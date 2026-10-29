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

// sessionList is `herdr session list --json` with every SessionInfo field.
const sessionList = `{"sessions":[
 {"name":"default","default":true,"running":true,"socket_path":"/run/herdr.sock","session_dir":"/s/default"},
 {"name":"work","default":false,"running":true,"socket_path":"/run/work.sock","session_dir":"/s/work"},
 {"name":"has space","default":false,"running":true,"socket_path":"/x","session_dir":"/x"},
 {"name":"alpha","default":false,"running":false,"connection_error":"refused","socket_path":"/x","session_dir":"/x"}
]}`

var defaultOnly = []bridge.Session{{Name: "default", Default: true, Running: true}}

func TestListSessionsParsesNamedSessionsThenDefault(t *testing.T) {
	m := startMachine(t, func(s *fakeherdr.Server) { s.SessionList = sessionList })
	c := m.dial(t)
	// A view of a named session still lists the machine's sessions: the
	// command is machine-level and carries no --session.
	work, err := c.ForSession("work")
	if err != nil {
		t.Fatal(err)
	}
	got, err := work.ListSessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []bridge.Session{
		{Name: "alpha", Running: false},
		{Name: "work", Running: true},
		{Name: "default", Default: true, Running: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	cmds := m.srv.Commands()
	if len(cmds) != 1 || !strings.Contains(cmds[0], `exec "$HERDR" session list --json'`) {
		t.Fatalf("ran %q", cmds)
	}
}

func TestListSessionsOnOlderHerdrIsDefaultOnly(t *testing.T) {
	for name, list := range map[string]string{
		"no session subcommand": "",
		"unreadable output":     "Sessions: default",
	} {
		t.Run(name, func(t *testing.T) {
			c := startMachine(t, func(s *fakeherdr.Server) { s.SessionList = list }).dial(t)
			got, err := c.ListSessions(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, defaultOnly) {
				t.Fatalf("got %+v, want the default session only", got)
			}
		})
	}
}

func TestListSessionsWithoutHerdrFails(t *testing.T) {
	c := startMachine(t, func(s *fakeherdr.Server) { s.NotInstalled = true }).dial(t)
	if _, err := c.ListSessions(context.Background()); !errors.Is(err, bridge.ErrHerdrNotInstalled) {
		t.Fatalf("got %v, want ErrHerdrNotInstalled", err)
	}
}
