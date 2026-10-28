// Package bridge talks to herdr on another machine over SSH by running
// `herdr api-bridge` there, the way the herdrup iOS app does.
package bridge

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// notInstalledMarker is what the remote script writes to stderr when it
// cannot find a herdr binary.
const notInstalledMarker = "__HERDR_NOT_INSTALLED__"

// resolveHerdr finds herdr on PATH or in ~/.local/bin, the default install
// location, which a non-interactive SSH shell often leaves off PATH.
const resolveHerdr = `HERDR=$(command -v herdr || echo "$HOME/.local/bin/herdr"); ` +
	`[ -x "$HERDR" ] || { echo ` + notInstalledMarker + ` >&2; exit 127; }; `

var (
	sessionName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	// safeWord is the alphabet of every argument this package passes:
	// flags and standard base64. Anything else would need shell quoting.
	safeWord = regexp.MustCompile(`^[A-Za-z0-9._+/=-]+$`)
)

// ValidSession reports whether name can be passed as a herdr session name.
// The empty string and "default" select the default session.
func ValidSession(name string) bool {
	return name == "" || sessionName.MatchString(name)
}

// remoteCommand builds the command line for an SSH exec channel. It always
// runs through /bin/sh because the user's login shell may be fish or csh.
func remoteCommand(session string, args ...string) (string, error) {
	var b strings.Builder
	b.WriteString(`/bin/sh -c '`)
	b.WriteString(resolveHerdr)
	b.WriteString(`exec "$HERDR"`)
	if session != "" && session != "default" {
		if !sessionName.MatchString(session) {
			return "", fmt.Errorf("invalid herdr session name %q", session)
		}
		b.WriteString(" --session ")
		b.WriteString(session)
	}
	for _, a := range args {
		if !safeWord.MatchString(a) {
			return "", fmt.Errorf("unsafe remote argument %q", a)
		}
		b.WriteByte(' ')
		b.WriteString(a)
	}
	b.WriteByte('\'')
	return b.String(), nil
}

var (
	// ErrHerdrNotInstalled means the machine has no herdr binary.
	ErrHerdrNotInstalled = errors.New("herdr is not installed on this machine")
	// ErrHerdrIncompatible means the installed herdr has no api-bridge.
	ErrHerdrIncompatible = errors.New("the herdr on this machine is too old for Herdrup")
)

// classifyExit turns the stderr of a finished remote command into a known
// error where it can.
func classifyExit(stderr string, err error) error {
	switch {
	case strings.Contains(stderr, notInstalledMarker):
		return ErrHerdrNotInstalled
	case strings.Contains(stderr, "unrecognized subcommand"),
		strings.Contains(stderr, "unexpected argument"):
		return ErrHerdrIncompatible
	}
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		return err
	}
	if len(msg) > 500 {
		msg = msg[len(msg)-500:]
	}
	if err == nil {
		return errors.New(msg)
	}
	return fmt.Errorf("%w: %s", err, msg)
}
