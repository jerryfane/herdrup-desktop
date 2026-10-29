package main

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
)

// AgentTarget identifies a pane within its originating connection and session.
// Pane IDs alone can name unrelated agents on other machines or sessions.
type AgentTarget struct {
	MachineID string `json:"machineID"`
	Session   string `json:"session"`
	PaneID    string `json:"paneID"`
}

func (t AgentTarget) notificationID() string {
	return notificationPrefix + url.QueryEscape(t.MachineID) + "/" + url.QueryEscape(sessionKey(t.Session)) + "/" + url.QueryEscape(t.PaneID)
}

func notificationTarget(id string) (AgentTarget, bool) {
	encoded, ok := strings.CutPrefix(id, notificationPrefix)
	if !ok {
		return AgentTarget{}, false
	}
	parts := strings.Split(encoded, "/")
	if len(parts) != 3 {
		return AgentTarget{}, false
	}
	for i := range parts {
		var err error
		parts[i], err = url.QueryUnescape(parts[i])
		if err != nil {
			return AgentTarget{}, false
		}
	}
	t := AgentTarget{MachineID: parts[0], Session: sessionKey(parts[1]), PaneID: parts[2]}
	return t, t.MachineID != "" && t.PaneID != "" && bridge.ValidSession(t.Session)
}

// requestAgent runs even before the window exists. The event is a wake-up;
// PendingAgent retains the request until the page has rendered its destination.
func (d *Desk) requestAgent(target AgentTarget) {
	target.Session = sessionKey(target.Session)
	d.mu.Lock()
	d.pendingAgent = &target
	d.mu.Unlock()
	AgentOpen.Broadcast(target)
}

// PendingAgent returns a notification or tray activation not yet displayed.
func (d *Desk) PendingAgent() *AgentTarget {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pendingAgent == nil {
		return nil
	}
	target := *d.pendingAgent
	return &target
}

// AgentOpened acknowledges only the activation the page actually displayed.
func (d *Desk) AgentOpened(target AgentTarget) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pendingAgent != nil && *d.pendingAgent == target {
		d.pendingAgent = nil
	}
}

// ActivateAgent selects the originating machine and session. A password-only
// connection may need the connection form; the pending activation survives it.
func (d *Desk) ActivateAgent(target AgentTarget) error {
	if target.MachineID == "" || target.PaneID == "" || !bridge.ValidSession(target.Session) {
		return errors.New("invalid agent destination")
	}
	d.mu.Lock()
	l := d.link
	sameMachine := l != nil && l.id == target.MachineID
	sameSession := sameMachine && sessionKey(l.session) == sessionKey(target.Session)
	d.mu.Unlock()
	if sameSession {
		return nil
	}
	if sameMachine {
		return d.SelectSession(target.Session)
	}
	d.storeMu.Lock()
	st, err := d.load()
	d.storeMu.Unlock()
	if err != nil {
		return err
	}
	i := st.find(target.MachineID)
	if i < 0 {
		return fmt.Errorf("notification machine %q is no longer saved", target.MachineID)
	}
	m := st.Machines[i]
	m.Session = target.Session
	return d.Connect(m, "")
}
