package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/gramstore"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// NotificationPreferences are device-local: changing hosts does not silently
// change which desktop alerts the owner has enabled.
type NotificationPreferences struct {
	NeedsInput bool `json:"needsInput"`
	Dies       bool `json:"dies"`
	Finishes   bool `json:"finishes"`
	// FinishesMineOnly narrows Finishes to the owner's own requests: "An
	// agent finishes" is Off / Only my requests / Always (turn-origin
	// contract, owner 2026-11-06), stored as herdrup's notify.finishes and
	// notify.finishesMineOnly. A file from before it has no such key, so a
	// finishes that was on reads as Always.
	FinishesMineOnly bool `json:"finishesMineOnly"`
	Gram             bool `json:"gram"`
}
type NotificationSettings struct {
	Preferences NotificationPreferences `json:"preferences"`
	Supported   bool                    `json:"supported"`
	LastError   string                  `json:"lastError"`
	// TurnOrigin is whether the connected herdr tells the owner's requests
	// apart (ping capability turn_origin); nil while no machine is connected.
	// Without it "Only my requests" alerts every finished turn.
	TurnOrigin *bool `json:"turnOrigin"`
}
type notificationSettings struct {
	mu          sync.Mutex
	loaded      bool
	preferences NotificationPreferences
	// muted are the panes whose notifications are off: herdrup's MuteStore
	// (App/PushCenter.swift:98-125), per pane id and on this device.
	muted     map[string]bool
	lastError string
}

// notificationsFile is notifications.json: the preferences, flat as they
// always were, and the muted panes.
type notificationsFile struct {
	NotificationPreferences
	MutedPanes []string `json:"mutedPanes,omitempty"`
}

func (d *Desk) loadNotificationsLocked() error {
	n := &d.notifications
	if n.loaded {
		return nil
	}
	file := notificationsFile{NotificationPreferences: NotificationPreferences{NeedsInput: true, Dies: true, Gram: true}}
	data, err := os.ReadFile(filepath.Join(d.dir, "notifications.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		if err = json.Unmarshal(data, &file); err != nil {
			return fmt.Errorf("read notification preferences: %w", err)
		}
	}
	n.muted = make(map[string]bool, len(file.MutedPanes))
	for _, pane := range file.MutedPanes {
		n.muted[pane] = true
	}
	n.preferences, n.loaded = file.NotificationPreferences, true
	return nil
}

