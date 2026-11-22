package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/account"
)

// syncWorker is the account service's sync as AccountService src/sync.ts
// keeps it: one revision per write, last write wins, tombstones for deletes,
// the hosts and prompts allowlists and field rules (a bad change refuses the
// whole push, 400), and the prompts cap (403).
type syncWorker struct {
	mu      sync.Mutex
	rev     int64
	items   map[string]account.Item
	n       int
	account string // "acct" when empty
	// failPush answers the next pushes 503 (the service down mid-sync).
	failPush bool
	// onPull, when set, runs once inside the next pull, before it answers.
	onPull func()
}

func (w *syncWorker) live() map[string]account.Item {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := map[string]account.Item{}
	for id, it := range w.items {
		if !it.Deleted {
			out[id] = it
		}
	}
	return out
}

func (w *syncWorker) serve(rw http.ResponseWriter, r *http.Request) {
	w.mu.Lock()
	defer w.mu.Unlock()
	reply := func(status int, v any) {
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(status)
		_ = json.NewEncoder(rw).Encode(v)
	}
	switch {
	case r.URL.Path == "/v1/auth/refresh":
		w.n++
		acct := w.account
		if acct == "" {
			acct = "acct"
		}
		reply(200, map[string]any{"account_id": acct, "access_token": fmt.Sprintf("a1.%022d.%043d", 1, w.n), "access_expires_in": 3600,
			"refresh_token": fmt.Sprintf("r1.%022d.%043d", 1, w.n), "refresh_expires_in": 1})
	case r.URL.Path == "/v1/sync" && r.Method == http.MethodGet:
		if hook := w.onPull; hook != nil {
			w.onPull = nil
			hook()
		}
		since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
		var changes []account.Item
		for _, it := range w.items {
			if it.Rev > since {
				changes = append(changes, it)
			}
		}
		reply(200, map[string]any{"rev": w.rev, "changes": changes, "more": false})
	case r.URL.Path == "/v1/sync" && r.Method == http.MethodPost:
		var body struct {
			Changes []struct {
				Collection string          `json:"collection"`
				ID         string          `json:"id"`
				Deleted    bool            `json:"deleted"`
				Body       json.RawMessage `json:"body"`
			}
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if w.failPush {
			reply(503, map[string]string{"error": "unavailable"})
			return
		}
		ids := map[string]bool{}
		for _, c := range body.Changes {
			// sync.ts: one change per collection and id in a push.
			if ids[c.Collection+"/"+c.ID] {
				reply(400, map[string]string{"error": "invalid_item"})
				return
			}
			ids[c.Collection+"/"+c.ID] = true
		}
		for _, c := range body.Changes {
			if c.Body != nil && !validSyncBody(c.Collection, c.Body) {
				reply(400, map[string]string{"error": "invalid_item"})
				return
			}
		}
		prompts := 0
		for id, it := range w.items {
			if it.Collection == "prompts" && !it.Deleted && !ids["prompts/"+id] {
				prompts++
			}
		}
		for _, c := range body.Changes {
			if c.Collection == "prompts" && !c.Deleted {
				prompts++
			}
		}
		if prompts > account.PromptsCap {
			reply(403, map[string]string{"error": "quota"})
			return
		}
		for _, c := range body.Changes {
			w.rev++
			it := account.Item{Collection: c.Collection, ID: c.ID, Rev: w.rev, Deleted: c.Deleted}
			if !c.Deleted {
				it.Body = c.Body
			}
			w.items[c.ID] = it
		}
		reply(200, map[string]any{"rev": w.rev, "applied": []any{}, "conflicts": []any{}})
	default:
		reply(404, map[string]string{"error": "not_found"})
	}
}

// validSyncBody is sync.ts's check of one body: only the collection's
// allowlisted fields, a prompt's text present and ≤8 KB, its title ≤128
// code points and its order a number.
func validSyncBody(collection string, raw json.RawMessage) bool {
	var fields map[string]any
	if json.Unmarshal(raw, &fields) != nil {
		return false
	}
	switch collection {
	case "hosts":
		for k := range fields {
			switch k {
			case "nickname", "host", "port", "username", "auth_kind", "label":
			default:
				return false
			}
		}
		return true
	case "prompts":
		for k, v := range fields {
			switch k {
			case "title":
				if s, ok := v.(string); !ok || len([]rune(s)) > 128 {
					return false
				}
			case "text":
				if s, ok := v.(string); !ok || s == "" || len(s) > 8192 {
					return false
				}
			case "order":
				if _, ok := v.(float64); !ok {
					return false
				}
			default:
				return false
			}
		}
		_, hasText := fields["text"]
		return hasText
	}
	return false
}

type signedInStore struct{ raw []byte }

func (s *signedInStore) Get() ([]byte, error) { return s.raw, nil }
func (s *signedInStore) Set(v []byte) error   { s.raw = v; return nil }
func (s *signedInStore) Delete() error        { s.raw = nil; return nil }

// device is one desktop app signed in to the shared fake account.
func device(t *testing.T, srv *httptest.Server) *Desk {
	t.Helper()
	d := newDesk(t.TempDir())
	signInTo(d, srv, "acct")
	d.accountStore = account.NewSecretsStore(noSecrets{}, errors.New("not found"))
	return d
}

// signInTo points d at the account srv serves.
func signInTo(d *Desk, srv *httptest.Server, acct string) {
	raw, _ := json.Marshal(map[string]string{"refresh_token": fmt.Sprintf("r1.%022d.%043d", 1, 0), "account_id": acct})
	d.account = account.New(srv.URL, "linux", &signedInStore{raw: raw}, srv.Client())
}

func quietSync(t *testing.T) {
	previous, background, prompts := publishSyncedMachines, backgroundMachineSync, publishSavedPrompts
	publishSyncedMachines, backgroundMachineSync, publishSavedPrompts = func([]SyncedMachine) {}, false, func([]SavedPrompt) {}
	t.Cleanup(func() { publishSyncedMachines, backgroundMachineSync, publishSavedPrompts = previous, background, prompts })
}

func syncIDs(t *testing.T, d *Desk) map[string]string {
	t.Helper()
	ms, err := d.Machines()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, m := range ms {
		out[m.ID] = m.SyncID
	}
	return out
}

// Two devices with one account: a machine saved on both syncs once, under
// the first pusher's id; a machine saved on one shows on the other to pair;
// an edit and a delete reach the other device; and no key path or session
// ever reaches the service.
func TestMachinesSyncAcrossTwoDevices(t *testing.T) {
	w := &syncWorker{items: map[string]account.Item{}}
	srv := httptest.NewServer(http.HandlerFunc(w.serve))
	defer srv.Close()
	ctx := context.Background()
	quietSync(t)

	mac, linux := device(t, srv), device(t, srv)
	// SaveMachine syncs in the background; this test syncs by hand, after.
	save := func(d *Desk, m Machine, replacing string) {
		t.Helper()
		if err := d.SaveMachine(m, replacing); err != nil {
			t.Fatal(err)
		}
	}
	save(mac, Machine{Nickname: "pi", Host: "Pi.local", User: "root", KeyPath: "/home/j/.ssh/id_ed25519", Session: "work"}, "")
	save(mac, Machine{Host: "studio", User: "jerry", Port: 2222}, "")
	save(linux, Machine{Host: "pi.local.", User: "root", KeyPath: "/root/.ssh/k"}, "")
	if err := linux.SelectMachine("root@pi.local.:22", ""); err == nil {
		linux.Disconnect()
	}
	sync := func(d *Desk) {
		t.Helper()
		if err := d.SyncMachines(ctx); err != nil {
			t.Fatal(err)
		}
	}
	sync(mac)
	sync(linux)
	macIDs, linuxIDs := syncIDs(t, mac), syncIDs(t, linux)
	pi := macIDs["root@Pi.local:22"]
	// Linux takes the Mac's copy (nickname, host spelling): same machine, one id.
	if pi == "" || linuxIDs["root@Pi.local:22"] != pi || len(linuxIDs) != 1 {
		t.Fatalf("the same machine on two devices: mac %v linux %v; want one id", macIDs, linuxIDs)
	}
	w.mu.Lock()
	live := 0
	for _, it := range w.items {
		if !it.Deleted {
			live++
		}
		if strings.Contains(string(it.Body), "ssh") || strings.Contains(string(it.Body), "work") {
			t.Fatalf("a key path or session reached the service: %s", it.Body)
		}
	}
	w.mu.Unlock()
	if live != 2 {
		t.Fatalf("%d machines in the account; want 2 (pi once, studio)", live)
	}
	// Linux's active machine took the Mac's spelling: Active follows it.
	if m, _ := linux.Machine(); m == nil || machineID(*m) != "root@Pi.local:22" {
		t.Fatalf("linux's active machine after the rename: %+v", m)
	}
	unsaved, err := linux.SyncedMachines()
	if err != nil || len(unsaved) != 1 || unsaved[0].Host != "studio" || unsaved[0].Port != 2222 || unsaved[0].Key {
		t.Fatalf("linux's machines to pair: %+v, %v", unsaved, err)
	}

	// An edit on the Mac reaches Linux; Linux keeps its own key path.
	save(mac, Machine{Nickname: "Raspberry", Host: "Pi.local", User: "root", KeyPath: "/home/j/.ssh/id_ed25519"}, "root@Pi.local:22")
	sync(mac)
	sync(linux)
	ms, _ := linux.Machines()
	if ms[0].Nickname != "Raspberry" || ms[0].KeyPath != "/root/.ssh/k" || ms[0].ID != "root@Pi.local:22" {
		t.Fatalf("linux after the mac's edit: %+v", ms[0].Machine)
	}

	// A delete on Linux reaches the Mac.
	if err := linux.RemoveMachine(ms[0].ID); err != nil {
		t.Fatal(err)
	}
	sync(linux)
	sync(mac)
	if _, ok := syncIDs(t, mac)["root@Pi.local:22"]; ok {
		t.Fatalf("the mac still has the machine linux deleted: %v", syncIDs(t, mac))
	}
	if raw, _ := os.ReadFile(linux.syncStatePath()); strings.Contains(string(raw), `"deletes"`) {
		t.Fatalf("the pushed delete is still pending: %s", raw)
	}
}

func newWorker(t *testing.T, acct string) (*syncWorker, *httptest.Server) {
	w := &syncWorker{items: map[string]account.Item{}, account: acct}
	srv := httptest.NewServer(http.HandlerFunc(w.serve))
	t.Cleanup(srv.Close)
	return w, srv
}

// #257 review P1: a first push the service refused keeps the machines, and
// the next sync pushes them under the same ids.
func TestARefusedFirstPushLosesNoMachine(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a refused push reported success")
	}
	first := syncIDs(t, mac)["root@pi:22"]
	w.mu.Lock()
	w.failPush = false
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	ids := syncIDs(t, mac)
	if ids["root@pi:22"] == "" || ids["root@pi:22"] != first {
		t.Fatalf("after the retry: %v (first id %q); want the machine kept under its id", ids, first)
	}
	if live := w.live(); len(live) != 1 || live[first].ID != first {
		t.Fatalf("account holds %v; want the machine once under %s", live, first)
	}
}

