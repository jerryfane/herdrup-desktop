package fakeherdr

import (
	"encoding/json"
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

func NewGuests() *Guests {
	now := time.Now().UnixMilli()
	localGrant := map[string]any{"terminal_id": "w1:p2", "agent_name": "Native smoke agent"}
	peerGrant := map[string]any{"terminal_id": "w1:p1", "agent_name": "Render agent"}
	return &Guests{stores: map[string]*guestStore{
		"": {
			guests: []map[string]any{
				{"guest_id": "guest-1", "name": "Alex", "grant": localGrant, "created_ms": now - 600000, "last_seen_ms": now - 30000, "fingerprint": "SHA256:fixture-alex", "device": "Laptop", "revoked": false, "share_gram": false},
				{"guest_id": "revoked-guest", "name": "Old guest", "grant": localGrant, "created_ms": now - 900000, "fingerprint": "SHA256:fixture-revoked", "revoked": true},
			},
			invites: []map[string]any{
				{"invite_id": "invite-1", "name": "Taylor", "grant": localGrant, "created_ms": now - 60000, "expires_ms": now + 3600000, "owner_name": "Owner", "machine_label": "Home box", "share_gram": false},
				{"invite_id": "used-invite", "name": "Alex", "grant": localGrant, "created_ms": now - 900000, "expires_ms": now + 3600000, "owner_name": "Owner", "machine_label": "Home box", "used_by": "guest-1"},
				{"invite_id": "expired-invite", "name": "Expired invite", "grant": localGrant, "created_ms": now - 900000, "expires_ms": now - 1, "owner_name": "Owner", "machine_label": "Home box"},
			},
			entries: []map[string]any{
				{"event": "prompt", "guest_id": "guest-1", "name": "Alex", "pane": "w1:p2", "ts_ms": now - 20000, "fingerprint": "SHA256:fixture-alex", "text": "Please explain the changes before running them."},
				{"event": "upload", "guest_id": "guest-1", "name": "Alex", "pane": "w1:p2", "ts_ms": now - 40000, "fingerprint": "SHA256:fixture-alex", "file": map[string]any{"name": "review-notes.txt", "size": 2048, "sha256": "fixture"}},
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
	case "guest.list", "guest.audit", "guest.update", "guest.revoke":
	default:
		return nil, nil, false
	}
	var p struct {
		Machine   string `json:"machine"`
		GuestID   string `json:"guest_id"`
		InviteID  string `json:"invite_id"`
		ShareGram bool   `json:"share_gram"`
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
	missing := func() (any, *APIError, bool) {
		return nil, &APIError{Code: "not_found", Message: "guest or invite not found on this machine"}, true
	}
	switch method {
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
		if p.GuestID != "" {
			for _, guest := range store.guests {
				if guest["guest_id"] != p.GuestID {
					continue
				}
				guest["revoked"] = true
				store.entries = append(store.entries, map[string]any{"event": "revoked", "guest_id": p.GuestID, "name": guest["name"], "ts_ms": time.Now().UnixMilli(), "fingerprint": guest["fingerprint"]})
				return snapshot(map[string]any{"type": "guest_revoked", "guest_id": p.GuestID, "closed_streams": 0})
			}
		} else {
			for _, invite := range store.invites {
				if invite["invite_id"] == p.InviteID {
					invite["expires_ms"] = int64(0)
					return snapshot(map[string]any{"type": "guest_revoked", "invite_id": p.InviteID, "closed_streams": 0})
				}
			}
		}
	}
	return missing()
}
