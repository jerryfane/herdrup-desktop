package fakeherdr_test

import (
	"encoding/json"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// The fixture answers repeats as pinned herdr does (store.rs revoke_in,
// remove_device_in; mod.rs revoke_at, remove_device_at): a guest revoked
// again is audited again; a person whose shares are all revoked, and a device
// removed again, succeed without an entry; unknown targets are not found.
func TestGuestsAnswerRepeatsAsHerdr(t *testing.T) {
	g := fakeherdr.NewGuests()
	call := func(method, params string) (map[string]any, *fakeherdr.APIError) {
		t.Helper()
		value, apiErr, handled := g.Handle(method, json.RawMessage(params))
		if !handled {
			t.Fatalf("%s not handled", method)
		}
		if apiErr != nil {
			return nil, apiErr
		}
		var out map[string]any
		if err := json.Unmarshal(value.(json.RawMessage), &out); err != nil {
			t.Fatal(err)
		}
		return out, nil
	}
	entries := func(event string) int {
		t.Helper()
		audit, _ := call("guest.audit", `{}`)
		n := 0
		for _, e := range audit["entries"].([]any) {
			if e.(map[string]any)["event"] == event {
				n++
			}
		}
		return n
	}
	for range 2 {
		if _, err := call("guest.revoke", `{"guest_id":"guest-1"}`); err != nil {
			t.Fatalf("revoking guest-1: %+v", err)
		}
	}
	if n := entries("revoked"); n != 2 {
		t.Fatalf("a guest revoked twice: %d revoked entries, want 2", n)
	}
	for range 2 {
		if _, err := call("guest.remove_device", `{"guest_id":"nike-1","fingerprint":"SHA256:fixture-nike-mac"}`); err != nil {
			t.Fatalf("removing the MacBook: %+v", err)
		}
	}
	if n := entries("device_removed"); n != 1 {
		t.Fatalf("a device removed twice: %d entries, want 1", n)
	}
	for range 2 {
		if _, err := call("guest.revoke", `{"person":"acct-nike"}`); err != nil {
			t.Fatalf("revoking Nike: %+v", err)
		}
	}
	if n := entries("revoked"); n != 4 {
		t.Fatalf("Nike's two shares revoked, then again: %d revoked entries, want 4", n)
	}
	for _, unknown := range []string{`{"guest_id":"nobody"}`, `{"person":"acct-nobody"}`, `{"invite_id":"nothing"}`} {
		if _, err := call("guest.revoke", unknown); err == nil || err.Code != "guest_not_found" {
			t.Fatalf("revoking %s: %+v", unknown, err)
		}
	}
	if _, err := call("guest.remove_device", `{"guest_id":"nike-1","fingerprint":"SHA256:fixture-nike-web"}`); err == nil || err.Code != "guest_not_found" {
		t.Fatalf("removing a device from a revoked share: %+v", err)
	}
}
