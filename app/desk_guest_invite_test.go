package main

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func TestGuestInviteStaysWithSelectedPeerAndRejectsClosedView(t *testing.T) {
	const peerID = "11111111111111111111111111111111"
	guests := fakeherdr.NewGuests()
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		s.Machines = []fakeherdr.Machine{{ProfileID: peerID, DisplayLabel: "render-box", SavedState: "coordinated", FederationReachability: "reachable"}}
		original := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "agent.list" {
				return map[string]any{"type": "agent_list", "agents": []any{
					map[string]any{"pane_id": "workspace/w1:p1", "name": "Local", "agent_status": "working"},
					map[string]any{"pane_id": peerID + "/workspace/w1:p1", "name": "Remote", "agent_status": "working", "machine_id": peerID, "machine_label": "render-box"},
				}}, nil
			}
			if value, err, handled := guests.Handle(method, raw); handled {
				return value, err
			}
			return original(method, raw)
		}
	})
	b := d.Board()
	ctx := context.Background()
	target := AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: peerID + "/workspace/w1:p1"}
	if _, err := d.OpenAgentView(target, "peer"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.CreateGuestInvite(ctx, "peer", "Taylor_peer", "Owner", true); err != nil {
		t.Fatal(err)
	}
	target.PaneID = "workspace/w1:p1"
	if _, err := d.OpenAgentView(target, "local"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.CreateGuestInvite(ctx, "peer", "stale", "Owner", false); err == nil {
		t.Fatal("replaced view created an invitation")
	}
	if _, err := d.CreateGuestInvite(ctx, "local", "Taylor_local", "Owner", false); err != nil {
		t.Fatal(err)
	}
	d.CloseAgentView("local")
	if _, err := d.CreateGuestInvite(ctx, "local", "closed", "Owner", false); err == nil {
		t.Fatal("closed view created an invitation")
	}
	if err := d.OpenSettings(b.MachineID, b.Session, "review"); err != nil {
		t.Fatal(err)
	}
	defer d.CloseSettings("review")
	for _, machine := range []string{"", peerID} {
		raw, err := d.SettingsGuestMachine(ctx, "review", machine)
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			Listing *herdrapi.ResponseResultGuestList `json:"listing"`
		}
		if err := json.Unmarshal([]byte(raw), &result); err != nil {
			t.Fatal(err)
		}
		if result.Listing == nil {
			t.Fatalf("guest store unavailable: %s", raw)
		}
		found := false
		want, forbidden := "Taylor_local", "Taylor_peer"
		if machine != "" {
			want, forbidden = forbidden, want
		}
		for _, invite := range result.Listing.Invites {
			if invite.Name == forbidden || invite.Name == "stale" || invite.Name == "closed" {
				t.Fatalf("invitation escaped its view: machine=%q name=%q", machine, invite.Name)
			}
			if invite.Name == want {
				found = true
				if invite.Grant.TerminalID != "workspace/w1:p1" {
					t.Fatalf("grant did not identify the daemon-local pane: %+v", invite.Grant)
				}
				if invite.ShareGram != (machine != "") {
					t.Fatalf("Gram consent changed: %+v", invite)
				}
			}
		}
		if !found {
			t.Fatalf("invitation missing from selected machine %q", machine)
		}
	}
}

// The machine_label an invite carries (the invite page, SHARED WITH YOU) is
// the saved machine's nickname, else its bare host: never the connection's
// user@host:port, nor the user@host nickname pairing once gave a machine. A
// federated peer's agent keeps herdr's machine_label for it. Each is a label
// herdr takes (the fake refuses one as herdr does): a nickname or peer label
// longer than herdr's 64 characters is cut, its control and format characters
// dropped (#521).
func TestGuestInviteNamesTheMachineByItsNicknameElseItsHost(t *testing.T) {
	const peerID = "11111111111111111111111111111111"
	long := strings.Repeat("é", 70)
	for _, c := range []struct{ nickname, want, peerLabel, wantPeer string }{
		{"  Studio Mac  ", "Studio Mac", "render-box", "render-box"},
		{"", "127.0.0.1", "render-box", "render-box"},
		{"dev@127.0.0.1", "127.0.0.1", "render-box", "render-box"},
		{strings.Repeat("N", 65), strings.Repeat("N", 64), long, strings.Repeat("é", 64)},
		{"Studio\u200d Mac\a", "Studio Mac", "\x1b\a", peerID},
	} {
		var labels []string
		var mu sync.Mutex
		guests := fakeherdr.NewGuests()
		d, _ := federatedDeskAs(t, c.nickname, func(s *fakeherdr.Server) {
			original := s.Handle
			s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
				if method == "agent.list" {
					return map[string]any{"type": "agent_list", "agents": []any{
						map[string]any{"pane_id": "w1:p1", "name": "Local", "agent_status": "working"},
						map[string]any{"pane_id": peerID + "/w1:p1", "name": "Remote", "agent_status": "working", "machine_id": peerID, "machine_label": c.peerLabel},
					}}, nil
				}
				if method == "guest.invite.create" {
					var p herdrapi.GuestInviteCreateParams
					_ = json.Unmarshal(raw, &p)
					mu.Lock()
					labels = append(labels, p.MachineLabel)
					mu.Unlock()
				}
				if value, err, handled := guests.Handle(method, raw); handled {
					return value, err
				}
				return original(method, raw)
			}
		})
		b := d.Board()
		for _, pane := range []string{"w1:p1", peerID + "/w1:p1"} {
			if _, err := d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: pane}, "v"); err != nil {
				t.Fatal(err)
			}
			if _, err := d.CreateGuestInvite(context.Background(), "v", "Taylor", "Owner", false); err != nil {
				t.Fatalf("nickname %q, pane %s: %v", c.nickname, pane, err)
			}
		}
		mu.Lock()
		got := labels
		mu.Unlock()
		if want := []string{c.want, c.wantPeer}; !slices.Equal(got, want) {
			t.Fatalf("nickname %q: invites named the machine %q, want %q", c.nickname, got, want)
		}
		if details, err := d.GuestShareDetails("v"); err != nil || details.MachineLabel != c.wantPeer {
			t.Fatalf("peer share details %+v, %v", details, err)
		}
	}
}

