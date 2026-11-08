package main

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func claudeAgent() herdrapi.AgentInfo {
	return herdrapi.AgentInfo{PaneID: "w1:p1", TerminalID: "t1", Name: new("planner"), Agent: new("claude"), Account: new("claude-work")}
}

// menuLabels flattens menu entries as labels does, separators as "—" and
// disabled items in brackets.
func menuLabels(es []menuEntry) []string {
	var out []string
	for _, e := range es {
		switch {
		case e.Separator:
			out = append(out, "—")
		case e.Sub != nil:
			out = append(out, e.Label+">"+join(menuLabels(e.Sub)))
		case e.Disabled:
			out = append(out, "["+e.Label+"]")
		default:
			out = append(out, e.Label)
		}
	}
	return out
}

func TestAgentRowMenuOrderAndItems(t *testing.T) {
	caps := &herdrapi.ServerCapabilities{AgentAvatar: true, AgentSessionTransfer: true,
		AgentSessionTransferHarnesses: []herdrapi.AgentSessionTransferHarness{"claude", "codex", "omp", "kimi"}}
	groups := &herdr.Groups{Stars: []string{}, Folders: []herdrapi.AgentGroupFolder{{ID: "x", Name: "Work"}}}
	accounts := []herdrapi.AccountInfo{
		{ID: "claude-work", Kind: "claude", Label: "Work", Active: true},
		{ID: "codex-1", Kind: "codex", Label: "Codex", Active: true},
		{ID: "claude-home", Kind: "claude", Label: "Home", Active: false},
	}
	got := agentRowMenu(agentMenuInput{Info: claudeAgent(), Caps: caps, Groups: groups, Accounts: accounts})
	want := []string{
		"Stop agent", "Rename", "Avatar…", "Star", `Move to folder>["Work","New folder…"]`, "Restart agent",
		`Switch harness>["Codex","Oh My Pi"]`,
		`Swap subscription>["Work (current)","Home (exhausted)"]`,
		"Archive",
	}
	if labels := menuLabels(got); !reflect.DeepEqual(labels, want) {
		t.Fatalf("menu %q\nwant %q", labels, want)
	}
	icons := []string{"stop.circle", "pencil", "person.crop.circle", "star", "folder", "arrow.clockwise", "arrow.left.arrow.right", "arrow.left.arrow.right", "archivebox"}
	for i, e := range got {
		if e.Icon != icons[i] {
			t.Errorf("%s icon %q, want %q", e.Label, e.Icon, icons[i])
		}
	}
	swap := got[7].Sub
	if swap[0].Icon != "person.crop.circle.fill" || swap[1].Icon != "person.crop.circle" {
		t.Errorf("swap icons %q %q", swap[0].Icon, swap[1].Icon)
	}
	if a := swap[1].Action; a == nil || a.Kind != "swap" || *a.Account != (AgentActionAccount{ID: "claude-home", Label: "Home"}) || a.PaneID != "w1:p1" || a.Title != "planner" {
		t.Errorf("swap action %+v", a)
	}
	transfer := got[6].Sub[1].Action
	if transfer == nil || transfer.Kind != "transfer" || transfer.Source != "claude" || *transfer.Target != (AgentActionTarget{ID: "omp", DisplayName: "Oh My Pi"}) || transfer.TerminalID != "t1" {
		t.Errorf("transfer action %+v", transfer)
	}
	for i, kind := range map[int]string{0: "stop", 1: "rename", 2: "avatar", 5: "restart", 8: "archive"} {
		if a := got[i].Action; a == nil || a.Kind != kind || a.Name != "planner" || a.Agent != "claude" {
			t.Errorf("%s action %+v", got[i].Label, a)
		}
	}
}

func TestAgentRowMenuWithoutCapabilitiesOrName(t *testing.T) {
	a := claudeAgent()
	a.Name = nil
	got := menuLabels(agentRowMenu(agentMenuInput{Info: a, Groups: &herdr.Groups{}}))
	if want := []string{"Stop agent", "Rename", "Restart agent", "Archive"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("menu %q, want %q", got, want)
	}
	got = menuLabels(agentRowMenu(agentMenuInput{Info: claudeAgent(), Caps: &herdrapi.ServerCapabilities{AgentGroups: true}}))
	if want := []string{"Stop agent", "Rename", "Restart agent", "Archive"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("menu without folders %q, want %q", got, want)
	}
}

