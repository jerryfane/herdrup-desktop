package main

import (
	"context"
	"encoding/json"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/guest"
)

// guestOwnerHost is the owner's herdr behind a fake guest relay: one omp
// agent waiting on a select menu until a committing key or an answer moves
// it on, as detection would.
type guestOwnerHost struct {
	mu      sync.Mutex
	status  string
	seq     int
	answers []map[string]any
	keys    [][]string
	// lagging: after a committing key detection has not caught up, so the
	// agent still lists as blocked at the same sequence, and the relay's gate
	// refuses further keys until state_change_seq moves (herdr #352 guest_gate).
	lagging bool
	// prompt is the blocked agent input_prompt_kind; empty lists select.
	prompt string
}

func (h *guestOwnerHost) handle(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
	h.mu.Lock()
	defer h.mu.Unlock()
	agent := map[string]any{"terminal_id": "t2", "pane_id": "w1:p2", "name": "docs", "agent": "omp", "agent_status": h.status, "state_change_seq": h.seq}
	if h.status == "blocked" {
		kind := h.prompt
		if kind == "" {
			kind = "select"
		}
		agent["input_pending"], agent["input_prompt_kind"] = true, kind
	}
	switch method {
	case "agent.list":
		return map[string]any{"type": "agent_list", "agents": []any{agent}}, nil
	case "agent.answer":
		var p map[string]any
		_ = json.Unmarshal(raw, &p)
		h.answers = append(h.answers, p)
		return map[string]any{"type": "agent_answer", "status": "answered"}, nil
	case "pane.send_keys":
		var p struct {
			PaneID string   `json:"pane_id"`
			Keys   []string `json:"keys"`
		}
		_ = json.Unmarshal(raw, &p)
		if p.PaneID != "w1:p2" {
			return nil, &fakeherdr.APIError{Code: "pane_not_found", Message: p.PaneID}
		}
		h.keys = append(h.keys, p.Keys)
		if p.Keys[len(p.Keys)-1] == "enter" && !h.lagging {
			h.status, h.seq = "working", h.seq+1
		}
		return map[string]any{"type": "ok"}, nil
	case "agent.transcript":
		page := map[string]any{"type": "agent_transcript", "agent": "omp", "pane_id": "w1:p2", "session_id": "s1", "after": "c1", "entries": []any{}}
		if h.status == "working" {
			page["working"] = map[string]any{"intent": "Reading"}
		}
		return page, nil
	}
	return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
}

func (h *guestOwnerHost) sent() ([]map[string]any, [][]string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.answers, h.keys
}

// openGuestAgent redeems the relay's invitation, connects the share and
// opens its agent page, as a guest does from the invite link; clock times
// the guest's status poll and relay backoff.
func openGuestAgent(t *testing.T, relay *fakeherdr.GuestRelay, clock guest.Clock) (*Desk, AgentView) {
	t.Helper()
	relay.TerminalID, relay.AgentName = "t2", "docs"
	relay.OwnerName, relay.MachineLabel, relay.GuestName = "Jerry", "studio", "visitor"
	base, err := relay.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = relay.Close() })
	d := newDesk(t.TempDir())
	d.guestClock = clock
	t.Cleanup(d.Disconnect)
	access, err := d.AcceptGuestInvitation(context.Background(), relay.InviteLink(base, time.Now().Add(time.Hour)))
	if err != nil {
		t.Fatal(err)
	}
	if err := d.ConnectGuest(access.ID()); err != nil {
		t.Fatal(err)
	}
	var view AgentView
	waitFor(t, "the shared agent's page", func() bool {
		view, err = d.OpenAgentView(AgentTarget{MachineID: "guest:" + access.ID(), PaneID: "w1:p2"}, "guest-view")
		return err == nil
	})
	if !view.Guest || view.GuestOwner != "Jerry" {
		t.Fatalf("guest view %+v", view)
	}
	return d, view
}

// A guest answers as the owner does (herdrup f2df68b ChatView.swift
// canAnswer, GuestPaneView.swift sendMenuKey): the chat's answer and the
// menu keys go through the guest link to the granted agent, in order.
func TestGuestAnswersAndMenuKeysGoThroughTheGuestLink(t *testing.T) {
	owner := &guestOwnerHost{status: "blocked", seq: 4}
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		t.Fatal(err)
	}
	relay.Handle = owner.handle
	d, view := openGuestAgent(t, relay, guest.SystemClock)
	ctx := context.Background()

	reply, err := d.ChatAnswer(ctx, view.Token, "q1", "Yes")
	if err != nil || reply.Status != "answered" || reply.Code != "" || reply.OwnerAnswers {
		t.Fatalf("guest answer: %+v, %v", reply, err)
	}
	for _, key := range []string{"Down", "Enter"} {
		if _, err := d.GuestMenuKey(ctx, view.Token, key); err != nil {
			t.Fatalf("menu key %s: %v", key, err)
		}
	}
	answers, keys := owner.sent()
	if want := []map[string]any{{"target": "w1:p2", "ask_id": "q1", "option": "Yes"}}; !reflect.DeepEqual(answers, want) {
		t.Errorf("owner's herdr got answers %v, want %v", answers, want)
	}
	if want := [][]string{{"down"}, {"enter"}}; !reflect.DeepEqual(keys, want) {
		t.Errorf("owner's herdr got keys %v, want %v", keys, want)
	}

	// Enter chose and the agent moved on: herdr refuses the next key, and
	// that refusal is the race it looks like, not an older host.
	if _, err := d.GuestMenuKey(ctx, view.Token, "Down"); err != nil {
		t.Fatalf("key after the menu closed: %v", err)
	}
	// Only the bar's keys leave the page; nothing types text.
	if _, err := d.GuestMenuKey(ctx, view.Token, "a"); err == nil {
		t.Error("a text key was sent as a menu key")
	}
	if _, keys := owner.sent(); len(keys) != 2 {
		t.Errorf("refused keys reached the pane: %v", keys)
	}
}

