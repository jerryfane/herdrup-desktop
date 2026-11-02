package fakeherdr

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

// Creation runs no processes and uses no provider credentials. It models pane
// ownership and a shell still starting, for real native-window creation checks.
type Creation struct {
	mu        sync.Mutex
	panes     map[string]map[string]any
	starts    map[string]int
	next      int
	calls     []string
	onStarted func(map[string]any)
}

func NewCreation(onStarted func(map[string]any)) *Creation {
	return &Creation{panes: map[string]map[string]any{}, starts: map[string]int{}, onStarted: onStarted}
}

func (c *Creation) Handle(method string, raw json.RawMessage) (any, *APIError, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, method)
	var p struct {
		Cwd    *string `json:"cwd"`
		Path   *string `json:"path"`
		PaneID string  `json:"pane_id"`
		Name   string  `json:"name"`
		Kind   string  `json:"kind"`
		Label  string  `json:"label"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, &APIError{Code: "invalid_request", Message: err.Error()}, true
		}
	}
	switch method {
	case "agent.kinds":
		return map[string]any{"type": "agent_kinds", "kinds": []any{map[string]any{"kind": "claude", "installed": true}, map[string]any{"kind": "omp", "installed": true}, map[string]any{"kind": "codex", "installed": false}}}, nil, true
	case "fs.list_dir":
		path := "/home/ci"
		if p.Path != nil {
			path = *p.Path
		}
		if path != "/home/ci" && path != "/home/ci/My Project" && path != "/home" && path != "/" {
			return nil, &APIError{Code: "not_a_directory", Message: "fixture path is not a directory"}, true
		}
		entries := []any{}
		if path == "/home/ci" {
			entries = append(entries, map[string]any{"name": "My Project", "is_dir": true}, map[string]any{"name": "notes.txt", "is_dir": false})
		}
		if path == "/" {
			entries = append(entries, map[string]any{"name": "home", "is_dir": true})
		}
		if path == "/home" {
			entries = append(entries, map[string]any{"name": "ci", "is_dir": true})
		}
		return map[string]any{"type": "dir_list", "path": path, "entries": entries}, nil, true
	case "pane.split":
		c.next++
		id := fmt.Sprintf("created-pane-%d", c.next)
		cwd := "/home/ci"
		if p.Cwd != nil {
			cwd = *p.Cwd
		}
		pane := map[string]any{"pane_id": id, "cwd": cwd, "agent_status": "idle", "focused": true, "tab_id": "creation", "terminal_id": id, "revision": 1, "width": 80, "height": 24}
		c.panes[id] = pane
		return map[string]any{"type": "pane_info", "pane": pane}, nil, true
	case "pane.process_info":
		if c.panes[p.PaneID] == nil {
			return nil, &APIError{Code: "not_found", Message: "pane is closed"}, true
		}
		return map[string]any{"type": "pane_process_info", "process_info": map[string]any{"pane_id": p.PaneID, "shell_pid": 42, "foreground_process_group_id": 42, "foreground_processes": []any{map[string]any{"pid": 42, "name": "-bash"}}}}, nil, true
	case "agent.start":
		pane := c.panes[p.PaneID]
		if pane == nil {
			return nil, &APIError{Code: "not_found", Message: "pane is closed"}, true
		}
		if p.Name == "reject" {
			return nil, &APIError{Code: "agent_name_taken", Message: "Choose another folder or agent name"}, true
		}
		c.starts[p.PaneID]++
		if c.starts[p.PaneID] == 1 {
			return nil, &APIError{Code: "agent_pane_busy", Message: "shell rc is initializing"}, true
		}
		agent := map[string]any{"pane_id": p.PaneID, "name": p.Name, "agent": p.Kind, "agent_status": "idle", "cwd": pane["cwd"], "terminal_id": p.PaneID, "tab_id": "creation", "workspace_id": "creation", "last_output": []string{"Agent is ready"}}
		pane["agent"] = p.Kind
		if c.onStarted != nil {
			c.onStarted(agent)
		}
		return map[string]any{"type": "agent_started", "agent": agent}, nil, true
	case "pane.rename":
		pane := c.panes[p.PaneID]
		if pane == nil {
			return nil, &APIError{Code: "not_found", Message: "pane is closed"}, true
		}
		pane["label"] = p.Label
		return map[string]any{"type": "pane_info", "pane": pane}, nil, true
	case "pane.close":
		if pane := c.panes[p.PaneID]; pane != nil && pane["agent"] != nil {
			return nil, &APIError{Code: "agent_running", Message: "refusing to close a started agent"}, true
		}
		delete(c.panes, p.PaneID)
		return map[string]any{"type": "ok"}, nil, true
	case "fixture.creation.state":
		panes := make([]string, 0, len(c.panes))
		labels := make(map[string]string, len(c.panes))
		for id := range c.panes {
			panes = append(panes, id)
			if label, ok := c.panes[id]["label"].(string); ok {
				labels[id] = label
			}
		}
		writes := 0
		for _, call := range c.calls {
			if call == "agent.prompt" || call == "pane.send_text" {
				writes++
			}
		}
		return map[string]any{"panes": panes, "labels": labels, "starts": c.starts, "writes": writes, "calls": strings.Join(c.calls, ",")}, nil, true
	}
	return nil, nil, false
}
