package main

import (
	"bytes"
	"context"
	"crypto/dsa"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/account"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/fakeaccount"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"golang.org/x/crypto/ssh"
)

const pairAcct = "acct-1"

// pairWorld is fakeaccount with this desk as the new device and an iPhone
// approving, plus the machines the iPhone ticks (fakeherdr), each started
// once the new device's key S is known and accepting only it.
type pairWorld struct {
	svc       *fakeaccount.Service
	elapsed   atomic.Int64
	intercept atomic.Pointer[func(w http.ResponseWriter, r *http.Request) bool]
	d         *Desk
	phone     *account.Client
	phoneKey  x25519Browser
}

func newPairWorld(t *testing.T) *pairWorld {
	t.Helper()
	quietSync(t)
	w := &pairWorld{svc: fakeaccount.New()}
	start := time.Unix(1_800_000_000, 0)
	w.svc.Now = func() time.Time { return start.Add(time.Duration(w.elapsed.Load())) }
	w.svc.Intercept = func(rw http.ResponseWriter, r *http.Request) bool {
		f := w.intercept.Load()
		return f != nil && (*f)(rw, r)
	}
	srv := httptest.NewServer(w.svc)
	t.Cleanup(srv.Close)
	w.d = newDesk(t.TempDir())
	identity, err := w.d.guestIdentity()
	if err != nil {
		t.Fatal(err)
	}
	signIn := func(dev fakeaccount.Device) *account.Client {
		raw, _ := json.Marshal(map[string]string{"refresh_token": w.svc.AddDevice(dev), "account_id": pairAcct})
		return account.New(srv.URL, dev.Platform, &signedInStore{raw: raw}, srv.Client())
	}
	w.d.account = signIn(fakeaccount.Device{ID: "dev-mac", Pub: b64u(identity.PublicKey()), Name: "MacBook Air", Platform: "macos"})
	k, _ := ecdh.X25519().NewPrivateKey(bytes.Repeat([]byte{0x70}, 32))
	w.phoneKey = x25519Browser{k}
	w.phone = signIn(fakeaccount.Device{ID: "dev-phone", Pub: b64u(k.PublicKey().Bytes()), Name: "Jerry's iPhone", Platform: "ios"})
	return w
}

// start asks to pair and checks the waiting view.
func (w *pairWorld) start(t *testing.T) PairRequestView {
	t.Helper()
	ctx := context.Background()
	if ok, err := w.d.PairRequestOffered(ctx); !ok || err != nil {
		t.Fatalf("offered %v, %v", ok, err)
	}
	v, err := w.d.PairRequestStart(ctx)
	if err != nil || v.Phase != PairWaiting || v.Code != "" || v.ExpiresIn != 600 {
		t.Fatalf("start %+v, %v", v, err)
	}
	if v, err = w.d.PairRequestRead(ctx, v.ID); err != nil || v.Phase != PairWaiting || v.Code != "" {
		t.Fatalf("waiting %+v, %v", v, err)
	}
	return v
}

func (w *pairWorld) read(t *testing.T, id string) PairRequestView {
	t.Helper()
	v, err := w.d.PairRequestRead(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// claim is the iPhone opening the request: the desk shows the code, which
// the iPhone's user types.
func (w *pairWorld) claim(t *testing.T, id string) (*account.PairApproval, ssh.PublicKey, string) {
	t.Helper()
	ctx := context.Background()
	reqs, err := w.phone.PairRequests(ctx, pairAcct)
	if err != nil || len(reqs) != 1 || reqs[0].ID != id || reqs[0].Requester.Name != "MacBook Air" {
		t.Fatalf("the iPhone lists %+v, %v", reqs, err)
	}
	line, err := reqs[0].AuthorizedKey()
	if err != nil {
		t.Fatal(err)
	}
	s, _, _, _, err := ssh.ParseAuthorizedKey([]byte(line))
	if err != nil {
		t.Fatal(err)
	}
	a, err := w.phone.StartPairApproval(ctx, pairAcct, w.phoneKey, reqs[0])
	if err != nil {
		t.Fatal(err)
	}
	v := w.read(t, id)
	if v.Phase != PairClaimed || len(v.Code) != 4 || v.Approver != "Jerry's iPhone" {
		t.Fatalf("claimed %+v", v)
	}
	if err := a.AwaitReveal(ctx); err != nil {
		t.Fatal(err)
	}
	return a, s, v.Code
}

// pairMachine is a machine the iPhone can tick: a fake herdr accepting only
// the new device's key, or an address nothing answers at.
type pairMachine struct {
	srv      *fakeherdr.Server
	host     string
	port     int
	hostKey  ssh.PublicKey
	hostLine string
}

func newHostKey(t *testing.T) (ssh.Signer, string) {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	// The approver's pin as the envelope carries it: "<type> <base64>".
	return signer, strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
}

func servedMachine(t *testing.T, key ssh.PublicKey) pairMachine {
	t.Helper()
	signer, _ := newHostKey(t)
	return servedMachineKeys(t, key, signer)
}

// servedMachineKeys is a machine serving signer's host key, which the
// approver pins, and the extra ones beside it (an sshd's other key types).
func servedMachineKeys(t *testing.T, key ssh.PublicKey, signer ssh.Signer, extra ...ssh.Signer) pairMachine {
	t.Helper()
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	srv := &fakeherdr.Server{HostKey: signer, AdditionalHostKeys: extra, Authorized: key,
		Handle: func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				return fakeherdr.Pong(true), nil
			case "agent.list":
				return map[string]any{"type": "agent_list", "agents": []any{}}, nil
			}
			return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
		}}
	addr, err := srv.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Close() })
	host, port, _ := net.SplitHostPort(addr)
	n, _ := strconv.Atoi(port)
	return pairMachine{srv: srv, host: host, port: n, hostKey: signer.PublicKey(), hostLine: line}
}

