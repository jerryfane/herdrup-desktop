package main

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

func updateCheckFixture(mode string, commit int64) map[string]any {
	return map[string]any{"type": "update_check", "running": map[string]any{"version": "0.9.5", "build_id": "old", "protocol": 22},
		"latest": map[string]any{"version": "0.9.6", "build_id": "new", "commit": "abc", "commit_time": commit, "built_at": "2026-10-31", "protocol": 22, "size": 1024, "notes": "A signed update"},
		"mode":   mode, "update_available": true}
}

func updateSettingsDesk(t *testing.T, updates func(string, json.RawMessage) (any, *fakeherdr.APIError)) *Desk {
	t.Helper()
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		previous := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "ping" {
				pong := fakeherdr.Pong(true)
				pong["capabilities"].(map[string]bool)["server_update"] = true
				return pong, nil
			}
			if method == "server.update_check" || method == "server.update_status" || method == "server.update_apply" {
				return updates(method, raw)
			}
			return previous(method, raw)
		}
	})
	b := d.Board()
	if err := d.OpenSettings(b.MachineID, b.Session, "updates"); err != nil {
		t.Fatal(err)
	}
	return d
}

func updateState(t *testing.T, d *Desk, refresh bool) serverUpdateState {
	t.Helper()
	raw, err := d.SettingsServerUpdate(context.Background(), "updates", refresh)
	if err != nil {
		t.Fatal(err)
	}
	var state serverUpdateState
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestServerUpdateRequiresConfirmedBuildAndLiveScope(t *testing.T) {
	var applies atomic.Int32
	d := updateSettingsDesk(t, func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
		switch method {
		case "server.update_check":
			return updateCheckFixture("restart_required", updateMinCommitTime), nil
		case "server.update_status":
			if applies.Load() == 0 {
				return map[string]any{"type": "update_status", "attempt": nil}, nil
			}
			return map[string]any{"type": "update_status", "attempt": map[string]any{"attempt_id": "ours", "build_id": "new", "from": "0.9.5", "to": "0.9.6", "phase": "installing", "restart_later": true, "outcome": "downloaded_restart_required"}}, nil
		case "server.update_apply":
			var params struct {
				BuildID      string `json:"build_id"`
				RestartLater bool   `json:"restart_later"`
			}
			if err := json.Unmarshal(raw, &params); err != nil || params.BuildID != "new" || !params.RestartLater {
				t.Errorf("unsafe apply parameters: %s", raw)
			}
			applies.Add(1)
			return map[string]any{"type": "update_apply", "attempt_id": "ours"}, nil
		}
		return nil, &fakeherdr.APIError{Code: "unknown_method"}
	})
	updateState(t, d, true)
	ctx := context.Background()
	for _, request := range []struct {
		build   string
		restart bool
	}{{"other", true}, {"new", false}} {
		if err := d.ApplySettingsServerUpdate(ctx, "updates", request.build, request.restart); err == nil {
			t.Fatal("unconfirmed build or restart mode accepted")
		}
	}
	if applies.Load() != 0 {
		t.Fatal("a rejected confirmation reached the server")
	}
	if err := d.ApplySettingsServerUpdate(ctx, "updates", "new", true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "downloaded update", func() bool { return updateState(t, d, false).Flow == "finished" })
	if err := d.ApplySettingsServerUpdate(ctx, "updates", "new", true); err == nil {
		t.Fatal("pending restart was downloaded twice")
	}
	d.CloseSettings("updates")
	if err := d.ApplySettingsServerUpdate(ctx, "updates", "new", true); err == nil {
		t.Fatal("closed Settings scope could install")
	}
	if applies.Load() != 1 {
		t.Fatalf("applies = %d", applies.Load())
	}
}

