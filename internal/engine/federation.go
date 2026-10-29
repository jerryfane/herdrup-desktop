package engine

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// SavedMachineStatus is one saved SSH machine from machine.status, as
// herdrup's SavedMachineStatus (Sources/HerdrKit/Federation.swift) keeps
// it. Unlike a peer derived from the agent list, it is there before the
// machine is opted into federation.
type SavedMachineStatus struct {
	ProfileID    string `json:"profileID"`
	DisplayLabel string `json:"displayLabel"`
	// SavedState is disabled, untrusted, coordinator_disabled or
	// coordinated, or a value a newer herdr adds.
	SavedState string `json:"savedState"`
	// FederationConfigured is whether a federation policy exists for the
	// machine; nil when herdr left the field out.
	FederationConfigured   *bool   `json:"federationConfigured"`
	FederationReachability *string `json:"federationReachability"`
	Stale                  bool    `json:"stale"`
}

// HasFederationPolicy is herdrup's hasFederationPolicy: what herdr says
// in federation_configured, or, from a herdr that leaves it out, whether
// the saved state is one only a federated machine has.
func (m SavedMachineStatus) HasFederationPolicy() bool {
	if m.FederationConfigured != nil {
		return *m.FederationConfigured
	}
	return m.SavedState == string(herdrapi.SavedMachineStateCoordinated) ||
		m.SavedState == string(herdrapi.SavedMachineStateCoordinatorDisabled)
}

// MachineStatuses is machine.status as the saved machines, sorted by
// display label as herdrup's HerdrClient.machineStatuses sorts them (then
// by profile id, so equal labels keep one order).
//
// The generated CoordinatorMachineStatus reads a missing
// federation_configured as false, so the reply is decoded a second time
// to tell the two apart.
func (c *Client) MachineStatuses(ctx context.Context) ([]SavedMachineStatus, error) {
	const name = "machine.status"
	m := method(name)
	if err := c.gate(ctx, m); err != nil {
		return nil, err
	}
	var raw json.RawMessage
	if err := c.t.Call(ctx, name, herdrapi.EmptyParams{}, &raw); err != nil {
		return nil, c.mapError(name, err)
	}
	var r herdrapi.ResponseResult
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("%s: decode result: %w", name, err)
	}
	if err := checkTag(m, r); err != nil {
		return nil, err
	}
	status, ok := r.Value.(herdrapi.ResponseResultMachineStatus)
	if !ok {
		return nil, fmt.Errorf("engine: %s result decoded as %T, want %T", name, r.Value, status)
	}
	var presence struct {
		Machines map[string]struct {
			FederationConfigured *bool `json:"federation_configured"`
		} `json:"machines"`
	}
	if err := json.Unmarshal(raw, &presence); err != nil {
		return nil, fmt.Errorf("%s: decode result: %w", name, err)
	}
	out := make([]SavedMachineStatus, 0, len(status.Machines))
	for key, s := range status.Machines {
		var reach *string
		if s.FederationReachability != nil {
			reach = new(string(*s.FederationReachability))
		}
		out = append(out, SavedMachineStatus{
			ProfileID:              s.ProfileID,
			DisplayLabel:           s.DisplayLabel,
			SavedState:             string(s.SavedState),
			FederationConfigured:   presence.Machines[key].FederationConfigured,
			FederationReachability: reach,
			Stale:                  s.Stale,
		})
	}
	slices.SortFunc(out, func(a, b SavedMachineStatus) int {
		return cmp.Or(cmp.Compare(a.DisplayLabel, b.DisplayLabel), cmp.Compare(a.ProfileID, b.ProfileID))
	})
	return out, nil
}

// MachineFederator is a Transport that can opt a saved SSH machine into
// federation and out of it. bridge.Client is one.
type MachineFederator interface {
	SetMachineFederation(ctx context.Context, profileID string, enabled bool) error
}

// ErrNoMachineFederation is SetMachineFederation over a transport that
// cannot run herdr's machine commands.
var ErrNoMachineFederation = errors.New("machine federation requires an SSH connection")

// SetMachineFederation opts the saved machine profileID into federation,
// or out of it, with `herdr machine federate|unfederate` on the connected
// machine (herdrup HerdrClient.setMachineFederation). machine.status is
// the source of truth afterwards.
func (c *Client) SetMachineFederation(ctx context.Context, profileID string, enabled bool) error {
	f, ok := c.t.(MachineFederator)
	if !ok {
		return ErrNoMachineFederation
	}
	return f.SetMachineFederation(ctx, profileID, enabled)
}

// PeerReachability is a peer's reachability, the worst across its agents.
type PeerReachability string

const (
	PeerReachable PeerReachability = "reachable"
	PeerDegraded  PeerReachability = "degraded"
	PeerOffline   PeerReachability = "offline"
)

// PeerSummary is one remote machine (federation peer) as the agent list
// shows it: herdrup's PeerSummary.
type PeerSummary struct {
	// Alias is the machine_id the peer's agents carry, the `<alias>/`
	// prefix of their names. For a saved machine it is its profile id.
	Alias string `json:"alias"`
	// Label is the first non-empty machine_label of its agents; "" when
	// none has one.
	Label string `json:"label"`
	// AgentCount is how many of its agents the list has.
	AgentCount   int              `json:"agentCount"`
	Reachability PeerReachability `json:"reachability"`
}

// DisplayName is the label when there is one, else the alias.
func (p PeerSummary) DisplayName() string { return cmp.Or(p.Label, p.Alias) }

// PeerSummaries is herdrup's PeerSummary.peerSummaries: the agents that
// carry a machine_id (a local agent has none), grouped by it, sorted by
// alias. A peer is offline when any of its agents is unreachable, else
// degraded when any is degraded, else reachable; a reachability this
// build does not know reads as reachable.
func PeerSummaries(agents []herdrapi.AgentInfo) []PeerSummary {
	var peers []PeerSummary
	index := map[string]int{}
	for _, a := range agents {
		if a.MachineID == nil {
			continue
		}
		i, ok := index[*a.MachineID]
		if !ok {
			i = len(peers)
			index[*a.MachineID] = i
			peers = append(peers, PeerSummary{Alias: *a.MachineID, Reachability: PeerReachable})
		}
		p := &peers[i]
		p.AgentCount++
		if p.Label == "" && a.MachineLabel != nil {
			p.Label = *a.MachineLabel
		}
		if a.Reachability == nil {
			continue
		}
		switch *a.Reachability {
		case herdrapi.ReachabilityUnreachable:
			p.Reachability = PeerOffline
		case herdrapi.ReachabilityDegraded:
			if p.Reachability != PeerOffline {
				p.Reachability = PeerDegraded
			}
		}
	}
	slices.SortFunc(peers, func(a, b PeerSummary) int { return cmp.Compare(a.Alias, b.Alias) })
	return peers
}
