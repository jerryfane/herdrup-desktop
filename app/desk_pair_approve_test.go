package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/account"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeaccount"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/pairing"
	"golang.org/x/crypto/ssh"
)

// pairWorld is one account on fakeaccount with this desk as the approver
// and a new device ("MacBook Air") asking to pair, and the owner's
// machines as fake herdrs: studio (the machine the desk is connected to),
// fleet (a key file), old (a herdr without pair.add_key), gone (a key file
// for a machine that doesn't answer) and box (a password machine).
type pairWorld struct {
	d   *Desk
	svc *fakeaccount.Service
	// elapsed moves the service's clock.
	elapsed atomic.Int64
	// lose: the routes ("finish", "envelope") whose next answer is lost
	// after the service took the call.
	lose   sync.Map
	ask    *account.PairAsk
	newDev *account.Client
	newKey x25519Browser
	sshKey pairing.PairKey
	// code is the new device's code once it revealed.
	code     atomic.Value
	machines map[string]*pairHerdr
	ids      map[string]string

	mu        sync.Mutex
	published []PairApproveUpdate
	progress  []PairApproveProgress
}

// pairHerdr is one machine's fake herdr: the keys pair.add_key added, its
// host key, and how many calls of pair.add_key to fail first.
type pairHerdr struct {
	keys    fakeherdr.PairKeys
	hostKey ssh.PublicKey
	srv     *fakeherdr.Server
	// refusing, when set, is the code pair.add_key refuses with.
	refusing atomic.Value
	failing  atomic.Int32
	adds     atomic.Int32
	keyPath  string
}

// handle answers pair.add_key (when pairOK) and ping.
func (h *pairHerdr) handle(pairOK bool, inner func(string, json.RawMessage) (any, *fakeherdr.APIError)) func(string, json.RawMessage) (any, *fakeherdr.APIError) {
	return func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
		switch {
		case method == "ping" && pairOK:
			return fakeherdr.PongPairAddKey(true), nil
		case method == "ping":
			return fakeherdr.Pong(true), nil
		case method == engine.PairAddKeyMethod && !pairOK:
			return nil, &fakeherdr.APIError{Code: "invalid_request", Message: "unknown variant `pair.add_key`, expected one of `ping`"}
		case method == engine.PairAddKeyMethod:
			h.adds.Add(1)
			if code, _ := h.refusing.Load().(string); code != "" {
				return nil, &fakeherdr.APIError{Code: code, Message: code}
			}
			if h.failing.Load() > 0 {
				h.failing.Add(-1)
				time.Sleep(10 * time.Millisecond)
				return nil, &fakeherdr.APIError{Code: "internal", Message: "disk full"}
			}
		}
		if v, e, ok := h.keys.Handle(method, raw); ok {
			return v, e
		}
		return inner(method, raw)
	}
}

func noMethod(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
	return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
}

// keyMachine starts a fake herdr reached with a key file and saves it;
// pinned: its host key is pinned here, as once this computer opened it.
func (w *pairWorld) keyMachine(t *testing.T, name string, pairOK, pinned bool) {
	t.Helper()
	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	hostKey, _ := ssh.NewSignerFromKey(hostPriv)
	w.keyMachineWith(t, name, hostKey, pairOK, pinned)
}

// certHostKey is a host key signer presenting an OpenSSH host certificate
// some principalBytes long (a long principal), signed by a fresh CA.
func certHostKey(t *testing.T, principalBytes int) ssh.Signer {
	t.Helper()
	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	host, _ := ssh.NewSignerFromKey(hostPriv)
	_, caPriv, _ := ed25519.GenerateKey(rand.Reader)
	ca, _ := ssh.NewSignerFromKey(caPriv)
	cert := &ssh.Certificate{Key: host.PublicKey(), CertType: ssh.HostCert, ValidPrincipals: []string{strings.Repeat("h", principalBytes)}, ValidBefore: ssh.CertTimeInfinity}
	if err := cert.SignCert(rand.Reader, ca); err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewCertSigner(cert, host)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// bigMachines saves machines that share one ECDSA P-521 host key, the
// longest the list carries, each with the longest nickname and user
// ("big00-xxx…"), until the checked wire list (PairEnvelope.Marshal) for
// studio and them, each "already" with its host key, is too long: the
// one before still fits, and the last one saved is the one with no room.
func (w *pairWorld) bigMachines(t *testing.T) []string {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P521(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	wire := func(m Machine, hostKey string) account.PairMachine {
		return account.PairMachine{Nickname: m.Nickname, Host: m.Host, Port: m.Port, User: m.User, HostKey: hostKey, Status: account.PairAlready}
	}
	studio, err := w.d.savedMachine(w.ids["studio"])
	if err != nil {
		t.Fatal(err)
	}
	e := account.PairEnvelope{V: account.PairEnvelopeVersion, Machines: []account.PairMachine{wire(studio, hostKeyLine(w.machines["studio"].hostKey))}}
	if _, err := e.Marshal(); err != nil {
		t.Fatalf("studio alone: %v", err)
	}
	var names []string
	for i := 0; ; i++ {
		if i == 64 {
			t.Fatalf("%d machines still fit the list", i)
		}
		name := fmt.Sprintf("big%02d-", i)
		name += strings.Repeat("x", 64-len(name))
		w.keyMachineWith(t, name, key, true, true)
		m, err := w.d.savedMachine(w.ids[name])
		if err != nil {
			t.Fatal(err)
		}
		m.User = strings.Repeat("u", 64)
		w.save(t, name, m)
		names = append(names, name)
		e.Machines = append(e.Machines, wire(m, hostKeyLine(key.PublicKey())))
		if _, err := e.Marshal(); errors.Is(err, account.ErrPairEnvelopeTooLong) {
			return names
		} else if err != nil {
			t.Fatalf("the list with %s: %v", name, err)
		}
	}
}

// keyMachineWith is keyMachine with hostKey as the machine's host key
// (the one pinned), and more as its other host keys.
func (w *pairWorld) keyMachineWith(t *testing.T, name string, hostKey ssh.Signer, pairOK, pinned bool, more ...ssh.Signer) {
	t.Helper()
	_, clientPriv, _ := ed25519.GenerateKey(rand.Reader)
	client, _ := ssh.NewSignerFromKey(clientPriv)
	block, err := ssh.MarshalPrivateKey(clientPriv, "")
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	h := &pairHerdr{hostKey: hostKey.PublicKey(), keyPath: keyPath}
	h.srv = &fakeherdr.Server{HostKey: hostKey, AdditionalHostKeys: more, Authorized: client.PublicKey(), Handle: h.handle(pairOK, noMethod)}
	addr, err := h.srv.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.srv.Close() })
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	w.save(t, name, Machine{Nickname: name, Host: host, Port: port, User: "dev", KeyPath: keyPath})
	w.machines[name] = h
	if pinned {
		if err := w.d.pins.SetPin(addr, bridge.Fingerprint(hostKey.PublicKey())); err != nil {
			t.Fatal(err)
		}
	}
}

