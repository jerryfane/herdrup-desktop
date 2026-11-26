package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/account"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/guest"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// GuestInvitation contains display information, not the invitation bearer.
type GuestInvitation struct {
	MachineLabel string    `json:"machineLabel"`
	OwnerName    string    `json:"ownerName"`
	AgentName    string    `json:"agentName"`
	GuestName    string    `json:"guestName"`
	Expires      time.Time `json:"expires"`
	Fingerprint  string    `json:"fingerprint"`
	// Account is an invitation whose host takes HerdrUp accounts (its
	// acct): the guest may keep the share on the account
	// (AcceptGuestInvitation's keep).
	Account bool `json:"account"`
}
type GuestConnection struct {
	Access      guest.Access   `json:"access"`
	Features    guest.Features `json:"features"`
	Fingerprint string         `json:"fingerprint"`
	// Availability classifies an "error" phase as herdrup's guest home does
	// (App/GuestHomeView.swift 346-356): "offline" when the relay reports the
	// machine offline, "lost" when the owner no longer shares the agent, ""
	// otherwise. "reconnecting" goes with a "connecting" or "connected" phase
	// instead: the relay refuses this network's connects (429 rate_limited)
	// and the guest waits to try again (Message says how long). "paused" goes
	// with "connected": the owner's agent is not running or not listed
	// (App/GuestPaneView.swift:737-753).
	Availability string `json:"availability,omitempty"`
	// OwnerScope is a web owner link's admitted grant scope, "chat" or
	// "terminal" (herdr owner_gate.rs): only "terminal" types into the
	// terminal. The browser Desk sets it; a guest's share never has one.
	OwnerScope string `json:"ownerScope,omitempty"`
}

var GuestInvitationOpened = mygo.NewEvent[bool]("guest-invitation:opened")

// queueGuestInvitation keeps an app link the system opened with herdrup for
// the page, as herdrup://guest-invite#<payload> whichever spelling it came in.
func (d *Desk) queueGuestInvitation(text string) bool {
	link, ok := guest.AppLink(text)
	if !ok {
		return false
	}
	d.mu.Lock()
	d.pendingGuestInvite = link
	d.mu.Unlock()
	GuestInvitationOpened.Broadcast(true)
	return true
}

// TakeGuestInvitation hands a launch URL to the page once, without persisting it.
func (d *Desk) TakeGuestInvitation() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	text := d.pendingGuestInvite
	d.pendingGuestInvite = ""
	return text
}

func (d *Desk) guestIdentity() (guest.Identity, error) {
	shares, err := d.guestStore.List()
	if err != nil {
		return guest.Identity{}, err
	}
	path := filepath.Join(d.dir, "guest-identity")
	if len(shares) > 0 {
		return guest.ExistingIdentity(path)
	}
	return guest.LoadIdentity(path)
}

// InspectGuestInvitation reads an invitation for review. A short link's sealed
// invite is fetched from its relay first, so this can fail with
// guest.ErrInviteRevoked or the retryable guest.ErrInviteUnreachable.
func (d *Desk) InspectGuestInvitation(ctx context.Context, text string) (GuestInvitation, error) {
	invite, err := guest.Resolve(ctx, text, time.Now(), d.inviteTransport)
	if err != nil {
		return GuestInvitation{}, err
	}
	identity, err := d.guestIdentity()
	if err != nil {
		return GuestInvitation{}, err
	}
	return GuestInvitation{MachineLabel: invite.MachineLabel, OwnerName: invite.OwnerName, AgentName: invite.AgentName, GuestName: invite.GuestName, Expires: invite.Expires, Fingerprint: identity.Fingerprint(), Account: invite.Account}, nil
}

// guestStatements gives a bound share's statements, from the signed-in
// account's cache; nil on a desk without an account client.
func (d *Desk) guestStatements() guest.StatementSource {
	if d.statements == nil {
		return nil
	}
	return guestStatementSource{d.statements}
}

// guestStatementSource is the account's StatementCache as a guest's
// statements: each one live while the sign-in it was issued in is the
// current one, and signed out is guest.ErrAccountRequired.
type guestStatementSource struct{ cache *account.StatementCache }

func (g guestStatementSource) Statement(ctx context.Context, host string, minLeft time.Duration) (guest.Statement, error) {
	got, err := g.cache.Get(ctx, host, minLeft)
	if errors.Is(err, account.ErrSignedOut) {
		return guest.Statement{}, guest.ErrAccountRequired
	}
	if err != nil {
		return guest.Statement{}, err
	}
	return guest.Statement{JWS: got.JWS, Exp: got.Exp, Live: func() bool { return g.cache.Live(got) }, Account: got.Account()}, nil
}

