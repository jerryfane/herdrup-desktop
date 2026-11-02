package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/egoist/mygo"
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
}
type GuestConnection struct {
	Access      guest.Access   `json:"access"`
	Features    guest.Features `json:"features"`
	Fingerprint string         `json:"fingerprint"`
}

var GuestInvitationOpened = mygo.NewEvent[bool]("guest-invitation:opened")

func (d *Desk) queueGuestInvitation(text string) bool {
	if !strings.HasPrefix(text, guest.AppLinkPrefix) {
		return false
	}
	d.mu.Lock()
	d.pendingGuestInvite = text
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

func (d *Desk) InspectGuestInvitation(text string) (GuestInvitation, error) {
	invite, err := guest.Parse(text, time.Now())
	if err != nil {
		return GuestInvitation{}, err
	}
	identity, err := d.guestIdentity()
	if err != nil {
		return GuestInvitation{}, err
	}
	return GuestInvitation{MachineLabel: invite.MachineLabel, OwnerName: invite.OwnerName, AgentName: invite.AgentName, GuestName: invite.GuestName, Expires: invite.Expires, Fingerprint: identity.Fingerprint()}, nil
}
func (d *Desk) SharedConnections() ([]guest.Access, error) { return d.guestStore.List() }
func (d *Desk) AcceptGuestInvitation(ctx context.Context, text string) (guest.Access, error) {
	d.guestAcceptMu.Lock()
	defer d.guestAcceptMu.Unlock()
	invite, err := guest.Parse(text, time.Now())
	if err != nil {
		return guest.Access{}, err
	}
	identity, err := d.guestIdentity()
	if err != nil {
		return guest.Access{}, err
	}
	device, err := os.Hostname()
	if err != nil || device == "" {
		device = "Desktop"
	}
	access, err := guest.Accept(ctx, invite, identity, device, time.Now())
	if err != nil {
		return guest.Access{}, err
	}
	// A successful redemption is irrevocable. Save even if the dialog's context
	// was cancelled immediately after the authenticated reply arrived.
	if err := d.guestStore.Save(access); err != nil {
		return guest.Access{}, fmt.Errorf("Access was accepted but could not be saved: %w. Keep this device's guest identity and ask the owner for a new invitation", err)
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
	transport := guest.NewTransport(*access, identity)
	ctx, cancel := context.WithCancel(context.Background())
	l := &link{id: "guest:" + id, guest: transport, guestClient: engine.New(transport), access: access, ctx: ctx}
	d.mu.Lock()
	if d.cancel != nil {
		d.cancel()
	}
	d.cancel = cancel
	d.link = l
	d.board, d.peers = nil, nil
	d.presence.show(nil, "", "")
	d.mu.Unlock()
	d.gramReset(l, access.MachineLabel)
	d.gramWipeCacheUnlessOwner(l.id)
	go func() {
		defer cancel()
		d.runGuest(ctx, l, identity.Fingerprint())
	}()
	return nil
}
func (d *Desk) ForgetGuestConnection(id string) error {
	if err := d.guestStore.Remove(id); err != nil {
		return err
	}
	d.mu.Lock()
	active := d.link != nil && d.link.guest != nil && d.link.access.ID() == id
	if active {
		if d.cancel != nil {
			d.cancel()
			d.cancel = nil
		}
		d.link = nil
		d.board, d.peers = nil, nil
		d.presence.show(nil, "", "")
	}
	d.mu.Unlock()
	if active {
		d.gramReset(nil, "")
		d.gramWipeCacheUnlessOwner("")
		d.setState(context.Background(), ConnState{Phase: "idle"})
	}
	return nil
}
func (d *Desk) runGuest(ctx context.Context, l *link, fingerprint string) {
	defer l.guest.Close()
	stop := context.AfterFunc(ctx, func() { _ = l.guest.Close() })
	defer stop()
	client := l.guestClient
	label := l.access.MachineLabel
	publishState := func(phase, message string) {
		d.mu.Lock()
		access := *l.access
		d.mu.Unlock()
		d.setState(ctx, ConnState{Phase: phase, Machine: label, Message: message, Guest: &GuestConnection{Access: access, Features: l.guest.Features(), Fingerprint: fingerprint}})
	}
	publishState("connecting", "")
	gramStarted := false
	for ctx.Err() == nil {
		result, err := client.AgentList(ctx, herdrapi.AgentListParams{})
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			publishState("error", err.Error())
			if errors.Is(err, guest.ErrRevoked) {
				return
			}
		} else {
			agents := make([]herdrapi.AgentInfo, 0, 1)
			for _, agent := range result.Agents {
				if agent.TerminalID == l.access.AgentTarget || agent.PaneID == l.access.AgentTarget {
					agents = append(agents, agent)
					break
				}
			}
			if !gramStarted && l.guest.Features().Gram {
				gramStarted = true
				go d.watchGram(ctx, l)
			}
			publishState("connected", "")
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
		case <-time.After(3 * time.Second):
		}
	}
}

// GuestChatAvailable follows the authenticated host's transcript capability.
func (d *Desk) GuestChatAvailable(ctx context.Context, token string) (bool, error) {
	v, err := d.agentView(token)
	if err != nil {
		return false, err
	}
	if !v.Guest {
		return false, errors.New("This is not a shared agent")
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	pong, err := v.client.Ping(ctx)
	return err == nil && pong.Capabilities != nil && pong.Capabilities.AgentTranscript, err
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
