package main

import (
	"slices"
	"testing"
)

// The prompts the page kept in localStorage come in once, ids kept (as the
// account takes them: lowercase; one that isn't a UUID gets a new one); a
// later import, or one after the list was cleared, adds nothing.
func TestSavedPromptsFromThePageImportOnce(t *testing.T) {
	quietSync(t)
	d := newDesk(t.TempDir())
	list, err := d.ImportSavedPrompts([]SavedPrompt{
		{ID: "0F8FAD5B-D9CB-469F-A165-70867728950E", Nickname: " standup ", Text: "What did you do?"},
		{ID: "not-a-uuid", Text: "run the tests"},
		{ID: "7c9e6679-7425-40de-944b-e07fc1f90ae7", Text: "   "},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0] != (SavedPrompt{ID: "0f8fad5b-d9cb-469f-a165-70867728950e", Nickname: "standup", Text: "What did you do?"}) {
		t.Fatalf("imported %+v", list)
	}
	if !promptUUID.MatchString(list[1].ID) || list[1].Text != "run the tests" {
		t.Fatalf("a prompt without a UUID: %+v", list[1])
	}
	again, err := d.ImportSavedPrompts([]SavedPrompt{{ID: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", Text: "from another window"}})
	if err != nil || !slices.Equal(again, list) {
		t.Fatalf("a second import: %+v, %v; want %+v", again, err, list)
	}
	if saved, _ := d.SavedPrompts(); !slices.Equal(saved, list) {
		t.Fatalf("saved prompts %+v; want %+v", saved, list)
	}
}
