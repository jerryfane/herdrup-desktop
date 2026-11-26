package main

import (
	"encoding/json"
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
// guest.update params sent, in order; while failing is set herdr refuses
// them.
type relabelHerdr struct {
	d       *Desk
	srv     *fakeherdr.Server
	guests  *fakeherdr.Guests
	failing atomic.Bool
	mu      sync.Mutex
	sent    []herdrapi.GuestUpdateParams
}

func newRelabelHerdr(t *testing.T, nickname string, relabel bool) *relabelHerdr {
	t.Helper()
	h := &relabelHerdr{guests: fakeherdr.NewGuests()}
	h.d, h.srv = federatedDeskAs(t, nickname, func(s *fakeherdr.Server) {
		original := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				value, err := original(method, raw)
				if caps, ok := value.(map[string]any)["capabilities"].(map[string]bool); ok && relabel {
					caps["guest_relabel"] = true
				}
				return value, err
			case "guest.update":
				var p herdrapi.GuestUpdateParams
				_ = json.Unmarshal(raw, &p)
				h.mu.Lock()
				h.sent = append(h.sent, p)
				h.mu.Unlock()
				if h.failing.Load() {
					return nil, &fakeherdr.APIError{Code: "guest_store_unavailable", Message: "try again"}
				}
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

// pending is the relabel the desk still has to send for its machine.
func (h *relabelHerdr) pending(t *testing.T) string {
	t.Helper()
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	h.d.storeMu.Lock()
	defer h.d.storeMu.Unlock()
	pending, err := h.d.loadRelabels()
	if err != nil {
		t.Fatal(err)
	}
	return pending[saved[0].ID]
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

// A rename while the previous one's relabel is out keeps its own: the
// earlier relabel taken doesn't forget the newer one, which herdr refused
// here, so it is still to be sent.
func TestARenameDuringARelabelKeepsItsOwn(t *testing.T) {
	h := newRelabelHerdr(t, "Old", true)
	h.rename(t, "First")
	waitFor(t, "the first relabel out", func() bool { return len(h.updates()) == 1 })
	// The fixture answers a guest.update 350ms after it arrives.
	h.failing.Store(true)
	h.rename(t, "Second")
	waitFor(t, "the second relabel tried", func() bool { return len(h.updates()) == 2 })
	time.Sleep(600 * time.Millisecond)
	if pending := h.pending(t); pending != "Second" {
		t.Fatalf("pending %q once the first relabel was taken, want Second", pending)
	}
}

// Only a rename of a saved machine queues a relabel, under the machine's id;
// an edit that moves the machine to another id (its user) takes a relabel
// not yet sent along.
func TestARelabelIsQueuedForARenameAndFollowsTheMachine(t *testing.T) {
	d := newDesk(t.TempDir())
	pending := func() map[string]string {
		t.Helper()
		d.storeMu.Lock()
		defer d.storeMu.Unlock()
		p, err := d.loadRelabels()
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	save := func(m Machine, replacing string) {
		t.Helper()
		if err := d.SaveMachine(m, replacing); err != nil {
			t.Fatal(err)
		}
	}
	pi := Machine{Nickname: "Old", Host: "pi", User: "root", KeyPath: "/k"}
	save(pi, "")
	if p := pending(); len(p) != 0 {
		t.Fatalf("a new machine queued %v", p)
	}
	pi.Session = "work"
	save(pi, "root@pi:22")
	if p := pending(); len(p) != 0 {
		t.Fatalf("an edit that renames nothing queued %v", p)
	}
	pi.Nickname = "New"
	save(pi, "root@pi:22")
	pi.User = "admin"
	save(pi, "root@pi:22")
	if p := pending(); len(p) != 1 || p["admin@pi:22"] != "New" {
		t.Fatalf("pending %v, want New for admin@pi:22", p)
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