func TestAgentRowMenuSwitchHarness(t *testing.T) {
	transfer := &herdrapi.ServerCapabilities{AgentSessionTransfer: true}
	switchItem := func(a herdrapi.AgentInfo, caps *herdrapi.ServerCapabilities) string {
		for _, l := range menuLabels(agentRowMenu(agentMenuInput{Info: a, Caps: caps})) {
			if strings.HasPrefix(l, "Switch") {
				return l
			}
		}
		return ""
	}
	omp := claudeAgent()
	omp.Agent = new("omp")
	federated := claudeAgent()
	federated.MachineID = new("studio")
	kimi := claudeAgent()
	kimi.Agent = new("kimi")
	upper := claudeAgent()
	upper.Agent = new("Codex")
	active := claudeAgent()
	active.SessionTransfer = &herdrapi.AgentSessionTransferInfo{ID: "x", Phase: herdrapi.AgentSessionTransferPhaseReady, Source: "claude", Target: "omp"}
	done := claudeAgent()
	done.SessionTransfer = &herdrapi.AgentSessionTransferInfo{ID: "x", Phase: herdrapi.AgentSessionTransferPhaseCompleted, Source: "codex", Target: "claude"}
	for _, tc := range []struct {
		name string
		a    herdrapi.AgentInfo
		caps *herdrapi.ServerCapabilities
		want string
	}{
		{"no capability", claudeAgent(), &herdrapi.ServerCapabilities{}, ""},
		{"server before the harness list: Claude Code and Codex", claudeAgent(), transfer, `Switch to Codex>["Codex"]`},
		{"omp is not in the older list", omp, transfer, ""},
		{"listed omp", omp, &herdrapi.ServerCapabilities{AgentSessionTransfer: true, AgentSessionTransferHarnesses: []herdrapi.AgentSessionTransferHarness{"omp", "claude"}}, `Switch to Claude Code>["Claude Code"]`},
		{"federated agent", federated, transfer, ""},
		{"not a native harness", kimi, transfer, ""},
		{"harness kind is case-insensitive", upper, transfer, `Switch to Claude Code>["Claude Code"]`},
		{"unfinished transfer reopens without the capability", active, nil, `Switch to Oh My Pi>["Oh My Pi"]`},
		{"finished transfer is the agent's own again", done, nil, ""},
	} {
		if got := switchItem(tc.a, tc.caps); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestPaneMenu(t *testing.T) {
	for _, tc := range []struct {
		name                        string
		o                           PaneMenuOptions
		owner, canEditAvatar, muted bool
		want                        []string
	}{
		{"plain terminal", PaneMenuOptions{PaneID: "p", Plain: true, HasSelection: true}, true, false, false,
			[]string{"Copy screen", "Copy recent output", "Copy selection", "—", "[Text size]", "Increase", "Decrease", "Reset"}},
		{"owner's agent", PaneMenuOptions{PaneID: "p", CanShare: true}, true, true, false,
			[]string{"Copy screen", "Copy recent output", "[Copy selection]", "—", "[Text size]", "Increase", "Decrease", "Reset", "—", "Share with someone", "Avatar…", "Mute notifications", "Close agent"}},
		{"muted, no avatars", PaneMenuOptions{PaneID: "p", CanShare: true, HasSelection: true}, true, false, true,
			[]string{"Copy screen", "Copy recent output", "Copy selection", "—", "[Text size]", "Increase", "Decrease", "Reset", "—", "Share with someone", "Unmute notifications", "Close agent"}},
		{"guest", PaneMenuOptions{PaneID: "p"}, false, false, false,
			[]string{"Copy screen", "Copy recent output", "[Copy selection]", "—", "[Text size]", "Increase", "Decrease", "Reset", "—"}},
	} {
		if got := menuLabels(paneMenu(tc.o, tc.owner, tc.canEditAvatar, tc.muted)); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %q\nwant %q", tc.name, got, tc.want)
		}
	}
	m := paneMenu(PaneMenuOptions{PaneID: "p", CanShare: true}, true, true, true)
	if e := m[len(m)-2]; e.Icon != "bell" || *e.Pane != (PaneAction{PaneID: "p", Action: "unmute"}) {
		t.Errorf("unmute entry %+v", e)
	}
	if e := m[len(m)-1]; e.Icon != "xmark.circle" || e.Pane.Action != "close" {
		t.Errorf("close entry %+v", e)
	}
}

func TestAvatarParamsAndErrors(t *testing.T) {
	for _, tc := range []struct {
		c    AvatarChoice
		want string
	}{
		{AvatarChoice{Kind: "default"}, `{"avatar":null,"target":"t"}`},
		{AvatarChoice{Kind: "mascot", Mascot: "otter"}, `{"avatar":{"mascot":"otter","style":"mascot"},"target":"t"}`},
		{AvatarChoice{Kind: "image", ImageBase64: "AAAA", Mime: "image/jpeg"}, `{"avatar":{"style":"image"},"image_base64":"AAAA","mime":"image/jpeg","target":"t"}`},
	} {
		p, err := avatarParams(tc.c)
		if err != nil {
			t.Fatal(err)
		}
		p.Target = "t"
		data, _ := json.Marshal(p)
		var a, b any
		_ = json.Unmarshal(data, &a)
		_ = json.Unmarshal([]byte(tc.want), &b)
		if !reflect.DeepEqual(a, b) {
			t.Errorf("%+v: %s, want %s", tc.c, data, tc.want)
		}
	}
	if _, err := avatarParams(AvatarChoice{Kind: "image"}); err == nil {
		t.Error("an image without bytes")
	}
	for err, want := range map[error]string{
		&engine.ErrUnsupported{Method: "agent.avatar.set"}:               "this server doesn't support agent pictures.",
		&bridge.APIError{Code: "avatar_too_large", Message: "64 KiB"}:    "the photo is too large.",
		&bridge.APIError{Code: "invalid_avatar", Message: "bad"}:         "the server refused it.",
		&bridge.APIError{Code: "agent_not_found", Message: "no agent x"}: "no agent x",
	} {
		if got := describeAvatarError(err); got == nil || got.Error() != want {
			t.Errorf("%v: %v, want %q", err, got, want)
		}
	}
	if avatarTarget(claudeAgent()) != "t1" {
		t.Error("a local agent's picture goes on its terminal id")
	}
	federated := claudeAgent()
	federated.MachineID = new("studio")
	if avatarTarget(federated) != "w1:p1" {
		t.Error("a federated agent's picture goes on its pane id")
	}
}

func TestPaneMuteIsKeptWithThePreferences(t *testing.T) {
	dir := t.TempDir()
	d := newDesk(dir)
	if err := d.SetPaneMuted("w1:p1", true); err != nil {
		t.Fatal(err)
	}
	if err := d.SetFinishNotifications("always"); err != nil {
		t.Fatal(err)
	}
	again := newDesk(dir)
	if !again.PaneMuted("w1:p1") || again.PaneMuted("w1:p2") {
		t.Fatal("mute not kept per pane across launches")
	}
	if p := again.notifications.preferences; !p.Finishes || !p.NeedsInput {
		t.Fatalf("preferences not kept beside the mute: %+v", p)
	}
	a := attention{agent: claudeAgent(), target: AgentTarget{MachineID: "m", PaneID: "w1:p1"}, kind: "needsInput"}
	if _, ok := again.agentNotification(a); ok {
		t.Error("a muted pane was notified")
	}
	if err := again.SetPaneMuted("w1:p1", false); err != nil {
		t.Fatal(err)
	}
	if options, ok := again.agentNotification(a); !ok || options.Title == "" {
		t.Errorf("unmuted pane: %+v, %v", options, ok)
	}
	if newDesk(dir).PaneMuted("w1:p1") {
		t.Error("unmute not kept")
	}
}

// actionsDesk is a desk connected to a fake herdr serving roster, whose
// agent menu methods fixture answers.
func actionsDesk(t *testing.T, caps map[string]bool) (*Desk, *fakeherdr.AgentActions) {
	t.Helper()
	var mu sync.Mutex
	roster := []byte(`{"type":"agent_list","agents":[
		{"pane_id":"w1:p1","terminal_id":"t1","tab_id":"w1:t1","name":"planner","agent":"claude","agent_status":"idle","focused":false,"revision":1},
		{"pane_id":"w1:p2","terminal_id":"t2","tab_id":"w1:t1","name":"docs","agent":"codex","agent_status":"working","focused":false,"revision":1}]}`)
	get := func() []byte { mu.Lock(); defer mu.Unlock(); return roster }
	set := func(b []byte) { mu.Lock(); defer mu.Unlock(); roster = b }
	fixture := fakeherdr.NewAgentActions(get, set, caps["agent_session_transfer"])
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				pong := fakeherdr.Pong(true)
				all := pong["capabilities"].(map[string]bool)
				for k, v := range caps {
					all[k] = v
				}
				return pong, nil
			case "agent.list":
				return json.RawMessage(get()), nil
			case "agent.restart":
				var p herdrapi.AgentRestartParams
				_ = json.Unmarshal(raw, &p)
				if p.Account != nil { // a swap
					return map[string]any{"type": "agent_info", "agent": map[string]any{"pane_id": p.Target, "agent_status": "idle", "account": *p.Account}}, nil
				}
			}
			if res, err, ok := fixture.Handle(method, raw); ok {
				return res, err
			}
			return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
		}
	})
	return d, fixture
}

