package fakeherdr_test

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/guest"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

type guestGramPage struct {
	Messages []struct {
		ID        string `json:"id"`
		Direction string `json:"direction"`
		From      string `json:"from"`
		Read      bool   `json:"read"`
	} `json:"messages"`
	HasMore bool `json:"has_more"`
}

func newShares(t *testing.T, spec string) *fakeherdr.GuestShares {
	t.Helper()
	grants, err := fakeherdr.ParseGuestShares(spec)
	if err != nil {
		t.Fatal(err)
	}
	shares, err := fakeherdr.NewGuestShares(grants, nil, "w1:p2", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return shares
}

// redeem accepts grant's invitation as identity's device and returns its
// transport and access.
func redeem(t *testing.T, base string, grant *fakeherdr.GuestGrant, identity guest.Identity) (*guest.Transport, guest.Access) {
	t.Helper()
	now := time.Now()
	invite, err := guest.Resolve(context.Background(), grant.Relay.InviteLink(base, now.Add(time.Hour)), now, nil)
	if err != nil {
		t.Fatal(err)
	}
	access, err := guest.Accept(context.Background(), invite, identity, "Desktop", now, nil)
	if err != nil {
		t.Fatalf("%s: %v", grant.Agent, err)
	}
	transport := guest.NewTransport(access, identity, guest.SystemClock, nil)
	t.Cleanup(func() { _ = transport.Close() })
	return transport, access
}

func gramPage(t *testing.T, transport *guest.Transport, before string) guestGramPage {
	t.Helper()
	params := map[string]any{"limit": 40}
	if before != "" {
		params["before_id"] = before
	}
	var page guestGramPage
	if err := transport.Call(context.Background(), "gram.list", params, &page); err != nil {
		t.Fatal(err)
	}
	return page
}

func TestGuestSharesServeEachGrantItsOwnAgentAndGram(t *testing.T) {
	shares := newShares(t, "enyo-market|Jerry|Mac Studio|gram,multi;enyo-legal|Jerry|Mac Studio|gram;ledger-qa|Alex|lab-box|gram,multi,pages")
	base, err := shares.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = shares.Close() })
	// One device redeems every grant, as one HerdrUp does.
	identity, err := guest.LoadIdentity(filepath.Join(t.TempDir(), "identity"))
	if err != nil {
		t.Fatal(err)
	}
	transports := make([]*guest.Transport, len(shares.Grants))
	accesses := make([]guest.Access, len(shares.Grants))
	for i, grant := range shares.Grants {
		transports[i], accesses[i] = redeem(t, base, grant, identity)
		if accesses[i].AgentName != grant.Agent || accesses[i].OwnerName != grant.Owner || accesses[i].MachineLabel != grant.Machine {
			t.Fatalf("grant %d access = %+v", i, accesses[i])
		}
	}
	if accesses[0].Endpoint.HostID != accesses[1].Endpoint.HostID || accesses[0].Endpoint.HostID == accesses[2].Endpoint.HostID {
		t.Fatalf("host ids %q %q %q: want the first two one host", accesses[0].Endpoint.HostID, accesses[1].Endpoint.HostID, accesses[2].Endpoint.HostID)
	}
	if accesses[0].GuestID == accesses[1].GuestID {
		t.Fatalf("grants of one host share guest id %q", accesses[0].GuestID)
	}
	for i, transport := range transports {
		grant := shares.Grants[i]
		var list struct {
			Agents []struct {
				Name   string `json:"name"`
				Status string `json:"agent_status"`
			} `json:"agents"`
		}
		if err := transport.Call(context.Background(), "agent.list", nil, &list); err != nil {
			t.Fatal(err)
		}
		if len(list.Agents) != 1 || list.Agents[0].Name != grant.Agent || list.Agents[0].Status != "working" {
			t.Fatalf("%s agent.list = %+v", grant.Agent, list.Agents)
		}
		if f := transport.Features(); !f.Gram || f.MultiRequest != grant.MultiRequest {
			t.Fatalf("%s features = %+v", grant.Agent, f)
		}
		page := gramPage(t, transport, "")
		want := fakeherdr.GuestShareSeed
		if grant.Pages {
			want = 40
		}
		if len(page.Messages) != want || page.HasMore != grant.Pages {
			t.Fatalf("%s gram.list: %d messages, has_more %v", grant.Agent, len(page.Messages), page.HasMore)
		}
		prefix := grant.Relay.TerminalID + "-"
		for _, m := range page.Messages {
			if !strings.HasPrefix(m.ID, prefix) || m.Direction == "agent_to_owner" && m.From != grant.Agent {
				t.Fatalf("%s listed another grant's message %+v", grant.Agent, m)
			}
		}
	}

	// gram.post and gram.mark_read reach only their grant's store.
	market, legal := shares.Grants[0], shares.Grants[1]
	before := len(legal.Gram.Messages())
	if err := transports[0].Call(context.Background(), "gram.post", map[string]any{"text": "hi", "to": "enyo-legal"}, nil); err != nil {
		t.Fatal(err)
	}
	posted := market.Gram.Messages()[len(market.Gram.Messages())-1]
	if posted.Text != "hi" || posted.To == nil || *posted.To != "enyo-market" || len(legal.Gram.Messages()) != before {
		t.Fatalf("post landed as %+v; legal store %d → %d", posted, before, len(legal.Gram.Messages()))
	}
	unread := legal.Gram.Messages()[len(legal.Gram.Messages())-1].ID
	if err := transports[1].Call(context.Background(), "gram.mark_read", map[string]any{"ids": []string{unread}}, nil); err != nil {
		t.Fatal(err)
	}
	if m := legal.Gram.Messages()[len(legal.Gram.Messages())-1]; !m.ReadByOwner {
		t.Fatalf("mark_read left %+v unread", m)
	}
	if err := transports[0].Call(context.Background(), "gram.mark_read", map[string]any{"ids": []string{unread}}, nil); err == nil {
		t.Fatal("market's gate marked legal's message read")
	}
}

