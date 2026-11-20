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
// writes some. Only the hosts collection is used by the desktop app so far.

// Item is one synced item as the service sends it.
type Item struct {
	Collection string          `json:"collection"`
	ID         string          `json:"id"`
	Rev        int64           `json:"rev"`
	UpdatedMs  int64           `json:"updated_ms"`
	Deleted    bool            `json:"deleted"`
	Body       json.RawMessage `json:"body"`
}

// Change is one write in a push. Body is nil for a delete.
type Change struct {
	Collection string `json:"collection"`
	ID         string `json:"id"`
	BaseRev    *int64 `json:"base_rev,omitempty"`
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

// Pull is the result of reading the service's changes.
type Pull struct {
	// Rev is the next pull's since.
	Rev int64
	// Items are the changes, oldest first.
	Items []Item
	// Full means Items is the whole account: anything held locally that it
	// does not list is gone (a since=0 pull, or a reset_required restart).
	Full bool
}

// ErrResetRequired is the service's 410: the caller may have missed a
// pruned delete. PullSince turns it into a full pull itself.
var ErrResetRequired = errors.New("account: sync reset required")

const maxPullPages = 64 // 64 × 500 items, past the 2,000-item account cap

// PullSince reads every change after since, following the cursor. A 410
// restarts from 0 and the result is Full.
// Every request is for account acct: ErrAccountChanged once another
// account is signed in.
func (c *Client) PullSince(ctx context.Context, acct string, since int64) (Pull, error) {
	p, err := c.pull(ctx, acct, since)
	if errors.Is(err, ErrResetRequired) && since != 0 {
		return c.pull(ctx, acct, 0)
	}
	return p, err
}

func (c *Client) pull(ctx context.Context, acct string, since int64) (Pull, error) {
	out := Pull{Full: since == 0}
	query := url.Values{"since": {strconv.FormatInt(since, 10)}}
	for page := 0; page < maxPullPages; page++ {
		var answer struct {
			Rev     int64  `json:"rev"`
			Changes []Item `json:"changes"`
			More    bool   `json:"more"`
			Cursor  string `json:"cursor"`
		}
		if err := c.authed(ctx, acct, http.MethodGet, "/v1/sync?"+query.Encode(), nil, &answer); err != nil {
			var api *APIError
			if errors.As(err, &api) && api.Status == http.StatusGone {
				return Pull{}, ErrResetRequired
			}
			return Pull{}, err
		}
		out.Items = append(out.Items, answer.Changes...)
		out.Rev = answer.Rev
		if !answer.More {
			return out, nil
		}
		if answer.Cursor == "" {
			return Pull{}, errors.New("account service: a page with more and no cursor")
		}
		query = url.Values{"cursor": {answer.Cursor}}
	}
	return Pull{}, fmt.Errorf("account service: more than %d sync pages", maxPullPages)
}

// Push writes changes (≤100) to account acct and returns the service's
// answer; ErrAccountChanged once another account is signed in.
func (c *Client) Push(ctx context.Context, acct string, changes []Change) (PushResult, error) {
	var out PushResult
	if len(changes) == 0 {
		return out, nil
	}
	err := c.authed(ctx, acct, http.MethodPost, "/v1/sync", map[string]any{"changes": changes}, &out)
	return out, err
}

// PushResult is POST /v1/sync's answer.
type PushResult struct {
	Rev     int64 `json:"rev"`
	Applied []struct {
		Collection string `json:"collection"`
		ID         string `json:"id"`
		Rev        int64  `json:"rev"`
	} `json:"applied"`
	Conflicts []struct {
		Collection string `json:"collection"`
		ID         string `json:"id"`
		Server     *Item  `json:"server"`
	} `json:"conflicts"`
}