func (g guestStatementSource) Drop(host, jws string) { g.cache.Drop(host, jws) }

// SharedConnections is every grant this device holds, in their order, each
// naming its machine as its host's latest hello did: the label on the
// host's grant a hello named last (guest.Access.NamedAt), whichever grant
// comes first, as a sibling opened since may hold an older name until its
// own hello. Each grant keeps its own label saved; only the copies
// returned are named so. A bound grant says how its item stands in its
// account (guest.Access.AccountShare).
func (d *Desk) SharedConnections() ([]guest.Access, error) {
	list, err := d.guestStore.List()
	if err != nil {
		return nil, err
	}
	return d.withAccountShares(sharedConnectionsOf(list))
}

// sharedConnectionsOf is SharedConnections' naming of held, in place.
func sharedConnectionsOf(held []guest.Access) []guest.Access {
	latest := map[string]guest.Access{}
	for _, g := range held {
		if had, ok := latest[g.Endpoint.HostID]; !ok || g.NamedAt().After(had.NamedAt()) {
			latest[g.Endpoint.HostID] = g
		}
	}
	for i, g := range held {
		held[i].MachineLabel = latest[g.Endpoint.HostID].MachineLabel
	}
	return held
}

// AcceptGuestInvitation redeems an invitation, keeping the share as keep
// says (herdrup#700): "account" binds an invitation whose host takes
// accounts (GuestInvitation.Account) to the signed-in HerdrUp account (the
// redemption carries its statement), and a share the host bound goes to
// the shares of the account it was bound to (Access.Account: the
// admitted statement's), for every device of it; "device" keeps it on
// this device only, as any other invitation is. A bound share's write is
// sent at once, one sync round within acceptShareWait, and the access says
// how it stands (Access.AccountShare): confirmed only once the account
// holds it, refused with why, else queued for the next sync.
func (d *Desk) AcceptGuestInvitation(ctx context.Context, text, keep string) (guest.Access, error) {
	if keep != "account" && keep != "device" {
		return guest.Access{}, fmt.Errorf("unknown way to keep a share: %q", keep)
	}
	d.guestAcceptMu.Lock()
	defer d.guestAcceptMu.Unlock()
	invite, err := guest.Resolve(ctx, text, time.Now(), d.inviteTransport)
	if err != nil {
		return guest.Access{}, err
	}
	var bind guest.StatementSource
	if keep == "account" && invite.Account {
		cur, _ := d.account.Current()
		if bind = d.guestStatements(); cur == nil || bind == nil {
			return guest.Access{}, account.ErrSignedOut
		}
	}
	identity, err := d.guestIdentity()
	if err != nil {
		return guest.Access{}, err
	}
	device, err := os.Hostname()
	if err != nil || device == "" {
		device = "Desktop"
	}
	access, err := guest.Accept(ctx, invite, identity, device, time.Now(), bind)
	if err != nil {
		return guest.Access{}, err
	}
	// A successful redemption is irrevocable. Save even if the dialog's context
	// was cancelled immediately after the authenticated reply arrived.
	if err := d.guestStore.Save(access); err != nil {
		return guest.Access{}, fmt.Errorf("Access was accepted but could not be saved: %w. Keep this device's guest identity and ask the owner for a new invitation", err)
	}
	d.syncGuestGram()
	if access.AccountBound {
		if err := d.noteShare(access, false); err != nil {
			return guest.Access{}, fmt.Errorf("Access was accepted and saved on this device, but could not be added to your HerdrUp account: %w", err)
		}
		d.confirmShare()
		// Unread, the access says nothing of the account (no AccountShare),
		// never that it holds the share.
		if told, err := d.withAccountShares([]guest.Access{access}); err == nil {
			access = told[0]
		}
	}
	return access, nil
}
func (d *Desk) ConnectGuest(id string) error {
	list, err := d.guestStore.List()
	if err != nil {
		return err
	}
	var access *guest.Access
	for _, item := range list {
		if item.ID() == id {
			copy := item
			access = &copy
			break
		}
	}
	if access == nil {
		return errors.New("This shared connection is no longer saved")
	}
	identity, err := guest.ExistingIdentity(filepath.Join(d.dir, "guest-identity"))
	if err != nil {
		return err
	}
	transport := guest.NewTransport(*access, identity, d.guestClock, d.guestStatements(), func(label string) { d.guestRelabeled(id, label) })
	ctx, cancel := context.WithCancel(context.Background())
	l := &link{id: "guest:" + id, shareLabel: access.MachineLabel, guest: transport, guestClient: engine.New(transport), access: access, guestPoll: make(chan struct{}, 1), ctx: ctx}
	d.mu.Lock()
	if d.cancel != nil {
		d.cancel()
	}
	d.cancel = cancel
	d.link = l
	d.board, d.peers = nil, nil
	d.presence.show(nil, "", "")
	// A guest's Gram is every shared agent's at once (desk_guest_gram_hub.go),
	// installed with the link as start does the owner's: the owner's Gram
	// ends and the downloads become this connection's.
	x := detached{composer: d.gramSwap(nil, ""), cache: d.gramClaimCache(l.id)}
	hub := d.installGuestGram()
	d.mu.Unlock()
	x.stop()
	x.remove()
	hub.sync()
	go func() {
		defer cancel()
		d.runGuest(ctx, l, identity.Fingerprint())
	}()
	return nil
}