// offNetwork is a machine at an address that refuses connections.
func offNetwork(t *testing.T) pairMachine {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	ln.Close()
	signer, line := newHostKey(t)
	return pairMachine{host: "127.0.0.1", port: addr.Port, hostKey: signer.PublicKey(), hostLine: line}
}

func (m pairMachine) entry(nickname, status, reason string) account.PairMachine {
	return account.PairMachine{Nickname: nickname, Host: m.host, Port: m.port, User: "jerry", HostKey: m.hostLine, Status: status, Reason: reason}
}

func pairEnvelope(ms ...account.PairMachine) account.PairEnvelope {
	return account.PairEnvelope{V: account.PairEnvelopeVersion, Machines: ms}
}

func (w *pairWorld) machines(t *testing.T) []Machine {
	t.Helper()
	w.d.storeMu.Lock()
	defer w.d.storeMu.Unlock()
	st, err := w.d.load()
	if err != nil {
		t.Fatal(err)
	}
	return st.Machines
}

func (w *pairWorld) identities(t *testing.T) []string {
	t.Helper()
	return entriesNamed(filepath.Join(w.d.dir, "identities"), "herdr-pair-", ".key")
}

func resultOf(v PairRequestView, label string) PairRequestMachine {
	for _, m := range v.Machines {
		if m.Label == label {
			return m
		}
	}
	return PairRequestMachine{}
}

// The whole request: the code once the iPhone opens it, then the machines
// it added the key to saved with S and their pins, linked to the account's
// record; the one it couldn't add is reported; the one off this network is
// saved but unreachable; and S opens a session on the reachable one.
func TestPairRequestSavesTheApprovedMachinesWithItsKeyAndPins(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	v := w.start(t)
	a, s, code := w.claim(t, v.ID)
	studio, offnet := servedMachine(t, s), offNetwork(t)
	// The account has studio, a password machine there, not saved here.
	const syncID = "0f1e2d3c-4b5a-4968-8776-655443322110"
	w.d.storeMu.Lock()
	err := w.d.storeSyncState(syncState{AccountID: pairAcct, Mirror: account.Mirror{Hosts: []account.RemoteHost{{ID: syncID, Rev: 1,
		Body: account.HostBody{Nickname: "studio", Host: studio.host, Port: studio.port, Username: "jerry", AuthKind: "password"}}}}})
	w.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if listed, err := w.d.SyncedMachines(); err != nil || len(listed) != 1 {
		t.Fatalf("to pair before: %+v, %v", listed, err)
	}
	if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
		t.Fatalf("the desk's code on the iPhone: %+v, %v", c, err)
	}
	if err := a.Approve(ctx, 1, pairEnvelope(
		studio.entry("Studio", account.PairAdded, ""),
		offnet.entry("laptop", account.PairAlready, ""),
		account.PairMachine{Nickname: "build-box", Host: "10.0.0.12", Port: 22, User: "jerry", Status: account.PairFailed, Reason: "timed out"},
	)); err != nil {
		t.Fatal(err)
	}
	v = w.read(t, v.ID)
	if v.Phase != PairDone || !v.RetryOpen || v.Code != code || len(v.Machines) != 3 {
		t.Fatalf("done %+v", v)
	}
	if r := resultOf(v, "studio"); r.Result != PairSaved || r.ID != "jerry@"+net.JoinHostPort(studio.host, strconv.Itoa(studio.port)) || r.Reach != "" {
		t.Fatalf("studio %+v", r)
	}
	if r := resultOf(v, "laptop"); r.Result != PairSaved {
		t.Fatalf("laptop %+v", r)
	}
	if r := resultOf(v, "build-box"); r.Result != PairNotAdded || r.Reason != "timed out" || r.ID != "" {
		t.Fatalf("build-box %+v", r)
	}
	saved := w.machines(t)
	keys := w.identities(t)
	if len(saved) != 2 || len(keys) != 1 {
		t.Fatalf("saved %+v, keys %v", saved, keys)
	}
	for _, m := range saved {
		if m.KeyPath != keys[0] || !m.Paired {
			t.Fatalf("saved %+v, want key %s, paired", m, keys[0])
		}
	}
	// Saved as the account's record: its nickname and sync id, so it isn't
	// offered to pair any more and doesn't sync as a second machine.
	if saved[0].Nickname != "studio" || saved[0].SyncID != syncID || saved[1].SyncID != "" {
		t.Fatalf("saved %+v", saved)
	}
	if listed, err := w.d.SyncedMachines(); err != nil || len(listed) != 0 {
		t.Fatalf("to pair after: %+v, %v", listed, err)
	}
	// S is the key file, and each pin is the iPhone's host key.
	pem, err := os.ReadFile(keys[0])
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.ParsePrivateKey(pem)
	if err != nil || !bytes.Equal(signer.PublicKey().Marshal(), s.Marshal()) {
		t.Fatalf("key file isn't S: %v", err)
	}
	for _, m := range []pairMachine{studio, offnet} {
		if pin, ok, _ := w.d.pins.Pin(net.JoinHostPort(m.host, strconv.Itoa(m.port))); !ok || pin != bridge.Fingerprint(m.hostKey) {
			t.Fatalf("pin of %d = %q, %v", m.port, pin, ok)
		}
	}

	v, err = w.d.PairRequestConnect(ctx, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r := resultOf(v, "studio"); r.Reach != PairOnline {
		t.Fatalf("studio %+v", r)
	}
	if r := resultOf(v, "laptop"); r.Reach != PairUnreachable {
		t.Fatalf("laptop %+v", r)
	}
	if r := resultOf(v, "build-box"); r.Reach != "" {
		t.Fatalf("build-box tried: %+v", r)
	}
	// Opening studio connects with S.
	t.Cleanup(w.d.Disconnect)
	if err := w.d.SelectMachine(resultOf(v, "studio").ID, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "studio connected", func() bool { return w.d.Board() != nil })
}

