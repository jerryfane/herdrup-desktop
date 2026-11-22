package fakeherdr

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// OwnerAccess serves herdr #491's owner_access.* (web owner access): info,
// list, add, renew and remove, with herdr's checks on add (ttl range, scope,
// a statement, unpadded keys) and its refusal of unknown params such as
// machine. It never contacts a relay; grants live in memory.
type OwnerAccess struct {
	mu     sync.Mutex
	HostID string
	Relay  string
	grants []map[string]any
	next   int
	// Statements are the account statements add received, in order (herdr
	// checks aud == HostID; tests check which one the client sent).
	Statements []string
}

// NewOwnerAccess serves a machine on relay with a fixed relay id.
func NewOwnerAccess(relay string) *OwnerAccess {
	return &OwnerAccess{HostID: base64.RawURLEncoding.EncodeToString([]byte("fake-host-id-016")), Relay: relay}
}

func ownerRefuse(code, msg string) *APIError { return &APIError{Code: code, Message: msg} }

// closedParams decodes params into dst and refuses fields dst doesn't name
// (herdr's additionalProperties: false).
func closedParams(raw json.RawMessage, allowed ...string) (map[string]any, *APIError) {
	var p map[string]any
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, ownerRefuse("invalid_params", err.Error())
		}
	}
	ok := map[string]bool{}
	for _, a := range allowed {
		ok[a] = true
	}
	for k := range p {
		if !ok[k] {
			return nil, ownerRefuse("invalid_params", "unknown field `"+k+"`")
		}
	}
	return p, nil
}

// Handle answers owner_access.*; handled is false for other methods.
func (o *OwnerAccess) Handle(method string, raw json.RawMessage) (any, *APIError, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	switch method {
	case "owner_access.info":
		if _, e := closedParams(raw); e != nil {
			return nil, e, true
		}
		return map[string]any{"type": "owner_access_info", "protocol": 1, "host_id": o.HostID,
			"node_pub": base64.RawURLEncoding.EncodeToString(sha256.New().Sum(nil)), "relay_url": o.Relay,
			"link": map[string]any{"state": "idle"}, "max_ttl_secs": 2592000, "scopes": []string{"chat", "terminal"}, "version": "0.9.5-fake"}, nil, true
	case "owner_access.list":
		if _, e := closedParams(raw); e != nil {
			return nil, e, true
		}
		return map[string]any{"type": "owner_access_list", "grants": o.grants}, nil, true
	case "owner_access.add":
		p, e := closedParams(raw, "device_pub", "device_name", "scope", "ttl_secs", "account_statement", "approved_by")
		if e != nil {
			return nil, e, true
		}
		ttl, _ := p["ttl_secs"].(float64)
		if ttl < 3600 || ttl > 2592000 {
			return nil, ownerRefuse("owner_ttl_invalid", "ttl_secs must be 3600 to 2592000"), true
		}
		pub, _ := p["device_pub"].(string)
		if key, err := base64.RawURLEncoding.Strict().DecodeString(pub); err != nil || len(key) != 32 {
			return nil, ownerRefuse("invalid_params", "device_pub must be unpadded base64url of 32 bytes"), true
		}
		st, _ := p["account_statement"].(string)
		if st == "" {
			return nil, ownerRefuse("account_statement_invalid", "a statement is required"), true
		}
		o.Statements = append(o.Statements, st)
		scope, _ := p["scope"].(string)
		if scope == "" {
			scope = "terminal"
		}
		if scope != "chat" && scope != "terminal" {
			return nil, ownerRefuse("invalid_params", "scope must be chat or terminal"), true
		}
		var replaced []string
		for _, g := range o.grants {
			if g["device_pub"] == pub && g["revoked"] == false {
				g["revoked"] = true
				replaced = append(replaced, g["grant_id"].(string))
			}
		}
		o.next++
		now := uint64(time.Now().UnixMilli())
		sum := sha256.Sum256([]byte(pub))
		g := map[string]any{"grant_id": fmt.Sprintf("grant-%d", o.next), "device_pub": pub,
			"fingerprint": "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:8]), "device": p["device_name"], "scope": scope,
			"approved_by": p["approved_by"], "created_ms": now, "expires_ms": now + uint64(ttl)*1000, "revoked": false}
		o.grants = append(o.grants, g)
		if replaced == nil {
			replaced = []string{}
		}
		return map[string]any{"type": "owner_access_added", "grant": g, "replaced": replaced}, nil, true
	case "owner_access.remove":
		p, e := closedParams(raw, "grant_id", "device_pub", "fingerprint")
		if e != nil {
			return nil, e, true
		}
		removed := []string{}
		for _, g := range o.grants {
			for k, v := range p {
				if g[k] == v && g["revoked"] == false {
					g["revoked"] = true
					removed = append(removed, g["grant_id"].(string))
				}
			}
		}
		return map[string]any{"type": "owner_access_removed", "removed": removed}, nil, true
	}
	return nil, nil, false
}
