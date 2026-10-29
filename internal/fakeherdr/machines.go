package fakeherdr

import (
	"fmt"
	"io"

	"golang.org/x/crypto/ssh"
)

// Machine is one saved SSH machine, as machine.status reports it. Its
// JSON is herdr's, so cmd/fakeherdr reads a file of them.
type Machine struct {
	ProfileID    string `json:"profile_id"`
	DisplayLabel string `json:"display_label"`
	// SavedState is disabled, untrusted, coordinator_disabled or
	// coordinated.
	SavedState string `json:"saved_state"`
	// FederationConfigured is left out of the reply when nil, as a herdr
	// from before the field leaves it out.
	FederationConfigured *bool `json:"federation_configured"`
	// FederationReachability is left out of the reply when "".
	FederationReachability string `json:"federation_reachability"`
	Stale                  bool   `json:"stale"`
}

// MachineCall is one `herdr machine` command the fake ran.
type MachineCall struct {
	Session string   // "" for the default session
	Args    []string // what follows `machine`: ["federate", "<id>"]
}

// MachineCalls returns every `herdr machine` command run, in order.
func (s *Server) MachineCalls() []MachineCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]MachineCall(nil), s.machineCalls...)
}

// machineStatus answers machine.status from s.Machines; ok is false when
// the fake has no saved machines and Handle answers it.
func (s *Server) machineStatus() (result any, apiErr *APIError, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Machines == nil {
		return nil, nil, false
	}
	if s.MachineStatusError != nil {
		return nil, s.MachineStatusError, true
	}
	machines := make(map[string]any, len(s.Machines))
	for _, m := range s.Machines {
		entry := map[string]any{
			"profile_id": m.ProfileID, "display_label": m.DisplayLabel,
			"saved_state": m.SavedState, "remote_session": "", "stale": m.Stale,
		}
		if m.FederationConfigured != nil {
			entry["federation_configured"] = *m.FederationConfigured
		}
		if m.FederationReachability != "" {
			entry["federation_reachability"] = m.FederationReachability
		}
		machines[m.ProfileID] = entry
	}
	return map[string]any{"type": "machine_status", "machines": machines}, nil, true
}

// machineCommand answers `herdr machine federate|unfederate <id>` as herdr
// does (src/cli/machine_federation.rs), on s.Machines.
func (s *Server) machineCommand(ch ssh.Channel, session string, args []string) int {
	s.mu.Lock()
	if s.Machines == nil {
		s.mu.Unlock()
		fmt.Fprintln(ch.Stderr(), "unknown command: machine")
		return 2
	}
	s.machineCalls = append(s.machineCalls, MachineCall{Session: session, Args: append([]string(nil), args...)})
	stdout, stderr := s.MachineStdout, s.MachineStderr
	s.mu.Unlock()
	_, _ = io.WriteString(ch, stdout)
	if len(args) != 2 || (args[0] != "federate" && args[0] != "unfederate") {
		fmt.Fprintln(ch.Stderr(), "usage: herdr machine federate|unfederate <label-or-id>")
		return 2
	}
	if stderr != "" {
		_, _ = io.WriteString(ch.Stderr(), stderr)
		return 1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	verb, id := args[0], args[1]
	i := 0
	for i < len(s.Machines) && s.Machines[i].ProfileID != id && s.Machines[i].DisplayLabel != id {
		i++
	}
	if i == len(s.Machines) {
		if verb == "federate" {
			fmt.Fprintf(ch.Stderr(), "machine %q was not found in saved profiles or legacy SSH peers\n", id)
		} else {
			fmt.Fprintf(ch.Stderr(), "saved machine %q was not found\n", id)
		}
		return 1
	}
	m := &s.Machines[i]
	enabled := verb == "federate"
	if m.FederationConfigured != nil {
		m.FederationConfigured = &enabled
	}
	switch {
	case m.SavedState == "disabled":
	case enabled && m.SavedState == "untrusted":
		m.SavedState = "coordinated"
	case !enabled:
		m.SavedState = "untrusted"
	}
	if enabled {
		fmt.Fprintf(ch, "Federated 1 machine(s), including %s.\n", id)
	} else {
		fmt.Fprintf(ch, "Unfederated machine %s (%s); saved SSH profile remains available.\n", m.DisplayLabel, m.ProfileID)
	}
	return 0
}
