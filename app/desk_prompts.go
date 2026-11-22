package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/account"
)

// Saved prompts: the composer's bookmark menu (SavedPromptsStore.swift).
// They live in prompts.json beside machines.json and sync with the HerdrUp
// account's prompts collection (desk_account_sync.go).

// SavedPrompt is one saved prompt. ID is a lowercase UUID, the account
// item's id too.
type SavedPrompt struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
	Text     string `json:"text"`
}

// promptStore is prompts.json.
type promptStore struct {
	Prompts []SavedPrompt `json:"prompts"`
	// Imported is set once the page's localStorage list (the prompts from
	// before they moved here) has been taken in.
	Imported bool `json:"imported,omitempty"`
}

// SavedPromptsChanged tells the page the saved prompts changed (a sync
// brought another device's, or another composer saved one).
var SavedPromptsChanged = mygo.NewEvent[[]SavedPrompt]("savedPrompts:changed")

var publishSavedPrompts = func(p []SavedPrompt) { SavedPromptsChanged.Broadcast(p) }

func (d *Desk) promptsPath() string { return filepath.Join(d.dir, "prompts.json") }

// loadPrompts reads prompts.json; none yet is an empty list. d.storeMu must
// be held.
func (d *Desk) loadPrompts() (promptStore, error) {
	var st promptStore
	raw, err := os.ReadFile(d.promptsPath())
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	return st, json.Unmarshal(raw, &st)
}

// storePrompts writes prompts.json. d.storeMu must be held.
func (d *Desk) storePrompts(st promptStore) error {
	if st.Prompts == nil {
		st.Prompts = []SavedPrompt{}
	}
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d.dir, 0o700); err != nil {
		return err
	}
	tmp := d.promptsPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, d.promptsPath())
}

var promptUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// promptID is id as the account takes it (a lowercase UUID), or a new one
// when id isn't a UUID.
func promptID(id string) (string, error) {
	if id = strings.ToLower(strings.TrimSpace(id)); promptUUID.MatchString(id) {
		return id, nil
	}
	return account.NewHostID()
}

// SavedPrompts is every saved prompt, in the menu's order.
func (d *Desk) SavedPrompts() ([]SavedPrompt, error) {
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	st, err := d.loadPrompts()
	if err != nil {
		return nil, err
	}
	return listOf(st.Prompts), nil
}

func listOf(p []SavedPrompt) []SavedPrompt {
	if p == nil {
		return []SavedPrompt{}
	}
	return p
}

// SavePrompt adds p (ID "") at the end, or replaces the saved prompt with
// its ID in place, and returns the saved prompts.
func (d *Desk) SavePrompt(p SavedPrompt) ([]SavedPrompt, error) {
	p.Nickname = strings.TrimSpace(p.Nickname)
	if strings.TrimSpace(p.Text) == "" {
		return nil, errors.New("a prompt needs text")
	}
	d.storeMu.Lock()
	st, err := d.loadPrompts()
	if err != nil {
		d.storeMu.Unlock()
		return nil, err
	}
	i := -1
	if p.ID != "" {
		i = slices.IndexFunc(st.Prompts, func(q SavedPrompt) bool { return q.ID == strings.ToLower(p.ID) })
	}
	if i >= 0 {
		p.ID = st.Prompts[i].ID
		st.Prompts[i] = p
	} else {
		if p.ID, err = promptID(p.ID); err != nil {
			d.storeMu.Unlock()
			return nil, err
		}
		st.Prompts = append(st.Prompts, p)
	}
	err = d.storePrompts(st)
	d.storeMu.Unlock()
	if err != nil {
		return nil, err
	}
	publishSavedPrompts(st.Prompts)
	d.syncMachinesSoon()
	return st.Prompts, nil
}

// DeletePrompt removes the saved prompt with id and returns those left. The
// account's other devices drop it too: the next sync pushes its tombstone.
func (d *Desk) DeletePrompt(id string) ([]SavedPrompt, error) {
	id = strings.ToLower(id)
	d.storeMu.Lock()
	st, err := d.loadPrompts()
	if err != nil {
		d.storeMu.Unlock()
		return nil, err
	}
	i := slices.IndexFunc(st.Prompts, func(q SavedPrompt) bool { return q.ID == id })
	if i < 0 {
		d.storeMu.Unlock()
		return listOf(st.Prompts), nil
	}
	// Kept before the prompt goes, as RemoveMachine: a removal the account
	// would never hear of is refused instead.
	state, err := d.loadSyncState()
	if err == nil && !slices.Contains(state.PromptDeletes, id) {
		state.PromptDeletes = append(state.PromptDeletes, id)
		err = d.storeSyncState(state)
	}
	if err != nil {
		d.storeMu.Unlock()
		return nil, err
	}
	st.Prompts = slices.Delete(st.Prompts, i, i+1)
	err = d.storePrompts(st)
	d.storeMu.Unlock()
	if err != nil {
		return nil, err
	}
	publishSavedPrompts(listOf(st.Prompts))
	d.syncMachinesSoon()
	return listOf(st.Prompts), nil
}

// ImportSavedPrompts takes in the prompts the page kept in localStorage
// before they moved here, once: ids are kept (lowercased; one that isn't a
// UUID gets a new one), one already saved is not added twice, and a later
// call adds nothing. It returns the saved prompts.
func (d *Desk) ImportSavedPrompts(list []SavedPrompt) ([]SavedPrompt, error) {
	d.storeMu.Lock()
	st, err := d.loadPrompts()
	if err != nil || st.Imported {
		d.storeMu.Unlock()
		return listOf(st.Prompts), err
	}
	have := map[string]bool{}
	for _, p := range st.Prompts {
		have[p.ID] = true
	}
	for _, p := range list {
		if strings.TrimSpace(p.Text) == "" {
			continue
		}
		if p.ID, err = promptID(p.ID); err != nil {
			d.storeMu.Unlock()
			return nil, err
		}
		if have[p.ID] {
			continue
		}
		have[p.ID] = true
		p.Nickname = strings.TrimSpace(p.Nickname)
		st.Prompts = append(st.Prompts, p)
	}
	st.Imported = true
	err = d.storePrompts(st)
	d.storeMu.Unlock()
	if err != nil {
		return nil, err
	}
	if len(list) > 0 {
		d.syncMachinesSoon()
	}
	return listOf(st.Prompts), nil
}
