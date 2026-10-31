package main

import (
	"context"

	"github.com/jerryfane/herdrup-desktop/internal/gramstore"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// gramAnswer keeps the guest wire contract separate from owner API results.
// Like Swift GuestGramMessage.gramMessage(agent:), it projects the guest's
// read mark into the common feed model; it never receives owner read/claim data.
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
	page, err := l.guest.GramList(ctx, limit, params.BeforeID)
	if err != nil {
		return gramstore.Answer{}, err
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
	return answer, nil
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
