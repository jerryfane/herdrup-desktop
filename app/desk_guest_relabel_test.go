package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/guest"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// relabelHerdr is a desk connected to the guest fixture as nickname, its
// herdr reporting guest_relabel when relabel is set. updates are the
// guest.update params sent, in order, and done counts those herdr has
// answered; while failing is set herdr refuses them. A gate in held (hold)
// holds the next guest.update until it carries that reply's outcome, and
// claims counts the guest.updates that took a gate. invites are the
// guest.invite.create params sent.
type relabelHerdr struct {
	d       *Desk
	srv     *fakeherdr.Server
	guests  *fakeherdr.Guests
	failing atomic.Bool
	held    atomic.Pointer[chan *fakeherdr.APIError]
	claims  atomic.Int32
	done    atomic.Int32
	mu      sync.Mutex
	sent    []herdrapi.GuestUpdateParams
	invites []herdrapi.GuestInviteCreateParams
}

func newRelabelHerdr(t *testing.T, nickname string, relabel bool) *relabelHerdr {
	t.Helper()
	var caps []string
	if relabel {
		caps = []string{"guest_relabel"}
	}
	return newRelabelHerdrWith(t, nickname, caps...)
}

// newOrderedRelabelHerdr is newRelabelHerdr's with herdr #526: its ping also
// reports guest_relabel_rev, and the fixture keeps revisions.
func newOrderedRelabelHerdr(t *testing.T, nickname string) *relabelHerdr {
	t.Helper()
	return newRelabelHerdrWith(t, nickname, "guest_relabel", "guest_relabel_rev")
}

func newRelabelHerdrWith(t *testing.T, nickname string, capabilities ...string) *relabelHerdr {
	t.Helper()
	h := &relabelHerdr{guests: fakeherdr.NewGuests()}
	h.d, h.srv = federatedDeskAs(t, nickname, func(s *fakeherdr.Server) {
		original := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				value, err := original(method, raw)
				if caps, ok := value.(map[string]any)["capabilities"].(map[string]bool); ok {
					for _, c := range capabilities {
						caps[c] = true
					}
				}
				return value, err
			case "guest.invite.create":
				var p herdrapi.GuestInviteCreateParams
				_ = json.Unmarshal(raw, &p)
				h.mu.Lock()
				h.invites = append(h.invites, p)
				h.mu.Unlock()
			case "guest.update":
				var p herdrapi.GuestUpdateParams
				_ = json.Unmarshal(raw, &p)
				h.mu.Lock()
				h.sent = append(h.sent, p)
				h.mu.Unlock()
				if h.failing.Load() {
					h.done.Add(1)
					return nil, &fakeherdr.APIError{Code: "guest_store_unavailable", Message: "try again"}
				}
				if gate := h.held.Swap(nil); gate != nil {
					h.claims.Add(1)
					if refused := <-*gate; refused != nil {
						h.done.Add(1)
						return nil, refused
					}
				}
				value, err, _ := h.guests.Handle(method, raw)
				h.done.Add(1)
				return value, err
			}
			if value, err, handled := h.guests.Handle(method, raw); handled {
				return value, err
			}
			return original(method, raw)
		}
	})
	return h
}

func (h *relabelHerdr) updates() []herdrapi.GuestUpdateParams {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]herdrapi.GuestUpdateParams(nil), h.sent...)
}

// rename saves the one machine under nickname.
func (h *relabelHerdr) rename(t *testing.T, nickname string) {
	t.Helper()
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	m := saved[0].Machine
	m.Nickname = nickname
	if err := h.d.SaveMachine(m, saved[0].ID); err != nil {
		t.Fatalf("the rename failed: %v", err)
	}
}

// reconnect connects again and waits for the new connection's first list,
// taken: what it sends on connect is started by then.
func (h *relabelHerdr) reconnect(t *testing.T) {
	t.Helper()
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	h.d.Disconnect()
	if err := h.d.SelectMachine(saved[0].ID, ""); err != nil {
		t.Fatal(err)
	}
	h.listed(t)
}

