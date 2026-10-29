package engine_test

import (
	"errors"
	"reflect"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func machineStatuses(t *testing.T, machines []fakeherdr.Machine) []engine.SavedMachineStatus {
	t.Helper()
	_, c := start(t, nil, nil, func(s *fakeherdr.Server) { s.Machines = machines })
	got, err := c.MachineStatuses(ctx(t))
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestHasFederationPolicyFallsBackToSavedStateOnlyWhenOmitted(t *testing.T) {
	got := machineStatuses(t, []fakeherdr.Machine{
		{ProfileID: "1", DisplayLabel: "a omitted coordinated", SavedState: "coordinated"},
		{ProfileID: "2", DisplayLabel: "b omitted coordinator_disabled", SavedState: "coordinator_disabled"},
		{ProfileID: "3", DisplayLabel: "c omitted untrusted", SavedState: "untrusted"},
		{ProfileID: "4", DisplayLabel: "d omitted disabled", SavedState: "disabled"},
		{ProfileID: "5", DisplayLabel: "e false coordinated", SavedState: "coordinated", FederationConfigured: new(false)},
		{ProfileID: "6", DisplayLabel: "f true untrusted", SavedState: "untrusted", FederationConfigured: new(true)},
	})
	want := []struct {
		configured *bool
		policy     bool
	}{{nil, true}, {nil, true}, {nil, false}, {nil, false}, {new(false), false}, {new(true), true}}
	if len(got) != len(want) {
		t.Fatalf("got %d machines", len(got))
	}
	for i, m := range got {
		if !reflect.DeepEqual(m.FederationConfigured, want[i].configured) || m.HasFederationPolicy() != want[i].policy {
			t.Errorf("%s: configured %v policy %v, want %v %v", m.DisplayLabel,
				m.FederationConfigured, m.HasFederationPolicy(), want[i].configured, want[i].policy)
		}
	}
}

func TestMachineStatusesSortByDisplayLabel(t *testing.T) {
	got := machineStatuses(t, []fakeherdr.Machine{
		{ProfileID: "p1", DisplayLabel: "zeta", SavedState: "untrusted"},
		{ProfileID: "p2", DisplayLabel: "beta", SavedState: "coordinated", FederationReachability: "degraded", Stale: true},
		{ProfileID: "p4", DisplayLabel: "mid", SavedState: "untrusted"},
		{ProfileID: "p3", DisplayLabel: "mid", SavedState: "untrusted"},
		{ProfileID: "p5", DisplayLabel: "Alpha", SavedState: "disabled"},
		{ProfileID: "p6", DisplayLabel: "gamma", SavedState: "untrusted"},
	})
	var order []string
	for _, m := range got {
		order = append(order, m.ProfileID)
	}
	if want := []string{"p5", "p2", "p6", "p3", "p4", "p1"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order %q, want %q", order, want)
	}
	beta := got[1]
	if beta.DisplayLabel != "beta" || beta.SavedState != "coordinated" || !beta.Stale ||
		beta.FederationReachability == nil || *beta.FederationReachability != "degraded" {
		t.Fatalf("beta %+v", beta)
	}
	if got[0].FederationReachability != nil || got[0].Stale {
		t.Fatalf("Alpha %+v", got[0])
	}
}

func TestSetMachineFederationRunsOverTheBridge(t *testing.T) {
	const id = "0123456789abcdef0123456789abcdef"
	h, c := start(t, nil, nil, func(s *fakeherdr.Server) {
		s.Machines = []fakeherdr.Machine{{ProfileID: id, DisplayLabel: "pi", SavedState: "untrusted"}}
	})
	if err := c.SetMachineFederation(ctx(t), id, true); err != nil {
		t.Fatal(err)
	}
	if got := h.srv.MachineCalls(); len(got) != 1 || !reflect.DeepEqual(got[0].Args, []string{"federate", id}) {
		t.Fatalf("ran %+v", got)
	}
	got, err := c.MachineStatuses(ctx(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].SavedState != "coordinated" || !got[0].HasFederationPolicy() {
		t.Fatalf("after federate %+v", got)
	}
}

func TestSetMachineFederationNeedsSSH(t *testing.T) {
	c := engine.New(noFederation{})
	if err := c.SetMachineFederation(ctx(t), "0123456789abcdef0123456789abcdef", true); !errors.Is(err, engine.ErrNoMachineFederation) {
		t.Fatalf("got %v", err)
	}
}

// noFederation is a Transport that cannot run machine commands.
type noFederation struct{ engine.Transport }

func agent(machine, label, reach *string) herdrapi.AgentInfo {
	a := herdrapi.AgentInfo{MachineID: machine, MachineLabel: label}
	if reach != nil {
		a.Reachability = new(herdrapi.Reachability(*reach))
	}
	return a
}

func TestPeerSummaries(t *testing.T) {
	agents := []herdrapi.AgentInfo{
		agent(nil, new("this box"), nil), // local: no machine_id
		agent(new("m3"), nil, new("a value from a newer herdr")),
		agent(new("m1"), new("pi-one"), new("unreachable")),
		agent(new("m2"), new(""), new("degraded")),
		agent(new("m1"), new("ignored"), new("degraded")),
		agent(new("m2"), new("pi-two"), nil),
		agent(new("m3"), nil, new("reachable")),
		agent(new("m2"), new("later"), new("reachable")),
		agent(new("m1"), nil, new("reachable")),
	}
	want := []engine.PeerSummary{
		{Alias: "m1", Label: "pi-one", AgentCount: 3, Reachability: engine.PeerOffline},
		{Alias: "m2", Label: "pi-two", AgentCount: 3, Reachability: engine.PeerDegraded},
		{Alias: "m3", Label: "", AgentCount: 2, Reachability: engine.PeerReachable},
	}
	got := engine.PeerSummaries(agents)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
	if got[2].DisplayName() != "m3" || got[0].DisplayName() != "pi-one" {
		t.Fatalf("display names %q %q", got[0].DisplayName(), got[2].DisplayName())
	}
	if got := engine.PeerSummaries(agents[:1]); len(got) != 0 {
		t.Fatalf("local agents only: %+v", got)
	}
}