func lastCall(t *testing.T, fixture *fakeherdr.AgentActions, method string) map[string]any {
	t.Helper()
	calls := fixture.Calls()
	for i := len(calls) - 1; i >= 0; i-- {
		if calls[i].Method == method {
			var p map[string]any
			if err := json.Unmarshal(calls[i].Params, &p); err != nil {
				t.Fatal(err)
			}
			return p
		}
	}
	t.Fatalf("no %s in %+v", method, calls)
	return nil
}

func TestAgentActionsReachHerdr(t *testing.T) {
	d, fixture := actionsDesk(t, map[string]bool{"agent_groups": true, "agent_avatar": true})
	ctx := context.Background()
	if err := d.RestartAgent(ctx, "w1:p1", ""); err != nil {
		t.Fatal(err)
	}
	if p := lastCall(t, fixture, "agent.restart"); !reflect.DeepEqual(p, map[string]any{"target": "w1:p1"}) {
		t.Errorf("plain restart sent %v, want only the target", p)
	}
	if err := d.RestartAgent(ctx, "w1:p1", "claude-home"); err != nil {
		t.Fatal(err)
	}
	if n := len(fixture.Calls()); n != 1 {
		t.Errorf("swap reached the plain restart fixture: %d calls", n)
	}
	saved, err := d.RenameAgent(ctx, "w1:p1", "  Code Reviewer!  ")
	if err != nil || saved != "code-reviewer-" {
		t.Fatalf("rename: %q, %v", saved, err)
	}
	if p := lastCall(t, fixture, "agent.rename"); p["name"] != "code-reviewer-" || p["target"] != "w1:p1" {
		t.Errorf("rename sent %v", p)
	}
	if _, err := d.RenameAgent(ctx, "w1:p1", "docs"); err == nil || !strings.Contains(err.Error(), "agent_name_taken") {
		t.Errorf("taken name: %v", err)
	}
	if _, err := d.RenameAgent(ctx, "w1:p1", "   "); err == nil {
		t.Error("an empty name was saved")
	}
	if err := d.ArchiveAgent(ctx, "w1:p1"); err != nil {
		t.Fatal(err)
	}
	if p := lastCall(t, fixture, "agent.archive"); !reflect.DeepEqual(p, map[string]any{"target": "w1:p1", "reason": "user action", "by": "herdrup"}) {
		t.Errorf("archive sent %v", p)
	}
	if err := d.ArchiveAgent(ctx, "w1:p2"); err == nil {
		t.Error("a working agent was archived")
	}
	if err := d.StopAgent(ctx, "w1:p2"); err != nil {
		t.Fatal(err)
	}
	if p := lastCall(t, fixture, "pane.close"); p["pane_id"] != "w1:p2" {
		t.Errorf("stop sent %v", p)
	}
	waitFor(t, "the stopped agent to leave the board", func() bool {
		b := d.Board()
		return b != nil && b.Board.Total == 0
	})
	if _, err := d.PrepareSessionTransfer(ctx, "w1:p1", "codex", ""); !errors.As(err, new(*engine.ErrUnsupported)) {
		t.Errorf("transfer without agent_session_transfer: %v", err)
	}
}

