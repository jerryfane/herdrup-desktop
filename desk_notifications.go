package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
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
	Gram       bool `json:"gram"`
}
type NotificationSettings struct {
	Preferences NotificationPreferences `json:"preferences"`
	Supported   bool                    `json:"supported"`
	LastError   string                  `json:"lastError"`
}
type notificationSettings struct {
	mu          sync.Mutex
	loaded      bool
	preferences NotificationPreferences
	lastError   string
}

func (d *Desk) loadNotificationsLocked() error {
	n := &d.notifications
	if n.loaded {
		return nil
	}
	preferences := NotificationPreferences{NeedsInput: true, Dies: true, Gram: true}
	data, err := os.ReadFile(filepath.Join(d.dir, "notifications.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		if err = json.Unmarshal(data, &preferences); err != nil {
			return fmt.Errorf("read notification preferences: %w", err)
		}
	}
	n.preferences, n.loaded = preferences, true
	return nil
}
func (d *Desk) GetNotificationSettings() (NotificationSettings, error) {
	n := &d.notifications
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := d.loadNotificationsLocked(); err != nil {
		return NotificationSettings{}, err
	}
	return NotificationSettings{Preferences: n.preferences, Supported: mygo.NotificationsSupported(), LastError: n.lastError}, nil
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
	case "finishes":
		next.Finishes = enabled
	case "gram":
		next.Gram = enabled
	default:
		return errors.New("unknown notification category")
	}
	data, err := json.MarshalIndent(next, "", "  ")
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
	case "test":
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
	return d.deliverNotification("test", mygo.NotificationOptions{ID: "herdrup-notification-test", Title: "Herdrup notifications", Body: "Desktop alerts can reach this session."})
}
func (d *Desk) showAgentNotification(a attention) {
	title := attentionTitle(a.agent)
	switch a.kind {
	case "dies":
		title = strings.TrimSuffix(title, " needs attention") + " stopped"
	case "finishes":
		title = strings.TrimSuffix(title, " needs attention") + " finished"
	}
	if err := d.deliverNotification(a.kind, mygo.NotificationOptions{ID: a.target.notificationID(), Title: title, Body: herdr.Preview(a.agent)}); err != nil {
		log.Printf("notification: %v", err)
	}
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
