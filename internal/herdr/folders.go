package herdr

import (
	"crypto/rand"
	"encoding/hex"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// Agent folders and stars (herdrup#552, HerdrKit AgentGroups.swift),
// synced through the herdr server's owner store (agent.groups.get/set,
// capability agent_groups). Membership follows the agent's raw name.

// Groups is the owner's folder document.
type Groups = herdrapi.ResponseResultAgentGroups

// MaxNameLength is the server's limit on folder names, in characters.
const MaxNameLength = 64

// FolderName is a folder name as the server accepts it: trimmed and at
// most 64 characters; "" when nothing is left (AgentGroupsDocument.folderName).
func FolderName(raw string) string {
	s := []rune(strings.TrimFunc(raw, unicode.IsSpace))
	if len(s) > MaxNameLength {
		s = s[:MaxNameLength]
	}
	return string(s)
}

// NewFolderID is a short random folder id: 12 lowercase hex characters,
// as herdrup's UUID prefix (AgentGroupsDocument.newFolderID).
func NewFolderID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// OrderedFolders are the folders in display order: by order, then by their
// place in the document.
func OrderedFolders(g Groups) []herdrapi.AgentGroupFolder {
	out := slices.Clone(g.Folders)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Order < out[j].Order })
	return out
}

// FolderOf is the folder name is in, or nil. An agent is in at most one.
func FolderOf(g Groups, name string) *herdrapi.AgentGroupFolder {
	for i := range g.Folders {
		if slices.Contains(g.Folders[i].Members, name) {
			return &g.Folders[i]
		}
	}
	return nil
}

// IsStarred reports whether name is starred.
func IsStarred(g Groups, name string) bool { return slices.Contains(g.Stars, name) }

// EditKind names one change the owner makes (herdrup AgentGroupsEdit).
type EditKind string

const (
	EditSetStar          EditKind = "setStar"
	EditMove             EditKind = "move"
	EditRemoveFromFolder EditKind = "removeFromFolder"
	EditAddFolder        EditKind = "addFolder"
	EditRenameFolder     EditKind = "renameFolder"
	EditDeleteFolder     EditKind = "deleteFolder"
	EditMoveFolder       EditKind = "moveFolder"
)

// Edit is one change, pure so a conflict can replay it onto the server's
// current document. Name is the agent, Folder the folder id, Text a folder
// name, Star the star state and By the step of a folder move.
type Edit struct {
	Kind   EditKind
	Name   string
	Folder string
	Text   string
	Star   bool
	By     int
}

// clone deep-copies g so an edit never touches the document it came from.
func clone(g Groups) Groups {
	out := Groups{Revision: g.Revision, Stars: slices.Clone(g.Stars), Folders: make([]herdrapi.AgentGroupFolder, len(g.Folders))}
	for i, f := range g.Folders {
		f.Members = slices.Clone(f.Members)
		out.Folders[i] = f
	}
	return out
}

// Apply returns g with e applied; g is left as it was.
func (e Edit) Apply(g Groups) Groups {
	g = clone(g)
	switch e.Kind {
	case EditSetStar:
		// Idempotent, not a toggle, so a replay keeps what was asked for.
		g.Stars = slices.DeleteFunc(g.Stars, func(s string) bool { return s == e.Name })
		if e.Star {
			g.Stars = append(g.Stars, e.Name)
		}
	case EditMove:
		move(&g, e.Name, e.Folder)
	case EditRemoveFromFolder:
		removeFromFolders(&g, e.Name)
	case EditAddFolder:
		order := int64(-1)
		for _, f := range g.Folders {
			order = max(order, f.Order)
		}
		g.Folders = append(g.Folders, herdrapi.AgentGroupFolder{ID: e.Folder, Name: e.Text, Order: order + 1, Members: []string{}})
		if e.Name != "" {
			move(&g, e.Name, e.Folder)
		}
	case EditRenameFolder:
		for i := range g.Folders {
			if g.Folders[i].ID == e.Folder {
				g.Folders[i].Name = e.Text
				break
			}
		}
	case EditDeleteFolder:
		// Its agents go back to the list.
		g.Folders = slices.DeleteFunc(g.Folders, func(f herdrapi.AgentGroupFolder) bool { return f.ID == e.Folder })
	case EditMoveFolder:
		ordered := OrderedFolders(g)
		i := slices.IndexFunc(ordered, func(f herdrapi.AgentGroupFolder) bool { return f.ID == e.Folder })
		j := i + e.By
		if i < 0 || j < 0 || j >= len(ordered) {
			break
		}
		ordered[i], ordered[j] = ordered[j], ordered[i]
		for k := range ordered {
			ordered[k].Order = int64(k)
		}
		g.Folders = ordered
	}
	return g
}

