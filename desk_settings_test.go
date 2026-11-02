package main

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func accountSettingsDesk(t *testing.T) *Desk {
	t.Helper()
	fixture := fakeherdr.NewAccounts()
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		previous := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if result, err, handled := fixture.Handle(method, raw); handled {
				return result, err
			}
			return previous(method, raw)
		}
	})
	board := d.Board()
	if err := d.OpenSettings(board.MachineID, board.Session, "settings"); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestAccountLoginRequiresObservedIdentity(t *testing.T) {
	d := accountSettingsDesk(t)
	ctx := context.Background()
	if _, err := d.StartAccountLogin(ctx, "settings", "first", "claude-smoke", false); err != nil {
		t.Fatal(err)
	}
	state, err := d.PollAccountLogin(ctx, "settings", "first")
	if err != nil || state.URL != "https://example.invalid/fixture-sign-in" {
		t.Fatalf("sign-in link: %+v, %v", state, err)
	}
	if err := d.SubmitAccountLogin(ctx, "settings", "first", "phrase-only"); err != nil {
		t.Fatal(err)
	}
	state, err = d.PollAccountLogin(ctx, "settings", "first")
	if err != nil || state.Phase == "signedIn" || state.Email != "" {
		t.Fatalf("terminal success text was mistaken for identity: %+v, %v", state, err)
	}
	if _, err := d.StartAccountLogin(ctx, "settings", "second", "claude-smoke", false); err != nil {
		t.Fatal(err)
	}
	d.CloseAccountLogin("settings", "first") // delayed teardown from the old sheet
	if err := d.SubmitAccountLogin(ctx, "settings", "second", "wrong-code"); err != nil {
		t.Fatal(err)
	}
	state, err = d.PollAccountLogin(ctx, "settings", "second")
	if err != nil || state.Phase != "rejected" {
		t.Fatalf("new sheet was closed or rejection lost: %+v, %v", state, err)
	}
	if err := d.SubmitAccountLogin(ctx, "settings", "second", "native-smoke-code"); err != nil {
		t.Fatal(err)
	}
	state, err = d.PollAccountLogin(ctx, "settings", "second")
	if err != nil || state.Phase != "signedIn" || state.Email != "signed-in@example.invalid" {
		t.Fatalf("identity without success text was not confirmed: %+v, %v", state, err)
	}
	d.CloseAccountLogin("settings", "second")
	// Re-signing in to the same identity cannot establish a new login.
	if _, err := d.StartAccountLogin(ctx, "settings", "third", "claude-smoke", false); err != nil {
		t.Fatal(err)
	}
	if err := d.SubmitAccountLogin(ctx, "settings", "third", "native-smoke-code"); err != nil {
		t.Fatal(err)
	}
	state, err = d.PollAccountLogin(ctx, "settings", "third")
	if err != nil || state.Phase == "signedIn" {
		t.Fatalf("unchanged identity confirmed a new login: %+v, %v", state, err)
	}
	d.CloseSettings("settings")
}

