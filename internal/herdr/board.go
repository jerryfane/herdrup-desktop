// Package herdr is the status board of the herdrup iOS app: agents from
// agent.list (herdrapi.AgentInfo) grouped and ordered the way herdrup
// shows them.
package herdr

import (
	"path"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
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
// AgentRow.resolvedGroup). live is false for a pane that is gone. A
// missing status reads as "", which, like a status this build does not
// know, is Unrecognised.
func GroupOf(a herdrapi.AgentInfo, live bool) Group {
	if !live {
		return Stopped
	}
	if (a.InputPending != nil && *a.InputPending) || a.AgentStatus == herdrapi.AgentStatusBlocked {
		return NeedsYou
	}
	switch a.AgentStatus {
	case herdrapi.AgentStatusWorking:
		return Working
	case herdrapi.AgentStatusIdle, herdrapi.AgentStatusDone:
		return Idle
	case herdrapi.AgentStatusUnknown:
		// A federated peer's live status is blanked to unknown when it
		// drops; its last known blocked still needs you.
		if a.LastKnownStatus != nil && *a.LastKnownStatus == herdrapi.AgentStatusBlocked {
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
	// Match is what the sidebar search looks in, each on its own: the
	// display name, the raw name (a federated agent's still carries the
	// machine alias) and the terminal title (herdrup visibleSections).
	Match []string `json:"match"`
	// Name is the agent's raw name, which folders and stars are keyed by;
	// "" for an agent that has none (it cannot be starred or filed).
	Name string `json:"name"`
	// Starred draws the star after the name; FolderID is set for an agent
	// shown indented under its open folder (herdrup card()).
	Starred  bool   `json:"starred"`
	FolderID string `json:"folderID,omitempty"`
	// Avatar is the picture the avatar draws (herdrup AgentAvatarAppearance).
	Avatar Avatar `json:"avatar"`
	// Stale marks a live agent on a degraded federation peer: its status
	// was not confirmed on the last poll (herdrup showsUnconfirmedMarker).
	Stale bool `json:"stale,omitempty"`
	// NoAccount is herdr's account_unresolved: the recorded account is gone
	// from the registry, so the agent refuses to resume.
	NoAccount bool `json:"noAccount,omitempty"`
	// Account is the id of the account the agent runs on, "" when herdr
	// reports none. The window shows the account's label.
	Account string `json:"account,omitempty"`
	// StatusSinceUnixMs is when the agent entered its current status, for
	// the time-in-state age; absent on an older herdr.
	StatusSinceUnixMs *uint64 `json:"statusSinceUnixMs,omitempty"`
	// Activity is the terminal title without its prompt and spinner, ""
	// when there is none (herdrup activityText): the needs-you pill's detail.
	Activity string `json:"activity,omitempty"`
}

// Section is one group of rows.
type Section struct {
	Key       string `json:"key"`
	Label     string `json:"label"`
	Collapsed bool   `json:"collapsed"`
	// Rows are the section's agents, those inside its folders included, in
	// list order.
	Rows []Row `json:"rows"`
	// Items are the rows the list draws once folders and stars apply:
	// starred agents, then the folders (and an open folder's agents), then
	// the other agents (herdrup AgentFolderLayout).
	Items []Item `json:"items"`
	// AgentCount counts the section's agents, those in its folders
	// included; the Idle disclosure shows it.
	AgentCount int `json:"agentCount"`
}

// Board is the status board for one machine.
type Board struct {
	Sections []Section `json:"sections"`
	Archived []Row     `json:"archived"`
	NeedsYou int       `json:"needsYou"`
	Total    int       `json:"total"`
	// EmptyFolders are folders none of whose agents are listed, drawn
	// after the sections so they can still be renamed or deleted. None
	// while searching.
	EmptyFolders []Folder `json:"emptyFolders"`
}

// View is how the board is laid out: the owner's folders and stars (nil
// without them: the plain list), which folders are open on this device,
// and the search query.
type View struct {
	Groups *Groups
	Open   map[string]bool
	// Query keeps the agents it matches (Matches); every folder counts as
	// open and empty folders are left out (herdrup rosterLayout).
	Query string
}

// Matches is the sidebar search's test (herdrup visibleSections): the
// query appears, ignoring case, inside one of the row's match strings. An
// empty query matches everything.
func Matches(match []string, query string) bool {
	if query == "" {
		return true
	}
	q := strings.ToLower(query)
	for _, s := range match {
		if strings.Contains(strings.ToLower(s), q) {
			return true
		}
	}
	return false
}

// BuildBoard groups and orders agents: by group, then most recently
// finished turn first, then pane id so unchanged data never reshuffles.
// Archived agents come newest-archived first, as in herdrup's AgentList.
// Folders and stars are then applied as v says.
func BuildBoard(agents []herdrapi.AgentInfo, v View) Board {
	type entry struct {
		info  herdrapi.AgentInfo
		group Group
	}
	var live, archived []entry
	b := Board{Sections: []Section{}, Archived: []Row{}}
	for _, a := range agents {
		if a.Archived != nil {
			archived = append(archived, entry{a, Idle})
			continue
		}
		live = append(live, entry{a, GroupOf(a, true)})
	}
	sort.SliceStable(archived, func(i, j int) bool {
		return archived[i].info.Archived.At > archived[j].info.Archived.At
	})
	for _, e := range archived {
		r := rowOf(e.info, Idle)
		r.ArchivedNote = archivedNote(*e.info.Archived)
		b.Archived = append(b.Archived, r)
	}
	completed := func(a herdrapi.AgentInfo) int64 {
		if a.LastCompletedTurn == nil {
			return -1 << 63
		}
		return int64(a.LastCompletedTurn.CompletedUnixMs)
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
	var members []member
	for _, e := range live {
		if e.group == NeedsYou {
			b.NeedsYou++
		}
		r := rowOf(e.info, e.group)
		if !Matches(r.Match, v.Query) {
			continue
		}
		n := len(b.Sections)
		if n == 0 || b.Sections[n-1].Key != e.group.Key() {
			b.Sections = append(b.Sections, Section{
				Key: e.group.Key(), Label: e.group.Label(), Collapsed: e.group == Idle,
			})
			n++
		}
		b.Sections[n-1].Rows = append(b.Sections[n-1].Rows, r)
		members = append(members, member{r, e.group})
	}
	b.Total = len(live)
	open := func(id string) bool { return v.Query != "" || v.Open[id] }
	b.Sections, b.EmptyFolders = layout(b.Sections, members, v.Groups, open)
	if v.Query != "" {
		b.EmptyFolders = []Folder{}
	}
	return b
}

var badgeOf = [...]string{NeedsYou: "waiting", Stopped: "stopped", Unrecognised: "unrecognised", Working: "working", Idle: "none"}

func rowOf(a herdrapi.AgentInfo, g Group) Row {
	title := DisplayName(a)
	r := Row{
		ID:      a.PaneID,
		Title:   title,
		Agent:   str(a.Agent),
		Status:  string(a.AgentStatus),
		Badge:   badgeOf[g],
		Preview: Preview(a),
		Initial: Initial(title),
		Tint:    TintIndex(title),
		Match:   []string{title},
		Name:    str(a.Name),
	}
	for _, s := range []string{str(a.Name), str(a.TerminalTitleStripped)} {
		if s != "" && s != title {
			r.Match = append(r.Match, s)
		}
	}
	if a.Reachability != nil && *a.Reachability == herdrapi.ReachabilityUnreachable {
		r.Badge = "offline"
	}
	r.Avatar = AvatarOf(a)
	r.Stale = a.Archived == nil && a.Reachability != nil && *a.Reachability == herdrapi.ReachabilityDegraded
	r.NoAccount = a.AccountUnresolved != nil && *a.AccountUnresolved
	r.Account = str(a.Account)
	r.StatusSinceUnixMs = a.StatusSinceUnixMs
	r.Activity = Activity(str(a.TerminalTitleStripped))
	return r
}

// Preview is herdrup's row subtitle: the folder's last path component and
// the activity, joined by " · ", or whichever exists, else the pane id.
func Preview(a herdrapi.AgentInfo) string {
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
func archivedNote(arc herdrapi.AgentArchivedInfo) string {
	by := "archived"
	if arc.By != "" {
		by = "archived by " + arc.By
	}
	if r := str(arc.Reason); r != "" {
		return by + " · " + r
	}
	return by
}

// DisplayName is the agent's name, falling back to its terminal title and
// pane id. A federated agent's machine alias is replaced by the machine's
// label.
func DisplayName(a herdrapi.AgentInfo) string {
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
