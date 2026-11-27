package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
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
	if err != nil || !access.AccountBound || relay.Bound() != "acct" || access.AccountShare != shareConfirmed {
		t.Fatalf("bound accept: %+v (bound to %q), %v; want the account to hold it", access, relay.Bound(), err)
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

// A label the account can't store is left out of the share's item, so the
// rest of it syncs: the service counts code points (sync.ts text()), and
// this agent name has 70 graphemes, under the guest's own 128, but 140 code
// points, over the service's 128.
func TestALabelTheServiceWontStoreIsLeftOut(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	relay, base := shareRelay(t, true)
	long := strings.Repeat("e\u0301", 70)
	relay.AgentName = long
	d := shareDevice(t, srv)
	access, err := d.AcceptGuestInvitation(context.Background(), relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
	if err != nil || !access.AccountBound || access.AgentName != long {
		t.Fatalf("bound accept: %+v, %v", access, err)
	}
	if err := d.SyncMachines(context.Background()); err != nil {
		t.Fatalf("a share with a long agent name: %v", err)
	}
	it, ok := w.live()[relay.HostID()+"/"+access.GuestID]
	if !ok {
		t.Fatal("the share was not written")
	}
	var body map[string]any
	_ = json.Unmarshal(it.Body, &body)
	if _, kept := body["agent_name"]; kept || body["owner_name"] != "Jerry" || body["machine_label"] != "studio" {
		t.Fatalf("shares body %v; want the agent name left out, the rest kept", body)
	}
}

// A push the service refuses whole (400) writes nothing, and acknowledges
// none of its changes: the share's write and a prompt's in the same batch
// both go again on the next sync.
func TestARefusedBatchLeavesItsChangesPending(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	relay, base := shareRelay(t, true)
	d := shareDevice(t, srv)
	// The accept's own sync, with a prompt saved before it, is the push
	// the service refuses whole.
	savePrompt(t, d, "", "", "summarise the build")
	w.mu.Lock()
	w.invalidNextPush = true
	w.mu.Unlock()
	access, err := d.AcceptGuestInvitation(context.Background(), relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
	if err != nil || !access.AccountBound || access.AccountShare != shareQueued {
		t.Fatalf("bound accept: %+v, %v; want it queued", access, err)
	}
	id := relay.HostID() + "/" + access.GuestID
	if _, ok := w.live()[id]; ok || len(w.livePrompts()) != 0 {
		t.Fatalf("a refused push wrote: %v", w.live())
	}
	d.storeMu.Lock()
	state, err := d.loadSyncState()
	d.storeMu.Unlock()
	if err != nil || !slices.ContainsFunc(state.ShareWrites, func(op shareOp) bool { return op.ID == id }) {
		t.Fatalf("the share's write is no longer owed: %+v, %v", state.ShareWrites, err)
	}
	if err := d.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := w.live()[id]; !ok || len(w.livePrompts()) != 1 {
		t.Fatalf("after the refusal, the next sync wrote %v", w.live())
	}
}

// A bound accept says the account holds its share only once the service
// took the write: with the account full (403 quota) it is refused, with
// why, never confirmed, and stays owed; once there is room, the next sync
// writes it and it is confirmed.
func TestABoundAcceptTheAccountRefusesIsNotConfirmed(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	w.seedPrompt("prompt-1", `{"text":"held"}`)
	w.mu.Lock()
	w.maxItems = 1 // full
	w.mu.Unlock()
	relay, base := shareRelay(t, true)
	d := shareDevice(t, srv)
	access, err := d.AcceptGuestInvitation(context.Background(), relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
	if err != nil || !access.AccountBound {
		t.Fatalf("bound accept: %+v, %v", access, err)
	}
	id := relay.HostID() + "/" + access.GuestID
	if _, held := w.live()[id]; held {
		t.Fatal("the account took a share past its quota")
	}
	want := "Your HerdrUp account holds as many shares as it can. Remove one from it, and this one is added at the next sync."
	if access.AccountShare != shareRefused || access.AccountShareProblem != want {
		t.Fatalf("a refused share's accept says %q (%q), want refused (%q)", access.AccountShare, access.AccountShareProblem, want)
	}
	told := func() guest.Access {
		t.Helper()
		list, err := d.SharedConnections()
		if err != nil || len(list) != 1 {
			t.Fatalf("shared connections %+v, %v", list, err)
		}
		return list[0]
	}
	if got := told(); got.AccountShare != shareRefused || got.AccountShareProblem != want {
		t.Fatalf("a refused share is listed as %q (%q)", got.AccountShare, got.AccountShareProblem)
	}
	if saved, _ := d.guestStore.List(); saved[0].AccountShare != "" {
		t.Fatalf("the account's answer was saved with the grant: %+v", saved[0])
	}
	w.mu.Lock()
	w.maxItems = 0
	w.mu.Unlock()
	if err := d.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, held := w.live()[id]; !held {
		t.Fatal("the owed write never went")
	}
	if got := told(); got.AccountShare != shareConfirmed || got.AccountShareProblem != "" {
		t.Fatalf("a share the account took is listed as %q (%q)", got.AccountShare, got.AccountShareProblem)
	}
}

// An open whose share is left on another device while herdr admits it
// saves nothing: with the returning hello's reply held, the first device
// leaves the share and the second syncs through its tombstone; released,
// the open fails, no grant is saved and no link opened, and a later sync
// finds neither the share nor a grant.
func TestAnOpenWhoseShareWasLeftMeanwhileSavesNothing(t *testing.T) {
	w, srv, relay, _, d1, access := acceptBound(t)
	id := relay.HostID() + "/" + access.GuestID
	d2 := shareDevice(t, srv)
	ctx := context.Background()
	if err := d2.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	held, release := make(chan struct{}), make(chan struct{})
	relay.HoldReply(func() {
		relay.HoldReply(nil)
		close(held)
		<-release
	})
	opened := make(chan error, 1)
	go func() { opened <- d2.OpenSyncedShare(ctx, id) }()
	select {
	case <-held:
	case <-time.After(10 * time.Second):
		t.Fatal("the open's hello never reached herdr")
	}
	if err := d1.ForgetGuestConnection(access.ID()); err != nil {
		t.Fatal(err)
	}
	if err := d1.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if err := d2.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if _, live := w.live()[id]; live {
		t.Fatal("the leave never reached the account")
	}
	close(release)
	var err error
	select {
	case err = <-opened:
	case <-time.After(10 * time.Second):
		t.Fatal("the open never returned")
	}
	if !errors.Is(err, errShareGone) {
		t.Fatalf("an open of a share left meanwhile: %v, want errShareGone", err)
	}
	d2.mu.Lock()
	linked := d2.link != nil
	d2.mu.Unlock()
	if grants, _ := d2.SharedConnections(); len(grants) != 0 || linked {
		t.Fatalf("grants %+v, link open %v; want neither", grants, linked)
	}
	if err := d2.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if grants, _ := d2.SharedConnections(); len(grants) != 0 || len(w.live()) != 0 || len(sharesOf(t, d2)) != 0 {
		t.Fatalf("after a later sync: grants %+v, rows %v, synced shares %+v", grants, w.live(), sharesOf(t, d2))
	}
}

// A share left elsewhere ends this device's open connection to it as its
// grant goes, even when the sync's commit then fails: the retry finds no
// grant to remove, so it couldn't end it then. Once the commit goes
// through, nothing stays connected.
func TestASharesConnectionEndsAsItsGrantGoesEvenIfTheCommitFails(t *testing.T) {
	w, srv, relay, _, d1, access := acceptBound(t)
	id := relay.HostID() + "/" + access.GuestID
	d2 := shareDevice(t, srv)
	ctx := context.Background()
	if err := d2.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if err := d2.OpenSyncedShare(ctx, id); err != nil {
		t.Fatal(err)
	}
	connected := func() bool {
		d2.mu.Lock()
		defer d2.mu.Unlock()
		return d2.link != nil && d2.link.guest != nil
	}
	waitFor(t, "the opened share connected", connected)
	if err := d1.ForgetGuestConnection(access.ID()); err != nil {
		t.Fatal(err)
	}
	if err := d1.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if _, live := w.live()[id]; live {
		t.Fatal("the leave never reached the account")
	}
	// The commit's record can't be written: a folder where its temporary
	// file goes (writeFileAtomic).
	blocker := filepath.Join(d2.dir, "sync-commit.json.tmp")
	if err := os.MkdirAll(filepath.Join(blocker, "x"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := d2.SyncMachines(ctx); err == nil {
		t.Fatal("a sync whose commit can't be written succeeded")
	}
	if grants, _ := d2.guestStore.List(); len(grants) != 0 {
		t.Fatalf("the left share's grant is still saved: %+v", grants)
	}
	if connected() {
		t.Fatal("the left share's grant went, its connection stayed")
	}
	if shares, err := d2.SyncedShares(); err != nil || len(shares) != 0 {
		t.Fatalf("after failed commit, SyncedShares still lists removed share: %+v, %v", shares, err)
	}
	if err := d2.OpenSyncedShare(ctx, id); !errors.Is(err, errShareGone) {
		t.Fatalf("after failed commit, OpenSyncedShare err = %v, want %v", err, errShareGone)
	}
	if err := os.RemoveAll(blocker); err != nil {
		t.Fatal(err)
	}
	if err := d2.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if grants, _ := d2.SharedConnections(); len(grants) != 0 || connected() || len(w.live()) != 0 {
		t.Fatalf("after the retry: grants %+v, connected %v, rows %v", grants, connected(), w.live())
	}
}

// signInAs signs d in to acct anew through the worker's handoff ("" is
// acct-2).
func signInAs(t *testing.T, w *syncWorker, d *Desk, acct string) {
	t.Helper()
	w.mu.Lock()
	w.handoffAccount = acct
	w.mu.Unlock()
	if _, err := d.account.StartSignIn("google"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.account.FinishSignIn(context.Background(), strings.Repeat("c", 43)); err != nil {
		t.Fatal(err)
	}
}

// Another account signed in meanwhile doesn't make this device forget a
// share its account held: left elsewhere while the other was signed in,
// the share's grant goes once its account is back, whether its tombstone
// is still there or pruned since, and its write is never sent again, even
// when only the accept's own sync, whose readback was lost, had run.
func TestAShareLeftWhileAnotherAccountWasSignedInStaysLeft(t *testing.T) {
	for _, c := range []struct {
		name         string
		prune        bool
		lostReadback bool
	}{
		{"its tombstone kept", false, false},
		{"its tombstone pruned", true, false},
		{"only the accept's sync run, its readback lost", false, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			quietSync(t)
			quietShares(t)
			w, srv := newWorker(t, "")
			relay, base := shareRelay(t, true)
			d := shareDevice(t, srv)
			ctx := context.Background()
			w.mu.Lock()
			w.dropReadback = c.lostReadback
			w.mu.Unlock()
			access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
			if err != nil || !access.AccountBound {
				t.Fatalf("bound accept: %+v, %v", access, err)
			}
			// The service took the write, even if its readback was lost.
			if access.AccountShare != shareConfirmed {
				t.Errorf("the accept says %q, want confirmed", access.AccountShare)
			}
			id := relay.HostID() + "/" + access.GuestID
			signInAs(t, w, d, "")
			if err := d.SyncMachines(ctx); err != nil {
				t.Fatal(err)
			}
			// Another device of the account leaves the share.
			w.mu.Lock()
			w.tombstone(id)
			if c.prune {
				w.prune(id)
			}
			w.mu.Unlock()
			signInAs(t, w, d, "acct")
			if err := d.SyncMachines(ctx); err != nil {
				t.Fatal(err)
			}
			if _, live := w.live()[id]; live {
				t.Fatal("the left share was written to the account again")
			}
			if grants, _ := d.SharedConnections(); len(grants) != 0 {
				t.Fatalf("the left share's grant is still held: %+v", grants)
			}
			if shares := sharesOf(t, d); len(shares) != 0 {
				t.Fatalf("the left share is still listed: %+v", shares)
			}
		})
	}
}

// A share another device deletes between the push that wrote it and that
// push's readback isn't confirmed: the readback is newer than the write's
// acknowledgement. The accept says nothing of the account (no
// AccountShare), the synced list doesn't list it, and the readback's save
// lets the grant go, as the merge would (dropGoneShares).
func TestAShareDeletedBeforeItsReadbackIsNotConfirmed(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	relay, base := shareRelay(t, true)
	d := shareDevice(t, srv)
	ctx := context.Background()
	invite := relay.InviteLink(base, time.Now().Add(time.Hour))
	// The push is taken, then another device leaves the share, before the
	// readback.
	w.mu.Lock()
	w.afterPush = func() {
		for id, it := range w.items {
			if it.Collection == "shares" {
				w.tombstone(id)
			}
		}
	}
	w.mu.Unlock()
	access, err := d.AcceptGuestInvitation(ctx, invite, "account")
	if err != nil || !access.AccountBound {
		t.Fatalf("bound accept: %+v, %v", access, err)
	}
	if access.AccountShare != "removed" {
		t.Fatalf("a share deleted before its readback: the accept says %q, want removed", access.AccountShare)
	}
	if len(w.live()) != 0 || len(sharesOf(t, d)) != 0 {
		t.Fatalf("rows %v, synced shares %+v; want none", w.live(), sharesOf(t, d))
	}
	if grants, _ := d.SharedConnections(); len(grants) != 0 {
		t.Fatalf("after the accept's readback: %+v; want the grant gone", grants)
	}
	if err := d.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if grants, _ := d.SharedConnections(); len(grants) != 0 || len(w.live()) != 0 {
		t.Fatalf("after the next sync: grants %+v, rows %v; want neither", grants, w.live())
	}
}

// A share another device deletes between the push that wrote it and that
// push's readback, its tombstone pruned at once, so the readback starts
// over (410, a full one), is gone just the same: the account acknowledged
// holding it, and the full readback lacks it with no tombstone to say so.
// Neither the accept nor the list confirms it, and the next sync lets the
// grant go.
func TestAShareDeletedAndPrunedBeforeAFullReadbackIsLetGo(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	w.seedPrompt("prompt-1", `{"text":"held"}`) // the readback pulls from past 0
	relay, base := shareRelay(t, true)
	d := shareDevice(t, srv)
	ctx := context.Background()
	w.mu.Lock()
	w.afterPush = func() {
		for id, it := range w.items {
			if it.Collection == "shares" {
				w.tombstone(id)
				w.prune(id) // past the device's mirror: its readback starts over
			}
		}
	}
	w.mu.Unlock()
	access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
	if err != nil || !access.AccountBound {
		t.Fatalf("bound accept: %+v, %v", access, err)
	}
	if access.AccountShare != "removed" {
		t.Fatalf("a share deleted before its full readback: the accept says %q, want removed", access.AccountShare)
	}
	id := relay.HostID() + "/" + access.GuestID
	if _, live := w.live()[id]; live || len(sharesOf(t, d)) != 0 {
		t.Fatalf("rows %v, synced shares %+v; want no share", w.live(), sharesOf(t, d))
	}
	if err := d.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if grants, _ := d.SharedConnections(); len(grants) != 0 {
		t.Fatalf("after the next sync: grants %+v; want none", grants)
	}
	if _, live := w.live()[id]; live {
		t.Fatal("the deleted share was written to the account again")
	}
}

// A full readback decides once whether a share it lacks is gone, however
// many ways this device knew the account held it (the mirror before, the
// account's acknowledgement, a tombstone the readback lists): the saved
// sync state names a share left elsewhere gone once, and one this device
// left that round not at all (its grant went with the leave).
func TestAFullReadbackNamesAShareGoneOnce(t *testing.T) {
	for _, here := range []bool{false, true} {
		t.Run(map[bool]string{false: "left elsewhere", true: "left here"}[here], func(t *testing.T) {
			w, _, _, _, d, access := acceptBound(t)
			held := sharesOf(t, d)
			if len(held) != 1 {
				t.Fatalf("synced shares %+v; want the one accepted", held)
			}
			id := held[0].ID
			if here {
				if err := d.ForgetGuestConnection(access.ID()); err != nil {
					t.Fatal(err)
				}
			} else if _, err := d.SavePrompt(SavedPrompt{Text: "to push"}); err != nil {
				t.Fatal(err)
			}
			w.mu.Lock()
			w.afterPush = func() {
				// Another device leaves the share (unless this one just
				// did); the history from before the device's mirror is
				// compacted, the tombstone kept, so the readback starts
				// over and lists that tombstone.
				if !here {
					w.tombstone(id)
				}
				w.floor = w.rev
			}
			w.mu.Unlock()
			if err := d.SyncMachines(context.Background()); err != nil {
				t.Fatal(err)
			}
			want := []string{id}
			if here {
				want = nil
			}
			if gone := savedSyncState(t, d).SharesGone; !slices.Equal(gone, want) {
				t.Fatalf("shares gone after the full readback: %q; want %q", gone, want)
			}
		})
	}
}

// savedSyncState is d's sync state as saved: what a restart of the app
// loads, with nothing owed in d's memory.
func savedSyncState(t *testing.T, d *Desk) syncState {
	t.Helper()
	restarted := newDesk(d.dir)
	restarted.storeMu.Lock()
	defer restarted.storeMu.Unlock()
	state, err := restarted.loadSyncState()
	if err != nil {
		t.Fatal(err)
	}
	return state
}

// acceptWithAckUnsaved accepts a bound share on d whose write the service
// takes, and whose settling (the acknowledgement) can't be saved: past the
// push, the sync state can't be written (a folder where its temporary
// file goes, writeFileAtomic) until the accept returns. The saved state
// still journals the write as sent.
func acceptWithAckUnsaved(t *testing.T, w *syncWorker, relay *fakeherdr.GuestRelay, base string, d *Desk) (guest.Access, string) {
	t.Helper()
	blocker := filepath.Join(d.dir, "account-sync.json.tmp")
	w.mu.Lock()
	w.afterPush = func() {
		if err := os.MkdirAll(filepath.Join(blocker, "x"), 0o700); err != nil {
			t.Error(err)
		}
	}
	w.mu.Unlock()
	access, err := d.AcceptGuestInvitation(context.Background(), relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
	if err != nil || !access.AccountBound {
		t.Fatalf("bound accept: %+v, %v", access, err)
	}
	if err := os.RemoveAll(blocker); err != nil {
		t.Fatal(err)
	}
	id := relay.HostID() + "/" + access.GuestID
	if _, live := w.live()[id]; !live {
		t.Fatal("the service never took the write")
	}
	saved := savedSyncState(t, d)
	if i := slices.IndexFunc(saved.ShareWrites, func(op shareOp) bool { return op.ID == id }); i < 0 || saved.ShareWrites[i].Sent == nil {
		t.Fatalf("the saved state doesn't journal the write as sent: %+v", saved.ShareWrites)
	}
	return access, id
}

// A share write the service took, whose acknowledgement couldn't be saved,
// stays journaled as sent, and is settled by the account's history, never
// written afresh: once the share is left elsewhere while another account
// was signed in, the share stays left when its account is back, and its
// grant goes. That holds with the share's tombstone pruned meanwhile too:
// the pull of the account back is a full one, which can't rule out that
// the create landed.
func TestAShareWriteWhoseSettlingFailedIsNotWrittenAfresh(t *testing.T) {
	for _, c := range []struct {
		name  string
		prune bool
	}{
		{"its tombstone kept", false},
		{"its tombstone pruned", true},
	} {
		t.Run(c.name, func(t *testing.T) {
			quietSync(t)
			quietShares(t)
			w, srv := newWorker(t, "")
			relay, base := shareRelay(t, true)
			d := shareDevice(t, srv)
			ctx := context.Background()
			_, id := acceptWithAckUnsaved(t, w, relay, base, d)
			signInAs(t, w, d, "")
			if err := d.SyncMachines(ctx); err != nil {
				t.Fatal(err)
			}
			w.mu.Lock()
			w.tombstone(id) // another device leaves the share
			if c.prune {
				w.prune(id)
			}
			w.mu.Unlock()
			signInAs(t, w, d, "acct")
			if err := d.SyncMachines(ctx); err != nil {
				t.Fatal(err)
			}
			if _, live := w.live()[id]; live {
				t.Fatal("the left share was written to the account again")
			}
			if grants, _ := d.SharedConnections(); len(grants) != 0 {
				t.Fatalf("the left share's grant is still held: %+v", grants)
			}
		})
	}
}

// restartDevice is d's app run again from its folder, signed in to the
// worker's first account ("acct"): nothing of d's memory carries over.
func restartDevice(t *testing.T, d *Desk, srv *httptest.Server) *Desk {
	t.Helper()
	d.Disconnect()
	restarted := newDesk(d.dir)
	signInTo(restarted, srv, "acct")
	restarted.accountStore = account.NewSecretsStore(noSecrets{}, errors.New("not found"))
	restarted.statements = account.NewStatementCache(restarted.account)
	t.Cleanup(restarted.Disconnect)
	return restarted
}

// A sent create whose acknowledgement no save holds, read back after a
// restart by a full pull (another account's state in between, or a 410
// once the share's tombstone was pruned), is settled as left elsewhere:
// the full pull can't rule out that it landed and was deleted. No POST
// writes it again, and its grant goes.
func TestASentCreateAFullPullCantRuleOutIsNotWrittenAfresh(t *testing.T) {
	for _, c := range []struct {
		name string
		// away signs another account in after the accept; awayFails makes
		// its sync save nothing (its pull fails).
		away, awayFails bool
	}{
		{"the same account, its pull told to start over (410)", false, false},
		{"another account signed in, its sync failed", true, true},
		{"another account signed in and synced", true, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			quietSync(t)
			quietShares(t)
			w, srv := newWorker(t, "")
			w.seedPrompt("prompt-1", `{"text":"held"}`) // pulls past 0 are incremental
			relay, base := shareRelay(t, true)
			d := shareDevice(t, srv)
			ctx := context.Background()
			_, id := acceptWithAckUnsaved(t, w, relay, base, d)
			if c.away {
				signInAs(t, w, d, "")
				// Failing, the other account's sync saves nothing: neither
				// the sync state (a folder where its temporary file goes)
				// nor anything past its pull.
				blocker := filepath.Join(d.dir, "account-sync.json.tmp")
				if c.awayFails {
					if err := os.MkdirAll(filepath.Join(blocker, "x"), 0o700); err != nil {
						t.Fatal(err)
					}
				}
				w.mu.Lock()
				w.failPull = c.awayFails
				w.mu.Unlock()
				if err := d.SyncMachines(ctx); (err != nil) != c.awayFails {
					t.Fatalf("the other account's sync: %v", err)
				}
				if err := os.RemoveAll(blocker); err != nil {
					t.Fatal(err)
				}
			}
			// Another device leaves the share, and its tombstone is pruned.
			w.mu.Lock()
			w.tombstone(id)
			w.prune(id)
			posts := w.posts
			w.mu.Unlock()
			restarted := restartDevice(t, d, srv)
			if err := restarted.SyncMachines(ctx); err != nil {
				t.Fatal(err)
			}
			w.mu.Lock()
			sent := w.posts - posts
			w.mu.Unlock()
			if _, live := w.live()[id]; live || sent != 0 {
				t.Fatalf("the left share was written to the account again (%d pushes)", sent)
			}
			if grants, _ := restarted.SharedConnections(); len(grants) != 0 {
				t.Fatalf("the left share's grant is still held: %+v", grants)
			}
			if shares := sharesOf(t, restarted); len(shares) != 0 {
				t.Fatalf("the left share is still listed: %+v", shares)
			}
		})
	}
}

// A sent create the account's history proves never landed is sent again,
// once: its push answered 503, the pull after it incremental, or a full
// one with nothing written since, or one after the account moved on
// whose history from the send the service still holds; or its push
// refused (provably nothing written), whatever pull comes after, another
// account's in between and a full one of this account back included.
func TestASentCreateThatNeverLandedIsSentAgainOnce(t *testing.T) {
	for _, c := range []struct {
		name string
		// seed is a prompt on the account first, so its pulls past it are
		// incremental; refused fills the account instead of failing the
		// push; away signs another account in and syncs it first, and
		// moveOn writes another prompt to the account meanwhile.
		seed, refused, away, moveOn bool
	}{
		{"its pull after incremental", true, false, false, false},
		{"a full pull, the account unwritten since", false, false, false, false},
		{"a full pull after another account, the account unwritten since", true, false, true, false},
		{"a full pull after another account, the account written since", true, false, true, true},
		{"refused, a full pull after another account, the account written since", true, true, true, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			quietSync(t)
			quietShares(t)
			w, srv := newWorker(t, "")
			if c.seed {
				w.seedPrompt("prompt-1", `{"text":"held"}`)
			}
			w.mu.Lock()
			if c.refused {
				w.maxItems = 1 // full
			} else {
				w.failPush = true
			}
			w.mu.Unlock()
			relay, base := shareRelay(t, true)
			d := shareDevice(t, srv)
			ctx := context.Background()
			access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
			if err != nil || !access.AccountBound || access.AccountShare == shareConfirmed {
				t.Fatalf("bound accept: %+v, %v; want it unconfirmed", access, err)
			}
			id := relay.HostID() + "/" + access.GuestID
			w.mu.Lock()
			w.failPush, w.maxItems = false, 0
			w.mu.Unlock()
			if c.away {
				signInAs(t, w, d, "")
				if err := d.SyncMachines(ctx); err != nil {
					t.Fatal(err)
				}
				if c.moveOn {
					w.seedPrompt("prompt-2", `{"text":"meanwhile"}`) // the account moves on
				}
				signInAs(t, w, d, "acct")
			}
			w.mu.Lock()
			posts := w.posts
			w.mu.Unlock()
			if err := d.SyncMachines(ctx); err != nil {
				t.Fatal(err)
			}
			w.mu.Lock()
			sent := w.posts - posts
			w.mu.Unlock()
			if _, live := w.live()[id]; !live || sent != 1 {
				t.Fatalf("the share on the account: %v, in %d pushes; want it, in 1", live, sent)
			}
			if grants, err := d.SharedConnections(); err != nil || len(grants) != 1 || grants[0].AccountShare != shareConfirmed {
				t.Fatalf("after the sync: %+v, %v; want the share confirmed", grants, err)
			}
		})
	}
}

// A create whose dispatch had no answer may still land late, after the
// next pull proved it hadn't: if it lands, is left on another device and
// its tombstone pruned before a full readback, the readback is what
// can't rule it out, nor can the service's history (pruned past it). Its
// re-send that round was refused (rate limited, so it wrote nothing) and
// owes it as the late one did. The write is let go with its grant in
// the ask's own save, so another account signed in and synced before
// this one's next sync changes nothing; it isn't written afresh.
func TestASentCreateThatLandedLateBeforeAFullReadbackIsLetGo(t *testing.T) {
	for _, away := range []bool{false, true} {
		t.Run(map[bool]string{false: "the next sync", true: "another account synced first"}[away], func(t *testing.T) {
			quietSync(t)
			quietShares(t)
			w, srv := newWorker(t, "")
			w.seedPrompt("prompt-1", `{"text":"held"}`)
			relay, base := shareRelay(t, true)
			d := shareDevice(t, srv)
			ctx := context.Background()
			w.mu.Lock()
			w.failPush = true
			w.mu.Unlock()
			access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
			if err != nil || !access.AccountBound || access.AccountShare == shareConfirmed {
				t.Fatalf("bound accept: %+v, %v; want it unconfirmed", access, err)
			}
			id := relay.HostID() + "/" + access.GuestID
			w.mu.Lock()
			w.failPush = false
			w.mu.Unlock()
			// The next sync sends it again; the service keeps that push to
			// land late, and the sync gives it up.
			syncGivingUpTheUpload(t, w, d)
			// A full first push of prompts, so the share's re-send goes
			// second.
			for i := range account.MaxPushChanges {
				if _, err := d.SavePrompt(SavedPrompt{Text: fmt.Sprintf("prompt %d", i)}); err != nil {
					t.Fatal(err)
				}
			}
			landed := false
			w.mu.Lock()
			w.rateLimit, w.windowPosts = 1, 0
			w.afterPush = func() {
				w.landHeldLocked()
				it, ok := w.items[id]
				landed = ok && !it.Deleted
				w.tombstone(id)
				w.prune(id)
			}
			w.mu.Unlock()
			if err := d.SyncMachines(ctx); err == nil {
				t.Fatal("a sync whose second push was rate limited: no error")
			}
			w.mu.Lock()
			landedLate := landed
			w.rateLimit = 0
			w.mu.Unlock()
			if !landedLate {
				t.Fatal("the held create did not land on the account")
			}
			// The readback's own ask settled it: pruned past it, let go.
			if owed := savedSyncState(t, d).ShareWrites; slices.ContainsFunc(owed, func(op shareOp) bool { return op.ID == id }) {
				t.Fatalf("after the readback's ask: owed %+v; want the create let go", owed)
			}
			if away {
				signInAs(t, w, d, "")
				if err := d.SyncMachines(ctx); err != nil {
					t.Fatal(err)
				}
				signInAs(t, w, d, "acct")
			}
			w.mu.Lock()
			posts := w.posts
			w.mu.Unlock()
			if err := d.SyncMachines(ctx); err != nil {
				t.Fatal(err)
			}
			w.mu.Lock()
			sent := w.posts - posts
			w.mu.Unlock()
			if _, live := w.live()[id]; live || sent != 0 {
				t.Fatalf("the left share on the account: %v, in %d pushes; want it gone, in none", live, sent)
			}
			if grants, err := d.SharedConnections(); err != nil || len(grants) != 0 {
				t.Fatalf("connections: %+v, %v; want the left share's grant gone", grants, err)
			}
		})
	}
}

// Two creates sent in one push share the revision their history is asked
// from. When a full readback lists one (A, written meanwhile by another
// device) and lacks the other (C), only C is asked for, and only C is
// settled by the answer (pruned past it: let go with its grant): A, live,
// keeps its grant and isn't named gone.
func TestAHistoryAnswerSettlesOnlyTheCreatesItWasAskedFor(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	w.seedPrompt("prompt-1", `{"text":"held"}`)
	d := shareDevice(t, srv)
	ctx := context.Background()
	accept := func() (guest.Access, string) {
		t.Helper()
		relay, base := shareRelay(t, true)
		access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
		if err != nil || !access.AccountBound || access.AccountShare == shareConfirmed {
			t.Fatalf("bound accept: %+v, %v; want it unconfirmed", access, err)
		}
		return access, relay.HostID() + "/" + access.GuestID
	}
	// Both sent with no answer, the second accept's push carrying both.
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	a, idA := accept()
	c, idC := accept()
	w.mu.Lock()
	w.failPush = false
	w.mu.Unlock()
	sentAt := map[string]int64{}
	for _, op := range savedSyncState(t, d).ShareWrites {
		if op.Sent != nil {
			sentAt[op.ID] = op.SentAt
		}
	}
	if len(sentAt) != 2 || sentAt[idA] != sentAt[idC] {
		t.Fatalf("sent at %v; want both creates sent from one revision", sentAt)
	}
	// Back from another account, this one moved on meanwhile, the ask
	// answering 503: both creates' proofs are owed.
	signInAs(t, w, d, "")
	if err := d.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	w.seedPrompt("prompt-2", `{"text":"meanwhile"}`)
	signInAs(t, w, d, "acct")
	w.mu.Lock()
	w.onPull = func() { w.failPull = true }
	w.mu.Unlock()
	if err := d.SyncMachines(ctx); err == nil {
		t.Fatal("a round whose history ask failed: no error")
	}
	var body json.RawMessage
	for _, op := range savedSyncState(t, d).ShareWrites {
		if op.ID == idA && op.Unproven {
			body, _ = json.Marshal(op.Body)
		}
	}
	if body == nil {
		t.Fatalf("A after a failed ask: owed %+v; want its proof owed", savedSyncState(t, d).ShareWrites)
	}
	// The next round: its own ask answers 503; a prompt is pushed; then
	// another device writes A, and the history is pruned past both sends
	// (prompt-1's tombstone), so the readback starts over: A live, C not.
	if _, err := d.SavePrompt(SavedPrompt{Text: "to push"}); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.onPull = func() { w.failPull = true }
	w.afterPush = func() {
		w.rev++
		w.items[idA] = account.Item{Collection: "shares", ID: idA, Rev: w.rev, Body: body}
		w.tombstone("prompt-1")
		w.prune("prompt-1")
	}
	w.mu.Unlock()
	if err := d.SyncMachines(ctx); err == nil {
		t.Fatal("a round whose first history ask failed: no error")
	}
	if gone := savedSyncState(t, d).SharesGone; slices.Contains(gone, idA) {
		t.Fatalf("shares gone %q; want A, listed live by the readback, not among them", gone)
	}
	held := map[string]bool{}
	grants, err := d.SharedConnections()
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range grants {
		held[g.GuestID] = true
	}
	if !held[a.GuestID] || held[c.GuestID] {
		t.Fatalf("grants %+v; want A's kept and C's gone", grants)
	}
	if _, live := w.live()[idC]; live {
		t.Fatal("C, its history pruned past it, was written to the account")
	}
}

// A full readback (from an empty account's 0) that lacks a create whose
// push had no answer doesn't let it go while the service still holds its
// history from the send: nothing was pruned, so the readback would list
// a landing and its tombstone. The create is sent again at the next sync.
func TestASentCreateAFullReadbackLacksIsKeptWhileItsHistoryIs(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	relay, base := shareRelay(t, true)
	d := shareDevice(t, srv)
	ctx := context.Background()
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
	if err != nil || !access.AccountBound || access.AccountShare == shareConfirmed {
		t.Fatalf("bound accept: %+v, %v; want it unconfirmed", access, err)
	}
	id := relay.HostID() + "/" + access.GuestID
	// A full first push of prompts, so the share's re-send goes second and
	// is rate limited, after the first is read back.
	for i := range account.MaxPushChanges {
		if _, err := d.SavePrompt(SavedPrompt{Text: fmt.Sprintf("prompt %d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	w.mu.Lock()
	w.failPush = false
	w.rateLimit, w.windowPosts = 1, 0
	w.mu.Unlock()
	if err := d.SyncMachines(ctx); err == nil {
		t.Fatal("a sync whose second push was rate limited: no error")
	}
	// The readback's own ask settled it: never landed, owed as unsent.
	if owed := savedSyncState(t, d).ShareWrites; !slices.ContainsFunc(owed, func(op shareOp) bool { return op.ID == id && !op.Unproven }) {
		t.Fatalf("after the readback's ask: owed %+v; want the create owed, proven", owed)
	}
	w.mu.Lock()
	w.rateLimit = 0
	posts := w.posts
	w.mu.Unlock()
	if err := d.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	sent := w.posts - posts
	w.mu.Unlock()
	if _, live := w.live()[id]; !live || sent != 1 {
		t.Fatalf("the share on the account: %v, in %d pushes; want it, in 1", live, sent)
	}
	if grants, err := d.SharedConnections(); err != nil || len(grants) != 1 || grants[0].AccountShare != shareConfirmed {
		t.Fatalf("after the sync: %+v, %v; want the share confirmed", grants, err)
	}
}

// A full readback whose ask of the service's history fails still applies
// what it settles. Share B, just acknowledged, was deleted elsewhere and
// its tombstone pruned, so the readback starts over and lacks it; it
// also lacks the older create A, sent with no answer and whose re-send
// the rate limit stopped, and the ask for A's history answers 503. B is
// not confirmed and its grant goes; A stays owed as it is, unsent, until
// a later ask settles it (refused: pruned past it, so let go with its
// grant).
func TestAFullReadbackWhoseHistoryAskFailsStillAppliesWhatItSettles(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	w.seedPrompt("prompt-1", `{"text":"held"}`)
	d := shareDevice(t, srv)
	ctx := context.Background()
	// accept accepts another host's invitation, bound, failing as fail
	// sets the worker to, and returns the share's item id.
	accept := func(fail func()) (guest.Access, string) {
		t.Helper()
		relay, base := shareRelay(t, true)
		w.mu.Lock()
		fail()
		w.mu.Unlock()
		access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
		if err != nil || !access.AccountBound || access.AccountShare == shareConfirmed {
			t.Fatalf("bound accept: %+v, %v; want it unconfirmed", access, err)
		}
		w.mu.Lock()
		w.failPush, w.failPull = false, false
		w.mu.Unlock()
		return access, relay.HostID() + "/" + access.GuestID
	}
	a, idA := accept(func() { w.failPush = true }) // sent, no answer
	b, idB := accept(func() { w.failPull = true }) // owed, unsent
	// The next round's writes start at B, as after a rate limit that
	// stopped there (PushFrom), and fill a first push with prompts: B goes
	// in the first, A in the second, which the rate limit stops.
	for i := range account.MaxPushChanges {
		if _, err := d.SavePrompt(SavedPrompt{Text: fmt.Sprintf("prompt %d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	d.storeMu.Lock()
	state, err := d.loadSyncState()
	if err == nil {
		state.PushFrom = "shares/" + idB
		err = d.storeSyncState(state)
	}
	d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.rateLimit, w.windowPosts = 1, 0
	w.afterPush = func() {
		w.tombstone(idB)
		w.prune(idB)
		// The readback's 410, its pull from 0, then the ask: 503.
		w.onPull = func() { w.onPull = func() { w.failPull = true } }
	}
	w.mu.Unlock()
	if err := d.SyncMachines(ctx); err == nil {
		t.Fatal("a round whose history ask failed: no error")
	}
	grantOf := func(guestID string) (guest.Access, bool) {
		t.Helper()
		grants, err := d.SharedConnections()
		if err != nil {
			t.Fatal(err)
		}
		i := slices.IndexFunc(grants, func(g guest.Access) bool { return g.GuestID == guestID })
		if i < 0 {
			return guest.Access{}, false
		}
		return grants[i], true
	}
	if g, ok := grantOf(b.GuestID); ok && g.AccountShare == shareConfirmed {
		t.Fatalf("B, deleted before the full readback: %+v; want it not confirmed", g)
	}
	if g, ok := grantOf(a.GuestID); !ok || g.AccountShare == shareConfirmed {
		t.Fatalf("A, its history unknown: %+v (held %v); want it held, unconfirmed", g, ok)
	}
	if owed := savedSyncState(t, d).ShareWrites; !slices.ContainsFunc(owed, func(op shareOp) bool {
		return op.ID == idA && op.Sent != nil && op.Unproven
	}) {
		t.Fatalf("A, its history unknown: owed %+v; want it sent, its proof owed", owed)
	}
	if _, live := w.live()[idA]; live {
		t.Fatal("A was written to the account")
	}
	// The next sync's ask fails too (its pull, then the ask: 503): the
	// merge still lets B's grant go, and keeps A as it is, unsent.
	w.mu.Lock()
	w.rateLimit = 0
	w.onPull = func() { w.failPull = true }
	w.mu.Unlock()
	if err := d.SyncMachines(ctx); err == nil {
		t.Fatal("a round whose history ask failed: no error")
	}
	if _, ok := grantOf(b.GuestID); ok {
		t.Fatal("B's grant is still held after a merge that knew it gone")
	}
	if g, ok := grantOf(a.GuestID); !ok || g.AccountShare == shareConfirmed {
		t.Fatalf("A, its history still unknown: %+v (held %v); want it held, unconfirmed", g, ok)
	}
	if _, live := w.live()[idA]; live {
		t.Fatal("A, its history still unknown, was written to the account")
	}
	// Asked again, the service answers: pruned past A, which is let go.
	if err := d.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if _, live := w.live()[idA]; live {
		t.Fatal("A, its history pruned past it, was written to the account")
	}
	if grants, err := d.SharedConnections(); err != nil || len(grants) != 0 {
		t.Fatalf("after the next sync: %+v, %v; want both grants gone", grants, err)
	}
}

// An accept's round commits what its full readback settled before it
// asks the service's history, so however the ask ends, the accept says
// what the readback found. Share A is owed, sent with no answer and its
// proof owed (Unproven). B is accepted: its round's own ask for A
// answers 503, B goes alone, is acknowledged, then deleted elsewhere and
// pruned, so the readback starts over and lacks both; then the ask for
// A's history answers 503, or holds until the accept's deadline. Either
// way B is not confirmed and A stays owed as it is, unwritten, until the
// next sync's ask settles it (pruned past it: let go, with no write).
func TestAnAcceptsReadbackIsCommittedBeforeItsHistoryAsk(t *testing.T) {
	for _, hang := range []bool{false, true} {
		t.Run(map[bool]string{false: "the ask answers 503", true: "the ask holds until the deadline"}[hang], func(t *testing.T) {
			quietSync(t)
			quietShares(t)
			w, srv := newWorker(t, "")
			w.seedPrompt("prompt-1", `{"text":"held"}`)
			d := shareDevice(t, srv)
			ctx := context.Background()
			accept := func() (guest.Access, string) {
				t.Helper()
				relay, base := shareRelay(t, true)
				access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
				if err != nil || !access.AccountBound {
					t.Fatalf("bound accept: %+v, %v", access, err)
				}
				return access, relay.HostID() + "/" + access.GuestID
			}
			w.mu.Lock()
			w.failPush = true
			w.mu.Unlock()
			_, idA := accept() // sent, no answer
			w.mu.Lock()
			w.failPush = false
			w.mu.Unlock()
			// Back from another account, this one moved on meanwhile: the
			// full pull can't rule A out, and the ask for its history
			// answers 503, so A's proof is owed.
			signInAs(t, w, d, "")
			if err := d.SyncMachines(ctx); err != nil {
				t.Fatal(err)
			}
			w.seedPrompt("prompt-2", `{"text":"meanwhile"}`)
			signInAs(t, w, d, "acct")
			w.mu.Lock()
			w.onPull = func() { w.failPull = true }
			w.mu.Unlock()
			if err := d.SyncMachines(ctx); err == nil {
				t.Fatal("a round whose history ask failed: no error")
			}
			unproven := func() bool {
				return slices.ContainsFunc(savedSyncState(t, d).ShareWrites, func(op shareOp) bool { return op.ID == idA && op.Unproven })
			}
			if !unproven() {
				t.Fatalf("A after a failed ask: owed %+v; want its proof owed", savedSyncState(t, d).ShareWrites)
			}
			if hang {
				wait := acceptShareWait
				acceptShareWait = 2 * time.Second
				t.Cleanup(func() { acceptShareWait = wait })
			}
			stalled := make(chan struct{}, 1)
			var idB string
			w.mu.Lock()
			w.onPull = func() { w.failPull = true } // the round's own ask for A
			w.afterPush = func() {
				for id, it := range w.items {
					if it.Collection == "shares" && !it.Deleted {
						idB = id
					}
				}
				w.tombstone(idB)
				w.prune(idB)
				// The readback's 410, its pull from 0, then the ask.
				w.onPull = func() {
					w.onPull = func() {
						if hang {
							w.stall, w.stalled = make(chan struct{}), stalled
						} else {
							w.failPull = true
						}
					}
				}
			}
			w.mu.Unlock()
			b, wantB := accept()
			w.mu.Lock()
			if w.stall != nil {
				close(w.stall)
				w.stall = nil
			}
			gotB := idB
			w.mu.Unlock()
			if hang && len(stalled) == 0 {
				t.Fatal("the ask for A's history was never held")
			}
			if gotB != wantB {
				t.Fatalf("the share acknowledged and deleted: %q; want B's", gotB)
			}
			if b.AccountShare == shareConfirmed {
				t.Fatalf("B, deleted before the readback the accept committed: the accept says %q", b.AccountShare)
			}
			if _, live := w.live()[idA]; live || !unproven() {
				t.Fatalf("A: live %v, owed %+v; want it unwritten, its proof owed", live, savedSyncState(t, d).ShareWrites)
			}
			w.mu.Lock()
			posts := w.posts
			w.mu.Unlock()
			if err := d.SyncMachines(ctx); err != nil {
				t.Fatal(err)
			}
			w.mu.Lock()
			sent := w.posts - posts
			w.mu.Unlock()
			if _, live := w.live()[idA]; live || sent != 0 {
				t.Fatalf("A, its history pruned past it: live %v, in %d pushes; want neither", live, sent)
			}
			if grants, err := d.SharedConnections(); err != nil || len(grants) != 0 {
				t.Fatalf("after the next sync: %+v, %v; want A's and B's grants gone", grants, err)
			}
		})
	}
}

// A bound accept owns one sync round: with background syncs on (as in the
// app) and the account full, it sends its write once; the owed write is
// left for the next sync, no second round started for it.
func TestABoundAcceptSendsItsWriteOnce(t *testing.T) {
	quietSync(t)
	quietShares(t)
	backgroundMachineSync = true // quietSync's cleanup puts it back
	w, srv := newWorker(t, "")
	w.seedPrompt("prompt-1", `{"text":"held"}`)
	w.mu.Lock()
	w.maxItems = 1 // full
	w.mu.Unlock()
	relay, base := shareRelay(t, true)
	d := shareDevice(t, srv)
	posts := func() int {
		w.mu.Lock()
		defer w.mu.Unlock()
		return w.posts
	}
	access, err := d.AcceptGuestInvitation(context.Background(), relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
	if err != nil || access.AccountShare != shareRefused {
		t.Fatalf("bound accept: %+v, %v; want refused", access, err)
	}
	// The accept's own round ran within it; any other it started runs in
	// the background (syncMachinesSoon): wait for every one to end before
	// counting.
	d.accountSync.background.Wait()
	if n := posts(); n != 1 {
		t.Fatalf("the accept sent %d pushes, want 1", n)
	}
}

// A share write whose journal (Sent, journalShareWrites) can't be saved
// before its push isn't sent: no request reaches the service, the write is
// still owed and not marked sent. Once the state can be saved, the next
// sync sends it once, and the share is confirmed. The save fails at the
// sync state's writer (accountSync.writeState): a write of a state that
// marks a share write sent fails, any other goes through.
func TestAShareWriteWhoseJournalCantBeSavedIsNotSent(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	relay, base := shareRelay(t, true)
	d := shareDevice(t, srv)
	ctx := context.Background()
	posts := func() int {
		w.mu.Lock()
		defer w.mu.Unlock()
		return w.posts
	}
	failJournal := true // syncs run on this goroutine
	d.accountSync.writeState = func(path string, raw []byte) error {
		var state syncState
		if err := json.Unmarshal(raw, &state); err != nil {
			return err
		}
		if failJournal && slices.ContainsFunc(state.ShareWrites, func(op shareOp) bool { return op.Sent != nil }) {
			return errors.New("no space left on device")
		}
		return writeFileAtomic(path, raw)
	}
	access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
	if err != nil || !access.AccountBound || access.AccountShare != shareQueued {
		t.Fatalf("bound accept: %+v, %v; want the share queued", access, err)
	}
	if n := posts(); n != 0 {
		t.Fatalf("%d pushes reached the service with no journal saved, want none", n)
	}
	id := relay.HostID() + "/" + access.GuestID
	d.storeMu.Lock()
	state, err := d.loadSyncState()
	d.storeMu.Unlock()
	if i := slices.IndexFunc(state.ShareWrites, func(op shareOp) bool { return op.ID == id }); err != nil || i < 0 || state.ShareWrites[i].Sent != nil {
		t.Fatalf("the write isn't owed unsent: %+v, %v", state.ShareWrites, err)
	}
	if _, live := w.live()[id]; live {
		t.Fatal("the share is on the account")
	}
	failJournal = false
	if err := d.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if n := posts(); n != 1 {
		t.Fatalf("the next sync sent %d pushes, want 1", n)
	}
	grants, err := d.SharedConnections()
	if err != nil || len(grants) != 1 || grants[0].AccountShare != shareConfirmed {
		t.Fatalf("after the next sync: %+v, %v; want the share confirmed", grants, err)
	}
	if _, live := w.live()[id]; !live {
		t.Fatal("the share isn't on the account")
	}
}

// A readback that carries an earlier tombstone for a share followed by a live
// re-add on a later page leaves the share live in the final mirror: the local
// grant must stay and the share must not appear in SharesGone.
func TestReadbackKeepsLocalGrantWhenLiveAfterEarlierTombstone(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	relay, base := shareRelay(t, true)
	d := shareDevice(t, srv)
	ctx := context.Background()

	access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
	if err != nil || access.AccountShare != shareConfirmed {
		t.Fatalf("initial accept: %+v, %v", access, err)
	}
	id := relay.HostID() + "/" + access.GuestID
	liveItem := w.items[id]
	if liveItem.Body == nil {
		t.Fatalf("expected share %s in worker", id)
	}

	// Queue a prompt push so SyncMachines performs a readback; tombstone id
	// in onPush (so its rev precedes the pushed prompt and lands on readback
	// page 1), then re-add id live via onNextPage so a later page carries the
	// live share.
	if _, err := d.SavePrompt(SavedPrompt{Text: "trigger readback"}); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.onPush = func() {
		w.tombstone(id)
	}
	w.afterPush = func() {
		w.pageSize = 1
		w.onNextPage = func() {
			w.rev++
			w.items[id] = account.Item{Collection: "shares", ID: id, Rev: w.rev, Body: liveItem.Body}
		}
	}
	w.mu.Unlock()
	if err := d.SyncMachines(ctx); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if gone := savedSyncState(t, d).SharesGone; slices.Contains(gone, id) {
		t.Fatalf("SharesGone contains live share %s: %v", id, gone)
	}
	grants, err := d.SharedConnections()
	if err != nil || len(grants) != 1 || grants[0].GuestID != access.GuestID || grants[0].AccountShare != shareConfirmed {
		t.Fatalf("grants after tombstone+readd readback: %+v, %v", grants, err)
	}
}

// A push conflict carrying a tombstone for a share followed by a readback
// showing the share live again keeps the local grant and excludes it from
// SharesGone.
func TestReadbackKeepsLocalGrantWhenLiveAfterConflictTombstone(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	relay, base := shareRelay(t, true)
	d := shareDevice(t, srv)
	ctx := context.Background()

	// Accept while push fails so the share write is queued (base_rev 0) and
	// the local grant is held.
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
	if err != nil || !access.AccountBound {
		t.Fatalf("initial accept: %+v, %v", access, err)
	}
	w.mu.Lock()
	w.failPush = false
	w.mu.Unlock()
	id := relay.HostID() + "/" + access.GuestID
	bodyStruct, err := shareBodyOf(access)
	if err != nil {
		t.Fatal(err)
	}
	liveBody, err := json.Marshal(bodyStruct)
	if err != nil {
		t.Fatal(err)
	}

	// Queue a prompt alongside the owed share create so the push acks the
	// prompt while the share create conflicts with a server tombstone, then
	// re-add the share live before the readback runs.
	if _, err := d.SavePrompt(SavedPrompt{Text: "acked alongside conflict"}); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.onPush = func() {
		w.rev++
		w.items[id] = account.Item{Collection: "shares", ID: id, Rev: w.rev, Deleted: true}
	}
	w.afterPush = func() {
		w.rev++
		w.items[id] = account.Item{Collection: "shares", ID: id, Rev: w.rev, Body: liveBody}
	}
	w.mu.Unlock()
	if err := d.SyncMachines(ctx); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if gone := savedSyncState(t, d).SharesGone; slices.Contains(gone, id) {
		t.Fatalf("SharesGone contains live share %s: %v", id, gone)
	}
	grants, err := d.SharedConnections()
	if err != nil || len(grants) != 1 || grants[0].GuestID != access.GuestID || grants[0].AccountShare != shareConfirmed {
		t.Fatalf("grants after conflict tombstone + live readback: %+v, %v", grants, err)
	}
}

// When AcceptGuestInvitation's own sync removes the grant (e.g. deleted from
// the account meanwhile), Accept returns AccountShare == shareRemoved — never
// confirmed or empty — even if saving sync state afterward fails.
func TestBoundAcceptReportsRemovedWhenSyncDropsGrant(t *testing.T) {
	for _, failStateSave := range []bool{false, true} {
		name := "save_ok"
		if failStateSave {
			name = "save_fails"
		}
		t.Run(name, func(t *testing.T) {
			quietSync(t)
			quietShares(t)
			w, srv := newWorker(t, "")
			relay, base := shareRelay(t, true)
			d := shareDevice(t, srv)
			ctx := context.Background()

			// Delete the newly pushed share immediately on the server so the
			// accept's own readback sees its tombstone and drops the local grant.
			var seenID string
			w.mu.Lock()
			w.afterPush = func() {
				for id, it := range w.items {
					if it.Collection == "shares" && !it.Deleted {
						seenID = id
						w.tombstone(id)
					}
				}
			}
			w.mu.Unlock()
			if failStateSave {
				d.accountSync.writeState = func(path string, raw []byte) error {
					var state syncState
					if err := json.Unmarshal(raw, &state); err == nil && seenID != "" && slices.Contains(state.SharesGone, seenID) {
						return errors.New("disk full after dropGoneShares")
					}
					return writeFileAtomic(path, raw)
				}
			}
			access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
			if err != nil {
				t.Fatalf("accept err: %v", err)
			}
			if access.AccountShare != "removed" {
				t.Fatalf("accept AccountShare=%q, want %q", access.AccountShare, "removed")
			}
			grants, err := d.SharedConnections()
			if err != nil || len(grants) != 0 {
				t.Fatalf("grants after removed accept: %+v, %v; want none", grants, err)
			}
		})
	}
}

// When readback drops a deleted share's local grant and saving the updated
// sync state then fails, the stale on-disk mirror must not let SyncedShares
// list that share or let OpenSyncedShare recreate its grant and connect.
func TestFailedReadbackSaveKeepsRemovedShareGone(t *testing.T) {
	w, srv, relay, _, _, access := acceptBound(t)
	id := relay.HostID() + "/" + access.GuestID
	d2 := shareDevice(t, srv)
	ctx := context.Background()
	if err := d2.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if err := d2.OpenSyncedShare(ctx, id); err != nil {
		t.Fatal(err)
	}
	connected := func() bool {
		d2.mu.Lock()
		defer d2.mu.Unlock()
		return d2.link != nil && d2.link.guest != nil
	}
	waitFor(t, "the opened share connected", connected)

	// Queue an unrelated local prompt on d2 so the next sync pushes a change
	// and enters the readback path after d1 deletes the share.
	if _, err := d2.SavePrompt(SavedPrompt{Nickname: "note", Text: "hello"}); err != nil {
		t.Fatal(err)
	}
	// Delete the share on the server after d2's push lands, so d2's readback
	// observes the tombstone, calls dropGoneShares, and then hits the
	// writeState failure before committing the updated mirror.
	w.mu.Lock()
	w.afterPush = func() {
		w.afterPush = nil
		w.tombstone(id)
	}
	w.mu.Unlock()
	d2.accountSync.writeState = func(path string, raw []byte) error {
		var state syncState
		if err := json.Unmarshal(raw, &state); err == nil && slices.Contains(state.SharesGone, id) {
			return errors.New("disk full after readback dropGoneShares")
		}
		return writeFileAtomic(path, raw)
	}
	if err := d2.SyncMachines(ctx); err == nil {
		t.Fatal("readback whose sync-state save failed succeeded")
	}
	if grants, err := d2.guestStore.List(); err != nil || len(grants) != 0 {
		t.Fatalf("local grant survived readback drop: %+v, %v", grants, err)
	}
	if connected() {
		t.Fatal("connection stayed open after readback drop")
	}
	if shares, err := d2.SyncedShares(); err != nil || len(shares) != 0 {
		t.Fatalf("SyncedShares listed removed share after failed readback save: %+v, %v", shares, err)
	}
	if err := d2.OpenSyncedShare(ctx, id); !errors.Is(err, errShareGone) {
		t.Fatalf("OpenSyncedShare after failed readback save = %v, want %v", err, errShareGone)
	}
	if grants, err := d2.guestStore.List(); err != nil || len(grants) != 0 {
		t.Fatalf("OpenSyncedShare recreated removed grant: %+v, %v", grants, err)
	}
	if connected() {
		t.Fatal("OpenSyncedShare reconnected removed share")
	}

	// Restart Desktop on the same data dir before any recovery sync commits:
	// the durable deletion marker must still keep the removed share hidden and
	// unopenable from the stale on-disk mirror.
	restarted := newDesk(d2.dir)
	restarted.account = d2.account
	if shares, err := restarted.SyncedShares(); err != nil || len(shares) != 0 {
		t.Fatalf("after restart, SyncedShares listed removed share: %+v, %v", shares, err)
	}
	if err := restarted.OpenSyncedShare(ctx, id); !errors.Is(err, errShareGone) {
		t.Fatalf("after restart, OpenSyncedShare = %v, want %v", err, errShareGone)
	}
	if grants, err := restarted.guestStore.List(); err != nil || len(grants) != 0 {
		t.Fatalf("after restart, OpenSyncedShare recreated removed grant: %+v, %v", grants, err)
	}

	// Once disk writes recover, the next sync commits the mirror and the
	// share remains absent.
	d2.accountSync.writeState = nil
	if err := d2.SyncMachines(ctx); err != nil {
		t.Fatalf("recovery sync failed: %v", err)
	}
	if shares, err := d2.SyncedShares(); err != nil || len(shares) != 0 {
		t.Fatalf("SyncedShares after recovery: %+v, %v", shares, err)
	}
	if err := d2.OpenSyncedShare(ctx, id); !errors.Is(err, errShareGone) {
		t.Fatalf("OpenSyncedShare after recovery = %v, want %v", err, errShareGone)
	}
}

// When settleShareProofs drops a grant and saving the updated sync state fails,
// a subsequent sync whose history probe fails (503) commits a merge that still
// keeps the unsettled ShareWrite. Pruning must NOT clear the durable deletion
// marker for that unsettled write until a commit actually retires it.
func TestFailedProofSaveMaskSurvivesInconclusiveMerge(t *testing.T) {
	quietSync(t)
	quietShares(t)
	w, srv := newWorker(t, "")
	w.seedPrompt("prompt-1", `{"text":"held"}`)
	relay, base := shareRelay(t, true)
	d := shareDevice(t, srv)
	ctx := context.Background()

	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
	if err != nil || !access.AccountBound || access.AccountShare == shareConfirmed {
		t.Fatalf("bound accept: %+v, %v; want it unconfirmed", access, err)
	}
	id := relay.HostID() + "/" + access.GuestID
	w.mu.Lock()
	w.failPush = false
	w.mu.Unlock()

	// Send the share create so the service holds it to land late, then abandon.
	syncGivingUpTheUpload(t, w, d)
	for i := range account.MaxPushChanges {
		if _, err := d.SavePrompt(SavedPrompt{Text: fmt.Sprintf("prompt %d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	w.mu.Lock()
	w.rateLimit, w.windowPosts = 1, 0
	w.afterPush = func() {
		w.landHeldLocked()
		w.tombstone(id)
		w.prune(id)
	}
	w.mu.Unlock()
	// Fail settleShareProofs's sync-state save after it drops the grant so the
	// ShareWrite stays on disk as Unproven.
	d.accountSync.writeState = func(path string, raw []byte) error {
		var state syncState
		if err := json.Unmarshal(raw, &state); err == nil && !slices.ContainsFunc(state.ShareWrites, func(op shareOp) bool { return op.ID == id }) {
			return errors.New("disk full on settleShareProofs save")
		}
		return writeFileAtomic(path, raw)
	}
	if err := d.SyncMachines(ctx); err == nil {
		t.Fatal("sync with failed settleShareProofs save succeeded")
	}
	w.mu.Lock()
	w.rateLimit = 0
	w.mu.Unlock()
	if grants, err := d.guestStore.List(); err != nil || len(grants) != 0 {
		t.Fatalf("grant survived proof drop: %+v, %v", grants, err)
	}
	if shares, err := d.SyncedShares(); err != nil || len(shares) != 0 {
		t.Fatalf("SyncedShares listed dropped share: %+v, %v", shares, err)
	}

	// Now allow state writes, but fail the history probe (503) so the next
	// merge commits while keeping the unsettled ShareWrite.
	d.accountSync.writeState = nil
	w.mu.Lock()
	w.onPull = func() { w.failPull = true }
	w.mu.Unlock()
	_ = d.SyncMachines(ctx)
	if shares, err := d.SyncedShares(); err != nil || len(shares) != 0 {
		t.Fatalf("inconclusive merge relisted dropped share: %+v, %v", shares, err)
	}
}
