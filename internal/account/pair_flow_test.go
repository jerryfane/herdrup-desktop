package account_test

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/account"
	"github.com/jerryfane/herdrup-desktop/internal/fakeaccount"
	"github.com/jerryfane/herdrup-desktop/internal/pairing"
)

const acct = "acct-1"

type memStore struct {
	mu  sync.Mutex
	raw []byte
}

func (m *memStore) Get() ([]byte, error) { m.mu.Lock(); defer m.mu.Unlock(); return m.raw, nil }
func (m *memStore) Set(v []byte) error   { m.mu.Lock(); defer m.mu.Unlock(); m.raw = v; return nil }
func (m *memStore) Delete() error        { m.mu.Lock(); defer m.mu.Unlock(); m.raw = nil; return nil }

// deviceKey is an install's X25519 device key.
type deviceKey struct{ k *ecdh.PrivateKey }

func (d deviceKey) PublicKey() []byte { return d.k.PublicKey().Bytes() }
func (d deviceKey) SharedSecret(peer []byte) ([]byte, error) {
	pub, err := ecdh.X25519().NewPublicKey(peer)
	if err != nil {
		return nil, err
	}
	return d.k.ECDH(pub)
}

func fixedKey(t *testing.T, seed byte) deviceKey {
	t.Helper()
	k, err := ecdh.X25519().NewPrivateKey(bytes.Repeat([]byte{seed}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return deviceKey{k}
}

// bench is one account on fakeaccount with a new device (asking), an
// approver (a Mac) and a browser, each signed in with its own client.
type bench struct {
	svc     *fakeaccount.Service
	elapsed atomic.Int64 // nanoseconds the service's clock has moved
	// intercept is the service's Intercept, swapped while it serves.
	intercept      atomic.Pointer[func(w http.ResponseWriter, r *http.Request) bool]
	newDev, mac    *account.Client
	web            *account.Client
	newKey, macKey deviceKey
	ssh            pairing.PairKey
}

func newBench(t *testing.T) *bench {
	t.Helper()
	b := &bench{svc: fakeaccount.New(), newKey: fixedKey(t, 0xb0), macKey: fixedKey(t, 0x70)}
	start := time.Unix(1_800_000_000, 0)
	b.svc.Now = func() time.Time { return start.Add(time.Duration(b.elapsed.Load())) }
	b.svc.Intercept = func(w http.ResponseWriter, r *http.Request) bool {
		f := b.intercept.Load()
		return f != nil && (*f)(w, r)
	}
	srv := httptest.NewServer(b.svc)
	t.Cleanup(srv.Close)
	client := func(d fakeaccount.Device) *account.Client {
		raw, _ := json.Marshal(map[string]string{"refresh_token": b.svc.AddDevice(d), "account_id": acct})
		return account.New(srv.URL, d.Platform, &memStore{raw: raw}, srv.Client())
	}
	pub := func(k deviceKey) string { return base64.RawURLEncoding.EncodeToString(k.PublicKey()) }
	b.newDev = client(fakeaccount.Device{ID: "dev-new", Pub: pub(b.newKey), Name: "Studio PC", Platform: "windows"})
	b.mac = client(fakeaccount.Device{ID: "dev-mac", Pub: pub(b.macKey), Name: "Jerry's Mac", Platform: "macos"})
	b.web = client(fakeaccount.Device{ID: "dev-web", Pub: pub(fixedKey(t, 0xe0)), Name: "Chrome", Platform: "web"})
	var err error
	if b.ssh, err = pairing.NewPairKey("Studio PC"); err != nil {
		t.Fatal(err)
	}
	return b
}

func (b *bench) advance(d time.Duration) { b.elapsed.Add(int64(d)) }

func (b *bench) ask(t *testing.T) *account.PairAsk {
	t.Helper()
	ask, err := b.newDev.AskToPair(context.Background(), acct, b.newKey, b.ssh.Public)
	if err != nil {
		t.Fatal(err)
	}
	return ask
}

// listed is the one pair request the approver sees.
func (b *bench) listed(t *testing.T) account.PairRequest {
	t.Helper()
	reqs, err := b.mac.PairRequests(context.Background(), acct)
	if err != nil || len(reqs) != 1 {
		t.Fatalf("approver lists %+v, %v", reqs, err)
	}
	return reqs[0]
}

// claimed is the approver's claim of the listed request, after the new
// device revealed (its Poll), with the new device's code.
func (b *bench) claimed(t *testing.T, ask *account.PairAsk) (*account.PairApproval, string) {
	t.Helper()
	ctx := context.Background()
	a, err := b.mac.StartPairApproval(ctx, acct, b.macKey, b.listed(t))
	if err != nil {
		t.Fatal(err)
	}
	prog, err := ask.Poll(ctx)
	if err != nil || prog.Code == "" || prog.Approver != "Jerry's Mac" {
		t.Fatalf("new device after the claim: %+v, %v", prog, err)
	}
	if err := a.AwaitReveal(ctx); err != nil {
		t.Fatal(err)
	}
	return a, prog.Code
}

// approved is a request the approver approved at seq 1 with one machine.
func (b *bench) approved(t *testing.T) (*account.PairAsk, *account.PairApproval) {
	t.Helper()
	ctx := context.Background()
	ask := b.ask(t)
	a, code := b.claimed(t, ask)
	if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
		t.Fatalf("the new device's own code: %+v, %v", c, err)
	}
	if err := a.Approve(ctx, 1, machines("studio")); err != nil {
		t.Fatal(err)
	}
	return ask, a
}

const hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1AF8PoQ4lakrcKp00bfrycmCzPLsSWjMDNVfEq9GYM"

func machines(nicknames ...string) account.PairEnvelope {
	env := account.PairEnvelope{V: account.PairEnvelopeVersion}
	for _, n := range nicknames {
		env.Machines = append(env.Machines, account.PairMachine{Nickname: n, Host: n + ".local", Port: 22, User: "jerry",
			HostKey: hostKey, Status: account.PairAdded})
	}
	return env
}

func apiError(err error, status int, code string) bool {
	var api *account.APIError
	return errors.As(err, &api) && api.Status == status && api.Code == code
}

func TestAPairedDeviceAddsTheNewDevicesKeyAndTheNewDeviceOpensTheMachineList(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	if ok, err := b.mac.PairOffered(ctx); !ok || err != nil {
		t.Fatalf("pair_v1 offered = %v, %v", ok, err)
	}
	ask := b.ask(t)
	if prog, err := ask.Poll(ctx); err != nil || prog.State != account.ApprovalWaiting || prog.Code != "" || prog.ExpiresIn != 600 {
		t.Fatalf("waiting: %+v, %v", prog, err)
	}
	req := b.listed(t)
	if req.ID != ask.ID() || req.Requester.Name != "Studio PC" || req.Claimed != "no" {
		t.Fatalf("listed %+v", req)
	}
	line, err := req.AuthorizedKey()
	if err != nil || line != strings.Join(strings.Fields(b.ssh.PublicLine)[:2], " ") {
		t.Fatalf("the key the approver adds = %q, %v; the new device's is %q", line, err, b.ssh.PublicLine)
	}
	if mine, err := b.newDev.PairRequests(ctx, acct); err != nil || len(mine) != 0 {
		t.Fatalf("the new device lists its own request: %+v, %v", mine, err)
	}

	a, code := b.claimed(t, ask)
	if err := a.Approve(ctx, 1, machines("studio")); !errors.Is(err, account.ErrCodeNotChecked) {
		t.Fatalf("approve before the code: %v", err)
	}
	if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
		t.Fatalf("code %s refused: %+v, %v", code, c, err)
	}
	if _, err := a.Live(ctx, time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := ask.Machines(ctx); ok || err != nil {
		t.Fatalf("machines before the approval: %v, %v", ok, err)
	}
	if err := a.Approve(ctx, 0, machines("studio")); !errors.Is(err, account.ErrPairSeq) {
		t.Fatalf("seq 0: %v", err)
	}
	if err := a.Approve(ctx, 1, machines("studio")); err != nil {
		t.Fatal(err)
	}
	got, ok, err := ask.Machines(ctx)
	if err != nil || !ok || got.Seq != 1 || len(got.Envelope.Machines) != 1 || got.Envelope.Machines[0].Nickname != "studio" {
		t.Fatalf("machines = %+v, %v, %v", got, ok, err)
	}
	if prog, err := ask.Poll(ctx); err != nil || prog.State != account.ApprovalApproved || !prog.Final {
		t.Fatalf("after the approval: %+v, %v", prog, err)
	}

	// A retry that reached another machine replaces the list.
	if err := a.Resend(ctx, 1, machines("studio", "nas")); !errors.Is(err, account.ErrPairSeq) {
		t.Fatalf("resend at the approval's seq: %v", err)
	}
	if err := a.Resend(ctx, 2, machines("studio", "nas")); err != nil || a.Seq() != 2 {
		t.Fatalf("resend: %v, seq %d", err, a.Seq())
	}
	got, ok, err = ask.Machines(ctx)
	if err != nil || !ok || got.Seq != 2 || len(got.Envelope.Machines) != 2 {
		t.Fatalf("machines after the retry = %+v, %v, %v", got, ok, err)
	}
}

func TestAResendBeforeTheApprovalOrAfterItsTenMinutesIsRefused(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask := b.ask(t)
	a, _ := b.claimed(t, ask)
	if err := a.Resend(ctx, 2, machines("studio")); !errors.Is(err, account.ErrPairNotApproved) {
		t.Fatalf("resend before approving: %v", err)
	}
	if err := b.mac.PutPairEnvelope(ctx, acct, ask.ID(), 2, strings.Repeat("A", 40)); !apiError(err, 409, account.PairErrNotApproved) {
		t.Fatalf("service, before the approval: %v", err)
	}

	b2 := newBench(t)
	_, a2 := b2.approved(t)
	b2.advance(fakeaccount.OutcomeKeep)
	if err := a2.Resend(ctx, 2, machines("studio")); !apiError(err, http.StatusGone, "expired") {
		t.Fatalf("resend after 10 minutes: %v", err)
	}
}

// The service takes a replacement envelope only from the claimant and only
// above the seq it holds, whatever the approver's own count says.
func TestTheServiceTakesOnlyAHigherSeqFromTheClaimant(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask, a := b.approved(t)
	if err := a.Resend(ctx, 3, machines("studio")); err != nil {
		t.Fatal(err)
	}
	seal := func(seq uint64) string {
		sealed, err := account.SealPairEnvelope(b.macKey, b.newKey.PublicKey(), b.ssh.Public, ask.ID(), seq, []byte(`{"v":1,"machines":[]}`))
		if err != nil {
			t.Fatal(err)
		}
		return sealed
	}
	for _, seq := range []uint64{3, 2} {
		if err := b.mac.PutPairEnvelope(ctx, acct, ask.ID(), seq, seal(seq)); !apiError(err, http.StatusConflict, account.PairErrStaleSeq) {
			t.Fatalf("seq %d after 3: %v", seq, err)
		}
	}
	if err := b.newDev.PutPairEnvelope(ctx, acct, ask.ID(), 5, seal(5)); !apiError(err, http.StatusNotFound, "not_found") {
		t.Fatalf("the requester's own envelope: %v", err)
	}
	if got, ok, err := ask.Machines(ctx); err != nil || !ok || got.Seq != 3 {
		t.Fatalf("machines = %+v, %v, %v", got, ok, err)
	}
	if err := b.mac.PutPairEnvelope(ctx, acct, ask.ID(), 4, seal(4)); err != nil {
		t.Fatal(err)
	}
	if got, ok, err := ask.Machines(ctx); err != nil || !ok || got.Seq != 4 || len(got.Envelope.Machines) != 0 {
		t.Fatalf("machines = %+v, %v, %v", got, ok, err)
	}
}

func TestARequestExpiresAfterTenMinutesForBothDevices(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask := b.ask(t)
	a, code := b.claimed(t, ask)
	if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
		t.Fatal(c, err)
	}
	b.advance(fakeaccount.RequestTTL)
	if prog, err := ask.Poll(ctx); err != nil || prog.State != account.ApprovalExpired || !prog.Final || prog.Code != code {
		t.Fatalf("new device: %+v, %v", prog, err)
	}
	if _, err := a.Live(ctx, time.Minute); !errors.Is(err, account.ErrApprovalEnded) {
		t.Fatalf("approver: %v", err)
	}
	if err := a.Approve(ctx, 1, machines("studio")); err == nil {
		t.Fatal("approved an expired request")
	}
}