func TestGuestSharesPagesThroughGramList(t *testing.T) {
	shares := newShares(t, "ledger-qa|Alex|lab-box|gram,pages")
	base, err := shares.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = shares.Close() })
	identity, err := guest.LoadIdentity(filepath.Join(t.TempDir(), "identity"))
	if err != nil {
		t.Fatal(err)
	}
	transport, _ := redeem(t, base, shares.Grants[0], identity)
	var ids []string
	before := ""
	for pages := 1; ; pages++ {
		page := gramPage(t, transport, before)
		for _, m := range page.Messages {
			ids = append(ids, m.ID)
		}
		if !page.HasMore {
			if pages != 3 {
				t.Fatalf("%d pages, want 3", pages)
			}
			break
		}
		before = page.Messages[len(page.Messages)-1].ID
	}
	slices.Sort(ids)
	if len(slices.Compact(ids)) != fakeherdr.GuestSharePagesSeed {
		t.Fatalf("paged %d distinct messages, want %d", len(ids), fakeherdr.GuestSharePagesSeed)
	}
}

func TestGuestSharesSeedInterleavesAcrossGrants(t *testing.T) {
	shares := newShares(t, "a|Jerry|Mac Studio|gram;b|Jerry|Mac Studio|gram;c|Alex|lab-box|gram")
	type seeded struct {
		grant int
		m     herdrapi.GramMessageInfo
	}
	var all []seeded
	ids := map[string]bool{}
	for i, grant := range shares.Grants {
		msgs := grant.Gram.Messages()
		if len(msgs) != fakeherdr.GuestShareSeed {
			t.Fatalf("%s seeded %d messages", grant.Agent, len(msgs))
		}
		var unread, read, posts int
		for _, m := range msgs {
			if ids[m.ID] {
				t.Fatalf("message id %q seeded twice", m.ID)
			}
			ids[m.ID] = true
			switch {
			case m.Direction == herdrapi.GramDirectionOwnerToAgent:
				posts++
			case m.ReadByOwner:
				read++
			default:
				unread++
			}
			all = append(all, seeded{i, m})
		}
		if unread != 2 || read != 3 || posts != 1 {
			t.Fatalf("%s seeded %d unread, %d read, %d posts", grant.Agent, unread, read, posts)
		}
	}
	slices.SortFunc(all, func(x, y seeded) int { return int(y.m.CreatedUnixMs) - int(x.m.CreatedUnixMs) })
	for k, s := range all {
		if s.grant != k%len(shares.Grants) {
			t.Fatalf("newest-first message %d is grant %d's: the grants do not interleave", k, s.grant)
		}
	}
}

func TestGuestSharesInjectAppendsToItsAgentsStore(t *testing.T) {
	shares := newShares(t, "a|Jerry|Mac Studio|gram;b|Alex|lab-box|gram")
	a, b := shares.Grants[0], shares.Grants[1]
	file := filepath.Join(t.TempDir(), "inject")
	if injected, err := shares.InjectFile(file); err != nil || injected != nil {
		t.Fatalf("absent file injected %v, %v", injected, err)
	}
	if err := os.WriteFile(file, []byte("b|Fresh from b\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	injected, err := shares.InjectFile(file)
	if err != nil || len(injected) != 1 {
		t.Fatalf("injected %v, %v", injected, err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("inject file left behind: %v", err)
	}
	if len(a.Gram.Messages()) != fakeherdr.GuestShareSeed {
		t.Fatal("inject reached a's store")
	}
	msgs := b.Gram.Messages()
	last := msgs[len(msgs)-1]
	if len(msgs) != fakeherdr.GuestShareSeed+1 || last.Text != "Fresh from b" || last.From != "b" ||
		last.Direction != herdrapi.GramDirectionAgentToOwner || last.ReadByOwner || last.CreatedUnixMs < msgs[len(msgs)-2].CreatedUnixMs {
		t.Fatalf("injected %+v", last)
	}
	if _, err := shares.Inject("nobody", "x"); err == nil {
		t.Fatal("injected to an agent no grant shares")
	}
}

func TestParseGuestSharesRefusesMalformedGrants(t *testing.T) {
	for _, spec := range []string{"", "a|b|c", "a||c|gram", "a|b|c|bogus", "a|b|c|gram;a|d|e|gram"} {
		if _, err := fakeherdr.ParseGuestShares(spec); err == nil {
			t.Errorf("ParseGuestShares(%q) accepted", spec)
		}
	}
	shares, err := fakeherdr.ParseGuestShares(" x | Jerry | Mac Studio | gram, multi ;y|Alex|lab|")
	if err != nil {
		t.Fatal(err)
	}
	want := []fakeherdr.GuestShare{{Agent: "x", Owner: "Jerry", Machine: "Mac Studio", Gram: true, MultiRequest: true}, {Agent: "y", Owner: "Alex", Machine: "lab"}}
	if !slices.Equal(shares, want) {
		t.Fatalf("parsed %+v", shares)
	}
}
