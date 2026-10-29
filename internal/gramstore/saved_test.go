package gramstore

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// herdrup has no unit tests for SavedGramStore (it is app code); these pin
// what App/SavedGramStore.swift does.

func savedIDs(s *Saved) []string {
	var out []string
	for _, g := range s.List() {
		out = append(out, g.ID)
	}
	return out
}

func at(id string, ms uint64) herdrapi.GramMessageInfo {
	m := msg(id, false)
	m.CreatedUnixMs = ms
	return m
}

func TestSavedKeepsACopyNewestFirstAndPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "saved-grams.json")
	s := NewSaved(path)
	file := at("g1", 100)
	file.File = &herdrapi.GramFileInfo{Name: "a.png", Size: 9, Mime: "image/png", SHA256: "x"}
	for _, m := range []herdrapi.GramMessageInfo{file, at("g3", 300), at("g2", 200)} {
		if changed, err := s.Save(m, "Mac Studio/scout"); err != nil || !changed {
			t.Fatalf("save %s: %v %v", m.ID, changed, err)
		}
	}
	if changed, _ := s.Save(at("g2", 200), "x"); changed {
		t.Error("saving a saved message changed something")
	}
	if !slices.Equal(savedIDs(s), []string{"g3", "g2", "g1"}) {
		t.Fatalf("order %v", savedIDs(s))
	}
	again := NewSaved(path) // as after a restart
	list := again.List()
	if !slices.Equal(savedIDs(again), []string{"g3", "g2", "g1"}) {
		t.Fatalf("reloaded %v", savedIDs(again))
	}
	g1 := list[2]
	if g1.From != "Mac Studio/scout" || !g1.FromAgent || g1.Text != "hi" || g1.File == nil ||
		*g1.File != (SavedFile{Name: "a.png", Size: 9, Mime: "image/png"}) || g1.ExpiredFile != nil {
		t.Fatalf("copy %+v", g1)
	}
	if removed, err := again.Remove("g2"); !removed || err != nil {
		t.Fatalf("remove: %v %v", removed, err)
	}
	if removed, _ := again.Remove("g2"); removed {
		t.Error("removed twice")
	}
	if !slices.Equal(savedIDs(NewSaved(path)), []string{"g3", "g1"}) {
		t.Fatal("removal not persisted")
	}
}

func TestSavedCopiesAnExpiredFileAsExpired(t *testing.T) {
	s := NewSaved(filepath.Join(t.TempDir(), "s.json"))
	m := at("g1", 1)
	m.ExpiredFile = &herdrapi.GramFileInfo{Name: "chart.png", Size: 5, Mime: "image/png"}
	s.Save(m, "vetrina")
	g, ok := s.Get("g1")
	if !ok || g.File != nil || g.ExpiredFile == nil || g.ExpiredFile.Name != "chart.png" {
		t.Fatalf("%+v", g)
	}
}

// expireFiles: a saved copy still holding a file the store has since
// expired stops offering it; nothing is written when nothing moved.
func TestSavedExpireFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.json")
	s := NewSaved(path)
	live := at("g1", 1)
	live.File = &herdrapi.GramFileInfo{Name: "r.zip", Size: 7, Mime: "application/zip"}
	s.Save(live, "vetrina")
	s.Save(at("g2", 2), "vetrina")

	info, _ := os.Stat(path)
	if moved, _ := s.ExpireFiles([]herdrapi.GramMessageInfo{live, at("g2", 2)}); moved {
		t.Fatal("nothing expired, yet something moved")
	}
	if after, _ := os.Stat(path); !after.ModTime().Equal(info.ModTime()) {
		t.Fatal("wrote with nothing moved")
	}
	expired := at("g1", 1)
	expired.ExpiredFile = &herdrapi.GramFileInfo{Name: "r.zip", Size: 7, Mime: "application/zip"}
	other := at("unsaved", 3)
	other.ExpiredFile = expired.ExpiredFile
	if moved, err := s.ExpireFiles([]herdrapi.GramMessageInfo{other, expired, expired}); !moved || err != nil {
		t.Fatalf("moved %v %v", moved, err)
	}
	g, _ := NewSaved(path).Get("g1")
	if g.File != nil || g.ExpiredFile == nil || *g.ExpiredFile != (SavedFile{Name: "r.zip", Size: 7, Mime: "application/zip"}) {
		t.Fatalf("after expiry %+v", g)
	}
}

func TestSavedABadFileIsNoSavedMessages(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := NewSaved(path).List(); len(got) != 0 {
		t.Fatalf("%v", got)
	}
}
