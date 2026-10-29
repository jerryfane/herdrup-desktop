package bridge_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

const profile = "0123456789abcdef0123456789abcdef"

func withMachine(s *fakeherdr.Server) {
	s.Machines = []fakeherdr.Machine{{ProfileID: profile, DisplayLabel: "pi", SavedState: "untrusted"}}
}

func TestSetMachineFederationRunsFederateAndUnfederate(t *testing.T) {
	m := startMachine(t, withMachine)
	c := m.dial(t)
	if err := c.SetMachineFederation(context.Background(), profile, true); err != nil {
		t.Fatal(err)
	}
	// A named session reloads that session's server: herdr strips the
	// global --session before the subcommand runs.
	work, err := c.ForSession("work")
	if err != nil {
		t.Fatal(err)
	}
	if err := work.SetMachineFederation(context.Background(), profile, false); err != nil {
		t.Fatal(err)
	}
	want := []fakeherdr.MachineCall{
		{Session: "", Args: []string{"federate", profile}},
		{Session: "work", Args: []string{"unfederate", profile}},
	}
	if got := m.srv.MachineCalls(); !reflect.DeepEqual(got, want) {
		t.Fatalf("ran %+v, want %+v", got, want)
	}
	cmds := m.srv.Commands()
	if len(cmds) != 2 ||
		!strings.HasSuffix(cmds[0], `exec "$HERDR" machine federate `+profile+`'`) ||
		!strings.HasSuffix(cmds[1], `exec "$HERDR" --session work machine unfederate `+profile+`'`) {
		t.Fatalf("commands %q", cmds)
	}
}

func TestSetMachineFederationRefusesBadIDsWithoutRunning(t *testing.T) {
	m := startMachine(t, withMachine)
	c := m.dial(t)
	for _, id := range []string{
		"",
		profile[:31],
		profile + "0",
		strings.ToUpper(profile),
		"0123456789abcdef0123456789abcdeg",
		"0123456789abcdef 123456789abcdef",
		"pi",
	} {
		if err := c.SetMachineFederation(context.Background(), id, true); !errors.Is(err, bridge.ErrInvalidProfileID) {
			t.Errorf("%q: got %v, want ErrInvalidProfileID", id, err)
		}
	}
	if cmds := m.srv.Commands(); len(cmds) != 0 {
		t.Fatalf("ran %q", cmds)
	}
}

func TestSetMachineFederationFailureCarriesHerdrMessage(t *testing.T) {
	t.Run("herdr's stderr", func(t *testing.T) {
		m := startMachine(t, withMachine)
		err := m.dial(t).SetMachineFederation(context.Background(), "fedcba9876543210fedcba9876543210", true)
		var failed *bridge.MachineCommandError
		if !errors.As(err, &failed) {
			t.Fatalf("got %v, want MachineCommandError", err)
		}
		const msg = `machine "fedcba9876543210fedcba9876543210" was not found in saved profiles or legacy SSH peers`
		if failed.ExitCode != 1 || failed.Command != "federate" || err.Error() != msg {
			t.Fatalf("got %+v (%q)", failed, err)
		}
	})
	t.Run("silent exit", func(t *testing.T) {
		m := startMachine(t, func(s *fakeherdr.Server) {
			withMachine(s)
			s.MachineStderr = "\n"
		})
		err := m.dial(t).SetMachineFederation(context.Background(), profile, false)
		if err == nil || err.Error() != "herdr machine unfederate failed (exit 1)" {
			t.Fatalf("got %v", err)
		}
	})
}

func TestSetMachineFederationCapsOutputAt64KiB(t *testing.T) {
	for name, tc := range map[string]struct {
		stdout, stderr string
		tooLarge       bool
	}{
		"stdout under the cap":  {stdout: strings.Repeat("x", 60<<10)},
		"stdout over the cap":   {stdout: strings.Repeat("x", 64<<10+1), tooLarge: true},
		"stdout+stderr over it": {stdout: strings.Repeat("x", 40<<10), stderr: strings.Repeat("e", 30<<10), tooLarge: true},
	} {
		t.Run(name, func(t *testing.T) {
			m := startMachine(t, func(s *fakeherdr.Server) {
				withMachine(s)
				s.MachineStdout, s.MachineStderr = tc.stdout, tc.stderr
			})
			err := m.dial(t).SetMachineFederation(context.Background(), profile, true)
			if got := errors.Is(err, bridge.ErrMachineOutputTooLarge); got != tc.tooLarge {
				t.Fatalf("got %v, want too large %v", err, tc.tooLarge)
			}
			if !tc.tooLarge && err != nil {
				t.Fatal(err)
			}
		})
	}
}