func (w *pairWorld) save(t *testing.T, name string, m Machine) {
	t.Helper()
	if err := w.d.SaveMachine(m, ""); err != nil {
		t.Fatal(err)
	}
	w.ids[name] = machineID(m)
}

// freePort is a local port nothing listens on.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}

func newPairWorld(t *testing.T) *pairWorld {
	t.Helper()
	quietSync(t)
	w := &pairWorld{svc: fakeaccount.New(), machines: map[string]*pairHerdr{}, ids: map[string]string{}}
	start := time.Now()
	w.svc.Now = func() time.Time { return start.Add(time.Duration(w.elapsed.Load())) }
	savedU, savedP := publishPairApprove, publishPairProgress
	publishPairApprove = func(u PairApproveUpdate) { w.mu.Lock(); w.published = append(w.published, u); w.mu.Unlock() }
	publishPairProgress = func(p PairApproveProgress) { w.mu.Lock(); w.progress = append(w.progress, p); w.mu.Unlock() }
	t.Cleanup(func() { publishPairApprove, publishPairProgress = savedU, savedP })

	// The new device reveals as soon as the desk's claim lands, before
	// the claim's answer: the desk's first read finds its code.
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		step := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		if _, lost := w.lose.Load(step); lost && r.Method != http.MethodGet && w.lose.CompareAndDelete(step, true) {
			w.svc.ServeHTTP(httptest.NewRecorder(), r)
			rw.WriteHeader(http.StatusBadGateway)
			return
		}
		w.svc.ServeHTTP(rw, r)
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/claim") && w.ask != nil {
			if prog, err := w.ask.Poll(context.Background()); err == nil && prog.Code != "" {
				w.code.Store(prog.Code)
			}
		}
	}))
	t.Cleanup(srv.Close)

	studio := &pairHerdr{}
	d, s := federatedDeskAs(t, "studio", func(s *fakeherdr.Server) {
		s.Handle = studio.handle(true, s.Handle)
	})
	studio.srv, studio.hostKey = s, s.HostKey.PublicKey()
	w.d = d
	w.machines["studio"] = studio
	ms, _ := d.WebAccessMachines()
	w.ids["studio"] = ms[0].ID

	identity, err := d.guestIdentity()
	if err != nil {
		t.Fatal(err)
	}
	b64 := base64.RawURLEncoding.EncodeToString
	raw, _ := json.Marshal(map[string]string{"account_id": w.svc.Account,
		"refresh_token": w.svc.AddDevice(fakeaccount.Device{ID: "dev-studio", Pub: b64(identity.PublicKey()), Name: "Mac Studio", Platform: "macos"})})
	d.account = account.New(srv.URL, "macos", &signedInStore{raw: raw}, srv.Client())

	priv, _ := ecdh.X25519().NewPrivateKey(bytes.Repeat([]byte{0xa1}, 32))
	w.newKey = x25519Browser{priv}
	raw, _ = json.Marshal(map[string]string{"account_id": w.svc.Account,
		"refresh_token": w.svc.AddDevice(fakeaccount.Device{ID: "dev-air", Pub: b64(w.newKey.PublicKey()), Name: "MacBook Air", Platform: "macos"})})
	w.newDev = account.New(srv.URL, "macos", &signedInStore{raw: raw}, srv.Client())
	if w.sshKey, err = pairing.NewPairKey("MacBook Air"); err != nil {
		t.Fatal(err)
	}

	w.keyMachine(t, "fleet", true, true)
	w.keyMachine(t, "old", false, true)
	// gone: a key that works elsewhere, at an address nothing answers.
	w.save(t, "gone", Machine{Nickname: "gone", Host: "127.0.0.1", Port: freePort(t), User: "dev", KeyPath: w.machines["fleet"].keyPath})
	w.save(t, "box", Machine{Nickname: "box", Host: "127.0.0.1", Port: freePort(t), User: "dev"})
	return w
}

// start has the new device ask, and the desk claim it and wait for its code.
func (w *pairWorld) start(t *testing.T) string {
	t.Helper()
	ask, err := w.newDev.AskToPair(context.Background(), w.svc.Account, w.newKey, w.sshKey.Public)
	if err != nil {
		t.Fatal(err)
	}
	w.ask = ask
	list, err := w.d.ApprovalRequests(context.Background())
	if err != nil || len(list) != 1 || list[0].Kind != "pair" || list[0].Pair == nil || list[0].Browser != nil {
		t.Fatalf("requests %+v, %v", list, err)
	}
	r := *list[0].Pair
	if r.ID != ask.ID() || r.DeviceName != "MacBook Air" || r.Platform != "macos" || r.Claimed != "no" {
		t.Fatalf("request %+v", r)
	}
	if err := w.d.PairApproveStart(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the new device's code", func() bool { return w.state(r.ID) == "ready" })
	return r.ID
}

func (w *pairWorld) state(id string) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	for i := len(w.published) - 1; i >= 0; i-- {
		if w.published[i].ID == id {
			return w.published[i].State
		}
	}
	return ""
}

func (w *pairWorld) codeOf(t *testing.T) string {
	t.Helper()
	c, _ := w.code.Load().(string)
	if c == "" {
		t.Fatal("the new device has no code")
	}
	return c
}

