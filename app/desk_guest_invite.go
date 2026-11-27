package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// GuestShareDetails describes the agent selected when this view was opened.
// Routing stays in Go; the page cannot supply a different pane or machine.
type GuestShareDetails struct {
	AgentName    string `json:"agentName"`
	MachineLabel string `json:"machineLabel"`
}

type guestShareRoute struct {
	details GuestShareDetails
	target  string
	machine *string
	// own: an agent of the owner link's own machine, whose invite takes
	// the label publishLabel verifies as it is created, never details'.
	own bool
}

// errShareUnbound is why a link not bound to its stored profile
// (desk_guest_relabel.go: none, or it moved) opens no invite of its
// machine: its label may be stale, and no rename would reach the share.
var errShareUnbound = errors.New("Couldn't save this machine's settings. Reconnect to share it.")

// errShareUndurable is why no invite of the machine opens while its saved
// profile may not be durable (Desk.undurable): its label revision could be
// one a crash takes back.
var errShareUndurable = errors.New("Couldn't save this machine's settings. Try sharing again in a moment.")

// shareRoute routes an invite to agent and names its machine to the guests:
// hostLabel (inviteLabel, already a shareLabel) for this machine's agents,
// a federated peer's by herdr's machine_label for it (as a shareLabel),
// else the peer's id.
func shareRoute(agent herdrapi.AgentInfo, name, hostLabel string) guestShareRoute {
	route := guestShareRoute{details: GuestShareDetails{AgentName: name, MachineLabel: hostLabel}, target: agent.PaneID}
	if agent.MachineID != nil && *agent.MachineID != "" && strings.HasPrefix(agent.PaneID, *agent.MachineID+"/") {
		route.target = strings.TrimPrefix(agent.PaneID, *agent.MachineID+"/")
		route.machine = agent.MachineID
		route.details.AgentName = strings.TrimPrefix(name, *agent.MachineID+"/")
		route.details.MachineLabel = *agent.MachineID
		if agent.MachineLabel != nil {
			if label := shareLabel(*agent.MachineLabel); label != "" {
				route.details.MachineLabel = label
			}
		}
	}
	return route
}

// linkShareRoute is shareRoute for agent on l, by l's label for its own
// machine. d.mu must be held.
func linkShareRoute(l *link, agent herdrapi.AgentInfo, name string) guestShareRoute {
	route := shareRoute(agent, name, l.shareLabel)
	route.own = l.guest == nil && route.machine == nil
	return route
}

// shareLabelMax is herdr's bound on an invite's machine_label (guest.invite.create,
// src/guest/mod.rs create_invite): 64 Unicode characters.
const shareLabelMax = 64

// shareLabel is s as a label herdr takes for an invite and its guests can
// decode: herdr refuses control characters (Cc) and more than shareLabelMax
// characters, and the invite's readers (internal/guest validLabel, the web's
// invite.ts) refuse format characters (Cf) too. Those are dropped, the rest
// trimmed and cut after shareLabelMax runes, then trimmed again. "" when
// nothing printable is left.
func shareLabel(s string) string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s))
	if utf8.RuneCountInString(s) > shareLabelMax {
		s = strings.TrimSpace(string([]rune(s)[:shareLabelMax]))
	}
	return s
}

// inviteLabel names saved machine m to the guests of its agents' shares
// (link.shareLabel): its name (machineLabel) as herdr takes it (shareLabel),
// else its host so. Only the invite is bound: the person still sees the name
// in full wherever the desktop shows it.
func inviteLabel(m Machine) string {
	if label := shareLabel(machineLabel(m)); label != "" {
		return label
	}
	return shareLabel(m.Host)
}

func (d *Desk) GuestShareDetails(token string) (GuestShareDetails, error) {
	v, err := d.agentView(token)
	if err != nil {
		return GuestShareDetails{}, err
	}
	return v.guestShare.details, nil
}

// CreateGuestInvite follows the same session lifetime as terminal/chat writes.
// A lost response is not retried: the daemon may already have created an invite.
func (d *Desk) CreateGuestInvite(ctx context.Context, token, name, ownerName string, shareGram bool) (string, error) {
	v, err := d.agentView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	params := herdrapi.GuestInviteCreateParams{
		Target: v.guestShare.target, Machine: v.guestShare.machine,
		MachineLabel: v.guestShare.details.MachineLabel,
		Name:         strings.TrimSpace(name), OwnerName: strings.TrimSpace(ownerName), ShareGram: shareGram,
	}
	if v.guestShare.own {
		// The machine as saved now, verified and durable (publishLabel),
		// never the label the view opened with.
		shown, err := d.publishLabel(ctx, v.at.link, false)
		if err != nil {
			return "", err
		}
		params.MachineLabel = shown.label
		// A herdr without guest_relabel_rev ignores the field.
		if shown.rev > 0 {
			params.MachineLabelRev = &shown.rev
		}
	}
	created, err := v.client.GuestInviteCreate(ctx, params)
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(created)
	return string(raw), err
}