// listed waits for the live connection's first list, taken.
func (h *relabelHerdr) listed(t *testing.T) {
	t.Helper()
	waitFor(t, "the connection's first list", func() bool {
		h.d.mu.Lock()
		defer h.d.mu.Unlock()
		return h.d.link != nil && h.d.link.caps != nil
	})
}

// hold holds the next guest.update until release gives its outcome: nil,
// taken; an API error, refused. The cleanup releases it whatever happened.
func (h *relabelHerdr) hold(t *testing.T) (release func(*fakeherdr.APIError)) {
	gate := make(chan *fakeherdr.APIError, 1)
	h.held.Store(&gate)
	var once sync.Once
	release = func(outcome *fakeherdr.APIError) { once.Do(func() { gate <- outcome }) }
	t.Cleanup(func() { release(nil) })
	return release
}

// live is the desk's open connection.
func (h *relabelHerdr) live() *link {
	h.d.mu.Lock()
	defer h.d.mu.Unlock()
	return h.d.link
}

// list is the fixture's guest.list: its guests and invites.
func (h *relabelHerdr) list(t *testing.T) herdrapi.ResponseResultGuestList {
	t.Helper()
	value, apiErr, _ := h.guests.Handle("guest.list", json.RawMessage(`{}`))
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	var list herdrapi.ResponseResultGuestList
	if err := json.Unmarshal(value.(json.RawMessage), &list); err != nil {
		t.Fatal(err)
	}
	return list
}

// labels are the machine labels of the fixture's active guests and pending
// invites on this machine, and revs their revisions.
func (h *relabelHerdr) labels(t *testing.T) (labels []string, revs []uint64) {
	t.Helper()
	list := h.list(t)
	for _, g := range list.Guests {
		if !g.Revoked {
			labels, revs = append(labels, "guest "+g.MachineLabel), append(revs, g.MachineLabelRev)
		}
	}
	now := uint64(time.Now().UnixMilli())
	for _, i := range list.Invites {
		if i.UsedBy == nil && i.ExpiresMs > now {
			labels, revs = append(labels, "invite "+i.MachineLabel), append(revs, i.MachineLabelRev)
		}
	}
	return labels, revs
}

// everywhere is what labels reads once the fixture's shares all carry label:
// its three active guests and one pending invite.
func everywhere(label string) []string {
	return []string{"guest " + label, "guest " + label, "guest " + label, "invite " + label}
}

// holds reports whether every share and invite holds label at rev.
func (h *relabelHerdr) holds(t *testing.T, label string, rev uint64) bool {
	t.Helper()
	labels, revs := h.labels(t)
	return slices.Equal(labels, everywhere(label)) && !slices.ContainsFunc(revs, func(r uint64) bool { return r != rev })
}

// labelRev is the saved machine's label revision.
func (h *relabelHerdr) labelRev(t *testing.T) uint64 {
	t.Helper()
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	return saved[0].LabelRev
}

// answered waits for n guest.updates sent and answered: those sent.
func (h *relabelHerdr) answered(t *testing.T, n int) []herdrapi.GuestUpdateParams {
	t.Helper()
	waitFor(t, fmt.Sprintf("%d relabels answered", n), func() bool { return len(h.updates()) == n && int(h.done.Load()) == n })
	return h.updates()
}

// invite opens a share view of the live machine and has herdr create an
// invite: the params it was sent. The invite is the fixture's too.
func (h *relabelHerdr) invite(t *testing.T) herdrapi.GuestInviteCreateParams {
	t.Helper()
	b := h.d.Board()
	if _, err := h.d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "v"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.d.CreateGuestInvite(context.Background(), "v", "Taylor", "Owner", false); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.invites[len(h.invites)-1]
}

// store rewrites the saved machines with change.
func (h *relabelHerdr) store(t *testing.T, change func(*machineStore)) {
	t.Helper()
	h.d.storeMu.Lock()
	defer h.d.storeMu.Unlock()
	st, err := h.d.load()
	if err == nil {
		change(&st)
		err = h.d.store(st)
	}
	if err != nil {
		t.Fatal(err)
	}
}

