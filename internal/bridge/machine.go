package bridge

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
)

// maxMachineOutputBytes bounds what `herdr machine federate|unfederate`
// writes, stdout and stderr together, as herdrup does
// (CitadelTransport.setMachineFederation).
const maxMachineOutputBytes = 64 << 10

// profileID is a saved SSH machine's id: 32 lowercase hex digits.
var profileID = regexp.MustCompile(`^[0-9a-f]{32}$`)

// ValidProfileID reports whether id is a saved-machine profile id.
func ValidProfileID(id string) bool { return profileID.MatchString(id) }

var (
	// ErrInvalidProfileID is a profile id that is not 32 lowercase hex
	// digits. Nothing is run for it.
	ErrInvalidProfileID = errors.New("invalid saved-machine profile ID")
	// ErrMachineOutputTooLarge is a machine command that wrote more than
	// 64 KiB. It is stopped.
	ErrMachineOutputTooLarge = errors.New("machine command returned too much output")
)

// MachineCommandError is a `herdr machine` command that exited non-zero.
type MachineCommandError struct {
	Command  string // "federate" or "unfederate"
	ExitCode int
	// Stderr is what herdr wrote to stderr, trimmed to its last 500 bytes.
	Stderr string
}

func (e *MachineCommandError) Error() string {
	if e.Stderr != "" {
		return e.Stderr
	}
	return fmt.Sprintf("herdr machine %s failed (exit %d)", e.Command, e.ExitCode)
}

// SetMachineFederation opts the saved SSH machine id into federation, or
// out of it, with `herdr machine federate|unfederate <id>`. herdr saves the
// policy and reloads the server of this client's session, whose
// machine.status then shows the change. It runs nothing unless id is a
// profile id. A non-zero exit is a *MachineCommandError carrying herdr's
// message.
func (c *Client) SetMachineFederation(ctx context.Context, id string, enabled bool) error {
	if !ValidProfileID(id) {
		return ErrInvalidProfileID
	}
	verb := "unfederate"
	if enabled {
		verb = "federate"
	}
	cmd, err := remoteCommand(c.cfg.Session, "machine", verb, id)
	if err != nil {
		return err
	}
	sess, err := c.newSession(ctx)
	if err != nil {
		return err
	}
	defer sess.Close()
	stop := context.AfterFunc(ctx, func() { sess.Close() })
	defer stop()
	out := &cappedOutput{limit: maxMachineOutputBytes, over: func() { sess.Close() }}
	sess.Stdout = capWriter{out, false}
	sess.Stderr = capWriter{out, true}
	runErr := sess.Run(cmd)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	stderr, exceeded := out.result()
	if exceeded {
		return ErrMachineOutputTooLarge
	}
	if strings.Contains(stderr, notInstalledMarker) {
		return ErrHerdrNotInstalled
	}
	var exit *ssh.ExitError
	if errors.As(runErr, &exit) {
		msg := strings.TrimSpace(stderr)
		if len(msg) > 500 {
			msg = msg[len(msg)-500:]
		}
		return &MachineCommandError{Command: verb, ExitCode: exit.ExitStatus(), Stderr: msg}
	}
	return runErr
}

// cappedOutput counts what a command writes to stdout and stderr together
// and keeps its stderr. Past limit it calls over, once, to stop the
// command.
type cappedOutput struct {
	limit int
	over  func()

	mu       sync.Mutex
	n        int
	stderr   []byte
	exceeded bool
}

func (o *cappedOutput) write(p []byte, stderr bool) (int, error) {
	o.mu.Lock()
	o.n += len(p)
	if o.n > o.limit {
		first := !o.exceeded
		o.exceeded = true
		o.mu.Unlock()
		if first {
			o.over()
		}
		return 0, ErrMachineOutputTooLarge
	}
	if stderr {
		o.stderr = append(o.stderr, p...)
	}
	o.mu.Unlock()
	return len(p), nil
}

func (o *cappedOutput) result() (stderr string, exceeded bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return string(o.stderr), o.exceeded
}

// capWriter is one stream of a cappedOutput.
type capWriter struct {
	o      *cappedOutput
	stderr bool
}

func (w capWriter) Write(p []byte) (int, error) { return w.o.write(p, w.stderr) }