// ForgetGuestConnection lets go of a grant on this device. A bound one
// leaves the account's shares too (noteShare), so every device of the
// account lets it go.
func (d *Desk) ForgetGuestConnection(id string) error {
	list, err := d.guestStore.List()
	if err != nil {
		return err
	}
	if i := slices.IndexFunc(list, func(a guest.Access) bool { return a.ID() == id }); i >= 0 && list[i].AccountBound {
		if err := d.noteShare(list[i], true); err != nil {
			return err
		}
	}
	if err := d.guestStore.Remove(id); err != nil {
		return err
	}
	d.closeGuest(id)
	return nil
}

// closeGuest ends this device's use of a grant it let go: the connection,
// when it is the open one, and its Gram.
func (d *Desk) closeGuest(id string) {
	d.finishGuests([]detached{d.detachGuest(id)})
}

// detachGuest ends grant id's connection when it is the open one, as
// Disconnect ends it without waiting for its work: the half of closeGuest
// under d.mu, which a caller holding d.storeMu may take. finishGuests ends
// the rest once d.storeMu is free.
func (d *Desk) detachGuest(id string) detached {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.link != nil && d.link.guest != nil && d.link.access.ID() == id {
		return d.endLocked()
	}
	return detached{}
}

// finishGuests ends what detachGuest took out of use (xs), and brings the
// guest Gram to the grants still saved.
func (d *Desk) finishGuests(xs []detached) {
	if len(xs) == 0 {
		return
	}
	d.syncGuestGram()
	for _, x := range xs {
		x.stop()
		x.remove()
	}
}

// guestAvailability is GuestConnection.Availability for a failed listing
// (App/GuestHomeView.swift 346-356).
func guestAvailability(err error) string {
	switch {
	case errors.Is(err, guest.ErrRevoked):
		return "lost"
	case errors.Is(err, guest.ErrHostOffline):
		return "offline"
	case errors.Is(err, guest.ErrRateLimited):
		return "reconnecting"
	}
	return ""
}

// guestStatusPoll is how often a guest lists the shared agent. Every guest
// request is its own relay connect, and the relay allows a network 30 a
// minute for this list, the chat's poll (src/chatPoll.ts) and Gram's
// (desk_gram.go) together: the list waits 15 s, and a send, an answer or a
// menu key asks again at once (pollGuestStatus).
const guestStatusPoll = 15 * time.Second

// pollGuestStatus has a guest's status poll list the agent now; nothing for
// the owner.
func (l *link) pollGuestStatus() {
	select {
	case l.guestPoll <- struct{}{}:
	default:
	}
}

