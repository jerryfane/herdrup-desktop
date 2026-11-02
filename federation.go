package main

import (
	"context"
	"errors"
	"slices"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
)

// SavedMachineStatus is one saved SSH machine of the connected herdr, for
// the Machines settings: herdrup's SavedMachineStatus with what its
// Federation section derives from it.
type SavedMachineStatus struct {
	engine.SavedMachineStatus
	// HasFederationPolicy is whether the machine is opted into federation:
	// federationConfigured, or from a herdr without that field, a saved
	// state only a federated machine has.
	HasFederationPolicy bool `json:"hasFederationPolicy"`
	// Peer is the federation peer whose alias is ProfileID among the
	// current board's agents, for the " · N agents" suffix and the
	// reachability badge; nil when the board lists none of its agents.
	Peer *engine.PeerSummary `json:"peer"`
}

// FederationChangeError is a SetMachineFederation that did not end with
// fresh statuses.
type FederationChangeError struct {
	// Applied is true when herdr made the change but machine.status could
	// not be read after it, false when the change itself failed.
	Applied bool
	Err     error
}

func (e *FederationChangeError) Error() string {
	if e.Applied {
		return "Change applied, but status could not refresh: " + e.Err.Error()
	}
	return "Change failed: " + e.Err.Error()
}

func (e *FederationChangeError) Unwrap() error { return e.Err }

// ErrSessionChanged is a machine status read whose herdr session or
// connection was replaced before it finished; its statuses are dropped.
var ErrSessionChanged = errors.New("the herdr session changed while machine status was read")

// boardSession identifies the connection and herdr session a request was
// sent to.
type boardSession struct {
	link   *link
	client *bridge.Client
	gen    uint64
}

// currentLocked reports whether at is still the board's connection and
// session. d.mu must be held.
func (d *Desk) currentLocked(at boardSession) bool {
	return at.link != nil && d.link == at.link && d.link.client == at.client && d.link.sessionGen == at.gen
}

// engineLocked snapshots either supported transport. d.mu must be held.
func (l *link) engineLocked() (*engine.Client, error) {
	if l.guest != nil {
		return l.guestClient, nil
	}
	if l.client == nil {
		return nil, errors.New("not connected")
	}
	view, err := l.client.ForSession(l.session)
	if err != nil {
		return nil, err
	}
	return engine.New(engine.Bridge(view)), nil
}

// herdrClient is a typed client for the herdr session the board shows,
// and that session.
func (d *Desk) herdrClient() (*engine.Client, boardSession, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.link == nil {
		return nil, boardSession{}, errors.New("not connected")
	}
	at := boardSession{link: d.link, client: d.link.client, gen: d.link.sessionGen}
	client, err := d.link.engineLocked()
	return client, at, err
}

// MachineStatuses lists the saved SSH machines of the connected herdr
// (machine.status), sorted by display label, each with its federation
// peer on the current board. It is ErrSessionChanged when the session
// switched during the read.
func (d *Desk) MachineStatuses(ctx context.Context) ([]SavedMachineStatus, error) {
	c, at, err := d.herdrClient()
	if err != nil {
		return nil, err
	}
	statuses, err := c.MachineStatuses(ctx)
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.currentLocked(at) {
		return nil, ErrSessionChanged
	}
	return d.withPeersLocked(statuses), nil
}

// withPeersLocked pairs each status with its peer on the current board,
// matched as herdrup matches them: peer alias == profile id. d.mu must be
// held.
func (d *Desk) withPeersLocked(statuses []engine.SavedMachineStatus) []SavedMachineStatus {
	peers := append([]engine.PeerSummary{}, d.peers...)
	out := make([]SavedMachineStatus, len(statuses))
	for i, s := range statuses {
		out[i] = SavedMachineStatus{SavedMachineStatus: s, HasFederationPolicy: s.HasFederationPolicy()}
		if j := slices.IndexFunc(peers, func(p engine.PeerSummary) bool { return p.Alias == s.ProfileID }); j >= 0 {
			out[i].Peer = &peers[j]
		}
	}
	return out
}

// SetMachineFederation opts the saved machine profileID into federation,
// or out of it, with `herdr machine federate|unfederate`, then re-reads
// the statuses and sends them as MachineStatusChanged (herdrup
// changeFederation). A *FederationChangeError says whether the change
// failed or was applied but the statuses could not be re-read; when the
// session switched meanwhile it is applied with ErrSessionChanged, and
// nothing is sent.
func (d *Desk) SetMachineFederation(ctx context.Context, profileID string, enabled bool) error {
	c, at, err := d.herdrClient()
	if err != nil {
		return &FederationChangeError{Err: err}
	}
	if err := c.SetMachineFederation(ctx, profileID, enabled); err != nil {
		return &FederationChangeError{Err: err}
	}
	statuses, err := c.MachineStatuses(ctx)
	if err != nil {
		return &FederationChangeError{Applied: true, Err: err}
	}
	// Under d.mu, like every board publish, so a session switch cannot
	// come between the check and the send.
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.currentLocked(at) {
		return &FederationChangeError{Applied: true, Err: ErrSessionChanged}
	}
	MachineStatusChanged.Broadcast(d.withPeersLocked(statuses))
	return nil
}

// Peers lists the federation peers among the current board's agents,
// sorted by alias; none before the first list. Saved machines match them
// by profile id; the rest are peers with no saved machine.
func (d *Desk) Peers() []engine.PeerSummary {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]engine.PeerSummary{}, d.peers...)
}
