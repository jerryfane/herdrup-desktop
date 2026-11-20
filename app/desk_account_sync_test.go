package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/account"
)

// syncWorker is the account service's sync as AccountService src/sync.ts
// keeps it: one revision per write, last write wins, tombstones for deletes,
// and the hosts allowlist (any other field is a 400).
type syncWorker struct {
	mu      sync.Mutex
	rev     int64
	items   map[string]account.Item
	n       int
	account string // "acct" when empty
	// failPush answers the next pushes 503 (the service down mid-sync).
	failPush bool
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
			if c.Body != nil {
				var fields map[string]any
				_ = json.Unmarshal(c.Body, &fields)
				for k := range fields {
					switch k {
					case "nickname", "host", "port", "username", "auth_kind", "label":
					default:
						reply(400, map[string]string{"error": "invalid_item"})
						return
					}
				}
			}
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
	previous, background := publishSyncedMachines, backgroundMachineSync
	publishSyncedMachines, backgroundMachineSync = func([]SyncedMachine) {}, false
	t.Cleanup(func() { publishSyncedMachines, backgroundMachineSync = previous, background })
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
	changes, _, _ := mergeMachines(&st, mirror, mirror, map[string]bool{hostA.ID: true, hostB.ID: true}, []string{hostB.ID})
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
