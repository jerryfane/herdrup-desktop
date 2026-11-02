package main

import (
	"context"

	"github.com/jerryfane/herdrup-desktop/internal/gramstore"
	"github.com/jerryfane/herdrup-desktop/internal/guest"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// guestGramLister is the guest transport's history read.
type guestGramLister interface {
	GramList(ctx context.Context, limit uint64, before *string) (guest.GramPage, error)
}

// guestGramPage reads the guest history asked for. The host has no
// unread_only filter for guests, so an unread-only ask (the badge, Mark all
// read) walks every older page: the newest page alone misses older unread.
// When an older page fails, the pages already read come back with the error,
// marked HasMore: the listing is incomplete, not empty.
func guestGramPage(ctx context.Context, lister guestGramLister, limit uint64, params herdrapi.GramListParams) (guest.GramPage, error) {
	page, err := lister.GramList(ctx, limit, params.BeforeID)
	if err != nil {
		return guest.GramPage{}, err
	}
	if !params.UnreadOnly {
		return page, nil
	}
	for next := page; next.HasMore && len(next.Messages) > 0; {
		before := next.Messages[len(next.Messages)-1].ID
		if next, err = lister.GramList(ctx, limit, &before); err != nil {
			page.HasMore = true
			return page, err
		}
		if len(next.Messages) > 0 && next.Messages[len(next.Messages)-1].ID == before {
			break // a cursor that does not advance would never end
		}
		page.Messages = append(page.Messages, next.Messages...)
		page.HasMore = next.HasMore
	}
	return page, nil
}

// gramAnswer keeps the guest wire contract separate from owner API results.
// Like Swift GuestGramMessage.gramMessage(agent:), it projects the guest's
// read mark into the common feed model; it never receives owner read/claim data.
// With an error, the answer still holds what an unread-only guest walk listed
// before an older page failed.
func (d *Desk) gramAnswer(ctx context.Context, l *link, params herdrapi.GramListParams) (gramstore.Answer, error) {
	ec, err := d.gramEngine(l)
	if err != nil {
		return gramstore.Answer{}, err
	}
	if l.guest == nil {
		listing, err := ec.GramList(ctx, params)
		return gramstore.FromList(listing.List, listing.Unchanged), err
	}
	limit := uint64(gramPageSize)
	if params.Limit != nil {
		limit = *params.Limit
	}
	page, listErr := guestGramPage(ctx, l.guest, limit, params)
	if listErr != nil && len(page.Messages) == 0 {
		return gramstore.Answer{}, listErr
	}
	d.mu.Lock()
	agent := l.access.AgentName
	for _, listed := range l.agents {
		if listed.Name != nil {
			agent = *listed.Name
			break
		}
	}
	d.mu.Unlock()
	answer := gramstore.Answer{Messages: make([]herdrapi.GramMessageInfo, 0, len(page.Messages)), HasMore: page.HasMore}
	for _, message := range page.Messages {
		item := herdrapi.GramMessageInfo{ID: message.ID, Direction: message.Direction, From: message.From, Text: message.Text, CreatedUnixMs: message.CreatedUnixMs, ReadByOwner: message.Read, File: message.File, ExpiredFile: message.ExpiredFile}
		if item.File != nil {
			item.ExpiredFile = nil
		}
		if item.Direction != herdrapi.GramDirectionAgentToOwner {
			item.To = &agent
		}
		if !params.UnreadOnly || gramstore.IsUnread(item) {
			answer.Messages = append(answer.Messages, item)
		}
	}
	return answer, listErr
}
func (d *Desk) gramRead(ctx context.Context, l *link, id string) error {
	ec, err := d.gramEngine(l)
	if err != nil {
		return err
	}
	if l.guest != nil {
		return l.guest.GramMarkRead(ctx, []string{id})
	}
	return ec.GramMarkRead(ctx, herdrapi.GramMarkReadParams{ID: &id})
}