// move puts name in folder id, out of any other. A missing folder (deleted
// on another device meanwhile) leaves the agent where it was.
func move(g *Groups, name, id string) {
	i := slices.IndexFunc(g.Folders, func(f herdrapi.AgentGroupFolder) bool { return f.ID == id })
	if i < 0 {
		return
	}
	removeFromFolders(g, name)
	g.Folders[i].Members = append(g.Folders[i].Members, name)
}

func removeFromFolders(g *Groups, name string) {
	for i := range g.Folders {
		g.Folders[i].Members = slices.DeleteFunc(g.Folders[i].Members, func(m string) bool { return m == name })
	}
}

// GroupsEqual compares two documents, an empty list and a missing one
// alike.
func GroupsEqual(a, b Groups) bool {
	if a.Revision != b.Revision || !slices.Equal(a.Stars, b.Stars) || len(a.Folders) != len(b.Folders) {
		return false
	}
	for i := range a.Folders {
		x, y := a.Folders[i], b.Folders[i]
		if x.ID != y.ID || x.Name != y.Name || x.Order != y.Order || !slices.Equal(x.Members, y.Members) {
			return false
		}
	}
	return true
}

// Item is one row of the list once folders and stars are applied: an
// agent (Row, with Starred and FolderID set) or a folder.
type Item struct {
	// Kind is "agent" or "folder".
	Kind   string  `json:"kind"`
	Row    *Row    `json:"row,omitempty"`
	Folder *Folder `json:"folder,omitempty"`
}

// Folder is what a folder row shows (herdrup AgentFolderSummary).
type Folder struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Open bool   `json:"open"`
	// Waiting and Stopped count its agents that need you and that stopped.
	Waiting int `json:"waiting"`
	Stopped int `json:"stopped"`
	// Count is "1 agent" or "N agents".
	Count string `json:"count"`
	// Summary is "a needs you · b stopped", "N working", "idle" or "empty".
	Summary string `json:"summary"`
	// Picture is its first four agents, for the folder's picture.
	Picture []Row `json:"picture"`
}

// member is a row with its group, as the layout needs it.
type member struct {
	row   Row
	group Group
}

func summarise(f herdrapi.AgentGroupFolder, members []member, open bool) Folder {
	s := Folder{ID: f.ID, Name: f.Name, Open: open, Picture: []Row{}}
	var waiting, stopped []string
	working := 0
	for i, m := range members {
		if i < 4 {
			s.Picture = append(s.Picture, m.row)
		}
		switch m.group {
		case NeedsYou:
			waiting = append(waiting, m.row.Title)
		case Stopped:
			stopped = append(stopped, m.row.Title)
		case Working:
			working++
		}
	}
	s.Waiting, s.Stopped = len(waiting), len(stopped)
	if len(members) == 1 {
		s.Count = "1 agent"
	} else {
		s.Count = strconv.Itoa(len(members)) + " agents"
	}
	var parts []string
	if len(waiting) > 0 {
		parts = append(parts, phrase(waiting, "needs you", "need you"))
	}
	if len(stopped) > 0 {
		parts = append(parts, phrase(stopped, "stopped", "stopped"))
	}
	switch {
	case len(members) == 0:
		s.Summary = "empty"
	case len(parts) > 0:
		s.Summary = strings.Join(parts, " · ")
	case working > 0:
		s.Summary = strconv.Itoa(working) + " working"
	default:
		s.Summary = "idle"
	}
	return s
}

