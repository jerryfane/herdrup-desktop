package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/account"
)

// deviceWorker is AccountService's devices (src/devices.ts) for one
// account: a challenge per enrolment, a device per key (the same key binds
// this session to its device), 20 at most, and a removed device's session
// ending with it.
type deviceWorker struct {
	mu       sync.Mutex
	devices  []account.Device
	bound    string // the session's device id
	refuse   string // the next enrolment's refusal code
	n        int
	signedIn bool
}

func (w *deviceWorker) serve(rw http.ResponseWriter, r *http.Request) {
	w.mu.Lock()
	defer w.mu.Unlock()
	reply := func(status int, v any) {
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(status)
		if v != nil {
			_ = json.NewEncoder(rw).Encode(v)
		}
	}
	if r.URL.Path != "/v1/auth/refresh" && !w.signedIn {
		reply(401, map[string]string{"error": "session_revoked"})
		return
	}
	var body map[string]string
	_ = json.NewDecoder(r.Body).Decode(&body)
	list := func() []account.Device {
		out := []account.Device{}
		for _, d := range w.devices {
			d.Current = d.ID == w.bound
			out = append(out, d)
		}
		return out
	}
	switch {
	case r.URL.Path == "/v1/auth/refresh":
		if !w.signedIn {
			reply(401, map[string]string{"error": "session_revoked"})
			return
		}
		w.n++
		reply(200, map[string]any{"account_id": "acct", "access_token": fmt.Sprintf("a1.%022d.%043d", 1, w.n), "access_expires_in": 3600,
			"refresh_token": fmt.Sprintf("r1.%022d.%043d", 1, w.n), "refresh_expires_in": 1})
	case r.URL.Path == "/v1/auth/signout":
		w.signedIn = false
		reply(204, nil)
	case r.URL.Path == "/v1/devices/challenge":
		reply(200, map[string]any{"challenge_id": "CCCCCCCCCCCCCCCCCCCCCC", "server_pub": "3p7bfXt9wbTTW2HC7OQ1Nz-DQ8hbeGdNrfx-FG-IK08", "salt": "ERERERERERERERERERERERERERERERERERERERERERE", "account_id": "acct", "expires_in": 60})
	case r.URL.Path == "/v1/devices" && r.Method == http.MethodPost:
		if w.refuse != "" {
			code := w.refuse
			w.refuse = ""
			status := 409
			if code == "too_many_devices" {
				status = 403
			}
			reply(status, map[string]string{"error": code})
			return
		}
		for _, d := range w.devices {
			if d.DevicePub == body["device_pub"] {
				w.bound = d.ID
				d.Current = true
				reply(200, map[string]any{"device": d})
				return
			}
		}
		d := account.Device{ID: fmt.Sprintf("d%d", len(w.devices)+1), Name: body["name"], Platform: body["platform"], DevicePub: body["device_pub"], CreatedMs: int64(100 + len(w.devices))}
		w.devices = append(w.devices, d)
		w.bound = d.ID
		d.Current = true
		reply(201, map[string]any{"device": d})
	case r.URL.Path == "/v1/devices" && r.Method == http.MethodGet:
		reply(200, map[string]any{"devices": list()})
	case strings.HasPrefix(r.URL.Path, "/v1/devices/"):
		id := strings.TrimPrefix(r.URL.Path, "/v1/devices/")
		for i, d := range w.devices {
			if d.ID != id {
				continue
			}
			if r.Method == http.MethodPatch {
				w.devices[i].Name = body["name"]
				reply(200, map[string]any{"device": w.devices[i]})
				return
			}
			w.devices = append(w.devices[:i], w.devices[i+1:]...)
			if id == w.bound {
				w.bound, w.signedIn = "", false
			}
			reply(204, nil)
			return
		}
		reply(404, map[string]string{"error": "not_found"})
	default:
		reply(404, map[string]string{"error": "not_found"})
	}
}

