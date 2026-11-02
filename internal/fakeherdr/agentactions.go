package fakeherdr

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sync"
	"time"
)

// AgentActions answers the agent menus' methods on the served roster:
// agent.rename, agent.archive, pane.close, a plain agent.restart and, when
// transfer is on, agent.transfer_session. Each changes the roster as herdr
// would and is recorded; fixture.agent_actions.calls returns the record so
// a smoke probe can assert what the app sent. It runs no process.
type AgentActions struct {
	mu       sync.Mutex
	get      func() []byte
	set      func([]byte)
	transfer bool
	next     int
	calls    []AgentActionCall
}

// AgentActionCall is one answered request: its method and params as sent.
type AgentActionCall struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// NewAgentActions serves the actions on the agent.list result get returns
// and set replaces. transfer serves agent.transfer_session.
func NewAgentActions(get func() []byte, set func([]byte), transfer bool) *AgentActions {
	return &AgentActions{get: get, set: set, transfer: transfer}
}

// Transfer reports whether agent.transfer_session is served, for ping's
// agent_session_transfer.
func (x *AgentActions) Transfer() bool { return x.transfer }

// Calls returns every request answered, in order.
func (x *AgentActions) Calls() []AgentActionCall {
	x.mu.Lock()
	defer x.mu.Unlock()
	return slices.Clone(x.calls)
}

// agentName is herdr's name grammar (src/app/api/agents.rs).
var agentName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

func (x *AgentActions) Handle(method string, raw json.RawMessage) (any, *APIError, bool) {
	switch method {
	case "agent.rename", "agent.archive", "pane.close", "agent.restart":
	case "agent.transfer_session":
		if !x.transfer {
			return nil, nil, false
		}
	case "fixture.agent_actions.calls":
		return map[string]any{"calls": x.Calls()}, nil, true
	default:
		return nil, nil, false
	}
	var p struct {
		Target     string  `json:"target"`
		PaneID     string  `json:"pane_id"`
		Name       *string `json:"name"`
		Reason     *string `json:"reason"`
		By         *string `json:"by"`
		Account    *string `json:"account"`
		To         string  `json:"to"`
		TransferID *string `json:"transfer_id"`
		Confirm    bool    `json:"confirm"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, &APIError{Code: "invalid_request", Message: err.Error()}, true
		}
	}
	if method == "agent.restart" && p.Account != nil {
		return nil, nil, false // a swap: the -accounts fixture's
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	var roster struct {
		Type   string           `json:"type"`
		Agents []map[string]any `json:"agents"`
	}
	if err := json.Unmarshal(x.get(), &roster); err != nil {
		return nil, &APIError{Code: "internal", Message: "fixture roster: " + err.Error()}, true
	}
	target := p.Target
	if method == "pane.close" {
		target = p.PaneID
	}
	i := slices.IndexFunc(roster.Agents, func(a map[string]any) bool {
		return target != "" && (a["pane_id"] == target || a["terminal_id"] == target || a["name"] == target)
	})
	if i < 0 {
		if method == "pane.close" {
			return nil, nil, false // not a roster agent's pane
		}
		return nil, &APIError{Code: "agent_not_found", Message: "no agent " + target}, true
	}
	x.calls = append(x.calls, AgentActionCall{Method: method, Params: append(json.RawMessage(nil), raw...)})
	agent := roster.Agents[i]
	var reply any
	switch method {
	case "agent.rename":
		name := ""
		if p.Name != nil {
			name = *p.Name
		}
		if !agentName.MatchString(name) {
			return nil, &APIError{Code: "invalid_agent_name", Message: "agent names are ^[a-z][a-z0-9_-]{0,31}$"}, true
		}
		if slices.ContainsFunc(roster.Agents, func(a map[string]any) bool { return a["name"] == name && a["pane_id"] != agent["pane_id"] }) {
			return nil, &APIError{Code: "agent_name_taken", Message: "an agent is already named " + name}, true
		}
		agent["name"] = name
	case "agent.archive":
		if agent["agent_status"] == "working" {
			return nil, &APIError{Code: "agent_busy", Message: "agent is mid-turn; archive with force"}, true
		}
		archived := map[string]any{"at": time.Now().UTC().Format(time.RFC3339), "by": "api"}
		if p.By != nil {
			archived["by"] = *p.By
		}
		if p.Reason != nil {
			archived["reason"] = *p.Reason
		}
		agent["archived"] = archived
	case "pane.close":
		roster.Agents = slices.Delete(roster.Agents, i, i+1)
		reply = map[string]any{"type": "ok"}
	case "agent.restart":
		agent["agent_status"] = "idle"
	case "agent.transfer_session":
		var err *APIError
		if agent, err = x.transferLocked(agent, p.To, p.Account, p.TransferID, p.Confirm); err != nil {
			return nil, err, true
		}
		roster.Agents[i] = agent
	}
	if reply == nil {
		reply = map[string]any{"type": "agent_info", "agent": agent}
	}
	data, err := json.Marshal(roster)
	if err != nil {
		return nil, &APIError{Code: "internal", Message: err.Error()}, true
	}
	x.set(data)
	return reply, nil, true
}

// transferLocked prepares a transfer to harness to (ready at once), or
// confirms the prepared one, which completes it: the agent then runs as to.
func (x *AgentActions) transferLocked(agent map[string]any, to string, account, id *string, confirm bool) (map[string]any, *APIError) {
	if agent["machine_id"] != nil {
		return nil, &APIError{Code: "unsupported", Message: "session transfer is local only"}
	}
	source, _ := agent["agent"].(string)
	harnesses := []string{"claude", "codex", "omp"}
	if !slices.Contains(harnesses, source) || !slices.Contains(harnesses, to) || source == to {
		return nil, &APIError{Code: "invalid_request", Message: fmt.Sprintf("cannot transfer %q to %q", source, to)}
	}
	current, _ := agent["session_transfer"].(map[string]any)
	if !confirm {
		x.next++
		transfer := map[string]any{"id": fmt.Sprintf("transfer-%d", x.next), "phase": "ready", "source": source, "target": to, "message_count": 12,
			"omissions": map[string]any{"attachment_records": 0, "metadata_records": 2, "reasoning_records": 3, "sidechain_records": 0, "system_records": 1, "tool_records": 4, "unsupported_blocks": 0}}
		if account != nil {
			transfer["target_account"] = *account
		}
		agent["session_transfer"] = transfer
		return agent, nil
	}
	if current == nil || id == nil || current["id"] != *id || current["phase"] != "ready" {
		return nil, &APIError{Code: "transfer_not_found", Message: "no prepared transfer with that id"}
	}
	current["phase"] = "completed"
	agent["agent"] = to
	if account != nil {
		agent["account"] = *account
	} else {
		delete(agent, "account")
	}
	return agent, nil
}
