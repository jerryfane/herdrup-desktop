package bridge

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
)

// Session is one herdr session on a machine, as `herdr session list
// --json` reports it (herdr session::SessionInfo).
type Session struct {
	Name    string `json:"name"`
	Default bool   `json:"default"`
	Running bool   `json:"running"`
}

// maxSessionListBytes bounds the output of `herdr session list --json`.
const maxSessionListBytes = 256 << 10

// defaultOnly is the session list of a herdr without named sessions.
var defaultOnly = []Session{{Name: "default", Default: true, Running: true}}

// ListSessions returns the herdr sessions on the machine: named sessions
// by name, then the default one. Names that cannot be passed back as
// --session are left out. It runs `herdr session list --json` (herdr
// 0.5.3 and later), which is machine-level, so it never carries --session
// whichever session this client addresses. When that command fails, as it
// does on an older herdr, the machine has only the default session.
//
// It fails only when the command cannot run at all: the connection is
// gone, ctx ended, or the machine has no herdr.
func (c *Client) ListSessions(ctx context.Context) ([]Session, error) {
	cmd, err := remoteCommand("", "session", "list", "--json")
	if err != nil {
		return nil, err
	}
	sess, err := c.ssh.NewSession()
	if err != nil {
		return nil, err
	}
	defer sess.Close()
	stop := context.AfterFunc(ctx, func() { sess.Close() })
	defer stop()
	stdout, err := sess.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &tailBuffer{}
	sess.Stderr = stderr
	if err := sess.Start(cmd); err != nil {
		return nil, err
	}
	out, readErr := io.ReadAll(io.LimitReader(stdout, maxSessionListBytes+1))
	waitErr := sess.Wait()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if errors.Is(classifyExit(stderr.String(), waitErr), ErrHerdrNotInstalled) {
		return nil, ErrHerdrNotInstalled
	}
	if readErr != nil || waitErr != nil || len(out) > maxSessionListBytes {
		return defaultOnly, nil
	}
	sessions, err := decodeSessions(out)
	if err != nil {
		return defaultOnly, nil
	}
	return sessions, nil
}

func decodeSessions(data []byte) ([]Session, error) {
	var env struct {
		Sessions *[]Session `json:"sessions"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, err
	}
	if env.Sessions == nil {
		return nil, fmt.Errorf("no sessions in herdr session list")
	}
	var out []Session
	for _, s := range *env.Sessions {
		if s.Default || sessionName.MatchString(s.Name) {
			out = append(out, s)
		}
	}
	slices.SortStableFunc(out, func(a, b Session) int {
		if a.Default != b.Default {
			if a.Default {
				return 1
			}
			return -1
		}
		return cmp.Compare(a.Name, b.Name)
	})
	return out, nil
}
