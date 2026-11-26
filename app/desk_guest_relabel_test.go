package main

import (
	"encoding/json"
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
// holds the next guest.update until it carries that reply's outcome.
type relabelHerdr struct {
	d       *Desk
	srv     *fakeherdr.Server
	guests  *fakeherdr.Guests
	failing atomic.Bool
	held    atomic.Pointer[chan *fakeherdr.APIError]
	done    atomic.Int32
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
					h.done.Add(1)
					return nil, &fakeherdr.APIError{Code: "guest_store_unavailable", Message: "try again"}
				}
				if gate := h.held.Swap(nil); gate != nil {
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

// pending is the relabel the desk still has to send for its one profile.
func (h *relabelHerdr) pending(t *testing.T) string {
	t.Helper()
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	return h.relabels(t)[saved[0].LocalID]
}

// relabels are every relabel the desk still has to send, by profile, as the
// file holds them.
func (h *relabelHerdr) relabels(t *testing.T) map[string]string {
	t.Helper()
	h.d.storeMu.Lock()
	defer h.d.storeMu.Unlock()
	pending := map[string]string{}
	data, err := os.ReadFile(h.d.guestRelabelsPath())
	if os.IsNotExist(err) {
		return pending
	}
	if err == nil {
		err = json.Unmarshal(data, &pending)
	}
	if err != nil {
		t.Fatal(err)
	}
	return pending
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

// #556, #561, #563: a rename while the previous one's relabel is out is
// queued behind it, never sent beside it, and goes once that one is done.
// Taken or refused (an answer), it goes at once on the live connection, so
// the newest name is the last one herdr takes and nothing waits. Unanswered
// (the relabel's context ended while herdr held it; herdr may still apply it,
// and does here, late), it doesn't go on that connection: it waits for the
// next one, which sends it. First is held on a gate that carries its outcome,
// and its context is cancelled only once Second is queued: no timing.
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
				// The relabel's context is the watch's: ending it (as a session
				// switch does) leaves First unanswered on the same connection.
				h.d.mu.Lock()
				restart := h.d.link.restart
				h.d.mu.Unlock()
				restart()
				h.idle(t, "the sender to give up on the unanswered relabel")
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

// Entries of no saved profile, such as the address-keyed format (#554,
// before #557), are retired: never matched to the profile at that address,
// so nothing is sent, and written out of the file with the next write (here
// the next rename's, which leaves the profile's own entry alone in it). The
// sender runs here, synchronously, on the live connection.
func TestAnAddressKeyedRelabelIsRetired(t *testing.T) {
	h := newRelabelHerdr(t, "Old", true)
	h.rename(t, "Named")
	waitFor(t, "the rename taken", func() bool { return h.done.Load() == 1 && h.pending(t) == "" })
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || saved[0].LocalID == "" {
		t.Fatalf("saved %+v, %v", saved, err)
	}
	h.d.storeMu.Lock()
	err = writeFileAtomic(h.d.guestRelabelsPath(), []byte(`{"`+saved[0].ID+`":"Old name"}`))
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	h.idle(t, "the rename's sender to end")
	h.d.relabelGuests(h.live())
	if n := len(h.updates()); n != 1 {
		t.Fatalf("%d guest.update calls; the address-keyed entry must send none", n)
	}
	h.failing.Store(true) // the next rename stays queued, so the file shows it
	h.rename(t, "Renamed")
	h.idle(t, "the next rename's sender to end")
	if p := h.relabels(t); len(p) != 1 || p[saved[0].LocalID] != "Renamed" {
		t.Fatalf("relabels %v after the next rename; want the address-keyed entry written out, the profile's alone", p)
	}
}

// #563: a retired entry whose removal can't be written (the atomic write's
// temp file can't be opened) doesn't hold back the current profile's relabel
// beside it: it is sent all the same, and the failure is only logged.
func TestARelabelBesideALegacyEntryGoesWhenTheCleanupCantBeWritten(t *testing.T) {
	h := newRelabelHerdr(t, "Old", true)
	h.failing.Store(true)
	h.rename(t, "Named")
	waitFor(t, "the rename refused", func() bool { return h.done.Load() == 1 })
	saved, err := h.d.Machines()
	if err != nil || len(saved) != 1 || h.pending(t) != "Named" {
		t.Fatalf("saved %+v, %v, pending %v", saved, err, h.relabels(t))
	}
	h.d.storeMu.Lock()
	err = writeFileAtomic(h.d.guestRelabelsPath(), []byte(`{"`+saved[0].LocalID+`":"Named","`+saved[0].ID+`":"Old name"}`))
	h.d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	blocked := h.d.guestRelabelsPath() + ".tmp"
	if err := os.Mkdir(blocked, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(blocked) })
	h.failing.Store(false)
	h.idle(t, "the rename's sender to end")
	h.d.relabelGuests(h.live())
	if n, got := len(h.updates()), h.labels(t); n != 2 || *h.updates()[1].MachineLabel != "Named" || !slices.Equal(got, everywhere("Named")) {
		t.Fatalf("%d guest.update calls, shares named %q; want Named sent despite the cleanup", n, got)
	}
}

// #557: a relabel belongs to the saved profile that was renamed. It goes with
// the profile, whether removed here or replaced (as account sync replaces
// one), and a profile saved again at the same user@host:port inherits nothing:
// its connect sends no guest.update.
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
		})
	}
}

// Only a rename of a saved machine queues a relabel, under the profile's own
// id, which an edit that moves the machine to another user@host:port keeps.
func TestARelabelIsQueuedForARenameUnderItsProfile(t *testing.T) {
	d := newDesk(t.TempDir())
	pending := func() map[string]string {
		t.Helper()
		d.storeMu.Lock()
		defer d.storeMu.Unlock()
		st, err := d.load()
		var p map[string]string
		if err == nil {
			p, _, err = d.loadRelabels(st)
		}
		if err != nil {
			t.Fatal(err)
		}
		return p
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
	pi := save(Machine{Nickname: "Old", Host: "pi", User: "root", KeyPath: "/k", LocalID: "from-the-page"}, "")
	if p := pending(); len(p) != 0 || pi.LocalID != "" {
		t.Fatalf("a new machine queued %v, local id %q", p, pi.LocalID)
	}
	pi.Session = "work"
	pi = save(pi, "root@pi:22")
	if p := pending(); len(p) != 0 || pi.LocalID != "" {
		t.Fatalf("an edit that renames nothing queued %v, local id %q", p, pi.LocalID)
	}
	pi.Nickname = "New"
	pi = save(pi, "root@pi:22")
	profile := pi.LocalID
	pi.User, pi.LocalID = "admin", "another"
	pi = save(pi, "root@pi:22")
	if p := pending(); len(profile) != 32 || pi.LocalID != profile || len(p) != 1 || p[profile] != "New" {
		t.Fatalf("pending %v, local id %q then %q; want New for the profile's own id", p, profile, pi.LocalID)
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