// wrong is a code that isn't the new device's.
func (w *pairWorld) wrong(t *testing.T) string {
	c := []byte(w.codeOf(t))
	c[0] = '0' + (c[0]-'0'+1)%10
	return string(c)
}

func (w *pairWorld) typeCode(t *testing.T, id string) {
	t.Helper()
	if c, err := w.d.PairApproveCheckCode(context.Background(), id, w.codeOf(t)); !c.Ok || err != nil {
		t.Fatalf("code: %+v %v", c, err)
	}
}

func (w *pairWorld) allKeys() int {
	n := 0
	for _, h := range w.machines {
		n += len(h.keys.Keys())
	}
	return n
}

// delivered is the newest list the new device opened.
func (w *pairWorld) delivered(t *testing.T) account.PairDelivery {
	t.Helper()
	got, ok, err := w.ask.Machines(context.Background())
	if err != nil || !ok {
		t.Fatalf("the new device has no list: %v %v", ok, err)
	}
	return got
}

func hostKeyLine(k ssh.PublicKey) string {
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k)))
}

// The whole approval: the typed code, probes that tell the machines apart,
// the request's own key added on the ticked machines only, over this
// desk's own sessions, and a list only the new device opens, with each
// machine's host key as this desk's session verified it.
func TestPairApproveAddsTheKeyOnTickedMachinesAndSealsTheirHostKeys(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	// No machine is reached before the code matches.
	id := w.start(t)
	if _, err := w.d.PairApproveProbe(ctx, id, w.ids["fleet"]); err == nil {
		t.Fatal("a probe before the code was typed")
	}
	w.typeCode(t, id)
	probes := map[string]string{}
	for name, mid := range w.ids {
		p, err := w.d.PairApproveProbe(ctx, id, mid)
		if err != nil {
			t.Fatal(err)
		}
		probes[name] = p.State
		if name == "old" && p.Version != "0.9.5" {
			t.Fatalf("old herdr's version %q", p.Version)
		}
	}
	want := map[string]string{"studio": "ready", "fleet": "ready", "old": "needs_update", "gone": "unreachable", "box": "needs_key"}
	if !maps.Equal(probes, want) {
		t.Fatalf("probes %v, want %v", probes, want)
	}
	if w.allKeys() != 0 {
		t.Fatal("a probe added a key")
	}
	// Ticked: studio and fleet; old is ready on nobody's list and stays untouched.
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"], w.ids["fleet"]})
	if err != nil || !res.Sent || res.Unsure || len(res.Machines) != 2 {
		t.Fatalf("approve %+v, %v", res, err)
	}
	authorized, _ := account.SSHAuthorizedKey(w.sshKey.Public)
	label := engine.PairKeyLabel("MacBook Air", accountDeviceName())
	for _, name := range []string{"studio", "fleet"} {
		keys := w.machines[name].keys.Keys()
		if len(keys) != 1 || keys[0].PublicKey != authorized || keys[0].Label != label {
			t.Fatalf("%s keys %+v, want the request's key labelled %q", name, keys, label)
		}
	}
	if n := w.allKeys(); n != 2 {
		t.Fatalf("%d keys added, want 2 (ticked machines only)", n)
	}
	for _, r := range res.Machines {
		if r.Status != account.PairAdded || r.KeyLabel != label {
			t.Fatalf("row %+v", r)
		}
	}
	got := w.delivered(t)
	if got.Seq != 1 || len(got.Envelope.Machines) != 2 {
		t.Fatalf("delivered %+v", got)
	}
	for _, m := range got.Envelope.Machines {
		h := w.machines[m.Nickname]
		if h == nil || m.Status != account.PairAdded || m.HostKey != hostKeyLine(h.hostKey) || m.User != "dev" || m.Host != "127.0.0.1" {
			t.Fatalf("envelope machine %+v", m)
		}
		key, err := m.HostPublicKey()
		if err != nil || !bytes.Equal(key.Marshal(), h.hostKey.Marshal()) {
			t.Fatalf("host key of %s: %v", m.Nickname, err)
		}
		if strings.Count(m.HostKey, " ") != 1 {
			t.Fatalf("host key %q carries a comment", m.HostKey)
		}
	}
	// Progress for each machine: adding, then its outcome.
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.progress) != 4 || w.progress[0].Status != "adding" || w.progress[1].Status != account.PairAdded || w.progress[1].KeyLabel != label {
		t.Fatalf("progress %+v", w.progress)
	}
}

// A machine the desk can't use and the user sends anyway is in the list
// as failed, with the reason; nothing is added there.
func TestPairApproveListsUnusableMachinesAsFailed(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	w.typeCode(t, id)
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["old"], w.ids["gone"], w.ids["box"], w.ids["fleet"]})
	if err != nil || !res.Sent {
		t.Fatalf("approve %+v, %v", res, err)
	}
	reasons := map[string]string{}
	for _, r := range res.Machines {
		reasons[r.Label] = r.Status + ": " + r.Reason
	}
	want := map[string]string{"old": "failed: needs a herdr update", "box": "failed: needs a key file", "fleet": "added: "}
	for k, v := range want {
		if reasons[k] != v {
			t.Fatalf("results %v, want %v", reasons, want)
		}
	}
	if !strings.HasPrefix(reasons["gone"], "failed: ") {
		t.Fatalf("gone %q", reasons["gone"])
	}
	// Only a failure Try again may mend is offered for it: gone didn't
	// answer; old's herdr is too old and box has no key file.
	rows := rowsByLabel(res)
	if !rows["gone"].Retryable || rows["old"].Retryable || rows["box"].Retryable || rows["fleet"].Retryable {
		t.Fatalf("retryable rows %+v", res.Machines)
	}
	if _, err := w.d.PairApproveRetry(ctx, id, []string{w.ids["old"], w.ids["box"]}); err == nil || w.machines["old"].adds.Load() != 0 {
		t.Fatalf("Try again on machines a retry can't mend: %v", err)
	}
	if len(w.machines["old"].keys.Keys()) != 0 {
		t.Fatal("a key on old")
	}
	env := w.delivered(t).Envelope
	if len(env.Machines) != 4 {
		t.Fatalf("envelope %+v", env)
	}
	for _, m := range env.Machines {
		if m.Nickname == "old" && m.HostKey != hostKeyLine(w.machines["old"].hostKey) {
			t.Fatalf("old's host key %q: it answered, so its verified key is sent", m.HostKey)
		}
		if (m.Nickname == "gone" || m.Nickname == "box") && m.HostKey != "" {
			t.Fatalf("%s has a host key %q though it was never reached", m.Nickname, m.HostKey)
		}
	}
}

