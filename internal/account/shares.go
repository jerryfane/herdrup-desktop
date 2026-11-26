package account

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ShareBody is a shares item (§5.1, AccountService src/sync.ts SCHEMAS.shares):
// a guest grant bound to the account, by item id "<host_id>/<guest_id>".
// Nothing secret travels: the relay's base URL, the host's id and public
// key, the grant's id and its labels.
type ShareBody struct {
	Relay        string `json:"relay"`
	HostID       string `json:"host_id"`
	NodePub      string `json:"node_pub"`
	GuestID      string `json:"guest_id"`
	AgentName    string `json:"agent_name,omitempty"`
	OwnerName    string `json:"owner_name,omitempty"`
	MachineLabel string `json:"machine_label,omitempty"`
	ShareGram    *bool  `json:"share_gram,omitempty"`
}

// The shares collection's text limits (AccountService src/sync.ts:219-235),
// in code points as its text() counts them (Array.from, :90-97), not
// graphemes as an invitation's labels are checked: a label within the
// guest's limit can be over the service's.
const (
	maxShareAgent   = 128
	maxShareOwner   = 64
	maxShareMachine = 128
	maxShareRelay   = 256
)

// ShareID is the shares item id of a grant: its host id and guest id, each
// 16 bytes in unpadded base64url.
func ShareID(hostID, guestID string) string { return hostID + "/" + guestID }

// NewShareBody is the shares item of a bound grant, from its relay (any
// spelling the relay check takes, stored canonical), host id and guest id
// (unpadded base64url, 16 bytes), the host's public key and the grant's
// labels. A label the service would refuse is left out (each is
// optional); ok is false when a required field doesn't fit.
func NewShareBody(relay, hostID string, nodePub []byte, guestID, agentName, ownerName, machineLabel string) (ShareBody, bool) {
	relay, ok := ShareRelay(relay)
	if !ok || !b64url16(hostID) || !b64url16(guestID) || len(nodePub) != 32 {
		return ShareBody{}, false
	}
	return ShareBody{Relay: relay, HostID: hostID, NodePub: base64.RawURLEncoding.EncodeToString(nodePub), GuestID: guestID,
		AgentName: shareText(agentName, maxShareAgent), OwnerName: shareText(ownerName, maxShareOwner), MachineLabel: shareText(machineLabel, maxShareMachine)}, true
}

// ShareRelay is a relay base URL in the form the service stores (sync.ts
// relayUrl): origin and path without a trailing slash, http(s), no
// credentials, query or fragment, and no path segment that is or decodes
// to "i" (an invite link's).
func ShareRelay(raw string) (string, bool) {
	if len(raw) > maxShareRelay || strings.ContainsAny(raw, "?#\\") || strings.ContainsFunc(raw, unicode.IsSpace) {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" && u.Scheme != "http" || u.Host == "" || u.User != nil || u.Opaque != "" {
		return "", false
	}
	for _, segment := range strings.Split(u.EscapedPath(), "/") {
		if s, err := url.PathUnescape(segment); err != nil || s == "i" {
			return "", false
		}
	}
	canonical := u.Scheme + "://" + strings.ToLower(u.Host) + strings.TrimRight(u.EscapedPath(), "/")
	return canonical, len(canonical) <= maxShareRelay
}

// ValidShare reports whether the service would take b as item id: the
// required fields well formed and matching the id, the labels within
// their limits.
func ValidShare(id string, b ShareBody) bool {
	_, ok := ShareRelay(b.Relay)
	pub, err := base64.RawURLEncoding.DecodeString(b.NodePub)
	return ok && b64url16(b.HostID) && b64url16(b.GuestID) && err == nil && len(pub) == 32 && id == ShareID(b.HostID, b.GuestID) &&
		shareText(b.AgentName, maxShareAgent) == b.AgentName && shareText(b.OwnerName, maxShareOwner) == b.OwnerName && shareText(b.MachineLabel, maxShareMachine) == b.MachineLabel
}

// shareText is a label as the service takes it (well-formed, no control
// characters, at most max code points), or "" when it wouldn't: the label
// is then left out of the item (each is optional), which the service would
// otherwise refuse with the whole push (400 invalid_item).
func shareText(s string, max int) string {
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > max || strings.ContainsFunc(s, unicode.IsControl) {
		return ""
	}
	return s
}

func b64url16(s string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	return err == nil && len(s) == 22 && len(raw) == 16
}

// RemoteShare is a live (not deleted) shares item.
type RemoteShare struct {
	ID   string
	Rev  int64
	Body ShareBody
}

// shareRow reads a live shares item; one the service wouldn't hold (its
// body not matching its id) is none.
func shareRow(it Item) (RemoteShare, bool) {
	var b ShareBody
	if json.Unmarshal(it.Body, &b) != nil || !ValidShare(it.ID, b) {
		return RemoteShare{}, false
	}
	return RemoteShare{ID: it.ID, Rev: it.Rev, Body: b}, true
}
