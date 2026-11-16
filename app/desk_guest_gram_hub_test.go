package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// guestGramFixture saves three shared agents (two on Jerry's host, one on
// Alex's, the last without Gram) and connects the first, as a guest does.
func guestGramFixture(t *testing.T) (*Desk, *fakeherdr.GuestShares, string) {
	t.Helper()
	shares, err := fakeherdr.ParseGuestShares("market|Jerry|Mac Studio|gram;legal|Jerry|Mac Studio|gram,multi;ledger|Alex|lab-box|gram;quiet|Alex|lab-box|")
	if err != nil {
		t.Fatal(err)
	}
	owner := func(string, json.RawMessage) (any, *fakeherdr.APIError) { return nil, &fakeherdr.APIError{Code: "unknown_method"} }
	fx, err := fakeherdr.NewGuestShares(shares, owner, "w1:p2", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	base, err := fx.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fx.Close() })
	d := newDesk(t.TempDir())
	t.Cleanup(d.Disconnect)
	ids := map[string]string{}
	for _, g := range fx.Grants {
		access, err := d.AcceptGuestInvitation(context.Background(), g.Relay.InviteLink(base, time.Now().Add(time.Hour)))
		if err != nil {
			t.Fatal(err)
		}
		ids[g.Agent] = access.ID()
	}
	if err := d.ConnectGuest(ids["market"]); err != nil {
		t.Fatal(err)
	}
	return d, fx, ids["market"]
}

func grantState(s GuestGramSnapshot, agent string) (GuestGramState, bool) {
	for _, g := range s.Grants {
		if g.Grant.Agent == agent {
			return g, true
		}
	}
	return GuestGramState{}, false
}

// #697: a guest's Gram is every saved shared agent's at once, each read on
// its own link (not only the connected one), its ids prefixed with its grant,
// and a grant without Gram listed but never read.
func TestGuestGramReadsEverySharedAgent(t *testing.T) {
	d, _, _ := guestGramFixture(t)
	d.GuestGramSetVisible(true)
	loaded := func(s GuestGramSnapshot) bool {
		n := 0
		for _, g := range s.Grants {
			if g.Grant.Gram && g.Gram.Phase == "loaded" && len(g.Gram.Messages) == fakeherdr.GuestShareSeed {
				n++
			}
		}
		return n == 3
	}
	waitFor(t, "three shared agents' Gram", func() bool { return loaded(d.GuestGramState()) })
	s := d.GuestGramState()
	if !s.Active || len(s.Grants) != 4 {
		t.Fatalf("grants %+v", s.Grants)
	}
	quiet, _ := grantState(s, "quiet")
	if !quiet.Grant.Ready || quiet.Grant.Gram || len(quiet.Gram.Messages) != 0 {
		t.Fatalf("quiet (no Gram) %+v", quiet)
	}
	for _, agent := range []string{"market", "legal", "ledger"} {
		g, _ := grantState(s, agent)
		for _, m := range g.Gram.Messages {
			if !strings.HasPrefix(m.ID, g.Grant.ID+guestGramSep) {
				t.Fatalf("%s message id %q not prefixed with its grant", agent, m.ID)
			}
		}
		if g.Grant.Owner == "" || g.Grant.Machine == "" {
			t.Fatalf("%s grant %+v", agent, g.Grant)
		}
	}
}

// A mark read and a post reach their own grant's host; the composer posts to
// the chosen shared agent, and the Gram calls of the owner's state are idle.
func TestGuestGramRoutesReadsAndPostsByGrant(t *testing.T) {
	d, fx, _ := guestGramFixture(t)
	d.GuestGramSetVisible(true)
	waitFor(t, "ledger's Gram", func() bool {
		g, _ := grantState(d.GuestGramState(), "ledger")
		return len(g.Gram.Messages) == fakeherdr.GuestShareSeed
	})
	s := d.GuestGramState()
	ledger, _ := grantState(s, "ledger")
	var unread GramMessage
	for _, m := range ledger.Gram.Messages {
		if m.Unread {
			unread = m
			break
		}
	}
	if unread.ID == "" {
		t.Fatal("ledger has no unread message")
	}
	if err := d.GramMarkRead(context.Background(), unread.ID); err != nil {
		t.Fatal(err)
	}
	_, raw, _ := strings.Cut(unread.ID, guestGramSep)
	var ledgerGrant, legalGrant *fakeherdr.GuestGrant
	for _, g := range fx.Grants {
		switch g.Agent {
		case "ledger":
			ledgerGrant = g
		case "legal":
			legalGrant = g
		}
	}
	read := func(g *fakeherdr.GuestGrant, id string) bool {
		for _, m := range g.Gram.Messages() {
			if m.ID == id {
				return m.ReadByOwner
			}
		}
		return false
	}
	if !read(ledgerGrant, raw) {
		t.Fatalf("ledger's %s was not marked read on its host", raw)
	}

	legal, _ := grantState(s, "legal")
	if err := d.GuestGramSetRecipient(legal.Grant.ID); err != nil {
		t.Fatal(err)
	}
	if err := d.GramPost(context.Background(), "for legal", nil, nil); err != nil {
		t.Fatal(err)
	}
	posted := func(g *fakeherdr.GuestGrant) bool {
		for _, m := range g.Gram.Messages() {
			if m.Text == "for legal" {
				return m.Direction == herdrapi.GramDirectionOwnerToAgent && m.To != nil && *m.To == "legal"
			}
		}
		return false
	}
	if !posted(legalGrant) || posted(ledgerGrant) {
		t.Fatal("the post did not reach legal's host alone")
	}
	waitFor(t, "the post in legal's Gram", func() bool {
		g, _ := grantState(d.GuestGramState(), "legal")
		for _, m := range g.Gram.Messages {
			if m.Text == "for legal" && !m.FromAgent {
				return true
			}
		}
		return false
	})
	if owner := d.GramState(); owner.Phase != "idle" || len(owner.Messages) != 0 {
		t.Fatalf("the owner's Gram is not idle while a guest: %+v", owner.Phase)
	}
}

// Forgetting a shared agent drops it from the guest's Gram; connecting a
// machine as its owner ends the guest's Gram.
func TestGuestGramFollowsTheSavedSharesAndEndsForTheOwner(t *testing.T) {
	d, _, connected := guestGramFixture(t)
	waitFor(t, "four grants", func() bool { return len(d.GuestGramState().Grants) == 4 })
	ledger, _ := grantState(d.GuestGramState(), "ledger")
	if err := d.ForgetGuestConnection(ledger.Grant.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := grantState(d.GuestGramState(), "ledger"); ok {
		t.Fatal("a forgotten shared agent is still in the guest's Gram")
	}
	if err := d.ForgetGuestConnection(connected); err != nil {
		t.Fatal(err)
	}
	if d.GuestGramState().Active {
		t.Fatal("the guest's Gram runs after its connection was forgotten")
	}
}
