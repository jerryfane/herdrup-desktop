// Package herdr holds the parts of the herdr API the spike uses: wire types
// for ping, agent.list and events, and the status-board grouping of the
// herdrup iOS app. Issue #2 replaces the hand-written types with ones
// generated from herdr's schema.
package herdr

import "encoding/json"

// Pong is the result of `ping`.
type Pong struct {
	Version      string       `json:"version"`
	Protocol     uint32       `json:"protocol"`
	Capabilities Capabilities `json:"capabilities"`
}

// Capabilities are the optional features a herdr advertises in its pong.
type Capabilities struct {
	APIBridgeMulti bool `json:"api_bridge_multi"`
	EventsV2       bool `json:"events_v2"`
}

// AgentList is the result of `agent.list`.
type AgentList struct {
	Agents []AgentInfo `json:"agents"`
}

// AgentInfo is one agent as `agent.list` reports it. Only the fields the
// board shows are decoded.
type AgentInfo struct {
	PaneID      string  `json:"pane_id"`
	AgentStatus *string `json:"agent_status"`
	// LastKnownStatus is a federated peer's last status, kept while the
	// peer's live status reads "unknown".
	LastKnownStatus       *string            `json:"last_known_status"`
	InputPending          bool               `json:"input_pending"`
	Name                  *string            `json:"name"`
	Agent                 *string            `json:"agent"`
	TerminalTitleStripped *string            `json:"terminal_title_stripped"`
	Cwd                   *string            `json:"cwd"`
	MachineID             *string            `json:"machine_id"`
	MachineLabel          *string            `json:"machine_label"`
	Reachability          *string            `json:"reachability"`
	Archived              json.RawMessage    `json:"archived"`
	LastCompletedTurn     *LastCompletedTurn `json:"last_completed_turn"`
}

// LastCompletedTurn is the agent's most recent finished turn.
type LastCompletedTurn struct {
	CompletedUnixMs int64 `json:"completed_unix_ms"`
}

// IsArchived reports whether herdr marked the agent archived.
func (a AgentInfo) IsArchived() bool {
	return len(a.Archived) > 0 && string(a.Archived) != "null"
}

// SubscribeParams are the params of `events.subscribe`.
type SubscribeParams struct {
	Subscriptions []Subscription `json:"subscriptions"`
	EventsV2      bool           `json:"events_v2"`
}

// Subscription selects one event type for every pane.
type Subscription struct {
	Type string `json:"type"`
}

// BoardSubscriptions are the events that change the agent board: status
// changes, finished turns, and panes or agents appearing and going away.
// They are the iOS app's subscription list.
var BoardSubscriptions = []Subscription{
	{"pane.agent_status_changed"},
	{"pane.turn_completed"},
	{"pane.created"},
	{"pane.closed"},
	{"pane.exited"},
	{"pane.agent_detected"},
}

// StreamLine is one line of an events.subscribe stream: the
// acknowledgement, an event, or a control line.
type StreamLine struct {
	// ID and Result or Error are set on the acknowledgement.
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	// Event names an event line.
	Event string `json:"event"`
	// Control is "lagged" or "heartbeat".
	Control string `json:"control"`
}
