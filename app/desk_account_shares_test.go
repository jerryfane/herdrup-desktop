package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/account"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/guest"
)

func quietShares(t *testing.T) {
	previous := publishSyncedShares
	publishSyncedShares = func([]SyncedShare) {}
	t.Cleanup(func() { publishSyncedShares = previous })
}

// shareDevice is a device signed in to the worker's account whose guest
// statements come from that account.
func shareDevice(t *testing.T, srv *httptest.Server) *Desk {
	t.Helper()
	d := device(t, srv)
	d.statements = account.NewStatementCache(d.account)
	t.Cleanup(d.Disconnect)
	return d
}

// shareRelay is an owner's herdr sharing one agent; with accounts, its
// invitation takes HerdrUp accounts, and it reads the worker's statements
// ("stmt.<account>.<host>").
func shareRelay(t *testing.T, accounts bool) (*fakeherdr.GuestRelay, string) {
	t.Helper()
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		t.Fatal(err)
	}
	owner := &guestOwnerHost{status: "blocked", seq: 4}
	relay.Handle = owner.handle
	relay.TerminalID, relay.AgentName = "t2", "docs"
	relay.OwnerName, relay.MachineLabel, relay.GuestName = "Jerry", "studio", "visitor"
	relay.MultiRequest = true
	relay.Accounts = accounts
	// The worker's statements name no device, so the device is not checked.
	relay.CheckStatement = func(jws string, _ []byte) (string, time.Time, string) {
		parts := strings.Split(jws, ".")
		if len(parts) != 3 || parts[0] != "stmt" || parts[2] != relay.HostID() {
			return "", time.Time{}, "statement_invalid"
		}
		return parts[1], time.Now().Add(10 * time.Minute), ""
	}
	base, err := relay.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = relay.Close() })
	return relay, base
}

// acceptBound is a share accepted on one device with "account" and synced.
func acceptBound(t *testing.T) (w *syncWorker, srv *httptest.Server, relay *fakeherdr.GuestRelay, base string, d *Desk, access guest.Access) {
	t.Helper()
	quietSync(t)
	quietShares(t)
	w, srv = newWorker(t, "")
	relay, base = shareRelay(t, true)
	d = shareDevice(t, srv)
	link := relay.InviteLink(base, time.Now().Add(time.Hour))
	if inv, err := d.InspectGuestInvitation(context.Background(), link); err != nil || !inv.Account {
		t.Fatalf("an invitation whose host takes accounts: %+v, %v", inv, err)
	}
	access, err := d.AcceptGuestInvitation(context.Background(), link, "account")
	if err != nil || !access.AccountBound || relay.Bound() != "acct" {
		t.Fatalf("bound accept: %+v (bound to %q), %v", access, relay.Bound(), err)
	}
	if err := d.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	return w, srv, relay, base, d, access
}

func sharesOf(t *testing.T, d *Desk) []SyncedShare {
	t.Helper()
	shares, err := d.SyncedShares()
	if err != nil {
		t.Fatal(err)
	}
	return shares
}

// herdrup#700 option A: a share accepted with "account" and bound by its
// host goes to the account's shares, its allowlisted fields only, and this
// device lists it as its own.
func TestABoundAcceptWritesTheShareToTheAccount(t *testing.T) {
	w, _, relay, base, d, access := acceptBound(t)
	id := relay.HostID() + "/" + access.GuestID
	it, ok := w.live()[id]
	if !ok || it.Collection != "shares" {
		t.Fatalf("no shares item %s: %v", id, w.live())
	}
	var body map[string]any
	if err := json.Unmarshal(it.Body, &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"relay": base, "host_id": relay.HostID(), "node_pub": base64.RawURLEncoding.EncodeToString(access.Endpoint.HostPublicKey),
		"guest_id": access.GuestID, "agent_name": "docs", "owner_name": "Jerry", "machine_label": "studio"}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("shares body %v, want %v", body, want)
	}
	if shares := sharesOf(t, d); len(shares) != 1 || shares[0].ID != id || !shares[0].Local || shares[0].MachineLabel != "studio" {
		t.Fatalf("synced shares %+v", shares)
	}
}

