package guest

import (
	"context"
	"errors"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// GramMessage is the host's guest projection: it deliberately has no owner
// read mark, queue claim, machine label or origin. Read belongs to this guest.
type GramMessage struct {
	ID            string                 `json:"id"`
	Direction     herdrapi.GramDirection `json:"direction"`
	From          string                 `json:"from"`
	Text          string                 `json:"text"`
	CreatedUnixMs uint64                 `json:"created_unix_ms"`
	File          *herdrapi.GramFileInfo `json:"file,omitempty"`
	ExpiredFile   *herdrapi.GramFileInfo `json:"expired_file,omitempty"`
	Read          bool                   `json:"read"`
}
type GramPage struct {
	Messages []GramMessage `json:"messages"`
	HasMore  bool          `json:"has_more"`
}

func (t *Transport) GramList(ctx context.Context, limit uint64, before *string) (GramPage, error) {
	if limit == 0 {
		limit = 100
	}
	limit = min(limit, 500)
	var page GramPage
	err := t.Call(ctx, "gram.list", struct {
		Limit  uint64  `json:"limit"`
		Before *string `json:"before_id,omitempty"`
	}{limit, before}, &page)
	return page, err
}
func (t *Transport) GramMarkRead(ctx context.Context, ids []string) error {
	return t.Call(ctx, "gram.mark_read", struct {
		IDs []string `json:"ids"`
	}{ids}, nil)
}
func (t *Transport) GramPost(ctx context.Context, params herdrapi.GramPostParams) (string, error) {
	// The authenticated receipt guarantees only an id. Do not synthesize an
	// owner message; refresh the guest projection after the post instead.
	var reply struct {
		Message struct {
			ID string `json:"id"`
		} `json:"message"`
	}
	if err := t.Call(ctx, "gram.post", params, &reply); err != nil {
		return "", err
	}
	if reply.Message.ID == "" {
		return "", errors.New("The shared agent did not confirm the posted Gram")
	}
	return reply.Message.ID, nil
}