func (d *Desk) runGuest(ctx context.Context, l *link, fingerprint string) {
	defer l.guest.Close()
	stop := context.AfterFunc(ctx, func() { _ = l.guest.Close() })
	defer stop()
	client := l.guestClient
	publishState := func(phase, message, availability string) {
		d.mu.Lock()
		access := *l.access
		d.mu.Unlock()
		d.setState(ctx, ConnState{Phase: phase, Machine: access.MachineLabel, Message: message, Guest: &GuestConnection{Access: access, Features: l.guest.Features(), Fingerprint: fingerprint, Availability: availability}})
	}
	publishState("connecting", "", "")
	listed := false
	for ctx.Err() == nil {
		wait := guestStatusPoll
		result, running, err := client.GuestAgentList(ctx)
		if ctx.Err() != nil {
			return
		}
		if errors.Is(err, guest.ErrRateLimited) {
			// Not an error: the transport connects again when its backoff
			// ends, and the agent's page stays open meanwhile.
			wait = max(wait, l.guest.RateLimitedUntil().Sub(d.guestClock.Now()))
			phase := "connecting"
			if listed {
				phase = "connected"
			}
			publishState(phase, fmt.Sprintf("The relay is receiving too many connections from this network. Trying again in %d s.", int((wait+time.Second-1)/time.Second)), guestAvailability(err))
		} else if err != nil {
			publishState("error", err.Error(), guestAvailability(err))
			if errors.Is(err, guest.ErrRevoked) {
				return
			}
		} else {
			listed = true
			agents := make([]herdrapi.AgentInfo, 0, 1)
			// Paused while the shared agent is missing or not running
			// (App/GuestPaneView.swift:737-753).
			availability := "paused"
			for i, agent := range result.Agents {
				if agent.TerminalID == l.access.AgentTarget || agent.PaneID == l.access.AgentTarget {
					agents = append(agents, agent)
					if running[i] {
						availability = ""
					}
					break
				}
			}
			publishState("connected", "", availability)
			d.mu.Lock()
			if ctx.Err() != nil || d.link != l {
				d.mu.Unlock()
				return
			}
			l.agents = agents
			if len(agents) > 0 {
				l.access.AgentName = herdr.DisplayName(agents[0])
			}
			d.publishLocked(BoardUpdate{Board: herdr.BuildBoard(agents, herdr.View{}), ListedAt: time.Now().Format(time.RFC3339), MachineID: l.id})
		}
		select {
		case <-ctx.Done():
			return
		case <-l.guestPoll:
		case <-d.guestClock.After(wait):
		}
	}
}

// guestRelabeled keeps the machine name a hello reply gave share id (its
// owner may have renamed the machine, herdr #519), and when: saved with the
// share, so SHARED WITH YOU names the machine as its latest hello did, and
// on the share's open link, whose connection state names it (published at
// once when connected, else by the state the link's next list publishes),
// so the open page's header and the list show it.
func (d *Desk) guestRelabeled(id, label string) {
	if err := d.guestStore.Relabel(id, label, time.Now()); err != nil {
		log.Printf("guest relabel: %s: %v", id, err)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	l := d.link
	if l == nil || l.guest == nil || l.access.ID() != id || l.ctx.Err() != nil || l.access.MachineLabel == label {
		return
	}
	l.access.MachineLabel, l.shareLabel = label, label
	if s := d.state; s.Phase == "connected" && s.Guest != nil && s.Guest.Access.ID() == id {
		g := *s.Guest
		g.Access.MachineLabel, s.Machine, s.Guest = label, label, &g
		d.state = s
		StateChanged.Broadcast(s)
	}
}

// GuestChat is what one fresh pong says about a shared agent's page: whether
// it offers Chat (the host's transcript capability) and whether the chat has
// the owner's up arrow. The arrow is the browser's owner link's alone, where
// the same pong says herdr records the browser's prompts as the owner's
// (src/web/desk.ts guestChatAvailable); a desktop guest's never has it.
type GuestChat struct {
	Available   bool `json:"available"`
	OwnerOrigin bool `json:"ownerOrigin"`
}

// GuestChatAvailable follows the authenticated host's transcript capability.
func (d *Desk) GuestChatAvailable(ctx context.Context, token string) (GuestChat, error) {
	v, err := d.agentView(token)
	if err != nil {
		return GuestChat{}, err
	}
	if !v.Guest {
		return GuestChat{}, errors.New("This is not a shared agent")
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	pong, err := v.client.Ping(ctx)
	return GuestChat{Available: err == nil && pong.Capabilities != nil && pong.Capabilities.AgentTranscript}, err
}

func (d *Desk) paneRecipient(v *interaction) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.currentLocked(v.at) || v.ctx.Err() != nil {
		return "", ErrSessionChanged
	}
	if v.at.link.guest != nil {
		if !v.at.link.guest.Features().Gram {
			return "", errors.New("The owner has not shared this agent's Gram or attachments")
		}
		for _, agent := range v.at.link.agents {
			if agent.PaneID == v.PaneID && agent.Name != nil && strings.TrimSpace(*agent.Name) != "" {
				return *agent.Name, nil
			}
		}
		return "", errors.New("The shared agent is not available for attachments")
	}
	if v.recipient == "" {
		return "", errors.New("choose a named agent to attach files")
	}
	return v.recipient, nil
}