func TestANewRequestReplacesTheDevicesEarlierOne(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	first := b.ask(t)
	second := b.ask(t)
	if reqs := b.svc.Requests(); len(reqs) != 1 || reqs[0].ID != second.ID() || first.ID() == second.ID() {
		t.Fatalf("requests %+v", reqs)
	}
	if _, err := first.Poll(ctx); !errors.Is(err, account.ErrApprovalEnded) {
		t.Fatalf("the replaced request: %v", err)
	}
	if req := b.listed(t); req.ID != second.ID() {
		t.Fatalf("listed %s, want %s", req.ID, second.ID())
	}
}

// A service showing the approver another SSH key than the one the new
// device committed to is caught at the reveal: the key the approver would
// add isn't the new device's.
func TestASwappedSSHKeyIsCaughtByTheApprover(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask := b.ask(t)
	req := b.listed(t)
	other, err := pairing.NewPairKey("Mallory")
	if err != nil {
		t.Fatal(err)
	}
	req.SSHPub = base64.RawURLEncoding.EncodeToString(other.Public)
	a, err := b.mac.StartPairApproval(ctx, acct, b.macKey, req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ask.Poll(ctx); err != nil {
		t.Fatal(err)
	}
	if err := a.AwaitReveal(ctx); !errors.Is(err, account.ErrApproveTampered) {
		t.Fatalf("await reveal: %v", err)
	}
	if err := a.Ready(); !errors.Is(err, account.ErrApprovalEnded) {
		t.Fatalf("still ready: %v", err)
	}
}

// An envelope for this request naming another SSH key, or sealed by
// another approver, is refused.
func TestTheNewDeviceRefusesAnEnvelopeForAnotherKeyOrApprover(t *testing.T) {
	for _, tc := range []struct {
		name  string
		alter func(e map[string]any)
	}{
		{"ssh key", func(e map[string]any) {
			e["ssh_pub"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
		}},
		{"approver", func(e map[string]any) {
			e["approver_pub"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
		}},
		{"seq", func(e map[string]any) { e["seq"] = 2 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := newBench(t)
			ask, _ := b.approved(t)
			var tampered atomic.Bool
			intercept := func(w http.ResponseWriter, r *http.Request) bool {
				if r.URL.Path != account.PairSelfPath || !tampered.CompareAndSwap(false, true) {
					return false
				}
				rec := httptest.NewRecorder()
				b.svc.ServeHTTP(rec, r)
				var self map[string]any
				_ = json.Unmarshal(rec.Body.Bytes(), &self)
				tc.alter(self["envelopes"].([]any)[0].(map[string]any))
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(self)
				return true
			}
			b.intercept.Store(&intercept)
			if _, ok, err := ask.Machines(context.Background()); ok || !errors.Is(err, account.ErrApproveTampered) {
				t.Fatalf("machines: %v, %v", ok, err)
			}
		})
	}
}

// The new device's cancel ends the request on the service: the approver
// that claimed it can go no further, and every later step answers 410.
func TestACancelledRequestEndsForTheApprover(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask := b.ask(t)
	a, err := b.mac.StartPairApproval(ctx, acct, b.macKey, b.listed(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := ask.Cancel(ctx); err != nil {
		t.Fatal(err)
	}
	if reqs := b.svc.Requests(); reqs[0].Outcome != account.ApprovalCancelled || reqs[0].NonceB != "" {
		t.Fatalf("request after the cancel: %+v", reqs[0])
	}
	if _, err := ask.Poll(ctx); !errors.Is(err, account.ErrApprovalEnded) {
		t.Fatalf("poll after the cancel: %v", err)
	}
	if err := a.AwaitReveal(ctx); !errors.Is(err, account.ErrApprovalEnded) {
		t.Fatalf("approver after the cancel: %v", err)
	}
	if err := b.newDev.RevealPair(ctx, acct, ask.ID(), bytes.Repeat([]byte{1}, 32)); !apiError(err, http.StatusGone, "cancelled") {
		t.Fatalf("reveal after the cancel: %v", err)
	}
	sealed, err := account.SealPairEnvelope(b.macKey, b.newKey.PublicKey(), b.ssh.Public, ask.ID(), 1, []byte(`{"v":1,"machines":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := b.mac.PutPairEnvelope(ctx, acct, ask.ID(), 1, sealed); !apiError(err, http.StatusGone, "cancelled") {
		t.Fatalf("envelope after the cancel: %v", err)
	}
	if reqs, err := b.mac.PairRequests(ctx, acct); err != nil || len(reqs) != 0 {
		t.Fatalf("listed after the cancel: %+v, %v", reqs, err)
	}
	// A second cancel finds the request ended: nil.
	if err := ask.Cancel(ctx); err != nil {
		t.Fatalf("second cancel: %v", err)
	}
}

// Only the new device cancels, and not once the request is finished.
func TestOnlyTheNewDeviceCancelsAnOpenRequest(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask, _ := b.approved(t)
	if err := b.mac.CancelPair(ctx, acct, ask.ID()); !apiError(err, http.StatusNotFound, "not_found") {
		t.Fatalf("the approver's cancel: %v", err)
	}
	if err := ask.Cancel(ctx); !apiError(err, http.StatusConflict, "already_finished") {
		t.Fatalf("cancel after the approval: %v", err)
	}
	if _, ok, err := ask.Machines(ctx); ok || err != nil {
		t.Fatalf("machines after a cancel: %v, %v", ok, err)
	}
}

// GET ?kind=any splits by kind: the approver polls one list.
func TestAnyApprovalsListsBothKinds(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask := b.ask(t)
	lists, err := b.mac.AnyApprovals(ctx, acct)
	if err != nil || len(lists.Pair) != 1 || lists.Pair[0].ID != ask.ID() || lists.Pair[0].Requester.Name != "Studio PC" || lists.Browser == nil || len(lists.Browser) != 0 {
		t.Fatalf("lists %+v, %v", lists, err)
	}
	// The service's browser entries (which the fake doesn't hold) go to Browser.
	intercept := func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Query().Get("kind") != "any" {
			return false
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"requests":[
			{"id":"web-1","kind":"browser","browser":{"device_id":"dev-web","name":"Chrome"},"commit":"c","claimed":"no","expires_in":300},
			{"id":"` + ask.ID() + `","kind":"pair","device":{"device_id":"dev-new","name":"Studio PC"},"commit":"c","ssh_pub":"s","claimed":"other","expires_in":200}]}`))
		return true
	}
	b.intercept.Store(&intercept)
	lists, err = b.mac.AnyApprovals(ctx, acct)
	if err != nil || len(lists.Browser) != 1 || lists.Browser[0].Browser.Name != "Chrome" || len(lists.Pair) != 1 || lists.Pair[0].Claimed != "other" {
		t.Fatalf("mixed lists %+v, %v", lists, err)
	}
}

func TestAnAbandonedRequestRevealsAndOpensNothing(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask := b.ask(t)
	ask.Abandon()
	if _, err := b.mac.StartPairApproval(ctx, acct, b.macKey, b.listed(t)); err != nil {
		t.Fatal(err)
	}
	if _, err := ask.Poll(ctx); !errors.Is(err, account.ErrApprovalEnded) {
		t.Fatalf("poll: %v", err)
	}
	if reqs := b.svc.Requests(); reqs[0].NonceB != "" {
		t.Fatal("an abandoned request revealed")
	}
	if _, ok, err := ask.Machines(ctx); ok || err != nil {
		t.Fatalf("machines: %v, %v", ok, err)
	}
}

func TestTheServiceRefusesTheRequesterItsOwnClaimAndBrowsersAPairRequest(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask := b.ask(t)
	if err := b.newDev.ClaimApproval(ctx, acct, ask.ID(), bytes.Repeat([]byte{1}, 32)); !apiError(err, http.StatusForbidden, account.PairErrOwnRequest) {
		t.Fatalf("own claim: %v", err)
	}
	commit, _ := account.PairCommit(b.newKey.PublicKey(), b.ssh.Public, bytes.Repeat([]byte{2}, 32))
	if _, err := b.web.RequestPair(ctx, acct, commit, b.ssh.Public); !apiError(err, http.StatusForbidden, account.PairErrNotNative) {
		t.Fatalf("browser request: %v", err)
	}
	if _, err := b.web.ReadPairSelf(ctx, acct); !apiError(err, http.StatusForbidden, account.PairErrNotNative) {
		t.Fatalf("browser pairs/self: %v", err)
	}
}

// The approver's read of a pair request carries what it needs to show it,
// and its nonce_b only to the claimant.
func TestAPairRequestsStateNamesTheDeviceAndKey(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask := b.ask(t)
	_, _ = b.claimed(t, ask)
	st, err := b.mac.ApprovalState(ctx, acct, ask.ID())
	if err != nil || st.Kind != account.PairKind || st.Device == nil || st.Device.Name != "Studio PC" ||
		st.SSHPub != base64.RawURLEncoding.EncodeToString(b.ssh.Public) || st.NonceB == "" {
		t.Fatalf("approver reads %+v, %v", st, err)
	}
	st, err = b.newDev.ApprovalState(ctx, acct, ask.ID())
	if err != nil || st.NonceT == "" || st.NonceB != "" {
		t.Fatalf("requester reads %+v, %v", st, err)
	}
}

// hold holds the first request of method to path in the service, before it
// reads anything, until release: entered closes once it's held.
func (b *bench) hold(t *testing.T, method, path string) (entered <-chan struct{}, release func()) {
	t.Helper()
	in, out := make(chan struct{}), make(chan struct{})
	var held atomic.Bool
	f := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == method && r.URL.Path == path && held.CompareAndSwap(false, true) {
			close(in)
			<-out
		}
		return false
	}
	b.intercept.Store(&f)
	release = sync.OnceFunc(func() { close(out) })
	t.Cleanup(release)
	return in, release
}

// An Abandon while a Poll's read is on the way stops the reveal it would
// have sent: the code is never shown, nonce_b never leaves the device.
func TestAnAbandonDuringAPollsReadRevealsNothing(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask := b.ask(t)
	if _, err := b.mac.StartPairApproval(ctx, acct, b.macKey, b.listed(t)); err != nil {
		t.Fatal(err)
	}
	entered, release := b.hold(t, http.MethodGet, "/v1/approvals/"+ask.ID())
	type polled struct {
		prog account.PairProgress
		err  error
	}
	done := make(chan polled, 1)
	go func() {
		prog, err := ask.Poll(ctx)
		done <- polled{prog, err}
	}()
	<-entered
	ask.Abandon()
	release()
	got := <-done
	if !errors.Is(got.err, account.ErrApprovalEnded) || got.prog.Code != "" || got.prog.State != account.ApprovalCancelled {
		t.Fatalf("poll = %+v, %v", got.prog, got.err)
	}
	if b.svc.Requests()[0].NonceB != "" || ask.RevealSent() {
		t.Fatal("an abandoned request revealed")
	}
}

// An Abandon while Machines reads opens nothing, and a list Machines gave
// is the caller's own copy.
func TestAnAbandonDuringMachinesOpensNothing(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask, _ := b.approved(t)
	got, ok, err := ask.Machines(ctx)
	if err != nil || !ok || got.Envelope.Machines[0].Nickname != "studio" {
		t.Fatalf("machines = %+v, %v, %v", got, ok, err)
	}
	got.Envelope.Machines[0].Nickname = "changed"
	if again, _, _ := ask.Machines(ctx); again.Envelope.Machines[0].Nickname != "studio" {
		t.Fatalf("a caller's change reached the next list: %+v", again)
	}

	entered, release := b.hold(t, http.MethodGet, account.PairSelfPath)
	type read struct {
		d   account.PairDelivery
		ok  bool
		err error
	}
	done := make(chan read, 1)
	go func() {
		d, ok, err := ask.Machines(ctx)
		done <- read{d, ok, err}
	}()
	<-entered
	ask.Abandon()
	release()
	if r := <-done; r.ok || r.err != nil || len(r.d.Envelope.Machines) != 0 {
		t.Fatalf("machines after the abandon = %+v", r)
	}
}

// A finish the service applied but whose answer was lost (and the state
// unreadable just then) is unknown; the retry, at a higher seq, finds the
// request approved and sends its list over the envelope route. When that
// fails too, the list is unknown and a Resend at NextSeq sends it.
func TestAnApprovalWhoseAnswerWasLostSendsItsListOverTheEnvelopeRoute(t *testing.T) {
	for _, putFails := range []bool{false, true} {
		b := newBench(t)
		ctx := context.Background()
		ask := b.ask(t)
		a, code := b.claimed(t, ask)
		if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
			t.Fatal(c, err)
		}
		var reads, puts atomic.Bool // down
		var lost atomic.Bool
		reads.Store(true)
		puts.Store(putFails)
		path := "/v1/approvals/" + ask.ID()
		f := func(w http.ResponseWriter, r *http.Request) bool {
			switch {
			case r.Method == http.MethodPost && r.URL.Path == path+"/finish" && lost.CompareAndSwap(false, true):
				b.svc.ServeHTTP(httptest.NewRecorder(), r)
				w.WriteHeader(http.StatusBadGateway)
			case r.Method == http.MethodGet && r.URL.Path == path && reads.Load(),
				r.Method == http.MethodPut && r.URL.Path == path+"/envelope" && puts.Load():
				w.WriteHeader(http.StatusServiceUnavailable)
			default:
				return false
			}
			return true
		}
		b.intercept.Store(&f)

		var not *account.NotApprovedError
		if err := a.Approve(ctx, 10, machines("studio")); err == nil || errors.As(err, &not) {
			t.Fatalf("approve with its answer lost: %v", err)
		}
		if got, ok, err := ask.Machines(ctx); err != nil || !ok || got.Seq != 10 {
			t.Fatalf("the service took seq 10: %+v, %v, %v", got, ok, err)
		}
		if err := a.Approve(ctx, 10, machines("studio", "nas")); !errors.As(err, &not) || !errors.Is(err, account.ErrPairSeq) {
			t.Fatalf("a retry at the same seq: %v", err)
		}
		reads.Store(false)
		err := a.Approve(ctx, 20, machines("studio", "nas"))
		want := uint64(20)
		if putFails {
			if !errors.Is(err, account.ErrPairListUnknown) || a.Seq() != 0 || a.NextSeq() != 21 {
				t.Fatalf("retry with the envelope route down: %v, seq %d, next %d", err, a.Seq(), a.NextSeq())
			}
			if got, _, _ := ask.Machines(ctx); got.Seq != 10 {
				t.Fatalf("machines = %+v", got)
			}
			puts.Store(false)
			err = a.Resend(ctx, a.NextSeq(), machines("studio", "nas"))
			want = 21
		}
		if err != nil || a.Seq() != want {
			t.Fatalf("putFails %v: %v, seq %d", putFails, err, a.Seq())
		}
		if got, ok, err := ask.Machines(ctx); err != nil || !ok || got.Seq != want || len(got.Envelope.Machines) != 2 {
			t.Fatalf("machines = %+v, %v, %v", got, ok, err)
		}
		if err := a.Approve(ctx, 30, machines("studio")); !errors.Is(err, account.ErrPairApproved) {
			t.Fatalf("approve after the approval: %v", err)
		}
	}
}

// The fake refuses a seq above JavaScript's safe integers, as the service
// does, and the approver never sends one.
func TestASeqAboveMaxPairSeqIsRefused(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask, a := b.approved(t)
	if err := a.Resend(ctx, account.MaxPairSeq+1, machines("studio")); !errors.Is(err, account.ErrPairSeq) {
		t.Fatalf("resend above MaxPairSeq: %v", err)
	}
	sealed, err := account.SealPairEnvelope(b.macKey, b.newKey.PublicKey(), b.ssh.Public, ask.ID(), account.MaxPairSeq+1, []byte(`{"v":1,"machines":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := b.mac.PutPairEnvelope(ctx, acct, ask.ID(), account.MaxPairSeq+1, sealed); !apiError(err, http.StatusBadRequest, "bad_request") {
		t.Fatalf("service, above MaxPairSeq: %v", err)
	}
	if err := a.Resend(ctx, account.MaxPairSeq, machines("studio")); err != nil {
		t.Fatal(err)
	}
}

// Only a native app's new device cancels.
func TestABrowserCantCancel(t *testing.T) {
	b := newBench(t)
	ask := b.ask(t)
	if err := b.web.CancelPair(context.Background(), acct, ask.ID()); !apiError(err, http.StatusForbidden, account.PairErrNotNative) {
		t.Fatalf("browser cancel: %v", err)
	}
}

// An approval's writes run one at a time: an Approve beside one in flight
// sends nothing until that one settles, then finds the request approved.
// (Two finishes at once could each count the other's list as its own.)
func TestOverlappingApprovesRunOneAtATime(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask := b.ask(t)
	a, code := b.claimed(t, ask)
	if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
		t.Fatal(c, err)
	}
	path := "/v1/approvals/" + ask.ID()
	var finishes, puts atomic.Int32
	entered, held := make(chan struct{}), make(chan struct{})
	release := sync.OnceFunc(func() { close(held) })
	t.Cleanup(release)
	f := func(w http.ResponseWriter, r *http.Request) bool {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == path+"/finish":
			if finishes.Add(1) == 1 {
				close(entered)
				<-held
			}
		case r.Method == http.MethodPut && r.URL.Path == path+"/envelope":
			puts.Add(1)
		}
		return false
	}
	b.intercept.Store(&f)

	first := make(chan error, 1)
	go func() { first <- a.Approve(ctx, 1, machines("studio")) }()
	<-entered
	others := make(chan error, 2)
	go func() { others <- a.Approve(ctx, 1, machines("studio", "nas")) }()
	go func() { others <- a.Approve(ctx, 2, machines("studio", "nas")) }()
	select {
	case err := <-others:
		t.Fatalf("an Approve ran beside the one in flight: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if n := finishes.Load(); n != 1 {
		t.Fatalf("%d finishes in flight", n)
	}
	release()
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := <-others; !errors.Is(err, account.ErrPairApproved) {
			t.Fatalf("an Approve after the approval: %v", err)
		}
	}
	if finishes.Load() != 1 || puts.Load() != 0 || a.Seq() != 1 || a.NextSeq() != 2 {
		t.Fatalf("finishes %d, puts %d, seq %d, next %d", finishes.Load(), puts.Load(), a.Seq(), a.NextSeq())
	}
	if got, ok, err := ask.Machines(ctx); err != nil || !ok || got.Seq != 1 || len(got.Envelope.Machines) != 1 {
		t.Fatalf("machines = %+v, %v, %v", got, ok, err)
	}
}

// An Abandon while the reveal waits for a fresh access token stops it: the
// reveal is marked sent only once it has its token and is about to go.
func TestAnAbandonDuringTheRevealsRefreshSendsNothing(t *testing.T) {
	b := newBench(t)
	b.svc.AccessExpiresIn = 60 // every request takes a fresh token
	ctx := context.Background()
	ask := b.ask(t)
	if _, err := b.mac.StartPairApproval(ctx, acct, b.macKey, b.listed(t)); err != nil {
		t.Fatal(err)
	}
	var refreshes, reveals atomic.Int32
	entered, held := make(chan struct{}), make(chan struct{})
	release := sync.OnceFunc(func() { close(held) })
	t.Cleanup(release)
	f := func(w http.ResponseWriter, r *http.Request) bool {
		switch r.URL.Path {
		case "/v1/auth/refresh":
			// The first is the status read's, the second the reveal's.
			if refreshes.Add(1) == 2 {
				close(entered)
				<-held
			}
		case "/v1/approvals/" + ask.ID() + "/reveal":
			reveals.Add(1)
		}
		return false
	}
	b.intercept.Store(&f)
	done := make(chan error, 1)
	go func() {
		_, err := ask.Poll(ctx)
		done <- err
	}()
	<-entered
	ask.Abandon()
	if ask.RevealSent() {
		t.Fatal("RevealSent while the reveal waits for its token")
	}
	release()
	if err := <-done; !errors.Is(err, account.ErrApprovalEnded) {
		t.Fatalf("poll = %v", err)
	}
	if reveals.Load() != 0 || b.svc.Requests()[0].NonceB != "" || ask.RevealSent() {
		t.Fatalf("an abandoned request revealed: %d reveals", reveals.Load())
	}
}

// The new device's stored cancel settles a finish whose answer was lost:
// the service takes no finish after it, so Approve is NotApprovedError.
func TestAStoredCancelSettlesAFinishWithALostAnswer(t *testing.T) {
	b := newBench(t)
	ctx := context.Background()
	ask := b.ask(t)
	a, code := b.claimed(t, ask)
	if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
		t.Fatal(c, err)
	}
	path := "/v1/approvals/" + ask.ID() + "/finish"
	var lost atomic.Bool
	f := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method != http.MethodPost || r.URL.Path != path || !lost.CompareAndSwap(false, true) {
			return false
		}
		if err := ask.Cancel(context.Background()); err != nil {
			t.Errorf("cancel: %v", err)
		}
		w.WriteHeader(http.StatusBadGateway)
		return true
	}
	b.intercept.Store(&f)
	var not *account.NotApprovedError
	if err := a.Approve(ctx, 1, machines("studio")); !errors.As(err, &not) {
		t.Fatalf("approve, cancelled meanwhile: %v", err)
	}
	if state, final, err := a.Outcome(ctx); err != nil || state != account.ApprovalCancelled || !final {
		t.Fatalf("outcome = %s, %v, %v", state, final, err)
	}
}
