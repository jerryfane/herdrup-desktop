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
	mu    sync.Mutex
	rev   int64
	items map[string]account.Item
	n     int
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
		reply(200, map[string]any{"account_id": "acct", "access_token": fmt.Sprintf("a1.%022d.%043d", 1, w.n), "access_expires_in": 3600,
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
	raw, _ := json.Marshal(map[string]string{"refresh_token": fmt.Sprintf("r1.%022d.%043d", 1, 0), "account_id": "acct"})
	d.account = account.New(srv.URL, "linux", &signedInStore{raw: raw}, srv.Client())
	d.accountStore = account.NewSecretsStore(noSecrets{}, errors.New("not found"))
	return d
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
	previous, background := publishSyncedMachines, backgroundMachineSync
	publishSyncedMachines, backgroundMachineSync = func([]SyncedMachine) {}, false
	t.Cleanup(func() { publishSyncedMachines, backgroundMachineSync = previous, background })

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
