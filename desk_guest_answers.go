package main

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
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

// GuestMenuKey presses one of the bar's menu keys in a guest's shared pane,
// as GuestPaneView.sendMenuKey (GuestPaneView.swift:788-813). herdr refuses a
// guest's key with guest_forbidden whenever it would not take one: not on a
// menu, on a free-text prompt, during its pause after a committing key
// (guest_gate.rs awaits_menu_input and MENU_COMMITS, d78b91c 505-529), and on a
// host older than guest answers. Its guest view hides the prompt kind and the
// state sequence, so a guest cannot tell these apart, and a refused key says
// nothing about the host (PR #90 review): it is ignored. Whether the host
// keeps answers for the owner is read from agent.answer and the transcript's
// answerable instead (ChatAnswer, the page's withheldFromCaller).
func (d *Desk) GuestMenuKey(ctx context.Context, token, key string) error {
	v, err := d.agentView(token)
	if err != nil {
		return err
	}
	guestLink := v.at.link.guest
	if guestLink == nil {
		return errors.New("This is not a shared agent")
	}
	if !slices.Contains(guestMenuKeys, key) {
		return fmt.Errorf("%q is not a menu key", key)
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	err = guestLink.SendMenuKeys(ctx, v.PaneID, []string{key})
	var api *bridge.APIError
	if errors.As(err, &api) && api.Code == guestForbidden {
		return nil
	}
	return err
}