// A retry's list at a higher seq saves what the first couldn't, with the
// same key; once the retry window closed, a later one isn't read.
func TestPairRequestTakesARetrysHigherSeqWithinTheWindow(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	now := time.Unix(1_800_000_000, 0)
	pairNow = func() time.Time { return now }
	t.Cleanup(func() { pairNow = time.Now })
	v := w.start(t)
	a, s, code := w.claim(t, v.ID)
	studio, build := servedMachine(t, s), servedMachine(t, s)
	if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
		t.Fatal(c, err)
	}
	if err := a.Approve(ctx, 1, pairEnvelope(studio.entry("studio", account.PairAdded, ""), build.entry("build-box", account.PairFailed, "timed out"))); err != nil {
		t.Fatal(err)
	}
	if v = w.read(t, v.ID); resultOf(v, "build-box").Result != PairNotAdded || len(w.machines(t)) != 1 {
		t.Fatalf("first list %+v", v)
	}
	// Nothing new: the same list read again changes nothing.
	if v = w.read(t, v.ID); len(v.Machines) != 2 || len(w.machines(t)) != 1 {
		t.Fatalf("read again %+v", v)
	}
	now = now.Add(5 * time.Minute)
	if err := a.Resend(ctx, 2, pairEnvelope(studio.entry("studio", account.PairAlready, ""), build.entry("build-box", account.PairAdded, ""))); err != nil {
		t.Fatal(err)
	}
	v = w.read(t, v.ID)
	saved, keys := w.machines(t), w.identities(t)
	if r := resultOf(v, "build-box"); r.Result != PairSaved || len(saved) != 2 || len(keys) != 1 || saved[1].KeyPath != keys[0] {
		t.Fatalf("retry %+v, saved %+v, keys %v", v, saved, keys)
	}
	// The machine the first list saved stays as that list decided it ("saved", not
	// "kept" because this device now has it).
	if r := resultOf(v, "studio"); r.Result != PairSaved {
		t.Fatalf("studio after the retry %+v", r)
	}
	if v, err := w.d.PairRequestConnect(ctx, v.ID); err != nil || resultOf(v, "build-box").Reach != PairOnline {
		t.Fatalf("build-box %+v, %v", v, err)
	}
	// Ten minutes after the first list, the page stops reading.
	now = now.Add(5 * time.Minute)
	if err := a.Resend(ctx, 3, pairEnvelope(offNetwork(t).entry("late", account.PairAdded, ""))); err != nil {
		t.Fatal(err)
	}
	if v = w.read(t, v.ID); v.RetryOpen || resultOf(v, "late").Result != "" || len(w.machines(t)) != 2 {
		t.Fatalf("after the window %+v", v)
	}
}

// A machine saved here at the same host and port is kept as it is (key,
// password, pin), and one whose host key differs from this device's pin is
// not saved: nothing is overwritten. With nothing to save, S is never
// written.
func TestPairRequestNeverOverwritesASavedMachineOrPin(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	v := w.start(t)
	a, s, code := w.claim(t, v.ID)
	studio, other := servedMachine(t, s), servedMachine(t, s)
	mine := Machine{Nickname: "my studio", Host: studio.host, Port: studio.port, User: "root"}
	if err := w.d.SaveMachine(mine, ""); err != nil {
		t.Fatal(err)
	}
	const pinned = "00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff"
	otherAt := net.JoinHostPort(other.host, strconv.Itoa(other.port))
	if err := w.d.pins.SetPin(otherAt, pinned); err != nil {
		t.Fatal(err)
	}
	if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
		t.Fatal(c, err)
	}
	if err := a.Approve(ctx, 1, pairEnvelope(studio.entry("studio", account.PairAdded, ""), other.entry("other", account.PairAdded, ""))); err != nil {
		t.Fatal(err)
	}
	v = w.read(t, v.ID)
	if r := resultOf(v, "studio"); r.Result != PairKept || r.ID != machineID(Machine{Host: studio.host, Port: studio.port, User: "root"}) {
		t.Fatalf("studio %+v", r)
	}
	if r := resultOf(v, "other"); r.Result != PairPinDiffers || r.ID != "" {
		t.Fatalf("other %+v", r)
	}
	if saved := w.machines(t); len(saved) != 1 || saved[0].KeyPath != "" || saved[0].User != "root" || saved[0].Paired || saved[0].LocalID == "" || saved[0].LocalID != resultOf(v, "studio").ProfileID {
		t.Fatalf("saved %+v", saved)
	}
	if pin, _, _ := w.d.pins.Pin(otherAt); pin != pinned {
		t.Fatalf("pin overwritten: %s", pin)
	}
	if pin, ok, _ := w.d.pins.Pin(net.JoinHostPort(studio.host, strconv.Itoa(studio.port))); ok {
		t.Fatalf("the kept machine got a pin: %s", pin)
	}
	if keys := w.identities(t); len(keys) != 0 {
		t.Fatalf("unused keys written: %v", keys)
	}
}

