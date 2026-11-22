// Package webrelay is the one list of relays the web app reaches. The
// desktop's browser approval (app/desk_web_access.go) skips a machine on any
// other relay, and the guest web build (vite.web.config.ts) writes the same
// origins, as wss://, into the page's connect-src. Both read relays.json, so
// an edit there changes both.
//
// The guest relay's own _headers (themartianapp/herdrup GuestRelay) repeats
// the CSP and must list the same origins.
package webrelay

import (
	_ "embed"
	"encoding/json"
	"slices"
	"strings"
)

//go:embed relays.json
var relaysJSON []byte

// Origins are the relay origins (https://host), from relays.json.
var Origins = func() []string {
	var o []string
	if err := json.Unmarshal(relaysJSON, &o); err != nil || len(o) == 0 {
		panic("webrelay: relays.json is not a list of origins")
	}
	return o
}()

// Allowed reports whether relay (an https origin, a trailing slash allowed)
// is one the web app reaches.
func Allowed(relay string) bool {
	return slices.Contains(Origins, strings.TrimRight(relay, "/"))
}