// Another device of the account lists the share, and opens it with no
// invitation: a returning hello with its own statement, which herdr takes
// in as one more device of the bound share.
func TestASecondDeviceOpensTheSyncedShare(t *testing.T) {
	w, srv, relay, _, _, access := acceptBound(t)
	id := relay.HostID() + "/" + access.GuestID
	d2 := shareDevice(t, srv)
	if err := d2.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	if shares := sharesOf(t, d2); len(shares) != 1 || shares[0].ID != id || shares[0].Local || shares[0].AgentName != "docs" {
		t.Fatalf("second device's synced shares %+v", shares)
	}
	if err := d2.OpenSyncedShare(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if relay.Devices() != 2 {
		t.Fatalf("the share admits %d devices, want 2", relay.Devices())
	}
	hellos := relay.Hellos()
	if last := hellos[len(hellos)-1]; last != "stmt.acct."+relay.HostID() {
		t.Fatalf("the second device's hello carried %q", last)
	}
	grants, err := d2.SharedConnections()
	if err != nil || len(grants) != 1 || !grants[0].AccountBound || grants[0].ShareID() != id || grants[0].AgentTarget != "t2" {
		t.Fatalf("second device's grants %+v, %v", grants, err)
	}
	if shares := sharesOf(t, d2); len(shares) != 1 || !shares[0].Local {
		t.Fatalf("an opened share is this device's: %+v", shares)
	}
	waitFor(t, "the opened share connected", func() bool {
		d2.mu.Lock()
		defer d2.mu.Unlock()
		return d2.link != nil && d2.link.access.ShareID() == id
	})
	if n := len(w.live()); n != 1 {
		t.Fatalf("opening wrote to the account: %v", w.live())
	}
}

// Leaving a bound share deletes it from the account, and the account's
// other device lets its grant go at its next sync.
func TestLeavingABoundShareLeavesItEverywhere(t *testing.T) {
	w, srv, relay, _, d1, access := acceptBound(t)
	id := relay.HostID() + "/" + access.GuestID
	d2 := shareDevice(t, srv)
	if err := d2.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := d2.OpenSyncedShare(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if err := d2.ForgetGuestConnection(access.ID()); err != nil {
		t.Fatal(err)
	}
	if grants, _ := d2.SharedConnections(); len(grants) != 0 {
		t.Fatalf("left grant still held: %+v", grants)
	}
	if shares := sharesOf(t, d2); len(shares) != 0 {
		t.Fatalf("a left share still listed: %+v", shares)
	}
	if err := d2.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, live := w.live()[id]; live {
		t.Fatal("the account still holds the left share")
	}
	if grants, _ := d1.SharedConnections(); len(grants) != 1 {
		t.Fatalf("first device before its sync: %+v", grants)
	}
	if err := d1.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	if grants, _ := d1.SharedConnections(); len(grants) != 0 {
		t.Fatalf("the share left elsewhere is still held here: %+v", grants)
	}
	if shares := sharesOf(t, d1); len(shares) != 0 {
		t.Fatalf("first device still lists %+v", shares)
	}
}

// "Only this device" keeps an account-capable invitation plain: no
// statement, nothing bound, nothing synced. "Add to my account" while
// signed out redeems nothing.
func TestADeviceOnlyAcceptWritesNothing(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	relay, base := shareRelay(t, true)
	link := relay.InviteLink(base, time.Now().Add(time.Hour))

	out := newDesk(t.TempDir())
	t.Cleanup(out.Disconnect)
	if _, err := out.AcceptGuestInvitation(context.Background(), link, "account"); !errors.Is(err, account.ErrSignedOut) || len(relay.Hellos()) != 0 {
		t.Fatalf("signed-out account accept: %v (hellos %q)", err, relay.Hellos())
	}

	d := shareDevice(t, srv)
	access, err := d.AcceptGuestInvitation(context.Background(), link, "device")
	if err != nil || access.AccountBound || relay.Bound() != "" {
		t.Fatalf("device accept: %+v (bound to %q), %v", access, relay.Bound(), err)
	}
	if hellos := relay.Hellos(); len(hellos) != 1 || hellos[0] != "" {
		t.Fatalf("device accept sent statements %q", hellos)
	}
	if err := d.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	for id, it := range w.live() {
		if it.Collection == "shares" {
			t.Fatalf("a device-only share reached the account: %s", id)
		}
	}
	if shares := sharesOf(t, d); len(shares) != 0 {
		t.Fatalf("synced shares %+v", shares)
	}
}

// An invitation from a host without accounts redeems as before, whatever
// the choice and signed in or not; an unknown choice redeems nothing.
func TestOldInvitationsAreUnchanged(t *testing.T) {
	quietShares(t)
	relay, base := shareRelay(t, false)
	link := relay.InviteLink(base, time.Now().Add(time.Hour))
	d := newDesk(t.TempDir())
	t.Cleanup(d.Disconnect)
	if inv, err := d.InspectGuestInvitation(context.Background(), link); err != nil || inv.Account {
		t.Fatalf("plain invitation: %+v, %v", inv, err)
	}
	if _, err := d.AcceptGuestInvitation(context.Background(), link, "both"); err == nil || !strings.Contains(err.Error(), "unknown way") || len(relay.Hellos()) != 0 {
		t.Fatalf("unknown choice: %v (hellos %q)", err, relay.Hellos())
	}
	access, err := d.AcceptGuestInvitation(context.Background(), link, "account")
	if err != nil || access.AccountBound || relay.Bound() != "" {
		t.Fatalf("plain accept: %+v, %v", access, err)
	}
	if hellos := relay.Hellos(); len(hellos) != 1 || hellos[0] != "" {
		t.Fatalf("plain accept sent statements %q", hellos)
	}
	d.storeMu.Lock()
	state, err := d.loadSyncState()
	d.storeMu.Unlock()
	if err != nil || len(state.ShareWrites)+len(state.ShareDeletes) != 0 {
		t.Fatalf("a plain share was queued for the account: %+v, %v", state, err)
	}
	if err := d.ForgetGuestConnection(access.ID()); err != nil {
		t.Fatal(err)
	}
	if grants, _ := d.SharedConnections(); len(grants) != 0 {
		t.Fatalf("grants after leaving %+v", grants)
	}
}

// A bound share's item belongs to the account herdr bound it to (the
// admitted statement's), whichever account is signed in when it is saved
// or left: under another account its write and its delete wait for that
// account, and never reach the account signed in.
func TestABoundShareStaysWithTheAccountThatBoundIt(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	relay, base := shareRelay(t, true)
	d := shareDevice(t, srv)
	ctx := context.Background()
	// switchTo signs this desk's client in to acct ("" is acct-2).
	switchTo := func(acct string) {
		w.mu.Lock()
		w.handoffAccount = acct
		w.mu.Unlock()
		if _, err := d.account.StartSignIn("google"); err != nil {
			t.Error(err)
		}
		if _, err := d.account.FinishSignIn(ctx, strings.Repeat("c", 43)); err != nil {
			t.Error(err)
		}
	}
	syncAs := func(as string) {
		t.Helper()
		if cur, _ := d.account.Current(); cur == nil || cur.AccountID != as {
			t.Fatalf("signed in as %+v, want %s", cur, as)
		}
		if err := d.SyncMachines(ctx); err != nil {
			t.Fatal(err)
		}
	}
	// Another account signs in as herdr checks the redemption's statement
	// (its hello already sent), before the grant is saved.
	check, switched := relay.CheckStatement, false
	relay.CheckStatement = func(jws string, device []byte) (string, time.Time, string) {
		sub, exp, code := check(jws, device)
		if !switched {
			switched = true
			switchTo("")
		}
		return sub, exp, code
	}
	access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
	if err != nil || !access.AccountBound || access.Account != "acct" || relay.Bound() != "acct" {
		t.Fatalf("bound accept: %+v (bound to %q), %v", access, relay.Bound(), err)
	}
	id := relay.HostID() + "/" + access.GuestID
	held := func() bool { _, ok := w.live()[id]; return ok }
	syncAs("acct-2")
	if held() {
		t.Fatal("the share was written while another account was signed in")
	}
	switchTo("acct")
	syncAs("acct")
	if !held() {
		t.Fatal("the share was not written once its account was back")
	}
	switchTo("")
	syncAs("acct-2")
	if err := d.ForgetGuestConnection(access.ID()); err != nil {
		t.Fatal(err)
	}
	syncAs("acct-2")
	if !held() {
		t.Fatal("a leave under another account deleted the share there")
	}
	switchTo("acct")
	syncAs("acct")
	if held() {
		t.Fatal("the leave never reached the share's account")
	}
}