// A list that doesn't open or verify saves nothing and ends the request.
func TestPairRequestSavesNothingFromATamperedList(t *testing.T) {
	for _, tc := range []struct {
		name  string
		alter func(e map[string]any)
	}{
		{"sealed", func(e map[string]any) {
			sealed := []byte(e["sealed"].(string))
			sealed[20] ^= 1
			e["sealed"] = string(sealed)
		}},
		{"seq", func(e map[string]any) { e["seq"] = 2 }},
		{"ssh key", func(e map[string]any) { e["ssh_pub"] = b64u(bytes.Repeat([]byte{9}, 32)) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := newPairWorld(t)
			ctx := context.Background()
			v := w.start(t)
			a, s, code := w.claim(t, v.ID)
			studio := servedMachine(t, s)
			if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
				t.Fatal(c, err)
			}
			if err := a.Approve(ctx, 1, pairEnvelope(studio.entry("studio", account.PairAdded, ""))); err != nil {
				t.Fatal(err)
			}
			var inner atomic.Bool // the service's own answer, read below, isn't intercepted
			intercept := func(rw http.ResponseWriter, r *http.Request) bool {
				if r.URL.Path != account.PairSelfPath || !inner.CompareAndSwap(false, true) {
					return false
				}
				defer inner.Store(false)
				rec := httptest.NewRecorder()
				w.svc.ServeHTTP(rec, r)
				var self map[string]any
				_ = json.Unmarshal(rec.Body.Bytes(), &self)
				tc.alter(self["envelopes"].([]any)[0].(map[string]any))
				rw.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(rw).Encode(self)
				return true
			}
			w.intercept.Store(&intercept)
			v = w.read(t, v.ID)
			if v.Phase != PairFailed || v.Problem == "" || len(v.Machines) != 0 || v.RetryOpen {
				t.Fatalf("tampered %+v", v)
			}
			w.intercept.Store(nil)
			if v = w.read(t, v.ID); v.Phase != PairFailed || len(v.Machines) != 0 {
				t.Fatalf("read again %+v", v)
			}
			if saved, keys := w.machines(t), w.identities(t); len(saved) != 0 || len(keys) != 0 {
				t.Fatalf("saved %+v, keys %v", saved, keys)
			}
			if _, ok, _ := w.d.pins.Pin(net.JoinHostPort(studio.host, strconv.Itoa(studio.port))); ok {
				t.Fatal("pinned from a tampered list")
			}
		})
	}
}

// Denied (three wrong codes on the iPhone) and expired requests end with
// nothing saved.
func TestPairRequestEndsDeniedOrExpired(t *testing.T) {
	t.Run("denied", func(t *testing.T) {
		w := newPairWorld(t)
		ctx := context.Background()
		v := w.start(t)
		a, _, code := w.claim(t, v.ID)
		wrong := fmt.Sprintf("%04d", (mustAtoi(code)+1)%10000)
		for range 3 {
			if _, err := a.CheckCode(ctx, wrong); err != nil {
				t.Fatal(err)
			}
		}
		if v = w.read(t, v.ID); v.Phase != PairDenied || v.Approver != "Jerry's iPhone" {
			t.Fatalf("denied %+v", v)
		}
		if saved, keys := w.machines(t), w.identities(t); len(saved) != 0 || len(keys) != 0 {
			t.Fatalf("saved %+v, keys %v", saved, keys)
		}
	})
	t.Run("expired", func(t *testing.T) {
		w := newPairWorld(t)
		v := w.start(t)
		w.elapsed.Add(int64(fakeaccount.RequestTTL))
		if v = w.read(t, v.ID); v.Phase != PairExpired || v.ExpiresIn != 0 {
			t.Fatalf("expired %+v", v)
		}
		if saved, keys := w.machines(t), w.identities(t); len(saved) != 0 || len(keys) != 0 {
			t.Fatalf("saved %+v, keys %v", saved, keys)
		}
	})
}

// Cancel ends the request at the service: the iPhone can't approve it.
func TestPairRequestCancelEndsItForTheApprover(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	v := w.start(t)
	a, s, code := w.claim(t, v.ID)
	if err := w.d.PairRequestCancel(ctx, v.ID); err != nil {
		t.Fatal(err)
	}
	if reqs := w.svc.Requests(); len(reqs) != 1 || reqs[0].Outcome != "cancelled" {
		t.Fatalf("the service holds %+v", reqs)
	}
	// The iPhone, with the code typed, can't approve it any more.
	if c, err := a.CheckCode(ctx, code); err == nil && c.Ok {
		if err := a.Approve(ctx, 1, pairEnvelope(servedMachine(t, s).entry("studio", account.PairAdded, ""))); err == nil {
			t.Fatal("approved a cancelled request")
		}
	}
	if _, err := w.d.PairRequestRead(ctx, v.ID); !errors.Is(err, errNoPairRequest) {
		t.Fatalf("read after cancel: %v", err)
	}
	if w.d.PairRequestCurrent() != nil || len(w.identities(t)) != 0 {
		t.Fatal("the request or its key stayed")
	}
}

// A cancel the service doesn't take still stops the request here, and says
// a device with the code could approve it until it expires.
func TestPairRequestCancelFallsBackToStoppingHere(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	v := w.start(t)
	unavailable := func(rw http.ResponseWriter, r *http.Request) bool {
		if !strings.HasSuffix(r.URL.Path, "/cancel") {
			return false
		}
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(http.StatusServiceUnavailable)
		_, _ = rw.Write([]byte(`{"error":"unavailable"}`))
		return true
	}
	w.intercept.Store(&unavailable)
	err := w.d.PairRequestCancel(ctx, v.ID)
	if err == nil || !strings.Contains(err.Error(), "could still approve it") {
		t.Fatalf("cancel: %v", err)
	}
	if w.d.PairRequestCurrent() != nil {
		t.Fatal("the request stayed")
	}
	if reqs := w.svc.Requests(); len(reqs) != 1 || reqs[0].Outcome != "" || reqs[0].NonceB != "" {
		t.Fatalf("the service holds %+v", reqs)
	}
}

