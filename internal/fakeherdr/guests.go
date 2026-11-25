package fakeherdr

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// Guests exercises independently routed guest stores without creating a real
// relay, invitation credential or permission grant.
type Guests struct {
	mu     sync.Mutex
	stores map[string]*guestStore
}
type guestStore struct {
	guests  []map[string]any
	invites []map[string]any
	entries []map[string]any
	link    map[string]any
}

// NewGuests is two machines' guest stores. This machine's ("") is a current
// herdr's: each guest names its person, Nike's two shares are bound to her
// HerdrUp account with devices she added, Alex's is a plain share. The
// peer's is an older herdr's: no person, no devices.
func NewGuests() *Guests {
	now := time.Now().UnixMilli()
	localGrant := map[string]any{"terminal_id": "w1:p2", "agent_name": "Native smoke agent"}
	peerGrant := map[string]any{"terminal_id": "w1:p1", "agent_name": "Render agent"}
	nikeDevices := func() []map[string]any {
		return []map[string]any{
			{"fingerprint": "SHA256:fixture-nike-mac", "device": "MacBook", "added_ms": now - 500000, "last_seen_ms": now - 7200000, "removed": false},
			{"fingerprint": "SHA256:fixture-nike-web", "device": "Chrome on macOS", "added_ms": now - 400000, "last_seen_ms": now - 86400000, "removed": false},
		}
	}
	return &Guests{stores: map[string]*guestStore{
		"": {
			guests: []map[string]any{
				{"guest_id": "guest-1", "name": "Alex", "grant": localGrant, "created_ms": now - 600000, "last_seen_ms": now - 30000, "fingerprint": "SHA256:fixture-alex", "device": "Laptop", "revoked": false, "share_gram": false, "person": "SHA256:fixture-alex", "account_bound": false, "devices": []any{}},
				{"guest_id": "revoked-guest", "name": "Old guest", "grant": localGrant, "created_ms": now - 900000, "fingerprint": "SHA256:fixture-revoked", "revoked": true, "person": "SHA256:fixture-revoked", "account_bound": false, "devices": []any{}},
				{"guest_id": "nike-1", "name": "Nike", "grant": map[string]any{"terminal_id": "w1:p3", "agent_name": "enyo"}, "created_ms": now - 800000, "last_seen_ms": now - 60000, "fingerprint": "SHA256:fixture-nike-phone", "device": "iPhone", "revoked": false, "share_gram": true, "person": "acct-nike", "account_bound": true, "devices": nikeDevices()},
				{"guest_id": "nike-2", "name": "Nike", "grant": map[string]any{"terminal_id": "w1:p4", "agent_name": "orgstudio"}, "created_ms": now - 700000, "last_seen_ms": now - 3600000, "fingerprint": "SHA256:fixture-nike-phone", "device": "iPhone", "revoked": false, "share_gram": false, "person": "acct-nike", "account_bound": true, "devices": nikeDevices()},
			},
			invites: []map[string]any{
				{"invite_id": "invite-1", "name": "Taylor", "grant": localGrant, "created_ms": now - 60000, "expires_ms": now + 3600000, "owner_name": "Owner", "machine_label": "Home box", "share_gram": false},
				{"invite_id": "used-invite", "name": "Alex", "grant": localGrant, "created_ms": now - 900000, "expires_ms": now + 3600000, "owner_name": "Owner", "machine_label": "Home box", "used_by": "guest-1"},
				{"invite_id": "expired-invite", "name": "Expired invite", "grant": localGrant, "created_ms": now - 900000, "expires_ms": now - 1, "owner_name": "Owner", "machine_label": "Home box"},
			},
			entries: []map[string]any{
				{"event": "prompt", "guest_id": "guest-1", "name": "Alex", "pane": "w1:p2", "ts_ms": now - 20000, "fingerprint": "SHA256:fixture-alex", "text": "Please explain the changes before running them."},
				{"event": "upload", "guest_id": "guest-1", "name": "Alex", "pane": "w1:p2", "ts_ms": now - 40000, "fingerprint": "SHA256:fixture-alex", "file": map[string]any{"name": "review-notes.txt", "size": 2048, "sha256": "fixture"}},
				{"event": "device_added", "guest_id": "nike-1", "name": "Nike", "pane": "w1:p3", "ts_ms": now - 400000, "fingerprint": "SHA256:fixture-nike-web", "text": "Chrome on macOS"},
			},
			link: map[string]any{"state": "up"},
		},
		"11111111111111111111111111111111": {
			guests:  []map[string]any{{"guest_id": "guest-1", "name": "Sam", "grant": peerGrant, "created_ms": now - 600000, "last_seen_ms": now - 900000, "fingerprint": "SHA256:fixture-sam", "device": "Tablet", "revoked": false, "share_gram": true}},
			invites: []map[string]any{{"invite_id": "invite-1", "name": "Riley", "grant": peerGrant, "created_ms": now - 90000, "expires_ms": now + 7200000, "owner_name": "Owner", "machine_label": "render-box", "share_gram": true}},
			entries: []map[string]any{{"event": "connected", "guest_id": "guest-1", "name": "Sam", "pane": "w1:p1", "ts_ms": now - 900000, "fingerprint": "SHA256:fixture-sam"}},
			link:    map[string]any{"state": "retrying", "last_error": "Isolated fixture reconnecting"},
		},
	}}
}