// A herdr with guest_relabel alone (no revisions) is sent a rename once,
// while connected, without a revision, the invite label bounded as herdr
// takes it (64 runes), best effort: nothing is sent again, not on a
// refusal, not on a connect, and a rename while not connected waits for the
// next rename.
func TestAnOldHerdrIsSentARenameOnceWhileConnected(t *testing.T) {
	h := newRelabelHerdr(t, "Old", true)
	nickname := strings.Repeat("Studio ", 9) + "Workshop"
	want := strings.Repeat("Studio ", 9) + "W"
	h.rename(t, nickname)
	p := h.answered(t, 1)[0]
	if p.MachineLabel == nil || *p.MachineLabel != want || p.MachineLabelRev != nil || p.GuestID != nil || p.InviteID != nil || p.ShareGram != nil {
		t.Fatalf("guest.update %+v (label %v, rev %v), want machine_label %q alone", p, p.MachineLabel, p.MachineLabelRev, want)
	}
	if got, _ := h.labels(t); !slices.Equal(got, everywhere(want)) {
		t.Fatalf("labels after the rename %q", got)
	}
	h.rename(t, nickname) // renames nothing
	h.reconnect(t)
	h.failing.Store(true)
	h.rename(t, "Refused")
	h.answered(t, 2)
	h.failing.Store(false)
	h.reconnect(t)
	h.d.Disconnect()
	h.rename(t, "Offline")
	h.reconnect(t)
	if n := len(h.updates()); n != 2 {
		t.Fatalf("%d guest.update calls; want the two renames made while connected", n)
	}
	if got, _ := h.labels(t); !slices.Equal(got, everywhere(want)) {
		t.Fatalf("labels %q; want the old name kept until the next rename", got)
	}
	h.rename(t, "Next")
	h.answered(t, 3)
	if got, _ := h.labels(t); !slices.Equal(got, everywhere("Next")) {
		t.Fatalf("labels %q after the next rename", got)
	}
}

// A herdr without guest_relabel is asked nothing, connected or on its next
// connect: its shares keep their label, as before.
func TestARenameIsNotSentToAHerdrWithoutGuestRelabel(t *testing.T) {
	h := newRelabelHerdr(t, "Old", false)
	h.rename(t, "New")
	h.reconnect(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("guest.update sent to a herdr without guest_relabel: %+v", got)
	}
}

// With guest_relabel_rev every owner connection sends the profile's label
// at its revision on its first list, a profile never renamed aside (nothing
// to send): a rename while not connected goes on the next connect, and each
// connect after sends it again, which changes nothing.
func TestEveryConnectSendsTheLabelAtItsRevision(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.reconnect(t)
	if n := len(h.updates()); n != 0 {
		t.Fatalf("%d guest.update calls for a machine never renamed", n)
	}
	h.d.Disconnect()
	h.rename(t, "New")
	if n := len(h.updates()); n != 0 {
		t.Fatalf("%d guest.update calls while not connected", n)
	}
	rev := h.labelRev(t)
	h.reconnect(t)
	p := h.answered(t, 1)[0]
	if p.MachineLabel == nil || *p.MachineLabel != "New" || p.MachineLabelRev == nil || *p.MachineLabelRev != rev || !h.holds(t, "New", rev) {
		t.Fatalf("sent %+v (rev %v), shares %+v; want New at %d everywhere", p, p.MachineLabelRev, h.list(t), rev)
	}
	h.reconnect(t)
	if p := h.answered(t, 2)[1]; *p.MachineLabel != "New" || *p.MachineLabelRev != rev || !h.holds(t, "New", rev) {
		t.Fatalf("sent %+v again, shares %+v; want New at %d, unchanged", p, h.list(t), rev)
	}
}