func deviceDesk(t *testing.T) (*Desk, *deviceWorker) {
	t.Helper()
	w := &deviceWorker{signedIn: true, devices: []account.Device{{ID: "d0", Name: "Jerry's iPhone", Platform: "ios", DevicePub: "other", CreatedMs: 50}}}
	srv := httptest.NewServer(http.HandlerFunc(w.serve))
	t.Cleanup(srv.Close)
	d := newDesk(t.TempDir())
	signInTo(d, srv, "acct")
	previous := publishAccount
	publishAccount = func(AccountState) {}
	t.Cleanup(func() { publishAccount = previous })
	name := hostDisplayName
	hostDisplayName = func() string { return "jerrys-laptop.local" }
	t.Cleanup(func() { hostDisplayName = name })
	return d, w
}

// This computer joins the account as a device (its guest key, named after
// the computer), lists first, renames, and enrolling again is the same
// device, not a second one.
func TestThisComputerJoinsTheAccountsDevices(t *testing.T) {
	d, w := deviceDesk(t)
	ctx := context.Background()
	if err := d.enrolThisDevice(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := d.AccountDevices(ctx)
	if err != nil || len(got.Devices) != 2 || !got.Devices[0].Current || got.Devices[0].Name != "jerrys-laptop" || got.Devices[0].Platform != accountPlatform(runtime.GOOS) || got.Enrolment != "" {
		t.Fatalf("devices: %+v, %v", got, err)
	}
	identity, _ := d.guestIdentity()
	w.mu.Lock()
	pub := w.devices[1].DevicePub
	w.mu.Unlock()
	if want := base64.RawURLEncoding.EncodeToString(identity.PublicKey()); pub != want {
		t.Fatalf("enrolled key %s; want the guest identity %s", pub, want)
	}
	if err := d.enrolThisDevice(ctx); err != nil {
		t.Fatal(err)
	}
	if err := d.AccountRenameDevice(ctx, got.Devices[0].ID, "  Studio\n"); err != nil {
		t.Fatal(err)
	}
	again, _ := d.AccountDevices(ctx)
	if len(again.Devices) != 2 || again.Devices[0].Name != "Studio" {
		t.Fatalf("after a second enrolment and a rename: %+v", again)
	}
}

// A device list without this computer adds it; a refusal is kept for the
// page (and not retried on every look) until Try again.
func TestARefusedEnrolmentIsShownUntilTryAgain(t *testing.T) {
	d, w := deviceDesk(t)
	ctx := context.Background()
	w.mu.Lock()
	w.refuse = "too_many_devices"
	w.mu.Unlock()
	got, err := d.AccountDevices(ctx)
	if err != nil || got.Enrolment != "too_many_devices" || len(got.Devices) != 1 {
		t.Fatalf("refused: %+v, %v", got, err)
	}
	if again, _ := d.AccountDevices(ctx); again.Enrolment != "too_many_devices" {
		t.Fatalf("the refusal was retried or lost: %+v", again)
	}
	got, err = d.AccountEnrolAgain(ctx)
	if err != nil || got.Enrolment != "" || len(got.Devices) != 2 || !got.Devices[0].Current {
		t.Fatalf("try again: %+v, %v", got, err)
	}
}

// Removing another device keeps this session; removing this computer ends
// it here too.
func TestRemovingThisComputerSignsItOut(t *testing.T) {
	d, _ := deviceDesk(t)
	ctx := context.Background()
	if err := d.enrolThisDevice(ctx); err != nil {
		t.Fatal(err)
	}
	if err := d.AccountRemoveDevice(ctx, "d0", false); err != nil || !d.AccountState().SignedIn {
		t.Fatalf("remove another device: %v, %+v", err, d.AccountState())
	}
	list, _ := d.AccountDevices(ctx)
	if len(list.Devices) != 1 {
		t.Fatalf("after removing the phone: %+v", list)
	}
	if err := d.AccountRemoveDevice(ctx, list.Devices[0].ID, true); err != nil {
		t.Fatal(err)
	}
	if d.AccountState().SignedIn {
		t.Fatal("still signed in after removing this computer")
	}
}
