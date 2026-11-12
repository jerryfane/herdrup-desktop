package main

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
)

// A guest answers the shared agent's questions as the owner does: the
// chat's answer buttons (ChatAnswer, agent.answer) and, while the agent
// waits on a menu, the owner's menu keys (GuestMenuKey, pane.send_keys).
// herdrup f2df68b App/GuestPaneView.swift and App/ChatView.swift; herdr #352
// (d78b91c) src/api/server/guest_gate.rs enforces what a guest may send.

// guestForbidden is herdr's refusal of a call outside the guest's grant. For
// agent.answer on the granted agent it means a host older than guest answers
// (a current herdr always lets a guest answer its grant, guest_gate.rs 538).
const guestForbidden = "guest_forbidden"

// guestMenuKeys are the keys the guest's menu-key bar sends, in its order
// (GuestMenuKeyBar, GuestPaneView.swift:1043-1097): a subset of the keys herdr's
// guest gate takes (guest_gate.rs:472-482), and nothing that types text.
var guestMenuKeys = []string{"Escape", "Space", "Left", "Up", "Down", "Right", "Tab", "Enter"}

// guestOwner is who shared the link's agent, "" for the owner's own link.
// Called with d.mu held.
func guestOwner(l *link) string {
	if l.guest == nil || l.access == nil {
		return ""
	}
	return l.access.OwnerName
}

// guestSelf is the guest's own name on the link, "" for the owner's own link.
// Called with d.mu held.
func guestSelf(l *link) string {
	if l.guest == nil || l.access == nil {
		return ""
	}
	return l.access.GuestName
}

// GuestMenuKeyReply says whether the guest's host keeps answers for the
// owner, learnt from a refused key.
type GuestMenuKeyReply struct {
	OwnerAnswers bool `json:"ownerAnswers,omitempty"`
}

// GuestMenuKey presses one of the bar's menu keys in a guest's shared pane,
// as GuestPaneView.sendMenuKey (GuestPaneView.swift:834-852). herdr refuses a
// guest's key with guest_forbidden whenever it would not take one: not on a
// menu, on a free-text prompt, during its pause after a committing key
// (guest_gate.rs awaits_menu_input and MENU_COMMITS, d78b91c 505-529), and on a
// host older than guest answers; its guest view shows only agent_status. As
// native, a refusal reads the agent again, and one still blocked means a host
// that keeps answers for the owner. Once the host has taken one of this
// guest's keys it is not such a host (an older host takes none), so a later
// refusal, during herdr's pause while detection still lists the old menu,
// learns nothing. A free-text prompt reads as blocked, as in native.
func (d *Desk) GuestMenuKey(ctx context.Context, token, key string) (GuestMenuKeyReply, error) {
	v, err := d.agentView(token)
	if err != nil {
		return GuestMenuKeyReply{}, err
	}
	l := v.at.link
	guestLink := l.guest
	if guestLink == nil {
		return GuestMenuKeyReply{}, errors.New("This is not a shared agent")
	}
	if !slices.Contains(guestMenuKeys, key) {
		return GuestMenuKeyReply{}, fmt.Errorf("%q is not a menu key", key)
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	defer l.pollGuestStatus()
	err = guestLink.SendMenuKeys(ctx, v.PaneID, []string{key})
	var api *bridge.APIError
	if !errors.As(err, &api) || api.Code != guestForbidden {
		if err == nil {
			l.guestKeyTaken.Store(true)
		}
		return GuestMenuKeyReply{}, err
	}
	if l.guestKeyTaken.Load() {
		return GuestMenuKeyReply{}, nil
	}
	list, running, err := l.guestClient.GuestAgentList(ctx)
	if err != nil {
		return GuestMenuKeyReply{}, nil // the refusal stands; nothing learnt
	}
	for i, agent := range list.Agents {
		if agent.TerminalID == l.access.AgentTarget || agent.PaneID == l.access.AgentTarget {
			return GuestMenuKeyReply{OwnerAnswers: herdr.GroupOf(agent, running[i]) == herdr.NeedsYou}, nil
		}
	}
	return GuestMenuKeyReply{}, nil
}
