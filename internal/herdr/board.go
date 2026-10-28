package herdr

import (
	"encoding/json"
	"path"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
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

// Row is one agent on the board, with everything herdrup's agent row
// (App/HerdrApp.swift card()) draws.
type Row struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Agent  string `json:"agent"`
	Status string `json:"status"`
	// Badge is the avatar's status badge: waiting, unrecognised, stopped,
	// working, offline or none (herdrup AgentAvatarBadge).
	Badge string `json:"badge"`
	// Preview is "folder · activity", or whichever of the two exists, or
	// the pane id (herdrup subtitle()).
	Preview string `json:"preview"`
	// Initial and Tint draw the default avatar: the name's first letter on
	// identity gradient Tint (0 default, 1 claude, 2 codex, 3 gemini), as
	// herdrup AgentPresentation.initial and colorIndex.
	Initial string `json:"initial"`
	Tint    int    `json:"tint"`
	// ArchivedNote is "archived by X · reason" for an archived agent.
	ArchivedNote string `json:"archivedNote,omitempty"`
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
// Archived agents come newest-archived first, as in herdrup's AgentList.
func BuildBoard(agents []AgentInfo) Board {
	type entry struct {
		info  AgentInfo
		group Group
	}
	var live, archived []entry
	b := Board{Sections: []Section{}, Archived: []Row{}}
	for _, a := range agents {
		if a.IsArchived() {
			archived = append(archived, entry{a, Idle})
			continue
		}
		live = append(live, entry{a, GroupOf(a, true)})
	}
	archivedAt := func(a AgentInfo) string {
		var arc struct {
			At string `json:"at"`
		}
		_ = json.Unmarshal(a.Archived, &arc)
		return arc.At
	}
	sort.SliceStable(archived, func(i, j int) bool {
		return archivedAt(archived[i].info) > archivedAt(archived[j].info)
	})
	for _, e := range archived {
		r := rowOf(e.info, Idle)
		r.ArchivedNote = archivedNote(e.info)
		b.Archived = append(b.Archived, r)
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
		b.Sections[n-1].Rows = append(b.Sections[n-1].Rows, rowOf(e.info, e.group))
		if e.group == NeedsYou {
			b.NeedsYou++
		}
	}
	b.Total = len(live)
	return b
}

var badgeOf = [...]string{NeedsYou: "waiting", Stopped: "stopped", Unrecognised: "unrecognised", Working: "working", Idle: "none"}

func rowOf(a AgentInfo, g Group) Row {
	title := DisplayName(a)
	r := Row{
		ID:      a.PaneID,
		Title:   title,
		Agent:   str(a.Agent),
		Status:  str(a.AgentStatus),
		Badge:   badgeOf[g],
		Preview: Preview(a),
		Initial: Initial(title),
		Tint:    TintIndex(title),
	}
	if str(a.Reachability) == "unreachable" {
		r.Badge = "offline"
	}
	return r
}

// Preview is herdrup's row subtitle: the folder's last path component and
// the activity, joined by " · ", or whichever exists, else the pane id.
func Preview(a AgentInfo) string {
	folder := ""
	if a.Cwd != nil {
		if f := path.Base(*a.Cwd); f != "/" && f != "." {
			folder = f
		}
	}
	activity := Activity(str(a.TerminalTitleStripped))
	switch {
	case folder != "" && activity != "":
		return folder + " · " + activity
	case folder != "":
		return folder
	case activity != "":
		return activity
	}
	return a.PaneID
}

// Initial is the name's first character, upper-cased, or "?".
func Initial(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "?"
	}
	r, _ := utf8.DecodeRuneInString(name)
	return strings.ToUpper(string(r))
}

// TintIndex picks one of the four identity gradients from the name with
// FNV-1a, folding the high bits down, exactly as herdrup does so an agent
// has the same colour in both apps.
func TintIndex(name string) int {
	h := uint64(14695981039346656037)
	for i := range len(name) {
		h = (h ^ uint64(name[i])) * 1099511628211
	}
	return int((h ^ (h >> 32)) % 4)
}

// archivedNote is herdrup's archivedSubtitle: "archived by X · reason",
// degrading to "archived" when herdr recorded no one.
func archivedNote(a AgentInfo) string {
	var arc struct {
		By     *string `json:"by"`
		Reason *string `json:"reason"`
	}
	_ = json.Unmarshal(a.Archived, &arc)
	by := "archived"
	if arc.By != nil {
		by = "archived by " + *arc.By
	}
	if r := str(arc.Reason); r != "" {
		return by + " · " + r
	}
	return by
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
