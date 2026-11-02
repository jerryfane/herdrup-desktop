package main

import (
	"context"
	"fmt"
	"slices"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/guest"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// guestHistory serves a newest-first guest gram.list in pages, as the host does.
type guestHistory struct {
	messages []guest.GramMessage
	asked    []string
}

func (h *guestHistory) GramList(_ context.Context, limit uint64, before *string) (guest.GramPage, error) {
	from := 0
	if before != nil {
		h.asked = append(h.asked, *before)
		from = slices.IndexFunc(h.messages, func(m guest.GramMessage) bool { return m.ID == *before }) + 1
	} else {
		h.asked = append(h.asked, "")
	}
	to := min(from+int(limit), len(h.messages))
	return guest.GramPage{Messages: h.messages[from:to], HasMore: to < len(h.messages)}, nil
}

// An unread-only ask (the badge, Mark all read) covers the whole guest
// conversation: 40 newer read messages must not hide an older unread one.
func TestGuestUnreadOnlyFollowsOlderPages(t *testing.T) {
	history := &guestHistory{}
	for i := range gramPageSize {
		history.messages = append(history.messages, guest.GramMessage{ID: fmt.Sprintf("read-%d", i), Direction: herdrapi.GramDirectionAgentToOwner, Read: true})
	}
	history.messages = append(history.messages, guest.GramMessage{ID: "old-unread", Direction: herdrapi.GramDirectionAgentToOwner})

	page, err := guestGramPage(context.Background(), history, gramPageSize, herdrapi.GramListParams{UnreadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if page.HasMore || len(page.Messages) != gramPageSize+1 || page.Messages[gramPageSize].ID != "old-unread" {
		t.Fatalf("unread-only ask stopped at the first page: %d messages, hasMore=%v, asked %q", len(page.Messages), page.HasMore, history.asked)
	}

	history.asked = nil
	page, err = guestGramPage(context.Background(), history, gramPageSize, herdrapi.GramListParams{})
	if err != nil || len(history.asked) != 1 || len(page.Messages) != gramPageSize || !page.HasMore {
		t.Fatalf("a head load must stay one page: %d messages, asked %q, %v", len(page.Messages), history.asked, err)
	}
}