// A failed add is in the list as failed; Try again adds it there and
// sends the whole list again at seq 2.
func TestPairApproveTryAgainResendsTheListAtTheNextSeq(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	w.typeCode(t, id)
	w.machines["fleet"].failing.Store(1)
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"], w.ids["fleet"]})
	if err != nil || !res.Sent || res.Machines[1].Status != account.PairFailed || res.Machines[1].Reason != "disk full" {
		t.Fatalf("approve %+v, %v", res, err)
	}
	if got := w.delivered(t); got.Seq != 1 || got.Envelope.Machines[1].Status != account.PairFailed {
		t.Fatalf("first list %+v", got)
	}
	// Only a failed machine is tried again.
	res, err = w.d.PairApproveRetry(ctx, id, []string{w.ids["studio"], w.ids["fleet"]})
	if err != nil || res.Problem != "" || res.Machines[0].Status != account.PairAdded || res.Machines[1].Status != account.PairAdded {
		t.Fatalf("retry %+v, %v", res, err)
	}
	if n := w.machines["studio"].adds.Load(); n != 1 {
		t.Fatalf("studio got %d adds, want 1", n)
	}
	got := w.delivered(t)
	if got.Seq != 2 || got.Envelope.Machines[1].Status != account.PairAdded || got.Envelope.Machines[1].HostKey != hostKeyLine(w.machines["fleet"].hostKey) {
		t.Fatalf("second list %+v", got)
	}
	if _, err := w.d.PairApproveRetry(ctx, id, []string{w.ids["fleet"]}); err == nil {
		t.Fatal("a retry with nothing failed")
	}
	// After the 10 minutes, no more retries.
	w.machines["fleet"].failing.Store(0)
	pairNow = func() time.Time { return time.Now().Add(pairResendWindow) }
	t.Cleanup(func() { pairNow = time.Now })
	res, err = w.d.PairApproveRetry(ctx, id, []string{w.ids["fleet"]})
	if err != nil || !res.Ended {
		t.Fatalf("late retry %+v, %v", res, err)
	}
}

// Three wrong codes deny the request, and no machine gets a key.
func TestPairApproveThreeWrongCodesDeny(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	for left := 2; left >= 0; left-- {
		c, err := w.d.PairApproveCheckCode(ctx, id, w.wrong(t))
		if err != nil || c.Ok || c.Left != left || c.Denied != (left == 0) {
			t.Fatalf("wrong code: %+v %v", c, err)
		}
	}
	if _, err := w.d.PairApproveCheckCode(ctx, id, w.codeOf(t)); err == nil {
		t.Fatal("the right code after a lockout")
	}
	if _, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"]}); err == nil {
		t.Fatal("approved after three wrong codes")
	}
	if w.allKeys() != 0 || w.machines["studio"].adds.Load() != 0 {
		t.Fatal("a key was added")
	}
	if rs := w.svc.Requests(); rs[0].Outcome != "denied" {
		t.Fatalf("request %+v", rs[0])
	}
}

// pair.add_key is never called before the code was checked, nor with a
// wrong one.
func TestPairApproveAddsNothingBeforeTheCodeMatches(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	_, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"], w.ids["fleet"]})
	if !errors.Is(err, account.ErrCodeNotChecked) {
		t.Fatalf("approve before the code: %v", err)
	}
	if c, _ := w.d.PairApproveCheckCode(ctx, id, w.wrong(t)); c.Ok {
		t.Fatal("a wrong code matched")
	}
	if _, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"]}); !errors.Is(err, account.ErrCodeNotChecked) {
		t.Fatalf("approve after a wrong code: %v", err)
	}
	if _, err := w.d.PairApproveRetry(ctx, id, []string{w.ids["studio"]}); err == nil {
		t.Fatal("a retry before any approval")
	}
	for name, h := range w.machines {
		if h.adds.Load() != 0 {
			t.Fatalf("pair.add_key called on %s before the code matched", name)
		}
	}
}

// Deny ends the request; nothing is added.
func TestPairApproveDeny(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	if err := w.d.PairApproveDeny(ctx, id); err != nil {
		t.Fatal(err)
	}
	if rs := w.svc.Requests(); rs[0].Outcome != "denied" {
		t.Fatalf("request %+v", rs[0])
	}
	if _, err := w.d.PairApproveCheckCode(ctx, id, w.codeOf(t)); err == nil {
		t.Fatal("code checked after Deny")
	}
	if w.allKeys() != 0 {
		t.Fatal("a key was added")
	}
}

