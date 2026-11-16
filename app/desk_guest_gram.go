package main

import (
	"context"
	"time"

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

// pacedLister spaces a shared agent's relay requests on a host without
// session reuse (gramDesk.requestCost): every list takes a turn, and the
// pages after a read's first wait for theirs, so a walk of every page (a
// hidden badge, Mark all read) stays within the agent's share of the relay's
// connects instead of bursting through them. A read's first request goes at
// once (a Refresh, Earlier); polls wait for the next turn (watchGram).
type pacedLister struct {
	guestGramLister
	g     *gramDesk
	asked bool
}

func (p *pacedLister) GramList(ctx context.Context, limit uint64, before *string) (guest.GramPage, error) {
	if err := p.g.takeTurn(ctx, p.asked); err != nil {
		return guest.GramPage{}, err
	}
	p.asked = true
	return p.guestGramLister.GramList(ctx, limit, before)
}

// takeTurn takes this shared agent's next relay request turn, waiting for it
// when wait says so; no turns without a requestCost (the owner's Gram, a
// multi_request host).
func (g *gramDesk) takeTurn(ctx context.Context, wait bool) error {
	g.mu.Lock()
	now := time.Now()
	next := now
	if g.nextRequest.After(now) {
		next = g.nextRequest
	}
	turn := now
	if wait {
		turn = next
	}
	if g.requestCost > 0 {
		g.nextRequest = next.Add(g.requestCost)
	}
	g.mu.Unlock()
	if !turn.After(now) {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(turn.Sub(now)):
		return nil
	}
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
	var lister guestGramLister = l.guest
	if l.gram != nil {
		lister = &pacedLister{guestGramLister: l.guest, g: l.gram}
	}
	page, listErr := guestGramPage(ctx, lister, limit, params)
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
