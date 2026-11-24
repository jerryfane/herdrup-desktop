package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// Sync is the account's settings sync (design #698 §5, AccountService
// src/sync.ts): GET /v1/sync pages changes since a revision; POST /v1/sync
// writes some. The desktop app syncs the hosts and prompts collections.

// Item is one synced item as the service sends it.
type Item struct {
	Collection string          `json:"collection"`
	ID         string          `json:"id"`
	Rev        int64           `json:"rev"`
	UpdatedMs  int64           `json:"updated_ms"`
	Deleted    bool            `json:"deleted"`
	Body       json.RawMessage `json:"body"`
}

// Change is one write in a push. Body is nil for a delete. Base is the
// revision it is based on, always sent (the service's optional base_rev):
// the service writes it only while the item is still at that revision (0:
// it holds no such item, not even a tombstone); otherwise it comes back in
// the answer's Conflicts, unwritten (AccountService src/sync.ts).
type Change struct {
	Collection string `json:"collection"`
	ID         string `json:"id"`
	Base       int64  `json:"base_rev"`
	Deleted    bool   `json:"deleted,omitempty"`
	Body       any    `json:"body,omitempty"`
}

// HostBody is the hosts collection's allowlist (§5.1) and nothing else: a
// saved machine's key path, pins and session never travel.
type HostBody struct {
	Nickname string `json:"nickname,omitempty"`
	Host     string `json:"host"`
	Port     int    `json:"port,omitempty"`
	Username string `json:"username"`
	AuthKind string `json:"auth_kind,omitempty"`
	Label    string `json:"label,omitempty"`
}

// PromptBody is the prompts collection's allowlist (§5.1): a saved prompt's
// title (none when empty), its text and its place in the list.
type PromptBody struct {
	Title string   `json:"title,omitempty"`
	Text  string   `json:"text"`
	Order *float64 `json:"order,omitempty"`
}

// Pull is the result of reading the service's changes.
type Pull struct {
	// Rev is the next pull's since.
	Rev int64
	// Items are the changes, oldest first.
	Items []Item
	// Full means Items is the whole account: anything held locally that it
	// does not list is gone (a since=0 pull, or a reset_required restart).
	Full bool
	// Reset means the service told the pull to start over (410): the
	// account's history may have been replaced (a restore), unlike a plain
	// since=0 pull, which is Full only.
	Reset bool
	// NowMs is the service's clock as of the pull (themartianapp/herdrup
	// #826): the earliest of its pages' now_ms, 0 when a page had none (a
	// service without it).
	NowMs int64
}

// ErrResetRequired is the service's 410: the caller may have missed a
// pruned delete. PullSince turns it into a full pull itself.
var ErrResetRequired = errors.New("account: sync reset required")

const maxPullPages = 64 // 64 × 500 items, past the 2,000-item account cap

// PullSince reads every change after since, following the cursor. A 410
// restarts from 0 and the result is Full and Reset.
// Every request (each page) is for r's session (Round): ErrAccountChanged
// once it ended, a sign-in again to the same account included.
func (c *Client) PullSince(ctx context.Context, r Round, since int64) (Pull, error) {
	p, err := c.pull(ctx, r, since)
	if errors.Is(err, ErrResetRequired) && since != 0 {
		p, err = c.pull(ctx, r, 0)
		p.Reset = err == nil
	}
	return p, err
}

func (c *Client) pull(ctx context.Context, r Round, since int64) (Pull, error) {
	out := Pull{Full: since == 0}
	query := url.Values{"since": {strconv.FormatInt(since, 10)}}
	nowless := false
	for page := 0; page < maxPullPages; page++ {
		var answer struct {
			Rev     int64  `json:"rev"`
			Changes []Item `json:"changes"`
			More    bool   `json:"more"`
			Cursor  string `json:"cursor"`
			NowMs   int64  `json:"now_ms"`
		}
		if err := c.authedEach(ctx, r, http.MethodGet, "/v1/sync?"+query.Encode(), func() (any, error) { return nil, nil }, nil, &answer); err != nil {
			var api *APIError
			if errors.As(err, &api) && api.Status == http.StatusGone {
				return Pull{}, ErrResetRequired
			}
			return Pull{}, err
		}
		c.noteNow(answer.NowMs)
		switch {
		case answer.NowMs <= 0:
			nowless = true
		case out.NowMs == 0 || answer.NowMs < out.NowMs:
			out.NowMs = answer.NowMs
		}
		out.Items = append(out.Items, answer.Changes...)
		out.Rev = answer.Rev
		if !answer.More {
			if nowless {
				out.NowMs = 0
			}
			return out, nil
		}
		if answer.Cursor == "" {
			return Pull{}, errors.New("account service: a page with more and no cursor")
		}
		query = url.Values{"cursor": {answer.Cursor}}
	}
	return Pull{}, fmt.Errorf("account service: more than %d sync pages", maxPullPages)
}