// Signed out, the page doesn't offer it.
func TestPairRequestIsNotOfferedSignedOut(t *testing.T) {
	d := newDesk(t.TempDir())
	d.account = account.New("http://127.0.0.1:1", "linux", &signedInStore{}, nil)
	if ok, err := d.PairRequestOffered(context.Background()); ok || err != nil {
		t.Fatalf("offered %v, %v", ok, err)
	}
	if _, err := d.PairRequestStart(context.Background()); err == nil {
		t.Fatal("started signed out")
	}
}

func mustAtoi(s string) int { n, _ := strconv.Atoi(s); return n }

// A machine the approver pinned by its RSA or ECDSA host key is saved
// Paired with that key type, and connects offering only it: an sshd that
// also serves an ed25519 key (which herdr pair's order prefers) is still
// checked against the approver's pin. A key type this device doesn't pin
// (DSA) is not saved.
func TestPairRequestConnectsWithTheKeyTypeTheApproverPinned(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	v := w.start(t)
	a, s, code := w.claim(t, v.ID)
	_, edPriv, _ := ed25519.GenerateKey(rand.Reader)
	ed, _ := ssh.NewSignerFromKey(edPriv)
	rsaPriv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	rsaSigner, _ := ssh.NewSignerFromKey(rsaPriv)
	ecPriv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ecSigner, _ := ssh.NewSignerFromKey(ecPriv)
	rsaBox := servedMachineKeys(t, s, rsaSigner, ed)
	ecBox := servedMachineKeys(t, s, ecSigner, ed)
	var dsaKey dsa.PrivateKey
	if err := dsa.GenerateParameters(&dsaKey.Parameters, rand.Reader, dsa.L1024N160); err != nil {
		t.Fatal(err)
	}
	if err := dsa.GenerateKey(&dsaKey, rand.Reader); err != nil {
		t.Fatal(err)
	}
	dsaPub, err := ssh.NewPublicKey(&dsaKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	dsaEntry := offNetwork(t).entry("dsa-box", account.PairAdded, "")
	dsaEntry.HostKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(dsaPub)))
	if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
		t.Fatal(c, err)
	}
	if err := a.Approve(ctx, 1, pairEnvelope(rsaBox.entry("rsa-box", account.PairAdded, ""), ecBox.entry("ec-box", account.PairAdded, ""), dsaEntry)); err != nil {
		t.Fatal(err)
	}
	v = w.read(t, v.ID)
	if r := resultOf(v, "dsa-box"); r.Result != PairNotAdded || !strings.Contains(r.Reason, "doesn't pin") {
		t.Fatalf("dsa %+v", r)
	}
	types := map[string]string{}
	for _, m := range w.machines(t) {
		if !m.Paired {
			t.Fatalf("%s saved without Paired", m.Nickname)
		}
		types[m.Nickname] = m.HostKeyType
	}
	if types["rsa-box"] != ssh.KeyAlgoRSA || types["ec-box"] != ssh.KeyAlgoECDSA256 || len(types) != 2 {
		t.Fatalf("saved key types %v", types)
	}
	v, err = w.d.PairRequestConnect(ctx, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"rsa-box", "ec-box"} {
		if r := resultOf(v, name); r.Reach != PairOnline {
			t.Fatalf("%s %+v", name, r)
		}
	}
	// An edit from the page (which doesn't hold the type) keeps it.
	for _, m := range w.machines(t) {
		if m.Nickname == "rsa-box" {
			edited := m
			edited.Nickname, edited.HostKeyType = "rsa box", ""
			if err := w.d.SaveMachine(edited, machineID(m)); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, m := range w.machines(t) {
		if m.Nickname == "rsa box" && m.HostKeyType != ssh.KeyAlgoRSA {
			t.Fatalf("edited %+v", m)
		}
	}
}

func TestHostKeyAlgorithmsFollowThePinnedType(t *testing.T) {
	for _, c := range []struct {
		m    Machine
		want []string
	}{
		{Machine{}, nil},
		{Machine{Paired: true}, pairingHostKeyAlgorithms},
		{Machine{Paired: true, HostKeyType: ssh.KeyAlgoED25519}, []string{ssh.KeyAlgoED25519}},
		{Machine{Paired: true, HostKeyType: ssh.KeyAlgoRSA}, []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256}},
		{Machine{Paired: true, HostKeyType: ssh.KeyAlgoECDSA384}, []string{ssh.KeyAlgoECDSA384}},
	} {
		if got := hostKeyAlgorithms(c.m); fmt.Sprint(got) != fmt.Sprint(c.want) {
			t.Errorf("%+v: %v, want %v", c.m, got, c.want)
		}
	}
}

