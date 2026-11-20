package main

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/account"
)

// AccountState is what Settings shows about the HerdrUp account (design
// #698 §2.3, §2.5).
type AccountState struct {
	SignedIn bool `json:"signedIn"`
	// DisplayHint is the Google address the service sent at sign-in, ""
	// for Apple or after a relaunch the hint was not kept for.
	DisplayHint string `json:"displayHint,omitempty"`
	// Persistent is false where the system has no credential store: the
	// session ends when the app quits.
	Persistent bool `json:"persistent"`
	// Problem is why the newest sign-in or session check failed, "" if none.
	Problem string `json:"problem,omitempty"`
}

// AccountChanged tells the page the account state changed (a finished
// sign-in, a refused session, sign-out).
var AccountChanged = mygo.NewEvent[AccountState]("account:changed")

// publishAccount sends one state to the page; tests replace it.
var publishAccount = func(s AccountState) { AccountChanged.Broadcast(s) }

// accountPlatform is the service's platform name for GOOS.
func accountPlatform(goos string) string {
	switch goos {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	}
	return "linux"
}

func newAccountClient(goos string) (*account.Client, *account.SecretsStore) {
	store := account.NewSecretsStore(mygo.Secrets, mygo.ErrSecretNotFound)
	return account.New("", accountPlatform(goos), store, nil), store
}

func (d *Desk) accountState(problem string) AccountState {
	// Current first: it reads the store, which is when a system without a
	// credential store is found out.
	current, err := d.account.Current()
	s := AccountState{Persistent: d.accountStore.Persistent(), Problem: problem}
	if err != nil {
		s.Problem = accountProblem(err)
		return s
	}
	if current != nil {
		s.SignedIn, s.DisplayHint = true, current.DisplayHint
	}
	return s
}

// AccountState is the account as the app holds it. It does not ask the
// service: AccountCheck does.
func (d *Desk) AccountState() AccountState { return d.accountState("") }

// AccountCheck asks the service whether the session still works (a refresh
// when the access token is old), so a removed device shows signed out.
func (d *Desk) AccountCheck(ctx context.Context) AccountState {
	_, err := d.account.AccessToken(ctx)
	if errors.Is(err, account.ErrSignedOut) {
		err = nil
	}
	s := d.accountState("")
	if err != nil {
		s.Problem = accountProblem(err)
	}
	return s
}

// AccountSignIn opens the sign-in for provider ("apple" or "google") in
// the system browser. The browser comes back on herdrup://account#…
// (queueAccountLink).
func (d *Desk) AccountSignIn(provider string) error {
	link, err := d.account.StartSignIn(account.Provider(provider))
	if err != nil {
		return err
	}
	return d.openBrowser(link)
}

// AccountSignOut ends the session.
func (d *Desk) AccountSignOut(ctx context.Context) AccountState {
	err := d.account.SignOut(ctx)
	s := d.accountState("")
	if err != nil {
		// Signed out here either way; the note says the service may not know.
		log.Printf("account: sign-out: %v", err)
	}
	publishAccount(s)
	return s
}

// queueAccountLink takes a herdrup://account#code=… link the system opened
// and redeems it; false for any other link.
func (d *Desk) queueAccountLink(link string) bool {
	if !strings.HasPrefix(strings.TrimSpace(link), account.LinkPrefix) {
		return false
	}
	go func() {
		code, ok := account.CodeFromLink(link)
		problem := ""
		if !ok {
			problem = "This sign-in link is not complete. Sign in again."
		} else {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			_, err := d.account.FinishSignIn(ctx, code)
			cancel()
			if err != nil {
				problem = accountProblem(err)
			}
		}
		publishAccount(d.accountState(problem))
	}()
	return true
}

// accountProblem is an account error in the app's words.
func accountProblem(err error) string {
	var api *account.APIError
	switch {
	case errors.Is(err, account.ErrNoSignIn):
		return "This sign-in was started elsewhere or already finished. Sign in again from Settings."
	case errors.As(err, &api) && api.Status == 429:
		return "Too many sign-in attempts. Try again in a few minutes."
	case errors.As(err, &api) && api.Status >= 400 && api.Status < 500:
		return "The sign-in didn't go through. Sign in again."
	case errors.As(err, &api):
		return "The account service is unavailable. Try again later."
	}
	return "Couldn't reach the account service."
}