func phrase(names []string, one, many string) string {
	switch len(names) {
	case 1:
		return names[0] + " " + one
	case 2:
		return names[0] + " and " + names[1] + " " + many
	}
	return strconv.Itoa(len(names)) + " " + many
}

// layout applies folders and stars to the board's sections, exactly as
// herdrup's AgentFolderLayout:
//   - A starred agent goes first within its state.
//   - A folder's agents leave their sections. The folder row sits in the
//     section of its most urgent agent, after that section's starred
//     agents and before its other agents (folders by their order), and
//     when open its agents follow it, most urgent first.
//   - A folder with none of its agents listed goes to the empty folders.
//
// Each section's AgentCount counts the agents in its folders too. With no
// document, the items are the rows as they are.
func layout(sections []Section, groups []member, g *Groups, open func(id string) bool) ([]Section, []Folder) {
	doc := Groups{}
	if g != nil {
		doc = *g
	}
	stars := map[string]bool{}
	for _, s := range doc.Stars {
		stars[s] = true
	}
	starred := func(r Row) bool { return r.Name != "" && stars[r.Name] }
	ordered := OrderedFolders(doc)
	folderOf := map[string]string{}
	for _, f := range ordered {
		for _, m := range f.Members {
			if _, ok := folderOf[m]; !ok {
				folderOf[m] = f.ID
			}
		}
	}
	folderID := func(r Row) string {
		if r.Name == "" {
			return ""
		}
		return folderOf[r.Name]
	}

	// groups holds every row in section order with its group; split it
	// back into sections.
	bySection := make([][]member, len(sections))
	k := 0
	for i, s := range sections {
		bySection[i] = groups[k : k+len(s.Rows)]
		k += len(s.Rows)
	}

	membersOf := map[string][]member{}
	for _, rows := range bySection {
		var first, rest []member
		for _, m := range rows {
			if starred(m.row) {
				first = append(first, m)
			} else {
				rest = append(rest, m)
			}
		}
		for _, m := range append(first, rest...) {
			if id := folderID(m.row); id != "" {
				membersOf[id] = append(membersOf[id], m)
			}
		}
	}

	summaries := map[Group][]struct {
		folder  Folder
		members []member
	}{}
	empty := []Folder{}
	for _, f := range ordered {
		ms := membersOf[f.ID]
		s := summarise(f, ms, open(f.ID))
		if len(ms) == 0 {
			empty = append(empty, s)
			continue
		}
		g := ms[0].group
		summaries[g] = append(summaries[g], struct {
			folder  Folder
			members []member
		}{s, ms})
	}

	agent := func(r Row, star bool, folder string) Item {
		r.Starred, r.FolderID = star, folder
		return Item{Kind: "agent", Row: &r}
	}
	out := []Section{}
	for i, s := range sections {
		var loose []Row
		for _, m := range bySection[i] {
			if folderID(m.row) == "" {
				loose = append(loose, m.row)
			}
		}
		items := []Item{}
		for _, r := range loose {
			if starred(r) {
				items = append(items, agent(r, true, ""))
			}
		}
		count := len(loose)
		if len(bySection[i]) > 0 {
			for _, fs := range summaries[bySection[i][0].group] {
				f := fs.folder
				items = append(items, Item{Kind: "folder", Folder: &f})
				count += len(fs.members)
				if f.Open {
					for _, m := range fs.members {
						items = append(items, agent(m.row, starred(m.row), f.ID))
					}
				}
			}
		}
		for _, r := range loose {
			if !starred(r) {
				items = append(items, agent(r, false, ""))
			}
		}
		if len(items) == 0 {
			continue
		}
		s.Items, s.AgentCount = items, count
		out = append(out, s)
	}
	return out, empty
}
