package main

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/account"
)

type noSecrets struct{}

func (noSecrets) Get(string) ([]byte, error) { return nil, errors.ErrUnsupported }
func (noSecrets) Set(string, []byte) error   { return errors.ErrUnsupported }
func (noSecrets) Delete(string) error        { return errors.ErrUnsupported }

// herdrup://account# goes to the account sign-in only, beside the pairing
// and invitation links the system opens the same way; a link this app did
// not start is not redeemed and says why.
func TestAccountLinksReachOnlyTheAccountRoute(t *testing.T) {
	store := account.NewSecretsStore(noSecrets{}, errors.New("not found"))
	d := newDesk(t.TempDir())
	d.account, d.accountStore = account.New("http://127.0.0.1:1", "linux", store, nil), store
	got := make(chan AccountState, 1)
	previous := publishAccount
	publishAccount = func(s AccountState) { got <- s }
	t.Cleanup(func() { publishAccount = previous })

	link := account.LinkPrefix + "code=" + strings.Repeat("c", 43)
	if d.queueGuestInvitation(link) || d.queuePairingLink(link) {
		t.Fatal("an account link was taken as an invitation or a pairing link")
	}
	if !d.queueAccountLink(link) {
		t.Fatal("the account route refused its own link")
	}
	if d.queueAccountLink("herdrup://pair#x") {
		t.Fatal("the account route took a pairing link")
	}
	select {
	case s := <-got:
		if s.SignedIn || s.Problem == "" || s.Persistent {
			t.Fatalf("unstarted sign-in: %+v; want signed out, a problem, not persistent (no credential store)", s)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no account state published")
	}
}