// The host home's avatar needs attention while the signed-in account's
// newest sync failed: a failed push sets it and tells the page, the next
// good sync clears it, and another account never inherits it.
func TestAFailedSyncNeedsAttentionUntilTheNextGoodOne(t *testing.T) {
	quietSync(t)
	var published []AccountState
	previous := publishAccount
	publishAccount = func(s AccountState) { published = append(published, s) }
	t.Cleanup(func() { publishAccount = previous })
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(context.Background()); err != nil || mac.AccountState().SyncFailed {
		t.Fatalf("a good sync: %v, %+v", err, mac.AccountState())
	}
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	if err := mac.SaveMachine(Machine{Host: "nas", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a refused push reported success")
	}
	if !mac.AccountState().SyncFailed || len(published) != 1 || !published[0].SyncFailed {
		t.Fatalf("after a failed sync: %+v, published %+v", mac.AccountState(), published)
	}
	signInTo(mac, srv, "other")
	if mac.AccountState().SyncFailed {
		t.Fatal("another account inherited the failed sync")
	}
	signInTo(mac, srv, "acct")
	w.mu.Lock()
	w.failPush = false
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	if mac.AccountState().SyncFailed || len(published) != 2 || published[1].SyncFailed {
		t.Fatalf("after the next good sync: %+v, published %+v", mac.AccountState(), published)
	}
}

// #263: each account keeps its own result. A fails, B fails, and back on A
// it still needs attention; B's later good sync clears only B.
func TestEachAccountKeepsItsOwnSyncFailure(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	fail := func(on bool) { w.mu.Lock(); w.failPush = on; w.mu.Unlock() }
	as := func(acct string) { w.mu.Lock(); w.account = acct; w.mu.Unlock(); signInTo(mac, srv, acct) }
	fail(true)
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("A: a refused push reported success")
	}
	as("other")
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("B: a refused push reported success")
	}
	as("acct")
	if !mac.AccountState().SyncFailed {
		t.Fatal("back on A, its failure was lost to B's")
	}
	fail(false)
	as("other")
	if err := mac.SyncMachines(context.Background()); err != nil || mac.AccountState().SyncFailed {
		t.Fatalf("B's good sync: %v, %+v", err, mac.AccountState())
	}
	as("acct")
	if !mac.AccountState().SyncFailed {
		t.Fatal("B's good sync cleared A's failure")
	}
}