// saveNotificationsLocked writes notifications.json. d.notifications.mu
// must be held.
func (d *Desk) saveNotificationsLocked(preferences NotificationPreferences, muted map[string]bool) error {
	file := notificationsFile{NotificationPreferences: preferences, MutedPanes: slices.Sorted(maps.Keys(muted))}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(d.dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(d.dir, "notifications.json")
	tmp := path + ".tmp"
	if err = os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
func (d *Desk) GetNotificationSettings() (NotificationSettings, error) {
	turnOrigin := d.turnOriginSupported()
	preferences, lastError, err := d.notificationPreferences()
	if err != nil {
		return NotificationSettings{}, err
	}
	return NotificationSettings{Preferences: preferences, Supported: mygo.NotificationsSupported(), LastError: lastError, TurnOrigin: turnOrigin}, nil
}

func (d *Desk) notificationPreferences() (NotificationPreferences, string, error) {
	n := &d.notifications
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := d.loadNotificationsLocked(); err != nil {
		return NotificationPreferences{}, "", err
	}
	return n.preferences, n.lastError, nil
}

// turnOriginSupported is whether the connected herdr advertises turn_origin;
// nil while no owner connection has answered a ping.
func (d *Desk) turnOriginSupported() *bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.link == nil || d.link.guest != nil || d.link.caps == nil {
		return nil
	}
	supported := d.link.caps.TurnOrigin
	return &supported
}

// SetFinishNotifications sets "An agent finishes" to off, mine (only my
// requests) or always.
func (d *Desk) SetFinishNotifications(choice string) error {
	n := &d.notifications
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := d.loadNotificationsLocked(); err != nil {
		return err
	}
	next := n.preferences
	switch choice {
	case "off":
		next.Finishes, next.FinishesMineOnly = false, false
	case "mine":
		next.Finishes, next.FinishesMineOnly = true, true
	case "always":
		next.Finishes, next.FinishesMineOnly = true, false
	default:
		return errors.New("unknown choice for An agent finishes")
	}
	if err := d.saveNotificationsLocked(next, n.muted); err != nil {
		return err
	}
	n.preferences = next
	return nil
}
func (d *Desk) SetNotificationPreference(kind string, enabled bool) error {
	n := &d.notifications
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := d.loadNotificationsLocked(); err != nil {
		return err
	}
	next := n.preferences
	switch kind {
	case "needsInput":
		next.NeedsInput = enabled
	case "dies":
		next.Dies = enabled
	case "gram":
		next.Gram = enabled
	default:
		return errors.New("unknown notification category")
	}
	if err := d.saveNotificationsLocked(next, n.muted); err != nil {
		return err
	}
	n.preferences = next
	return nil
}
func (p NotificationPreferences) enabled(kind string) bool {
	switch kind {
	case "needsInput":
		return p.NeedsInput
	case "dies":
		return p.Dies
	case "finishes":
		return p.Finishes
	case "gram":
		return p.Gram
	case "test", "appUpdate":
		// A newer app is announced once per version (desk_updates_notice.go).
		return true
	}
	return false
}
func (d *Desk) deliverNotification(kind string, options mygo.NotificationOptions) error {
	n := &d.notifications
	n.mu.Lock()
	if err := d.loadNotificationsLocked(); err != nil {
		n.mu.Unlock()
		return err
	}
	allowed := n.preferences.enabled(kind)
	n.mu.Unlock()
	if !allowed {
		return nil
	}
	var err error
	if !mygo.NotificationsSupported() {
		err = errors.New("desktop notifications are unavailable in this session")
	} else {
		err = mygo.NewNotification(options).Show()
	}
	n.mu.Lock()
	if err != nil {
		n.lastError = err.Error()
	} else {
		n.lastError = ""
	}
	n.mu.Unlock()
	return err
}
func (d *Desk) TestNotification() error {
	return d.deliverNotification("test", mygo.NotificationOptions{ID: "herdrup-notification-test", Title: "herdrup notifications", Body: "Desktop alerts can reach this session."})
}
func (d *Desk) showAgentNotification(a attention) {
	options, ok := d.agentNotification(a)
	if !ok {
		return
	}
	if err := d.deliverNotification(a.kind, options); err != nil {
		log.Printf("notification: %v", err)
	}
}

// agentNotification is the alert for a, none for a muted pane: herdrup's
// daemon skips a muted pane's pushes (MuteStore, App/PushCenter.swift:98-104).
func (d *Desk) agentNotification(a attention) (mygo.NotificationOptions, bool) {
	if d.PaneMuted(a.target.PaneID) {
		return mygo.NotificationOptions{}, false
	}
	if a.kind == "finishes" && !d.finishAlerts(a.agent) {
		return mygo.NotificationOptions{}, false
	}
	title := attentionTitle(a.agent)
	switch a.kind {
	case "dies":
		title = strings.TrimSuffix(title, " needs attention") + " stopped"
	case "finishes":
		title = strings.TrimSuffix(title, " needs attention") + " finished"
	}
	return mygo.NotificationOptions{ID: a.target.notificationID(), Title: title, Body: herdr.Preview(a.agent)}, true
}

// finishAlerts is whether a finished turn of a may alert under "An agent
// finishes": with Only my requests, a turn herdr says someone else started
// (gitmoot, a script, another agent, a guest) stays quiet. An unknown origin
// alerts (never lose a notification for missing data), so a herdr older than
// turn origins, or a federated machine's, alerts every finished turn.
func (d *Desk) finishAlerts(a herdrapi.AgentInfo) bool {
	n := &d.notifications
	n.mu.Lock()
	defer n.mu.Unlock()
	if d.loadNotificationsLocked() != nil || !n.preferences.FinishesMineOnly {
		return true
	}
	return a.LastCompletedTurn == nil || a.LastCompletedTurn.TurnOrigin == nil || *a.LastCompletedTurn.TurnOrigin != herdrapi.TurnOriginOther
}

// SetPaneMuted turns a pane's notifications off or on, on this device
// (herdrup MuteStore.setMuted, App/PushCenter.swift:118-122). It is kept
// in notifications.json with the preferences.
func (d *Desk) SetPaneMuted(paneID string, muted bool) error {
	if paneID == "" {
		return nil
	}
	n := &d.notifications
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := d.loadNotificationsLocked(); err != nil {
		return err
	}
	if n.muted[paneID] == muted {
		return nil
	}
	next := maps.Clone(n.muted)
	if muted {
		next[paneID] = true
	} else {
		delete(next, paneID)
	}
	if err := d.saveNotificationsLocked(n.preferences, next); err != nil {
		return err
	}
	n.muted = next
	return nil
}

// PaneMuted reports whether a pane's notifications are off (herdrup
// MuteStore.isMuted, App/PushCenter.swift:116). An unreadable
// notifications.json mutes nothing.
func (d *Desk) PaneMuted(paneID string) bool {
	n := &d.notifications
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := d.loadNotificationsLocked(); err != nil {
		return false
	}
	return n.muted[paneID]
}

// The unread poll can expose old messages again after newer ones are read.
// Only newly created messages advance this connection's notification cursor;
// retain IDs at the boundary because multiple messages may share a millisecond.
// g.mu is held. Native delivery runs outside that lock.
func (d *Desk) gramNotificationsLocked(messages []herdrapi.GramMessageInfo) {
	g := &d.gram
	newest := g.notificationNewest
	for _, m := range messages {
		newest = max(newest, m.CreatedUnixMs)
	}
	ids := g.notificationIDs
	if ids == nil || newest > g.notificationNewest {
		ids = map[string]bool{}
	}
	for _, m := range messages {
		fresh := m.CreatedUnixMs > g.notificationNewest || (m.CreatedUnixMs == g.notificationNewest && !g.notificationIDs[m.ID])
		if g.notificationBaseline && !g.visible && fresh && gramstore.IsUnread(m) && m.Direction == herdrapi.GramDirectionAgentToOwner {
			options := mygo.NotificationOptions{ID: "gram:" + g.machine + ":" + m.ID, Title: gramstore.SenderName(m), Body: m.Text}
			go func() {
				if err := d.deliverNotification("gram", options); err != nil {
					log.Printf("Gram notification: %v", err)
				}
			}()
		}
		if m.CreatedUnixMs == newest {
			ids[m.ID] = true
		}
	}
	g.notificationBaseline, g.notificationNewest, g.notificationIDs = true, newest, ids
}