func (x *Guests) Handle(method string, raw json.RawMessage) (any, *APIError, bool) {
	switch method {
	case "guest.invite.create", "guest.list", "guest.audit", "guest.update", "guest.revoke", "guest.remove_device":
	default:
		return nil, nil, false
	}
	var p struct {
		Machine      string `json:"machine"`
		GuestID      string `json:"guest_id"`
		InviteID     string `json:"invite_id"`
		Person       string `json:"person"`
		Fingerprint  string `json:"fingerprint"`
		ShareGram    bool   `json:"share_gram"`
		Target       string `json:"target"`
		Name         string `json:"name"`
		OwnerName    string `json:"owner_name"`
		MachineLabel string `json:"machine_label"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &APIError{Code: "invalid_request", Message: err.Error()}, true
	}
	// An update deliberately crosses UI turns, so rapid switch changes exercise
	// the app's latest-choice sender rather than an instant mock echo.
	if method == "guest.update" {
		time.Sleep(350 * time.Millisecond)
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	if p.Machine == "44444444444444444444444444444444" {
		return nil, &APIError{Code: "permission_denied", Message: "Isolated peer guest store is unavailable"}, true
	}
	store := x.stores[p.Machine]
	if store == nil {
		return nil, &APIError{Code: "unsupported", Message: "guest administration is not available on this fixture peer"}, true
	}
	snapshot := func(value any) (any, *APIError, bool) {
		data, _ := json.Marshal(value)
		return json.RawMessage(data), nil, true
	}
	// herdr guest_owner.rs: no guest, invite or person with that id (or no
	// active guest, for guest.update and guest.remove_device).
	missing := func() (any, *APIError, bool) {
		return nil, &APIError{Code: "guest_not_found", Message: "no guest, invite or person with that id"}, true
	}
	switch method {
	case "guest.invite.create":
		if p.Target == "" || p.Name == "" || p.OwnerName == "" {
			return nil, &APIError{Code: "invalid_params", Message: "target, guest name and owner name are required"}, true
		}
		now := time.Now().UnixMilli()
		id := fmt.Sprintf("created-%d", len(store.invites)+1)
		invite := map[string]any{"invite_id": id, "name": p.Name, "owner_name": p.OwnerName, "machine_label": p.MachineLabel,
			"created_ms": now, "expires_ms": now + 86400000, "share_gram": p.ShareGram,
			"grant": map[string]any{"terminal_id": p.Target, "agent_name": p.Target}}
		store.invites = append(store.invites, invite)
		// Deliberately non-credential payload; exercises local QR/copy only.
		return snapshot(map[string]any{"type": "guest_invite_created", "invite": invite,
			"url": "herdrup://guest-invite#fixture-" + id, "web_url": "https://example.invalid/i#fixture-" + id})
	case "guest.list":
		return snapshot(map[string]any{"type": "guest_list", "guests": store.guests, "invites": store.invites, "link": store.link})
	case "guest.audit":
		return snapshot(map[string]any{"type": "guest_audit", "entries": store.entries})
	case "guest.update":
		for _, guest := range store.guests {
			if guest["guest_id"] != p.GuestID {
				continue
			}
			if guest["revoked"] == true {
				return nil, &APIError{Code: "permission_denied", Message: "guest access was revoked"}, true
			}
			guest["share_gram"] = p.ShareGram
			return snapshot(map[string]any{"type": "guest_updated", "guest": guest})
		}
	case "guest.revoke":
		// herdr store.rs revoke_in and mod.rs revoke_at: a known guest is
		// revoked (again) and audited each time; a person's shares already
		// revoked are a success that audits nothing; only an unknown one is
		// not found.
		if p.GuestID != "" {
			for _, guest := range store.guests {
				if guest["guest_id"] != p.GuestID {
					continue
				}
				guest["revoked"] = true
				store.entries = append(store.entries, map[string]any{"event": "revoked", "guest_id": p.GuestID, "name": guest["name"], "ts_ms": time.Now().UnixMilli(), "fingerprint": guest["fingerprint"]})
				return snapshot(map[string]any{"type": "guest_revoked", "guest_id": p.GuestID, "closed_streams": 0})
			}
		} else if p.Person != "" {
			known := false
			for _, guest := range store.guests {
				if guest["person"] != p.Person {
					continue
				}
				known = true
				if guest["revoked"] != true {
					guest["revoked"] = true
					store.entries = append(store.entries, map[string]any{"event": "revoked", "guest_id": guest["guest_id"], "name": guest["name"], "ts_ms": time.Now().UnixMilli(), "fingerprint": guest["fingerprint"]})
				}
			}
			if known {
				return snapshot(map[string]any{"type": "guest_revoked", "person": p.Person, "closed_streams": 0})
			}
		} else {
			for _, invite := range store.invites {
				if invite["invite_id"] == p.InviteID {
					invite["expires_ms"] = int64(0)
					return snapshot(map[string]any{"type": "guest_revoked", "invite_id": p.InviteID, "closed_streams": 0})
				}
			}
		}
	case "guest.remove_device":
		// herdr store.rs remove_device_in: an added device, or the accepting
		// one (then kept as a removed entry); refused for a plain share.
		for _, guest := range store.guests {
			if guest["guest_id"] != p.GuestID || guest["revoked"] == true {
				continue
			}
			if guest["account_bound"] != true {
				return nil, &APIError{Code: "guest_not_account_bound", Message: "this share is bound to one device; revoke the guest instead"}, true
			}
			devices, _ := guest["devices"].([]map[string]any)
			found := false
			for _, device := range devices {
				if device["fingerprint"] != p.Fingerprint {
					continue
				}
				if device["removed"] == true {
					// Removed before: success again, no audit entry (remove_device_at).
					return snapshot(map[string]any{"type": "guest_device_removed", "guest": guest, "closed_streams": 0})
				}
				device["removed"], found = true, true
			}
			if !found && guest["fingerprint"] == p.Fingerprint {
				guest["devices"] = append(devices, map[string]any{"fingerprint": p.Fingerprint, "device": guest["device"], "added_ms": guest["created_ms"], "removed": true})
				found = true
			}
			if !found {
				return nil, &APIError{Code: "guest_device_not_found", Message: "this guest has no device with that fingerprint"}, true
			}
			store.entries = append(store.entries, map[string]any{"event": "device_removed", "guest_id": p.GuestID, "name": guest["name"], "ts_ms": time.Now().UnixMilli(), "fingerprint": p.Fingerprint})
			return snapshot(map[string]any{"type": "guest_device_removed", "guest": guest, "closed_streams": 0})
		}
	}
	return missing()
}