// The request expires while the sheet is open: Approve adds nothing and
// says it ended; and with the sheet idle, the page is told.
func TestPairApproveRequestExpiringMidSheet(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	w.typeCode(t, id)
	w.elapsed.Store(int64(fakeaccount.RequestTTL))
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"]})
	if err != nil || !res.Ended || res.Problem != pairEnded || res.Sent {
		t.Fatalf("approve after expiry %+v, %v", res, err)
	}
	if w.allKeys() != 0 {
		t.Fatal("a key was added to an expired request")
	}

	// A request with 3 s left: once they pass, the open sheet hears it ended.
	w2 := newPairWorld(t)
	w2.ask, _ = w2.newDev.AskToPair(ctx, w2.svc.Account, w2.newKey, w2.sshKey.Public)
	w2.elapsed.Store(int64(fakeaccount.RequestTTL - 3*time.Second))
	if err := w2.d.PairApproveStart(ctx, w2.ask.ID()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "ready", func() bool { return w2.state(w2.ask.ID()) == "ready" })
	deadline := time.Now().Add(10 * time.Second)
	for w2.state(w2.ask.ID()) != "ended" {
		if time.Now().After(deadline) {
			t.Fatal("the sheet never heard the request ended")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// The host key sent is the one the session verified, and only when it
// matches the pin kept here.
func TestPairApproveRefusesAHostKeyThatDoesntMatchItsPin(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	w.typeCode(t, id)
	w.d.mu.Lock()
	_, addr := w.d.link.client.HostKey()
	w.d.mu.Unlock()
	if err := w.d.pins.SetPin(addr, strings.Repeat("0", 64)); err != nil {
		t.Fatal(err)
	}
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"]})
	if err != nil || res.Machines[0].Status != account.PairFailed || !strings.Contains(res.Machines[0].Reason, "host key") {
		t.Fatalf("approve %+v, %v", res, err)
	}
	if w.machines["studio"].adds.Load() != 0 {
		t.Fatal("added over a connection whose host key doesn't match its pin")
	}
	if m := w.delivered(t).Envelope.Machines[0]; m.HostKey != "" {
		t.Fatalf("sent host key %q", m.HostKey)
	}
}

// The new device cancelling mid-sheet: Approve adds nothing and says so.
func TestPairApproveRequestCancelledByTheNewDevice(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	w.typeCode(t, id)
	if err := w.ask.Cancel(ctx); err != nil {
		t.Fatal(err)
	}
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"]})
	if err != nil || !res.Ended || res.Problem != pairCancelled || res.Sent {
		t.Fatalf("approve after cancel %+v, %v", res, err)
	}
	if w.allKeys() != 0 {
		t.Fatal("a key was added to a cancelled request")
	}
}

// A finish whose answer was lost, and the recovering list too: the
// service holds the approval with no known list, so the same list goes
// again at the next seq, and no machine gets the key twice.
func TestPairApproveLostAnswersSendTheListAgainAtTheNextSeq(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	w.typeCode(t, id)
	w.lose.Store("finish", true)
	w.lose.Store("envelope", true)
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"], w.ids["fleet"]})
	for i := 0; err == nil && res.Unsure && i < 3; i++ {
		res, err = w.d.PairApproveAdd(ctx, id, nil)
	}
	for i := 0; err == nil && res.Unsent && i < 3; i++ {
		res, err = w.d.PairApproveRetry(ctx, id, nil)
	}
	if err != nil || !res.Sent || res.Unsent || res.Machines[0].Status != account.PairAdded || res.Machines[1].Status != account.PairAdded {
		t.Fatalf("approve %+v, %v", res, err)
	}
	if got := w.delivered(t); got.Seq < 2 || len(got.Envelope.Machines) != 2 || got.Envelope.Machines[1].HostKey != hostKeyLine(w.machines["fleet"].hostKey) {
		t.Fatalf("list %+v", got)
	}
	if a, b := w.machines["studio"].adds.Load(), w.machines["fleet"].adds.Load(); a != 1 || b != 1 {
		t.Fatalf("adds studio %d fleet %d, want 1 each", a, b)
	}
}

// herdr's typed refusals read as a plain reason on the machine's row.
func TestPairApproveShowsHerdrsRefusalAsTheRowsReason(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	w.typeCode(t, id)
	w.machines["fleet"].refusing.Store("pair_write_failed")
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["fleet"]})
	if err != nil || res.Machines[0].Status != account.PairFailed || res.Machines[0].Reason != "herdr couldn't write authorized_keys" {
		t.Fatalf("approve %+v, %v", res, err)
	}
}

func rowsByLabel(res PairApproveResult) map[string]PairApproveRow {
	out := map[string]PairApproveRow{}
	for _, r := range res.Machines {
		out[r.Label] = r
	}
	return out
}

// A machine never opened from this computer has no pin kept here: an
// approval neither trusts its host key nor pins it. It is unusable, gets
// no key, and no pin is written, before the code or after.
func TestPairApproveNeverPinsAMachineOnFirstContact(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	w.keyMachine(t, "fresh", true, false)
	m, err := w.d.savedMachine(w.ids["fresh"])
	if err != nil {
		t.Fatal(err)
	}
	addr := net.JoinHostPort(m.Host, strconv.Itoa(m.Port))
	id := w.start(t)
	if _, err := w.d.PairApproveProbe(ctx, id, w.ids["fresh"]); err == nil {
		t.Fatal("a probe before the code was typed")
	}
	w.typeCode(t, id)
	if p, err := w.d.PairApproveProbe(ctx, id, w.ids["fresh"]); err != nil || p.State != "needs_pin" {
		t.Fatalf("probe %+v, %v", p, err)
	}
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["fresh"], w.ids["fleet"]})
	rows := rowsByLabel(res)
	if err != nil || rows["fresh"].Status != account.PairFailed || rows["fresh"].Reason != errNoPin.Error() || rows["fleet"].Status != account.PairAdded {
		t.Fatalf("approve %+v, %v", res, err)
	}
	if w.machines["fresh"].adds.Load() != 0 {
		t.Fatal("a key on a machine whose host key isn't pinned here")
	}
	if _, ok, _ := w.d.pins.Pin(addr); ok {
		t.Fatal("the approval pinned a host key on first contact")
	}
	for _, e := range w.delivered(t).Envelope.Machines {
		if e.Nickname == "fresh" && e.HostKey != "" {
			t.Fatalf("sent fresh's unpinned host key %q", e.HostKey)
		}
	}
}

// Try again reaches no machine once the service no longer holds the
// approval.
func TestPairApproveTryAgainChecksTheRequestFirst(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	w.typeCode(t, id)
	w.machines["fleet"].failing.Store(1)
	if res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"], w.ids["fleet"]}); err != nil || !res.Sent {
		t.Fatalf("approve %+v, %v", res, err)
	}
	adds := w.machines["fleet"].adds.Load()
	w.elapsed.Store(int64(fakeaccount.RequestTTL + fakeaccount.OutcomeKeep + time.Minute))
	res, err := w.d.PairApproveRetry(ctx, id, []string{w.ids["fleet"]})
	if err != nil || !res.Ended || res.Problem != pairTooLate {
		t.Fatalf("retry %+v, %v", res, err)
	}
	if w.machines["fleet"].adds.Load() != adds {
		t.Fatal("Try again reached a machine for a request that no longer takes a list")
	}
}

