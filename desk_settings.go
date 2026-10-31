package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// A Settings scope keeps account actions and temporary auth panes on the host and
// session whose account list the reader opened. Closing it cancels pending work.
type settingsSession struct {
	token        string
	at           boardSession
	client       *engine.Client
	ctx          context.Context
	cancel       context.CancelFunc
	mu           sync.Mutex
	login        *accountLogin
	closedLogins map[string]bool
}

type accountLogin struct {
	id, pane, account, baselineEmail, submitBaseline string
	started, submitted                               time.Time
	state                                            AccountLoginState
}

type AccountLoginState struct {
	URL     string `json:"url"`
	Phase   string `json:"phase"`
	Message string `json:"message"`
	Email   string `json:"email"`
}

func (d *Desk) OpenSettings(machineID, session, token string) error {
	if token == "" || len(token) > 128 {
		return errors.New("invalid Settings token")
	}
	client, at, err := d.herdrClient()
	if err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.currentLocked(at) || at.link.id != machineID || sessionKey(at.link.session) != sessionKey(session) {
		return ErrSessionChanged
	}
	ctx, cancel := context.WithCancel(at.link.ctx)
	view := &settingsSession{token: token, at: at, client: client, ctx: ctx, cancel: cancel}
	if d.settings != nil {
		d.settings.cancel()
	}
	d.settings = view
	go func() { <-ctx.Done(); view.mu.Lock(); defer view.mu.Unlock(); view.closeLogin() }()
	return nil
}

func (d *Desk) settingsView(token string) (*settingsSession, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	view := d.settings
	if view == nil || view.token != token || !d.currentLocked(view.at) || view.ctx.Err() != nil {
		return nil, errors.New("Settings connection or session changed; request was not sent")
	}
	return view, nil
}

func (d *Desk) CloseSettings(token string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.settings != nil && d.settings.token == token {
		d.settings.cancel()
		d.settings = nil
	}
}

func accountJSON(result herdrapi.ResponseResultAccountsList, err error) (string, error) {
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(result)
	return string(data), err
}

func (d *Desk) SettingsAccounts(ctx context.Context, token string) (string, error) {
	view, err := d.settingsView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	return accountJSON(view.client.AccountsList(ctx))
}

// SettingsMachineVersion identifies the daemon belonging to this Settings scope,
// not the desktop app or the currently selected machine after a switch.
func (d *Desk) SettingsMachineVersion(ctx context.Context, token string) (string, error) {
	view, err := d.settingsView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	result, err := view.client.StagedUpdate(ctx)
	var unsupported *engine.ErrUnsupported
	if errors.As(err, &unsupported) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if _, err := d.settingsView(token); err != nil {
		return "", err
	}
	line := "herdr " + result.RunningVersion
	if result.RunningSha != nil {
		line += " · " + *result.RunningSha
	}
	return line, nil
}