func TestSettingsRejectsClosedScopeMutations(t *testing.T) {
	d := accountSettingsDesk(t)
	ctx := context.Background()
	d.CloseAccountLogin("settings", "closed-before-start")
	if _, err := d.StartAccountLogin(ctx, "settings", "closed-before-start", "claude-smoke", false); err == nil {
		t.Fatal("late start created an auth pane after its sheet closed")
	}
	d.CloseSettings("settings")
	board := d.Board()
	if err := d.OpenSettings(board.MachineID, board.Session, "replacement"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.CreateSettingsAccount(ctx, "settings", "claude", "must not exist"); err == nil {
		t.Fatal("closed settings could register an account")
	}
	d.CloseSettings("settings")
	if _, err := d.CreateSettingsAccount(ctx, "replacement", "kimi", "current account"); err != nil {
		t.Fatal(err)
	}
	accounts, err := d.SettingsAccounts(ctx, "replacement")
	if err != nil || strings.Contains(accounts, "must not exist") || !strings.Contains(accounts, "current account") {
		t.Fatalf("wrong scope mutated accounts: %s, %v", accounts, err)
	}
	d.CloseSettings("replacement")
}

func TestSharedAccessKeepsSameIDsOnDifferentMachinesSeparate(t *testing.T) {
	fixture := fakeherdr.NewGuests()
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		previous := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if result, err, handled := fixture.Handle(method, raw); handled {
				return result, err
			}
			return previous(method, raw)
		}
	})
	board := d.Board()
	if err := d.OpenSettings(board.MachineID, board.Session, "guests"); err != nil {
		t.Fatal(err)
	}
	defer d.CloseSettings("guests")
	ctx := context.Background()
	const peer = "11111111111111111111111111111111"
	list := func(machine string) herdrapi.ResponseResultGuestList {
		t.Helper()
		raw, err := d.SettingsGuestMachine(ctx, "guests", machine)
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			Listing *herdrapi.ResponseResultGuestList `json:"listing"`
			Error   string                            `json:"error"`
		}
		if err := json.Unmarshal([]byte(raw), &result); err != nil {
			t.Fatal(err)
		}
		if result.Listing == nil {
			t.Fatalf("guest list failed: %s", result.Error)
		}
		return *result.Listing
	}
	if err := d.SetGuestGramSharing(ctx, "guests", peer, "guest-1", false); err != nil {
		t.Fatal(err)
	}
	if err := d.SetGuestGramSharing(ctx, "guests", "", "guest-1", true); err != nil {
		t.Fatal(err)
	}
	if !list("").Guests[0].ShareGram || list(peer).Guests[0].ShareGram {
		t.Fatal("Gram sharing crossed machine boundaries for the same guest id")
	}
	if err := d.RevokeGuestAccess(ctx, "guests", peer, "guest-1", false); err != nil {
		t.Fatal(err)
	}
	if list("").Guests[0].Revoked || !list(peer).Guests[0].Revoked {
		t.Fatal("revoking the peer guest changed the local guest with the same id")
	}
	if err := d.RevokeGuestAccess(ctx, "guests", "", "invite-1", true); err != nil {
		t.Fatal(err)
	}
	if list("").Invites[0].ExpiresMs != 0 || list(peer).Invites[0].ExpiresMs == 0 {
		t.Fatal("cancelling the local invite changed the peer invite with the same id")
	}
	d.CloseSettings("guests")
	if err := d.SetGuestGramSharing(ctx, "guests", "", "guest-1", false); err == nil {
		t.Fatal("a closed Settings page could change sharing permissions")
	}
}

func TestSettingsMachineVersionDiscardsClosedScopeReply(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	var calls atomic.Int32
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		previous := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method != "server.staged_update" {
				return previous(method, raw)
			}
			if calls.Add(1) == 1 {
				close(started)
				<-release
				return map[string]any{"type": "staged_update", "running_version": "old", "running_protocol": 22, "running_sha": "old-sha"}, nil
			}
			return map[string]any{"type": "staged_update", "running_version": "new", "running_protocol": 22, "running_sha": "new-sha"}, nil
		}
	})
	t.Cleanup(unblock)
	board := d.Board()
	if err := d.OpenSettings(board.MachineID, board.Session, "old"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type reply struct {
		line string
		err  error
	}
	done := make(chan reply, 1)
	go func() {
		line, err := d.SettingsMachineVersion(ctx, "old")
		done <- reply{line, err}
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("version request did not reach the old scope")
	}
	d.CloseSettings("old")
	if err := d.OpenSettings(board.MachineID, board.Session, "new"); err != nil {
		t.Fatal(err)
	}
	unblock()
	select {
	case result := <-done:
		if result.line != "" || result.err == nil {
			t.Fatalf("closed scope published old daemon version: %+v", result)
		}
	case <-ctx.Done():
		t.Fatal("closed version request did not finish")
	}
	line, err := d.SettingsMachineVersion(ctx, "new")
	if err != nil || line != "herdr new · new-sha" {
		t.Fatalf("new scope inherited the closed scope's version: %q, %v", line, err)
	}
	d.CloseSettings("new")
}
