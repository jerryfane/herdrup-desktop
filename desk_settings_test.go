package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
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