func (d *Desk) CreateSettingsAccount(ctx context.Context, token, kind, label string) (string, error) {
	view, err := d.settingsView(token)
	if err != nil {
		return "", err
	}
	label = strings.TrimSpace(label)
	if label == "" || !slices.Contains([]string{"claude", "codex", "kimi"}, kind) {
		return "", errors.New("choose an account kind and label")
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	return accountJSON(view.client.AccountsCreate(ctx, kind, label))
}

func (d *Desk) RemoveSettingsAccount(ctx context.Context, token, id string) (string, error) {
	view, err := d.settingsView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	return accountJSON(view.client.AccountsRemove(ctx, id))
}

func findAccount(ctx context.Context, view *settingsSession, id string) (herdrapi.AccountInfo, error) {
	result, err := view.client.AccountsList(ctx)
	if err != nil {
		return herdrapi.AccountInfo{}, err
	}
	for _, account := range result.Accounts {
		if account.ID == id {
			return account, nil
		}
	}
	return herdrapi.AccountInfo{}, errors.New("account is no longer registered")
}

// SwapSettingsAccount checks the roster again; a displayed account is not proof
// that it can resume an agent. The daemon also enforces readiness per restart.
func (d *Desk) SwapSettingsAccount(ctx context.Context, token, id string) (string, error) {
	view, err := d.settingsView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	account, err := findAccount(ctx, view, id)
	if err != nil {
		return "", err
	}
	if account.Readiness != nil && !account.Readiness.Ready {
		detail := "account is not ready to resume agents"
		if account.Readiness.Detail != nil {
			detail = *account.Readiness.Detail
		}
		return "", errors.New(detail)
	}
	d.mu.Lock()
	var targets []string
	if d.currentLocked(view.at) {
		for _, agent := range view.at.link.agents {
			if agent.Agent != nil && *agent.Agent == account.Kind {
				targets = append(targets, agent.PaneID)
			}
		}
	}
	d.mu.Unlock()
	moved := 0
	var lastError error
	for _, pane := range targets {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if err := view.client.AgentRestart(ctx, pane, id); err != nil {
			lastError = err
		} else {
			moved++
		}
	}
	message := fmt.Sprintf("Moved %d of %d %s agents to %s.", moved, len(targets), account.Kind, account.Label)
	if lastError != nil {
		message += " Last error: " + lastError.Error()
	}
	return message, nil
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }
func accountCommand(account herdrapi.AccountInfo, action string) (string, error) {
	if account.Kind != "claude" || account.ConfigDir == "" {
		return "", errors.New("in-app sign-in requires a Claude account with a config directory")
	}
	return "env -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR=" + shellQuote(account.ConfigDir) + " claude " + action, nil
}

// closeLogin has one owner for each pane. It uses the original client even when
// the foreground has switched hosts; cleanup must never close a new host's pane.
func (view *settingsSession) closeLogin() {
	if view.login == nil {
		return
	}
	pane := view.login.pane
	view.login = nil
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = view.client.PaneClose(ctx, pane)
}

func (d *Desk) StartAccountLogin(ctx context.Context, token, loginID, id string, setupToken bool) (AccountLoginState, error) {
	view, err := d.settingsView(token)
	if err != nil {
		return AccountLoginState{}, err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	view.mu.Lock()
	defer view.mu.Unlock()
	if loginID == "" || len(loginID) > 128 || view.closedLogins[loginID] {
		return AccountLoginState{}, errors.New("sign-in was closed")
	}
	view.closeLogin()
	account, err := findAccount(ctx, view, id)
	if err != nil {
		return AccountLoginState{}, err
	}
	action := "auth login --claudeai"
	if setupToken {
		action = "setup-token"
	}
	command, err := accountCommand(account, action)
	if err != nil {
		return AccountLoginState{}, err
	}
	pane, err := view.client.BackgroundPane(ctx)
	if err != nil {
		return AccountLoginState{}, err
	}
	login := &accountLogin{id: loginID, pane: pane, account: id, started: time.Now(), state: AccountLoginState{Phase: "starting", Message: "Getting a sign-in link…"}}
	if account.Email != nil {
		login.baselineEmail = *account.Email
	}
	view.login = login
	if err = view.client.PaneSendText(ctx, pane, command); err == nil {
		err = view.client.PaneEnter(ctx, pane)
	}
	if err != nil {
		view.closeLogin()
		return AccountLoginState{}, err
	}
	return login.state, nil
}

var accountLoginURL = regexp.MustCompile(`https://[^\s<>"\x1b]+`)

func loginRejected(text string) bool {
	text = strings.ToLower(text)
	// Success wording suppresses old rejection text but never proves sign-in.
	// Only a changed account identity in PollAccountLogin can do that.
	for _, phrase := range []string{"logged in", "login successful", "successfully logged in", "authentication successful"} {
		if strings.Contains(text, phrase) {
			return false
		}
	}
	for _, phrase := range []string{"invalid code", "invalid authorization code", "invalid token", "expired code", "code expired", "token expired", "session expired", "authentication failed", "login failed", "try again"} {
		if strings.Contains(text, phrase) {
			return true
		}
	}
	return false
}

func (d *Desk) PollAccountLogin(ctx context.Context, token, loginID string) (AccountLoginState, error) {
	view, err := d.settingsView(token)
	if err != nil {
		return AccountLoginState{}, err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	view.mu.Lock()
	defer view.mu.Unlock()
	login := view.login
	if login == nil || login.id != loginID {
		return AccountLoginState{}, errors.New("sign-in is no longer open")
	}
	if login.state.Phase == "signedIn" {
		return login.state, nil
	}
	if time.Since(login.started) > 10*time.Minute {
		login.state.Phase = "unconfirmed"
		login.state.Message = "Couldn't confirm the sign-in. Check Accounts — it may have worked."
		return login.state, nil
	}
	account, err := findAccount(ctx, view, login.account)
	if err != nil {
		return login.state, err
	}
	if account.Email != nil && strings.TrimSpace(*account.Email) != "" && strings.TrimSpace(*account.Email) != strings.TrimSpace(login.baselineEmail) {
		login.state.Phase = "signedIn"
		login.state.Email = *account.Email
		login.state.Message = "Signed in as " + *account.Email + "."
		return login.state, nil
	}
	text, err := view.client.PaneReadText(ctx, login.pane)
	if err != nil {
		return login.state, err
	}
	if login.state.URL == "" {
		candidate := strings.TrimRight(accountLoginURL.FindString(text), ").,;]")
		if parsed, err := url.Parse(candidate); err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil {
			login.state.URL = candidate
			if login.state.Phase == "starting" {
				login.state.Phase = "linkReady"
				login.state.Message = "Open the link, approve, then paste the code below."
			}
		}
	}
	if login.state.Phase == "submitting" {
		newText := strings.TrimPrefix(text, login.submitBaseline)
		if loginRejected(newText) {
			login.state.Phase = "rejected"
			login.state.Message = "That code didn't work — check it and try again."
		} else if time.Since(login.submitted) >= 45*time.Second {
			login.state.Phase = "unconfirmed"
			login.state.Message = "Couldn't confirm the sign-in. Check Accounts — it may have worked."
		}
	}
	return login.state, nil
}

func (d *Desk) SubmitAccountLogin(ctx context.Context, token, loginID, code string) error {
	view, err := d.settingsView(token)
	if err != nil {
		return err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	view.mu.Lock()
	defer view.mu.Unlock()
	login := view.login
	if login == nil || login.id != loginID {
		return errors.New("sign-in is no longer open")
	}
	code = strings.TrimSpace(code)
	if code == "" || strings.ContainsAny(code, "\r\n\x00\x1b") {
		return errors.New("paste one authorization code")
	}
	if login.state.Phase == "submitting" || login.state.Phase == "signedIn" {
		return errors.New("a sign-in is already in progress")
	}
	login.submitBaseline, err = view.client.PaneReadText(ctx, login.pane)
	if err != nil {
		return err
	}
	if err = view.client.PaneSendText(ctx, login.pane, code); err == nil {
		err = view.client.PaneEnter(ctx, login.pane)
	}
	if err != nil {
		return err
	}
	login.submitted = time.Now()
	login.state.Phase = "submitting"
	login.state.Message = "Signing you in…"
	return nil
}

func (d *Desk) CloseAccountLogin(token, loginID string) {
	view, err := d.settingsView(token)
	if err != nil {
		return
	}
	view.mu.Lock()
	defer view.mu.Unlock()
	if view.closedLogins == nil {
		view.closedLogins = make(map[string]bool)
	}
	view.closedLogins[loginID] = true
	if view.login != nil && view.login.id == loginID {
		view.closeLogin()
	}
}

func (d *Desk) LogoutSettingsAccount(ctx context.Context, token, id string) (string, error) {
	view, err := d.settingsView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	account, err := findAccount(ctx, view, id)
	if err != nil {
		return "", err
	}
	command, err := accountCommand(account, "auth logout")
	if err != nil {
		return "", err
	}
	pane, err := view.client.BackgroundPane(ctx)
	if err != nil {
		return "", err
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = view.client.PaneClose(cleanup, pane)
	}()
	if err = view.client.PaneSendText(ctx, pane, command); err == nil {
		err = view.client.PaneEnter(ctx, pane)
	}
	if err != nil {
		return "", err
	}
	timer := time.NewTimer(2500 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-timer.C:
	}
	return accountJSON(view.client.AccountsList(ctx))
}

type AccountMenuChoice struct {
	Token      string `json:"token"`
	ID         string `json:"id"`
	Action     string `json:"action"`
	AgentCount int    `json:"agentCount"`
}

var AccountMenuChosen = mygo.NewEvent[AccountMenuChoice]("settings:account-menu")

// SettingsAccountMenu snapshots one account. A menu selection is only an intent;
// the actual mutation still requires a current Settings token and confirmation.
func (d *Desk) SettingsAccountMenu(ctx context.Context, token, id, accountID string) error {
	view, err := d.settingsView(token)
	if err != nil {
		return err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	account, err := findAccount(ctx, view, accountID)
	if err != nil {
		return err
	}
	d.mu.Lock()
	if !d.currentLocked(view.at) {
		d.mu.Unlock()
		return ErrSessionChanged
	}
	count := 0
	for _, agent := range view.at.link.agents {
		if agent.Agent != nil && *agent.Agent == account.Kind {
			count++
		}
	}
	d.mu.Unlock()
	item := func(label, action string) *mygo.MenuItem {
		return &mygo.MenuItem{Label: label, Click: func(*mygo.MenuItem, *mygo.Window) {
			AccountMenuChosen.Broadcast(AccountMenuChoice{Token: token, ID: id, Action: action, AgentCount: count})
		}}
	}
	var items []*mygo.MenuItem
	if count > 0 {
		swap := item("Use for all "+account.Kind+" agents", "swap")
		swap.Disabled = account.Readiness != nil && !account.Readiness.Ready
		if swap.Disabled && account.Readiness.Detail != nil {
			swap.ToolTip = *account.Readiness.Detail
		}
		items = append(items, swap)
	}
	if account.Kind == "claude" && account.ConfigDir != "" {
		items = append(items, item("Log in", "login"), item("Log out", "logout"))
	}
	items = append(items, item("Remove account", "remove"))
	if ctx.Err() != nil {
		return ctx.Err()
	}
	mygo.NewMenu(items).Popup(mygo.CallerWindow(ctx))
	return nil
}
