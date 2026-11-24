package account

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
	"unicode"
	"unicode/utf8"
)

// PromptsCap is the most prompts an account holds (§5.1); the service
// refuses a push past it.
const PromptsCap = 500

// The prompts collection's field limits (§5.5, AccountService src/sync.ts):
// a title of up to 128 code points on one line, a text of up to 8 KB of
// UTF-8 that may hold tabs and line breaks, and an order the service can
// keep exactly. The body as the service stores it (JSON.stringify of those
// fields) is at most MaxItemBytes.
const (
	maxPromptTitle = 128
	maxPromptText  = 8192
	// MaxPromptOrder is the largest order the service takes.
	MaxPromptOrder = 1<<53 - 1
)

// MaxItemBytes is the most UTF-8 bytes one item's body may take once the
// service has serialised it (MAX_ITEM_BYTES; 413 too_large).
const MaxItemBytes = 16 * 1024

// RemotePrompt is a live (not deleted) prompts item. UpdatedMs is when the
// service wrote it, on its clock (sync.ts UPSERT binds the push's nowMs,
// the clock its now_ms answers carry); 0 in a mirror from before it was
// kept.
type RemotePrompt struct {
	ID        string
	Rev       int64
	UpdatedMs int64 `json:",omitempty"`
	Body      PromptBody
}

// promptRow reads a live prompts item; one without text is none the service
// would hold.
func promptRow(it Item) (RemotePrompt, bool) {
	var b PromptBody
	if json.Unmarshal(it.Body, &b) != nil || b.Text == "" {
		return RemotePrompt{}, false
	}
	return RemotePrompt{ID: it.ID, Rev: it.Rev, UpdatedMs: it.UpdatedMs, Body: b}, true
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
	if o := b.Order; o != nil && (math.IsNaN(*o) || math.Abs(*o) > MaxPromptOrder) {
		return false
	}
	return storedSize(b) <= MaxItemBytes
}

// storedSize is the length of b as the service stores it: JSON.stringify,
// which escapes what Go's encoder does without HTML escaping, except U+2028
// and U+2029, which it keeps as themselves (3 bytes, not 6).
func storedSize(b PromptBody) int {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(b) != nil {
		return math.MaxInt
	}
	separators := strings.Count(b.Title, "\u2028") + strings.Count(b.Title, "\u2029") + strings.Count(b.Text, "\u2028") + strings.Count(b.Text, "\u2029")
	return len(bytes.TrimSuffix(buf.Bytes(), []byte("\n"))) - 3*separators
}
