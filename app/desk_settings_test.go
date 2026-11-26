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

// A device removal's confirmation checks the shares with guest.list alone: no
// guest.audit waits on it, and a listing that can't be read is an error, not an
// empty listing.
func TestSharedAccessListsTheSharesAloneForAConfirmation(t *testing.T) {
	fixture := fakeherdr.NewGuests()
	var mu sync.Mutex
	var methods []string
	var failing atomic.Bool
	var answer atomic.Pointer[string]
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		previous := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if strings.HasPrefix(method, "guest.") {
				mu.Lock()
				methods = append(methods, method)
				mu.Unlock()
			}
			if method == "guest.list" && failing.Load() {
				return nil, &fakeherdr.APIError{Code: "guest_store_unavailable", Message: "try again"}
			}
			if body := answer.Load(); method == "guest.list" && body != nil {
				return json.RawMessage(*body), nil
			}
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
	raw, err := d.SettingsGuestList(ctx, "guests", "")
	if err != nil {
		t.Fatal(err)
	}
	var listing herdrapi.ResponseResultGuestList
	if err := json.Unmarshal([]byte(raw), &listing); err != nil || len(listing.Guests) == 0 {
		t.Fatalf("guest list %s, %v", raw, err)
	}
	mu.Lock()
	if strings.Join(methods, ",") != "guest.list" {
		t.Fatalf("a confirmation's check sent %v, want guest.list alone", methods)
	}
	mu.Unlock()
	failing.Store(true)
	if raw, err := d.SettingsGuestList(ctx, "guests", ""); err == nil || !strings.Contains(err.Error(), "guest_store_unavailable") {
		t.Fatalf("an unreadable guest list answered %q, %v", raw, err)
	}
	failing.Store(false)
	// A listing without a list of shares is no listing either: guests missing or null, not a list,
	// or a share whose devices aren't a list.
	for _, body := range []string{
		`{"type":"guest_list","invites":[]}`,
		`{"type":"guest_list","guests":null,"invites":[]}`,
		`{"type":"guest_list","guests":{"guest_id":"g"},"invites":[]}`,
		`{"type":"guest_list","guests":[{"guest_id":"g","devices":{"fingerprint":"f"}}],"invites":[]}`,
	} {
		answer.Store(&body)
		if raw, err := d.SettingsGuestList(ctx, "guests", ""); err == nil {
			t.Fatalf("guest.list answering %s listed %q", body, raw)
		}
	}
	answer.Store(nil)
	d.CloseSettings("guests")
	if _, err := d.SettingsGuestList(ctx, "guests", ""); err == nil {
		t.Fatal("a closed Settings page listed the shares")
	}
}

// Removing a person revokes every share of theirs on that machine in one
// guest.revoke {person}; removing a device sends its share and fingerprint
// (guest.remove_device), and the person's other devices keep the share.
func TestSharedAccessRemovesAPersonOrOneOfTheirDevicesOnThatMachineOnly(t *testing.T) {
	fixture := fakeherdr.NewGuests()
	var mu sync.Mutex
	sent := map[string][]json.RawMessage{}
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		previous := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "guest.revoke" || method == "guest.remove_device" {
				mu.Lock()
				sent[method] = append(sent[method], append(json.RawMessage(nil), raw...))
				mu.Unlock()
			}
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
	guests := func() []herdrapi.GuestInfo {
		t.Helper()
		raw, err := d.SettingsGuestMachine(ctx, "guests", "")
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			Listing *herdrapi.ResponseResultGuestList `json:"listing"`
		}
		if err := json.Unmarshal([]byte(raw), &result); err != nil || result.Listing == nil {
			t.Fatalf("guest list %s, %v", raw, err)
		}
		return result.Listing.Guests
	}
	byID := func(id string) herdrapi.GuestInfo {
		for _, g := range guests() {
			if g.GuestID == id {
				return g
			}
		}
		t.Fatalf("no guest %s", id)
		return herdrapi.GuestInfo{}
	}
	if g := byID("nike-1"); g.Person != "acct-nike" || !g.AccountBound || len(g.Devices) != 2 {
		t.Fatalf("Nike's share as listed: %+v", g)
	}
	if err := d.RemoveGuestDevice(ctx, "guests", "", "nike-1", "SHA256:fixture-nike-mac"); err != nil {
		t.Fatal(err)
	}
	if d1, d2 := byID("nike-1").Devices, byID("nike-2").Devices; !d1[0].Removed || d1[1].Removed || d2[0].Removed {
		t.Fatalf("after removing the MacBook from nike-1: %+v / %+v", d1, d2)
	}
	if err := d.RemoveGuestDevice(ctx, "guests", "", "guest-1", "SHA256:fixture-alex"); err == nil || !strings.Contains(err.Error(), "guest_not_account_bound") {
		t.Fatalf("removing a plain share's device: %v", err)
	}
	if err := d.RevokeGuestPerson(ctx, "guests", "", "acct-nike"); err != nil {
		t.Fatal(err)
	}
	if !byID("nike-1").Revoked || !byID("nike-2").Revoked || byID("guest-1").Revoked {
		t.Fatal("removing Nike revoked the wrong shares")
	}
	if err := d.RevokeGuestPerson(ctx, "guests", "", ""); err == nil {
		t.Fatal("an empty person was sent")
	}
	mu.Lock()
	defer mu.Unlock()
	want := map[string][]string{
		"guest.remove_device": {`{"fingerprint":"SHA256:fixture-nike-mac","guest_id":"nike-1"}`, `{"fingerprint":"SHA256:fixture-alex","guest_id":"guest-1"}`},
		"guest.revoke":        {`{"person":"acct-nike"}`},
	}
	for method, params := range want {
		if len(sent[method]) != len(params) {
			t.Fatalf("%s sent %d times: %s", method, len(sent[method]), sent[method])
		}
		for i, p := range params {
			if string(sent[method][i]) != p {
				t.Fatalf("%s params %s, want %s", method, sent[method][i], p)
			}
		}
	}
}

// #524 review: as herdr does (store.rs revoke_in, remove_device_at), a device
// removed again and a person whose shares are all revoked are done; a share
// revoked meanwhile (guest_not_found) is gone for the device too, so
// RemoveGuestDevice is done; only an unknown person is refused.
func TestSharedAccessRepeatsAreDoneAndAStaleShareIsGone(t *testing.T) {
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
	// nike-1 revoked elsewhere: the device removal on it is done, and nike-2's still goes.
	if err := d.RevokeGuestAccess(ctx, "guests", "", "nike-1", false); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"nike-1", "nike-2", "nike-2"} {
		if err := d.RemoveGuestDevice(ctx, "guests", "", id, "SHA256:fixture-nike-mac"); err != nil {
			t.Fatalf("removing the MacBook from %s: %v", id, err)
		}
	}
	if err := d.RemoveGuestDevice(ctx, "guests", "", "nike-2", "SHA256:nobody"); err == nil || !strings.Contains(err.Error(), "guest_device_not_found") {
		t.Fatalf("an unknown device: %v", err)
	}
	for range 2 {
		if err := d.RevokeGuestPerson(ctx, "guests", "", "acct-nike"); err != nil {
			t.Fatalf("revoking Nike (again): %v", err)
		}
	}
	if err := d.RevokeGuestPerson(ctx, "guests", "", "acct-nobody"); err == nil || !strings.Contains(err.Error(), "guest_not_found") {
		t.Fatalf("an unknown person: %v", err)
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