// The service's limits on one push (src/sync.ts MAX_CHANGES,
// MAX_SYNC_BODY_BYTES): past either it answers 413 to the whole push.
const (
	MaxPushChanges = 100
	MaxPushBytes   = 256 * 1024
)

// pushOverhead is the push body around the changes: `{"changes":[`, and
// `],"not_after":` with its milliseconds (up to 16 digits) and `}`.
const pushOverhead = len(`{"changes":[],"not_after":}`) + 16

// Batches splits changes into pushes the service takes: at most
// MaxPushChanges each, and each request body (as Push encodes it) at most
// MaxPushBytes. Order is kept.
func Batches(changes []Change) ([][]Change, error) {
	var out [][]Change
	start, size := 0, pushOverhead
	for i, c := range changes {
		raw, err := json.Marshal(c)
		if err != nil {
			return nil, err
		}
		n := len(raw)
		if i > start {
			n++ // the comma
		}
		if i > start && (i-start == MaxPushChanges || size+n > MaxPushBytes) {
			out = append(out, changes[start:i])
			start, size, n = i, pushOverhead, len(raw)
		}
		size += n
	}
	if start < len(changes) {
		out = append(out, changes[start:])
	}
	return out, nil
}

// errNothingToPush is a dispatch whose prepare left no change to send.
var errNothingToPush = errors.New("account: nothing to push")

// notAfterMargin is how long past the newest now_ms seen a push may still
// be applied (themartianapp/herdrup#826).
const notAfterMargin = 120_000

// noteNow keeps the newest now_ms the sync answers carried (0: none). An
// answer without one (a service rolled back from #826) forgets it, so
// later pushes carry no not_after until an answer carries one again.
func (c *Client) noteNow(ms int64) {
	c.nowMu.Lock()
	defer c.nowMu.Unlock()
	if ms <= 0 {
		c.nowMs = 0
		return
	}
	c.nowMs = max(c.nowMs, ms)
}

// notAfter is the deadline a push dispatched now carries: the newest
// now_ms seen plus notAfterMargin, 0 (none) while no answer carried one.
func (c *Client) notAfter() int64 {
	c.nowMu.Lock()
	defer c.nowMu.Unlock()
	if c.nowMs == 0 {
		return 0
	}
	return c.nowMs + notAfterMargin
}

// Push writes the changes prepare returns (one of Batches) to account acct
// and returns the service's answer; ErrAccountChanged once another account
// is signed in. prepare runs just before each dispatch, the replay after a
// refused credential included, so what goes is what holds then; none is
// no request (an empty answer). It is given the dispatch's not_after (0
// for none): the service refuses the push once its clock is past it
// (themartianapp/herdrup#826). A canceled ctx stops the push before
// prepare. wroteNothing hears of a dispatch that provably wrote nothing:
// refused (any 4xx, as soon as its status line is read: before its body,
// and before a refreshed credential's replay), or failed before it had a
// connection (exchange). Past that a failure proves nothing, and the send
// stays open.
func (c *Client) Push(ctx context.Context, r Round, prepare func(notAfter int64) ([]Change, error), wroteNothing func() error) (PushResult, error) {
	var out PushResult
	err := c.authedEach(ctx, r, http.MethodPost, "/v1/sync", func() (any, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		notAfter := c.notAfter()
		changes, err := prepare(notAfter)
		if err == nil && len(changes) == 0 {
			err = errNothingToPush
		}
		return pushBody{Changes: changes, NotAfter: notAfter}, err
	}, wroteNothing, &out)
	if errors.Is(err, errNothingToPush) {
		return PushResult{}, nil
	}
	if err == nil {
		c.noteNow(out.NowMs)
	}
	return out, err
}

// pushBody is POST /v1/sync's request.
type pushBody struct {
	Changes  []Change `json:"changes"`
	NotAfter int64    `json:"not_after,omitempty"`
}

// PushResult is POST /v1/sync's answer: each change is either Applied (the
// service now holds what it asked for) or in Conflicts.
type PushResult struct {
	Rev int64 `json:"rev"`
	// NowMs is the service's clock as it answered, 0 for none (#826).
	NowMs   int64 `json:"now_ms"`
	Applied []struct {
		Collection string `json:"collection"`
		ID         string `json:"id"`
		Rev        int64  `json:"rev"`
	} `json:"applied"`
	Conflicts []Conflict `json:"conflicts"`
}

// Conflict is a change the service didn't write because its Base was
// stale: Server is the item it holds (perhaps a tombstone), or nil for
// none.
type Conflict struct {
	Collection string `json:"collection"`
	ID         string `json:"id"`
	Server     *Item  `json:"server"`
}
