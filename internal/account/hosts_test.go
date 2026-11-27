package account

import (
	"encoding/json"
	"maps"
	"regexp"
	"slices"
	"strings"
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

// Check holds a machine to the service's SCHEMAS.hosts: lengths in code
// points, no control character, no white space in the host.
func TestHostBodyCheckIsTheServicesHostsSchema(t *testing.T) {
	ok := HostBody{Nickname: strings.Repeat("ñ", 64), Host: strings.Repeat("é", 253), Username: strings.Repeat("ü", 64),
		Label: strings.Repeat("ß", 64), Port: 65535, AuthKind: "password"}
	if err := ok.Check(); err != nil {
		t.Fatalf("limits in code points: %v", err)
	}
	if err := (HostBody{Host: "pi", Username: "root"}).Check(); err != nil {
		t.Fatalf("the least machine: %v", err)
	}
	for name, change := range map[string]func(b *HostBody){
		"control in nickname": func(b *HostBody) { b.Nickname = "pi\x7f" },
		"C1 in label":         func(b *HostBody) { b.Label = "a\u0085b" },
		"space in host":       func(b *HostBody) { b.Host = "pi local" },
		"nbsp in host":        func(b *HostBody) { b.Host = "pi\u00a0local" },
		"bom in host":         func(b *HostBody) { b.Host = "\ufeffpi" },
		"empty username":      func(b *HostBody) { b.Username = "" },
		"empty host":          func(b *HostBody) { b.Host = "" },
		"long host":           func(b *HostBody) { b.Host = strings.Repeat("h", 254) },
		"long username":       func(b *HostBody) { b.Username = strings.Repeat("u", 65) },
		"long nickname":       func(b *HostBody) { b.Nickname = strings.Repeat("n", 65) },
		"bad UTF-8":           func(b *HostBody) { b.Username = "ro\xffot" },
		"port":                func(b *HostBody) { b.Port = 65536 },
		"auth kind":           func(b *HostBody) { b.AuthKind = "agent" },
	} {
		b := ok
		change(&b)
		if b.Check() == nil {
			t.Errorf("%s: taken", name)
		}
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
	plan, err := PlanHosts(local, mirror, nil)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Adopt[0] != idA || len(plan.Adopt) != 1 {
		t.Fatalf("adopt %v", plan.Adopt)
	}
	if len(plan.Push) != 1 || !uuidV4.MatchString(plan.Push[1]) {
		t.Fatalf("push %v; want one new lowercase v4 for the second machine", plan.Push)
	}
	if len(plan.Delete) != 0 || len(plan.Gone) != 0 {
		t.Fatalf("delete %v gone %v", plan.Delete, plan.Gone)
	}
}

// A machine another device pushed first: the account's id wins over this
// device's own, and nothing is pushed for the old one.
func TestTheAccountsIDWinsOverADifferentLocalOne(t *testing.T) {
	plan, _ := PlanHosts([]LocalHost{{SyncID: idC, Body: HostBody{Username: "root", Host: "pi"}}},
		[]RemoteHost{{ID: idA, Rev: 1, Body: HostBody{Username: "root", Host: "pi"}}}, map[string]bool{idC: false})
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
	}, nil)
	if !slices.Equal(plan.Delete, []string{idB}) || plan.Adopt[0] != idA {
		t.Fatalf("%+v", plan)
	}
}

// A machine deleted on another device leaves this one; a mirror built from
// pulls applies tombstones and full pulls replace it.
func TestDeletedElsewhereIsGoneAndTheMirrorFollowsPulls(t *testing.T) {
	m, _ := Mirror{}.Apply(Pull{Rev: 2, Full: true, Items: []Item{hostItem(1, "a", false), hostItem(2, "b", false)}})
	m, gone := m.Apply(Pull{Rev: 3, Items: []Item{hostItem(1, "", true)}})
	if !maps.Equal(gone.Hosts, map[string]int64{hostItem(1, "", true).ID: 1}) || len(gone.Prompts) != 0 {
		t.Fatalf("tombstones %+v", gone)
	}
	if m.Rev != 3 || len(m.Hosts) != 1 || m.Hosts[0].Body.Host != "b" {
		t.Fatalf("mirror %+v", m)
	}
	id := hostItem(1, "a", false).ID
	plan, _ := PlanHosts([]LocalHost{{SyncID: id, Body: HostBody{Username: "root", Host: "a"}}}, m.Hosts, map[string]bool{id: true})
	if !slices.Equal(plan.Gone, []int{0}) || len(plan.Push) != 0 {
		t.Fatalf("%+v", plan)
	}
	full, _ := m.Apply(Pull{Rev: 7, Full: true, Items: []Item{hostItem(5, "e", false)}})
	if len(full.Hosts) != 1 || full.Hosts[0].Body.Host != "e" {
		t.Fatalf("a full pull replaces the mirror: %+v", full)
	}
}