// Try again reaches only machines still saved here. One removed since is
// answered with its new reason and no Try again (a result, not an error,
// so the sheet shows it).
func TestPairApproveTryAgainOnlyReachesMachinesStillSaved(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	w.typeCode(t, id)
	w.machines["fleet"].failing.Store(1)
	if res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"], w.ids["fleet"]}); err != nil || !res.Sent {
		t.Fatalf("approve %+v, %v", res, err)
	}
	adds := w.machines["fleet"].adds.Load()
	if err := w.d.RemoveMachine(w.ids["fleet"]); err != nil {
		t.Fatal(err)
	}
	res, err := w.d.PairApproveRetry(ctx, id, []string{w.ids["fleet"]})
	if fleet := rowsByLabel(res)["fleet"]; err != nil || fleet.Reason != "that machine is no longer saved here" || fleet.Retryable {
		t.Fatalf("retry %+v, %v", res, err)
	}
	if w.machines["fleet"].adds.Load() != adds {
		t.Fatal("Try again reached a machine no longer saved")
	}
	if _, err := w.d.PairApproveRetry(ctx, id, []string{w.ids["fleet"]}); err == nil {
		t.Fatal("a second Try again found something to try")
	}
}

// A store Try again can't read says why and keeps Try again: only a read
// that finds no such machine ends its retries. Once the store reads, the
// retry reaches the machine.
func TestPairApproveTryAgainKeepsARowWhenTheStoreIsUnread(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	w.typeCode(t, id)
	w.machines["fleet"].failing.Store(1)
	if res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"], w.ids["fleet"]}); err != nil || !res.Sent {
		t.Fatalf("approve %+v, %v", res, err)
	}
	adds := w.machines["fleet"].adds.Load()
	saved, err := os.ReadFile(w.d.machinesPath())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(w.d.machinesPath(), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := w.d.PairApproveRetry(ctx, id, []string{w.ids["fleet"]})
	if fleet := rowsByLabel(res)["fleet"]; err != nil || !strings.HasPrefix(fleet.Reason, "couldn't read the machines saved here") || !fleet.Retryable {
		t.Fatalf("retry with the store unread %+v, %v", res, err)
	}
	if w.machines["fleet"].adds.Load() != adds {
		t.Fatal("Try again reached a machine it couldn't read")
	}
	if err := os.WriteFile(w.d.machinesPath(), saved, 0o600); err != nil {
		t.Fatal(err)
	}
	res, err = w.d.PairApproveRetry(ctx, id, []string{w.ids["fleet"]})
	if err != nil || rowsByLabel(res)["fleet"].Status != account.PairAdded || w.machines["fleet"].adds.Load() != adds+1 {
		t.Fatalf("retry with the store read %+v, %v", res, err)
	}
}

// A machine the list can't carry (a user with an @ can't split back from
// user@host) is found before any machine changes: shown failed with why,
// never given the key, never sealed, never tried again.
func TestPairApproveHoldsOutAMachineTheListCantCarry(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	at, err := w.d.savedMachine(w.ids["fleet"])
	if err != nil {
		t.Fatal(err)
	}
	at.Nickname, at.User = "at", "dev@box"
	w.save(t, "at", at)
	id := w.start(t)
	w.typeCode(t, id)
	if p, err := w.d.PairApproveProbe(ctx, id, w.ids["at"]); err != nil || p.State != "unsendable" || !strings.Contains(p.Reason, "@") {
		t.Fatalf("probe %+v, %v", p, err)
	}
	if _, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["at"]}); err == nil {
		t.Fatal("approved with only a machine the list can't carry")
	}
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["at"], w.ids["studio"]})
	rows := rowsByLabel(res)
	if err != nil || !res.Sent || rows["at"].Status != account.PairFailed || !strings.HasPrefix(rows["at"].Reason, "can't be sent to the new device") || rows["studio"].Status != account.PairAdded {
		t.Fatalf("approve %+v, %v", res, err)
	}
	if n := w.machines["fleet"].adds.Load(); n != 0 {
		t.Fatalf("%d adds where only the @ user's machine points", n)
	}
	if env := w.delivered(t).Envelope; len(env.Machines) != 1 || env.Machines[0].Nickname != "studio" {
		t.Fatalf("envelope %+v", env)
	}
	if _, err := w.d.PairApproveRetry(ctx, id, []string{w.ids["at"]}); err == nil || w.machines["fleet"].adds.Load() != 0 {
		t.Fatalf("Try again on a held machine: %v", err)
	}
}

// The list is sized with the host keys the probes verified before any
// machine changes: the machine with long host keys that makes it too long
// is left out, with why, before any key is added; the rest get the key.
func TestPairApproveSizesTheListWithTheProbedHostKeys(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	big := w.bigMachines(t)
	last := big[len(big)-1]
	id := w.start(t)
	w.typeCode(t, id)
	ticked := []string{w.ids["studio"]}
	for _, name := range append([]string{"studio"}, big...) {
		if p, err := w.d.PairApproveProbe(ctx, id, w.ids[name]); err != nil || p.State != "ready" {
			t.Fatalf("probe %s %+v, %v", name, p, err)
		}
		if name != "studio" {
			ticked = append(ticked, w.ids[name])
		}
	}
	res, err := w.d.PairApproveAdd(ctx, id, ticked)
	rows := rowsByLabel(res)
	if err != nil || !res.Sent || rows[big[0]].Status != account.PairAdded || rows[last].Status != account.PairFailed || rows[last].Reason != pairNoRoom || rows[last].Retryable {
		t.Fatalf("approve %+v, %v", res, err)
	}
	if n := w.machines[last].adds.Load(); n != 0 {
		t.Fatalf("%d adds on the machine left out", n)
	}
	w.mu.Lock()
	first := w.progress[0]
	adding := slices.ContainsFunc(w.progress, func(p PairApproveProgress) bool { return p.MachineID == w.ids[last] && p.Status == "adding" })
	w.mu.Unlock()
	if first.MachineID != w.ids[last] || first.Status != account.PairFailed || adding {
		t.Fatalf("%s wasn't left out before any machine changed: first progress %+v, adding %v", last, first, adding)
	}
	if env := w.delivered(t).Envelope; len(env.Machines) != len(big) || slices.ContainsFunc(env.Machines, func(m account.PairMachine) bool { return m.Nickname == last }) {
		t.Fatalf("envelope %+v", env)
	}
}

