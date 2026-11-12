package main

import (
	"context"
	"encoding/json"
	"strings"

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
}

func shareRoute(agent herdrapi.AgentInfo, name, hostLabel string) guestShareRoute {
	route := guestShareRoute{details: GuestShareDetails{AgentName: name, MachineLabel: hostLabel}, target: agent.PaneID}
	if agent.MachineID != nil && *agent.MachineID != "" && strings.HasPrefix(agent.PaneID, *agent.MachineID+"/") {
		route.target = strings.TrimPrefix(agent.PaneID, *agent.MachineID+"/")
		route.machine = agent.MachineID
		route.details.AgentName = strings.TrimPrefix(name, *agent.MachineID+"/")
		route.details.MachineLabel = *agent.MachineID
		if agent.MachineLabel != nil && *agent.MachineLabel != "" {
			route.details.MachineLabel = *agent.MachineLabel
		}
	}
	return route
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
	created, err := v.client.GuestInviteCreate(ctx, herdrapi.GuestInviteCreateParams{
		Target: v.guestShare.target, Machine: v.guestShare.machine,
		MachineLabel: v.guestShare.details.MachineLabel,
		Name:         strings.TrimSpace(name), OwnerName: strings.TrimSpace(ownerName), ShareGram: shareGram,
	})
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(created)
	return string(raw), err
}
