package account

import (
	"regexp"
	"slices"
	"testing"
)

// The host identity rule (design #698 §5.5, herdr-app 523157), which iOS
// applies too: username as typed, host lowercased without a trailing dot,
// port 22 when none.
func TestHostIdentity(t *testing.T) {
	a := IdentityOf(HostBody{Username: "root", Host: "Pi.Local.", Nickname: "pi"})
	b := IdentityOf(HostBody{Username: "root", Host: "pi.local", Port: 22, Label: "x", AuthKind: "key"})
	if a != b {
		t.Fatalf("%+v != %+v", a, b)
	}
	if IdentityOf(HostBody{Username: "Root", Host: "pi.local"}) == a {
		t.Fatal("the username is compared as typed")
	}
	if IdentityOf(HostBody{Username: "root", Host: "pi.local", Port: 2222}) == a {
		t.Fatal("another port is another machine")
	}
}

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

const (
	idA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	idB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	idC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
)

// First sign-in on a device that already has machines: pull first, adopt
// the account's id for the same machine, push only what the account lacks,
// and offer the account's other machines to pair.
func TestFirstSignInAdoptsTheAccountsIDsBeforePushing(t *testing.T) {
	local := []LocalHost{
		{Body: HostBody{Username: "root", Host: "PI.local"}},       // the account has it as idA
		{Body: HostBody{Username: "jerry", Host: "mac", Port: 22}}, // new to the account
	}
	mirror := []RemoteHost{
		{ID: idA, Rev: 3, Body: HostBody{Username: "root", Host: "pi.local."}},
		{ID: idB, Rev: 4, Body: HostBody{Username: "root", Host: "studio"}},
	}
	plan, err := PlanHosts(local, mirror)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Adopt[0] != idA || len(plan.Adopt) != 1 {
		t.Fatalf("adopt %v", plan.Adopt)
	}
	if len(plan.Push) != 1 || !uuidV4.MatchString(plan.Push[1]) {
		t.Fatalf("push %v; want one new lowercase v4 for the second machine", plan.Push)
	}
	if len(plan.New) != 1 || plan.New[0].ID != idB || len(plan.Delete) != 0 || len(plan.Gone) != 0 {
		t.Fatalf("new %v delete %v gone %v", plan.New, plan.Delete, plan.Gone)
	}
}

// A machine another device pushed first: the account's id wins over this
// device's own, and nothing is pushed for the old one.
func TestTheAccountsIDWinsOverADifferentLocalOne(t *testing.T) {
	plan, _ := PlanHosts([]LocalHost{{SyncID: idC, Body: HostBody{Username: "root", Host: "pi"}}},
		[]RemoteHost{{ID: idA, Rev: 1, Body: HostBody{Username: "root", Host: "pi"}}})
	if plan.Adopt[0] != idA || len(plan.Push) != 0 || len(plan.Gone) != 0 {
		t.Fatalf("%+v", plan)
	}
}

// An earlier fork (two items, one machine): the lower rev is kept, the other
// tombstoned, and the local machine points at the kept one.
func TestAForkKeepsTheLowerRev(t *testing.T) {
	plan, _ := PlanHosts([]LocalHost{{SyncID: idB, Body: HostBody{Username: "root", Host: "pi"}}}, []RemoteHost{
		{ID: idB, Rev: 9, Body: HostBody{Username: "root", Host: "PI"}},
		{ID: idA, Rev: 2, Body: HostBody{Username: "root", Host: "pi", Port: 22}},
	})
	if !slices.Equal(plan.Delete, []string{idB}) || plan.Adopt[0] != idA || len(plan.New) != 0 {
		t.Fatalf("%+v", plan)
	}
}

// A machine deleted on another device leaves this one; a mirror built from
// pulls applies tombstones and full pulls replace it.
func TestDeletedElsewhereIsGoneAndTheMirrorFollowsPulls(t *testing.T) {
	m := Mirror{}.Apply(Pull{Rev: 2, Full: true, Items: []Item{hostItem(1, "a", false), hostItem(2, "b", false)}})
	m = m.Apply(Pull{Rev: 3, Items: []Item{hostItem(1, "", true)}})
	if m.Rev != 3 || len(m.Hosts) != 1 || m.Hosts[0].Body.Host != "b" {
		t.Fatalf("mirror %+v", m)
	}
	plan, _ := PlanHosts([]LocalHost{{SyncID: hostItem(1, "a", false).ID, Body: HostBody{Username: "root", Host: "a"}}}, m.Hosts)
	if !slices.Equal(plan.Gone, []int{0}) || len(plan.Push) != 0 {
		t.Fatalf("%+v", plan)
	}
	full := m.Apply(Pull{Rev: 7, Full: true, Items: []Item{hostItem(5, "e", false)}})
	if len(full.Hosts) != 1 || full.Hosts[0].Body.Host != "e" {
		t.Fatalf("a full pull replaces the mirror: %+v", full)
	}
}
