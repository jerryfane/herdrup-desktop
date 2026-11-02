package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

func TestAgentStartWaitsOnlyForInitializingShell(t *testing.T) {
	for _, owned := range []bool{true, false} {
		name := "foreground-job"
		if owned {
			name = "initializing-shell"
		}
		t.Run(name, func(t *testing.T) {
			var starts atomic.Int32
			_, client := start(t, nil, func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
				switch method {
				case "agent.start":
					if starts.Add(1) == 1 {
						return nil, &fakeherdr.APIError{Code: "agent_pane_busy", Message: "foreground is busy"}
					}
					return map[string]any{"type": "agent_started", "agent": map[string]any{"pane_id": "new-pane", "name": "worker", "agent_status": "idle"}}, nil
				case "pane.process_info":
					group := 42
					if !owned {
						group = 81
					}
					return map[string]any{"type": "pane_process_info", "process_info": map[string]any{"pane_id": "new-pane", "shell_pid": 42, "foreground_process_group_id": group, "foreground_processes": []any{map[string]any{"pid": 42, "name": "-bash"}}}}, nil
				}
				return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
			}, nil)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			agent, err := client.StartAgentWhenShellReady(ctx, "worker", "claude", "new-pane")
			if owned {
				if err != nil || agent.PaneID != "new-pane" || starts.Load() != 2 {
					t.Fatalf("shell readiness: %+v %v starts=%d", agent, err, starts.Load())
				}
			} else {
				var busy *bridge.APIError
				if !errors.As(err, &busy) || busy.Code != "agent_pane_busy" || starts.Load() != 1 {
					t.Fatalf("foreground job was retried: %v starts=%d", err, starts.Load())
				}
			}
		})
	}
}

func TestAgentStartRechecksForegroundBeforeRetry(t *testing.T) {
	var starts, checks atomic.Int32
	_, client := start(t, nil, func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
		if method == "agent.start" {
			starts.Add(1)
			return nil, &fakeherdr.APIError{Code: "agent_pane_busy", Message: "busy"}
		}
		if method == "pane.process_info" {
			group := 42
			if checks.Add(1) > 1 {
				group = 91
			}
			return map[string]any{"type": "pane_process_info", "process_info": map[string]any{"pane_id": "new-pane", "shell_pid": 42, "foreground_process_group_id": group, "foreground_processes": []any{map[string]any{"pid": 42, "name": "bash"}}}}, nil
		}
		return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
	}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := client.StartAgentWhenShellReady(ctx, "worker", "claude", "new-pane")
	var busy *bridge.APIError
	if !errors.As(err, &busy) || busy.Code != "agent_pane_busy" || starts.Load() != 1 || checks.Load() != 2 {
		t.Fatalf("ownership change not respected: %v starts=%d checks=%d", err, starts.Load(), checks.Load())
	}
}
