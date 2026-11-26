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
// guest.invite.create params sent. While ignoreRev is set herdr drops
// machine_label_rev, as one that doesn't keep revisions does. A func in
// onList runs on the next agent.list, before its reply.
type relabelHerdr struct {
	d         *Desk
	srv       *fakeherdr.Server
	guests    *fakeherdr.Guests
	failing   atomic.Bool
	ignoreRev atomic.Bool
	held      atomic.Pointer[chan *fakeherdr.APIError]
	claims    atomic.Int32
	onList    atomic.Pointer[func()]
	done      atomic.Int32
	mu        sync.Mutex
	sent      []herdrapi.GuestUpdateParams
	invites   []herdrapi.GuestInviteCreateParams
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
			if f := h.onList.Load(); method == "agent.list" && f != nil && h.onList.CompareAndSwap(f, nil) {
				(*f)()
			}
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
				if h.ignoreRev.Load() {
					p.MachineLabelRev = nil
					raw, _ = json.Marshal(p)
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

// reconnect connects again and waits for the new connection's first list.
func (h *relabelHerdr) reconnect(t *testing.T) {
	t.Helper()
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	h.d.Disconnect()
	lists := h.count("agent.list")
	if err := h.d.SelectMachine(saved[0].ID, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the new connection's first list", func() bool { return h.count("agent.list") > lists })
}

func (h *relabelHerdr) count(method string) int {
	n := 0
	for _, r := range h.srv.Requests() {
		if r.Method == method {
			n++
		}
	}
	return n
}

// pending is the label the desk still has to send for its one profile, ""
// when none.
func (h *relabelHerdr) pending(t *testing.T) string {
	t.Helper()
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	return h.relabels(t)[saved[0].LocalID]
}

// relabels are the labels the desk still has to send, by profile, as the
// saved profiles say.
func (h *relabelHerdr) relabels(t *testing.T) map[string]string {
	t.Helper()
	return pendingRelabels(t, h.d)
}

// pendingRelabels are the labels d still has to send, by profile.
func pendingRelabels(t *testing.T, d *Desk) map[string]string {
	t.Helper()
	saved, err := d.Machines()
	if err != nil {
		t.Fatal(err)
	}
	labels := map[string]string{}
	for _, s := range saved {
		if relabelPending(s.Machine) {
			labels[s.LocalID] = inviteLabel(s.Machine)
		}
	}
	return labels
}

// legacyQueue writes guest-relabels.json as a build before #592 left it,
// with the saved profiles as that build wrote them (no fold recorded).
func (h *relabelHerdr) legacyQueue(t *testing.T, body string) {
	t.Helper()
	h.d.storeMu.Lock()
	defer h.d.storeMu.Unlock()
	st, err := h.d.load()
	if err == nil {
		st.RelabelsFolded = false
		err = h.d.store(st)
	}
	if err == nil {
		err = writeFileAtomic(h.d.guestRelabelsPath(), []byte(body))
	}
	if err != nil {
		t.Fatal(err)
	}
}

// legacyQueueGone reports the older build's queue retired.
func (h *relabelHerdr) legacyQueueGone() bool {
	h.d.storeMu.Lock()
	defer h.d.storeMu.Unlock()
	_, err := os.Stat(h.d.guestRelabelsPath())
	return os.IsNotExist(err)
}

// countTries counts, from now, the relabels this desk's senders tried
// (each relabelOnce, sent or not, through the desk's relabelSent), by link.
func (h *relabelHerdr) countTries() (tried func(*link) int) {
	var mu sync.Mutex
	n := map[*link]int{}
	hook := func(l *link) {
		mu.Lock()
		n[l]++
		mu.Unlock()
	}
	h.d.relabelSent.Store(&hook)
	return func(l *link) int {
		mu.Lock()
		defer mu.Unlock()
		return n[l]
	}
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

// labels are the machine labels of the fixture's active guests and pending
// invites on this machine.
func (h *relabelHerdr) labels(t *testing.T) []string {
	t.Helper()
	value, apiErr, _ := h.guests.Handle("guest.list", json.RawMessage(`{}`))
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	var list herdrapi.ResponseResultGuestList
	if err := json.Unmarshal(value.(json.RawMessage), &list); err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, g := range list.Guests {
		if !g.Revoked {
			out = append(out, "guest "+g.MachineLabel)
		}
	}
	now := uint64(time.Now().UnixMilli())
	for _, i := range list.Invites {
		if i.UsedBy == nil && i.ExpiresMs > now {
			out = append(out, "invite "+i.MachineLabel)
		}
	}
	return out
}

// everywhere is what labels reads once the fixture's shares all carry label:
// its three active guests and one pending invite.
func everywhere(label string) []string {
	return []string{"guest " + label, "guest " + label, "guest " + label, "invite " + label}
}

// A rename of the live machine relabels its shares and pending invites once,
// with one guest.update {machine_label} (no scope, no share_gram), the new
// invite label bounded as herdr takes it (64 runes).
func TestARenameRelabelsTheMachinesExistingShares(t *testing.T) {
	h := newRelabelHerdr(t, "Old", true)
	nickname := strings.Repeat("Studio ", 9) + "Workshop"
	want := strings.Repeat("Studio ", 9) + "W"
	h.rename(t, nickname)
	waitFor(t, "the relabel", func() bool { return len(h.updates()) == 1 })
	p := h.updates()[0]
	if p.MachineLabel == nil || *p.MachineLabel != want || p.GuestID != nil || p.InviteID != nil || p.ShareGram != nil {
		t.Fatalf("guest.update %+v (label %v), want machine_label %q alone", p, p.MachineLabel, want)
	}
	waitFor(t, "the relabel taken", func() bool { return h.pending(t) == "" })
	if got := h.labels(t); !slices.Equal(got, everywhere(want)) {
		t.Fatalf("labels after the rename %q", got)
	}
	// A save that renames nothing relabels nothing; a connect after the
	// relabel sends it no more.
	h.rename(t, nickname)
	h.reconnect(t)
	time.Sleep(300 * time.Millisecond)
	if n := len(h.updates()); n != 1 || h.pending(t) != "" {
		t.Fatalf("%d guest.update calls, pending %q; want the one relabel", n, h.pending(t))
	}
}

// A herdr without guest_relabel is asked nothing, connected or on its next
// connect: its shares keep their label, as before.
func TestARenameIsNotSentToAHerdrWithoutGuestRelabel(t *testing.T) {
	h := newRelabelHerdr(t, "Old", false)
	h.rename(t, "New")
	h.reconnect(t)
	time.Sleep(300 * time.Millisecond)
	if got := h.updates(); len(got) != 0 {
		t.Fatalf("guest.update sent to a herdr without guest_relabel: %+v", got)
	}
}

// A machine renamed while not connected is relabeled on its next connect.
func TestARenameOfAMachineNotConnectedIsSentOnItsNextConnect(t *testing.T) {
	h := newRelabelHerdr(t, "Old", true)
	h.d.Disconnect()
	h.rename(t, "New")
	if got, pending := h.updates(), h.pending(t); len(got) != 0 || pending != "New" {
		t.Fatalf("sent %+v while not connected, pending %q", got, pending)
	}
	h.reconnect(t)
	waitFor(t, "the relabel on connect", func() bool { return len(h.updates()) == 1 && h.pending(t) == "" })
	if p := h.updates()[0]; p.MachineLabel == nil || *p.MachineLabel != "New" {
		t.Fatalf("guest.update %+v", p)
	}
}

// A relabel herdr refuses leaves the rename saved and is sent again on the
// next connect.
func TestAFailedRelabelIsSentAgainOnTheNextConnect(t *testing.T) {
	h := newRelabelHerdr(t, "Old", true)
	h.failing.Store(true)
	h.rename(t, "New")
	waitFor(t, "the relabel tried", func() bool { return len(h.updates()) == 1 })
	time.Sleep(100 * time.Millisecond)
	if saved, err := h.d.Machines(); err != nil || saved[0].Nickname != "New" || h.pending(t) != "New" {
		t.Fatalf("after a refused relabel: saved %+v, %v, pending %q", saved, err, h.pending(t))
	}
	h.failing.Store(false)
	h.reconnect(t)
	waitFor(t, "the relabel sent again", func() bool { return len(h.updates()) == 2 && h.pending(t) == "" })
	if got := h.labels(t); !slices.Equal(got, everywhere("New")) {
		t.Fatalf("labels after the retry %q", got)
	}
}

// A sender asked again while its relabel is out, the rename already saved
// (a connection's first list as the rename goes), sends nothing new: the
// refused label waits for the next connect, not sent twice on this one.
func TestARefusedRelabelIsNotSentAgainOnItsConnection(t *testing.T) {
	h := newRelabelHerdr(t, "Old", true)
	release := h.hold(t)
	h.rename(t, "New")
	waitFor(t, "New held", func() bool { return h.claims.Load() == 1 })
	h.d.relabelGuests(h.live()) // asks the sender out again
	release(&fakeherdr.APIError{Code: "guest_store_unavailable", Message: "try again"})
	h.idle(t, "the sender to end")
	time.Sleep(100 * time.Millisecond)
	if n, pending := len(h.updates()), h.pending(t); n != 1 || pending != "New" {
		t.Fatalf("%d guest.update calls, pending %q; want New refused once, left for the next connect", n, pending)
	}
}

// #594: a relabel never written (bridge.ErrNotSent: here its watch had
// already ended) is no answer from herdr, so it goes again on the same
// connection.
func TestARelabelNeverWrittenGoesAgainOnItsConnection(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	tried := h.countTries()
	h.reconnect(t)
	waitFor(t, "the first list's sender to try", func() bool { return tried(h.live()) > 0 })
	h.idle(t, "the first list's sender to end")
	// A rename stored without a sender of its own.
	h.d.storeMu.Lock()
	st, err := h.d.load()
	if err == nil {
		m := &st.Machines[0]
		m.Nickname, m.LabelRev = "New", nextLabelRev(m.LabelRev)
		err = h.d.store(st)
	}
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	l := h.live()
	ended, end := context.WithCancel(context.Background())
	end()
	h.d.mu.Lock()
	watch := l.ctx
	l.ctx = ended
	h.d.mu.Unlock()
	outcome := h.d.relabelOnce(l)
	h.d.mu.Lock()
	l.ctx = watch
	h.d.mu.Unlock()
	if n := len(h.updates()); outcome != relabelDone || n != 0 || h.pending(t) != "New" {
		t.Fatalf("outcome %d, %d guest.update calls, pending %q; want New not written, still pending", outcome, n, h.pending(t))
	}
	h.d.relabelGuests(l)
	if n, pending := len(h.updates()), h.pending(t); n != 1 || pending != "" {
		t.Fatalf("%d guest.update calls, pending %q; want New sent on the same connection", n, pending)
	}
}

// #594: herdr's answer to a relabel holds for the SSH connection it came
// on. A refused one, its sender held while that connection dropped and the
// new connection's first list asked it again, goes again on the new one.
func TestARefusedRelabelGoesAgainOnANewConnection(t *testing.T) {
	h := newRelabelHerdr(t, "Old", true)
	// A connection whose first list's sender tried and ended, so the
	// rename's own is the one held and nothing is queued behind it before
	// the new connection asks.
	tried := h.countTries()
	h.reconnect(t)
	l := h.live()
	waitFor(t, "the first list's sender to try", func() bool { return tried(l) > 0 })
	h.idle(t, "the first list's sender to end")
	proceed := make(chan struct{})
	var once sync.Once
	resume := func() { once.Do(func() { close(proceed) }) }
	t.Cleanup(resume)
	var holding atomic.Bool
	hook := func(hl *link) {
		if hl == l && len(h.updates()) == 1 && holding.CompareAndSwap(false, true) {
			<-proceed
		}
	}
	h.d.relabelSent.Store(&hook)
	h.failing.Store(true)
	h.rename(t, "New")
	waitFor(t, "New refused, its sender held", holding.Load)
	h.failing.Store(false)
	h.d.mu.Lock()
	refusedOn := l.client
	h.d.mu.Unlock()
	h.srv.DropConns()
	h.queuedBehind(t) // the new connection's first list
	h.d.mu.Lock()
	now := l.client
	h.d.mu.Unlock()
	if now == nil || now == refusedOn || h.live() != l {
		t.Fatalf("the link's connection %p after %p; want a new one on the same link", now, refusedOn)
	}
	resume()
	waitFor(t, "New sent again on the new connection", func() bool { return len(h.updates()) == 2 && h.pending(t) == "" })
}

// #594: a session switch keeps the SSH connection, so a relabel herdr
// refused on it isn't sent again by the new watch's first list; a
// reconnect sends it.
func TestARefusedRelabelIsNotSentAgainAfterASessionSwitch(t *testing.T) {
	h := newRelabelHerdr(t, "Old", true)
	tried := h.countTries()
	h.failing.Store(true)
	h.rename(t, "New")
	waitFor(t, "New refused", func() bool { return h.done.Load() == 1 })
	h.idle(t, "the rename's sender to end")
	h.failing.Store(false)
	l := h.live()
	n := tried(l)
	h.restartWatch(t)
	waitFor(t, "the new watch's sender", func() bool { return tried(l) > n })
	h.idle(t, "the new watch's sender to end")
	if got, pending := len(h.updates()), h.pending(t); got != 1 || pending != "New" {
		t.Fatalf("%d guest.update calls, pending %q after the session switch; want New refused once, still pending", got, pending)
	}
	h.reconnect(t)
	waitFor(t, "New sent again on the next connect", func() bool { return len(h.updates()) == 2 && h.pending(t) == "" })
}

// #594: the startup connect (main starts the saved machine directly) gives
// the link its profile as every connect does: a profile saved before local
// ids gets one there, so its first rename relabels its shares and an invite
// carries the new label at its revision.
func TestAStartupConnectGivesTheLinkItsProfile(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.d.storeMu.Lock()
	st, err := h.d.load()
	if err == nil {
		st.Machines[0].LocalID = ""
		err = h.d.store(st)
	}
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	m, err := h.d.Machine()
	if err != nil || m == nil {
		t.Fatalf("the saved machine %+v, %v", m, err)
	}
	lists := h.count("agent.list")
	h.d.start(*m, "")
	waitFor(t, "the startup connection's first list", func() bool { return h.count("agent.list") > lists })
	h.rename(t, "New")
	waitFor(t, "New sent and taken", func() bool { return len(h.updates()) == 1 && h.pending(t) == "" })
	b := h.d.Board()
	if _, err := h.d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "v"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.d.CreateGuestInvite(context.Background(), "v", "Taylor", "Owner", false); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	p := h.invites[len(h.invites)-1]
	h.mu.Unlock()
	if rev := h.labelRev(t); p.MachineLabel != "New" || p.MachineLabelRev == nil || *p.MachineLabelRev != rev {
		t.Fatalf("an invite after the rename: %+v (rev %v); want New at %d", p, p.MachineLabelRev, rev)
	}
}

// #594, the probe: one save moves the connected profile to another
// destination (another user, here on the same server) and renames it. The
// link to its former destination neither takes the relabel nor settles it,
// nor names the new label to guests; connecting to the new destination
// sends it.
func TestARelabelGoesOnlyToItsProfilesCurrentDestination(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	tried := h.countTries()
	h.reconnect(t)
	l := h.live()
	waitFor(t, "the first list's sender to try", func() bool { return tried(l) > 0 })
	h.idle(t, "the first list's sender to end")
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	m := saved[0].Machine
	m.Nickname, m.User = "New B", "other"
	if err := h.d.SaveMachine(m, saved[0].ID); err != nil {
		t.Fatal(err)
	}
	h.d.relabelGuests(l) // the link to the former destination, asked
	h.d.mu.Lock()
	label, rev := l.shareLabel, l.shareLabelRev
	h.d.mu.Unlock()
	if got, pending := h.updates(), h.pending(t); len(got) != 0 || pending != "New B" || label != "Old" || rev != 0 {
		t.Fatalf("sent %+v, pending %q, the old link names %q at %d; want nothing sent, New B pending, Old kept", got, pending, label, rev)
	}
	saved, err = h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	lists := h.count("agent.list")
	if err := h.d.SelectMachine(saved[0].ID, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the new destination's first list", func() bool { return h.count("agent.list") > lists })
	waitFor(t, "New B sent and taken", func() bool { return len(h.updates()) == 1 && h.pending(t) == "" })
	if got := h.labels(t); !slices.Equal(got, everywhere("New B")) {
		t.Fatalf("shares %q; want New B", got)
	}
}

// #556, #561, #563, on a herdr without guest_relabel_rev: a rename while the
// previous one's relabel is out is queued behind it, never sent beside it,
// and goes once that one is done. Taken or refused (an answer), it goes at
// once on the live connection, so the newest name is the last one herdr
// takes and nothing waits. Unanswered (the relabel's context ended while
// herdr held it; herdr may still apply it, and does here, late), it doesn't
// go on that connection: not by the replacement watch's first list, nor by a
// relabel asked for on it while First is still held (#570); it waits for
// the next connection, which sends it. First is held on a gate that carries
// its outcome, and its context is cancelled only once Second is queued: no
// timing.
func TestARenameQueuedBehindARelabelOut(t *testing.T) {
	refusal := &fakeherdr.APIError{Code: "guest_store_unavailable", Message: "try again"}
	for _, c := range []struct {
		name       string
		outcome    *fakeherdr.APIError
		unanswered bool
	}{
		{name: "taken"},
		{name: "refused", outcome: refusal},
		{name: "unanswered", unanswered: true},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newRelabelHerdr(t, "Old", true)
			release := h.hold(t)
			h.rename(t, "First")
			waitFor(t, "the first relabel out", func() bool { return len(h.updates()) >= 1 })
			h.rename(t, "Second")
			h.queuedBehind(t)
			if c.unanswered {
				h.restartWatch(t)
				h.idle(t, "the sender to give up on the unanswered relabel")
				// The same connection, First still held: asked again, it sends nothing.
				h.d.relabelGuests(h.live())
				if n := len(h.updates()); n != 1 {
					t.Fatalf("%d guest.update calls on the connection First went unanswered on; want none more", n)
				}
				release(nil)
				waitFor(t, "the late relabel applied", func() bool { return h.done.Load() == 1 })
				if n, pending, got := len(h.updates()), h.pending(t), h.labels(t); n != 1 || pending != "Second" || !slices.Equal(got, everywhere("First")) {
					t.Fatalf("after an unanswered relabel: %d sent, pending %q, shares %q; want Second kept for the next connection", n, pending, got)
				}
				h.reconnect(t)
			} else {
				release(c.outcome)
			}
			waitFor(t, "Second taken", func() bool { return h.done.Load() == 2 && h.pending(t) == "" })
			var sent []string
			for _, p := range h.updates() {
				sent = append(sent, *p.MachineLabel)
			}
			if got := h.labels(t); !slices.Equal(sent, []string{"First", "Second"}) || !slices.Equal(got, everywhere("Second")) {
				t.Fatalf("sent %q, shares named %q; want First then Second, and Second everywhere", sent, got)
			}
		})
	}
}

// queuedBehind waits for the rename just saved to be queued behind the
// relabel out, and fails if it reached the server beside it instead.
func (h *relabelHerdr) queuedBehind(t *testing.T) {
	t.Helper()
	queued := func() bool {
		h.d.relabelMu.Lock()
		defer h.d.relabelMu.Unlock()
		for _, again := range h.d.relabeling {
			if again {
				return true
			}
		}
		return false
	}
	waitFor(t, "the second relabel queued or sent", func() bool { return queued() || len(h.updates()) > 1 })
	if n := len(h.updates()); !queued() || n != 1 {
		t.Fatalf("the second relabel reached the server beside the first (%d updates sent), not queued behind it", n)
	}
}

// idle waits for the desk's relabel senders to end.
func (h *relabelHerdr) idle(t *testing.T, what string) {
	t.Helper()
	waitFor(t, what, func() bool {
		h.d.relabelMu.Lock()
		defer h.d.relabelMu.Unlock()
		return len(h.d.relabeling) == 0
	})
}

// restartWatch ends the watch a relabel out runs on (as a session switch
// does), which leaves that relabel unanswered on the same connection, and
// waits for the replacement watch's first list.
func (h *relabelHerdr) restartWatch(t *testing.T) {
	t.Helper()
	h.d.mu.Lock()
	l := h.d.link
	restart, old := l.restart, l.ctx
	h.d.mu.Unlock()
	restart()
	waitFor(t, "the replacement watch's first list", func() bool {
		h.d.mu.Lock()
		defer h.d.mu.Unlock()
		return l.ctx != old && l.caps != nil
	})
}

// labelRevs are the machine label revisions of the fixture's active guests
// and pending invites.
func (h *relabelHerdr) labelRevs(t *testing.T) []uint64 {
	t.Helper()
	value, apiErr, _ := h.guests.Handle("guest.list", json.RawMessage(`{}`))
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	var list herdrapi.ResponseResultGuestList
	if err := json.Unmarshal(value.(json.RawMessage), &list); err != nil {
		t.Fatal(err)
	}
	var out []uint64
	for _, g := range list.Guests {
		if !g.Revoked {
			out = append(out, g.MachineLabelRev)
		}
	}
	now := uint64(time.Now().UnixMilli())
	for _, i := range list.Invites {
		if i.UsedBy == nil && i.ExpiresMs > now {
			out = append(out, i.MachineLabelRev)
		}
	}
	return out
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

// answered waits for herdr to have answered every guest.update sent.
func (h *relabelHerdr) answered(t *testing.T) {
	t.Helper()
	waitFor(t, "every relabel answered", func() bool { return int(h.done.Load()) == len(h.updates()) })
}

// #570, herdr #526 (guest_relabel_rev): the probe's sequence. First is held
// past the connection it went on (unanswered), Second goes on the next one
// and is taken, and First lands late: herdr keeps Second, whose revision is
// above First's, and nothing is left to send.
func TestAnOrderedRelabelHeldAcrossAReconnectNeverRevertsANewerOne(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	release := h.hold(t)
	h.rename(t, "First")
	waitFor(t, "the first relabel out", func() bool { return len(h.updates()) >= 1 })
	first := h.labelRev(t)
	h.rename(t, "Second")
	second := h.labelRev(t)
	h.reconnect(t)
	waitFor(t, "Second taken on the next connection", func() bool { return h.pending(t) == "" && slices.Equal(h.labels(t), everywhere("Second")) })
	release(nil)
	h.answered(t)
	h.idle(t, "the senders to end")
	if got, revs, pending := h.labels(t), h.labelRevs(t), h.pending(t); !slices.Equal(got, everywhere("Second")) || slices.ContainsFunc(revs, func(r uint64) bool { return r != second }) || pending != "" {
		t.Fatalf("after First landed late: shares %q at %v, pending %q; want Second at %d everywhere (First was %d)", got, revs, pending, second, first)
	}
	if p := h.updates()[0]; p.MachineLabelRev == nil || *p.MachineLabelRev != first || first >= second {
		t.Fatalf("First went as %+v; want its revision %d, below Second's %d", p, first, second)
	}
}

// #570: on a herdr that orders labels by revision, a relabel left unanswered
// doesn't hold back its connection: Second goes on the same connection (the
// replacement watch's), with no reconnect, and First, landing late, changes
// nothing.
func TestAnOrderedRelabelUnansweredDoesNotHoldBackItsConnection(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	release := h.hold(t)
	h.rename(t, "First")
	waitFor(t, "the first relabel out", func() bool { return len(h.updates()) >= 1 })
	h.rename(t, "Second")
	h.queuedBehind(t)
	client := h.live().client
	h.restartWatch(t)
	waitFor(t, "Second taken on the same connection", func() bool { return h.pending(t) == "" && slices.Equal(h.labels(t), everywhere("Second")) })
	if h.live().client != client {
		t.Fatal("the connection was replaced")
	}
	release(nil)
	h.answered(t)
	if got := h.labels(t); !slices.Equal(got, everywhere("Second")) {
		t.Fatalf("shares %q after First landed late; want Second", got)
	}
}

// #570: a relabel is forgotten only when the reply shows every share and
// invite at its revision or above. A record below it (a herdr that didn't
// keep the revision) keeps it for the next connect; one above it (a newer
// label, from another of the owner's devices) stands, and the relabel is
// done.
func TestAnOrderedRelabelIsForgottenOnlyWhenEveryRecordReachedItsRevision(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.ignoreRev.Store(true)
	h.rename(t, "Mine")
	waitFor(t, "Mine sent", func() bool { return len(h.updates()) >= 1 })
	h.answered(t)
	h.idle(t, "the sender to end")
	if pending := h.pending(t); pending != "Mine" {
		t.Fatalf("pending %q after a reply below the revision; want Mine kept", pending)
	}
	h.ignoreRev.Store(false)
	newer := uint64(time.Now().Add(time.Hour).UnixMilli())
	if _, apiErr, _ := h.guests.Handle("guest.update", json.RawMessage(fmt.Sprintf(`{"machine_label":"Elsewhere","machine_label_rev":%d}`, newer))); apiErr != nil {
		t.Fatal(apiErr)
	}
	h.reconnect(t)
	waitFor(t, "Mine sent again and done", func() bool { return len(h.updates()) >= 2 && h.pending(t) == "" })
	h.answered(t)
	h.idle(t, "the sender to end")
	if got, pending := h.labels(t), h.pending(t); !slices.Equal(got, everywhere("Elsewhere")) || pending != "" {
		t.Fatalf("shares %q, pending %q; want the newer Elsewhere kept and Mine done", got, pending)
	}
}

// #570, #592: an entry an older build queued before revisions (its label
// alone) raises its profile's revision to the file's time; the profile's
// own label goes at it (the profile, not the queue, holds the name), and the
// file is retired.
func TestARelabelQueuedBeforeRevisionsGoesAtTheFilesTime(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.rename(t, "Named")
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	renamed := saved[0].LabelRev
	time.Sleep(5 * time.Millisecond) // the file's time above the rename's
	h.legacyQueue(t, `{"`+saved[0].LocalID+`":"Legacy"}`)
	h.d.storeMu.Lock()
	info, err := os.Stat(h.d.guestRelabelsPath())
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	want := uint64(info.ModTime().UnixMilli())
	if want <= renamed {
		t.Fatalf("the file's time %d is not above the rename's %d", want, renamed)
	}
	// Connected as the page connects a machine (Connect): the connection
	// starts with the queue folded, its invite revision the folded one
	// before its first list (and its sender) comes.
	h.d.Disconnect()
	var atFirstList atomic.Uint64
	record := func() {
		h.d.mu.Lock()
		atFirstList.Store(h.d.link.shareLabelRev)
		h.d.mu.Unlock()
	}
	h.onList.Store(&record)
	lists := h.count("agent.list")
	if err := h.d.Connect(saved[0].Machine, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the connection's first list", func() bool { return h.count("agent.list") > lists && atFirstList.Load() != 0 })
	if got := atFirstList.Load(); got != want {
		t.Fatalf("the link's invite revision %d at its first list; want the folded %d", got, want)
	}
	waitFor(t, "the profile's label sent and taken", func() bool { return len(h.updates()) >= 1 && h.pending(t) == "" })
	h.answered(t)
	h.idle(t, "the sender to end")
	if n := len(h.updates()); n != 1 {
		t.Fatalf("%d guest.update calls; want the profile's one", n)
	}
	if p := h.updates()[0]; *p.MachineLabel != "Named" || p.MachineLabelRev == nil || *p.MachineLabelRev != want || !slices.Equal(h.labels(t), everywhere("Named")) {
		t.Fatalf("sent %+v (rev %v), shares %q; want Named at %d, taken", p, p.MachineLabelRev, h.labels(t), want)
	}
	if rev := h.labelRev(t); rev != want || !h.legacyQueueGone() {
		t.Fatalf("profile revision %d, queue gone %v; want %d kept as the floor, the queue retired", rev, h.legacyQueueGone(), want)
	}
}

// #570: an invite of the machine carries its label's revision, so a relabel
// older than its label never overwrites it; before any rename, none.
func TestAnInviteCarriesItsLabelsRevision(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	b := h.d.Board()
	invite := func() herdrapi.GuestInviteCreateParams {
		t.Helper()
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
	if p := invite(); p.MachineLabel != "Old" || p.MachineLabelRev != nil {
		t.Fatalf("an invite before any rename: %+v (rev %v); want Old, no revision", p, p.MachineLabelRev)
	}
	h.rename(t, "New")
	if p, rev := invite(), h.labelRev(t); p.MachineLabel != "New" || p.MachineLabelRev == nil || *p.MachineLabelRev != rev {
		t.Fatalf("an invite after the rename: %+v (rev %v); want New at %d", p, p.MachineLabelRev, rev)
	}
}

// Entries of no saved profile in an older build's queue, such as the
// address-keyed format (#554, before #557), are retired with it: never
// matched to the profile at that address, so the next connect sends nothing.
func TestAnAddressKeyedRelabelIsRetired(t *testing.T) {
	h := newRelabelHerdr(t, "Old", true)
	h.rename(t, "Named")
	waitFor(t, "the rename taken", func() bool { return h.done.Load() == 1 && h.pending(t) == "" })
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	h.idle(t, "the rename's sender to end")
	h.legacyQueue(t, `{"`+saved[0].ID+`":"Old name"}`)
	h.reconnect(t)
	time.Sleep(300 * time.Millisecond)
	if n := len(h.updates()); n != 1 || !h.legacyQueueGone() || h.pending(t) != "" {
		t.Fatalf("%d guest.update calls, queue gone %v, pending %q; the address-keyed entry must send none and go", n, h.legacyQueueGone(), h.pending(t))
	}
}

// #594: an older build's queue is folded in once, recorded with the
// profiles it changed. A queue whose deletion failed (here: written back
// after the fold, its time ahead of the clock) changes nothing on a later
// load: no profile is marked unsent again, no revision raised, nothing sent.
func TestARelabelQueueIsFoldedInOnce(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.rename(t, "Named")
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	queue := `{"` + saved[0].LocalID + `":"Legacy"}`
	h.legacyQueue(t, queue)
	h.reconnect(t)
	waitFor(t, "Named sent and taken", func() bool { return len(h.updates()) == 1 && h.pending(t) == "" })
	h.answered(t)
	h.idle(t, "the sender to end")
	h.d.storeMu.Lock()
	folded, err := os.ReadFile(h.d.machinesPath())
	if err == nil {
		err = writeFileAtomic(h.d.guestRelabelsPath(), []byte(queue))
	}
	if err == nil {
		ahead := time.Now().Add(time.Hour)
		err = os.Chtimes(h.d.guestRelabelsPath(), ahead, ahead)
	}
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond) // a fold now would stamp a later now
	h.reconnect(t)
	time.Sleep(300 * time.Millisecond)
	h.d.storeMu.Lock()
	again, err := os.ReadFile(h.d.machinesPath())
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if n, pending := len(h.updates()), h.pending(t); n != 1 || pending != "" || string(again) != string(folded) {
		t.Fatalf("%d guest.update calls, pending %q, profiles\n%s\nthen\n%s\nwant the fold once, nothing changed", n, pending, folded, again)
	}
}

// #594: the live connection's invite label and revision follow the saved
// profile whenever its LabelRev changes, a fold made by another save
// included, so a share view opened then carries the folded revision.
func TestAnInviteFollowsAFoldedRevision(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.rename(t, "Named")
	waitFor(t, "Named taken", func() bool { return h.done.Load() == 1 && h.pending(t) == "" })
	h.idle(t, "the sender to end")
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	time.Sleep(5 * time.Millisecond)
	floor := uint64(time.Now().UnixMilli())
	h.legacyQueue(t, fmt.Sprintf(`{%q:{"label":"Legacy","rev":%d}}`, saved[0].LocalID, floor))
	if err := h.d.SaveMachine(Machine{Nickname: "Other", Host: "other", User: "root", Port: 22, KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	b := h.d.Board()
	if _, err := h.d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "v"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.d.CreateGuestInvite(context.Background(), "v", "Taylor", "Owner", false); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	p := h.invites[len(h.invites)-1]
	h.mu.Unlock()
	if p.MachineLabel != "Named" || p.MachineLabelRev == nil || *p.MachineLabelRev != floor {
		t.Fatalf("an invite after the fold: %+v (rev %v); want Named at the folded %d", p, p.MachineLabelRev, floor)
	}
}

// #594: while an older build's queue exists but can't be read, nothing is
// sent or settled, since its revision may be above the profile's. Unreadable
// through a whole connect, nothing goes. Then the probe's sequence: the
// queue unreadable when the connection starts, readable again by its first
// list: the sender folds it in first and sends at its revision.
func TestNoRelabelGoesWhileTheOlderQueueCantBeRead(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.rename(t, "Named")
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	renamed := saved[0].LabelRev
	time.Sleep(5 * time.Millisecond)
	floor := uint64(time.Now().UnixMilli())
	queue := fmt.Sprintf(`{%q:{"label":"Named","rev":%d}}`, saved[0].LocalID, floor)
	h.legacyQueue(t, queue)
	path := h.d.guestRelabelsPath()
	// A directory where the queue is: it exists, and can't be read.
	h.d.storeMu.Lock()
	err = os.Remove(path)
	if err == nil {
		err = os.Mkdir(path, 0o700)
	}
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	tried := h.countTries()
	h.reconnect(t)
	waitFor(t, "the connection's sender to try", func() bool { return tried(h.live()) > 0 })
	h.idle(t, "the sender to end")
	if got, pending, rev := h.updates(), h.pending(t), h.labelRev(t); len(got) != 0 || pending != "Named" || rev != renamed {
		t.Fatalf("sent %+v, pending %q, revision %d while the queue can't be read; want nothing sent, Named pending at %d", got, pending, rev, renamed)
	}
	readable := func() {
		h.d.storeMu.Lock()
		defer h.d.storeMu.Unlock()
		if err := os.Remove(path); err != nil {
			t.Error(err)
		}
		if err := writeFileAtomic(path, []byte(queue)); err != nil {
			t.Error(err)
		}
	}
	h.onList.Store(&readable)
	h.reconnect(t)
	waitFor(t, "Named sent and taken", func() bool { return len(h.updates()) >= 1 && h.pending(t) == "" })
	h.answered(t)
	h.idle(t, "the sender to end")
	got := h.updates()
	if len(got) != 1 || *got[0].MachineLabel != "Named" || *got[0].MachineLabelRev != floor || h.labelRev(t) != floor || !h.legacyQueueGone() {
		t.Fatalf("sent %+v, revision %d, queue gone %v; want Named once, at the queue's %d", got, h.labelRev(t), h.legacyQueueGone(), floor)
	}
}

// #594, the probe's sequence: account sync removes the connected profile
// (deleted on another device: its connection stays until it ends) and moves
// another to its address. A save of a third, unrelated profile leaves the
// link naming its own profile: an invite opened then carries that profile's
// label and revision, never the other's.
func TestALinkKeepsItsLabelWhenAnotherProfileTakesItsAddress(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.rename(t, "Named")
	waitFor(t, "Named taken", func() bool { return h.done.Load() == 1 && h.pending(t) == "" })
	h.idle(t, "the sender to end")
	rev := h.labelRev(t)
	h.d.storeMu.Lock()
	st, err := h.d.load()
	if err == nil {
		other := st.Machines[0]
		other.Nickname, other.SyncID, other.LocalID, other.LabelRev, other.LabelSent = "Replacement", "", "", 0, 0
		st.Machines = []Machine{other}
		err = h.d.store(st)
	}
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err := h.d.SaveMachine(Machine{Nickname: "Third", Host: "third", User: "root", Port: 22, KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	b := h.d.Board()
	if _, err := h.d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "v"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.d.CreateGuestInvite(context.Background(), "v", "Taylor", "Owner", false); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	p := h.invites[len(h.invites)-1]
	h.mu.Unlock()
	if p.MachineLabel != "Named" || p.MachineLabelRev == nil || *p.MachineLabelRev != rev {
		t.Fatalf("an invite after the unrelated save: %+v (rev %v); want Named at %d", p, p.MachineLabelRev, rev)
	}
}

// #592, the probe's sequence: First was queued while disconnected, then
// Second was saved while the queue's write failed, so an older build's queue
// still names First. The profile holds the name: the reconnect sends Second
// at its own revision, nothing else, and leaves nothing to send.
func TestARelabelLeftByAFailedQueueWriteGoesWithTheSavedName(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.rename(t, "First")
	first := h.labelRev(t)
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	time.Sleep(2 * time.Millisecond)
	h.rename(t, "Second")
	second := h.labelRev(t)
	if second <= first {
		t.Fatalf("Second's revision %d not above First's %d", second, first)
	}
	// The older build saved Second but failed to write its queue entry, so
	// the queue still holds First's.
	h.legacyQueue(t, fmt.Sprintf(`{%q:{"label":"First","rev":%d}}`, saved[0].LocalID, first))
	h.reconnect(t)
	waitFor(t, "Second sent and taken", func() bool { return len(h.updates()) >= 1 && h.pending(t) == "" })
	h.answered(t)
	h.idle(t, "the sender to end")
	got := h.updates()
	if len(got) != 1 || *got[0].MachineLabel != "Second" || got[0].MachineLabelRev == nil || *got[0].MachineLabelRev != second {
		t.Fatalf("sent %+v; want Second alone, at %d", got, second)
	}
	if labels := h.labels(t); !slices.Equal(labels, everywhere("Second")) || !h.legacyQueueGone() {
		t.Fatalf("shares %q, queue gone %v; want Second everywhere, the queue retired", labels, h.legacyQueueGone())
	}
}

// #593: an older build's queue whose time is ahead of the clock (a skewed
// mtime) never puts its time on herdr: the revision it raises the profile to
// is clamped to now, and the next rename goes above it and is taken.
func TestAMigratedRevisionNeverMakesTheNextRenameOlder(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.rename(t, "Named")
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	h.legacyQueue(t, `{"`+saved[0].LocalID+`":"Legacy"}`)
	ahead := time.Now().Add(time.Hour)
	h.d.storeMu.Lock()
	err = os.Chtimes(h.d.guestRelabelsPath(), ahead, ahead)
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	h.reconnect(t)
	waitFor(t, "Named sent and taken", func() bool { return len(h.updates()) >= 1 && h.pending(t) == "" })
	h.answered(t)
	h.idle(t, "the sender to end")
	now := uint64(time.Now().UnixMilli())
	if p := h.updates()[0]; *p.MachineLabel != "Named" || p.MachineLabelRev == nil || *p.MachineLabelRev > now || h.labelRev(t) > now {
		t.Fatalf("sent %+v (rev %v), profile revision %d; want Named at no later than now (%d)", p, p.MachineLabelRev, h.labelRev(t), now)
	}
	h.rename(t, "New")
	waitFor(t, "New sent", func() bool { return len(h.updates()) >= 2 })
	h.answered(t)
	h.idle(t, "the sender to end")
	if got, pending := h.labels(t), h.pending(t); !slices.Equal(got, everywhere("New")) || pending != "" {
		t.Fatalf("shares %q, pending %q; want New taken", got, pending)
	}
}

// #593: a rename's revision is above the profile's, even one ahead of the
// clock (the clock went back since), so herdr, which holds that one, takes
// it.
func TestARenameGoesAboveItsProfilesRevision(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.rename(t, "Named")
	waitFor(t, "Named taken", func() bool { return h.done.Load() == 1 && h.pending(t) == "" })
	h.idle(t, "the sender to end")
	ahead := uint64(time.Now().Add(time.Hour).UnixMilli())
	h.d.Disconnect()
	h.d.storeMu.Lock()
	st, err := h.d.load()
	if err == nil {
		st.Machines[0].LabelRev, st.Machines[0].LabelSent = ahead, ahead
		err = h.d.store(st)
	}
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, apiErr, _ := h.guests.Handle("guest.update", json.RawMessage(fmt.Sprintf(`{"machine_label":"Named","machine_label_rev":%d}`, ahead))); apiErr != nil {
		t.Fatal(apiErr)
	}
	h.reconnect(t)
	h.rename(t, "New")
	waitFor(t, "New sent", func() bool { return len(h.updates()) >= 2 })
	h.answered(t)
	h.idle(t, "the sender to end")
	if got, pending, rev := h.labels(t), h.pending(t), h.labelRev(t); !slices.Equal(got, everywhere("New")) || pending != "" || rev <= ahead {
		t.Fatalf("shares %q, pending %q, revision %d; want New taken above %d", got, pending, rev, ahead)
	}
}

// #593, #594, the rule: another label at this label's very revision is one
// written elsewhere that herdr kept (it takes a label only above a
// revision). It stands: the relabel is settled, not taken, and not sent
// again.
func TestARelabelTiedWithAnotherLabelStands(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	h.d.Disconnect()
	h.rename(t, "Mine")
	rev := h.labelRev(t)
	if _, apiErr, _ := h.guests.Handle("guest.update", json.RawMessage(fmt.Sprintf(`{"machine_label":"Other","machine_label_rev":%d}`, rev))); apiErr != nil {
		t.Fatal(apiErr)
	}
	h.reconnect(t)
	waitFor(t, "Mine sent and settled", func() bool { return len(h.updates()) >= 1 && h.pending(t) == "" })
	h.answered(t)
	h.idle(t, "the sender to end")
	got := h.updates()
	if len(got) != 1 || *got[0].MachineLabel != "Mine" || *got[0].MachineLabelRev != rev || h.labelRev(t) != rev {
		t.Fatalf("sent %+v, revision %d; want Mine once, at %d", got, h.labelRev(t), rev)
	}
	if labels := h.labels(t); !slices.Equal(labels, everywhere("Other")) {
		t.Fatalf("shares %q; want Other kept everywhere", labels)
	}
}

// P3 (#591 review): a sender still on a link another connection to the
// profile replaced (no Disconnect) hands what is left to the replacement
// link's work: the next request goes out as that link's work while the old
// link's work ends. The old link's request is held at herdr (its gate
// claimed) until the replacement starts, and its sender (this desk's
// relabelSent) until the replacement's own first-list sender queued behind
// it; the replacement's request stays held through the checks.
func TestARelabelOfAReplacedLinkGoesOnWithTheNewLinksWork(t *testing.T) {
	h := newOrderedRelabelHerdr(t, "Old")
	old := h.live()
	h.hold(t)
	h.rename(t, "First")
	waitFor(t, "First held on the old link", func() bool { return h.claims.Load() == 1 })
	proceed := make(chan struct{})
	var once sync.Once
	resume := func() { once.Do(func() { close(proceed) }) }
	t.Cleanup(resume)
	hook := func(l *link) {
		if l == old {
			<-proceed
		}
	}
	h.d.relabelSent.Store(&hook) // the old sender, out with First, holds once it returns
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	if err := h.d.SelectMachine(saved[0].ID, ""); err != nil {
		t.Fatal(err)
	}
	// The replacement listed: its first list's sender found the old one
	// out and queued behind it.
	h.queuedBehind(t)
	replacement := h.live()
	waitFor(t, "the replacement listed", func() bool {
		h.d.mu.Lock()
		defer h.d.mu.Unlock()
		return replacement != old && replacement.caps != nil
	})
	h.hold(t)
	resume()
	waitFor(t, "First again, held on the replacement", func() bool { return h.claims.Load() == 2 })
	waitFor(t, "the old link's work to end, the request still held", func() bool {
		old.work.mu.Lock()
		defer old.work.mu.Unlock()
		return old.work.running == 0
	})
	// The replacement's work: its watch (run) and the sender holding First.
	replacement.work.mu.Lock()
	running := replacement.work.running
	replacement.work.mu.Unlock()
	if p := h.updates(); len(p) != 2 || *p[1].MachineLabel != "First" || running < 2 || h.live() != replacement {
		t.Fatalf("sent %+v, the replacement's work %d running; want First held as the replacement's work", p, running)
	}
}

// #557: a relabel belongs to the saved profile that was renamed. It goes with
// the profile, whether removed here or replaced (as account sync replaces
// one), and a profile saved again at the same user@host:port inherits nothing:
// its connect sends no guest.update. That profile, connected without a local
// id of its own, gets one, so its own rename goes over its connection.
func TestARelabelGoesWithItsProfile(t *testing.T) {
	for _, gone := range []string{"removed", "replaced"} {
		t.Run(gone, func(t *testing.T) {
			h := newRelabelHerdr(t, "Old", true)
			saved, err := h.d.Machines()
			if err != nil || len(saved) != 1 {
				t.Fatalf("saved %+v, %v", saved, err)
			}
			h.d.Disconnect()
			h.rename(t, "Renamed")
			if h.pending(t) != "Renamed" {
				t.Fatalf("pending %v", h.relabels(t))
			}
			fresh := saved[0].Machine
			fresh.Nickname, fresh.LocalID, fresh.SyncID = "Fresh", "", ""
			if gone == "removed" {
				if err := h.d.RemoveMachine(saved[0].ID); err != nil {
					t.Fatal(err)
				}
				if p := h.relabels(t); len(p) != 0 {
					t.Fatalf("a removed profile's relabel stayed: %v", p)
				}
				if err := h.d.SaveMachine(fresh, ""); err != nil {
					t.Fatal(err)
				}
			} else {
				h.d.storeMu.Lock()
				err := h.d.store(machineStore{Active: saved[0].ID, Machines: []Machine{fresh}})
				h.d.storeMu.Unlock()
				if err != nil {
					t.Fatal(err)
				}
			}
			h.reconnect(t)
			time.Sleep(300 * time.Millisecond)
			if got := h.updates(); len(got) != 0 {
				t.Fatalf("the fresh profile's connect sent %+v", got)
			}
			h.rename(t, "Again")
			waitFor(t, "the fresh profile's rename sent", func() bool { return len(h.updates()) == 1 && h.pending(t) == "" })
			if p := h.updates()[0]; *p.MachineLabel != "Again" {
				t.Fatalf("sent %+v; want Again", p)
			}
		})
	}
}

// Only a rename of a saved machine leaves a relabel to send, under the
// profile's own id, which an edit that moves the machine to another
// user@host:port keeps, at the profile's new label revision (above the one
// before).
func TestARelabelIsQueuedForARenameUnderItsProfile(t *testing.T) {
	d := newDesk(t.TempDir())
	pending := func() map[string]string {
		t.Helper()
		return pendingRelabels(t, d)
	}
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
	pi := save(Machine{Nickname: "Old", Host: "pi", User: "root", KeyPath: "/k", LocalID: "from-the-page", LabelRev: 9, LabelSent: 3}, "")
	if p := pending(); len(p) != 0 || pi.LocalID != "" || pi.LabelRev != 0 || pi.LabelSent != 0 {
		t.Fatalf("a new machine queued %v, local id %q, label revision %d sent %d", p, pi.LocalID, pi.LabelRev, pi.LabelSent)
	}
	pi.Session = "work"
	pi = save(pi, "root@pi:22")
	if p := pending(); len(p) != 0 || pi.LocalID != "" || pi.LabelRev != 0 {
		t.Fatalf("an edit that renames nothing queued %v, local id %q, label revision %d", p, pi.LocalID, pi.LabelRev)
	}
	pi.Nickname = "New"
	pi = save(pi, "root@pi:22")
	profile, first := pi.LocalID, pi.LabelRev
	pi.User, pi.LocalID, pi.LabelRev, pi.LabelSent = "admin", "another", 1, first
	pi = save(pi, "root@pi:22")
	if p := pending(); len(profile) != 32 || first == 0 || pi.LocalID != profile || pi.LabelRev != first || len(p) != 1 || p[profile] != "New" {
		t.Fatalf("pending %v, local id %q then %q, label revision %d then %d; want New for the profile's own id and revision", p, profile, pi.LocalID, first, pi.LabelRev)
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
