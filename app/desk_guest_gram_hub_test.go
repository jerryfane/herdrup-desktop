package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/guest"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// guestGramFixture saves three shared agents (two on Jerry's host, one on
// Alex's, the last without Gram) and connects the first, as a guest does.
func guestGramFixture(t *testing.T) (*Desk, *fakeherdr.GuestShares, string) {
	t.Helper()
	return guestGramFixtureOf(t, "market|Jerry|Mac Studio|gram;legal|Jerry|Mac Studio|gram,multi;ledger|Alex|lab-box|gram;quiet|Alex|lab-box|")
}

// guestGramFixtureOf accepts every share of spec (fakeherdr -guest-shares)
// and connects the one of agent "market".
func guestGramFixtureOf(t *testing.T, spec string) (*Desk, *fakeherdr.GuestShares, string) {
	t.Helper()
	shares, err := fakeherdr.ParseGuestShares(spec)
	if err != nil {
		t.Fatal(err)
	}
	owner := func(string, json.RawMessage) (any, *fakeherdr.APIError) {
		return nil, &fakeherdr.APIError{Code: "unknown_method"}
	}
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

// #227 review: the agent page's Chat attachments download through the shared
// agent's combined guest Gram link: the owner's Gram is idle while a guest.
func TestGuestChatAttachmentsUseTheSharedAgentsGramLink(t *testing.T) {
	d, _, connected := guestGramFixture(t)
	d.GuestGramSetVisible(true)
	waitFor(t, "market's Gram", func() bool {
		g, _ := grantState(d.GuestGramState(), "market")
		return g.Grant.Gram && g.Gram.Phase == "loaded"
	})
	l, err := d.attachmentLink()
	if err != nil {
		t.Fatalf("attachment link: %v", err)
	}
	if l.access.ID() != connected || l.gram == nil {
		t.Fatalf("attachment link is %q, want the connected share's Gram link %q", l.access.ID(), connected)
	}
}

// #227 review: files attached have uploaded to the recipient's host, so the
// recipient holds until they are sent or removed, whoever asks to change it.
func TestGuestGramRecipientHoldsWhileFilesAreAttached(t *testing.T) {
	d, _, _ := guestGramFixture(t)
	d.GuestGramSetVisible(true)
	waitFor(t, "two shared agents with Gram", func() bool {
		s := d.GuestGramState()
		a, _ := grantState(s, "market")
		b, _ := grantState(s, "legal")
		return a.Grant.Gram && b.Grant.Gram && a.Gram.Phase == "loaded" && b.Gram.Phase == "loaded"
	})
	s := d.GuestGramState()
	market, _ := grantState(s, "market")
	legal, _ := grantState(s, "legal")
	if err := d.GuestGramSetRecipient(market.Grant.ID); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(file, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := d.GramAttachFiles([]string{file}); err != nil {
		t.Fatal(err)
	}
	if err := d.GuestGramSetRecipient(legal.Grant.ID); err == nil {
		t.Fatal("the recipient moved while a file was attached to another host")
	}
	if err := d.GramCancelAttachment(file); err != nil {
		t.Fatal(err)
	}
	if err := d.GuestGramSetRecipient(legal.Grant.ID); err != nil {
		t.Fatalf("the recipient stayed locked after the file was removed: %v", err)
	}
}

// #227 review: a shared agent's saved message is kept under its
// "<grant>\x1f<id>"; when its host expires the file, the saved copy follows.
func TestGuestGramSavedFileExpiresWithItsHost(t *testing.T) {
	d, fx, _ := guestGramFixture(t)
	market := fx.Grants[0]
	market.Gram.Add(herdrapi.GramMessageInfo{ID: "with-file", CreatedUnixMs: uint64(time.Now().UnixMilli()),
		Direction: herdrapi.GramDirectionAgentToOwner, From: market.Agent, Text: "the report",
		File: &herdrapi.GramFileInfo{Name: "report.pdf", Mime: "application/pdf"}}, []byte("pdf"))
	d.GuestGramSetVisible(true)
	var id string
	waitFor(t, "the message with a file", func() bool {
		g, _ := grantState(d.GuestGramState(), "market")
		for _, m := range g.Gram.Messages {
			if strings.HasSuffix(m.ID, guestGramSep+"with-file") {
				id = m.ID
				return true
			}
		}
		return false
	})
	if err := d.GramSetSaved(id, true); err != nil {
		t.Fatal(err)
	}
	market.Gram.Update("with-file", func(m *herdrapi.GramMessageInfo) { m.ExpiredFile, m.File = m.File, nil })
	waitFor(t, "the saved copy's file to expire", func() bool {
		d.GuestGramRefresh(context.Background(), nil)
		for _, s := range d.GuestGramState().Saved {
			if s.ID == id {
				return s.File == nil && s.ExpiredFile != nil
			}
		}
		return false
	})
}

// #227 review: on a host without session reuse every relay request is a
// connect; a read that walks many pages (a hidden badge) spaces its requests
// by the agent's request cost rather than bursting through the relay's
// connect limit and paying for it afterwards.
func TestGuestGramWalkSpacesItsRelayRequests(t *testing.T) {
	d, fx, connected := guestGramFixtureOf(t, "market|Jerry|Mac Studio|gram")
	h := d.guestGram.Load()
	var l *link
	waitFor(t, "market's Gram polling set up", func() bool {
		h.mu.Lock()
		l = h.links[connected]
		h.mu.Unlock()
		if l == nil || l.gram == nil {
			return false
		}
		l.gram.mu.Lock()
		defer l.gram.mu.Unlock()
		return l.gram.requestCost > 0
	})
	const cost = 80 * time.Millisecond
	l.gram.mu.Lock()
	l.gram.requestCost, l.gram.nextRequest = cost, time.Time{}
	l.gram.mu.Unlock()
	market := fx.Grants[0]
	now := time.Now().UnixMilli()
	for i := range 3 * gramPageSize {
		market.Gram.Add(herdrapi.GramMessageInfo{ID: fmt.Sprintf("old-%03d", i), CreatedUnixMs: uint64(now - int64(10_000+i)),
			Direction: herdrapi.GramDirectionAgentToOwner, From: market.Agent, Text: "history"}, nil)
	}
	// The fixture's own poll may overlap (a read's first request goes at
	// once): count this walk's requests and time it.
	l.gram.mu.Lock()
	l.gram.nextRequest = time.Time{}
	l.gram.mu.Unlock()
	counted := &countLister{guestGramLister: l.guest}
	lister := &pacedLister{guestGramLister: counted, g: l.gram}
	start := time.Now()
	if _, err := guestGramPage(context.Background(), lister, gramPageSize, herdrapi.GramListParams{UnreadOnly: true}); err != nil {
		t.Fatal(err)
	}
	took := time.Since(start)
	if counted.n < 4 {
		t.Fatalf("the walk made %d requests, want every page's (4)", counted.n)
	}
	if want := time.Duration(counted.n-1) * cost * 3 / 4; took < want {
		t.Fatalf("a %d-request walk took %v, want at least %v: its requests burst", counted.n, took, want)
	}
}

// #227 review: a shared agent's Chat attachment outside the loaded feed never
// takes the owner's saved copy of the same raw id for its file's name and size.
func TestGuestChatAttachmentIgnoresTheOwnersSavedCopyOfTheSameID(t *testing.T) {
	d, fx, _ := guestGramFixture(t)
	opened := ""
	d.openPath = func(p string) error { opened = p; return nil }
	market := fx.Grants[0]
	data := []byte("the shared agent's notes")
	market.Gram.Add(herdrapi.GramMessageInfo{ID: "same-id", CreatedUnixMs: uint64(time.Now().UnixMilli()),
		Direction: herdrapi.GramDirectionAgentToOwner, From: market.Agent, Text: "notes",
		File: &herdrapi.GramFileInfo{Name: "notes.txt", Mime: "text/plain", Size: uint64(len(data))}}, data)
	if _, err := d.savedGrams().Save(herdrapi.GramMessageInfo{ID: "same-id", CreatedUnixMs: 1,
		Direction: herdrapi.GramDirectionAgentToOwner, From: "owner-agent", Text: "owner's",
		File: &herdrapi.GramFileInfo{Name: "owner.txt", Mime: "text/plain", Size: 99_999}}, "owner-agent"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "market's Gram", func() bool {
		g, _ := grantState(d.GuestGramState(), "market")
		return g.Grant.Gram
	})
	if err := d.GramOpenAttachment(context.Background(), "same-id"); err != nil {
		t.Fatalf("open the shared agent's attachment: %v", err)
	}
	if got, err := os.ReadFile(opened); err != nil || string(got) != string(data) {
		t.Fatalf("opened %q holding %q (%v), want the shared agent's notes", opened, got, err)
	}
}

// #227 review: opening Gram interrupts a paced hidden walk; the head load
// does not wait for every older page.
func TestGuestGramOpeningInterruptsAHiddenWalk(t *testing.T) {
	d, fx, connected := guestGramFixtureOf(t, "market|Jerry|Mac Studio|gram")
	h := d.guestGram.Load()
	var l *link
	waitFor(t, "market's hidden badge poll", func() bool {
		l = h.link(connected)
		if l == nil || l.gram == nil {
			return false
		}
		l.gram.mu.Lock()
		defer l.gram.mu.Unlock()
		return l.gram.requestCost > 0 && l.gram.wake != nil
	})
	market := fx.Grants[0]
	now := time.Now().UnixMilli()
	for i := range 4 * gramPageSize {
		market.Gram.Add(herdrapi.GramMessageInfo{ID: fmt.Sprintf("old-%03d", i), CreatedUnixMs: uint64(now - int64(10_000+i)),
			Direction: herdrapi.GramDirectionAgentToOwner, From: market.Agent, Text: "history"}, nil)
	}
	l.gram.mu.Lock()
	l.gram.requestCost, l.gram.nextRequest = time.Second, time.Time{}
	l.gram.mu.Unlock()
	// Start a hidden badge walk: about a second a page.
	select {
	case l.gram.wake <- struct{}{}:
	default:
	}
	time.Sleep(300 * time.Millisecond)
	opened := time.Now()
	d.GuestGramSetVisible(true)
	for {
		g, _ := grantState(d.GuestGramState(), "market")
		if g.Gram.Phase == "loaded" && len(g.Gram.Messages) > 0 {
			break
		}
		if time.Since(opened) > 1500*time.Millisecond {
			t.Fatalf("Gram still %q with %d messages %v after opening: the hidden walk held the head load", g.Gram.Phase, len(g.Gram.Messages), time.Since(opened))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

type countLister struct {
	guestGramLister
	n int
}

func (c *countLister) GramList(ctx context.Context, limit uint64, before *string) (guest.GramPage, error) {
	c.n++
	return c.guestGramLister.GramList(ctx, limit, before)
}