// When saving the machines fails (their pins or the machine list), nothing
// is saved: the key file written for them is removed again, and so are the
// pins new for them (a pin that was there before stays). The view says so
// while the list is read again, and the next read saves them with a new key.
func TestPairRequestRemovesItsKeyAndNewPinsWhenSavingFails(t *testing.T) {
	for _, c := range []struct {
		blocked string
		pinned  bool // the machine's host key was pinned here already
	}{{"host-keys.json.tmp", false}, {"machines.json.tmp", false}, {"machines.json.tmp", true}} {
		t.Run(fmt.Sprintf("%s pinned=%v", c.blocked, c.pinned), func(t *testing.T) {
			w := newPairWorld(t)
			ctx := context.Background()
			v := w.start(t)
			a, s, code := w.claim(t, v.ID)
			studio := servedMachine(t, s)
			at := net.JoinHostPort(studio.host, strconv.Itoa(studio.port))
			if c.pinned {
				if err := w.d.pins.SetPin(at, bridge.Fingerprint(studio.hostKey)); err != nil {
					t.Fatal(err)
				}
			}
			if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
				t.Fatal(c, err)
			}
			if err := a.Approve(ctx, 1, pairEnvelope(studio.entry("studio", account.PairAdded, ""))); err != nil {
				t.Fatal(err)
			}
			// A folder where the file's replacement is written: that write fails.
			obstacle := filepath.Join(w.d.dir, c.blocked)
			if err := os.MkdirAll(filepath.Join(obstacle, "x"), 0o700); err != nil {
				t.Fatal(err)
			}
			v = w.read(t, v.ID)
			if v.Phase != PairApproved || !v.SaveFailed || !strings.Contains(v.Problem, "Trying again") {
				t.Fatalf("failed save %+v", v)
			}
			if keys := w.identities(t); len(keys) != 0 {
				t.Fatalf("key files left %v", keys)
			}
			if len(w.machines(t)) != 0 {
				t.Fatalf("saved %+v", w.machines(t))
			}
			if _, ok, err := w.d.pins.Pin(at); err != nil || ok != c.pinned {
				t.Fatalf("pin there %v (%v), want %v", ok, err, c.pinned)
			}
			if err := os.RemoveAll(obstacle); err != nil {
				t.Fatal(err)
			}
			v = w.read(t, v.ID)
			keys, saved := w.identities(t), w.machines(t)
			if v.Problem != "" || v.SaveFailed || resultOf(v, "studio").Result != PairSaved || len(keys) != 1 || len(saved) != 1 || saved[0].KeyPath != keys[0] {
				t.Fatalf("after %+v, keys %v, saved %+v", v, keys, saved)
			}
		})
	}
}

// A write of the machines that fails after they are in place (the folder's
// sync) keeps them, their key and their pins: nothing a saved machine uses
// is removed.
func TestPairRequestKeepsItsKeyOnceTheMachinesAreWritten(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	v := w.start(t)
	a, s, code := w.claim(t, v.ID)
	studio := servedMachine(t, s)
	if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
		t.Fatal(c, err)
	}
	if err := a.Approve(ctx, 1, pairEnvelope(studio.entry("studio", account.PairAdded, ""))); err != nil {
		t.Fatal(err)
	}
	w.d.writeMachines = func(path string, data []byte) (bool, error) {
		if published, err := publishFile(path, data); !published {
			return false, err
		}
		return true, errors.New("sync: input/output error")
	}
	v = w.read(t, v.ID)
	keys, saved := w.identities(t), w.machines(t)
	if v.Phase != PairDone || resultOf(v, "studio").Result != PairSaved || len(keys) != 1 || len(saved) != 1 || saved[0].KeyPath != keys[0] {
		t.Fatalf("view %+v, keys %v, saved %+v", v, keys, saved)
	}
	if pin, ok, err := w.d.pins.Pin(net.JoinHostPort(studio.host, strconv.Itoa(studio.port))); err != nil || !ok || pin != bridge.Fingerprint(studio.hostKey) {
		t.Fatalf("pin %q %v %v", pin, ok, err)
	}
}

// A pin another writer set while the save went on is not the save's to
// take back: a failed save leaves it, and removes only its own key.
func TestPairRequestLeavesAPinSetSinceWhenSavingFails(t *testing.T) {
	w := newPairWorld(t)
	id, studio := w.approved(t)
	at := net.JoinHostPort(studio.host, strconv.Itoa(studio.port))
	other, _ := newHostKey(t)
	since := bridge.Fingerprint(other.PublicKey())
	w.d.writeMachines = func(string, []byte) (bool, error) {
		if err := w.d.pins.SetPin(at, since); err != nil {
			return false, err
		}
		return false, errors.New("no space left on device")
	}
	v := w.read(t, id)
	if v.Phase != PairApproved || !v.SaveFailed {
		t.Fatalf("view %+v", v)
	}
	if pin, ok, err := w.d.pins.Pin(at); err != nil || !ok || pin != since {
		t.Fatalf("pin %q %v %v, want the one set since", pin, ok, err)
	}
	if keys := w.identities(t); len(keys) != 0 {
		t.Fatalf("key files left %v", keys)
	}
}

// A list that can't be saved is saved again on later reads, but only while
// the approver could still send it again: then the problem is final.
func TestPairRequestStopsRetryingASaveAfterTheWindow(t *testing.T) {
	w := newPairWorld(t)
	now := time.Unix(1_800_000_000, 0)
	pairNow = func() time.Time { return now }
	t.Cleanup(func() { pairNow = time.Now })
	id, _ := w.approved(t)
	w.d.writeMachines = func(string, []byte) (bool, error) { return false, errors.New("no space left on device") }
	for range 2 {
		if v := w.read(t, id); v.Phase != PairApproved || !v.SaveFailed || !strings.Contains(v.Problem, "no space left") || !strings.Contains(v.Problem, "Trying again") {
			t.Fatalf("retrying %+v", v)
		}
		now = now.Add(pairRetryWindow / 2)
	}
	v := w.read(t, id)
	if v.Phase != PairFailed || v.SaveFailed || v.RetryOpen || !strings.Contains(v.Problem, "no space left") || !strings.Contains(v.Problem, "stopped trying") {
		t.Fatalf("after the window %+v", v)
	}
	w.savedNothing(t)
}