// #570's probe, with guest_relabel_rev: First is held past the connection
// it went on (unanswered), Second goes beside it and is taken, the next
// connect sends Second again, and First lands late: herdr keeps Second,
// whose revision is above First's.
func TestAnUnansweredRelabelAcrossAReconnectEndsWithTheNewest(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	release := h.hold(t)
	h.rename(t, "First")
	waitFor(t, "First held", func() bool { return h.claims.Load() == 1 })
	h.rename(t, "Second")
	second := h.labelRev(t)
	waitFor(t, "Second taken", func() bool { return h.done.Load() == 1 && h.holds(t, "Second", second) })
	h.reconnect(t)
	waitFor(t, "Second sent again on connect", func() bool { return len(h.updates()) == 3 && h.done.Load() == 2 })
	release(nil)
	h.answered(t, 3)
	if !h.holds(t, "Second", second) {
		t.Fatalf("shares %+v after First landed late; want Second at %d", h.list(t), second)
	}
}

// The startup connect (main starts the saved machine directly) sends the
// profile's label at its revision as every connect does, and a profile
// without a local id started there is still the one renames while
// connected relabel (the first gives it one): sent, and the next invite
// carries the newest.
func TestAStartupConnectRelabels(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	startup := func() {
		t.Helper()
		h.d.Disconnect()
		m, err := h.d.Machine()
		if err != nil || m == nil {
			t.Fatalf("the saved machine %+v, %v", m, err)
		}
		h.d.start(*m, "")
		h.listed(t)
	}
	h.d.Disconnect()
	h.rename(t, "Named")
	named := h.labelRev(t)
	startup()
	if p := h.answered(t, 1)[0]; *p.MachineLabel != "Named" || *p.MachineLabelRev != named || !h.holds(t, "Named", named) {
		t.Fatalf("sent %+v at startup, shares %+v; want Named at %d", p, h.list(t), named)
	}
	h.store(t, func(st *machineStore) { st.Machines[0].LocalID = "" })
	startup()
	h.answered(t, 2)
	for i, name := range []string{"New", "Newer"} {
		h.rename(t, name)
		rev := h.labelRev(t)
		if p := h.answered(t, 3+i)[2+i]; *p.MachineLabel != name || *p.MachineLabelRev != rev || !h.holds(t, name, rev) {
			t.Fatalf("sent %+v for the rename, shares %+v; want %s at %d", p, h.list(t), name, rev)
		}
	}
	if p, rev := h.invite(t), h.labelRev(t); p.MachineLabel != "Newer" || p.MachineLabelRev == nil || *p.MachineLabelRev != rev {
		t.Fatalf("an invite after the renames: %+v (rev %v); want Newer at %d", p, p.MachineLabelRev, rev)
	}
}

// #594's probe: one save moves the connected profile to another
// destination (another user, here on the same server) and renames it. The
// link to its former destination is sent nothing and keeps its label for
// invites; connecting to the new destination sends the new label.
func TestAMovedProfileIsRelabeledOnlyAtItsNewDestination(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	l := h.live()
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	m := saved[0].Machine
	m.Nickname, m.User = "New B", "other"
	if err := h.d.SaveMachine(m, saved[0].ID); err != nil {
		t.Fatal(err)
	}
	h.d.mu.Lock()
	label, rev := l.shareLabel, l.shareLabelRev
	h.d.mu.Unlock()
	if n := len(h.updates()); n != 0 || label != "Old" || rev != 0 {
		t.Fatalf("%d guest.update calls, the old link names %q at %d; want nothing sent, Old kept", n, label, rev)
	}
	h.reconnect(t)
	moved := h.labelRev(t)
	if p := h.answered(t, 1)[0]; *p.MachineLabel != "New B" || *p.MachineLabelRev != moved || !h.holds(t, "New B", moved) {
		t.Fatalf("sent %+v, shares %+v; want New B at %d", p, h.list(t), moved)
	}
}