func TestSessionTransferPrepareAndConfirm(t *testing.T) {
	d, fixture := actionsDesk(t, map[string]bool{"agent_session_transfer": true})
	ctx := context.Background()
	reply, err := d.PrepareSessionTransfer(ctx, "w1:p1", "codex", "")
	if err != nil {
		t.Fatal(err)
	}
	var prepared herdrapi.ResponseResultAgentInfo
	if err := json.Unmarshal([]byte(reply), &prepared); err != nil || prepared.Agent.SessionTransfer == nil || prepared.Agent.SessionTransfer.Phase != herdrapi.AgentSessionTransferPhaseReady {
		t.Fatalf("prepare reply %s, %v", reply, err)
	}
	if p := lastCall(t, fixture, "agent.transfer_session"); !reflect.DeepEqual(p, map[string]any{"target": "w1:p1", "to": "codex"}) {
		t.Errorf("prepare sent %v", p)
	}
	id := prepared.Agent.SessionTransfer.ID
	reply, err = d.ConfirmSessionTransfer(ctx, "w1:p1", "codex", "codex-1", id)
	if err != nil {
		t.Fatal(err)
	}
	if p := lastCall(t, fixture, "agent.transfer_session"); !reflect.DeepEqual(p, map[string]any{"target": "w1:p1", "to": "codex", "account": "codex-1", "transfer_id": id, "confirm": true}) {
		t.Errorf("confirm sent %v", p)
	}
	info, err := d.TransferAgentInfo(ctx, "gone", "t1")
	var agent herdrapi.AgentInfo
	if err != nil || json.Unmarshal([]byte(info), &agent) != nil || agent.SessionTransfer.Phase != herdrapi.AgentSessionTransferPhaseCompleted || deref(agent.Agent) != "codex" {
		t.Fatalf("agent by terminal id: %s, %v", info, err)
	}
	if info, err := d.TransferAgentInfo(ctx, "gone", ""); err != nil || info != "" {
		t.Errorf("missing agent: %q, %v", info, err)
	}
}
