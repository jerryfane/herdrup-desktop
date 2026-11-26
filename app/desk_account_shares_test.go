package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
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
// AccountShare), the synced list doesn't list it, and the next sync lets
// the grant go.
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
	if access.AccountShare != "" {
		t.Fatalf("a share deleted before its readback: the accept says %q, want nothing", access.AccountShare)
	}
	if len(w.live()) != 0 || len(sharesOf(t, d)) != 0 {
		t.Fatalf("rows %v, synced shares %+v; want none", w.live(), sharesOf(t, d))
	}
	if grants, _ := d.SharedConnections(); len(grants) != 1 || grants[0].AccountShare != "" {
		t.Fatalf("before the next sync: %+v; want the grant, not confirmed", grants)
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
	if access.AccountShare != "" {
		t.Fatalf("a share deleted before its full readback: the accept says %q, want nothing", access.AccountShare)
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
// is settled by that acknowledgement, never written afresh: owed in memory
// until a save holds it, it says the account holds the share, and once the
// share is left elsewhere while another account was signed in, the share
// stays left when its account is back, and its grant goes. That holds with
// the share's tombstone pruned meanwhile too, where the account's history
// alone can't tell the write (a create, on base 0) from one that never
// landed.
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
			access, id := acceptWithAckUnsaved(t, w, relay, base, d)
			if access.AccountShare != shareConfirmed {
				t.Errorf("the service took the write: the accept says %q, want confirmed", access.AccountShare)
			}
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

// A share write's acknowledgement whose save failed is written by the next
// save of the sync state, with no restart in between: a local change's (a
// prompt deleted here), or an account switch's, which saves it first, even
// when the switch's own sync then fails. The saved state holds the share
// as the account's, its write no longer owed, so a restart, which loses
// what was owed in memory, still knows the write landed.
func TestAShareAckWhoseSaveFailedIsSavedByTheNextSave(t *testing.T) {
	for _, c := range []struct {
		name string
		save func(t *testing.T, w *syncWorker, d *Desk)
	}{
		{"a prompt deleted here", func(t *testing.T, _ *syncWorker, d *Desk) {
			if _, err := d.DeletePrompt("prompt-1"); err != nil {
				t.Fatal(err)
			}
			if saved := savedSyncState(t, d); !slices.Contains(saved.PromptDeletes, "prompt-1") {
				t.Fatalf("the save lost its own change: %+v", saved.PromptDeletes)
			}
		}},
		{"another account signed in, its sync failed", func(t *testing.T, w *syncWorker, d *Desk) {
			signInAs(t, w, d, "")
			w.mu.Lock()
			w.failPull = true
			w.mu.Unlock()
			if err := d.SyncMachines(context.Background()); err == nil {
				t.Fatal("a sync whose pull failed reported success")
			}
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			quietSync(t)
			quietShares(t)
			w, srv := newWorker(t, "")
			w.seedPrompt("prompt-1", `{"text":"held"}`)
			relay, base := shareRelay(t, true)
			d := shareDevice(t, srv)
			_, id := acceptWithAckUnsaved(t, w, relay, base, d)
			if grants, err := d.SharedConnections(); err != nil || len(grants) != 1 || grants[0].AccountShare != shareConfirmed {
				t.Errorf("before the next save: %+v, %v; want the share confirmed", grants, err)
			}
			c.save(t, w, d)
			saved := savedSyncState(t, d)
			if slices.ContainsFunc(saved.ShareWrites, func(op shareOp) bool { return op.ID == id }) || !slices.Contains(saved.SharesHeld["acct"], id) {
				t.Fatalf("the next save: writes %+v, held %v; want the share held, its write not owed", saved.ShareWrites, saved.SharesHeld)
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
	// A round the accept left behind would be waiting for the sync's turn:
	// let it have the turn a few times before counting.
	for range 20 {
		d.accountSync.turn <- struct{}{}
		<-d.accountSync.turn
		time.Sleep(10 * time.Millisecond)
	}
	if n := posts(); n != 1 {
		t.Fatalf("the accept sent %d pushes, want 1", n)
	}
}

// A share write whose journal (Sent, journalShareWrites) can't be saved
// before its push isn't sent: no request reaches the service, the write is
// still owed and not marked sent. Once the state can be saved, the next
// sync sends it once, and the share is confirmed.
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
	// The accept's round fails at its pull, so its write stays owed.
	w.mu.Lock()
	w.failPull = true
	w.mu.Unlock()
	access, err := d.AcceptGuestInvitation(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), "account")
	if err != nil || !access.AccountBound {
		t.Fatalf("bound accept: %+v, %v", access, err)
	}
	if n := posts(); n != 0 {
		t.Fatalf("the accept's failed round sent %d pushes", n)
	}
	id := relay.HostID() + "/" + access.GuestID
	// The next pull brings another device's prompt; once the merge is
	// written (publishSavedPrompts, before the push's prepare), the sync
	// state can't be: a folder where its temporary file goes.
	blocker := filepath.Join(d.dir, "account-sync.json.tmp")
	published := publishSavedPrompts
	publishSavedPrompts = func([]SavedPrompt) {
		publishSavedPrompts = published
		if err := os.MkdirAll(filepath.Join(blocker, "x"), 0o700); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { publishSavedPrompts = published })
	w.mu.Lock()
	w.otherDeviceWritesBodyLocked("00000000-0000-4000-8000-0000000000aa", `{"text":"q","order":1}`)
	w.mu.Unlock()
	if err := d.SyncMachines(ctx); err == nil {
		t.Fatal("a round whose journal couldn't be saved reported success")
	}
	if n := posts(); n != 0 {
		t.Fatalf("%d pushes reached the service with no journal saved, want none", n)
	}
	if err := os.RemoveAll(blocker); err != nil {
		t.Fatal(err)
	}
	d.storeMu.Lock()
	state, err := d.loadSyncState()
	d.storeMu.Unlock()
	if i := slices.IndexFunc(state.ShareWrites, func(op shareOp) bool { return op.ID == id }); err != nil || i < 0 || state.ShareWrites[i].Sent != nil {
		t.Fatalf("the write isn't owed unsent: %+v, %v", state.ShareWrites, err)
	}
	if _, live := w.live()[id]; live {
		t.Fatal("the share is on the account")
	}
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