// #594's probe: account sync removes the connected profile (its connection
// stays until it ends) and moves another to its address. A save of a third
// profile, or a rename of the one now at the address, leaves the link
// naming the profile it was started with: nothing is sent, and an invite
// carries that profile's label and revision.
func TestALinkKeepsItsLabelWhenAnotherProfileTakesItsAddress(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.rename(t, "Named")
	rev := h.labelRev(t)
	h.answered(t, 1)
	h.store(t, func(st *machineStore) {
		other := st.Machines[0]
		other.Nickname, other.SyncID, other.LocalID, other.LabelRev = "Replacement", "", "", 0
		st.Machines = []Machine{other}
	})
	if err := h.d.SaveMachine(Machine{Nickname: "Third", Host: "third", User: "root", Port: 22, KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 2 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	i := slices.IndexFunc(saved, func(s SavedMachine) bool { return s.Nickname == "Replacement" })
	m := saved[i].Machine
	m.Nickname = "Renamed replacement"
	if err := h.d.SaveMachine(m, saved[i].ID); err != nil {
		t.Fatal(err)
	}
	if p := h.invite(t); len(h.updates()) != 1 || p.MachineLabel != "Named" || p.MachineLabelRev == nil || *p.MachineLabelRev != rev {
		t.Fatalf("%d guest.update calls, an invite %+v (rev %v); want nothing more sent, Named at %d", len(h.updates()), p, p.MachineLabelRev, rev)
	}
}

// guest-relabels.json, an older build's relabel queue, is deleted where a
// connection starts, unread: the connect sends the profile's own label at
// its revision.
func TestTheOlderRelabelQueueIsDeletedUnread(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.rename(t, "Named")
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	h.d.storeMu.Lock()
	err = writeFileAtomic(h.d.guestRelabelsPath(), []byte(fmt.Sprintf(`{%q:{"label":"Legacy","rev":%d}}`, saved[0].LocalID, saved[0].LabelRev+1)))
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	h.reconnect(t)
	h.d.storeMu.Lock()
	_, err = os.Stat(h.d.guestRelabelsPath())
	h.d.storeMu.Unlock()
	if !os.IsNotExist(err) {
		t.Fatalf("the older queue after a connect: %v; want it deleted", err)
	}
	if p := h.answered(t, 1)[0]; *p.MachineLabel != "Named" || *p.MachineLabelRev != saved[0].LabelRev {
		t.Fatalf("sent %+v; want Named at %d", p, saved[0].LabelRev)
	}
}

// An invite of the machine carries its label's revision, so a relabel
// older than its label never overwrites it; before any rename, none.
func TestAnInviteCarriesItsLabelsRevision(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	if p := h.invite(t); p.MachineLabel != "Old" || p.MachineLabelRev != nil {
		t.Fatalf("an invite before any rename: %+v (rev %v); want Old, no revision", p, p.MachineLabelRev)
	}
	h.rename(t, "New")
	if p, rev := h.invite(t), h.labelRev(t); p.MachineLabel != "New" || p.MachineLabelRev == nil || *p.MachineLabelRev != rev {
		t.Fatalf("an invite after the rename: %+v (rev %v); want New at %d", p, p.MachineLabelRev, rev)
	}
}

// A rename's revision is above the profile's, even one ahead of the clock
// (the clock went back since), so herdr, which holds that one, takes it.
func TestARenameGoesAboveItsProfilesRevision(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	ahead := uint64(time.Now().Add(time.Hour).UnixMilli())
	h.d.Disconnect()
	h.store(t, func(st *machineStore) {
		st.Machines[0].Nickname, st.Machines[0].LocalID, st.Machines[0].LabelRev = "Named", newLocalID(), ahead
	})
	h.reconnect(t)
	h.answered(t, 1)
	h.rename(t, "New")
	h.answered(t, 2)
	if rev := h.labelRev(t); rev <= ahead || !h.holds(t, "New", rev) {
		t.Fatalf("shares %+v, revision %d; want New taken above %d", h.list(t), rev, ahead)
	}
}

// A profile saved again at a removed one's user@host:port inherits none of
// its label: its connect sends nothing.
func TestAProfileSavedAgainInheritsNoLabel(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	h.d.Disconnect()
	h.rename(t, "Renamed")
	if err := h.d.RemoveMachine(saved[0].ID); err != nil {
		t.Fatal(err)
	}
	fresh := saved[0].Machine
	fresh.Nickname = "Fresh"
	if err := h.d.SaveMachine(fresh, ""); err != nil {
		t.Fatal(err)
	}
	h.reconnect(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("the fresh profile's connect sent %+v", got)
	}
}

// Only a rename of a saved machine gives it a new label revision, above the
// one before, and a local id if it has none, which an edit that moves the
// machine to another user@host:port keeps; a new profile takes neither from
// the page.
func TestARenameGivesItsProfileANewLabelRevision(t *testing.T) {
	d := newDesk(t.TempDir())
	save := func(m Machine, replacing string) Machine {
		t.Helper()
		if err := d.SaveMachine(m, replacing); err != nil {
			t.Fatal(err)
		}
		saved, err := d.Machines()
		if err != nil || len(saved) != 1 {
			t.Fatalf("saved %+v, %v", saved, err)
		}
		return saved[0].Machine
	}
	pi := save(Machine{Nickname: "Old", Host: "pi", User: "root", KeyPath: "/k", LocalID: "from-the-page", LabelRev: 9}, "")
	if pi.LocalID != "" || pi.LabelRev != 0 {
		t.Fatalf("a new machine: local id %q, label revision %d", pi.LocalID, pi.LabelRev)
	}
	pi.Session = "work"
	if pi = save(pi, "root@pi:22"); pi.LocalID != "" || pi.LabelRev != 0 {
		t.Fatalf("an edit that renames nothing: local id %q, label revision %d", pi.LocalID, pi.LabelRev)
	}
	pi.Nickname = "New"
	pi = save(pi, "root@pi:22")
	profile, first := pi.LocalID, pi.LabelRev
	pi.User, pi.LocalID, pi.LabelRev = "admin", "another", 1
	if pi = save(pi, "root@pi:22"); len(profile) != 32 || first == 0 || pi.LocalID != profile || pi.LabelRev != first {
		t.Fatalf("local id %q then %q, label revision %d then %d; want the rename's kept", profile, pi.LocalID, first, pi.LabelRev)
	}
	pi.Nickname = "Newer"
	if pi = save(pi, "admin@pi:22"); pi.LabelRev <= first {
		t.Fatalf("label revision %d after %d; a rename's is above the one before", pi.LabelRev, first)
	}
}

// A guest's reconnect takes the machine's new name from herdr's hello reply
// (the owner renamed it, herdr #519): saved with the share (SHARED WITH YOU)
// and named by the open link's state (its header). A reply that names no
// machine (an older herdr) changes nothing.
func TestAGuestReconnectTakesTheMachinesNewName(t *testing.T) {
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		t.Fatal(err)
	}
	relay.Handle = (&guestOwnerHost{status: "idle"}).handle
	d, _ := openGuestAgent(t, relay, guest.SystemClock)
	list, err := d.SharedConnections()
	if err != nil || len(list) != 1 || list[0].MachineLabel != "studio" {
		t.Fatalf("shares %+v, %v", list, err)
	}
	id := list[0].ID()
	names := func() [3]string {
		saved, _ := d.SharedConnections()
		s := d.State()
		shown := ""
		if s.Guest != nil {
			shown = s.Guest.Access.MachineLabel
		}
		return [3]string{saved[0].MachineLabel, s.Machine, shown}
	}
	reconnect := func(label string) {
		t.Helper()
		relay.SetMachineLabel(label)
		hellos := len(relay.Hellos())
		if err := d.ConnectGuest(id); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "the reconnect listed", func() bool {
			s := d.State()
			return len(relay.Hellos()) > hellos && s.Phase == "connected" && s.Guest != nil
		})
	}
	reconnect("Studio Mac")
	if got, want := names(), [3]string{"Studio Mac", "Studio Mac", "Studio Mac"}; got != want {
		t.Fatalf("after a reconnect to the renamed machine: saved, state, header %q, want %q", got, want)
	}
	reconnect("")
	if got, want := names(), [3]string{"Studio Mac", "Studio Mac", "Studio Mac"}; got != want {
		t.Fatalf("after a hello naming no machine: saved, state, header %q, want %q", got, want)
	}
}