// #257 review: a rename keeps the machine (matched by id, not identity); an
// id the account never acknowledged (a push that failed) is pushed again,
// never read as deleted elsewhere.
func TestRenamesKeepTheMachineAndUnacknowledgedIDsArePushedAgain(t *testing.T) {
	mirror := []RemoteHost{{ID: idA, Rev: 3, Body: HostBody{Username: "root", Host: "old-name"}}}
	plan, _ := PlanHosts([]LocalHost{{SyncID: idA, Body: HostBody{Username: "root", Host: "new-name"}}}, mirror, map[string]bool{idA: true})
	if len(plan.Gone) != 0 || len(plan.Push) != 0 || len(plan.Adopt) != 0 {
		t.Fatalf("a renamed machine: %+v; want it kept as idA", plan)
	}
	plan, _ = PlanHosts([]LocalHost{{SyncID: idC, Body: HostBody{Username: "root", Host: "x"}}}, nil, map[string]bool{})
	if len(plan.Gone) != 0 || plan.Push[0] != idC {
		t.Fatalf("an unacknowledged id: %+v; want it pushed again under idC", plan)
	}
	plan, _ = PlanHosts([]LocalHost{{SyncID: idC, Body: HostBody{Username: "root", Host: "x"}}}, nil, map[string]bool{idC: true})
	if !slices.Equal(plan.Gone, []int{0}) {
		t.Fatalf("an id the account deleted: %+v; want gone", plan)
	}
}

// A pull's pages are read one at a time, so an item can show live on one
// page and deleted, at a newer revision, on a later one: the pull is applied
// in revision order, hosts and prompts alike, and an item older than the one
// held changes nothing.
func TestAPullAppliesItsItemsInRevisionOrder(t *testing.T) {
	host := func(rev int64, h string) Item {
		it := Item{Collection: "hosts", ID: idA, Rev: rev, Deleted: h == ""}
		if h != "" {
			it.Body, _ = json.Marshal(HostBody{Host: h, Username: "root"})
		}
		return it
	}
	prompt := func(rev int64, text string) Item {
		it := Item{Collection: "prompts", ID: idB, Rev: rev, Deleted: text == ""}
		if text != "" {
			it.Body, _ = json.Marshal(PromptBody{Text: text})
		}
		return it
	}
	pages := []Item{host(1, "a"), prompt(2, "p"), host(3, ""), prompt(4, "")}
	listed := slices.Clone(pages)
	slices.Reverse(listed)
	for _, items := range [][]Item{pages, listed} {
		for _, full := range []bool{true, false} {
			if m, gone := (Mirror{}).Apply(Pull{Rev: 4, Full: full, Items: items}); len(m.Hosts) != 0 || len(m.Prompts) != 0 ||
				!maps.Equal(gone.Hosts, map[string]int64{idA: 3}) || !maps.Equal(gone.Prompts, map[string]int64{idB: 4}) {
				t.Fatalf("full %v, items %+v: %+v; want both deletes to stand", full, items, m)
			}
		}
	}
	held := Mirror{Rev: 9, Hosts: []RemoteHost{{ID: idA, Rev: 9, Body: HostBody{Host: "new", Username: "root"}}},
		Prompts: []RemotePrompt{{ID: idB, Rev: 9, Body: PromptBody{Text: "new"}}}}
	m, gone := held.Apply(Pull{Rev: 9, Items: []Item{host(5, ""), prompt(6, "old")}})
	if len(m.Hosts) != 1 || m.Hosts[0].Body.Host != "new" || len(m.Prompts) != 1 || m.Prompts[0].Body.Text != "new" {
		t.Fatalf("older items over newer ones: %+v; want the held ones", m)
	}
	// A tombstone older than the held item still says the account held it.
	if !maps.Equal(gone.Hosts, map[string]int64{idA: 5}) || len(gone.Prompts) != 0 {
		t.Fatalf("tombstones %+v; want the skipped host's", gone)
	}
}

// A machine whose id the account held and doesn't now goes when unchanged
// here, and is pushed again under its id when edited here since.
func TestAnEditedMachineTheAccountLostIsPushedAgain(t *testing.T) {
	local := []LocalHost{
		{SyncID: idA, Body: HostBody{Username: "root", Host: "a"}},
		{SyncID: idB, Body: HostBody{Username: "root", Host: "b"}, Edited: true},
	}
	plan, _ := PlanHosts(local, nil, map[string]bool{idA: true, idB: true})
	if !slices.Equal(plan.Gone, []int{0}) || len(plan.Push) != 1 || plan.Push[1] != idB {
		t.Fatalf("%+v; want the unchanged one gone and the edited one pushed as %s", plan, idB)
	}
}

// The service's copies of turned-down changes replace the mirror's, all
// in one go (none: the item goes; a tombstone: the item goes; a live row:
// it replaces the copy held), and a collection no conflict names is left
// as it is.
func TestAdoptTakesTheServicesCopiesAndLeavesOtherCollectionsAlone(t *testing.T) {
	m := Mirror{
		Hosts:   []RemoteHost{{ID: idA, Rev: 1, Body: HostBody{Host: "a", Username: "root"}}},
		Prompts: []RemotePrompt{{ID: idA, Rev: 1, Body: PromptBody{Text: "old"}}, {ID: idB, Rev: 1, Body: PromptBody{Text: "gone"}}},
	}
	live := Item{Collection: "prompts", ID: idA, Rev: 5, Body: json.RawMessage(`{"text":"new"}`)}
	tomb := Item{Collection: "prompts", ID: idB, Rev: 6, Deleted: true}
	got := m.Adopt([]Conflict{
		{Collection: "prompts", ID: idA, Server: &live},
		{Collection: "prompts", ID: idB, Server: &tomb},
		{Collection: "prompts", ID: idC, Server: nil},
	})
	if len(got.Prompts) != 1 || got.Prompts[0].ID != idA || got.Prompts[0].Rev != 5 || got.Prompts[0].Body.Text != "new" {
		t.Fatalf("prompts %+v; want only the service's copy of %s", got.Prompts, idA)
	}
	if len(got.Hosts) != 1 || &got.Hosts[0] != &m.Hosts[0] {
		t.Fatalf("hosts %+v; want the mirror's own, untouched", got.Hosts)
	}
}