// With no probe to size it by, each connection's verified host key sizes
// the list again before its key is added: the one machine that would make
// it too long (whichever gets there last) gets no key, and the list still
// fits.
func TestPairApproveSizesTheListAgainBeforeEachKey(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	big := w.bigMachines(t)
	id := w.start(t)
	w.typeCode(t, id)
	ticked := []string{w.ids["studio"]}
	for _, name := range big {
		ticked = append(ticked, w.ids[name])
	}
	res, err := w.d.PairApproveAdd(ctx, id, ticked)
	if err != nil || !res.Sent {
		t.Fatalf("approve %+v, %v", res, err)
	}
	var held []string
	for _, r := range res.Machines {
		switch {
		case r.Status == account.PairFailed && r.Reason == pairNoRoom:
			held = append(held, r.Label)
		case r.Status != account.PairAdded:
			t.Fatalf("%s: %+v", r.Label, r)
		}
	}
	if len(held) != 1 || w.machines[held[0]].adds.Load() != 0 {
		t.Fatalf("held %v: want one machine left out with no key added", held)
	}
	if env := w.delivered(t).Envelope; len(env.Machines) != len(big) {
		t.Fatalf("envelope %+v", env)
	}
}

// The list carries plain host keys only (pair-v1 host_key): a machine
// whose host presents a certificate is sent with the key it certifies,
// whose fingerprint is what the new device pins; the certificate, however
// long, costs the list nothing.
func TestPairApproveSendsACertificateHostsPlainKey(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	cert := certHostKey(t, 13000)
	w.keyMachineWith(t, "cert", cert, true, true)
	plain := cert.PublicKey().(*ssh.Certificate).Key
	id := w.start(t)
	w.typeCode(t, id)
	if p, err := w.d.PairApproveProbe(ctx, id, w.ids["cert"]); err != nil || p.State != "ready" {
		t.Fatalf("probe %+v, %v", p, err)
	}
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["cert"]})
	if err != nil || !res.Sent || res.Machines[0].Status != account.PairAdded {
		t.Fatalf("approve %+v, %v", res, err)
	}
	m := w.delivered(t).Envelope.Machines[0]
	if m.HostKey != hostKeyLine(plain) || !strings.HasPrefix(m.HostKey, ssh.KeyAlgoED25519+" ") {
		t.Fatalf("sent host key %q, want the certified key %q", m.HostKey, hostKeyLine(plain))
	}
	k, err := m.HostPublicKey()
	if _, isCert := k.(*ssh.Certificate); err != nil || isCert || bridge.Fingerprint(k) != bridge.Fingerprint(plain) {
		t.Fatalf("sent key %v, %v: want the plain key's fingerprint", k, err)
	}
}

func rsaHostKey(t *testing.T) ssh.Signer {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func ed25519HostKey(t *testing.T) ssh.Signer {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// A host with only an RSA host key is held out before any key is added
// there: the new device checks ed25519 and ECDSA keys only.
func TestPairApproveHoldsOutAnRSAOnlyHost(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	w.keyMachineWith(t, "rsa", rsaHostKey(t), true, true)
	id := w.start(t)
	w.typeCode(t, id)
	if p, err := w.d.PairApproveProbe(ctx, id, w.ids["rsa"]); err != nil || p.State != "unsendable" || p.Reason != string(errHostKeyType) {
		t.Fatalf("probe %+v, %v", p, err)
	}
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"], w.ids["rsa"]})
	rows := rowsByLabel(res)
	if err != nil || !res.Sent || rows["studio"].Status != account.PairAdded ||
		rows["rsa"].Status != account.PairFailed || rows["rsa"].Reason != string(errHostKeyType) || rows["rsa"].Retryable {
		t.Fatalf("approve %+v, %v", res, err)
	}
	if n := w.machines["rsa"].adds.Load(); n != 0 {
		t.Fatalf("%d adds on the RSA host", n)
	}
	if env := w.delivered(t).Envelope; len(env.Machines) != 1 || env.Machines[0].Nickname != "studio" {
		t.Fatalf("envelope %+v", env)
	}
}

// A host with RSA and ed25519 keys shows a pair approval its ed25519 key
// (SSH's defaults would get its RSA one), the key the new device
// negotiates; that is the key added over and sent.
func TestPairApproveSendsTheEd25519KeyOfAHostWithRSAToo(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	ed := ed25519HostKey(t)
	w.keyMachineWith(t, "both", ed, true, true, rsaHostKey(t))
	id := w.start(t)
	w.typeCode(t, id)
	if p, err := w.d.PairApproveProbe(ctx, id, w.ids["both"]); err != nil || p.State != "ready" {
		t.Fatalf("probe %+v, %v", p, err)
	}
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["both"]})
	if err != nil || !res.Sent || res.Machines[0].Status != account.PairAdded {
		t.Fatalf("approve %+v, %v", res, err)
	}
	if m := w.delivered(t).Envelope.Machines[0]; m.HostKey != hostKeyLine(ed.PublicKey()) {
		t.Fatalf("sent host key %q, want the ed25519 key", m.HostKey)
	}
}

