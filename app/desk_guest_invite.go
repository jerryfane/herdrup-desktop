package main

import (
	"context"
	"encoding/json"
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
	// labelRev is details.MachineLabel's revision (Machine.LabelRev) for
	// this machine's agents: the invite carries it (machine_label_rev), so a
	// relabel older than its label never overwrites it. 0 sends none.
	labelRev uint64
}

// shareRoute routes an invite to agent and names its machine to the guests:
// hostLabel (inviteLabel, already a shareLabel) at hostRev for this
// machine's agents, a federated peer's by herdr's machine_label for it (as a
// shareLabel), else the peer's id, with no revision.
func shareRoute(agent herdrapi.AgentInfo, name, hostLabel string, hostRev uint64) guestShareRoute {
	route := guestShareRoute{details: GuestShareDetails{AgentName: name, MachineLabel: hostLabel}, target: agent.PaneID, labelRev: hostRev}
	if agent.MachineID != nil && *agent.MachineID != "" && strings.HasPrefix(agent.PaneID, *agent.MachineID+"/") {
		route.target = strings.TrimPrefix(agent.PaneID, *agent.MachineID+"/")
		route.machine = agent.MachineID
		route.labelRev = 0
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
	// A herdr without guest_relabel_rev ignores the field.
	if rev := v.guestShare.labelRev; rev > 0 {
		params.MachineLabelRev = &rev
	}
	created, err := v.client.GuestInviteCreate(ctx, params)
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(created)
	return string(raw), err
}
