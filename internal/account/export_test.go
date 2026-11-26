package account

import (
	"testing"
	"time"
)

// FastPolls makes request reads a millisecond apart for the rest of t, for
// account_test's tests against fakeaccount (which imports this package, so
// they can't be in it).
func FastPolls(t *testing.T) {
	saved := approvalPoll
	approvalPoll = func(time.Duration) time.Duration { return time.Millisecond }
	t.Cleanup(func() { approvalPoll = saved })
}