func TestServerUpdateFollowsLostReplyWithoutAdoptingPreviousAttempt(t *testing.T) {
	var mu sync.Mutex
	current := "previous"
	entered, release := make(chan struct{}), make(chan struct{})
	var applies atomic.Int32
	var oldPolls atomic.Int32
	d := updateSettingsDesk(t, func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
		switch method {
		case "server.update_check":
			return updateCheckFixture("live", updateMinCommitTime), nil
		case "server.update_status":
			mu.Lock()
			id := current
			mu.Unlock()
			if applies.Load() > 0 && id == "previous" {
				oldPolls.Add(1)
			}
			return map[string]any{"type": "update_status", "attempt": map[string]any{"attempt_id": id, "build_id": "new", "from": "0.9.5", "to": "0.9.6", "phase": "installing", "outcome": "updated"}}, nil
		case "server.update_apply":
			applies.Add(1)
			close(entered)
			<-release
			return map[string]any{"type": "update_apply", "attempt_id": "ours"}, nil
		}
		return nil, &fakeherdr.APIError{Code: "unknown_method"}
	})
	updateState(t, d, true)
	result := make(chan error, 1)
	go func() { result <- d.ApplySettingsServerUpdate(context.Background(), "updates", "new", false) }()
	<-entered
	d.CloseSettings("updates") // cancel the caller after the request reached herdr
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	close(release)
	machine, err := d.Machine()
	if err != nil {
		t.Fatal(err)
	}
	d.Disconnect()
	if err := d.Connect(*machine, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "reconnected board", func() bool { return d.Board() != nil })
	b := d.Board()
	if err := d.OpenSettings(b.MachineID, b.Session, "updates"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "poll of the previous attempt", func() bool { return oldPolls.Load() > 0 })
	state := updateState(t, d, false)
	if state.Flow != "running" || state.Attempt != nil {
		t.Fatalf("adopted a completed previous attempt: %+v", state)
	}
	if err := d.ApplySettingsServerUpdate(context.Background(), "updates", "new", false); err == nil {
		t.Fatal("uncertain apply was repeated")
	}
	mu.Lock()
	current = "ours"
	mu.Unlock()
	waitFor(t, "same-machine handoff outcome", func() bool { return updateState(t, d, false).Flow == "finished" })
	state = updateState(t, d, false)
	if state.Attempt == nil || state.Attempt.AttemptID != "ours" || applies.Load() != 1 {
		t.Fatalf("wrong resumed attempt: %+v; applies=%d", state, applies.Load())
	}
}

func TestServerUpdateRejectsUnsupportedAndUnpublishedOffers(t *testing.T) {
	for _, tc := range []struct {
		name, mode string
		commit     int64
	}{
		{"unsupported", "unsupported", updateMinCommitTime},
		{"unknown mode", "future_mode", updateMinCommitTime},
		{"unpublished required features", "live", updateMinCommitTime - 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var applies atomic.Int32
			d := updateSettingsDesk(t, func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
				if method == "server.update_check" {
					return updateCheckFixture(tc.mode, tc.commit), nil
				}
				if method == "server.update_status" {
					return map[string]any{"type": "update_status", "attempt": nil}, nil
				}
				applies.Add(1)
				return nil, &fakeherdr.APIError{Code: "unexpected_apply"}
			})
			updateState(t, d, true)
			if err := d.ApplySettingsServerUpdate(context.Background(), "updates", "new", false); err == nil {
				t.Fatal("unsafe update was offered")
			}
			if applies.Load() != 0 {
				t.Fatal("unsafe request reached herdr")
			}
		})
	}
}

func TestServerUpdateRecheckFollowsExistingAttempt(t *testing.T) {
	var started, finished atomic.Bool
	var applies atomic.Int32
	d := updateSettingsDesk(t, func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
		switch method {
		case "server.update_check":
			return updateCheckFixture("live", updateMinCommitTime), nil
		case "server.update_status":
			var attempt any
			if started.Load() {
				a := map[string]any{"attempt_id": "another-device", "build_id": "new", "from": "0.9.5", "to": "0.9.6", "phase": "switching"}
				if finished.Load() {
					a["outcome"] = "updated"
				}
				attempt = a
			}
			return map[string]any{"type": "update_status", "attempt": attempt}, nil
		case "server.update_apply":
			applies.Add(1)
			started.Store(true)
			return nil, &fakeherdr.APIError{Code: "update_in_progress", Message: "Another device started the update"}
		}
		return nil, &fakeherdr.APIError{Code: "unknown_method"}
	})
	updateState(t, d, true)
	ctx := context.Background()
	if err := d.ApplySettingsServerUpdate(ctx, "updates", "new", false); err != nil {
		t.Fatal(err)
	}
	if state := updateState(t, d, false); state.Flow != "refused" {
		t.Fatalf("missing refusal: %+v", state)
	}
	if err := d.RecheckSettingsServerUpdate(ctx, "updates", false); err != nil {
		t.Fatal(err)
	}
	state := updateState(t, d, false)
	if state.Flow != "running" || state.Attempt == nil || state.Attempt.AttemptID != "another-device" {
		t.Fatalf("did not adopt running update: %+v", state)
	}
	if err := d.ApplySettingsServerUpdate(ctx, "updates", "new", false); err == nil {
		t.Fatal("running update could be resubmitted")
	}
	finished.Store(true)
	waitFor(t, "other-device update outcome", func() bool { return updateState(t, d, false).Flow == "finished" })
	if applies.Load() != 1 {
		t.Fatalf("duplicate applies: %d", applies.Load())
	}
}
