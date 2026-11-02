package main

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// A guest answers the shared agent's questions as the owner does: the
// chat's answer buttons (ChatAnswer, agent.answer) and, while the agent
// waits on a menu, the owner's menu keys (GuestMenuKey, pane.send_keys).
// herdrup f2df68b App/GuestPaneView.swift and App/ChatView.swift; herdr #352
// (d78b91c) src/api/server/guest_gate.rs enforces what a guest may send.

// guestForbidden is herdr's refusal of a call outside the guest's grant; for
// agent.answer and pane.send_keys, a host older than guest answers.
const guestForbidden = "guest_forbidden"

// guestMenuKeys are the keys the guest's menu-key bar sends, in its order
// (GuestMenuKeyBar, GuestPaneView.swift:1043-1097): a subset of the keys herdr's
// guest gate takes (guest_gate.rs:472-482), and nothing that types text.
var guestMenuKeys = []string{"Escape", "Space", "Left", "Up", "Down", "Right", "Tab", "Enter"}

// GuestMenuKeyReply is a menu key's outcome the page acts on.
type GuestMenuKeyReply struct {
	// OwnerAnswers: the host refused the key while the agent still waits on
	// its menu, so it keeps answers for the owner (a host older than guest
	// answers); the page waits for the owner from then on.
	OwnerAnswers bool `json:"ownerAnswers,omitempty"`
}

// guestOwner is who shared the link's agent, "" for the owner's own link.
// Called with d.mu held.
func guestOwner(l *link) string {
	if l.guest == nil || l.access == nil {
		return ""
	}
	return l.access.OwnerName
}

// awaitingMenuInput is herdrup AgentInfo.isAwaitingMenuInput
// (Sources/HerdrKit/Wire.swift:407): the agent waits on a menu or question,
// the state in which herdr takes a guest's menu keys. A live agent in it is
// in the needs-you group (herdr.GroupOf), which is how the page sees it.
func awaitingMenuInput(a herdrapi.AgentInfo) bool {
	return a.AgentStatus == herdrapi.AgentStatusBlocked || (a.InputPending != nil && *a.InputPending)
}

// GuestMenuKey presses one of the bar's menu keys in a guest's shared pane,
// as GuestPaneView.sendMenuKey (GuestPaneView.swift:788-813). herdr refuses
// a guest's key with guest_forbidden while the agent is not on a menu, after
// a choosing key until it sees the menu change (guest_gate.rs:992-1038), and
// always on a host older than guest answers. A refusal while the agent still
// waits means the last; one after the menu closed is the race it looks like,
// and the next agent poll settles the page.
func (d *Desk) GuestMenuKey(ctx context.Context, token, key string) (GuestMenuKeyReply, error) {
	v, err := d.agentView(token)
	if err != nil {
		return GuestMenuKeyReply{}, err
	}
	guestLink := v.at.link.guest
	if guestLink == nil {
		return GuestMenuKeyReply{}, errors.New("This is not a shared agent")
	}
	if !slices.Contains(guestMenuKeys, key) {
		return GuestMenuKeyReply{}, fmt.Errorf("%q is not a menu key", key)
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	err = guestLink.SendMenuKeys(ctx, v.PaneID, []string{key})
	var api *bridge.APIError
	if err == nil || !errors.As(err, &api) || api.Code != guestForbidden {
		return GuestMenuKeyReply{}, err
	}
	list, err := v.client.AgentList(ctx, herdrapi.AgentListParams{})
	if err != nil {
		return GuestMenuKeyReply{}, err
	}
	i := slices.IndexFunc(list.Agents, func(a herdrapi.AgentInfo) bool { return a.PaneID == v.PaneID })
	return GuestMenuKeyReply{OwnerAnswers: i >= 0 && awaitingMenuInput(list.Agents[i])}, nil
}
