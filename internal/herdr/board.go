package herdr

import (
	"path"
	"sort"
	"strings"
	"unicode"
)

// Group is a section of the status board. The order is the board's point:
// what needs you comes first and quiet agents last.
type Group int

const (
	NeedsYou Group = iota
	Stopped
	// Unrecognised holds statuses this build cannot read. It sorts above
	// working and idle so a new or missing state is seen, not buried.
	Unrecognised
	Working
	Idle
)

var groupLabels = [...]string{"needs you", "stopped", "unrecognised", "working", "idle"}

// Label is the section heading.
func (g Group) Label() string { return groupLabels[g] }

// Key is the section's stable name for the frontend.
func (g Group) Key() string {
	return [...]string{"needsYou", "stopped", "unrecognised", "working", "idle"}[g]
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// GroupOf places an agent the way the iOS app does (HerdrKit
// AgentRow.resolvedGroup). live is false for a pane that is gone.
func GroupOf(a AgentInfo, live bool) Group {
	if !live {
		return Stopped
	}
	if a.InputPending || str(a.AgentStatus) == "blocked" {
		return NeedsYou
	}
	if a.AgentStatus == nil {
		return Unrecognised
	}
	switch *a.AgentStatus {
	case "working":
		return Working
	case "idle", "done":
		return Idle
	case "unknown":
		// A federated peer's live status is blanked to unknown when it
		// drops; its last known blocked still needs you.
		if str(a.LastKnownStatus) == "blocked" {
			return NeedsYou
		}
	}
	return Unrecognised
}

// Row is one agent on the board.
type Row struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Agent  string `json:"agent"`
	Status string `json:"status"`
	// Detail is the agent's current activity, or its folder.
	Detail string `json:"detail"`
	// Done marks an idle agent whose last turn finished (shown green).
	Done bool `json:"done"`
	// Offline marks a federated agent whose machine is unreachable.
	Offline bool `json:"offline"`
}

// Section is one group of rows.
type Section struct {
	Key       string `json:"key"`
	Label     string `json:"label"`
	Collapsed bool   `json:"collapsed"`
	Rows      []Row  `json:"rows"`
}

// Board is the status board for one machine.
type Board struct {
	Sections []Section `json:"sections"`
	Archived []Row     `json:"archived"`
	NeedsYou int       `json:"needsYou"`
	Total    int       `json:"total"`
}

// BuildBoard groups and orders agents: by group, then most recently
// finished turn first, then pane id so unchanged data never reshuffles.
func BuildBoard(agents []AgentInfo) Board {
	type entry struct {
		info  AgentInfo
		group Group
	}
	var live []entry
	b := Board{Sections: []Section{}, Archived: []Row{}}
	for _, a := range agents {
		if a.IsArchived() {
			b.Archived = append(b.Archived, rowOf(a))
			continue
		}
		live = append(live, entry{a, GroupOf(a, true)})
	}
	completed := func(a AgentInfo) int64 {
		if a.LastCompletedTurn == nil {
			return -1 << 63
		}
		return a.LastCompletedTurn.CompletedUnixMs
	}
	sort.SliceStable(live, func(i, j int) bool {
		a, b := live[i], live[j]
		if a.group != b.group {
			return a.group < b.group
		}
		if ta, tb := completed(a.info), completed(b.info); ta != tb {
			return ta > tb
		}
		return a.info.PaneID < b.info.PaneID
	})
	for _, e := range live {
		n := len(b.Sections)
		if n == 0 || b.Sections[n-1].Key != e.group.Key() {
			b.Sections = append(b.Sections, Section{
				Key: e.group.Key(), Label: e.group.Label(), Collapsed: e.group == Idle,
			})
			n++
		}
		b.Sections[n-1].Rows = append(b.Sections[n-1].Rows, rowOf(e.info))
		if e.group == NeedsYou {
			b.NeedsYou++
		}
	}
	b.Total = len(live)
	return b
}

func rowOf(a AgentInfo) Row {
	detail := Activity(str(a.TerminalTitleStripped))
	if detail == "" && a.Cwd != nil {
		detail = path.Base(*a.Cwd)
	}
	return Row{
		ID:      a.PaneID,
		Title:   DisplayName(a),
		Agent:   str(a.Agent),
		Status:  str(a.AgentStatus),
		Detail:  detail,
		Done:    str(a.AgentStatus) == "done",
		Offline: str(a.Reachability) == "unreachable",
	}
}

// DisplayName is the agent's name, falling back to its terminal title and
// pane id. A federated agent's machine alias is replaced by the machine's
// label.
func DisplayName(a AgentInfo) string {
	raw := str(a.Name)
	if raw == "" {
		raw = str(a.TerminalTitleStripped)
	}
	if raw == "" {
		raw = a.PaneID
	}
	id, label := str(a.MachineID), str(a.MachineLabel)
	if id == "" || label == "" || !strings.HasPrefix(raw, id+"/") {
		return raw
	}
	return label + "/" + strings.TrimPrefix(raw, id+"/")
}

// Activity strips the prompt and spinner glyphs agents put at the start of
// their terminal title ("π > reading files" becomes "reading files").
func Activity(title string) string {
	rest := title
	sawPrompt := false
	for {
		rest = strings.TrimLeftFunc(rest, unicode.IsSpace)
		token, _, _ := strings.Cut(rest, " ")
		isPrompt := token == "π"
		if token == "" || !(isPrompt || isSpinner(token) || (sawPrompt && token == ">")) {
			return rest
		}
		sawPrompt = sawPrompt || isPrompt
		rest = rest[len(token):]
	}
}

func isSpinner(token string) bool {
	for _, r := range token {
		if !(r >= 0x2800 && r <= 0x28FF) && !strings.ContainsRune("✳✶✻✽✢✱", r) {
			return false
		}
	}
	return true
}
