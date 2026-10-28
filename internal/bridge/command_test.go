package bridge

import "testing"

func TestRemoteCommand(t *testing.T) {
	const prefix = `/bin/sh -c 'HERDR=$(command -v herdr || echo "$HOME/.local/bin/herdr"); ` +
		`[ -x "$HERDR" ] || { echo __HERDR_NOT_INSTALLED__ >&2; exit 127; }; `
	for _, tc := range []struct {
		session string
		args    []string
		want    string
	}{
		{"", []string{"api-bridge", "--multi"}, prefix + `exec "$HERDR" api-bridge --multi'`},
		{"default", []string{"api-bridge", "--multi"}, prefix + `exec "$HERDR" api-bridge --multi'`},
		{"work", []string{"api-bridge", "eyJpZCI6IjEifQ=="}, prefix + `exec "$HERDR" --session work api-bridge eyJpZCI6IjEifQ=='`},
	} {
		got, err := remoteCommand(tc.session, tc.args...)
		if err != nil || got != tc.want {
			t.Errorf("remoteCommand(%q, %q) = %q, %v\nwant %q", tc.session, tc.args, got, err, tc.want)
		}
	}
	for _, bad := range [][2]string{{"a b", "--multi"}, {"", "x'y"}, {"", "$(id)"}} {
		if got, err := remoteCommand(bad[0], bad[1]); err == nil {
			t.Errorf("remoteCommand(%q, %q) = %q, want an error", bad[0], bad[1], got)
		}
	}
}
