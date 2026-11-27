package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
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
	// workList, while set, holds the work session's agent.list until it
	// is closed.
	workList atomic.Pointer[chan struct{}]
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
		s.HandleSession = func(session, method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if gate := h.workList.Load(); gate != nil && session == "work" && method == "agent.list" {
				<-*gate
			}
			return s.Handle(method, raw)
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
	p, err := h.tryInvite(t)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// tryInvite is invite, the desk's refusal returned.
func (h *relabelHerdr) tryInvite(t *testing.T) (herdrapi.GuestInviteCreateParams, error) {
	t.Helper()
	b := h.d.Board()
	if _, err := h.d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "v"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.d.CreateGuestInvite(context.Background(), "v", "Taylor", "Owner", false); err != nil {
		return herdrapi.GuestInviteCreateParams{}, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.invites[len(h.invites)-1], nil
}

// failDirSync makes every sync of the desk's folder fail with EIO until
// the returned func lifts it.
func (h *relabelHerdr) failDirSync(t *testing.T) (lift func()) {
	t.Helper()
	real := syncDir
	var failing atomic.Bool
	failing.Store(true)
	syncDir = func(dir string) error {
		if failing.Load() && filepath.Clean(dir) == filepath.Clean(h.d.dir) {
			return syscall.EIO
		}
		return real(dir)
	}
	t.Cleanup(func() { syncDir = real })
	return func() { failing.Store(false) }
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

// drain waits, still connected, until every relabel the live link
// scheduled has ended, sent or not, while its connection could carry it.
// Disconnect cancels before it waits, which can end a wrong send before it
// is made.
func (h *relabelHerdr) drain(t *testing.T) {
	t.Helper()
	l := h.live()
	waitFor(t, "the link's relabels ended", func() bool { return l.relabels.Load() == 0 })
	h.d.mu.Lock()
	live := h.d.link == l && l.client != nil
	h.d.mu.Unlock()
	if !live {
		t.Fatal("the connection ended while its work drained")
	}
}

// blockStore makes every write of machines.json fail (a folder where its
// temp file goes) until the returned func lifts it.
func (h *relabelHerdr) blockStore(t *testing.T) (lift func()) {
	t.Helper()
	tmp := h.d.machinesPath() + ".tmp"
	if err := os.Mkdir(tmp, 0o700); err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	lift = func() {
		once.Do(func() {
			if err := os.Remove(tmp); err != nil {
				t.Error(err)
			}
		})
	}
	t.Cleanup(lift)
	return lift
}

// writeQueue writes a preview.28 relabel queue naming the saved profile.
func (h *relabelHerdr) writeQueue(t *testing.T, localID, label string) {
	t.Helper()
	h.d.storeMu.Lock()
	err := writeFileAtomic(h.d.guestRelabelsPath(), []byte(fmt.Sprintf(`{%q:%q}`, localID, label)))
	h.d.storeMu.Unlock()
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
	h.drain(t) // the connect's work ended, connected
	if n := len(h.updates()); n != 2 {
		t.Fatalf("%d guest.update calls; want the two renames made while connected", n)
	}
	if got, _ := h.labels(t); !slices.Equal(got, everywhere(want)) {
		t.Fatalf("labels %q; want the old name kept until the next rename", got)
	}
	h.reconnect(t)
	h.rename(t, "Next")
	h.answered(t, 3)
	if got, _ := h.labels(t); !slices.Equal(got, everywhere("Next")) {
		t.Fatalf("labels %q after the next rename", got)
	}
}

// A herdr without guest_relabel is asked nothing, connected or on its next
// connect: its shares keep their label, as before. The link's work ends
// while it is still connected (drain) before nothing sent is checked.
func TestARenameIsNotSentToAHerdrWithoutGuestRelabel(t *testing.T) {
	h := newRelabelHerdr(t, "Old", false)
	h.rename(t, "New")
	h.drain(t)
	h.reconnect(t)
	h.rename(t, "Newer")
	h.drain(t)
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
	h.drain(t) // the connect's work ended, connected
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

// A session switch keeps the SSH connection, and the label goes once per
// connection: the new session's first list sends nothing more.
func TestASessionSwitchSendsTheLabelNoMore(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.rename(t, "New")
	h.reconnect(t)
	h.answered(t, 1)
	h.srv.SetSessionList(`{"sessions":[{"name":"default","default":true,"running":true},{"name":"work","running":true}]}`)
	if err := h.d.SelectSession("work"); err != nil {
		t.Fatal(err)
	}
	// The work watch cleared caps before its first list asked: caps again
	// after that list is that first list, taken.
	waitFor(t, "the work session's first list, taken", func() bool {
		listed := slices.ContainsFunc(h.srv.Requests(), func(r fakeherdr.Request) bool {
			return r.Method == "agent.list" && r.Session == "work"
		})
		h.d.mu.Lock()
		defer h.d.mu.Unlock()
		return listed && h.d.link != nil && h.d.link.session == "work" && h.d.link.caps != nil
	})
	h.drain(t) // its work ended, connected
	if n := len(h.updates()); n != 1 {
		t.Fatalf("%d guest.update calls after a session switch; want the connection's one", n)
	}
}

// #570's probe, with guest_relabel_rev: First is held past the connection
// it went on (unanswered), Second goes beside it and is taken, the next
// connect sends Second again, and First lands late: herdr keeps Second,
// whose revision is above First's.
func TestAnUnansweredRelabelAcrossAReconnectEndsWithTheNewest(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	// A connection whose own send is answered: nothing more of it comes.
	h.d.Disconnect()
	h.rename(t, "Zero")
	h.reconnect(t)
	h.answered(t, 1)
	release := h.hold(t)
	h.rename(t, "First")
	waitFor(t, "First held", func() bool { return h.claims.Load() == 1 })
	h.rename(t, "Second")
	second := h.labelRev(t)
	waitFor(t, "Second taken", func() bool { return h.done.Load() == 2 && h.holds(t, "Second", second) })
	h.reconnect(t)
	waitFor(t, "Second sent again on connect", func() bool { return len(h.updates()) == 4 && h.done.Load() == 3 })
	release(nil)
	h.answered(t, 4)
	if !h.holds(t, "Second", second) {
		t.Fatalf("shares %+v after First landed late; want Second at %d", h.list(t), second)
	}
}

// The startup connect (main starts the saved machine directly) sends the
// profile's label at its revision as every connect does, and a profile
// saved without a local id gets one where it is read (stored), so the link
// started with it is the one renames while connected relabel: sent, and
// the next invite carries the newest.
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
// link to its former destination is sent nothing: its share view still
// previews the old name, and (round 11) no invite of it opens, its profile
// no longer there. Connecting to the new destination sends the new label.
func TestAMovedProfileIsRelabeledOnlyAtItsNewDestination(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.drain(t)
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	m := saved[0].Machine
	m.Nickname, m.User = "New B", "other"
	if err := h.d.SaveMachine(m, saved[0].ID); err != nil {
		t.Fatal(err)
	}
	if p, err := h.tryInvite(t); !refused(err, unboundRefusal) {
		t.Fatalf("an invite of the old destination: %+v (rev %v), %v; want it refused", p, p.MachineLabelRev, err)
	}
	if details, err := h.d.GuestShareDetails("v"); err != nil || details.MachineLabel != "Old" {
		t.Fatalf("the old destination's share view previews %+v, %v; want Old", details, err)
	}
	h.drain(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("the old destination was sent %+v", got)
	}
	h.reconnect(t)
	moved := h.labelRev(t)
	if p := h.answered(t, 1)[0]; *p.MachineLabel != "New B" || *p.MachineLabelRev != moved || !h.holds(t, "New B", moved) {
		t.Fatalf("sent %+v, shares %+v; want New B at %d", p, h.list(t), moved)
	}
}

// #594's probe: account sync removes the connected profile (its connection
// stays until it ends) and moves another to its address, written without a
// local id (given one where it is read). A save of a third profile, or a
// rename of the one now at the address, leaves the link naming the profile
// it was started with: nothing is sent, and (round 11) no invite opens of
// a machine whose profile is gone.
func TestALinkKeepsItsLabelWhenAnotherProfileTakesItsAddress(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.rename(t, "Named")
	h.reconnect(t)
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
	if p, err := h.tryInvite(t); !refused(err, unboundRefusal) || len(h.updates()) != 1 {
		t.Fatalf("%d guest.update calls, an invite %+v (rev %v), %v; want nothing more sent, the invite refused", len(h.updates()), p, p.MachineLabelRev, err)
	}
}

// #594's probe: a rename saved after a connect took its profile's snapshot
// and before the link went in (SelectMachine's gap) goes on that
// connection's first list, read from the profile as saved then, and the
// next invite carries it. A profile moved to another destination in that
// gap is sent nothing over the connection to its former one.
func TestARenameSavedAsAConnectionStartsIsSent(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	snapshot := func() Machine {
		t.Helper()
		h.d.Disconnect()
		m, err := h.d.Machine()
		if err != nil || m == nil {
			t.Fatalf("the saved machine %+v, %v", m, err)
		}
		return *m
	}
	m := snapshot()
	h.rename(t, "Gap")
	rev := h.labelRev(t)
	h.d.start(m, "")
	h.listed(t)
	if p := h.answered(t, 1)[0]; *p.MachineLabel != "Gap" || *p.MachineLabelRev != rev || !h.holds(t, "Gap", rev) {
		t.Fatalf("sent %+v, shares %+v; want Gap at %d", p, h.list(t), rev)
	}
	if p := h.invite(t); p.MachineLabel != "Gap" || p.MachineLabelRev == nil || *p.MachineLabelRev != rev {
		t.Fatalf("an invite: %+v (rev %v); want Gap at %d", p, p.MachineLabelRev, rev)
	}
	m = snapshot()
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	moved := saved[0].Machine
	moved.Nickname, moved.User = "Moved", "other"
	if err := h.d.SaveMachine(moved, saved[0].ID); err != nil {
		t.Fatal(err)
	}
	h.d.start(m, "")
	h.listed(t)
	h.drain(t) // its work ended, connected
	if n := len(h.updates()); n != 1 {
		t.Fatalf("%d guest.update calls; want nothing sent to the moved profile's former destination", n)
	}
}

// v0.1.0-preview.28 kept renames not yet sent in guest-relabels.json, by
// local id, the label alone, and saved no label revision. Upgrading, each
// one of a saved profile takes a revision of now, so the profile's label
// goes at it on the next connect; the file is deleted, entries of no saved
// profile with it.
func TestAPreview28RelabelQueueIsSentOnTheNextConnect(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.store(t, func(st *machineStore) { st.Machines[0].Nickname, st.Machines[0].LabelRev = "Renamed", 0 })
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" || saved[0].LabelRev != 0 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	h.d.storeMu.Lock()
	err = writeFileAtomic(h.d.guestRelabelsPath(), []byte(fmt.Sprintf(`{%q:"Renamed","0123456789abcdef0123456789abcdef":"Gone"}`, saved[0].LocalID)))
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	before := uint64(time.Now().UnixMilli())
	h.reconnect(t)
	p := h.answered(t, 1)[0]
	if rev := h.labelRev(t); *p.MachineLabel != "Renamed" || *p.MachineLabelRev < before || *p.MachineLabelRev != rev || !h.holds(t, "Renamed", rev) {
		t.Fatalf("sent %+v (rev %v), saved revision %d, shares %+v; want Renamed at a revision of the upgrade, saved", p, *p.MachineLabelRev, rev, h.list(t))
	}
	h.d.storeMu.Lock()
	_, err = os.Stat(h.d.guestRelabelsPath())
	h.d.storeMu.Unlock()
	if !os.IsNotExist(err) {
		t.Fatalf("the older queue after the upgrade: %v; want it deleted", err)
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
	h.drain(t) // the connect's work ended, connected
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("the fresh profile's connect sent %+v", got)
	}
}

// Every saved profile has its own local id, never the page's, kept by any
// edit, a move to another user@host:port included, and given where it is
// read to one saved without (account sync, older builds). A change of its
// invite label (its nickname, or its host while it has none) gives it a new
// label revision, above the one before; nothing else does.
func TestALabelChangeGivesItsProfileANewLabelRevision(t *testing.T) {
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
	profile := pi.LocalID
	if len(profile) != 32 || pi.LabelRev != 0 {
		t.Fatalf("a new machine: local id %q, label revision %d", pi.LocalID, pi.LabelRev)
	}
	pi.Session = "work"
	if pi = save(pi, "root@pi:22"); pi.LocalID != profile || pi.LabelRev != 0 {
		t.Fatalf("an edit that relabels nothing: local id %q, label revision %d", pi.LocalID, pi.LabelRev)
	}
	pi.Nickname = "New"
	pi = save(pi, "root@pi:22")
	first := pi.LabelRev
	pi.User, pi.LocalID, pi.LabelRev = "admin", "another", 1
	if pi = save(pi, "root@pi:22"); first == 0 || pi.LocalID != profile || pi.LabelRev != first {
		t.Fatalf("local id %q, label revision %d then %d; want both kept", pi.LocalID, first, pi.LabelRev)
	}
	pi.Nickname = "Newer"
	if pi = save(pi, "admin@pi:22"); pi.LabelRev <= first {
		t.Fatalf("label revision %d after %d; a rename's is above the one before", pi.LabelRev, first)
	}
	// Without a nickname the host is the label: a host change relabels, a
	// nickname naming the machine as its host already does doesn't.
	renamed := pi.LabelRev
	pi.Nickname = ""
	pi = save(pi, "admin@pi:22")
	unnamed := pi.LabelRev
	pi.Host = "pi.local"
	if pi = save(pi, "admin@pi:22"); unnamed <= renamed || pi.LabelRev <= unnamed {
		t.Fatalf("label revisions %d, %d, %d; want each label change above the one before", renamed, unnamed, pi.LabelRev)
	}
	hostRev := pi.LabelRev
	pi.Nickname = "pi.local"
	if pi = save(pi, "admin@pi.local:22"); pi.LabelRev != hostRev {
		t.Fatalf("label revision %d after a nickname naming it as it was, want %d", pi.LabelRev, hostRev)
	}
	d.storeMu.Lock()
	st, err := d.load()
	if err == nil {
		st.Machines[0].LocalID = ""
		err = d.store(st)
	}
	d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	saved, err := d.Machines()
	again, _ := d.Machines()
	if err != nil || len(saved[0].LocalID) != 32 || saved[0].LocalID == profile || again[0].LocalID != saved[0].LocalID {
		t.Fatalf("a profile read without a local id: %q, then %q; want one given and kept", saved[0].LocalID, again[0].LocalID)
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

// SHARED WITH YOU names a machine as its latest hello did, whichever of its
// grants comes first: two grants on one host both say "Old"; the second's
// hello renames the machine "New", and both read "New", the first's saved
// label untouched; the first's own hello, naming it "New" too, doesn't flip
// the name back.
func TestSharedWithYouNamesAMachineAsItsLatestHelloDid(t *testing.T) {
	d := newDesk(t.TempDir())
	host := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	accepted := time.Now().Add(-time.Hour)
	share := func(id string, at time.Time) guest.Access {
		return guest.Access{GuestID: id, GuestName: "guest", MachineLabel: "Old", OwnerName: "Owner", AgentName: id, AgentTarget: "%2",
			Endpoint: guest.Endpoint{Relay: "https://relay.example", HostID: host, HostPublicKey: make([]byte, 32)}, AcceptedAt: at}
	}
	first, second := share("first", accepted), share("second", accepted.Add(time.Minute))
	for _, a := range []guest.Access{first, second} {
		if err := d.guestStore.Save(a); err != nil {
			t.Fatal(err)
		}
	}
	labels := func() []string {
		t.Helper()
		list, err := d.SharedConnections()
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, a := range list {
			out = append(out, a.GuestID+"="+a.MachineLabel)
		}
		return out
	}
	if got := labels(); !slices.Equal(got, []string{"first=Old", "second=Old"}) {
		t.Fatalf("before any hello: %q", got)
	}
	d.guestRelabeled(second.ID(), "New")
	if got := labels(); !slices.Equal(got, []string{"first=New", "second=New"}) {
		t.Fatalf("after the second's hello renamed the machine: %q", got)
	}
	if saved, _ := d.guestStore.List(); saved[0].MachineLabel != "Old" {
		t.Fatalf("the first grant's saved label changed: %+v", saved[0])
	}
	d.guestRelabeled(first.ID(), "New")
	if got := labels(); !slices.Equal(got, []string{"first=New", "second=New"}) {
		t.Fatalf("after the first's hello named it the same: %q", got)
	}
}

// liveProfile is the live link's profile (local id).
func (h *relabelHerdr) liveProfile() string {
	h.d.mu.Lock()
	defer h.d.mu.Unlock()
	return h.d.link.profile
}

// #594 rounds 6 and 8: a local id given where the profile is read, its
// store failing, is not used. A link started with that profile, its first
// list unable to store one either, has none for its run: a rename relabels
// nothing, no address stands in, and it opens no invite of its machine (the
// reviewer's sequence: writes back, a rename saved; an invite never names
// it Old). The next load that stores an id keeps it from then on, and a
// connect after binds to it: a rename then reaches its herdr and the live
// invite.
func TestALinkBindsOnlyAStoredLocalID(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.store(t, func(st *machineStore) { st.Machines[0].LocalID = "" })
	lift := h.blockStore(t)
	m, err := h.d.Machine()
	if err != nil || m == nil {
		t.Fatalf("the saved machine %+v, %v", m, err)
	}
	h.d.start(*m, "")
	h.listed(t)
	lift()
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	id := saved[0].LocalID
	if again, err := h.d.Machines(); err != nil || again[0].LocalID != id {
		t.Fatalf("saved again %+v, %v; want local id %s kept", again, err, id)
	}
	if p := h.liveProfile(); p != "" && p != id {
		t.Fatalf("the link started with local id %q, never stored (stored: %s)", p, id)
	}
	h.rename(t, "Unbound")
	h.drain(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("a link with no stored local id sent %+v", got)
	}
	switch p, err := h.tryInvite(t); {
	case err != nil && err.Error() != "Couldn't save this machine's settings. Reconnect to share it.":
		t.Fatalf("an invite of the unbound link: %v; want it refused for its settings", err)
	case err == nil && (p.MachineLabel != "Unbound" || p.MachineLabelRev == nil || *p.MachineLabelRev != h.labelRev(t)):
		t.Fatalf("an invite of the unbound link: %+v (rev %v); want Unbound at its revision, or none", p, p.MachineLabelRev)
	}
	h.reconnect(t)
	if p := h.liveProfile(); p != id {
		t.Fatalf("the next link's profile %q, want %s", p, id)
	}
	h.answered(t, 1) // the connect's: Unbound
	h.rename(t, "Bound")
	rev := h.labelRev(t)
	if p := h.answered(t, 2)[1]; *p.MachineLabel != "Bound" || *p.MachineLabelRev != rev || !h.holds(t, "Bound", rev) {
		t.Fatalf("sent %+v, shares %+v; want Bound at %d", p, h.list(t), rev)
	}
	if p := h.invite(t); p.MachineLabel != "Bound" || p.MachineLabelRev == nil || *p.MachineLabelRev != rev {
		t.Fatalf("an invite after the rename: %+v (rev %v); want Bound at %d", p, p.MachineLabelRev, rev)
	}
}

// #594 round 6, the reviewer's probe: a rename saved after a connect took
// its snapshot, the store busy while the connection lists. Its first board
// already names the machine as saved: an invite opened from it carries the
// rename and its revision.
func TestTheFirstBoardNamesTheMachineAsSaved(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	m, err := h.d.Machine()
	if err != nil || m == nil {
		t.Fatalf("the saved machine %+v, %v", m, err)
	}
	h.rename(t, "Saved")
	rev := h.labelRev(t)
	h.d.storeMu.Lock()
	var once sync.Once
	release := func() { once.Do(h.d.storeMu.Unlock) }
	t.Cleanup(release)
	h.d.start(*m, "")
	// The board may not come while the store is busy; one that does must
	// name the machine as saved.
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if l := h.live(); l != nil && func() bool { h.d.mu.Lock(); defer h.d.mu.Unlock(); return l.caps != nil }() {
			break
		}
	}
	h.d.mu.Lock()
	listed := h.d.link != nil && h.d.link.caps != nil
	h.d.mu.Unlock()
	if !listed {
		release()
		h.listed(t)
	}
	p := h.invite(t)
	release()
	if p.MachineLabel != "Saved" || p.MachineLabelRev == nil || *p.MachineLabelRev != rev {
		t.Fatalf("an invite from the first board: %+v (rev %v); want Saved at %d", p, p.MachineLabelRev, rev)
	}
}

// #594 round 6: a rename while a session switch's first list is still on
// its way goes on the SSH connection, which the switch keeps: herdr is sent
// it then, not on a list of that connection.
func TestARenameDuringASessionSwitchIsSent(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.drain(t)
	gate := make(chan struct{})
	h.workList.Store(&gate)
	var once sync.Once
	open := func() { once.Do(func() { close(gate) }) }
	t.Cleanup(open)
	h.srv.SetSessionList(`{"sessions":[{"name":"default","default":true,"running":true},{"name":"work","running":true}]}`)
	if err := h.d.SelectSession("work"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the work session's first list, held", func() bool {
		return slices.ContainsFunc(h.srv.Requests(), func(r fakeherdr.Request) bool {
			return r.Method == "agent.list" && r.Session == "work"
		})
	})
	h.rename(t, "New")
	rev := h.labelRev(t)
	if p := h.answered(t, 1)[0]; *p.MachineLabel != "New" || *p.MachineLabelRev != rev || !h.holds(t, "New", rev) {
		t.Fatalf("sent %+v, shares %+v; want New at %d", p, h.list(t), rev)
	}
	open()
}

// #594 round 6: the preview.28 queue folded in, its store failing, gives
// no revision: the profile reads as saved (none), and a connect sends
// nothing. The next load stores the fold, and the link still connected
// sends it (round 10).
func TestAFoldNotStoredGivesNoRevision(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.store(t, func(st *machineStore) { st.Machines[0].Nickname, st.Machines[0].LabelRev = "Renamed", 0 })
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	id := saved[0].LocalID
	h.writeQueue(t, id, "Renamed")
	lift := h.blockStore(t)
	if again, err := h.d.Machines(); err != nil || again[0].LabelRev != 0 || again[0].LocalID != id {
		t.Fatalf("saved %+v, %v while the fold can't be stored; want no revision, local id %s", again, err, id)
	}
	m, err := h.d.Machine()
	if err != nil || m == nil {
		t.Fatalf("the saved machine %+v, %v", m, err)
	}
	h.d.start(*m, "")
	h.listed(t)
	h.drain(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("a fold not stored sent %+v", got)
	}
	lift()
	rev := h.labelRev(t)
	if p := h.answered(t, 1)[0]; rev == 0 || *p.MachineLabel != "Renamed" || *p.MachineLabelRev != rev {
		t.Fatalf("sent %+v, saved revision %d; want Renamed at it", p, rev)
	}
}

// #594 round 6: a fold stored but its queue not deleted (interrupted
// between the two) is folded again at the next load, which changes no
// revision: preview.28 kept none, so a profile with one was folded or
// renamed since. The queue goes then.
func TestAnInterruptedFoldRaisesNoRevision(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.store(t, func(st *machineStore) { st.Machines[0].Nickname, st.Machines[0].LabelRev = "Renamed", 0 })
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	h.writeQueue(t, saved[0].LocalID, "Renamed")
	folded := h.labelRev(t)
	h.writeQueue(t, saved[0].LocalID, "Renamed")
	waitFor(t, "the clock past the fold", func() bool { return uint64(time.Now().UnixMilli()) > folded })
	if rev := h.labelRev(t); folded == 0 || rev != folded {
		t.Fatalf("revision %d after the fold again; want %d", rev, folded)
	}
	h.d.storeMu.Lock()
	_, err = os.Stat(h.d.guestRelabelsPath())
	h.d.storeMu.Unlock()
	if !os.IsNotExist(err) {
		t.Fatalf("the older queue: %v; want it deleted", err)
	}
}

// #594 round 7, the reviewer's order: the store is busy while a
// connection's first list waits to read the profile. A Disconnect ends that
// wait with the watch: it returns at once, and nothing is published or sent.
func TestADisconnectEndsAFirstListWaitingForTheStore(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.rename(t, "New")
	m, err := h.d.Machine()
	if err != nil || m == nil {
		t.Fatalf("the saved machine %+v, %v", m, err)
	}
	h.d.storeMu.Lock()
	var once sync.Once
	release := func() { once.Do(h.d.storeMu.Unlock) }
	t.Cleanup(release)
	h.d.start(*m, "")
	waitFor(t, "the first list waiting for the store", func() bool {
		buf := make([]byte, 1<<20)
		return bytes.Contains(buf[:runtime.Stack(buf, true)], []byte("(*Desk).publishLabel("))
	})
	began := time.Now()
	h.d.Disconnect()
	if took := time.Since(began); took > time.Second {
		t.Fatalf("Disconnect took %s with the first list waiting for the store", took)
	}
	release()
	if b := h.d.Board(); b != nil {
		t.Fatalf("a board published after the Disconnect: %+v", b)
	}
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("sent %+v for a first list the Disconnect ended", got)
	}
}

// #594 rounds 7 and 8: a relabel takes its link's route when scheduled
// (relabelLocked), and a later board or redial that replaces the route
// before the send goes is not used: here the route scheduled on has ended
// and the replacement is live, and nothing is sent.
func TestARelabelGoesByTheRouteItWasScheduledOn(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.drain(t)
	l := h.live()
	ended, cancel := context.WithCancel(context.Background())
	cancel()
	h.d.mu.Lock()
	replacement := l.relabelVia
	l.relabelVia = relabelRoute{view: replacement.view, caps: replacement.caps, ctx: ended}
	h.d.relabelLocked(l, shownLabel{"Late", nextLabelRev(0)})
	l.relabelVia = replacement
	h.d.mu.Unlock()
	h.drain(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("a relabel scheduled on an ended route sent %+v by its replacement", got)
	}
}

// writeRaw rewrites machines.json with change as another writer does
// (account sync), no load in between: no local id is given.
func (h *relabelHerdr) writeRaw(t *testing.T, change func(*machineStore)) {
	t.Helper()
	h.d.storeMu.Lock()
	defer h.d.storeMu.Unlock()
	st, err := h.d.readMachines()
	if err != nil {
		t.Fatal(err)
	}
	change(&st)
	data, err := encodeMachines(st)
	if err == nil {
		err = writeFileAtomic(h.d.machinesPath(), data)
	}
	if err != nil {
		t.Fatal(err)
	}
}

// refused reports whether err is the desk's refusal want, by its words.
func refused(err error, want string) bool { return err != nil && err.Error() == want }

const (
	unboundRefusal   = "Couldn't save this machine's settings. Reconnect to share it."
	undurableRefusal = "Couldn't save this machine's settings. Try sharing again in a moment."
	unreadRefusal    = "Couldn't read this machine's settings. Try sharing again in a moment."
)

// #594 rounds 7 to 9: the older queue goes only once its fold is durable.
// A fold written but its folder's sync failing, the queue stays, the next
// load (nothing to change) retrying the sync alone, no rewrite; once a
// sync succeeds, the queue goes and the fold stands.
func TestTheOlderQueueOutlivesAFoldNotDurable(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.store(t, func(st *machineStore) { st.Machines[0].Nickname, st.Machines[0].LabelRev = "Renamed", 0 })
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	h.writeQueue(t, saved[0].LocalID, "Renamed")
	lift := h.failDirSync(t)
	if _, err := h.d.Machines(); err != nil { // the fold, written, its sync failing
		t.Fatal(err)
	}
	// A second name keeps the file's inode from being reused by a rewrite.
	pinned := filepath.Join(t.TempDir(), "machines.json")
	if err := os.Link(h.d.machinesPath(), pinned); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(pinned)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.d.Machines(); err != nil {
		t.Fatal(err)
	}
	queue := func() error {
		h.d.storeMu.Lock()
		defer h.d.storeMu.Unlock()
		_, err := os.Stat(h.d.guestRelabelsPath())
		return err
	}
	if err := queue(); err != nil {
		t.Fatalf("the older queue, its fold not durable: %v; want it kept", err)
	}
	lift()
	if rev := h.labelRev(t); rev == 0 {
		t.Fatal("no revision once the fold is durable")
	}
	if err := queue(); !os.IsNotExist(err) {
		t.Fatalf("the older queue after a sync: %v; want it deleted", err)
	}
	if after, err := os.Stat(h.d.machinesPath()); err != nil || !os.SameFile(before, after) {
		t.Fatalf("machines.json rewritten (%v) with nothing to change", err)
	}
}

// #594 rounds 8 and 9: a fold whose folder sync fails (EIO, at its store
// and at every retry) reaches nobody: its connect sends nothing and no
// invite of the machine opens. Once a sync succeeds, the link still
// connected sends the folded revision (round 11: it was owed).
func TestAFoldIsSentOnlyOnceDurable(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.store(t, func(st *machineStore) { st.Machines[0].Nickname, st.Machines[0].LabelRev = "Renamed", 0 })
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	h.writeQueue(t, saved[0].LocalID, "Renamed")
	lift := h.failDirSync(t)
	m, err := h.d.Machine() // the fold's store: written, its sync failing
	if err != nil || m == nil || m.LabelRev != 0 {
		t.Fatalf("the saved machine %+v, %v; want no revision", m, err)
	}
	h.d.start(*m, "") // its first list's load: the sync failing again
	h.listed(t)
	h.drain(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("a fold not durable sent %+v", got)
	}
	if p, err := h.tryInvite(t); !refused(err, undurableRefusal) {
		t.Fatalf("an invite while the fold is not durable: %+v (rev %v), %v; want it refused", p, p.MachineLabelRev, err)
	}
	lift()
	rev := h.labelRev(t)
	if p := h.answered(t, 1)[0]; rev == 0 || *p.MachineLabel != "Renamed" || *p.MachineLabelRev != rev {
		t.Fatalf("sent %+v, saved revision %d; want Renamed at it", p, rev)
	}
}

// #594 round 9: a plain rename whose store's folder sync fails (EIO) is in
// the file but may not survive a crash: nothing goes out (not by the save,
// not by the next connect) and no invite of the machine opens, until a sync
// succeeds; then the link still connected sends it (round 11: the send was
// owed), and invites carry it.
func TestARenameIsSentOnlyOnceDurable(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.drain(t)
	lift := h.failDirSync(t)
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	m := saved[0].Machine
	m.Nickname = "New"
	if err := h.d.SaveMachine(m, saved[0].ID); err == nil {
		t.Fatal("a save whose folder sync failed reported none")
	}
	h.drain(t)
	h.d.Disconnect()
	started, err := h.d.Machine() // New, as the file holds it
	if err != nil || started == nil || started.Nickname != "New" {
		t.Fatalf("the saved machine %+v, %v", started, err)
	}
	h.d.start(*started, "")
	h.listed(t)
	h.drain(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("a rename not durable sent %+v", got)
	}
	if p, err := h.tryInvite(t); !refused(err, undurableRefusal) {
		t.Fatalf("an invite while the rename is not durable: %+v (rev %v), %v; want it refused", p, p.MachineLabelRev, err)
	}
	lift()
	rev := h.labelRev(t)
	if p := h.answered(t, 1)[0]; rev == 0 || *p.MachineLabel != "New" || *p.MachineLabelRev != rev || !h.holds(t, "New", rev) {
		t.Fatalf("sent %+v, shares %+v; want New at %d", p, h.list(t), rev)
	}
	if p := h.invite(t); p.MachineLabel != "New" || p.MachineLabelRev == nil || *p.MachineLabelRev != rev {
		t.Fatalf("an invite once durable: %+v (rev %v); want New at %d", p, p.MachineLabelRev, rev)
	}
}

// #594 round 9: a link started with a profile whose local id could not be
// stored is not bound at its first list to the profile at its address
// still without one: account sync may have put another there (here, once
// writes are back). It stays unbound: nothing is sent for that profile's
// rename, and no invite of the machine opens.
func TestAFirstListBindsNoProfileThatTookItsAddress(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.store(t, func(st *machineStore) { st.Machines[0].LocalID = "" })
	lift := h.blockStore(t)
	m, err := h.d.Machine()
	if err != nil || m == nil || m.LocalID != "" {
		t.Fatalf("the saved machine %+v, %v; want no local id", m, err)
	}
	lift()
	h.writeRaw(t, func(st *machineStore) {
		st.Machines[0].Nickname, st.Machines[0].SyncID, st.Machines[0].LocalID = "Replacement", "another", ""
	})
	h.d.start(*m, "")
	h.listed(t)
	if p := h.liveProfile(); p != "" {
		t.Fatalf("the link bound to %q, the profile that took its address", p)
	}
	h.rename(t, "Replacement renamed")
	h.drain(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("the unbound link sent %+v", got)
	}
	if p, err := h.tryInvite(t); !refused(err, unboundRefusal) {
		t.Fatalf("an invite of the unbound link: %+v (rev %v), %v; want it refused", p, p.MachineLabelRev, err)
	}
}

// failedRename saves the one machine under nickname with its folder's sync
// failing: the file holds it, the save reports the failure.
func (h *relabelHerdr) failedRename(t *testing.T, nickname string) (lift func()) {
	t.Helper()
	lift = h.failDirSync(t)
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	m := saved[0].Machine
	m.Nickname = nickname
	if err := h.d.SaveMachine(m, saved[0].ID); err == nil {
		t.Fatal("a save whose folder sync failed reported none")
	}
	h.drain(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("a rename not durable sent %+v", got)
	}
	return lift
}

// countDirSyncs counts the syncs of the desk's folder from now on.
func (h *relabelHerdr) countDirSyncs(t *testing.T) func() int32 {
	t.Helper()
	real := syncDir
	var n atomic.Int32
	syncDir = func(dir string) error {
		if filepath.Clean(dir) == filepath.Clean(h.d.dir) {
			n.Add(1)
		}
		return real(dir)
	}
	t.Cleanup(func() { syncDir = real })
	return n.Load
}

// #594 round 10: a rename whose store failed its folder's sync, the link
// still connected, is shared once a sync succeeds at an invite: the invite
// carries it with its revision, and the shares are relabeled.
func TestAnInviteAfterASyncRecoversCarriesTheRename(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.drain(t)
	h.failedRename(t, "New")()
	p := h.invite(t)
	rev := h.labelRev(t)
	if rev == 0 || p.MachineLabel != "New" || p.MachineLabelRev == nil || *p.MachineLabelRev != rev {
		t.Fatalf("an invite once durable: %+v (rev %v); want New at %d", p, p.MachineLabelRev, rev)
	}
	u := h.answered(t, 1)[0]
	labels, revs := h.labels(t) // the invite just created among them
	if *u.MachineLabel != "New" || *u.MachineLabelRev != rev || !slices.Equal(labels, append(everywhere("New"), "invite New")) || slices.ContainsFunc(revs, func(r uint64) bool { return r != rev }) {
		t.Fatalf("sent %+v, shares %v at %v; want New at %d", u, labels, revs, rev)
	}
}

// #594 round 10: the same rename saved again once the folder syncs finds
// the file already renamed, the link behind it: the shares are relabeled.
func TestARepeatedRenameAfterASyncRecoversIsSent(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.drain(t)
	h.failedRename(t, "New")()
	h.rename(t, "New")
	rev := h.labelRev(t)
	if u := h.answered(t, 1)[0]; rev == 0 || *u.MachineLabel != "New" || *u.MachineLabelRev != rev || !h.holds(t, "New", rev) {
		t.Fatalf("sent %+v, shares %+v; want New at %d", u, h.list(t), rev)
	}
}

// #594 round 10: once any load finds the folder syncs again, the link
// still connected catches up with the rename and relabels its shares.
func TestARenameNotDurableIsSentOnceItsFolderSyncs(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.drain(t)
	h.failedRename(t, "New")()
	rev := h.labelRev(t)
	if u := h.answered(t, 1)[0]; rev == 0 || *u.MachineLabel != "New" || *u.MachineLabelRev != rev || !h.holds(t, "New", rev) {
		t.Fatalf("sent %+v, shares %+v; want New at %d", u, h.list(t), rev)
	}
}

// #594 round 10: a load that rewrites machines.json leaves its folder's
// sync to the rewrite; no second one runs.
func TestALoadThatRewritesSyncsTheFolderOnce(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.drain(t)
	h.failedRename(t, "New")()
	h.d.Disconnect()
	h.writeRaw(t, func(st *machineStore) { st.Machines[0].LocalID = "" })
	syncs := h.countDirSyncs(t)
	m, err := h.d.Machine()
	if err != nil || m == nil || m.LocalID == "" {
		t.Fatalf("the saved machine %+v, %v; want a local id stored", m, err)
	}
	if n := syncs(); n != 1 {
		t.Fatalf("%d syncs of the folder; want the rewrite's one", n)
	}
}

// #594 round 11, probe 1: an account sync commit left interrupted (here,
// cut short) keeps the saved machines from being read; an invite of the
// machine, its profile not verified, is refused rather than sent with the
// label the link had.
func TestAnInviteWhoseProfileCantBeReadIsRefused(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.drain(t)
	h.d.storeMu.Lock()
	err := os.WriteFile(h.d.commitPath(), []byte(`{"machines":`), 0o600)
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if p, err := h.tryInvite(t); !refused(err, unreadRefusal) {
		t.Fatalf("an invite of a profile that can't be read: %+v (rev %v), %v; want it refused", p, p.MachineLabelRev, err)
	}
}

// #594 round 11, probe 2: a connection whose first list read the rename
// while its folder's sync failed owes it to the shares: once the sync
// succeeds, at an invite, the shares are relabeled, not only the invite.
func TestAFirstListNotDurableIsSentOnceASyncSucceeds(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.drain(t)
	lift := h.failedRename(t, "New")
	h.d.Disconnect()
	started, err := h.d.Machine()
	if err != nil || started == nil || started.Nickname != "New" {
		t.Fatalf("the saved machine %+v, %v", started, err)
	}
	h.d.start(*started, "")
	h.listed(t)
	h.drain(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("a rename not durable sent %+v", got)
	}
	lift()
	p := h.invite(t)
	rev := h.labelRev(t)
	if rev == 0 || p.MachineLabel != "New" || p.MachineLabelRev == nil || *p.MachineLabelRev != rev {
		t.Fatalf("an invite once durable: %+v (rev %v); want New at %d", p, p.MachineLabelRev, rev)
	}
	if u := h.answered(t, 1)[0]; *u.MachineLabel != "New" || *u.MachineLabelRev != rev {
		t.Fatalf("sent %+v; want New at %d", u, rev)
	}
}

// #594 round 11: what herdr took on one SSH connection is not taken for
// the next one's (link.sentRev starts at 0): a redial of the same link
// sends the label again on its first list.
func TestEveryConnectionSendsTheLabelAgain(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.drain(t)
	l := h.live()
	h.rename(t, "New")
	rev := h.labelRev(t)
	h.answered(t, 1)
	h.srv.DropConns()
	got := h.answered(t, 2)
	if *got[1].MachineLabel != "New" || *got[1].MachineLabelRev != rev {
		t.Fatalf("sent %+v at the redial; want New at %d", got[1], rev)
	}
	if h.live() != l {
		t.Fatal("the redial replaced the link")
	}
}

// offlineRenamedLegacy is a herdr without guest_relabel_rev whose machine
// was renamed while disconnected: the saved machine, to connect with.
func offlineRenamedLegacy(t *testing.T) (*relabelHerdr, Machine) {
	t.Helper()
	h := newRelabelHerdr(t, "Old", true)
	h.drain(t)
	h.d.Disconnect()
	h.rename(t, "Offline")
	m, err := h.d.Machine()
	if err != nil || m == nil || m.Nickname != "Offline" {
		t.Fatalf("the saved machine %+v, %v", m, err)
	}
	return h, *m
}

// #594 round 12, probe 1: a herdr without guest_relabel_rev is sent no
// rename made before its connection's first list read the profile: not by
// a real SaveMachine held at syncDir while that first list installed its
// route and waited for storeMu. The healthy control, the first list not
// held up, sends nothing either, nor does a save then that renames nothing;
// a rename saved once it read the profile is sent.
func TestALegacyHerdrIsSentNoRenameMadeBeforeItsFirstListRead(t *testing.T) {
	for _, held := range []bool{true, false} {
		h, m := offlineRenamedLegacy(t)
		before, _ := h.labels(t)
		if held {
			entered := make(chan struct{})
			release := make(chan struct{})
			saveDone := make(chan error, 1)
			var once, releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			origSync := syncDir
			syncDir = func(dir string) error {
				once.Do(func() {
					close(entered)
					<-release
				})
				return origSync(dir)
			}
			saveWaited := false
			t.Cleanup(func() {
				unblock()
				if !saveWaited {
					<-saveDone
				}
				syncDir = origSync
			})

			during := m
			during.Nickname = "During"
			go func() {
				saveDone <- h.d.SaveMachine(during, machineID(m))
			}()
			select {
			case <-entered:
			case err := <-saveDone:
				saveWaited = true
				t.Fatalf("held SaveMachine returned before syncDir: %v", err)
			case <-time.After(5 * time.Second):
				t.Fatal("timed out waiting for SaveMachine to reach syncDir")
			}
			h.d.start(m, "")
			// Wait until this connection's own link installed its relabel route
			// under d.mu (right before calling publishLabel for its first list).
			waitFor(t, "this connection installed its relabel route", func() bool {
				h.d.mu.Lock()
				defer h.d.mu.Unlock()
				return h.d.link != nil && h.d.link.relabelVia.view != nil
			})
			unblock()
			saveWaited = true
			if err := <-saveDone; err != nil {
				t.Fatalf("held SaveMachine: %v", err)
			}
		} else {
			h.d.start(m, "")
		}
		h.listed(t)
		h.drain(t)
		if got := h.updates(); len(got) != 0 {
			t.Fatalf("held %v: the offline rename was sent %+v", held, got)
		}
		if got, _ := h.labels(t); !slices.Equal(got, before) {
			t.Fatalf("held %v: labels %q; want the shares' own kept", held, got)
		}
		now, err := h.d.Machine()
		if err != nil || now == nil {
			t.Fatalf("the saved machine %+v, %v", now, err)
		}
		h.rename(t, now.Nickname) // a save on the connection that renames nothing
		h.drain(t)
		if got := h.updates(); len(got) != 0 {
			t.Fatalf("held %v: a save that renames nothing sent %+v", held, got)
		}
		h.rename(t, "Online")
		if p := h.answered(t, 1)[0]; *p.MachineLabel != "Online" || p.MachineLabelRev != nil {
			t.Fatalf("held %v: sent %+v; want Online without a revision", held, p)
		}
	}
}

// #594 round 12: an online rename on a herdr without guest_relabel_rev
// whose machines.json rename succeeded while directory sync returned EIO
// must not send while undurable, and must still relabel existing shares
// once the store becomes durable again (either on a retry of SaveMachine
// or on directory-sync recovery).
func TestLegacyOnlineRenameSurvivesDirSyncFailure(t *testing.T) {
	for _, viaRetry := range []bool{true, false} {
		name := "recover"
		if viaRetry {
			name = "retry"
		}
		t.Run(name, func(t *testing.T) {
			h, m := offlineRenamedLegacy(t)
			h.d.start(m, "")
			h.listed(t)
			h.drain(t)

			var failDir atomic.Bool
			failDir.Store(true)
			origSync := syncDir
			syncDir = func(dir string) error {
				if failDir.Load() {
					return errors.New("input/output error")
				}
				return origSync(dir)
			}
			t.Cleanup(func() { syncDir = origSync })

			renamed := m
			renamed.Nickname = "New"
			if err := h.d.SaveMachine(renamed, machineID(m)); err == nil {
				t.Fatal("first SaveMachine with failing syncDir succeeded, want error")
			}
			h.drain(t)
			if got := h.updates(); len(got) != 0 {
				t.Fatalf("sent while undurable: %+v; want none", got)
			}

			failDir.Store(false)
			if viaRetry {
				if err := h.d.SaveMachine(renamed, machineID(renamed)); err != nil {
					t.Fatalf("retry SaveMachine: %v", err)
				}
			} else {
				if _, err := h.d.Machine(); err != nil {
					t.Fatalf("recovery read: %v", err)
				}
			}
			if p := h.answered(t, 1)[0]; *p.MachineLabel != "New" || p.MachineLabelRev != nil {
				t.Fatalf("sent %+v; want New without a revision", p)
			}
		})
	}
}

// #594 round 12, probe 2: a first list whose read of the profile fails
// (an account sync commit cut short) leaves a herdr without
// guest_relabel_rev sent nothing for that connection, even once the commit
// reads again: neither an invite nor a rename then sends anything.
func TestALegacyFirstListThatCantReadSendsNothing(t *testing.T) {
	h, m := offlineRenamedLegacy(t)
	journal := func(raw []byte) {
		t.Helper()
		h.d.storeMu.Lock()
		defer h.d.storeMu.Unlock()
		var err error
		if raw != nil {
			err = os.WriteFile(h.d.commitPath(), raw, 0o600)
		} else {
			err = os.Remove(h.d.commitPath())
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	journal([]byte(`{"machines":`))
	h.d.start(m, "")
	h.listed(t)
	journal(nil)
	if p := h.invite(t); p.MachineLabel != "Offline" {
		t.Fatalf("an invite once the commit reads: %+v; want Offline", p)
	}
	h.drain(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("the offline rename was sent %+v", got)
	}
	h.rename(t, "Online")
	h.drain(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("a connection whose first list couldn't read sent %+v", got)
	}
}

// #594 round 13: if a local online rename on a legacy herdr fails at syncDir
// (leaving d.undurable true) and another writer (such as account sync) then
// installs a different nickname without changing LabelRev, recovery must NOT
// send that other device's nickname to the legacy herdr.
func TestLegacyRecoveryDoesNotSendAccountRename(t *testing.T) {
	h, m := offlineRenamedLegacy(t)
	before, _ := h.labels(t)
	h.d.start(m, "")
	h.listed(t)
	h.drain(t)

	// Fail syncDir during a local rename so the new file lands on disk with
	// a bumped LabelRev while d.undurable stays true.
	var failSync atomic.Bool
	failSync.Store(true)
	origSync := syncDir
	syncDir = func(dir string) error {
		if failSync.Load() {
			return errors.New("EIO")
		}
		return origSync(dir)
	}
	t.Cleanup(func() { syncDir = origSync })

	local := m
	local.Nickname = "LocalPending"
	if err := h.d.SaveMachine(local, machineID(m)); err == nil {
		t.Fatal("SaveMachine succeeded despite syncDir error")
	}
	h.drain(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("undurable local rename sent early: %+v", got)
	}

	// Simulate account sync replacing the saved nickname with another device's
	// label while keeping LabelRev unchanged, then clearing the disk error.
	failSync.Store(false)
	h.store(t, func(st *machineStore) {
		st.Machines[0].Nickname = "RemoteFromSync"
	})

	// Trigger recovery publish (e.g. a durable read or Machine() after sync).
	if _, err := h.d.Machine(); err != nil {
		t.Fatalf("Machine: %v", err)
	}
	h.d.storeMu.Lock()
	st, err := h.d.load()
	if err == nil {
		_, _ = h.d.publishLabelLocked(nil, st, publishCause{})
	}
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	h.drain(t)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("recovery sent another device's rename to legacy herdr: %+v", got)
	}
	if got, _ := h.labels(t); !slices.Equal(got, before) {
		t.Fatalf("existing share labels changed to %q; want %q", got, before)
	}
}