// A herdr older than guest answers refuses both with guest_forbidden: the
// page learns the host keeps answers for the owner and waits for them
// (ChatView.swift:153-155, GuestPaneView.swift:806-808).
func TestGuestOnAnOlderHostWaitsForTheOwner(t *testing.T) {
	owner := &guestOwnerHost{status: "blocked", seq: 4}
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		t.Fatal(err)
	}
	relay.Handle, relay.OwnerOnlyAnswers = owner.handle, true
	d, view := openGuestAgent(t, relay, guest.SystemClock)
	ctx := context.Background()

	reply, err := d.ChatAnswer(ctx, view.Token, "q1", "Yes")
	if err != nil || reply.Code != "guest_forbidden" || !reply.OwnerAnswers {
		t.Fatalf("answer on an older host: %+v, %v", reply, err)
	}
	// A refused key while the agent is still blocked on it says the same
	// (GuestPaneView.sendMenuKey: refresh, then isBlocked).
	if reply, err := d.GuestMenuKey(ctx, view.Token, "Enter"); err != nil || !reply.OwnerAnswers {
		t.Fatalf("menu key on an older host: %+v, %v", reply, err)
	}
	if answers, keys := owner.sent(); len(answers) != 0 || len(keys) != 0 {
		t.Errorf("an older host passed a guest's answer on: %v %v", answers, keys)
	}
}

// A refused key on an agent that no longer waits (its menu closed, the key
// raced it) learns nothing about the host.
func TestGuestKeyRefusedWhenNoLongerBlockedLearnsNothing(t *testing.T) {
	owner := &guestOwnerHost{status: "working", seq: 5}
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		t.Fatal(err)
	}
	relay.Handle = owner.handle
	d, view := openGuestAgent(t, relay, guest.SystemClock)
	if reply, err := d.GuestMenuKey(context.Background(), view.Token, "Down"); err != nil || reply.OwnerAnswers {
		t.Fatalf("a key refused by an agent that moved on: %+v, %v", reply, err)
	}
	if _, keys := owner.sent(); len(keys) != 0 {
		t.Errorf("the refused key reached the pane: %v", keys)
	}
}

// A current host pauses a guest's keys after a committing one until the
// agent's state moves on, while agent.list can still show the old menu
// (herdr #352 guest_gate). Once this page has seen a guest key go through,
// that refusal is the pause, not a host that keeps answers for the owner
// (PR #90 review): Enter then a quick Down must not stop the guest answering.
func TestGuestKeyAfterACommitIsNotAnOlderHost(t *testing.T) {
	owner := &guestOwnerHost{status: "blocked", seq: 4, lagging: true}
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		t.Fatal(err)
	}
	relay.Handle = owner.handle
	d, view := openGuestAgent(t, relay, guest.SystemClock)
	ctx := context.Background()
	if _, err := d.GuestMenuKey(ctx, view.Token, "Enter"); err != nil {
		t.Fatalf("committing key: %v", err)
	}
	if reply, err := d.GuestMenuKey(ctx, view.Token, "Down"); err != nil || reply.OwnerAnswers {
		t.Fatalf("key during herdr's pause read as an older host: %+v, %v", reply, err)
	}
	if reply, err := d.ChatAnswer(ctx, view.Token, "q1", "Yes"); err != nil || reply.OwnerAnswers {
		t.Fatalf("answer after the pause read as an older host: %+v, %v", reply, err)
	}
	if _, keys := owner.sent(); !reflect.DeepEqual(keys, [][]string{{"enter"}}) {
		t.Errorf("the refused key reached the pane: %v", keys)
	}
}

// herdr takes no guest keys on a free-text prompt (guest_gate.rs
// awaits_menu_input), and its guest view hides the prompt kind, so that
// refusal reads as an older host here as in native (GuestPaneView
// isBlocked): the keys hide. The chat's answer still goes through and says
// otherwise.
func TestGuestKeyOnAFreeTextPromptReadsAsNative(t *testing.T) {
	owner := &guestOwnerHost{status: "blocked", seq: 4, prompt: "free_text"}
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		t.Fatal(err)
	}
	relay.Handle = owner.handle
	d, view := openGuestAgent(t, relay, guest.SystemClock)
	ctx := context.Background()
	if reply, err := d.GuestMenuKey(ctx, view.Token, "Down"); err != nil || !reply.OwnerAnswers {
		t.Fatalf("key on a free-text prompt: %+v, %v", reply, err)
	}
	if reply, err := d.ChatAnswer(ctx, view.Token, "q1", "Yes"); err != nil || reply.OwnerAnswers || reply.Status != "answered" {
		t.Fatalf("answer on the same host: %+v, %v", reply, err)
	}
}
