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

// herdrClient is a typed client for the herdr session the board shows.
func (d *Desk) herdrClient() (*engine.Client, error) {
	d.mu.Lock()
	var c *bridge.Client
	var session string
	if d.link != nil {
		c, session = d.link.client, d.link.session
	}
	d.mu.Unlock()
	if c == nil {
		return nil, errors.New("not connected")
	}
	view, err := c.ForSession(session)
	if err != nil {
		return nil, err
	}
	return engine.New(engine.Bridge(view)), nil
}

// MachineStatuses lists the saved SSH machines of the connected herdr
// (machine.status), sorted by display label, each with its federation
// peer on the current board.
func (d *Desk) MachineStatuses(ctx context.Context) ([]SavedMachineStatus, error) {
	c, err := d.herdrClient()
	if err != nil {
		return nil, err
	}
	statuses, err := c.MachineStatuses(ctx)
	if err != nil {
		return nil, err
	}
	return d.withPeers(statuses), nil
}

// withPeers pairs each status with its peer on the current board, matched
// as herdrup matches them: peer alias == profile id.
func (d *Desk) withPeers(statuses []engine.SavedMachineStatus) []SavedMachineStatus {
	peers := d.Peers()
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
// failed or was applied but the statuses could not be re-read.
func (d *Desk) SetMachineFederation(ctx context.Context, profileID string, enabled bool) error {
	c, err := d.herdrClient()
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
	MachineStatusChanged.Broadcast(d.withPeers(statuses))
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
