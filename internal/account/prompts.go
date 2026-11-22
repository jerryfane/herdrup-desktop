package account

import (
	"encoding/json"
	"math"
	"unicode"
	"unicode/utf8"
)

// PromptsCap is the most prompts an account holds (§5.1); the service
// refuses a push past it.
const PromptsCap = 500

// The prompts collection's field limits (§5.5, AccountService src/sync.ts):
// a title of up to 128 code points on one line, a text of up to 8 KB of
// UTF-8 that may hold tabs and line breaks, and an order the service can
// keep exactly.
const (
	maxPromptTitle = 128
	maxPromptText  = 8192
	maxPromptOrder = 1<<53 - 1
)

// RemotePrompt is a live (not deleted) prompts item.
type RemotePrompt struct {
	ID   string
	Rev  int64
	Body PromptBody
}

// RemotePrompts splits pulled prompts items into live ones and deleted ids.
// An item without text is none the service would hold, and is skipped.
func RemotePrompts(items []Item) (live []RemotePrompt, deleted []string) {
	for _, it := range items {
		if it.Collection != "prompts" {
			continue
		}
		if it.Deleted {
			deleted = append(deleted, it.ID)
			continue
		}
		var b PromptBody
		if json.Unmarshal(it.Body, &b) != nil || b.Text == "" {
			continue
		}
		live = append(live, RemotePrompt{ID: it.ID, Rev: it.Rev, Body: b})
	}
	return live, deleted
}

// ValidPrompt reports whether the service would take b: a push holding one
// it refuses is refused whole, so such a prompt is not sent.
func ValidPrompt(b PromptBody) bool {
	if !utf8.ValidString(b.Title) || !utf8.ValidString(b.Text) {
		return false
	}
	if utf8.RuneCountInString(b.Title) > maxPromptTitle || b.Text == "" || len(b.Text) > maxPromptText {
		return false
	}
	for _, r := range b.Title {
		if unicode.IsControl(r) {
			return false
		}
	}
	for _, r := range b.Text {
		if unicode.IsControl(r) && r != '\t' && r != '\n' && r != '\r' {
			return false
		}
	}
	if o := b.Order; o != nil && (math.IsNaN(*o) || math.Abs(*o) > maxPromptOrder) {
		return false
	}
	return true
}
