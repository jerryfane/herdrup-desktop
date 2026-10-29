package herdr

import (
	"strings"
	"testing"
)

func TestAvatarOfResolvesLikeHerdrup(t *testing.T) {
	sha := strings.Repeat("ab", 32)
	for _, tc := range []struct {
		name string
		js   string
		want Avatar
	}{
		{"no choice", `{}`, Avatar{Kind: "initial"}},
		{"bundled mascot", `{"avatar":{"style":"mascot","mascot":"pip"}}`, Avatar{Kind: "mascot", Mascot: "pip"}},
		{"last mascot", `{"avatar":{"style":"mascot","mascot":"drop"}}`, Avatar{Kind: "mascot", Mascot: "drop"}},
		{"mascot a newer build ships", `{"avatar":{"style":"mascot","mascot":"zebra"}}`, Avatar{Kind: "initial"}},
		{"mascot without an id", `{"avatar":{"style":"mascot"}}`, Avatar{Kind: "initial"}},
		{"photo", `{"pane_id":"p1","terminal_id":"t1","avatar":{"style":"image","sha256":"` + sha + `"}}`,
			Avatar{Kind: "image", SHA256: sha, Target: "t1"}},
		{"photo with an upper-case sha", `{"terminal_id":"t1","avatar":{"style":"image","sha256":"` + strings.ToUpper(sha) + `"}}`,
			Avatar{Kind: "image", SHA256: sha, Target: "t1"}},
		{"photo with a short sha", `{"avatar":{"style":"image","sha256":"` + sha[:63] + `"}}`, Avatar{Kind: "initial"}},
		{"photo with a non-hex sha", `{"avatar":{"style":"image","sha256":"` + sha[:63] + `g"}}`, Avatar{Kind: "initial"}},
		{"photo without a sha", `{"avatar":{"style":"image"}}`, Avatar{Kind: "initial"}},
		{"unknown style", `{"avatar":{"style":"hologram","mascot":"pip"}}`, Avatar{Kind: "initial"}},
	} {
		if got := AvatarOf(agent(t, tc.js)); got != tc.want {
			t.Errorf("%s: got %+v, want %+v", tc.name, got, tc.want)
		}
	}
}

func TestAvatarTarget(t *testing.T) {
	for _, tc := range []struct{ name, js, want string }{
		{"local: terminal id", `{"pane_id":"p1","terminal_id":"t1"}`, "t1"},
		{"federated: prefixed pane id", `{"pane_id":"studio:p1","terminal_id":"t1","machine_id":"studio"}`, "studio:p1"},
		{"no terminal id: pane id", `{"pane_id":"p1"}`, "p1"},
		{"no pane: terminal id", `{"pane_id":"","terminal_id":"t1","machine_id":"studio"}`, "t1"},
		{"no pane or terminal: name", `{"pane_id":"","name":"ada"}`, "ada"},
	} {
		if got := AvatarTarget(agent(t, tc.js)); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestRowMarkersAccountAndAge(t *testing.T) {
	rowFor := func(js string) Row { return rowOf(agent(t, js), Idle) }
	if r := rowFor(`{"agent_status":"idle","reachability":"degraded"}`); !r.Stale {
		t.Error("a degraded peer's row is not marked stale")
	}
	if r := rowFor(`{"agent_status":"idle","reachability":"unreachable"}`); r.Stale || r.Badge != "offline" {
		t.Errorf("an unreachable peer's row: stale %v, badge %q; want the offline badge only", r.Stale, r.Badge)
	}
	if r := rowFor(`{"agent_status":"idle","reachability":"reachable"}`); r.Stale {
		t.Error("a reachable row is marked stale")
	}
	if r := rowFor(`{"agent_status":"idle","reachability":"degraded","archived":{"at":"2026-01-01T00:00:00Z","by":"x"}}`); r.Stale {
		t.Error("an archived row is marked stale")
	}
	if r := rowFor(`{"account_unresolved":true,"account":"work"}`); !r.NoAccount || r.Account != "work" {
		t.Errorf("unresolved account: got %+v", r)
	}
	if r := rowFor(`{"account_unresolved":false}`); r.NoAccount {
		t.Error("account_unresolved false reads as no account")
	}
	if r := rowFor(`{"status_since_unix_ms":1700000000000}`); r.StatusSinceUnixMs == nil || *r.StatusSinceUnixMs != 1700000000000 {
		t.Errorf("status since: got %v", r.StatusSinceUnixMs)
	}
	if r := rowFor(`{"terminal_title_stripped":"π > reading files"}`); r.Activity != "reading files" {
		t.Errorf("activity: got %q", r.Activity)
	}
	if r := rowFor(`{"avatar":{"style":"mascot","mascot":"bot"}}`); r.Avatar.Kind != "mascot" {
		t.Errorf("row avatar: got %+v", r.Avatar)
	}
}