// A host this computer pinned by its RSA key (as SSH's defaults pick it)
// still has that key: the ed25519 key a pair approval gets isn't the one
// pinned, and nothing here vouches for it. The host is held out with why,
// not shown as a changed host key, and its pin stays as it was.
func TestPairApproveHoldsOutAHostPinnedByAnotherKeyType(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	rsaKey := rsaHostKey(t)
	w.keyMachineWith(t, "rsapin", rsaKey, true, true, ed25519HostKey(t))
	id := w.start(t)
	w.typeCode(t, id)
	why := "can't share this machine: this computer pinned its RSA host key, not the one the new device checks"
	if p, err := w.d.PairApproveProbe(ctx, id, w.ids["rsapin"]); err != nil || p.State != "unsendable" || p.Reason != why {
		t.Fatalf("probe %+v, %v", p, err)
	}
	res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"], w.ids["rsapin"]})
	rows := rowsByLabel(res)
	if err != nil || !res.Sent || rows["rsapin"].Status != account.PairFailed || rows["rsapin"].Reason != why || rows["rsapin"].Retryable {
		t.Fatalf("approve %+v, %v", res, err)
	}
	if n := w.machines["rsapin"].adds.Load(); n != 0 {
		t.Fatalf("%d adds on the host pinned by its RSA key", n)
	}
	if env := w.delivered(t).Envelope; len(env.Machines) != 1 || env.Machines[0].Nickname != "studio" {
		t.Fatalf("envelope %+v", env)
	}
	m, err := w.d.savedMachine(w.ids["rsapin"])
	if err != nil {
		t.Fatal(err)
	}
	if pin, ok, err := w.d.pins.Pin(net.JoinHostPort(m.Host, strconv.Itoa(m.Port))); err != nil || !ok || pin != bridge.Fingerprint(rsaKey.PublicKey()) {
		t.Fatalf("pin %q %v %v: want the RSA key's, as it was", pin, ok, err)
	}
}

// A list the service didn't take goes again in the last minute: only a
// key still to add needs the time for an add and the report.
func TestPairApproveSendsTheListAgainInTheLastMinute(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	w.typeCode(t, id)
	w.machines["fleet"].failing.Store(1)
	if res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"], w.ids["fleet"]}); err != nil || !res.Sent || !rowsByLabel(res)["fleet"].Retryable {
		t.Fatalf("approve %+v, %v", res, err)
	}
	// Try again adds fleet's key; the answer to its list is lost.
	w.lose.Store("envelope", true)
	res, err := w.d.PairApproveRetry(ctx, id, []string{w.ids["fleet"]})
	if err != nil || !res.Unsent || rowsByLabel(res)["fleet"].Status != account.PairAdded {
		t.Fatalf("retry %+v, %v", res, err)
	}
	// 45 s before retries end: the list still goes.
	pairNow = func() time.Time { return time.Now().Add(pairResendWindow - 45*time.Second) }
	t.Cleanup(func() { pairNow = time.Now })
	res, err = w.d.PairApproveRetry(ctx, id, nil)
	if err != nil || !res.Sent || res.Unsent || res.Ended || res.Problem != "" {
		t.Fatalf("last-minute resend %+v, %v", res, err)
	}
	if got := w.delivered(t); got.Seq != 3 || got.Envelope.Machines[1].Status != account.PairAdded {
		t.Fatalf("list %+v", got)
	}
	if n := w.machines["fleet"].adds.Load(); n != 2 {
		t.Fatalf("fleet got %d adds, want 2", n)
	}
}

// In the last minute a failed machine gets no new key: Try again says
// it's too late and reaches nothing.
func TestPairApproveAddsNoKeyInTheLastMinute(t *testing.T) {
	w := newPairWorld(t)
	ctx := context.Background()
	id := w.start(t)
	w.typeCode(t, id)
	w.machines["fleet"].failing.Store(1)
	if res, err := w.d.PairApproveAdd(ctx, id, []string{w.ids["studio"], w.ids["fleet"]}); err != nil || !res.Sent {
		t.Fatalf("approve %+v, %v", res, err)
	}
	pairNow = func() time.Time { return time.Now().Add(pairResendWindow - 45*time.Second) }
	t.Cleanup(func() { pairNow = time.Now })
	res, err := w.d.PairApproveRetry(ctx, id, []string{w.ids["fleet"]})
	if err != nil || !res.Ended || res.Problem != pairTooLate {
		t.Fatalf("late retry %+v, %v", res, err)
	}
	if n := w.machines["fleet"].adds.Load(); n != 1 {
		t.Fatalf("fleet got %d adds, want 1", n)
	}
}

// A list pairFits takes fits with every row at its longest status and
// its host key. With every row failed for the longest reason it would be
// too long, so the wire list leaves reasons out from the last row on
// until it fits, keeping those that do; the sheet keeps every reason.
func TestPairEnvelopeLeavesOutReasonsThatDontFit(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	k, _ := ssh.NewPublicKey(priv.Public())
	hostKey := hostKeyLine(k)
	var rows []pairRow
	for i := 0; ; i++ {
		m := Machine{Nickname: "machine-" + strconv.Itoa(i), Host: "127.0.0.1", Port: 22, User: "dev"}
		next := append(slices.Clone(rows), pairRow{m: m, entry: pairEntry(m), hostKey: hostKey})
		if pairFits(next) != nil {
			break
		}
		rows = next
	}
	already := account.PairEnvelope{V: account.PairEnvelopeVersion}
	for _, r := range rows {
		e := r.entry
		e.HostKey, e.Status = r.hostKey, account.PairAlready
		already.Machines = append(already.Machines, e)
	}
	if _, err := already.Marshal(); err != nil {
		t.Fatalf("%d rows pairFits took don't fit as already there: %v", len(rows), err)
	}
	longest := strings.Repeat("<\u2028", pairReasonRunes)
	for i := range rows {
		rows[i].entry.HostKey = rows[i].hostKey
		rows[i].fail(longest, true)
	}
	if _, err := (&pairApproval{rows: rows}).envelope().Marshal(); err != nil {
		t.Fatalf("the list for %d failed rows: %v", len(rows), err)
	}
	p := &pairApproval{rows: rows[:len(rows)/2]}
	e := p.envelope()
	if _, err := e.Marshal(); err != nil {
		t.Fatalf("the list for %d failed rows: %v", len(p.rows), err)
	}
	last := e.Machines[len(e.Machines)-1]
	if e.Machines[0].Reason != rows[0].entry.Reason || last.Reason != "" || last.Status != account.PairFailed || last.HostKey != hostKey {
		t.Fatalf("first reason %q, last %+v: want reasons kept from the first row, left out at the end", e.Machines[0].Reason, last)
	}
	for _, r := range p.result().Machines {
		if r.Reason != truncate(longest, pairReasonRunes) {
			t.Fatalf("the sheet's reason for %s: %q", r.Label, r.Reason)
		}
	}
}