// holdMachinesWrite holds the desk's next write of machines.json until
// release, before anything is written: arrived closes once it is held.
func (w *pairWorld) holdMachinesWrite() (arrived <-chan struct{}, release func()) {
	arrive, rel := make(chan struct{}), make(chan struct{})
	var once sync.Once
	w.d.writeMachines = func(path string, data []byte) (bool, error) {
		once.Do(func() { close(arrive); <-rel })
		return publishFile(path, data)
	}
	return arrive, func() { close(rel) }
}

// Cancel while the list's machines are being written (the write held, the
// request fenced, then the write goes on): what the save wrote is taken
// back before Cancel returns.
func TestPairRequestCancelDuringTheWriteSavesNothing(t *testing.T) {
	w := newPairWorld(t)
	id, read, release := w.approvedAndHeld(t, w.holdMachinesWrite)
	p := w.d.pairRequest
	cancelled := make(chan error, 1)
	go func() { cancelled <- w.d.PairRequestCancel(context.Background(), id) }()
	for !p.fenced.Load() {
		time.Sleep(time.Millisecond)
	}
	release()
	if err := <-cancelled; err == nil || !strings.Contains(err.Error(), "had already approved it") {
		t.Fatalf("cancel: %v", err)
	}
	w.savedNothing(t)
	<-read
}

// Signed out while the list's machines are being written (the write held,
// the session dropped, then the write goes on): the sign-out returns only
// once what the save wrote is taken back.
func TestPairRequestSignOutDuringTheWriteSavesNothing(t *testing.T) {
	w := newPairWorld(t)
	published := publishAccount
	publishAccount = func(AccountState) {}
	t.Cleanup(func() { publishAccount = published })
	id, read, release := w.approvedAndHeld(t, w.holdMachinesWrite)
	signedOut := make(chan struct{})
	go func() { w.d.AccountSignOut(context.Background()); close(signedOut) }()
	waitFor(t, "the session dropped here", func() bool { cur, _ := w.d.account.Current(); return cur == nil })
	select {
	case <-signedOut:
		t.Fatal("the sign-out returned while the save was writing")
	default:
	}
	release()
	<-signedOut
	w.savedNothing(t)
	if v := <-read; v.Phase != PairFailed || !strings.Contains(v.Problem, "signed out") {
		t.Fatalf("view %+v", v)
	}
	if v := w.read(t, id); v.Phase != PairFailed {
		t.Fatalf("read again %+v", v)
	}
}

// approved is a request approved with studio's list, not read yet.
func (w *pairWorld) approved(t *testing.T) (id string, studio pairMachine) {
	t.Helper()
	ctx := context.Background()
	v := w.start(t)
	a, s, code := w.claim(t, v.ID)
	studio = servedMachine(t, s)
	if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
		t.Fatal(c, err)
	}
	if err := a.Approve(ctx, 1, pairEnvelope(studio.entry("studio", account.PairAdded, ""))); err != nil {
		t.Fatal(err)
	}
	return v.ID, studio
}

// holdMachinesRead holds the new device's next GET /v1/pairs/self until
// release: arrived closes once it is held.
func (w *pairWorld) holdMachinesRead() (arrived <-chan struct{}, release func()) {
	arrive, rel := make(chan struct{}), make(chan struct{})
	var once sync.Once
	hold := func(_ http.ResponseWriter, r *http.Request) bool {
		if r.Method == http.MethodGet && r.URL.Path == account.PairSelfPath {
			once.Do(func() { close(arrive); <-rel })
		}
		return false
	}
	w.intercept.Store(&hold)
	return arrive, func() { close(rel) }
}

// approvedAndHeld is a request approved with studio's list, its read of
// that list in flight and held by hold.
func (w *pairWorld) approvedAndHeld(t *testing.T, hold func() (<-chan struct{}, func())) (id string, read <-chan PairRequestView, release func()) {
	t.Helper()
	ctx := context.Background()
	id, _ = w.approved(t)
	arrived, release := hold()
	done := make(chan PairRequestView, 1)
	go func() {
		v, err := w.d.PairRequestRead(ctx, id)
		if err != nil {
			t.Error(err)
		}
		done <- v
	}()
	<-arrived
	return id, done, release
}

func (w *pairWorld) savedNothing(t *testing.T) {
	t.Helper()
	if keys, saved := w.identities(t), w.machines(t); len(keys) != 0 || len(saved) != 0 {
		t.Fatalf("keys %v, saved %+v", keys, saved)
	}
	if pins, err := os.ReadFile(filepath.Join(w.d.dir, "host-keys.json")); err == nil && strings.Contains(string(pins), "127.0.0.1") {
		t.Fatalf("pins %s", pins)
	}
}

// Cancel while the approved list's read is in flight: the request is fenced
// first, so that read saves nothing, and the service is still told (it
// answers that the request was approved already, which Cancel says).
func TestPairRequestCancelFencesAReadInFlight(t *testing.T) {
	w := newPairWorld(t)
	id, read, release := w.approvedAndHeld(t, w.holdMachinesRead)
	p := w.d.pairRequest
	cancelled := make(chan error, 1)
	go func() { cancelled <- w.d.PairRequestCancel(context.Background(), id) }()
	for !p.fenced.Load() {
		time.Sleep(time.Millisecond)
	}
	release()
	<-read
	err := <-cancelled
	if err == nil || !strings.Contains(err.Error(), "had already approved it") {
		t.Fatalf("cancel: %v", err)
	}
	w.savedNothing(t)
	if w.d.PairRequestCurrent() != nil {
		t.Fatal("the request stayed")
	}
}