// #262: a sync the session leaves midway (here a sign-out during its pull)
// neither fails nor succeeds, so A's earlier failure stands.
func TestAnAbandonedSyncLeavesTheLastResult(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a refused push reported success")
	}
	var signedOut sync.WaitGroup
	signedOut.Add(1)
	client := mac.account
	w.mu.Lock()
	w.failPush = false
	w.onPull = func() {
		go func() { defer signedOut.Done(); _ = client.SignOut(context.Background()) }()
		for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(5 * time.Millisecond) {
			if s, _ := client.Current(); s == nil {
				return
			}
		}
	}
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err != nil {
		t.Fatalf("a sync the session left: %v", err)
	}
	signedOut.Wait()
	signInTo(mac, srv, "acct")
	if !mac.AccountState().SyncFailed {
		t.Fatal("an abandoned sync cleared A's failure")
	}
}

// #257 review P2: changing a machine's host or user on either device is an
// edit of the same item, not a delete and a new machine.
func TestIdentityChangingRenamesFollowTheItem(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	ctx := context.Background()
	mac, linux := device(t, srv), device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	for _, d := range []*Desk{mac, linux} {
		if err := d.SyncMachines(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err := linux.SaveMachine(Machine{Host: "10.0.0.5", User: "root", KeyPath: "/k2"}, ""); err != nil { // to pair: saves it
		t.Fatal(err)
	}
	if err := linux.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	id := syncIDs(t, mac)["root@pi:22"]
	// The Mac renames pi's host.
	if err := mac.SaveMachine(Machine{Host: "pi.lan", User: "root", KeyPath: "/k"}, "root@pi:22"); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if got := syncIDs(t, mac)["root@pi.lan:22"]; got != id {
		t.Fatalf("mac lost the machine on rename: %v", syncIDs(t, mac))
	}
	live := w.live()
	if body := string(live[id].Body); !strings.Contains(body, `"pi.lan"`) {
		t.Fatalf("account item %s after the rename: %s", id, body)
	}
	if len(live) != 2 {
		t.Fatalf("account has %d items; want 2 (pi renamed, 10.0.0.5)", len(live))
	}
}

// #257 review P2: the sync state belongs to one account. Signing in to
// another doesn't read the first one's machines as deleted, and shows none
// of them.
func TestAnotherAccountStartsOverWithoutDeletingMachines(t *testing.T) {
	quietSync(t)
	_, srvA := newWorker(t, "acct-a")
	wB, srvB := newWorker(t, "acct-b")
	ctx := context.Background()
	mac := device(t, srvA)
	signInTo(mac, srvA, "acct-a")
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	signInTo(mac, srvB, "acct-b")
	if got, _ := mac.SyncedMachines(); len(got) != 0 {
		t.Fatalf("account B shows account A's machines: %+v", got)
	}
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	ids := syncIDs(t, mac)
	if ids["root@pi:22"] == "" {
		t.Fatalf("machines after switching accounts: %v; want pi kept and synced to B", ids)
	}
	if live := wB.live(); len(live) != 1 || live[ids["root@pi:22"]].ID == "" {
		t.Fatalf("account B holds %v; want pi", live)
	}
}

// #257 review P2: a reconnect through Connect (Save & Connect) keeps the
// machine's sync id, so removing it later reaches the account.
func TestConnectKeepsTheSyncIDSoARemovalReachesTheAccount(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	ctx := context.Background()
	mac := device(t, srv)
	m := Machine{Host: "127.0.0.1", Port: 1, User: "root", KeyPath: "/k"}
	if err := mac.SaveMachine(m, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	id := syncIDs(t, mac)["root@127.0.0.1:1"]
	m.Nickname = "box"
	if err := mac.Connect(m, ""); err != nil {
		t.Fatal(err)
	}
	mac.Disconnect()
	if got := syncIDs(t, mac)["root@127.0.0.1:1"]; got != id {
		t.Fatalf("Connect dropped the sync id: %q, want %q", got, id)
	}
	if err := mac.RemoveMachine("root@127.0.0.1:1"); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if live := w.live(); len(live) != 0 {
		t.Fatalf("the removed machine is still in the account: %v", live)
	}
}

// #257 review P2: a fork's higher member also pending delete here makes one
// change, not two (the service refuses a push naming an id twice).
func TestOneChangePerID(t *testing.T) {
	hostA := account.RemoteHost{ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Rev: 1, Body: account.HostBody{Host: "pi", Username: "root"}}
	hostB := account.RemoteHost{ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Rev: 2, Body: account.HostBody{Host: "PI", Username: "root"}}
	mirror := account.Mirror{Rev: 2, Hosts: []account.RemoteHost{hostA, hostB}}
	st := machineStore{Machines: []Machine{{Host: "pi", User: "root", Port: 22, KeyPath: "/k", SyncID: hostA.ID}}}
	changes, _, _, _ := mergeMachines(&st, mirror, mirror, map[string]bool{hostA.ID: true, hostB.ID: true}, []string{hostB.ID}, nil)
	n := 0
	for _, c := range changes {
		if c.ID == hostB.ID {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d changes for %s: %+v", n, hostB.ID, changes)
	}
}

// #257 review P3: a removal whose tombstone can't be kept is refused, so the
// account never keeps a machine this device says it deleted.
func TestARemovalWhoseTombstoneCantBeKeptIsRefused(t *testing.T) {
	quietSync(t)
	_, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The sync state can't be written: its path is a directory.
	if err := os.Remove(mac.syncStatePath()); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(mac.syncStatePath(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mac.syncStatePath(), "x"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := mac.RemoveMachine("root@pi:22"); err == nil {
		t.Fatal("the removal succeeded without its tombstone")
	}
	if _, ok := syncIDs(t, mac)["root@pi:22"]; !ok {
		t.Fatal("the machine was removed though the account would never hear of it")
	}
}

// #257 review round 3: whether a device signs in with a key or a password
// is its own. A password device that changed nothing must not push its
// nickname back over the key device's rename, sync after sync.
func TestADevicesOwnSignInKindIsNotAnEdit(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	ctx := context.Background()
	keyDev, pwDev := device(t, srv), device(t, srv)
	if err := keyDev.SaveMachine(Machine{Nickname: "Old", Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := pwDev.SaveMachine(Machine{Nickname: "Old", Host: "pi", User: "root"}, ""); err != nil { // password here
		t.Fatal(err)
	}
	sync := func(d *Desk) {
		t.Helper()
		if err := d.SyncMachines(ctx); err != nil {
			t.Fatal(err)
		}
	}
	sync(keyDev)
	sync(pwDev)
	if err := keyDev.SaveMachine(Machine{Nickname: "New", Host: "pi", User: "root", KeyPath: "/k"}, "root@pi:22"); err != nil {
		t.Fatal(err)
	}
	sync(keyDev)
	w.mu.Lock()
	writes := w.rev
	w.mu.Unlock()
	for range 3 {
		sync(pwDev)
	}
	live := w.live()
	id := syncIDs(t, keyDev)["root@pi:22"]
	if body := string(live[id].Body); !strings.Contains(body, `"New"`) || !strings.Contains(body, `"key"`) {
		t.Fatalf("account copy after the password device synced: %s; want the key device's rename and auth kind kept", body)
	}
	w.mu.Lock()
	extra := w.rev - writes
	w.mu.Unlock()
	if extra != 0 {
		t.Fatalf("the unchanged password device wrote %d times", extra)
	}
	ms, _ := pwDev.Machines()
	if ms[0].Nickname != "New" || ms[0].KeyPath != "" {
		t.Fatalf("password device: %+v; want the rename taken and no key path", ms[0].Machine)
	}
}

// #257 review round 3: a damaged account-sync.json is an error, never a
// silent restart: no removal, no sync, and the file is left for a look.
func TestADamagedSyncStateStopsRemovalAndSync(t *testing.T) {
	quietSync(t)
	_, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mac.syncStatePath(), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := mac.RemoveMachine("root@pi:22"); err == nil {
		t.Fatal("removed a machine with a damaged sync state")
	}
	if _, ok := syncIDs(t, mac)["root@pi:22"]; !ok {
		t.Fatal("the machine is gone")
	}
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("synced over a damaged sync state")
	}
	if raw, _ := os.ReadFile(mac.syncStatePath()); string(raw) != "{not json" {
		t.Fatalf("the damaged file was replaced: %q", raw)
	}
}

// #257 review round 4: a local edit whose push the service refused stays an
// edit, and the next sync sends it.
func TestARefusedEditIsSentAgain(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	ctx := context.Background()
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Nickname: "Old", Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if err := mac.SaveMachine(Machine{Nickname: "New", Host: "pi", User: "root", KeyPath: "/k"}, "root@pi:22"); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	if err := mac.SyncMachines(ctx); err == nil {
		t.Fatal("a refused push reported success")
	}
	w.mu.Lock()
	w.failPush = false
	w.mu.Unlock()
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	id := syncIDs(t, mac)["root@pi:22"]
	if body := string(w.live()[id].Body); !strings.Contains(body, `"New"`) {
		t.Fatalf("account copy after the retry: %s; want the edit sent", body)
	}
}

// seedPrompt puts a prompt in the account as another device (the Swift
// app) wrote it.
func (w *syncWorker) seedPrompt(id, body string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.rev++
	w.items[id] = account.Item{Collection: "prompts", ID: id, Rev: w.rev, Body: json.RawMessage(body)}
}

func (w *syncWorker) livePrompts() map[string]string {
	out := map[string]string{}
	for id, it := range w.live() {
		if it.Collection == "prompts" {
			out[id] = string(it.Body)
		}
	}
	return out
}

func savePrompt(t *testing.T, d *Desk, id, nickname, text string) SavedPrompt {
	t.Helper()
	list, err := d.SavePrompt(SavedPrompt{ID: id, Nickname: nickname, Text: text})
	if err != nil {
		t.Fatal(err)
	}
	if id == "" {
		return list[len(list)-1]
	}
	i := slices.IndexFunc(list, func(p SavedPrompt) bool { return p.ID == id })
	if i < 0 {
		t.Fatalf("no prompt %s after saving it: %+v", id, list)
	}
	return list[i]
}

func promptsOf(t *testing.T, d *Desk) map[string]SavedPrompt {
	t.Helper()
	list, err := d.SavedPrompts()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]SavedPrompt{}
	for _, p := range list {
		out[p.ID] = p
	}
	return out
}

func syncEach(t *testing.T, ds ...*Desk) {
	t.Helper()
	for _, d := range ds {
		if err := d.SyncMachines(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
}

// Two devices with one account: a prompt saved on each shows on both, an
// edit on one reaches the other, and so does a delete.
func TestPromptsSyncAcrossTwoDevices(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac, linux := device(t, srv), device(t, srv)
	a := savePrompt(t, mac, "", "standup", "What did you do?")
	b := savePrompt(t, linux, "", "", "Run the tests\nthen push")
	syncEach(t, mac, linux, mac)
	for name, d := range map[string]*Desk{"mac": mac, "linux": linux} {
		got := promptsOf(t, d)
		if len(got) != 2 || got[a.ID] != a || got[b.ID] != b {
			t.Fatalf("%s's prompts: %+v; want %+v and %+v", name, got, a, b)
		}
	}
	if live := w.livePrompts(); len(live) != 2 {
		t.Fatalf("the account holds %v; want both prompts", live)
	}

	edited := savePrompt(t, mac, a.ID, "Standup", "What did you do yesterday?")
	if edited.ID != a.ID {
		t.Fatalf("an edit made a new prompt: %+v", edited)
	}
	syncEach(t, mac, linux)
	if got := promptsOf(t, linux)[a.ID]; got != edited {
		t.Fatalf("linux after the mac's edit: %+v; want %+v", got, edited)
	}

	if _, err := linux.DeletePrompt(b.ID); err != nil {
		t.Fatal(err)
	}
	syncEach(t, linux, mac)
	if got := promptsOf(t, mac); len(got) != 1 || got[a.ID] != edited {
		t.Fatalf("mac after linux's delete: %+v; want only %+v", got, edited)
	}
	if _, ok := w.livePrompts()[b.ID]; ok {
		t.Fatal("the account still holds the deleted prompt")
	}
	if raw, _ := os.ReadFile(linux.syncStatePath()); strings.Contains(string(raw), `"promptDeletes"`) {
		t.Fatalf("the pushed delete is still pending: %s", raw)
	}
}

// The owner's case: this device synced machines before prompts synced, has
// its own prompts, and the account already holds the Swift app's. Both
// lists end up on both, the account's after this device's, and the
// device's after the account's last order.
func TestSigningInWithPromptsKeepsTheAccountsToo(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	const phone, phone2 = "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
	w.seedPrompt(phone2, `{"text":"second","order":1}`)
	w.seedPrompt(phone, `{"title":"From the phone","text":"hello","order":0}`)
	mac := device(t, srv)
	// A machines-only sync already ran: its mirror is past the prompts' revisions.
	if err := mac.storeSyncState(syncState{AccountID: "acct", Mirror: account.Mirror{Rev: 2}}); err != nil {
		t.Fatal(err)
	}
	own := savePrompt(t, mac, "", "desk", "from the desktop")
	syncEach(t, mac)
	list, _ := mac.SavedPrompts()
	want := []SavedPrompt{own, {ID: phone, Nickname: "From the phone", Text: "hello"}, {ID: phone2, Text: "second"}}
	if !slices.Equal(list, want) {
		t.Fatalf("mac's prompts: %+v; want %+v", list, want)
	}
	if body := w.livePrompts()[own.ID]; body != `{"title":"desk","text":"from the desktop","order":2}` {
		t.Fatalf("the desktop's prompt in the account: %s", body)
	}
	linux := device(t, srv)
	syncEach(t, linux)
	if got := promptsOf(t, linux); len(got) != 3 || got[own.ID] != own {
		t.Fatalf("another device's prompts: %+v", got)
	}
}

// A prompt travels as title (the nickname trimmed, none when empty), text
// with its line breaks, and order; an edit keeps the account's order.
func TestPromptFieldsRoundTrip(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac, linux := device(t, srv), device(t, srv)
	daily := savePrompt(t, mac, "", "  daily  ", "line one\n\tline two")
	bare := savePrompt(t, mac, "", "", "no title")
	syncEach(t, mac)
	live := w.livePrompts()
	if live[daily.ID] != `{"title":"daily","text":"line one\n\tline two","order":0}` || live[bare.ID] != `{"text":"no title","order":1}` {
		t.Fatalf("the account's copies: %v", live)
	}
	syncEach(t, linux)
	if got := promptsOf(t, linux)[daily.ID]; got.Nickname != "daily" || got.Text != "line one\n\tline two" {
		t.Fatalf("linux's copy: %+v", got)
	}
	savePrompt(t, linux, bare.ID, "titled", "no title, edited")
	syncEach(t, linux)
	if body := w.livePrompts()[bare.ID]; body != `{"title":"titled","text":"no title, edited","order":1}` {
		t.Fatalf("the edited prompt in the account: %s; want its order kept", body)
	}
}

// A prompt the service would refuse (too long, no text) or one past the
// account's cap is not sent, so the rest of the push goes through; it stays
// on this device.
func TestPromptsTheServiceWouldRefuseAreNotSent(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	long := savePrompt(t, mac, "", "", strings.Repeat("x", 8193))
	good := savePrompt(t, mac, "", "", "fits")
	syncEach(t, mac)
	live := w.livePrompts()
	if _, sent := live[long.ID]; sent || live[good.ID] == "" {
		t.Fatalf("the account holds %v; want only the prompt that fits", live)
	}
	if got := promptsOf(t, mac); len(got) != 2 {
		t.Fatalf("mac's prompts after the sync: %+v; want both kept", got)
	}
	empty := SavedPrompt{ID: "00000000-0000-4000-8000-000000000009"}
	if _, changes, _, _ := mergePrompts([]SavedPrompt{empty}, nil, nil, nil, nil, nil); len(changes) != 0 {
		t.Fatalf("an empty prompt was sent: %+v", changes)
	}

	for i := range account.PromptsCap - 1 {
		w.seedPrompt(fmt.Sprintf("00000000-0000-4000-9000-%012d", i), `{"text":"seeded"}`)
	}
	over := savePrompt(t, mac, "", "", "one too many")
	syncEach(t, mac)
	if _, sent := w.livePrompts()[over.ID]; sent || len(w.livePrompts()) != account.PromptsCap {
		t.Fatalf("the account holds %d prompts (the last one sent: %v); want the cap", len(w.livePrompts()), sent)
	}
	if _, kept := promptsOf(t, mac)[over.ID]; !kept {
		t.Fatal("the prompt past the cap was dropped here")
	}
}

// A prompt deleted on another device goes here too, unless it was edited
// here since: then the edit stands and is pushed back.
func TestAPromptEditedHereOutlivesItsRemoteDelete(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac, linux := device(t, srv), device(t, srv)
	kept := savePrompt(t, mac, "", "", "keep me")
	gone := savePrompt(t, mac, "", "", "drop me")
	syncEach(t, mac, linux)
	for _, id := range []string{kept.ID, gone.ID} {
		if _, err := linux.DeletePrompt(id); err != nil {
			t.Fatal(err)
		}
	}
	syncEach(t, linux)
	edited := savePrompt(t, mac, kept.ID, "", "keep me, edited")
	syncEach(t, mac)
	if got := promptsOf(t, mac); len(got) != 1 || got[kept.ID] != edited {
		t.Fatalf("mac's prompts: %+v; want only the edited one", got)
	}
	if body := w.livePrompts()[kept.ID]; !strings.Contains(body, "keep me, edited") {
		t.Fatalf("the account's copy: %q; want the edit pushed back", body)
	}
}

// The account page's status: what the account held at the newest good
// sync of the signed-in account, under its JSON names; Sync now runs one
// and tells the page.
func TestAccountSyncStatusAndSyncNow(t *testing.T) {
	quietSync(t)
	var published []AccountState
	previous := publishAccount
	publishAccount = func(s AccountState) { published = append(published, s) }
	t.Cleanup(func() { publishAccount = previous })
	_, srv := newWorker(t, "")
	mac := device(t, srv)
	if s, err := mac.AccountSyncStatus(); err != nil || s != (AccountSyncStatus{}) {
		t.Fatalf("before any sync: %+v, %v", s, err)
	}
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	first := savePrompt(t, mac, "", "", "one")
	savePrompt(t, mac, "", "", "two")
	start := time.Now().UnixMilli()
	if err := mac.AccountSyncNow(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(published) != 1 || !published[0].SignedIn {
		t.Fatalf("published %+v; want the account state once", published)
	}
	// A delete not yet synced: the status is still the account's.
	if _, err := mac.DeletePrompt(first.ID); err != nil {
		t.Fatal(err)
	}
	s, err := mac.AccountSyncStatus()
	if err != nil || s.LastSyncedMs < start || s.LastSyncedMs > time.Now().UnixMilli() || s.Machines != 1 || s.Prompts != 2 {
		t.Fatalf("after the sync: %+v, %v", s, err)
	}
	raw, _ := json.Marshal(s)
	if want := fmt.Sprintf(`{"lastSyncedMs":%d,"machines":1,"prompts":2}`, s.LastSyncedMs); string(raw) != want {
		t.Fatalf("status JSON %s; want %s", raw, want)
	}
	signInTo(mac, srv, "other")
	if s, _ := mac.AccountSyncStatus(); s != (AccountSyncStatus{}) {
		t.Fatalf("another account's status: %+v", s)
	}
}