// Every label shareLabel gives is one herdr takes for an invite (1 to 64
// characters, none a control character, src/guest/mod.rs create_invite) and
// the invite's readers decode (none a format character either, validLabel),
// cut on a rune boundary.
func TestShareLabelIsALabelHerdrAndTheGuestsTake(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"Studio Mac", "Studio Mac"},
		{"  padded  ", "padded"},
		{strings.Repeat("x", 64), strings.Repeat("x", 64)},
		{strings.Repeat("x", 65), strings.Repeat("x", 64)},
		{strings.Repeat("x", 63) + " tail", strings.Repeat("x", 63)},
		{strings.Repeat("日", 80), strings.Repeat("日", 64)},
		{"👩\u200d💻 desk", "👩💻 desk"},
		{"\ufeffbom\u0085next\tline\n", "bomnextline"},
		{"\x00\a\u200b", ""},
		{"   ", ""},
	} {
		got := shareLabel(c.in)
		if got != c.want {
			t.Errorf("shareLabel(%q) = %q, want %q", c.in, got, c.want)
		}
		if got != "" && (strings.TrimSpace(got) != got || utf8.RuneCountInString(got) > 64 || !utf8.ValidString(got) ||
			strings.ContainsFunc(got, func(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) })) {
			t.Errorf("shareLabel(%q) = %q, not a label herdr and the guests take", c.in, got)
		}
	}
	for _, c := range []struct {
		m    Machine
		want string
	}{
		{Machine{Nickname: strings.Repeat("N", 65), User: "dev", Host: "box"}, strings.Repeat("N", 64)},
		{Machine{Nickname: "\a", User: "dev", Host: "box"}, "box"},
		{Machine{Nickname: "dev@box", User: "dev", Host: "box"}, "box"},
		{Machine{Nickname: "ops@box", User: "dev", Host: "box"}, "ops@box"},
		{Machine{User: "dev", Host: strings.Repeat("h", 70) + ".example"}, strings.Repeat("h", 64)},
	} {
		if got := machineLabel(c.m); got != c.want {
			t.Errorf("machineLabel(%+v) = %q, want %q", c.m, got, c.want)
		}
	}
}

// Renamed while connected, the machine's next share view sends its new name
// (#523); a save of another machine leaves the name alone.
func TestGuestInviteNamesTheMachineAsSavedSinceTheConnect(t *testing.T) {
	var labels []string
	var mu sync.Mutex
	guests := fakeherdr.NewGuests()
	d, _ := federatedDeskAs(t, "Old", func(s *fakeherdr.Server) {
		original := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "guest.invite.create" {
				var p herdrapi.GuestInviteCreateParams
				_ = json.Unmarshal(raw, &p)
				mu.Lock()
				labels = append(labels, p.MachineLabel)
				mu.Unlock()
			}
			if value, err, handled := guests.Handle(method, raw); handled {
				return value, err
			}
			return original(method, raw)
		}
	})
	b := d.Board()
	invite := func() {
		t.Helper()
		if _, err := d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "v"); err != nil {
			t.Fatal(err)
		}
		if _, err := d.CreateGuestInvite(context.Background(), "v", "Taylor", "Owner", false); err != nil {
			t.Fatal(err)
		}
	}
	saved, err := d.Machines()
	if err != nil || len(saved) != 1 || saved[0].ID != b.MachineID {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	invite()
	renamed := saved[0].Machine
	renamed.Nickname = "New"
	if err := d.SaveMachine(renamed, saved[0].ID); err != nil {
		t.Fatal(err)
	}
	invite()
	if err := d.SaveMachine(Machine{Nickname: "Elsewhere", Host: "other.example", User: "dev"}, ""); err != nil {
		t.Fatal(err)
	}
	invite()
	mu.Lock()
	got := labels
	mu.Unlock()
	if want := []string{"Old", "New", "New"}; !slices.Equal(got, want) {
		t.Fatalf("invites named the machine %q, want %q", got, want)
	}
}