// Signed out while the approved list's read is in flight: the session that
// asked isn't the current one at the save, so nothing is saved and the
// request ends.
func TestPairRequestSavesNothingAfterSignOut(t *testing.T) {
	w := newPairWorld(t)
	id, read, release := w.approvedAndHeld(t, w.holdMachinesRead)
	// The fake service has no sign-out route: the session is dropped here
	// whatever it answers.
	_ = w.d.account.SignOut(context.Background())
	if cur, _ := w.d.account.Current(); cur != nil {
		t.Fatal("still signed in")
	}
	release()
	v := <-read
	if v.Phase != PairFailed || !strings.Contains(v.Problem, "signed out") {
		t.Fatalf("view %+v", v)
	}
	w.savedNothing(t)
	if v = w.read(t, id); v.Phase != PairFailed {
		t.Fatalf("read again %+v", v)
	}
}

// Cancel once the list is saved still tells the service; its answer that
// the request finished already is no error then, and what was saved stays.
func TestPairRequestCancelAfterTheSaveStillTellsTheService(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	v := w.start(t)
	a, s, code := w.claim(t, v.ID)
	studio := servedMachine(t, s)
	if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
		t.Fatal(c, err)
	}
	if err := a.Approve(ctx, 1, pairEnvelope(studio.entry("studio", account.PairAdded, ""))); err != nil {
		t.Fatal(err)
	}
	if v = w.read(t, v.ID); v.Phase != PairDone {
		t.Fatalf("saved %+v", v)
	}
	var told atomic.Int32
	count := func(_ http.ResponseWriter, r *http.Request) bool {
		if strings.HasSuffix(r.URL.Path, "/cancel") {
			told.Add(1)
		}
		return false
	}
	w.intercept.Store(&count)
	if err := w.d.PairRequestCancel(ctx, v.ID); err != nil {
		t.Fatal(err)
	}
	if told.Load() != 1 || len(w.machines(t)) != 1 || len(w.identities(t)) != 1 {
		t.Fatalf("told %d, saved %+v", told.Load(), w.machines(t))
	}
}

// A machine removed here after the list saved it is settled as removed,
// not tried again and again, even once another profile is saved at the
// same address: that one is not the list's (its profile id differs).
func TestPairRequestSettlesARemovedMachine(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id, _ := w.approved(t)
	v := w.read(t, id)
	saved := w.machines(t)
	r := resultOf(v, "studio")
	if len(saved) != 1 || r.ProfileID == "" || saved[0].LocalID != r.ProfileID {
		t.Fatalf("saved %+v, result %+v", saved, r)
	}
	if err := w.d.RemoveMachine(r.ID); err != nil {
		t.Fatal(err)
	}
	again := saved[0]
	again.LocalID = ""
	if err := w.d.SaveMachine(again, ""); err != nil {
		t.Fatal(err)
	}
	v, err := w.d.PairRequestConnect(ctx, id)
	if err != nil || resultOf(v, "studio").Reach != PairRemoved {
		t.Fatalf("connect %+v, %v", v, err)
	}
}

// The envelope's host_key is a plain key; one sent as a certificate anyway
// is pinned as the plain key it certifies, so the machine saves with that
// key's type and connects.
func TestPairRequestPinsTheKeyACertificateCertifies(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	v := w.start(t)
	a, s, code := w.claim(t, v.ID)
	studio := servedMachine(t, s)
	ca, _ := newHostKey(t)
	cert := &ssh.Certificate{Key: studio.hostKey, CertType: ssh.HostCert, ValidBefore: ssh.CertTimeInfinity}
	if err := cert.SignCert(rand.Reader, ca); err != nil {
		t.Fatal(err)
	}
	entry := studio.entry("studio", account.PairAdded, "")
	entry.HostKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(cert)))
	if c, err := a.CheckCode(ctx, code); err != nil || !c.Ok {
		t.Fatal(c, err)
	}
	if err := a.Approve(ctx, 1, pairEnvelope(entry)); err != nil {
		t.Fatal(err)
	}
	v = w.read(t, v.ID)
	saved := w.machines(t)
	if resultOf(v, "studio").Result != PairSaved || len(saved) != 1 || saved[0].HostKeyType != ssh.KeyAlgoED25519 {
		t.Fatalf("view %+v, saved %+v", v, saved)
	}
	if pin, ok, err := w.d.pins.Pin(net.JoinHostPort(studio.host, strconv.Itoa(studio.port))); err != nil || !ok || pin != bridge.Fingerprint(studio.hostKey) {
		t.Fatalf("pin %q %v %v, want the plain key's", pin, ok, err)
	}
	if v, err := w.d.PairRequestConnect(ctx, v.ID); err != nil || resultOf(v, "studio").Reach != PairOnline {
		t.Fatalf("connect %+v, %v", v, err)
	}
}

// Pairing again with herdr pair's QR pins the QR's host key, so the machine
// takes herdr pair's host key policy, not the type an approval pinned.
func TestQRPairingReplacesThePinnedKeyType(t *testing.T) {
	d := newDesk(t.TempDir())
	raw, _, _, _, outcome := pairingListener(t, d, `{"type":"pair.ok"}`)
	before := Machine{Host: "127.0.0.1", Port: 22, User: "pairing-user", Paired: true, HostKeyType: ssh.KeyAlgoRSA, KeyPath: "/old.key"}
	d.storeMu.Lock()
	err := d.store(machineStore{Machines: []Machine{before}})
	d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.PairMachine(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
	if err := <-outcome; err != nil {
		t.Fatal(err)
	}
	hosts, err := d.Machines()
	if err != nil || len(hosts) != 1 || !hosts[0].Paired || hosts[0].HostKeyType != "" || hosts[0].KeyPath == "/old.key" {
		t.Fatalf("re-paired %+v, %v", hosts, err)
	}
}
