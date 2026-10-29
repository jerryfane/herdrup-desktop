package live

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func info(t *testing.T, js string) herdrapi.AgentInfo {
	t.Helper()
	var a herdrapi.AgentInfo
	if err := json.Unmarshal([]byte(js), &a); err != nil {
		t.Fatal(err)
	}
	return a
}

func line(event, data string) herdrapi.SubscriptionStreamEvent {
	return herdrapi.SubscriptionStreamEvent{Event: event, Data: json.RawMessage(data)}
}

func TestDecode(t *testing.T) {
	c, reload := Decode(line("pane.agent_status_changed", `{"pane_id":"p","agent_status":"blocked","input_pending":true,"input_prompt_kind":"permission","agent":"pi","turn":4,"turn_epoch":2}`))
	if reload || c == nil || c.Turn || c.PaneID != "p" || c.Status != "blocked" || !c.InputPending || c.PromptKind == nil || *c.PromptKind != "permission" || *c.Agent != "pi" || *c.TurnN != 4 || *c.TurnEpoch != 2 {
		t.Fatalf("status change: %+v %v", c, reload)
	}
	c, _ = Decode(line("pane_turn_completed", `{"pane":{"pane_id":"p","agent_status":"done","agent":"pi"},"turn":5,"turn_epoch":2,"completed_unix_ms":77,"outcome":"completed"}`))
	if c == nil || !c.Turn || c.PaneID != "p" || c.Status != "done" || c.InputPending || *c.TurnN != 5 || c.CompletedUnixMs != 77 {
		t.Fatalf("turn: %+v", c)
	}
	for _, k := range []string{"pane_created", "pane.closed", "pane_exited", "pane.agent_detected"} {
		if c, reload := Decode(line(k, `{}`)); c != nil || !reload {
			t.Errorf("%s: %v %v, want a reload", k, c, reload)
		}
	}
	if c, reload := Decode(line("layout_updated", `{}`)); c != nil || reload {
		t.Errorf("unknown kind: %v %v", c, reload)
	}
}

func TestApplyStatusSetsSinceOnlyOnAChange(t *testing.T) {
	at := time.UnixMilli(5000)
	a := info(t, `{"pane_id":"p","agent_status":"working","status_since_unix_ms":10,"input_pending":true,"turn":1}`)
	same := Change{PaneID: "p", Status: "working"}.Apply(a, at)
	if *same.StatusSinceUnixMs != 10 || *same.InputPending || *same.Turn != 1 {
		t.Errorf("unchanged status: since %d pending %v turn %d", *same.StatusSinceUnixMs, *same.InputPending, *same.Turn)
	}
	n := uint64(2)
	moved := Change{PaneID: "p", Status: "blocked", InputPending: true, TurnN: &n}.Apply(a, at)
	if moved.AgentStatus != "blocked" || *moved.StatusSinceUnixMs != 5000 || !*moved.InputPending || *moved.Turn != 2 {
		t.Errorf("changed status: %+v", moved)
	}
	if *a.StatusSinceUnixMs != 10 || a.AgentStatus != "working" {
		t.Error("Apply changed the row it was given")
	}
}

func TestApplyTurn(t *testing.T) {
	at := time.UnixMilli(5000)
	a := info(t, `{"pane_id":"p","agent_status":"blocked","input_pending":true,"last_completed_turn":{"turn":1,"turn_epoch":1,"completed_unix_ms":40}}`)
	turn, epoch := uint64(3), uint64(1)
	// No status in the snapshot: the prompt stays, the turn moves, and a
	// missing completion time keeps the previous one.
	got := Change{Turn: true, PaneID: "p", TurnN: &turn, TurnEpoch: &epoch}.Apply(a, at)
	if got.AgentStatus != "blocked" || !*got.InputPending || *got.Turn != 3 || got.LastCompletedTurn.Turn != 3 || got.LastCompletedTurn.CompletedUnixMs != 40 {
		t.Errorf("turn without status: %+v %+v", got, got.LastCompletedTurn)
	}
	got = Change{Turn: true, PaneID: "p", Status: "done", TurnN: &turn, TurnEpoch: &epoch, CompletedUnixMs: 90}.Apply(a, at)
	if got.AgentStatus != "done" || *got.InputPending || got.LastCompletedTurn.CompletedUnixMs != 90 {
		t.Errorf("turn with status: %+v %+v", got, got.LastCompletedTurn)
	}
}

func TestEffectOf(t *testing.T) {
	agents := []herdrapi.AgentInfo{info(t, `{"pane_id":"a","agent_status":"idle"}`)}
	at := time.Now()
	if e, p := (Change{PaneID: "a", Status: "working"}).EffectOf(agents, at); e != Patch || p[0].AgentStatus != "working" || agents[0].AgentStatus != "idle" {
		t.Errorf("listed: %v %+v", e, p)
	}
	pi := "pi"
	if e, _ := (Change{PaneID: "b", Agent: &pi}).EffectOf(agents, at); e != ReloadUnlisted {
		t.Errorf("unlisted agent pane: %v", e)
	}
	if e, _ := (Change{PaneID: "b"}).EffectOf(agents, at); e != Ignore {
		t.Errorf("plain shell: %v", e)
	}
	if e, _ := (Change{Agent: &pi}).EffectOf(agents, at); e != Ignore {
		t.Errorf("no pane: %v", e)
	}
}

func TestLedgerKeepsChangesALateListWouldUndo(t *testing.T) {
	var l ledger
	at := time.UnixMilli(1)
	l.record(Change{PaneID: "a", Status: "working"}, at) // before the list started
	mark := l.mark()
	l.record(Change{PaneID: "a", Status: "blocked"}, at) // while it was in flight
	l.record(Change{PaneID: "zz", Status: "blocked"}, at)
	stale := []herdrapi.AgentInfo{info(t, `{"pane_id":"a","agent_status":"idle"}`)}
	l.settle(mark)
	got := l.replay(stale, mark)
	if got[0].AgentStatus != "blocked" || len(got) != 1 {
		t.Fatalf("replayed %+v", got)
	}
	if len(l.entries) != 2 {
		t.Errorf("settle kept %d entries, want the 2 after the mark", len(l.entries))
	}
	for range ledgerCapacity + 10 {
		l.record(Change{PaneID: "a"}, at)
	}
	if len(l.entries) != ledgerCapacity || l.entries[len(l.entries)-1].index != l.mark() {
		t.Errorf("capacity: %d entries", len(l.entries))
	}
}

func TestUnlistedReloadsOncePerPaneUntilALaterListPublishes(t *testing.T) {
	u := unlistedReloads{}
	t0 := time.Unix(100, 0)
	if !u.request("p", t0) || u.request("p", t0.Add(time.Second)) {
		t.Fatal("second request for the same pane was allowed")
	}
	u.published(t0) // started at the same instant: not after the request
	if u.request("p", t0.Add(2*time.Second)) {
		t.Fatal("a list that did not start after the request answered it")
	}
	u.published(t0.Add(3 * time.Second))
	if !u.request("p", t0.Add(4*time.Second)) {
		t.Fatal("a later list did not clear the request")
	}
}
