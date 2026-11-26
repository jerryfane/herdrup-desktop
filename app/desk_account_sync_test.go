package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jerryfane/herdrup-desktop/internal/account"
)

// syncWorker is the account service's sync as AccountService src/sync.ts
// keeps it: one revision per write, last write wins, tombstones for deletes,
// the hosts, prompts and shares allowlists and field rules (a bad change
// refuses the whole push, 400), base_rev (a stale change is not written and
// comes back in conflicts) and the account's caps (403 quota, the push
// rolled back). It also gives a guest share's statements (/v1/statements),
// "stmt.<account>.<host>", for 10 minutes.
type syncWorker struct {
	mu      sync.Mutex
	rev     int64
	items   map[string]account.Item
	n       int
	account string // "acct" when empty
	// failPush answers the next pushes 503 (the service down mid-sync).
	failPush bool
	// invalidNextPush answers the next push 400 invalid_item, as the
	// service refuses a batch with one change it won't store: none of it is
	// written.
	invalidNextPush bool
	// dropReadback answers the first pull after the next push it applies
	// 503: the push's readback lost; failPull is that pull owed.
	dropReadback, failPull bool
	// onPull, when set, runs once inside the next pull, before it answers.
	onPull func()
	// onPush, when set, runs once inside the next push, before it is applied.
	onPush func()
	// pushes counts the pushes the service took; posts every push asked,
	// taken or not.
	pushes, posts int
	// rateLimit, when set, is the most pushes asked in one window
	// (windowPosts; a test starts the next by zeroing it): more get 429,
	// as the service's 30 a minute.
	rateLimit, windowPosts int
	// afterPush, when set, runs once after the next push is applied and
	// before it is answered.
	afterPush func()
	// pageSize, when set, is the most changes one pull page holds; a page
	// with more after it carries a cursor (the last change's rev).
	pageSize int
	// onNextPage, when set, runs once inside the next pull of a later page
	// (one with a cursor), before it answers.
	onNextPage func()
	// losePush applies the next push and then answers it 503, as if the
	// answer was lost on its way.
	losePush bool
	// muteApplied applies the next push and answers it without its applied
	// list: an answer that doesn't say what became of the changes.
	muteApplied bool
	// stall, while set, holds every pull until it is closed or the request
	// ends; stalled hears of each held pull.
	stall, stalled chan struct{}
	// quotaBytes, when set, is the account's storage quota in prompt-body
	// bytes, and maxItems its cap on live items: a push past either is
	// refused whole (403 quota).
	quotaBytes, maxItems int
	// floor is the highest revision whose tombstones were pruned (sync.ts
	// sync_floor): a pull from below it is told to start over (410).
	floor int64
	// asSecond counts requests made with the second account's bearer
	// (acct-2, signed in by /v1/auth/handoff).
	asSecond int
	// unauthorizeNextPush answers the next push 401 (an access token that
	// stopped working), as the service does; onRefresh, when set, runs
	// once inside the next credential refresh.
	unauthorizeNextPush bool
	onRefresh           func()
	// failNextRefresh answers the next credential refresh 503.
	failNextRefresh bool
	// maxPushBytes, when set, is a push body limit below the service's
	// 256 KiB.
	maxPushBytes int
	// serverAhead sets the service's clock (its answers' now_ms) this far
	// from the device's; noNow leaves now_ms out (a service without
	// themartianapp/herdrup#826). A push past its not_after is refused
	// (409 expired) before anything is written.
	serverAhead time.Duration
	noNow       bool
	// breakNextRefusal, when set, answers the next push with that status
	// and cuts the answer off inside its body; cutRefusals cuts every
	// refusal so.
	breakNextRefusal int
	cutRefusals      bool
	// handoffAccount is the account a sign-in redeemed here opens (acct-2
	// when ""; "acct" is a sign-in again to the first one).
	handoffAccount string
	// holdNext, when set, makes the next push a late one: the worker keeps
	// it unapplied (held, oldest first), closes holdNext once it has it,
	// and answers nothing until the request ends; landHeld applies it
	// later.
	holdNext chan struct{}
	held     [][]byte
}

// startOver begins the account's history again, as after a restored
// database. w.mu must be held (as in a hook).
func (w *syncWorker) startOver() {
	w.restoreTo(0)
}

// restoreTo takes the account back to revision rev, as after a database
// restored from then: what was written after it is gone. w.mu must be held
// (as in a hook).
func (w *syncWorker) restoreTo(rev int64) {
	for id, it := range w.items {
		if it.Rev > rev {
			delete(w.items, id)
		}
	}
	w.rev = rev
}

// holdNextPush makes the next push a late one (holdNext); the channel
// closes once the worker has it.
func (w *syncWorker) holdNextPush() <-chan struct{} {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.holdNext = make(chan struct{})
	return w.holdNext
}

// landHeld applies the oldest push holdNextPush kept, as a write that
// reaches the service late.
func (w *syncWorker) landHeld() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.landHeldLocked()
}

// landHeldLocked is landHeld with w.mu held (as in a hook). A push past
// its not_after is refused, unwritten.
func (w *syncWorker) landHeldLocked() {
	var body struct {
		Changes  []pushChange
		NotAfter int64 `json:"not_after"`
	}
	_ = json.Unmarshal(w.held[0], &body)
	if !w.expired(body.NotAfter) {
		w.write(body.Changes)
	}
	w.held = w.held[1:]
}

// nowMs is the service's clock (serverAhead). w.mu must be held.
func (w *syncWorker) nowMs() int64 { return time.Now().Add(w.serverAhead).UnixMilli() }

// expired is whether a push with notAfter (0: none) is past it, as the
// service judges inside the write. w.mu must be held.
func (w *syncWorker) expired(notAfter int64) bool { return notAfter != 0 && w.nowMs() > notAfter }

// withNow adds the service's clock as of now (read before the answer's
// rows) to a sync answer, unless noNow. w.mu must be held.
func (w *syncWorker) withNow(answer map[string]any, now int64) map[string]any {
	if !w.noNow {
		answer["now_ms"] = now
	}
	return answer
}

// cutAnswer answers r with status and an error body cut off midway.
func cutAnswer(rw http.ResponseWriter, r *http.Request, status int) {
	_, _ = io.Copy(io.Discard, r.Body)
	conn, buf, err := rw.(http.Hijacker).Hijack()
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(buf, "HTTP/1.1 %d Refused\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"err", status)
	_ = buf.Flush()
	_ = conn.Close()
}

// pushChange is one change of a push as the worker reads it.
type pushChange struct {
	Collection string          `json:"collection"`
	ID         string          `json:"id"`
	BaseRev    *int64          `json:"base_rev"`
	Deleted    bool            `json:"deleted"`
	Body       json.RawMessage `json:"body"`
}

// write applies changes as sync.ts does: deletes first; one with base_rev
// only while its item is still at that revision (0: no item, not even a
// tombstone); a delete only of an item held; an unchanged item is not
// written again. Past a cap nothing is written (ok false). Each change is
// applied when the account now holds what it asked for, otherwise it is a
// conflict with the account's copy. w.mu must be held.
func (w *syncWorker) write(changes []pushChange) (applied, conflicts []map[string]any, ok bool) {
	next, rev := maps.Clone(w.items), w.rev
	ordered := slices.Concat(
		slices.DeleteFunc(slices.Clone(changes), func(c pushChange) bool { return !c.Deleted }),
		slices.DeleteFunc(slices.Clone(changes), func(c pushChange) bool { return c.Deleted }))
	for _, c := range ordered {
		held, exists := next[c.ID]
		if c.BaseRev != nil && *c.BaseRev != held.Rev {
			continue
		}
		if c.Deleted && !exists || exists && held.Deleted == c.Deleted && bytes.Equal(held.Body, c.Body) {
			continue
		}
		rev++
		it := account.Item{Collection: c.Collection, ID: c.ID, Rev: rev, UpdatedMs: w.nowMs(), Deleted: c.Deleted}
		if !c.Deleted {
			it.Body = c.Body
		}
		next[c.ID] = it
	}
	prompts, items, stored := 0, 0, 0
	for _, it := range next {
		if it.Deleted {
			continue
		}
		items++
		if it.Collection == "prompts" {
			prompts++
			stored += len(it.Body)
		}
	}
	if prompts > account.PromptsCap || w.maxItems > 0 && items > w.maxItems || w.quotaBytes > 0 && stored > w.quotaBytes {
		return nil, nil, false
	}
	w.items, w.rev = next, rev
	for _, c := range changes {
		it, exists := next[c.ID]
		if c.Deleted && (!exists || it.Deleted) || !c.Deleted && exists && !it.Deleted && bytes.Equal(it.Body, c.Body) {
			applied = append(applied, map[string]any{"collection": c.Collection, "id": c.ID, "rev": it.Rev})
			continue
		}
		var server any
		if exists {
			server = it
		}
		conflicts = append(conflicts, map[string]any{"collection": c.Collection, "id": c.ID, "server": server})
	}
	return applied, conflicts, true
}

// stallPulls holds pulls from now until release (at the latest, when the
// test ends); stalled hears of each held pull.
func (w *syncWorker) stallPulls(t *testing.T) (stalled <-chan struct{}, release func()) {
	w.mu.Lock()
	w.stall, w.stalled = make(chan struct{}), make(chan struct{}, 8)
	stall, out := w.stall, w.stalled
	w.mu.Unlock()
	var once sync.Once
	release = func() {
		once.Do(func() {
			w.mu.Lock()
			w.stall = nil
			w.mu.Unlock()
			close(stall)
		})
	}
	t.Cleanup(release)
	return out, release
}

// tombstone deletes the item with id as another device would. w.mu must be
// held (as in a hook).
func (w *syncWorker) tombstone(id string) {
	w.rev++
	it := w.items[id]
	w.items[id] = account.Item{Collection: it.Collection, ID: id, Rev: w.rev, Deleted: true}
}

// prune drops item id's tombstone and raises the floor past it, as the
// service's hourly prune does (sync.ts pruneTombstones). w.mu must be held.
func (w *syncWorker) prune(id string) {
	w.floor = max(w.floor, w.items[id].Rev)
	delete(w.items, id)
}

func (w *syncWorker) live() map[string]account.Item {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := map[string]account.Item{}
	for id, it := range w.items {
		if !it.Deleted {
			out[id] = it
		}
	}
	return out
}

func (w *syncWorker) serve(rw http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/v1/sync" && r.Method == http.MethodGet {
		w.mu.Lock()
		stall, stalled := w.stall, w.stalled
		w.mu.Unlock()
		if stall != nil {
			select {
			case stalled <- struct{}{}:
			default:
			}
			select {
			case <-stall:
			case <-r.Context().Done():
			}
			return
		}
	}
	if r.URL.Path == "/v1/sync" && r.Method == http.MethodPost {
		w.mu.Lock()
		hold := w.holdNext
		w.holdNext = nil
		w.mu.Unlock()
		if hold != nil {
			raw, _ := io.ReadAll(r.Body)
			w.mu.Lock()
			w.held = append(w.held, raw)
			w.mu.Unlock()
			close(hold)
			<-r.Context().Done()
			return
		}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	reply := func(status int, v any) {
		if w.cutRefusals && status >= 400 {
			cutAnswer(rw, r, status)
			return
		}
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(status)
		_ = json.NewEncoder(rw).Encode(v)
	}
	// A request carrying the second account's bearer (signed in by the
	// handoff below) is counted: this account's data never goes to it.
	if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer a1."+fmt.Sprintf("%022d", 2)+".") {
		w.asSecond++
	}
	switch {
	case r.URL.Path == "/v1/auth/refresh":
		w.n++
		if hook := w.onRefresh; hook != nil {
			w.onRefresh = nil
			hook()
		}
		if w.failNextRefresh {
			w.failNextRefresh = false
			reply(503, map[string]string{"error": "unavailable"})
			return
		}
		acct, marker := w.account, 1
		if acct == "" {
			acct = "acct"
		}
		var body struct {
			Refresh string `json:"refresh_token"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.HasPrefix(body.Refresh, "r1."+fmt.Sprintf("%022d", 2)+".") {
			acct, marker = "acct-2", 2
		}
		reply(200, map[string]any{"account_id": acct, "access_token": fmt.Sprintf("a1.%022d.%043d", marker, w.n), "access_expires_in": 3600,
			"refresh_token": fmt.Sprintf("r1.%022d.%043d", marker, w.n), "refresh_expires_in": 1})
	case r.URL.Path == "/v1/auth/handoff":
		// A sign-in redeemed here: to another account (acct-2), unless
		// handoffAccount says this one again.
		w.n++
		acct, marker := "acct-2", 2
		if w.handoffAccount == "acct" {
			acct, marker = "acct", 1
		}
		reply(200, map[string]any{"account_id": acct, "access_token": fmt.Sprintf("a1.%022d.%043d", marker, w.n), "access_expires_in": 3600,
			"refresh_token": fmt.Sprintf("r1.%022d.%043d", marker, w.n), "refresh_expires_in": 1})
	case r.URL.Path == "/v1/statements":
		var body struct {
			Hosts []string `json:"hosts"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		acct := cmp.Or(w.account, "acct")
		if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer a1."+fmt.Sprintf("%022d", 2)+".") {
			acct = "acct-2"
		}
		statements := []any{}
		for _, h := range body.Hosts {
			statements = append(statements, map[string]any{"host": h, "jws": "stmt." + acct + "." + h})
		}
		reply(200, map[string]any{"statements": statements, "exp": 600})
	case r.URL.Path == "/v1/sync" && r.Method == http.MethodGet && w.failPull:
		w.failPull = false
		reply(503, map[string]string{"error": "unavailable"})
	case r.URL.Path == "/v1/sync" && r.Method == http.MethodGet:
		// sync.ts reads now_ms before the snapshot it pages.
		now := w.nowMs()
		if hook := w.onPull; hook != nil {
			w.onPull = nil
			hook()
		}
		since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
		if cursor := r.URL.Query().Get("cursor"); cursor != "" {
			if hook := w.onNextPage; hook != nil {
				w.onNextPage = nil
				hook()
			}
			since, _ = strconv.ParseInt(cursor, 10, 64)
		}
		if since > w.rev || since > 0 && since < w.floor {
			// sync.ts handlePull: a revision past the account's is another
			// history (a restored database), and one below the floor may
			// have missed a pruned delete: start over. A client at the floor
			// or above gets an incremental pull.
			reply(410, map[string]string{"error": "reset_required"})
			return
		}
		var changes []account.Item
		for _, it := range w.items {
			if it.Rev > since {
				changes = append(changes, it)
			}
		}
		slices.SortFunc(changes, func(a, b account.Item) int { return int(a.Rev - b.Rev) })
		answer := map[string]any{"rev": w.rev, "more": false}
		if w.pageSize > 0 && len(changes) > w.pageSize {
			changes = changes[:w.pageSize]
			answer["more"], answer["cursor"] = true, strconv.FormatInt(changes[len(changes)-1].Rev, 10)
		}
		answer["changes"] = changes
		reply(200, w.withNow(answer, now))
	case r.URL.Path == "/v1/sync" && r.Method == http.MethodPost:
		w.posts++
		if status := w.breakNextRefusal; status != 0 {
			w.breakNextRefusal = 0
			cutAnswer(rw, r, status)
			return
		}
		if w.invalidNextPush {
			w.invalidNextPush = false
			reply(400, map[string]any{"error": "invalid_item", "index": 0, "field": "body"})
			return
		}
		if w.unauthorizeNextPush {
			w.unauthorizeNextPush = false
			reply(401, map[string]string{"error": "invalid_token"})
			return
		}
		if w.windowPosts++; w.rateLimit > 0 && w.windowPosts > w.rateLimit {
			reply(429, map[string]string{"error": "rate_limited"})
			return
		}
		var body struct {
			Changes  []pushChange
			NotAfter int64 `json:"not_after"`
		}
		raw, _ := io.ReadAll(r.Body)
		// sync.ts MAX_SYNC_BODY_BYTES and MAX_CHANGES: a bigger push is refused whole.
		limit := 256 * 1024
		if w.maxPushBytes > 0 {
			limit = w.maxPushBytes
		}
		if len(raw) > limit {
			reply(413, map[string]string{"error": "too_large"})
			return
		}
		_ = json.Unmarshal(raw, &body)
		if len(body.Changes) > 100 {
			reply(413, map[string]string{"error": "too_large"})
			return
		}
		if w.failPush {
			reply(503, map[string]string{"error": "unavailable"})
			return
		}
		if hook := w.onPush; hook != nil {
			w.onPush = nil
			hook()
		}
		ids := map[string]bool{}
		for _, c := range body.Changes {
			// sync.ts: one change per collection and id in a push.
			if ids[c.Collection+"/"+c.ID] {
				reply(400, map[string]string{"error": "invalid_item"})
				return
			}
			ids[c.Collection+"/"+c.ID] = true
		}
		for _, c := range body.Changes {
			if c.Body == nil {
				continue
			}
			if !validSyncBody(c.Collection, c.Body) {
				reply(400, map[string]string{"error": "invalid_item"})
				return
			}
			// MAX_ITEM_BYTES, of the body as JSON.stringify writes it.
			var fields map[string]any
			_ = json.Unmarshal(c.Body, &fields)
			var stored bytes.Buffer
			enc := json.NewEncoder(&stored)
			enc.SetEscapeHTML(false)
			_ = enc.Encode(fields)
			if stored.Len()-1 > 16*1024 {
				reply(413, map[string]string{"error": "too_large"})
				return
			}
		}
		// The deadline is checked inside the write itself (#826).
		if w.expired(body.NotAfter) {
			reply(409, map[string]string{"error": "expired"})
			return
		}
		applied, conflicts, ok := w.write(body.Changes)
		if !ok {
			reply(403, map[string]string{"error": "quota"})
			return
		}
		w.pushes++
		if hook := w.afterPush; hook != nil {
			w.afterPush = nil
			hook()
		}
		if w.losePush {
			w.losePush = false
			reply(503, map[string]string{"error": "unavailable"})
			return
		}
		if w.muteApplied {
			w.muteApplied = false
			applied = nil
		}
		w.failPull, w.dropReadback = w.dropReadback, false
		reply(200, w.withNow(map[string]any{"rev": w.rev, "applied": applied, "conflicts": conflicts}, w.nowMs()))
	default:
		reply(404, map[string]string{"error": "not_found"})
	}
}

// validSyncBody is sync.ts's check of one body: only the collection's
// allowlisted fields, a prompt's text present and ≤8 KB, its title ≤128
// code points and its order a number.
func validSyncBody(collection string, raw json.RawMessage) bool {
	var fields map[string]any
	if json.Unmarshal(raw, &fields) != nil {
		return false
	}
	switch collection {
	case "hosts":
		for k := range fields {
			switch k {
			case "nickname", "host", "port", "username", "auth_kind", "label":
			default:
				return false
			}
		}
		return true
	case "prompts":
		for k, v := range fields {
			switch k {
			case "title":
				if s, ok := v.(string); !ok || len([]rune(s)) > 128 {
					return false
				}
			case "text":
				if s, ok := v.(string); !ok || s == "" || len(s) > 8192 {
					return false
				}
			case "order":
				if _, ok := v.(float64); !ok {
					return false
				}
			default:
				return false
			}
		}
		_, hasText := fields["text"]
		return hasText
	case "shares":
		// sync.ts SCHEMAS.shares (themartianapp/herdrup AccountService
		// src/sync.ts:219-235): the allowlist, the four ids present, and
		// the labels as text() takes them (:90-97): well formed, no control
		// character, at most 128, 64 and 128 code points.
		labels := map[string]int{"agent_name": 128, "owner_name": 64, "machine_label": 128}
		for k, v := range fields {
			switch k {
			case "relay", "host_id", "node_pub", "guest_id", "agent_name", "owner_name", "machine_label":
				s, ok := v.(string)
				if !ok {
					return false
				}
				if max, label := labels[k]; label && (!utf8.ValidString(s) || utf8.RuneCountInString(s) > max || strings.ContainsFunc(s, unicode.IsControl)) {
					return false
				}
			case "share_gram":
				if _, ok := v.(bool); !ok {
					return false
				}
			default:
				return false
			}
		}
		for _, k := range []string{"relay", "host_id", "node_pub", "guest_id"} {
			if s, _ := fields[k].(string); s == "" {
				return false
			}
		}
		return true
	}
	return false
}

type signedInStore struct{ raw []byte }

func (s *signedInStore) Get() ([]byte, error) { return s.raw, nil }
func (s *signedInStore) Set(v []byte) error   { s.raw = v; return nil }
func (s *signedInStore) Delete() error        { s.raw = nil; return nil }

// device is one desktop app signed in to the shared fake account.
func device(t *testing.T, srv *httptest.Server) *Desk {
	t.Helper()
	d := newDesk(t.TempDir())
	signInTo(d, srv, "acct")
	d.accountStore = account.NewSecretsStore(noSecrets{}, errors.New("not found"))
	return d
}

// signInTo points d at the account srv serves.
func signInTo(d *Desk, srv *httptest.Server, acct string) {
	raw, _ := json.Marshal(map[string]string{"refresh_token": fmt.Sprintf("r1.%022d.%043d", 1, 0), "account_id": acct})
	d.account = account.New(srv.URL, "linux", &signedInStore{raw: raw}, srv.Client())
}

func quietSync(t *testing.T) {
	previous, background, prompts := publishSyncedMachines, backgroundMachineSync, publishSavedPrompts
	publishSyncedMachines, backgroundMachineSync, publishSavedPrompts = func([]SyncedMachine) {}, false, func([]SavedPrompt) {}
	t.Cleanup(func() {
		publishSyncedMachines, backgroundMachineSync, publishSavedPrompts = previous, background, prompts
	})
}

func syncIDs(t *testing.T, d *Desk) map[string]string {
	t.Helper()
	ms, err := d.Machines()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, m := range ms {
		out[m.ID] = m.SyncID
	}
	return out
}

// Two devices with one account: a machine saved on both syncs once, under
// the first pusher's id; a machine saved on one shows on the other to pair;
// an edit and a delete reach the other device; and no key path or session
// ever reaches the service.
func TestMachinesSyncAcrossTwoDevices(t *testing.T) {
	w := &syncWorker{items: map[string]account.Item{}}
	srv := httptest.NewServer(http.HandlerFunc(w.serve))
	defer srv.Close()
	ctx := context.Background()
	quietSync(t)

	mac, linux := device(t, srv), device(t, srv)
	// SaveMachine syncs in the background; this test syncs by hand, after.
	save := func(d *Desk, m Machine, replacing string) {
		t.Helper()
		if err := d.SaveMachine(m, replacing); err != nil {
			t.Fatal(err)
		}
	}
	save(mac, Machine{Nickname: "pi", Host: "Pi.local", User: "root", KeyPath: "/home/j/.ssh/id_ed25519", Session: "work"}, "")
	save(mac, Machine{Host: "studio", User: "jerry", Port: 2222}, "")
	save(linux, Machine{Host: "pi.local.", User: "root", KeyPath: "/root/.ssh/k"}, "")
	if err := linux.SelectMachine("root@pi.local.:22", ""); err == nil {
		linux.Disconnect()
	}
	sync := func(d *Desk) {
		t.Helper()
		if err := d.SyncMachines(ctx); err != nil {
			t.Fatal(err)
		}
	}
	sync(mac)
	sync(linux)
	macIDs, linuxIDs := syncIDs(t, mac), syncIDs(t, linux)
	pi := macIDs["root@Pi.local:22"]
	// Linux takes the Mac's copy (nickname, host spelling): same machine, one id.
	if pi == "" || linuxIDs["root@Pi.local:22"] != pi || len(linuxIDs) != 1 {
		t.Fatalf("the same machine on two devices: mac %v linux %v; want one id", macIDs, linuxIDs)
	}
	w.mu.Lock()
	live := 0
	for _, it := range w.items {
		if !it.Deleted {
			live++
		}
		if strings.Contains(string(it.Body), "ssh") || strings.Contains(string(it.Body), "work") {
			t.Fatalf("a key path or session reached the service: %s", it.Body)
		}
	}
	w.mu.Unlock()
	if live != 2 {
		t.Fatalf("%d machines in the account; want 2 (pi once, studio)", live)
	}
	// Linux's active machine took the Mac's spelling: Active follows it.
	if m, _ := linux.Machine(); m == nil || machineID(*m) != "root@Pi.local:22" {
		t.Fatalf("linux's active machine after the rename: %+v", m)
	}
	unsaved, err := linux.SyncedMachines()
	if err != nil || len(unsaved) != 1 || unsaved[0].Host != "studio" || unsaved[0].Port != 2222 || unsaved[0].Key {
		t.Fatalf("linux's machines to pair: %+v, %v", unsaved, err)
	}

	// An edit on the Mac reaches Linux; Linux keeps its own key path.
	save(mac, Machine{Nickname: "Raspberry", Host: "Pi.local", User: "root", KeyPath: "/home/j/.ssh/id_ed25519"}, "root@Pi.local:22")
	sync(mac)
	sync(linux)
	ms, _ := linux.Machines()
	if ms[0].Nickname != "Raspberry" || ms[0].KeyPath != "/root/.ssh/k" || ms[0].ID != "root@Pi.local:22" {
		t.Fatalf("linux after the mac's edit: %+v", ms[0].Machine)
	}

	// A delete on Linux reaches the Mac.
	if err := linux.RemoveMachine(ms[0].ID); err != nil {
		t.Fatal(err)
	}
	sync(linux)
	sync(mac)
	if _, ok := syncIDs(t, mac)["root@Pi.local:22"]; ok {
		t.Fatalf("the mac still has the machine linux deleted: %v", syncIDs(t, mac))
	}
	if raw, _ := os.ReadFile(linux.syncStatePath()); strings.Contains(string(raw), `"deletes"`) {
		t.Fatalf("the pushed delete is still pending: %s", raw)
	}
}

func newWorker(t *testing.T, acct string) (*syncWorker, *httptest.Server) {
	w := &syncWorker{items: map[string]account.Item{}, account: acct}
	srv := httptest.NewServer(http.HandlerFunc(w.serve))
	t.Cleanup(srv.Close)
	return w, srv
}

// #257 review P1: a first push the service refused keeps the machines, and
// the next sync pushes them under the same ids.
func TestARefusedFirstPushLosesNoMachine(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a refused push reported success")
	}
	first := syncIDs(t, mac)["root@pi:22"]
	w.mu.Lock()
	w.failPush = false
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	ids := syncIDs(t, mac)
	if ids["root@pi:22"] == "" || ids["root@pi:22"] != first {
		t.Fatalf("after the retry: %v (first id %q); want the machine kept under its id", ids, first)
	}
	if live := w.live(); len(live) != 1 || live[first].ID != first {
		t.Fatalf("account holds %v; want the machine once under %s", live, first)
	}
}

// The host home's avatar needs attention while the signed-in account's
// newest sync failed: a failed push sets it and tells the page, the next
// good sync clears it, and another account never inherits it.
func TestAFailedSyncNeedsAttentionUntilTheNextGoodOne(t *testing.T) {
	quietSync(t)
	var published []AccountState
	previous := publishAccount
	publishAccount = func(s AccountState) { published = append(published, s) }
	t.Cleanup(func() { publishAccount = previous })
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(context.Background()); err != nil || mac.AccountState().SyncFailed {
		t.Fatalf("a good sync: %v, %+v", err, mac.AccountState())
	}
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	if err := mac.SaveMachine(Machine{Host: "nas", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a refused push reported success")
	}
	if !mac.AccountState().SyncFailed || len(published) != 1 || !published[0].SyncFailed {
		t.Fatalf("after a failed sync: %+v, published %+v", mac.AccountState(), published)
	}
	signInTo(mac, srv, "other")
	if mac.AccountState().SyncFailed {
		t.Fatal("another account inherited the failed sync")
	}
	signInTo(mac, srv, "acct")
	w.mu.Lock()
	w.failPush = false
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	if mac.AccountState().SyncFailed || len(published) != 2 || published[1].SyncFailed {
		t.Fatalf("after the next good sync: %+v, published %+v", mac.AccountState(), published)
	}
}

// #263: each account keeps its own result. A fails, B fails, and back on A
// it still needs attention; B's later good sync clears only B.
func TestEachAccountKeepsItsOwnSyncFailure(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	fail := func(on bool) { w.mu.Lock(); w.failPush = on; w.mu.Unlock() }
	as := func(acct string) { w.mu.Lock(); w.account = acct; w.mu.Unlock(); signInTo(mac, srv, acct) }
	fail(true)
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("A: a refused push reported success")
	}
	as("other")
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("B: a refused push reported success")
	}
	as("acct")
	if !mac.AccountState().SyncFailed {
		t.Fatal("back on A, its failure was lost to B's")
	}
	fail(false)
	as("other")
	if err := mac.SyncMachines(context.Background()); err != nil || mac.AccountState().SyncFailed {
		t.Fatalf("B's good sync: %v, %+v", err, mac.AccountState())
	}
	as("acct")
	if !mac.AccountState().SyncFailed {
		t.Fatal("B's good sync cleared A's failure")
	}
}

// #262: a sync the session leaves midway (here a sign-out during its pull)
// neither fails nor succeeds, so A's earlier failure stands.
func TestAnAbandonedSyncLeavesTheLastResult(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a refused push reported success")
	}
	var signedOut sync.WaitGroup
	signedOut.Add(1)
	client := mac.account
	w.mu.Lock()
	w.failPush = false
	w.onPull = func() {
		go func() { defer signedOut.Done(); _ = client.SignOut(context.Background()) }()
		for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(5 * time.Millisecond) {
			if s, _ := client.Current(); s == nil {
				return
			}
		}
	}
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err != nil {
		t.Fatalf("a sync the session left: %v", err)
	}
	signedOut.Wait()
	signInTo(mac, srv, "acct")
	if !mac.AccountState().SyncFailed {
		t.Fatal("an abandoned sync cleared A's failure")
	}
}

// #257 review P2: changing a machine's host or user on either device is an
// edit of the same item, not a delete and a new machine.
func TestIdentityChangingRenamesFollowTheItem(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	ctx := context.Background()
	mac, linux := device(t, srv), device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	for _, d := range []*Desk{mac, linux} {
		if err := d.SyncMachines(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err := linux.SaveMachine(Machine{Host: "10.0.0.5", User: "root", KeyPath: "/k2"}, ""); err != nil { // to pair: saves it
		t.Fatal(err)
	}
	if err := linux.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	id := syncIDs(t, mac)["root@pi:22"]
	// The Mac renames pi's host.
	if err := mac.SaveMachine(Machine{Host: "pi.lan", User: "root", KeyPath: "/k"}, "root@pi:22"); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if got := syncIDs(t, mac)["root@pi.lan:22"]; got != id {
		t.Fatalf("mac lost the machine on rename: %v", syncIDs(t, mac))
	}
	live := w.live()
	if body := string(live[id].Body); !strings.Contains(body, `"pi.lan"`) {
		t.Fatalf("account item %s after the rename: %s", id, body)
	}
	if len(live) != 2 {
		t.Fatalf("account has %d items; want 2 (pi renamed, 10.0.0.5)", len(live))
	}
}

// #257 review P2: the sync state belongs to one account. Signing in to
// another doesn't read the first one's machines as deleted, and shows none
// of them.
func TestAnotherAccountStartsOverWithoutDeletingMachines(t *testing.T) {
	quietSync(t)
	_, srvA := newWorker(t, "acct-a")
	wB, srvB := newWorker(t, "acct-b")
	ctx := context.Background()
	mac := device(t, srvA)
	signInTo(mac, srvA, "acct-a")
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	signInTo(mac, srvB, "acct-b")
	if got, _ := mac.SyncedMachines(); len(got) != 0 {
		t.Fatalf("account B shows account A's machines: %+v", got)
	}
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	ids := syncIDs(t, mac)
	if ids["root@pi:22"] == "" {
		t.Fatalf("machines after switching accounts: %v; want pi kept and synced to B", ids)
	}
	if live := wB.live(); len(live) != 1 || live[ids["root@pi:22"]].ID == "" {
		t.Fatalf("account B holds %v; want pi", live)
	}
}

// #257 review P2: a reconnect through Connect (Save & Connect) keeps the
// machine's sync id, so removing it later reaches the account.
func TestConnectKeepsTheSyncIDSoARemovalReachesTheAccount(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	ctx := context.Background()
	mac := device(t, srv)
	m := Machine{Host: "127.0.0.1", Port: 1, User: "root", KeyPath: "/k"}
	if err := mac.SaveMachine(m, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	id := syncIDs(t, mac)["root@127.0.0.1:1"]
	m.Nickname = "box"
	if err := mac.Connect(m, ""); err != nil {
		t.Fatal(err)
	}
	mac.Disconnect()
	if got := syncIDs(t, mac)["root@127.0.0.1:1"]; got != id {
		t.Fatalf("Connect dropped the sync id: %q, want %q", got, id)
	}
	if err := mac.RemoveMachine("root@127.0.0.1:1"); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if live := w.live(); len(live) != 0 {
		t.Fatalf("the removed machine is still in the account: %v", live)
	}
}

// #257 review P2: a fork's higher member also pending delete here makes one
// change, not two (the service refuses a push naming an id twice); #390
// e8debfe review: it is built on its base revision.
func TestOneChangePerID(t *testing.T) {
	hostA := account.RemoteHost{ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Rev: 1, Body: account.HostBody{Host: "pi", Username: "root"}}
	hostB := account.RemoteHost{ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Rev: 2, Body: account.HostBody{Host: "PI", Username: "root"}}
	mirror := account.Mirror{Rev: 2, Hosts: []account.RemoteHost{hostA, hostB}}
	st := machineStore{Machines: []Machine{{Host: "pi", User: "root", Port: 22, KeyPath: "/k", SyncID: hostA.ID}}}
	changes, _, _, _ := mergeMachines(&st, mirror, mirror, map[string]bool{hostA.ID: true, hostB.ID: true}, []string{hostB.ID}, nil, baseRevs(mirror, nil))
	n := 0
	for _, c := range changes {
		if c.ID == hostB.ID {
			n++
			if c.Base != hostB.Rev {
				t.Fatalf("the delete of %s is based on %d; want its revision %d", hostB.ID, c.Base, hostB.Rev)
			}
		}
	}
	if n != 1 {
		t.Fatalf("%d changes for %s: %+v", n, hostB.ID, changes)
	}
}

// #257 review P3: a removal whose tombstone can't be kept is refused, so the
// account never keeps a machine this device says it deleted.
func TestARemovalWhoseTombstoneCantBeKeptIsRefused(t *testing.T) {
	quietSync(t)
	_, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The sync state can't be written: its path is a directory.
	if err := os.Remove(mac.syncStatePath()); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(mac.syncStatePath(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mac.syncStatePath(), "x"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := mac.RemoveMachine("root@pi:22"); err == nil {
		t.Fatal("the removal succeeded without its tombstone")
	}
	if _, ok := syncIDs(t, mac)["root@pi:22"]; !ok {
		t.Fatal("the machine was removed though the account would never hear of it")
	}
}

// #257 review round 3: whether a device signs in with a key or a password
// is its own. A password device that changed nothing must not push its
// nickname back over the key device's rename, sync after sync.
func TestADevicesOwnSignInKindIsNotAnEdit(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	ctx := context.Background()
	keyDev, pwDev := device(t, srv), device(t, srv)
	if err := keyDev.SaveMachine(Machine{Nickname: "Old", Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := pwDev.SaveMachine(Machine{Nickname: "Old", Host: "pi", User: "root"}, ""); err != nil { // password here
		t.Fatal(err)
	}
	sync := func(d *Desk) {
		t.Helper()
		if err := d.SyncMachines(ctx); err != nil {
			t.Fatal(err)
		}
	}
	sync(keyDev)
	sync(pwDev)
	if err := keyDev.SaveMachine(Machine{Nickname: "New", Host: "pi", User: "root", KeyPath: "/k"}, "root@pi:22"); err != nil {
		t.Fatal(err)
	}
	sync(keyDev)
	w.mu.Lock()
	writes := w.rev
	w.mu.Unlock()
	for range 3 {
		sync(pwDev)
	}
	live := w.live()
	id := syncIDs(t, keyDev)["root@pi:22"]
	if body := string(live[id].Body); !strings.Contains(body, `"New"`) || !strings.Contains(body, `"key"`) {
		t.Fatalf("account copy after the password device synced: %s; want the key device's rename and auth kind kept", body)
	}
	w.mu.Lock()
	extra := w.rev - writes
	w.mu.Unlock()
	if extra != 0 {
		t.Fatalf("the unchanged password device wrote %d times", extra)
	}
	ms, _ := pwDev.Machines()
	if ms[0].Nickname != "New" || ms[0].KeyPath != "" {
		t.Fatalf("password device: %+v; want the rename taken and no key path", ms[0].Machine)
	}
}

// #257 review round 3: a damaged account-sync.json is an error, never a
// silent restart: no removal, no sync, and the file is left for a look.
func TestADamagedSyncStateStopsRemovalAndSync(t *testing.T) {
	quietSync(t)
	_, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mac.syncStatePath(), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := mac.RemoveMachine("root@pi:22"); err == nil {
		t.Fatal("removed a machine with a damaged sync state")
	}
	if _, ok := syncIDs(t, mac)["root@pi:22"]; !ok {
		t.Fatal("the machine is gone")
	}
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("synced over a damaged sync state")
	}
	if raw, _ := os.ReadFile(mac.syncStatePath()); string(raw) != "{not json" {
		t.Fatalf("the damaged file was replaced: %q", raw)
	}
}

// #257 review round 4: a local edit whose push the service refused stays an
// edit, and the next sync sends it.
func TestARefusedEditIsSentAgain(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	ctx := context.Background()
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Nickname: "Old", Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	if err := mac.SaveMachine(Machine{Nickname: "New", Host: "pi", User: "root", KeyPath: "/k"}, "root@pi:22"); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	if err := mac.SyncMachines(ctx); err == nil {
		t.Fatal("a refused push reported success")
	}
	w.mu.Lock()
	w.failPush = false
	w.mu.Unlock()
	if err := mac.SyncMachines(ctx); err != nil {
		t.Fatal(err)
	}
	id := syncIDs(t, mac)["root@pi:22"]
	if body := string(w.live()[id].Body); !strings.Contains(body, `"New"`) {
		t.Fatalf("account copy after the retry: %s; want the edit sent", body)
	}
}

// seedPrompt puts a prompt in the account as another device (the Swift
// app) wrote it.
func (w *syncWorker) seedPrompt(id, body string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.rev++
	w.items[id] = account.Item{Collection: "prompts", ID: id, Rev: w.rev, Body: json.RawMessage(body)}
}

func (w *syncWorker) livePrompts() map[string]string {
	out := map[string]string{}
	for id, it := range w.live() {
		if it.Collection == "prompts" {
			out[id] = string(it.Body)
		}
	}
	return out
}

func savePrompt(t *testing.T, d *Desk, id, nickname, text string) SavedPrompt {
	t.Helper()
	list, err := d.SavePrompt(SavedPrompt{ID: id, Nickname: nickname, Text: text})
	if err != nil {
		t.Fatal(err)
	}
	if id == "" {
		return list[len(list)-1]
	}
	i := slices.IndexFunc(list, func(p SavedPrompt) bool { return p.ID == id })
	if i < 0 {
		t.Fatalf("no prompt %s after saving it: %+v", id, list)
	}
	return list[i]
}

func promptsOf(t *testing.T, d *Desk) map[string]SavedPrompt {
	t.Helper()
	list, err := d.SavedPrompts()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]SavedPrompt{}
	for _, p := range list {
		out[p.ID] = p
	}
	return out
}

func syncEach(t *testing.T, ds ...*Desk) {
	t.Helper()
	for _, d := range ds {
		if err := d.SyncMachines(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
}

// Two devices with one account: a prompt saved on each shows on both, an
// edit on one reaches the other, and so does a delete.
func TestPromptsSyncAcrossTwoDevices(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac, linux := device(t, srv), device(t, srv)
	a := savePrompt(t, mac, "", "standup", "What did you do?")
	b := savePrompt(t, linux, "", "", "Run the tests\nthen push")
	syncEach(t, mac, linux, mac)
	for name, d := range map[string]*Desk{"mac": mac, "linux": linux} {
		got := promptsOf(t, d)
		if len(got) != 2 || got[a.ID] != a || got[b.ID] != b {
			t.Fatalf("%s's prompts: %+v; want %+v and %+v", name, got, a, b)
		}
	}
	if live := w.livePrompts(); len(live) != 2 {
		t.Fatalf("the account holds %v; want both prompts", live)
	}

	edited := savePrompt(t, mac, a.ID, "Standup", "What did you do yesterday?")
	if edited.ID != a.ID {
		t.Fatalf("an edit made a new prompt: %+v", edited)
	}
	syncEach(t, mac, linux)
	if got := promptsOf(t, linux)[a.ID]; got != edited {
		t.Fatalf("linux after the mac's edit: %+v; want %+v", got, edited)
	}

	if _, err := linux.DeletePrompt(b.ID); err != nil {
		t.Fatal(err)
	}
	syncEach(t, linux, mac)
	if got := promptsOf(t, mac); len(got) != 1 || got[a.ID] != edited {
		t.Fatalf("mac after linux's delete: %+v; want only %+v", got, edited)
	}
	if _, ok := w.livePrompts()[b.ID]; ok {
		t.Fatal("the account still holds the deleted prompt")
	}
	if raw, _ := os.ReadFile(linux.syncStatePath()); strings.Contains(string(raw), `"promptDeletes"`) {
		t.Fatalf("the pushed delete is still pending: %s", raw)
	}
}

// The owner's case: this device synced machines before prompts synced, has
// its own prompts, and the account already holds the Swift app's. Both
// lists end up on both, the account's after this device's, and the
// device's after the account's last order. A tombstone the account holds
// from long ago doesn't take a prompt this device never synced.
func TestSigningInWithPromptsKeepsTheAccountsToo(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	const phone, phone2, old = "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"
	w.mu.Lock()
	w.rev++
	w.items[old] = account.Item{Collection: "prompts", ID: old, Rev: w.rev, Deleted: true}
	w.mu.Unlock()
	w.seedPrompt(phone2, `{"text":"second","order":1}`)
	w.seedPrompt(phone, `{"title":"From the phone","text":"hello","order":0}`)
	mac := device(t, srv)
	// A machines-only sync already ran: its mirror is past the prompts' revisions.
	if err := mac.storeSyncState(syncState{AccountID: "acct", Mirror: account.Mirror{Rev: 3}}); err != nil {
		t.Fatal(err)
	}
	kept, err := mac.ImportSavedPrompts([]SavedPrompt{{ID: old, Text: "from localStorage"}})
	if err != nil {
		t.Fatal(err)
	}
	own := savePrompt(t, mac, "", "desk", "from the desktop")
	syncEach(t, mac)
	list, _ := mac.SavedPrompts()
	want := []SavedPrompt{kept[0], own, {ID: phone, Nickname: "From the phone", Text: "hello"}, {ID: phone2, Text: "second"}}
	if !slices.Equal(list, want) {
		t.Fatalf("mac's prompts: %+v; want %+v", list, want)
	}
	if body := w.livePrompts()[own.ID]; body != `{"title":"desk","text":"from the desktop","order":3}` {
		t.Fatalf("the desktop's prompt in the account: %s", body)
	}
	linux := device(t, srv)
	syncEach(t, linux)
	if got := promptsOf(t, linux); len(got) != 4 || got[own.ID] != own || got[old] != kept[0] {
		t.Fatalf("another device's prompts: %+v", got)
	}
}

// A prompt travels as title (the nickname trimmed, none when empty), text
// with its line breaks, and order; an edit keeps the account's order.
func TestPromptFieldsRoundTrip(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac, linux := device(t, srv), device(t, srv)
	daily := savePrompt(t, mac, "", "  daily  ", "line one\n\tline two")
	bare := savePrompt(t, mac, "", "", "no title")
	syncEach(t, mac)
	live := w.livePrompts()
	if live[daily.ID] != `{"title":"daily","text":"line one\n\tline two","order":0}` || live[bare.ID] != `{"text":"no title","order":1}` {
		t.Fatalf("the account's copies: %v", live)
	}
	syncEach(t, linux)
	if got := promptsOf(t, linux)[daily.ID]; got.Nickname != "daily" || got.Text != "line one\n\tline two" {
		t.Fatalf("linux's copy: %+v", got)
	}
	savePrompt(t, linux, bare.ID, "titled", "no title, edited")
	syncEach(t, linux)
	if body := w.livePrompts()[bare.ID]; body != `{"title":"titled","text":"no title, edited","order":1}` {
		t.Fatalf("the edited prompt in the account: %s; want its order kept", body)
	}
}

// A prompt the service would refuse (too long, no text) or one past the
// account's cap is not sent, so the rest of the push goes through; it stays
// on this device.
func TestPromptsTheServiceWouldRefuseAreNotSent(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	long := savePrompt(t, mac, "", "", strings.Repeat("x", 8193))
	good := savePrompt(t, mac, "", "", "fits")
	// The prompt the service would refuse stays here, unsent, and the round
	// says so (it doesn't count as a good sync).
	before, _ := mac.AccountSyncStatus()
	if err := mac.SyncMachines(context.Background()); !errors.Is(err, errUnsendable) {
		t.Fatalf("%v; want the round to report the prompt it can't send", err)
	}
	if after, _ := mac.AccountSyncStatus(); after != before || !mac.AccountState().SyncFailed {
		t.Fatalf("last sync %+v (was %+v), needs attention %v; want unchanged, true", after, before, mac.AccountState().SyncFailed)
	}
	live := w.livePrompts()
	if _, sent := live[long.ID]; sent || live[good.ID] == "" {
		t.Fatalf("the account holds %v; want only the prompt that fits", live)
	}
	if got := promptsOf(t, mac); len(got) != 2 {
		t.Fatalf("mac's prompts after the sync: %+v; want both kept", got)
	}
	empty := SavedPrompt{ID: "00000000-0000-4000-8000-000000000009"}
	if _, changes, _, _, _ := mergePrompts([]SavedPrompt{empty}, nil, nil, nil, nil, nil, nil, nil, nil, nil); len(changes) != 0 {
		t.Fatalf("an empty prompt was sent: %+v", changes)
	}

	for i := range account.PromptsCap - 1 {
		w.seedPrompt(fmt.Sprintf("00000000-0000-4000-9000-%012d", i), `{"text":"seeded"}`)
	}
	over := savePrompt(t, mac, "", "", "one too many")
	syncRefusedForQuota(t, mac)
	if _, sent := w.livePrompts()[over.ID]; sent || len(w.livePrompts()) != account.PromptsCap {
		t.Fatalf("the account holds %d prompts (the last one sent: %v); want the cap", len(w.livePrompts()), sent)
	}
	if _, kept := promptsOf(t, mac)[over.ID]; !kept {
		t.Fatal("the prompt past the cap was dropped here")
	}
}

// A prompt deleted on another device goes here too, unless it was edited
// here since: then the edit stands and is pushed back.
func TestAPromptEditedHereOutlivesItsRemoteDelete(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac, linux := device(t, srv), device(t, srv)
	kept := savePrompt(t, mac, "", "", "keep me")
	gone := savePrompt(t, mac, "", "", "drop me")
	syncEach(t, mac, linux)
	for _, id := range []string{kept.ID, gone.ID} {
		if _, err := linux.DeletePrompt(id); err != nil {
			t.Fatal(err)
		}
	}
	syncEach(t, linux)
	edited := savePrompt(t, mac, kept.ID, "", "keep me, edited")
	syncEach(t, mac)
	if got := promptsOf(t, mac); len(got) != 1 || got[kept.ID] != edited {
		t.Fatalf("mac's prompts: %+v; want only the edited one", got)
	}
	if body := w.livePrompts()[kept.ID]; !strings.Contains(body, "keep me, edited") {
		t.Fatalf("the account's copy: %q; want the edit pushed back", body)
	}
}

// The account page's status: what the account held at the newest good
// sync of the signed-in account, under its JSON names; Sync now runs one
// and tells the page.
func TestAccountSyncStatusAndSyncNow(t *testing.T) {
	quietSync(t)
	var published []AccountState
	previous := publishAccount
	publishAccount = func(s AccountState) { published = append(published, s) }
	t.Cleanup(func() { publishAccount = previous })
	_, srv := newWorker(t, "")
	mac := device(t, srv)
	if s, err := mac.AccountSyncStatus(); err != nil || s != (AccountSyncStatus{}) {
		t.Fatalf("before any sync: %+v, %v", s, err)
	}
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	first := savePrompt(t, mac, "", "", "one")
	savePrompt(t, mac, "", "", "two")
	start := time.Now().UnixMilli()
	if err := mac.AccountSyncNow(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(published) != 1 || !published[0].SignedIn {
		t.Fatalf("published %+v; want the account state once", published)
	}
	// A delete not yet synced: the status is still the account's.
	if _, err := mac.DeletePrompt(first.ID); err != nil {
		t.Fatal(err)
	}
	s, err := mac.AccountSyncStatus()
	if err != nil || s.LastSyncedMs < start || s.LastSyncedMs > time.Now().UnixMilli() || s.Machines != 1 || s.Prompts != 2 {
		t.Fatalf("after the sync: %+v, %v", s, err)
	}
	raw, _ := json.Marshal(s)
	if want := fmt.Sprintf(`{"lastSyncedMs":%d,"machines":1,"prompts":2}`, s.LastSyncedMs); string(raw) != want {
		t.Fatalf("status JSON %s; want %s", raw, want)
	}
	signInTo(mac, srv, "other")
	if s, _ := mac.AccountSyncStatus(); s != (AccountSyncStatus{}) {
		t.Fatalf("another account's status: %+v", s)
	}
}

// #273 review: 40 prompts of 8 KB are more than one push may carry (256
// KiB), though fewer than 100: they go in as many pushes as the bytes need.
func TestManyLongPromptsFitTheServicesPushLimit(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	for i := range 40 {
		savePrompt(t, mac, "", "", fmt.Sprintf("%02d", i)+strings.Repeat("x", 8000))
	}
	syncEach(t, mac)
	if n := len(w.livePrompts()); n != 40 || w.pushes < 2 {
		t.Fatalf("the account holds %d prompts after %d pushes; want 40 in more than one", n, w.pushes)
	}
}

// #273 review: a prompt within 8 KB of text whose stored body passes the
// service's 16 KiB item limit (quotes take two bytes each) stays here and
// doesn't stop the rest of the push; the round reports it.
func TestAPromptTooBigToStoreStaysHere(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	quotes := savePrompt(t, mac, "", "", "x"+strings.Repeat(`"`, 8191))
	good := savePrompt(t, mac, "", "", "fits")
	if err := mac.SyncMachines(context.Background()); !errors.Is(err, errUnsendable) {
		t.Fatalf("%v; want the round to report the prompt it can't send", err)
	}
	live := w.livePrompts()
	if _, sent := live[quotes.ID]; sent || live[good.ID] == "" {
		t.Fatalf("the account holds %v; want only the prompt that fits", live)
	}
	if _, kept := promptsOf(t, mac)[quotes.ID]; !kept {
		t.Fatal("the prompt too big to store was dropped here")
	}
}

// #273 review: a prompt deleted while its first upload is on the way is
// deleted in the account by the next sync, not brought back.
func TestAPromptDeletedWhileItUploadsStaysDeleted(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac, linux := device(t, srv), device(t, srv)
	p := savePrompt(t, mac, "", "", "short-lived")
	w.mu.Lock()
	w.onPush = func() {
		if _, err := mac.DeletePrompt(p.ID); err != nil {
			t.Error(err)
		}
	}
	w.mu.Unlock()
	syncEach(t, mac, mac, linux)
	if got := promptsOf(t, mac); len(got) != 0 {
		t.Fatalf("mac's prompts: %+v; want the deleted one gone", got)
	}
	if _, ok := w.livePrompts()[p.ID]; ok {
		t.Fatal("the account still holds the prompt deleted during its upload")
	}
	if got := promptsOf(t, linux); len(got) != 0 {
		t.Fatalf("linux's prompts: %+v", got)
	}
}

// #273 review: the status's counts are the account's at its time. A failed
// sync that pulled another device's prompt leaves both as they were.
func TestAFailedSyncLeavesTheStatusAsItWas(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	savePrompt(t, mac, "", "", "one")
	syncEach(t, mac)
	before, err := mac.AccountSyncStatus()
	if err != nil || before.Prompts != 1 || before.LastSyncedMs == 0 {
		t.Fatalf("after a good sync: %+v, %v", before, err)
	}
	w.seedPrompt("00000000-0000-4000-8000-000000000001", `{"text":"from the phone"}`)
	savePrompt(t, mac, "", "", "two")
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a refused push reported success")
	}
	if after, _ := mac.AccountSyncStatus(); after != before {
		t.Fatalf("after a failed sync: %+v; want %+v", after, before)
	}
}

// #372: a pull reads its pages one at a time. A prompt live on the first
// page and deleted by another device before the second is not brought back.
func TestAPromptLiveOnOnePullPageAndDeletedBeforeTheNextIsNotBroughtBack(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	const gone = "00000000-0000-4000-8000-000000000001"
	w.seedPrompt(gone, `{"text":"deleted while pulled","order":0}`)
	w.seedPrompt("00000000-0000-4000-8000-000000000002", `{"text":"two","order":1}`)
	w.seedPrompt("00000000-0000-4000-8000-000000000003", `{"text":"three","order":2}`)
	w.mu.Lock()
	w.pageSize = 2
	w.onNextPage = func() { w.tombstone(gone) }
	w.mu.Unlock()
	mac := device(t, srv)
	syncEach(t, mac, mac)
	got := promptsOf(t, mac)
	if _, back := got[gone]; back || len(got) != 2 {
		t.Fatalf("mac's prompts: %+v; want the two left", got)
	}
	if _, back := w.livePrompts()[gone]; back {
		t.Fatal("the deleted prompt is in the account again")
	}
}

// #372: another device's delete that this device reads back with its own
// write is not uploaded again by the next sync.
func TestADeleteArrivingWithTheReadbackIsNotUploadedAgain(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac, linux := device(t, srv), device(t, srv)
	p := savePrompt(t, mac, "", "", "deleted on linux")
	syncEach(t, mac, linux)
	savePrompt(t, mac, "", "", "new on mac")
	// Linux's delete lands while mac pushes its new prompt.
	w.mu.Lock()
	w.onPush = func() { w.tombstone(p.ID) }
	w.mu.Unlock()
	syncEach(t, mac, mac)
	if _, kept := promptsOf(t, mac)[p.ID]; kept {
		t.Fatal("mac still holds the prompt linux deleted")
	}
	if live := w.livePrompts(); len(live) != 1 || live[p.ID] != "" {
		t.Fatalf("the account holds %v; want only mac's new prompt", live)
	}
}

// #372: the same for a machine: another device's delete read back with
// this device's write is not uploaded again.
func TestAMachineDeletedElsewhereDuringTheReadbackIsNotUploadedAgain(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	syncEach(t, mac)
	id := syncIDs(t, mac)["root@pi:22"]
	if err := mac.SaveMachine(Machine{Host: "box", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.onPush = func() { w.tombstone(id) }
	w.mu.Unlock()
	syncEach(t, mac, mac)
	if _, kept := syncIDs(t, mac)["root@pi:22"]; kept {
		t.Fatal("mac still holds the machine deleted elsewhere")
	}
	hosts := 0
	for hid, it := range w.live() {
		if it.Collection == "hosts" {
			hosts++
			if hid == id {
				t.Fatal("the deleted machine is in the account again")
			}
		}
	}
	if hosts != 1 {
		t.Fatalf("the account holds %d machines; want 1", hosts)
	}
}

// #372: an upload the service took but whose answer was lost leaves no
// baseline; an edit saved after it is still this device's edit, kept here
// and sent, not overwritten by the account's copy of the first upload.
func TestAnEditAfterAnUploadWhoseAnswerWasLostIsKept(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v1")
	w.mu.Lock()
	w.losePush = true
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a sync whose push answer was lost reported success")
	}
	if body := w.livePrompts()[p.ID]; !strings.Contains(body, `"v1"`) {
		t.Fatalf("the account's copy: %s; want the upload taken", body)
	}
	v2 := savePrompt(t, mac, p.ID, "", "v2")
	syncEach(t, mac)
	if got := promptsOf(t, mac)[p.ID]; got != v2 {
		t.Fatalf("mac's prompt: %+v; want the edit %+v", got, v2)
	}
	if body := w.livePrompts()[p.ID]; !strings.Contains(body, `"v2"`) {
		t.Fatalf("the account's copy: %s; want the edit", body)
	}
}

// #372: account-sync.json from before the sent fields were kept lists the
// prompts being sent by id; each still counts as one the account may hold,
// so deleting it keeps its tombstone.
func TestAnOldStatesSendingListKeepsADeletesTombstone(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "on its way")
	old := fmt.Sprintf(`{"accountId":"acct","mirror":{"rev":0,"hosts":null},"promptsPulled":true,"promptsSending":[%q]}`, p.ID)
	if err := os.WriteFile(mac.syncStatePath(), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	// The upload was taken; its answer was lost.
	w.seedPrompt(p.ID, `{"text":"on its way","order":0}`)
	if _, err := mac.DeletePrompt(p.ID); err != nil {
		t.Fatal(err)
	}
	syncEach(t, mac)
	if _, back := promptsOf(t, mac)[p.ID]; back {
		t.Fatal("the deleted prompt came back")
	}
	if _, held := w.livePrompts()[p.ID]; held {
		t.Fatal("the account still holds the deleted prompt")
	}
}

// #372: after an account prompt at the largest order the service takes, a
// new prompt syncs without an order instead of never.
func TestANewPromptAfterTheLargestOrderSyncsWithoutOne(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	w.seedPrompt("00000000-0000-4000-8000-000000000001", `{"text":"last","order":9007199254740991}`)
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "new")
	syncEach(t, mac)
	if body := w.livePrompts()[p.ID]; body != `{"text":"new"}` {
		t.Fatalf("the new prompt in the account: %q; want it without an order", body)
	}
}

// #372: a sync whose request stalls ends by the round's deadline, and the
// next sync gets its turn.
func TestAStalledSyncEndsByItsDeadlineAndFreesTheTurn(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	previous := syncRoundTimeout
	syncRoundTimeout = 200 * time.Millisecond
	t.Cleanup(func() { syncRoundTimeout = previous })
	_, release := w.stallPulls(t)
	done := make(chan error, 1)
	go func() { done <- mac.SyncMachines(context.Background()) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a stalled sync reported success")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a stalled sync outlived its round's deadline")
	}
	release()
	syncRoundTimeout = previous
	syncEach(t, mac)
}

// #372: a sync waiting for its turn leaves when its own context ends,
// without syncing, while another holds the turn.
func TestASyncWaitingForItsTurnLeavesWhenItsContextEnds(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	stalled, release := w.stallPulls(t)
	holding := make(chan error, 1)
	go func() { holding <- mac.SyncMachines(context.Background()) }()
	select {
	case <-stalled:
	case <-time.After(5 * time.Second):
		t.Fatal("the first sync never pulled")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	waited := make(chan error, 1)
	go func() { waited <- mac.SyncMachines(ctx) }()
	select {
	case err := <-waited:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("the waiting sync: %v; want its context's end", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a waiting sync outlived its context")
	}
	release()
	<-holding
}

// #372: the account's history starts over (a restore without this
// device's prompts and machine) while it pushes a new prompt: its readback
// pulls the restored account whole, and what that no longer holds goes
// here too instead of being uploaded again.
func TestWhatARestoredAccountNoLongerHoldsGoesHereTooWhenTheReadbackShowsIt(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	a, b := savePrompt(t, mac, "", "", "a"), savePrompt(t, mac, "", "", "b")
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	syncEach(t, mac)
	c := savePrompt(t, mac, "", "", "c")
	w.mu.Lock()
	w.onPush = w.startOver
	w.mu.Unlock()
	syncEach(t, mac, mac)
	if got := promptsOf(t, mac); len(got) != 1 || got[c.ID] != c {
		t.Fatalf("mac's prompts: %+v; want only %+v", got, c)
	}
	if live := w.livePrompts(); len(live) != 1 || live[c.ID] == "" || live[a.ID] != "" || live[b.ID] != "" {
		t.Fatalf("the account holds %v; want only c", live)
	}
	if ids := syncIDs(t, mac); len(ids) != 0 {
		t.Fatalf("mac's machines: %v; want the restored account's (none)", ids)
	}
	for _, it := range w.live() {
		if it.Collection == "hosts" {
			t.Fatalf("the machine was uploaded again: %+v", it)
		}
	}
}

// #372: two uploads whose answers were lost (v1, then v2) both reached
// the account; v1 saved again afterwards is an edit, kept here and sent.
func TestARevertAfterTwoUploadsWhoseAnswersWereLostIsKept(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v1")
	for _, text := range []string{"v1", "v2"} {
		savePrompt(t, mac, p.ID, "", text)
		w.mu.Lock()
		w.losePush = true
		w.mu.Unlock()
		if err := mac.SyncMachines(context.Background()); err == nil {
			t.Fatal("a sync whose push answer was lost reported success")
		}
	}
	if body := w.livePrompts()[p.ID]; !strings.Contains(body, `"v2"`) {
		t.Fatalf("the account's copy: %s; want both uploads taken", body)
	}
	reverted := savePrompt(t, mac, p.ID, "", "v1")
	syncEach(t, mac)
	if got := promptsOf(t, mac)[p.ID]; got != reverted {
		t.Fatalf("mac's prompt: %+v; want the revert %+v", got, reverted)
	}
	if body := w.livePrompts()[p.ID]; !strings.Contains(body, `"v1"`) {
		t.Fatalf("the account's copy: %s; want the revert", body)
	}
}

// #372: a push past the account's storage quota is refused whole; a
// deletion and a prompt that fits still reach the account, and the prompt
// past it stays here. The round still fails, every time it is tried.
func TestAPromptPastTheQuotaStaysHereWhileADeletionAndAPromptThatFitGo(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	savePrompt(t, mac, "", "", "kept")
	k := savePrompt(t, mac, "", "", "k")
	syncEach(t, mac)
	w.mu.Lock()
	w.quotaBytes = 81
	for _, it := range w.items {
		w.quotaBytes += len(it.Body)
	}
	w.mu.Unlock()
	if _, err := mac.DeletePrompt(k.ID); err != nil {
		t.Fatal(err)
	}
	draft := savePrompt(t, mac, "", "", strings.Repeat("d", 500))
	small := savePrompt(t, mac, "", "", "small")
	for round := range 2 {
		var api *account.APIError
		if err := mac.SyncMachines(context.Background()); !errors.As(err, &api) || api.Code != "quota" {
			t.Fatalf("round %d: %v; want the quota refusal", round, err)
		}
		live := w.livePrompts()
		if _, held := live[k.ID]; held || live[small.ID] == "" || live[draft.ID] != "" {
			t.Fatalf("round %d: the account holds %v; want k deleted, small sent and the draft not", round, live)
		}
		if _, kept := promptsOf(t, mac)[draft.ID]; !kept {
			t.Fatalf("round %d: the draft is no longer saved here", round)
		}
		state, err := mac.loadSyncState()
		if err != nil || len(state.PromptDeletes) != 0 || !mac.AccountState().SyncFailed {
			t.Fatalf("round %d: pending deletes %v (%v), needs attention %v", round, state.PromptDeletes, err, mac.AccountState().SyncFailed)
		}
	}
}

// #390 review: an upload of v1 the service received lands late, after v2,
// saved since, was acknowledged. v1 was based on the account holding no
// such prompt, so it is not written: both here and in the account the
// prompt stays v2.
func TestALateUploadDoesNotEraseANewerAcknowledgedEdit(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v1")
	syncGivingUpTheUpload(t, w, mac)
	v2 := savePrompt(t, mac, p.ID, "", "v2")
	syncEach(t, mac)
	w.landHeld()
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got != v2 || !strings.Contains(body, `"v2"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want v2 in both", got, body)
	}
}

// #390 review: the same when v2's answer was lost and a pull showed it
// landed before v1 did.
func TestALateUploadDoesNotEraseANewerEditAPullShowed(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v1")
	syncGivingUpTheUpload(t, w, mac)
	v2 := savePrompt(t, mac, p.ID, "", "v2")
	w.mu.Lock()
	w.losePush = true
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a sync whose push answer was lost reported success")
	}
	syncEach(t, mac)
	w.landHeld()
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got != v2 || !strings.Contains(body, `"v2"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want v2 in both", got, body)
	}
}

// #390 review: two devices take in the same prompt id (kept from the
// page's localStorage). The mac's create lands late, after linux's: it is
// not written, and the mac takes the account's copy.
func TestALateCreateAfterAnotherDeviceCreatedTheSameID(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac, linux := device(t, srv), device(t, srv)
	const id = "00000000-0000-4000-8000-000000000001"
	if _, err := mac.ImportSavedPrompts([]SavedPrompt{{ID: id, Text: "from the mac"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := linux.ImportSavedPrompts([]SavedPrompt{{ID: id, Text: "from linux"}}); err != nil {
		t.Fatal(err)
	}
	syncGivingUpTheUpload(t, w, mac)
	syncEach(t, linux)
	w.landHeld()
	syncEach(t, mac, linux)
	if body := w.livePrompts()[id]; !strings.Contains(body, `"from linux"`) {
		t.Fatalf("the account's copy: %s; want linux's, the first create", body)
	}
	for name, d := range map[string]*Desk{"mac": mac, "linux": linux} {
		if got := promptsOf(t, d)[id]; got.Text != "from linux" {
			t.Fatalf("%s's prompt: %+v; want the account's", name, got)
		}
	}
}

// An edit here that the service turns down (another device's edit landed
// since this device's pull) is not taken as agreed: the same sync takes
// the account's copy, keeps the edit and sends it again over it, the last
// write to reach the service winning.
func TestAnEditTheServiceTurnsDownIsKeptAndSentAgain(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v1")
	syncEach(t, mac)
	edited := savePrompt(t, mac, p.ID, "", "from the mac")
	w.mu.Lock()
	w.onPush = func() { w.otherDeviceWritesLocked(p.ID, "from linux") }
	w.mu.Unlock()
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got != edited || !strings.Contains(body, "from the mac") {
		t.Fatalf("mac's prompt %+v, the account's %s; want the mac's edit in both", got, body)
	}
}

// anotherDeviceWrites writes prompt id's text as another device would.
func (w *syncWorker) anotherDeviceWrites(id, text string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.otherDeviceWritesLocked(id, text)
}

// A write sent here whose fate was unknown, and which can no longer land
// (the account moved past its base), is forgotten: a later copy from
// another device that happens to match it is that device's edit, taken
// here, not this device's write landing over an unedited copy.
func TestAWriteThatCanNoLongerLandIsForgotten(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "B")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "X")
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a failed upload reported success")
	}
	w.mu.Lock()
	w.failPush = false
	w.mu.Unlock()
	savePrompt(t, mac, p.ID, "", "B")
	w.anotherDeviceWrites(p.ID, "Y")
	syncEach(t, mac)
	w.anotherDeviceWrites(p.ID, "X")
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "X" || !strings.Contains(body, `"X"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the other device's X in both", got, body)
	}
}

// A write the service refused whole (here for the quota) can't land: it
// is forgotten at once, so another device's matching edit later is taken
// here, not mistaken for this device's write over an unedited copy.
func TestARefusedWriteIsForgotten(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "B")
	syncEach(t, mac)
	quota := w.usedBytes() + 5
	w.mu.Lock()
	w.quotaBytes = quota
	w.mu.Unlock()
	savePrompt(t, mac, p.ID, "", "B, but much longer")
	syncRefusedForQuota(t, mac)
	savePrompt(t, mac, p.ID, "", "B")
	w.mu.Lock()
	w.quotaBytes = 0
	w.mu.Unlock()
	w.anotherDeviceWrites(p.ID, "B, but much longer")
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "B, but much longer" || !strings.Contains(body, "much longer") {
		t.Fatalf("mac's prompt %+v, the account's %s; want the other device's edit in both", got, body)
	}
}

// syncGivingUpTheUpload runs a sync on d that gives its upload up once the
// service has received it (the service keeps it, to land late).
func syncGivingUpTheUpload(t *testing.T, w *syncWorker, d *Desk) {
	t.Helper()
	received := w.holdNextPush()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { <-received; cancel() }()
	if err := d.SyncMachines(ctx); err == nil {
		t.Fatal("a given-up upload reported success")
	}
}

// #384: the first upload of v1 is given up after the service received it;
// v2 is saved and its upload refused; then v1 lands late. The next sync
// keeps v2 here (v1 is a write that landed, not this device's copy) and
// sends it.
func TestALateFirstUploadDoesNotOverwriteANewerSavedEdit(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v1")
	syncGivingUpTheUpload(t, w, mac)
	v2 := savePrompt(t, mac, p.ID, "", "v2")
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a refused upload reported success")
	}
	w.mu.Lock()
	w.failPush = false
	w.mu.Unlock()
	w.landHeld()
	if body := w.livePrompts()[p.ID]; !strings.Contains(body, `"v1"`) {
		t.Fatalf("the account's copy: %s; want v1 landed late", body)
	}
	syncEach(t, mac)
	if got := promptsOf(t, mac)[p.ID]; got != v2 {
		t.Fatalf("mac's prompt: %+v; want the newer edit %+v", got, v2)
	}
	if body := w.livePrompts()[p.ID]; !strings.Contains(body, `"v2"`) {
		t.Fatalf("the account's copy: %s; want the newer edit", body)
	}
}

// #384: account-sync.json from before every unsettled write was kept holds
// the newest one under promptsSent; it still tells an edit made since.
func TestAnUpgradedStatesSentFieldsStillTellAnEdit(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v1")
	old := fmt.Sprintf(`{"accountId":"acct","mirror":{"rev":0,"hosts":null},"promptsPulled":true,"promptsSent":{%q:{"text":"v1"}}}`, p.ID)
	if err := os.WriteFile(mac.syncStatePath(), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	// The upload was taken; its answer was lost.
	w.seedPrompt(p.ID, `{"text":"v1","order":0}`)
	v2 := savePrompt(t, mac, p.ID, "", "v2")
	syncEach(t, mac)
	if got := promptsOf(t, mac)[p.ID]; got != v2 {
		t.Fatalf("mac's prompt: %+v; want the edit %+v", got, v2)
	}
	if body := w.livePrompts()[p.ID]; !strings.Contains(body, `"v2"`) {
		t.Fatalf("the account's copy: %s; want the edit", body)
	}
}

// #385 (a regression guard; #372 item 6 fixed it): the account is restored
// to an earlier revision while this device pushes, so the readback is told
// to start over and pulls the account whole. A prompt and a machine the
// restored account no longer holds go here too, instead of being uploaded
// again.
func TestAFullReadbackAfterARestoreKeepsTheRemovalsWithoutTombstones(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	const keep, old = "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
	w.seedPrompt(keep, `{"text":"keep","order":0}`)
	w.seedPrompt(old, `{"text":"old","order":1}`)
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	syncEach(t, mac)
	n := savePrompt(t, mac, "", "", "new")
	w.mu.Lock()
	w.onPush = func() { w.restoreTo(1) }
	w.mu.Unlock()
	syncEach(t, mac, mac)
	if got := promptsOf(t, mac); len(got) != 2 || got[keep].Text != "keep" || got[n.ID] != n {
		t.Fatalf("mac's prompts: %+v; want keep and new", got)
	}
	if live := w.livePrompts(); len(live) != 2 || live[keep] == "" || live[n.ID] == "" {
		t.Fatalf("the account holds %v; want keep and new", live)
	}
	if ids := syncIDs(t, mac); len(ids) != 0 {
		t.Fatalf("mac's machines: %v; want the restored account's (none)", ids)
	}
	for _, it := range w.live() {
		if it.Collection == "hosts" {
			t.Fatalf("the machine was uploaded again: %+v", it)
		}
	}
}

// An older form of the unsettled writes of the wrong type is a damaged
// state like any other: a delete is refused (its tombstone couldn't be
// kept) and the sync stops, instead of the pending ids being dropped.
func TestALegacySendingListOfTheWrongTypeIsADamagedState(t *testing.T) {
	quietSync(t)
	_, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "on its way")
	damaged := fmt.Sprintf(`{"accountId":"acct","mirror":{"rev":0,"hosts":null},"promptsPulled":true,"promptsSending":[%q,5]}`, p.ID)
	if err := os.WriteFile(mac.syncStatePath(), []byte(damaged), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := mac.DeletePrompt(p.ID); err == nil {
		t.Fatal("a delete over a damaged state was taken")
	}
	if _, kept := promptsOf(t, mac)[p.ID]; !kept {
		t.Fatal("the prompt went without its tombstone")
	}
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a sync over a damaged state reported success")
	}
}

// #386: a restore during the readback leaves out a saved machine and a
// saved prompt; both are edited here before the next sync. Edits outlive
// the absence: both stay here and are uploaded again.
func TestEditsAfterARestoreLeftThemOutAreUploadedAgain(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Nickname: "pi", Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	a := savePrompt(t, mac, "", "", "a")
	syncEach(t, mac)
	id := syncIDs(t, mac)["root@pi:22"]
	savePrompt(t, mac, "", "", "c")
	w.mu.Lock()
	w.onPush = w.startOver
	w.mu.Unlock()
	syncEach(t, mac)
	if err := mac.SaveMachine(Machine{Nickname: "Pi 4", Host: "pi", User: "root", KeyPath: "/k"}, "root@pi:22"); err != nil {
		t.Fatal(err)
	}
	edited := savePrompt(t, mac, a.ID, "", "a, edited")
	syncEach(t, mac)
	if got := syncIDs(t, mac)["root@pi:22"]; got != id {
		t.Fatalf("mac's machines: %v; want the edited one kept as %s", syncIDs(t, mac), id)
	}
	if body := string(w.live()[id].Body); !strings.Contains(body, `"Pi 4"`) {
		t.Fatalf("the account's machine: %q; want the edit uploaded again", body)
	}
	if got := promptsOf(t, mac)[a.ID]; got != edited {
		t.Fatalf("mac's prompt: %+v; want the edit %+v", got, edited)
	}
	if body := w.livePrompts()[a.ID]; !strings.Contains(body, `"a, edited"`) {
		t.Fatalf("the account's prompt: %q; want the edit uploaded again", body)
	}
}

// usedBytes is what the account's prompts weigh against its quota.
func (w *syncWorker) usedBytes() int {
	n := 0
	for _, body := range w.livePrompts() {
		n += len(body)
	}
	return n
}

// syncRefusedForQuota syncs d and wants the quota refusal back.
func syncRefusedForQuota(t *testing.T, d *Desk) {
	t.Helper()
	var api *account.APIError
	if err := d.SyncMachines(context.Background()); !errors.As(err, &api) || api.Code != "quota" {
		t.Fatalf("%v; want the quota refusal", err)
	}
}

// Item F: one prompt past the quota can't be made smaller: each round
// sends it once.
func TestOnePromptPastTheQuotaIsSentOncePerRound(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	savePrompt(t, mac, "", "", "kept")
	syncEach(t, mac)
	quota := w.usedBytes() + 10
	w.mu.Lock()
	w.quotaBytes, w.posts = quota, 0
	w.mu.Unlock()
	big := savePrompt(t, mac, "", "", strings.Repeat("b", 100))
	for range 2 {
		syncRefusedForQuota(t, mac)
	}
	_, kept := promptsOf(t, mac)[big.ID]
	_, sent := w.livePrompts()[big.ID]
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.posts != 2 || !kept || sent {
		t.Fatalf("asked %d times in 2 rounds, kept here %v, in the account %v; want twice, kept, not sent", w.posts, kept, sent)
	}
}

// Item F: 29 drafts past the quota before a small prompt that fits, with
// the service's 30 pushes a minute. A round stops at the rate limit, and
// the next starts where it stopped: the small prompt gets in.
func TestAPromptThatFitsGetsInPast29ThatDont(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	savePrompt(t, mac, "", "", "kept")
	syncEach(t, mac)
	quota := w.usedBytes() + 81
	w.mu.Lock()
	w.quotaBytes, w.rateLimit = quota, 30
	w.mu.Unlock()
	var drafts []SavedPrompt
	for i := range 29 {
		drafts = append(drafts, savePrompt(t, mac, "", "", fmt.Sprintf("%02d", i)+strings.Repeat("d", 498)))
	}
	small := savePrompt(t, mac, "", "", "small")
	for round := 0; ; round++ {
		if round == 3 {
			t.Fatal("the small prompt is still not in the account after 3 rounds")
		}
		w.mu.Lock()
		w.windowPosts = 0
		w.mu.Unlock()
		var api *account.APIError
		if err := mac.SyncMachines(context.Background()); !errors.As(err, &api) || api.Status != http.StatusTooManyRequests && api.Code != "quota" {
			t.Fatalf("round %d: %v; want the rate limit or the quota", round, err)
		}
		live := w.livePrompts()
		w.mu.Lock()
		window := w.windowPosts
		w.mu.Unlock()
		if window > 31 {
			t.Fatalf("round %d: %d pushes asked; want the round to stop at the first one past 30", round, window)
		}
		for _, d := range drafts {
			if live[d.ID] != "" {
				t.Fatalf("round %d: a draft past the quota is in the account", round)
			}
		}
		if live[small.ID] != "" {
			break
		}
	}
	if got := promptsOf(t, mac); len(got) != 31 {
		t.Fatalf("mac holds %d prompts; want all 31", len(got))
	}
}

// #390 review: at the account's item limit a new prompt is refused; an
// edit of a prompt the account holds adds no item, and still goes in,
// larger as it is.
func TestAnEditGoesInAtTheItemLimit(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "short")
	syncEach(t, mac)
	w.mu.Lock()
	for i := range 1999 {
		w.rev++
		id := fmt.Sprintf("setting.%d", i)
		w.items[id] = account.Item{Collection: "settings", ID: id, Rev: w.rev, Body: json.RawMessage(`1`)}
	}
	w.maxItems = 2000
	w.mu.Unlock()
	savePrompt(t, mac, "", "", "new")
	syncRefusedForQuota(t, mac)
	savePrompt(t, mac, p.ID, "", "short, now "+strings.Repeat("longer ", 20))
	w.mu.Lock()
	before := w.posts
	w.mu.Unlock()
	syncRefusedForQuota(t, mac)
	w.mu.Lock()
	asked := w.posts - before
	w.mu.Unlock()
	if body := w.livePrompts()[p.ID]; asked == 0 || !strings.Contains(body, "longer") {
		t.Fatalf("%d pushes asked, the account's copy %s; want the edit in", asked, body)
	}
}

// #390 review: at the account's item limit a draft is refused; another
// device's delete (of an item that is no prompt, so the account's prompts
// weigh as much as before) frees room, and the draft goes in at the next
// sync.
func TestSpaceAnotherDeviceFreesLetsADraftIn(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	savePrompt(t, mac, "", "", "kept")
	syncEach(t, mac)
	w.mu.Lock()
	for i := range 1999 {
		w.rev++
		id := fmt.Sprintf("setting.%d", i)
		w.items[id] = account.Item{Collection: "settings", ID: id, Rev: w.rev, Body: json.RawMessage(`1`)}
	}
	w.maxItems = 2000
	w.mu.Unlock()
	draft := savePrompt(t, mac, "", "", "draft")
	syncRefusedForQuota(t, mac)
	w.mu.Lock()
	w.tombstone("setting.0")
	w.mu.Unlock()
	syncEach(t, mac)
	if _, in := w.livePrompts()[draft.ID]; !in {
		t.Fatal("the draft is not in the account after another device made room")
	}
}

// #390 review: a delete made here frees room in the same round a draft
// that didn't fit goes again: the deletes go first, and the writes that
// fit then go in while one that still doesn't stays here.
func TestADeleteHereMakesRoomInTheSameRound(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	savePrompt(t, mac, "", "", "kept")
	k := savePrompt(t, mac, "", "", strings.Repeat("k", 200))
	syncEach(t, mac)
	quota := w.usedBytes() + 10
	w.mu.Lock()
	w.quotaBytes = quota
	w.mu.Unlock()
	draft := savePrompt(t, mac, "", "", strings.Repeat("d", 100))
	syncRefusedForQuota(t, mac)
	if _, err := mac.DeletePrompt(k.ID); err != nil {
		t.Fatal(err)
	}
	huge := savePrompt(t, mac, "", "", strings.Repeat("h", 300))
	syncRefusedForQuota(t, mac)
	live := w.livePrompts()
	_, kIn := live[k.ID]
	_, draftIn := live[draft.ID]
	_, hugeIn := live[huge.ID]
	if kIn || !draftIn || hugeIn {
		t.Fatalf("in the account: k %v, the draft %v, the huge one %v; want only the draft", kIn, draftIn, hugeIn)
	}
}

// Item E, #390 r15: the service takes a prompt's and a machine's delete,
// then its history is restored to one that still holds both. The deletes
// stay pending, the round that found them back is incomplete (no new good
// sync), and the next sync deletes them there again.
func TestWhatWasDeletedHereThatARestoredHistoryHoldsIsDeletedThereAgain(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	a := savePrompt(t, mac, "", "", "a")
	savePrompt(t, mac, "", "", "b")
	if err := mac.SaveMachine(Machine{Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	syncEach(t, mac)
	id := syncIDs(t, mac)["root@pi:22"]
	prompt, host := w.live()[a.ID], w.live()[id]
	if _, err := mac.DeletePrompt(a.ID); err != nil {
		t.Fatal(err)
	}
	if err := mac.RemoveMachine("root@pi:22"); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.afterPush = func() {
		w.startOver()
		for _, it := range []account.Item{prompt, host} {
			w.rev++
			it.Rev = w.rev
			w.items[it.ID] = it
		}
	}
	w.mu.Unlock()
	before, err := mac.loadSyncState()
	if err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(context.Background()); !errors.Is(err, errDeleteUndone) {
		t.Fatalf("%v; want the round incomplete while the restored deletes wait", err)
	}
	if state, _ := mac.loadSyncState(); *state.LastSync != *before.LastSync {
		t.Fatalf("last good sync %+v; want it left at %+v", *state.LastSync, *before.LastSync)
	}
	syncEach(t, mac)
	if _, back := promptsOf(t, mac)[a.ID]; back {
		t.Fatal("the deleted prompt is back here")
	}
	live := w.live()
	if _, held := live[a.ID]; held {
		t.Fatal("the restored account still holds the deleted prompt")
	}
	if _, held := live[id]; held {
		t.Fatal("the restored account still holds the removed machine")
	}
}

// otherDeviceWritesLocked is anotherDeviceWrites with w.mu held (as in a
// hook).
func (w *syncWorker) otherDeviceWritesLocked(id, text string) {
	w.otherDeviceWritesBodyLocked(id, fmt.Sprintf(`{"text":%q,"order":0}`, text))
}

// otherDeviceWritesBodyLocked is another device writing prompt id's body
// as is (its JSON text, byte for byte). w.mu must be held.
func (w *syncWorker) otherDeviceWritesBodyLocked(id, body string) {
	w.rev++
	it := w.items[id]
	it.Collection, it.ID, it.Deleted = "prompts", id, false
	it.Rev, it.UpdatedMs, it.Body = w.rev, w.nowMs(), json.RawMessage(body)
	w.items[id] = it
}

// #359 round 5: an edit here of a prompt another device deleted is pushed
// back against the tombstone's revision; the service's rate limit stops
// it, and the tombstone is pruned meanwhile (the floor rises to it, so the
// next pull is an empty incremental one, not a reset). The service turns
// the stale base down with no copy: the same sync takes that as the
// account holding nothing, and sends the edit again as a new item.
func TestAnEditAgainstAPrunedTombstoneGetsIn(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v1")
	syncEach(t, mac)
	edited := savePrompt(t, mac, p.ID, "", "edited here")
	w.mu.Lock()
	w.tombstone(p.ID)
	w.rateLimit, w.windowPosts = 1, 1
	w.mu.Unlock()
	var api *account.APIError
	if err := mac.SyncMachines(context.Background()); !errors.As(err, &api) || api.Status != http.StatusTooManyRequests {
		t.Fatalf("%v; want the rate limit", err)
	}
	w.mu.Lock()
	w.prune(p.ID)
	w.rateLimit = 0
	w.mu.Unlock()
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got != edited || !strings.Contains(body, "edited here") {
		t.Fatalf("mac's prompt %+v, the account's %q; want the edit in both", got, body)
	}
}

// #359 round 5: an upload of v1 the service received lands late, while an
// unrelated prompt uploads, after v0 was saved here again. The readback
// shows v1; the next sync still knows v1 was this device's write, so v0
// (the newer edit) stays here and goes to the account.
func TestALateUploadSeenOnReadbackDoesNotEraseARevert(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	syncGivingUpTheUpload(t, w, mac)
	reverted := savePrompt(t, mac, p.ID, "", "v0")
	savePrompt(t, mac, "", "", "unrelated")
	w.mu.Lock()
	w.onPush = w.landHeldLocked
	w.mu.Unlock()
	syncEach(t, mac)
	if body := w.livePrompts()[p.ID]; !strings.Contains(body, `"v1"`) {
		t.Fatalf("the account's copy: %s; want v1 landed late", body)
	}
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got != reverted || !strings.Contains(body, `"v0"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want v0 in both", got, body)
	}
}

// #359 round 5, #390 r9: a prompt deleted here after its first upload
// reached the service, and before it committed, stays deleted when the
// upload lands later: the delete waits for a copy to delete, and the round
// that leaves it waiting is incomplete.
func TestALateFirstUploadDoesNotBringBackAPromptDeletedHere(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "short-lived")
	syncGivingUpTheUpload(t, w, mac)
	if _, err := mac.DeletePrompt(p.ID); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(context.Background()); !errors.Is(err, errDeleteHeldBack) {
		t.Fatalf("%v; want the round incomplete while the delete waits", err)
	}
	w.landHeld()
	syncEach(t, mac)
	if _, back := promptsOf(t, mac)[p.ID]; back {
		t.Fatal("the deleted prompt is back here")
	}
	if _, held := w.livePrompts()[p.ID]; held {
		t.Fatal("the account still holds the deleted prompt")
	}
}

// #359 round 5: with one prompt slot and 81 bytes left, a draft too large
// for the bytes doesn't keep the slot from a later one that fits both.
func TestADraftPastTheQuotaDoesNotHoldTheLastSlot(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	for i := range account.PromptsCap - 1 {
		w.seedPrompt(fmt.Sprintf("00000000-0000-4000-9000-%012d", i), fmt.Sprintf(`{"text":"seeded","order":%d}`, i))
	}
	mac := device(t, srv)
	syncEach(t, mac)
	quota := w.usedBytes() + 81
	w.mu.Lock()
	w.quotaBytes = quota
	w.mu.Unlock()
	draft := savePrompt(t, mac, "", "", strings.Repeat("d", 500))
	small := savePrompt(t, mac, "", "", "small")
	syncRefusedForQuota(t, mac)
	live := w.livePrompts()
	if _, in := live[small.ID]; !in {
		t.Fatal("the prompt that fits is not in the account")
	}
	if _, in := live[draft.ID]; in {
		t.Fatal("the draft past the quota is in the account")
	}
}

// #359 round 5: another device edits the prompt between this device's
// pull and every push: the round sends at most syncPasses times, then
// fails, leaving the last good sync as it was.
func TestARoundThatStaysConflictedFails(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v1")
	syncEach(t, mac)
	before, _ := mac.AccountSyncStatus()
	savePrompt(t, mac, p.ID, "", "from the mac")
	n := 0
	var bump func()
	bump = func() {
		n++
		w.otherDeviceWritesLocked(p.ID, fmt.Sprintf("from linux %d", n))
		w.onPush = bump
	}
	w.mu.Lock()
	w.onPush, w.posts = bump, 0
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); !errors.Is(err, errSyncConflicted) {
		t.Fatalf("%v; want the round to fail as conflicted", err)
	}
	w.mu.Lock()
	posts := w.posts
	w.mu.Unlock()
	if after, _ := mac.AccountSyncStatus(); posts != syncPasses || after != before || !mac.AccountState().SyncFailed {
		t.Fatalf("%d pushes, last sync %+v (was %+v), needs attention %v; want %d, unchanged, true", posts, after, before, mac.AccountState().SyncFailed, syncPasses)
	}
}

// A batch with no prompt write, or an answer that changes nothing (a
// host-only delete, a refusal of no records), doesn't touch the sync
// state: not even a damaged one, which a real change would stop at.
func TestNoOpJournalUpdatesLeaveTheStateAlone(t *testing.T) {
	d := newDesk(t.TempDir())
	if err := os.WriteFile(d.syncStatePath(), []byte("{damaged"), 0o600); err != nil {
		t.Fatal(err)
	}
	deletes := []account.Change{{Collection: "prompts", ID: "00000000-0000-4000-8000-000000000001", Base: 3, Deleted: true}}
	hosts := []account.Change{{Collection: "hosts", ID: "00000000-0000-4000-8000-000000000002", Base: 3, Deleted: true}}
	part, sent, _, err := d.recordAttempts(context.Background(), "acct", deletes, 0)
	if err != nil || len(sent) != 0 || len(part) != 1 {
		t.Fatalf("recording a delete-only batch: %v, %v, %v", part, sent, err)
	}
	if err := d.settleSend(context.Background(), "acct", 0, sent, nil); err != nil {
		t.Fatalf("a refusal of no records: %v", err)
	}
	if err := d.settleSend(context.Background(), "acct", 0, nil, &pushOutcome{applied: []appliedChange{{Change: hosts[0], Rev: 4}}}); err != nil {
		t.Fatalf("an answer to a host-only delete: %v", err)
	}
}

// #390 review: an upload of v1 is held past cancellation; the identical
// retry (same fields, same base) is refused (429), and v0 is saved again.
// The refusal retires only the retry's own record: when the held request
// commits v1, the next sync still knows it was this device's write, and
// keeps v0 here and in the account.
func TestARefusedRetryKeepsTheRecordOfAnOlderRequest(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	syncGivingUpTheUpload(t, w, mac)
	w.mu.Lock()
	w.rateLimit, w.windowPosts = 1, 1
	w.mu.Unlock()
	var api *account.APIError
	if err := mac.SyncMachines(context.Background()); !errors.As(err, &api) || api.Status != http.StatusTooManyRequests {
		t.Fatalf("%v; want the rate limit", err)
	}
	w.mu.Lock()
	w.rateLimit = 0
	w.mu.Unlock()
	reverted := savePrompt(t, mac, p.ID, "", "v0")
	w.landHeld()
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got != reverted || !strings.Contains(body, `"v0"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want v0 in both", got, body)
	}
}

// #390 review: while a new prompt's first upload is on its way, another
// device creates the same id and a newer version is saved here. The
// service turns the create down; the newer version, not the one sent, is
// what this device holds, so it is kept and sent over the other device's.
// One still equal to the version sent takes the other device's copy.
func TestAFirstCreateConflictKeepsANewerEditSavedMeanwhile(t *testing.T) {
	for _, saveNewer := range []bool{true, false} {
		quietSync(t)
		w, srv := newWorker(t, "")
		mac := device(t, srv)
		const id = "00000000-0000-4000-8000-000000000001"
		if _, err := mac.ImportSavedPrompts([]SavedPrompt{{ID: id, Text: "v1"}}); err != nil {
			t.Fatal(err)
		}
		w.mu.Lock()
		w.onPush = func() {
			w.otherDeviceWritesLocked(id, "from linux")
			if saveNewer {
				savePrompt(t, mac, id, "", "v2")
			}
		}
		w.mu.Unlock()
		syncEach(t, mac)
		want := "from linux"
		if saveNewer {
			want = "v2"
		}
		if got, body := promptsOf(t, mac)[id], w.livePrompts()[id]; got.Text != want || !strings.Contains(body, want) {
			t.Fatalf("saved a newer version %v: mac's prompt %+v, the account's %s; want %q in both", saveNewer, got, body, want)
		}
	}
}

// #390 review: a batch is refused for the quota, another device frees
// room before its halves go, and both land: the round finished well.
func TestAQuotaSplitWhosePartsAllLandCompletesTheRound(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	k := savePrompt(t, mac, "", "", strings.Repeat("k", 300))
	syncEach(t, mac)
	quota := w.usedBytes() + 10
	w.mu.Lock()
	w.quotaBytes = quota
	w.onPush = func() {
		w.onPush = func() { w.tombstone(k.ID) }
	}
	w.mu.Unlock()
	a := savePrompt(t, mac, "", "", strings.Repeat("a", 100))
	b := savePrompt(t, mac, "", "", strings.Repeat("b", 100))
	syncEach(t, mac)
	live := w.livePrompts()
	if _, in := live[a.ID]; !in {
		t.Fatal("a is not in the account")
	}
	if _, in := live[b.ID]; !in {
		t.Fatal("b is not in the account")
	}
	if mac.AccountState().SyncFailed {
		t.Fatal("a round whose writes all landed needs attention")
	}
}

// #390 round 2: a new prompt deleted here between the merge that planned
// its first upload and the upload itself is not sent, and stays deleted.
func TestAPromptDeletedBetweenPlanningAndPostIsNotSent(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	w.seedPrompt("00000000-0000-4000-8000-000000000001", `{"text":"from the phone","order":0}`)
	mac := device(t, srv)
	draft := savePrompt(t, mac, "", "", "draft")
	deleted := false
	publishSavedPrompts = func([]SavedPrompt) {
		// The merge took in the phone's prompt and is about to push. (The
		// delete publishes too: only the first call deletes.)
		if !deleted {
			deleted = true
			if _, err := mac.DeletePrompt(draft.ID); err != nil {
				t.Error(err)
			}
		}
	}
	syncEach(t, mac, mac)
	if _, held := w.livePrompts()[draft.ID]; held {
		t.Fatal("the deleted draft was uploaded")
	}
	if _, back := promptsOf(t, mac)[draft.ID]; back {
		t.Fatal("the deleted draft is back here")
	}
}

// #390 round 2: an edit here (B) is turned down against another device's
// (L); the user saves the agreed text (A) again meanwhile, and another
// device then saves B on its own. The turned-down send is no proof this
// device's B landed: the account's B is the other device's edit, taken
// here, not overwritten with A.
func TestATurnedDownSendIsNotTakenForALandedWrite(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "A")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "B")
	w.mu.Lock()
	w.onPush = func() {
		w.otherDeviceWritesLocked(p.ID, "L")
		savePrompt(t, mac, p.ID, "", "A")
		w.onPull = func() { w.otherDeviceWritesLocked(p.ID, "B") }
	}
	w.mu.Unlock()
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "B" || !strings.Contains(body, `"B"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the other device's B in both", got, body)
	}
}

// #390 round 2: a sign-in to another account completes between two passes
// of a round (a real handoff redeemed here). The round was the first
// account's: it is abandoned, nothing goes to the second account, and the
// first account's sync state is left as it was.
func TestARoundStaysWithTheAccountItBeganOn(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v1")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "edited on the mac")
	w.mu.Lock()
	w.onPush = func() { w.otherDeviceWritesLocked(p.ID, "from linux") }
	w.mu.Unlock()
	var once sync.Once
	publishSyncedMachines = func([]SyncedMachine) {
		// The first pass ended (turned down); before the next one starts,
		// another account's sign-in completes.
		once.Do(func() {
			if _, err := mac.account.StartSignIn("google"); err != nil {
				t.Error(err)
				return
			}
			if _, err := mac.account.FinishSignIn(context.Background(), strings.Repeat("c", 43)); err != nil {
				t.Error(err)
			}
		})
	}
	if err := mac.SyncMachines(context.Background()); err != nil {
		t.Fatalf("an abandoned round: %v; want nothing to report", err)
	}
	if cur, _ := mac.account.Current(); cur == nil || cur.AccountID != "acct-2" {
		t.Fatalf("the session: %+v; want the second account's", cur)
	}
	w.mu.Lock()
	asSecond := w.asSecond
	w.mu.Unlock()
	state, err := mac.loadSyncState()
	if err != nil || asSecond != 0 || state.AccountID != "acct" {
		t.Fatalf("%d requests as the second account, sync state of %q (%v); want none, the first account's", asSecond, state.AccountID, err)
	}
	if body := w.livePrompts()[p.ID]; !strings.Contains(body, "from linux") {
		t.Fatalf("the first account's copy: %s; want linux's, untouched by the abandoned round", body)
	}
}

// #390 round 2: a tombstone revision is kept only while something here
// may write the item again: once a prompt deleted elsewhere is gone here
// too, its revision goes as well.
func TestATombstoneNothingHereUsesIsNotKept(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	a := savePrompt(t, mac, "", "", "a")
	savePrompt(t, mac, "", "", "b")
	syncEach(t, mac)
	w.mu.Lock()
	w.tombstone(a.ID)
	w.mu.Unlock()
	syncEach(t, mac)
	if _, kept := promptsOf(t, mac)[a.ID]; kept {
		t.Fatal("the prompt deleted elsewhere is still here")
	}
	state, err := mac.loadSyncState()
	if err != nil {
		t.Fatal(err)
	}
	if rev, kept := state.Removed["prompts/"+a.ID]; kept {
		t.Fatalf("the tombstone's revision %d is kept for a prompt nothing here holds", rev)
	}
}

// #359 round 6, #390 rounds 3 and 4: forty edits of each of five prompts,
// each round's upload failing with no answer, keep the journal bounded (at
// most maxVariants entries per prompt, a few open sends each, no body),
// and once the service answers again, and the sends are too old to land,
// the newest edits go.
func TestRepeatedFailedUploadsKeepTheJournalBounded(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	ps := make([]SavedPrompt, 5)
	for i := range ps {
		ps[i] = savePrompt(t, mac, "", "", fmt.Sprintf("secret body %d edit 0", i))
	}
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	for edit := range 40 {
		for i := range ps {
			ps[i] = savePrompt(t, mac, ps[i].ID, "", fmt.Sprintf("secret body %d edit %d", i, edit+1))
		}
		if err := mac.SyncMachines(context.Background()); err == nil {
			t.Fatal("a failed upload reported success")
		}
	}
	raw, err := os.ReadFile(mac.syncStatePath())
	if err != nil {
		t.Fatal(err)
	}
	state, _ := mac.loadSyncState()
	for i, p := range ps {
		if n := strings.Count(string(raw), fmt.Sprintf("secret body %d edit", i)); n > 0 {
			t.Fatalf("the journal keeps %d bodies of %s; want none", n, p.ID)
		}
		entries := state.PromptAttempts[p.ID]
		if len(entries) > maxVariants {
			t.Fatalf("journal of %s: %d entries; want at most %d", p.ID, len(entries), maxVariants)
		}
		for _, e := range entries {
			if len(e.Open) > maxOpenSends {
				t.Fatalf("journal of %s: %d open sends; want at most %d", p.ID, len(e.Open), maxOpenSends)
			}
		}
	}
	w.mu.Lock()
	w.failPush, w.serverAhead = false, pastDeadline
	w.mu.Unlock()
	for round := 0; mac.SyncMachines(context.Background()) != nil; round++ {
		if round == 3 {
			t.Fatal("still failing three rounds after the service came back")
		}
	}
	for _, p := range ps {
		if body := w.livePrompts()[p.ID]; !strings.Contains(body, p.Text) {
			t.Fatalf("the account's copy of %s: %s; want the newest edit %q", p.ID, body, p.Text)
		}
	}
}

// #359 round 6: a new prompt whose body is exactly the service's item
// limit without an order goes without one, rather than never.
func TestANewPromptTheOrderWouldMakeTooLargeGoesWithoutOne(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	// 8,186 quotes (2 bytes each as JSON) and a letter: {"text":"…"} is
	// exactly 16 KiB.
	text := strings.Repeat(`"`, 8186) + "a"
	if b := (account.PromptBody{Text: text}); !account.ValidPrompt(b) {
		t.Fatal("the fixture's body is past the limit on its own")
	}
	p := savePrompt(t, mac, "", "", text)
	syncEach(t, mac)
	body, in := w.livePrompts()[p.ID]
	if !in || strings.Contains(body, `"order"`) {
		t.Fatalf("the account's copy (held %v): %.40s…; want it without an order", in, body)
	}
}

// #359 r7, #390 r3: A and then B are sent, both failing with no answer; A
// is saved again and sent (the journal's A entry, reused), and another
// device creates the same id first. The last send was A, not B: with A
// still saved here the other device's copy is taken; with B saved while
// that POST was out, B is a newer edit, kept and sent.
func TestTheLastSendTellsANewerEditFromTheSentCopy(t *testing.T) {
	for _, saveDuring := range []bool{false, true} {
		quietSync(t)
		w, srv := newWorker(t, "")
		mac := device(t, srv)
		p := savePrompt(t, mac, "", "", "A")
		w.mu.Lock()
		w.failPush = true
		w.mu.Unlock()
		for _, text := range []string{"B", "A"} {
			if err := mac.SyncMachines(context.Background()); err == nil {
				t.Fatal("a failed upload reported success")
			}
			savePrompt(t, mac, p.ID, "", text)
		}
		w.mu.Lock()
		w.failPush = false
		w.onPush = func() {
			w.otherDeviceWritesLocked(p.ID, "X")
			if saveDuring {
				savePrompt(t, mac, p.ID, "", "B")
			}
		}
		w.mu.Unlock()
		syncEach(t, mac)
		want := "X"
		if saveDuring {
			want = "B"
		}
		if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != want || !strings.Contains(body, `"`+want+`"`) {
			t.Fatalf("saved B during the POST %v: mac's prompt %+v, the account's %s; want %s in both", saveDuring, got, body, want)
		}
	}
}

// #390 r3: an upload of T is held; the agreed text is saved again here;
// then the account is restored to an older revision where the prompt was
// T. That older row is no upload landing (its revision is not past the
// send's base): it is taken here, not overwritten with the agreed text.
func TestAnOlderRestoredRowIsNotTakenForALandedUpload(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	const id = "00000000-0000-4000-8000-000000000001"
	w.seedPrompt(id, `{"text":"T","order":0}`)
	w.mu.Lock()
	backup := w.items[id]
	w.mu.Unlock()
	mac := device(t, srv)
	syncEach(t, mac)
	w.anotherDeviceWrites(id, "agreed")
	syncEach(t, mac)
	savePrompt(t, mac, id, "", "T")
	syncGivingUpTheUpload(t, w, mac)
	savePrompt(t, mac, id, "", "agreed")
	w.mu.Lock()
	w.restoreTo(backup.Rev)
	w.items[id] = backup
	w.mu.Unlock()
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[id], w.livePrompts()[id]; got.Text != "T" || !strings.Contains(body, `"T"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the restored T in both", got, body)
	}
}

// #390 r3: an answer applied at the send's own base (the account already
// held that copy, and kept its revision) settles only that send; one
// applied at a new revision settles every send at that base.
func TestOnlyAnAnswerAtANewRevisionSettlesEarlierSends(t *testing.T) {
	d := newDesk(t.TempDir())
	const id = "00000000-0000-4000-8000-000000000001"
	if err := d.storeSyncState(syncState{AccountID: "acct", PromptAttempts: map[string][]promptAttempt{id: {
		{Base: 5, Hash: "A", Open: []string{"a1"}},
		{Base: 5, Hash: "B", Open: []string{"b1", "b2"}},
	}}}); err != nil {
		t.Fatal(err)
	}
	answer := func(send string, rev int64) {
		t.Helper()
		out := &pushOutcome{applied: []appliedChange{{Change: account.Change{Collection: "prompts", ID: id, Body: account.PromptBody{Text: "B"}}, Rev: rev}}}
		if err := d.settleSend(context.Background(), "acct", 0, map[string]sentAttempt{id: {ID: send, Base: 5}}, out); err != nil {
			t.Fatal(err)
		}
	}
	answer("b2", 5)
	state, _ := d.loadSyncState()
	if entries := state.PromptAttempts[id]; len(entries) != 2 || !slices.Equal(entries[0].Open, []string{"a1"}) || !slices.Equal(entries[1].Open, []string{"b1"}) {
		t.Fatalf("after an answer at the base: %+v; want only b2 settled", entries)
	}
	answer("b1", 6)
	state, _ = d.loadSyncState()
	if entries := state.PromptAttempts[id]; len(entries) != 0 {
		t.Fatalf("after an answer at a new revision: %+v; want every send at the base settled", entries)
	}
}

// #390 r3: a restore (410) brings a prompt's row back to the base of a
// held upload, which therefore stays unsettled; when it lands late, it is
// recognised as this device's write, and the text saved here since (a
// revert) is kept and sent.
func TestARestoreBackToASendsBaseKeepsItUnsettled(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "A")
	syncEach(t, mac)
	w.mu.Lock()
	backup := w.items[p.ID]
	w.mu.Unlock()
	savePrompt(t, mac, p.ID, "", "B")
	syncGivingUpTheUpload(t, w, mac)
	savePrompt(t, mac, p.ID, "", "A")
	w.seedPrompt("00000000-0000-4000-8000-000000000002", `{"text":"other","order":5}`)
	syncEach(t, mac)
	w.anotherDeviceWrites(p.ID, "C")
	w.mu.Lock()
	w.restoreTo(backup.Rev)
	w.items[p.ID] = backup
	w.mu.Unlock()
	syncEach(t, mac)
	w.landHeld()
	if body := w.livePrompts()[p.ID]; !strings.Contains(body, `"B"`) {
		t.Fatalf("the account's copy: %s; want the held B landed", body)
	}
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "A" || !strings.Contains(body, `"A"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the revert A in both", got, body)
	}
}

// #359 r7, #390 r3: the push is refused for a stale credential (401) and
// the prompt is deleted here while the credential refreshes. The replay
// reads the saved prompts again: the deleted prompt is not uploaded.
func TestADeleteDuringACredentialRefreshIsNotUploaded(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	syncEach(t, mac)
	p := savePrompt(t, mac, "", "", "short-lived")
	w.mu.Lock()
	w.unauthorizeNextPush = true
	w.onRefresh = func() {
		if _, err := mac.DeletePrompt(p.ID); err != nil {
			t.Error(err)
		}
	}
	w.mu.Unlock()
	syncEach(t, mac, mac)
	w.mu.Lock()
	_, uploaded := w.items[p.ID]
	w.mu.Unlock()
	if uploaded {
		t.Fatal("the prompt deleted during the refresh was uploaded")
	}
	if _, back := promptsOf(t, mac)[p.ID]; back {
		t.Fatal("the deleted prompt is back here")
	}
}

// #359 r7, #390 r3: an edit of a synced prompt whose body is exactly the
// service's item limit without its order goes without one.
func TestAnEditTheOrderWouldMakeTooLargeGoesWithoutOne(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "short")
	syncEach(t, mac)
	text := strings.Repeat(`"`, 8186) + "a"
	savePrompt(t, mac, p.ID, "", text)
	syncEach(t, mac)
	body := w.livePrompts()[p.ID]
	if !strings.Contains(body, `\"a`) || strings.Contains(body, `"order"`) {
		t.Fatalf("the account's copy: %.40s…; want the edit without an order", body)
	}
}

// #359 r7 and r11, #390 r3, r6 and r7: which sends may have written a row
// (promptAttempt.mayHaveWritten), the rule the one matcher applies before
// it hashes anything (landedEntry): an open send, or the trimmed ones,
// based below the row, with no deadline or one the row's stamp is not past
// (or no stamp).
func TestWhichSendsMayHaveWrittenARow(t *testing.T) {
	a := promptAttempt{Base: 3, Open: []string{"s1", "s2"}, Deadlines: map[string]int64{"s1": 1000, "s2": 2000}}
	for _, c := range []struct {
		name           string
		a              promptAttempt
		rev, updatedMs int64
		want           bool
	}{
		{"a row past the base, within a deadline", a, 4, 1500, true},
		{"a row at the base", a, 3, 500, false},
		{"a row stamped past every deadline", a, 4, 2500, false},
		{"a row with no stamp", a, 4, 0, true},
		{"a send with no deadline", promptAttempt{Base: 3, Open: []string{"s"}}, 4, 9000, true},
		{"a trimmed send within its deadline", promptAttempt{Base: 3, Open: []string{"s"}, Deadlines: map[string]int64{"s": 1000, "": 3000}}, 4, 2500, true},
	} {
		if got := c.a.mayHaveWritten(c.rev, c.updatedMs); got != c.want {
			t.Errorf("%s: %v; want %v", c.name, got, c.want)
		}
	}
	row := account.RemotePrompt{ID: "p", Rev: 4, Body: account.PromptBody{Text: "t"}}
	entries := []promptAttempt{{Base: 3, Hash: "another", Open: []string{"s"}}, {Base: 3, Hash: sendHash(row.Body), Open: []string{"s"}}}
	if got := landedEntry(row, entries); got != 1 {
		t.Fatalf("landed entry %d; want the one with the row's body", got)
	}
}

// BenchmarkMergeWithoutLandings measures a merge of 50 prompts none of whose
// sends may have written the account's row (nothing to hash).
func BenchmarkMergeWithoutLandings(b *testing.B) {
	var mirror []account.RemotePrompt
	var local []SavedPrompt
	baseline := map[string]promptFields{}
	attempts := map[string][]promptAttempt{}
	for i := range 50 {
		id := fmt.Sprintf("00000000-0000-4000-8000-%012d", i)
		mirror = append(mirror, account.RemotePrompt{ID: id, Rev: int64(i + 1), Body: account.PromptBody{Text: "t"}})
		local = append(local, SavedPrompt{ID: id, Text: "t"})
		baseline[id] = promptFields{Text: "t"}
		attempts[id] = []promptAttempt{{Base: int64(i + 1), Hash: "another", Open: []string{"s"}}}
	}
	b.ReportAllocs()
	for b.Loop() {
		mergePrompts(local, mirror, mirror, nil, nil, baseline, nil, attempts, nil, nil)
	}
}

// cancelAfterPull is a transport that ends the round (cancel) once a pull
// has been answered and read in full.
type cancelAfterPull struct {
	base   http.RoundTripper
	mu     sync.Mutex
	cancel context.CancelFunc
}

func (c *cancelAfterPull) RoundTrip(r *http.Request) (*http.Response, error) {
	resp, err := c.base.RoundTrip(r)
	if err != nil || r.Method != http.MethodGet || r.URL.Path != "/v1/sync" {
		return resp, err
	}
	raw, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	resp.Body = io.NopCloser(bytes.NewReader(raw))
	c.mu.Lock()
	if c.cancel != nil {
		c.cancel()
	}
	c.mu.Unlock()
	return resp, err
}

// #359 r10: a round whose deadline passes after its pull, while it waits
// for the store, applies none of it: the account's v1 is not taken here.
func TestARoundPastItsDeadlineAppliesNoMerge(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	transport := &cancelAfterPull{base: srv.Client().Transport}
	raw, _ := json.Marshal(map[string]string{"refresh_token": fmt.Sprintf("r1.%022d.%043d", 1, 0), "account_id": "acct"})
	mac.account = account.New(srv.URL, "linux", &signedInStore{raw: raw}, &http.Client{Transport: transport})
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	w.anotherDeviceWrites(p.ID, "v1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transport.mu.Lock()
	transport.cancel = cancel
	transport.mu.Unlock()
	if err := mac.SyncMachines(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("%v; want the round ended", err)
	}
	if got := promptsOf(t, mac)[p.ID]; got.Text != "v0" {
		t.Fatalf("mac's prompt %+v; want v0, the merge not applied", got)
	}
}

// #359 r8: a push the service refuses for its size (413) is halved like
// one past the quota, and what fits goes in; a lone prompt it still
// refuses stays here and leaves the round incomplete.
func TestAPushTooLargeIsHalved(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	w.mu.Lock()
	w.maxPushBytes = 15 * 1024 // under one 16 KiB prompt, over one 8 KB one
	w.mu.Unlock()
	var ps []SavedPrompt
	for i := range 5 {
		ps = append(ps, savePrompt(t, mac, "", "", fmt.Sprintf("%d", i)+strings.Repeat("x", 8000)))
	}
	huge := savePrompt(t, mac, "", "", "h"+strings.Repeat(`"`, 8100))
	var api *account.APIError
	if err := mac.SyncMachines(context.Background()); !errors.As(err, &api) || api.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("%v; want the round incomplete with the lone refusal", err)
	}
	live := w.livePrompts()
	for _, p := range ps {
		if _, in := live[p.ID]; !in {
			t.Fatalf("%.10s… is not in the account", p.Text)
		}
	}
	if _, in := live[huge.ID]; in {
		t.Fatal("the prompt past the size limit is in the account")
	}
	if _, kept := promptsOf(t, mac)[huge.ID]; !kept {
		t.Fatal("the prompt past the size limit was dropped here")
	}
}

// #359 r8: an upload of v1 is refused for its credential (401) and the
// refresh then fails (503). The refusal wrote nothing: when another device
// later saves v1 on its own, it is that device's edit, taken here (where
// v0 was saved again since), not this device's upload landing.
func TestACredentialRefusalLeavesNoSendOpenWhenTheRefreshFails(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.mu.Lock()
	w.unauthorizeNextPush, w.failNextRefresh = true, true
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a sync whose refresh failed reported success")
	}
	savePrompt(t, mac, p.ID, "", "v0")
	w.anotherDeviceWrites(p.ID, "v1")
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v1" || !strings.Contains(body, `"v1"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the other device's v1 in both", got, body)
	}
}

// #359 r8: a state from before keeps a send id, sequence number, base and
// body with each prompt's last send, and a global counter; it still loads,
// and the last send keeps what the merge reads (its hash).
func TestAStateWithTheOldLastSendFieldsLoads(t *testing.T) {
	d := newDesk(t.TempDir())
	const id = "00000000-0000-4000-8000-000000000001"
	old := fmt.Sprintf(`{"accountId":"acct","mirror":{"rev":0,"hosts":null},"sendSeq":7,"promptLastSent":{%q:{"hash":"h","id":"s1","seq":3,"base":2,"body":{"text":"t"}}}}`, id)
	if err := os.WriteFile(d.syncStatePath(), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := d.loadSyncState()
	if err != nil {
		t.Fatal(err)
	}
	if last := state.PromptLastSent[id]; last.Hash != "h" {
		t.Fatalf("last send %+v; want its hash kept", last)
	}
}

// failEdits saves each text over p and syncs it with the service answering
// no push (503): each stays an unanswered send.
func failEdits(t *testing.T, w *syncWorker, d *Desk, p SavedPrompt, texts ...string) {
	t.Helper()
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	for _, text := range texts {
		savePrompt(t, d, p.ID, "", text)
		if err := d.SyncMachines(context.Background()); err == nil {
			t.Fatalf("an unanswered upload of %.10s… reported success", text)
		}
	}
	w.mu.Lock()
	w.failPush = false
	w.mu.Unlock()
}

// heldBack syncs d, which has an edit waiting for a slot in the journal.
func heldBack(t *testing.T, w *syncWorker, d *Desk, id, want string) {
	t.Helper()
	if err := d.SyncMachines(context.Background()); !errors.Is(err, errEditHeldBack) {
		t.Fatalf("%v; want the edit held back", err)
	}
	if body := w.livePrompts()[id]; !strings.Contains(body, want) {
		t.Fatalf("the account's copy: %.40s; want %q still", body, want)
	}
}

// serverClock sets the service's clock ahead of the device's by ahead.
func serverClock(w *syncWorker, ahead time.Duration) {
	w.mu.Lock()
	w.serverAhead = ahead
	w.mu.Unlock()
}

// pastDeadline is a service clock past the not_after of sends made at 0
// (two minutes past the newest now_ms seen).
const pastDeadline = 2*time.Minute + 5*time.Second

// #390 r4 and r5, themartianapp/herdrup#826: v1's upload is held and v2's
// goes unanswered, filling the journal; v3, saved since, waits while they
// might still land. Past their not_after the held push is refused when it
// arrives, a pull settles both, and v3 goes; no older body is sent again.
func TestAHeldPushPastItsDeadlineIsRefusedAndFreesItsSlot(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", strings.Repeat("1", 6000))
	syncGivingUpTheUpload(t, w, mac)
	failEdits(t, w, mac, p, strings.Repeat("2", 6000))
	savePrompt(t, mac, p.ID, "", "v3")
	heldBack(t, w, mac, p.ID, `"v0"`)
	serverClock(w, time.Minute)
	heldBack(t, w, mac, p.ID, `"v0"`)
	serverClock(w, pastDeadline)
	w.landHeld()
	if body := w.livePrompts()[p.ID]; !strings.Contains(body, `"v0"`) {
		t.Fatalf("the account's copy: %.40s; want the held push past its not_after refused", body)
	}
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v3" || !strings.Contains(body, `"v3"`) {
		t.Fatalf("mac's prompt %+v, the account's %.40s; want v3 in both", got, body)
	}
}

// #390 r5: an entry's deadline is its newest send's: v1 sent again a
// minute and a half on (unanswered again) may land until two minutes
// after that.
func TestAnIdenticalResendMovesItsDeadline(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	failEdits(t, w, mac, p, "v1")
	serverClock(w, 90*time.Second)
	failEdits(t, w, mac, p, "v1", "v2")
	savePrompt(t, mac, p.ID, "", "v3")
	serverClock(w, pastDeadline+30*time.Second)
	heldBack(t, w, mac, p.ID, `"v0"`)
}

// #390 r5: deadlines run on the service's clock alone: with the device's
// clock half an hour ahead of it, or behind it, no time has passed for the
// sends, and the edit still waits.
func TestTheDeadlineRunsOnTheServicesClock(t *testing.T) {
	for _, ahead := range []time.Duration{-30 * time.Minute, 30 * time.Minute} {
		quietSync(t)
		w, srv := newWorker(t, "")
		w.serverAhead = ahead
		mac := device(t, srv)
		p := savePrompt(t, mac, "", "", "v0")
		syncEach(t, mac)
		failEdits(t, w, mac, p, "v1", "v2")
		savePrompt(t, mac, p.ID, "", "v3")
		heldBack(t, w, mac, p.ID, `"v0"`)
	}
}

// #390 r5: without now_ms (a service without #826) nothing settles by
// time and the round stays incomplete: a pull without it settles no send
// (and the device's clock, half an hour ahead, is not taken in its
// place); a send that went without a not_after can land at any time, so
// its entry never settles by time, even once a later identical send
// carries one.
func TestWithoutTheServicesClockNothingSettlesByTime(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	w.serverAhead = -30 * time.Minute
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	failEdits(t, w, mac, p, "v1", "v2")
	savePrompt(t, mac, p.ID, "", "v3")
	w.mu.Lock()
	w.noNow, w.serverAhead = true, -30*time.Minute+pastDeadline
	w.mu.Unlock()
	heldBack(t, w, mac, p.ID, `"v0"`)

	w, srv = newWorker(t, "")
	w.noNow = true
	mac = device(t, srv)
	p = savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	failEdits(t, w, mac, p, "v1", "v2")
	w.mu.Lock()
	w.noNow = false
	w.mu.Unlock()
	failEdits(t, w, mac, p, "v1", "v2")
	savePrompt(t, mac, p.ID, "", "v3")
	serverClock(w, pastDeadline)
	heldBack(t, w, mac, p.ID, `"v0"`)
}

// #390 r5 and r6: an upload refused for its credential (401), the answer
// cut off inside its body, still refreshes the credential by its status
// and goes again.
func TestACredentialRefusalCutInItsBodyIsReplayed(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.mu.Lock()
	w.breakNextRefusal = http.StatusUnauthorized
	w.mu.Unlock()
	syncEach(t, mac)
	if body := w.livePrompts()[p.ID]; !strings.Contains(body, `"v1"`) {
		t.Fatalf("the account's copy: %s; want v1 replayed", body)
	}
}

// #359 r9, #390 r5: an upload of v1 is refused, and the answer is cut off
// inside its body. The status line said nothing was written: when another
// device later saves v1, it is that device's edit, taken here (where v0
// was saved again since).
func TestARefusalCutInItsBodyLeavesNoSendOpen(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.mu.Lock()
	w.breakNextRefusal = http.StatusForbidden
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a sync whose refusal was cut off reported success")
	}
	savePrompt(t, mac, p.ID, "", "v0")
	w.anotherDeviceWrites(p.ID, "v1")
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v1" || !strings.Contains(body, `"v1"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the other device's v1 in both", got, body)
	}
}

// #390 r5: a round canceled after its pull and before its upload sends
// nothing and keeps no send: when another device saves v1, it is that
// device's edit, taken here (where v0 was saved again since).
func TestACanceledRoundKeepsNoSend(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	q := savePrompt(t, mac, "", "", "q0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.anotherDeviceWrites(q.ID, "q1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	previous := publishSavedPrompts
	publishSavedPrompts = func([]SavedPrompt) { cancel() } // the merge took q1: after the pull
	t.Cleanup(func() { publishSavedPrompts = previous })
	w.mu.Lock()
	posts := w.posts
	w.mu.Unlock()
	if err := mac.SyncMachines(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("%v; want the round canceled", err)
	}
	publishSavedPrompts = previous
	w.mu.Lock()
	sent := w.posts - posts
	w.mu.Unlock()
	if sent != 0 {
		t.Fatalf("%d uploads after the cancel; want none", sent)
	}
	savePrompt(t, mac, p.ID, "", "v0")
	w.anotherDeviceWrites(p.ID, "v1")
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v1" || !strings.Contains(body, `"v1"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the other device's v1 in both", got, body)
	}
}

// #359 r9, #390 r5: a push of deletes alone that the service refuses for
// its size is halved too, until each part fits.
func TestASizeRefusalHalvesADeleteOnlyPush(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	var ids []string
	for i := range 6 {
		ids = append(ids, savePrompt(t, mac, "", "", fmt.Sprintf("p%d", i)).ID)
	}
	syncEach(t, mac)
	for _, id := range ids {
		if _, err := mac.DeletePrompt(id); err != nil {
			t.Fatal(err)
		}
	}
	w.mu.Lock()
	w.maxPushBytes = 250 // two deletes, not six
	w.mu.Unlock()
	syncEach(t, mac)
	if live := w.livePrompts(); len(live) != 0 {
		t.Fatalf("the account still holds %d prompts; want every delete in", len(live))
	}
}

// #390 r5: v1's upload is held; v2's is in flight when v1 commits and
// v0 is saved again here, so v2 conflicts with v1; another device saves
// v3 before the next pull. The conflict recorded v1 as this device's
// landed write at once, so the revert to v0 is an edit against it: kept,
// and sent over v3.
func TestAConflictRecordsALandedUploadAtOnce(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	syncGivingUpTheUpload(t, w, mac)
	savePrompt(t, mac, p.ID, "", "v2")
	w.mu.Lock()
	w.onPush = func() {
		w.landHeldLocked()
		savePrompt(t, mac, p.ID, "", "v0")
	}
	w.afterPush = func() { w.otherDeviceWritesLocked(p.ID, "v3") }
	w.mu.Unlock()
	for round := 0; mac.SyncMachines(context.Background()) != nil; round++ {
		if round == 3 {
			t.Fatal("still failing three rounds on")
		}
	}
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v0" || !strings.Contains(body, `"v0"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the revert to v0 in both", got, body)
	}
}

// #390 r4: an upload of v1 is held (a new prompt's create, or an edit of
// one synced at v0); v2 is saved and sent, and v1 commits before v2 is
// applied, so v2 conflicts with v1. The conflict retires only v2's send:
// v1 is recognised as this device's write that landed, and v2, the newer
// edit, is kept and sent.
func TestAConflictKeepsTheEvidenceOfAnOlderUploadThatLanded(t *testing.T) {
	for _, synced := range []bool{false, true} {
		quietSync(t)
		w, srv := newWorker(t, "")
		mac := device(t, srv)
		p := savePrompt(t, mac, "", "", "v0")
		if synced {
			syncEach(t, mac)
		}
		savePrompt(t, mac, p.ID, "", "v1")
		syncGivingUpTheUpload(t, w, mac)
		savePrompt(t, mac, p.ID, "", "v2")
		w.mu.Lock()
		w.onPush = w.landHeldLocked
		w.mu.Unlock()
		for round := 0; mac.SyncMachines(context.Background()) != nil; round++ {
			if round == 3 {
				t.Fatalf("synced at v0 %v: still failing three rounds on", synced)
			}
		}
		if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v2" || !strings.Contains(body, `"v2"`) {
			t.Fatalf("synced at v0 %v: mac's prompt %+v, the account's %s; want v2 in both", synced, got, body)
		}
	}
}

// #390 r6: two prompts fit the service's size limit alone, not together,
// and every refusal's answer is cut off inside its body: the status alone
// still halves the push, and both go in.
func TestASizeRefusalCutInItsBodyStillHalves(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	a := savePrompt(t, mac, "", "", strings.Repeat("a", 6000))
	b := savePrompt(t, mac, "", "", strings.Repeat("b", 6000))
	w.mu.Lock()
	w.maxPushBytes, w.cutRefusals = 9000, true
	w.mu.Unlock()
	syncEach(t, mac)
	live := w.livePrompts()
	if _, in := live[a.ID]; !in {
		t.Fatal("the first prompt is not in the account")
	}
	if _, in := live[b.ID]; !in {
		t.Fatal("the second prompt is not in the account")
	}
}

// #390 r6: the only upload in flight sends v1; another device saves v1
// too (the same content, its JSON written otherwise), and v0 is saved
// again here. The service turns the upload down with that copy: the
// rejected upload is not taken for a landed one, so the other device's v1
// is taken here and stays in the account.
func TestAConflictIsNotTakenForItsOwnUploadLanding(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1<")
	w.mu.Lock()
	w.onPush = func() {
		w.otherDeviceWritesBodyLocked(p.ID, `{"text":"v1<","order":0}`)
		savePrompt(t, mac, p.ID, "", "v0")
	}
	w.mu.Unlock()
	for round := 0; mac.SyncMachines(context.Background()) != nil; round++ {
		if round == 3 {
			t.Fatal("still failing three rounds on")
		}
	}
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v1<" || !strings.Contains(body, `"v1<"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the other device's v1< in both", got, body)
	}
}

// #390 r6: an older upload of v1 (at order 0) is held; v2's upload is
// turned down because another device saved v1 at order 7, and v0 was
// saved again here. The copy is not this device's held body, so it is the
// other device's edit: taken here, not overwritten with v0.
func TestALandedMatchComparesTheWholeBodySent(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	syncGivingUpTheUpload(t, w, mac)
	savePrompt(t, mac, p.ID, "", "v2")
	w.mu.Lock()
	w.onPush = func() {
		w.otherDeviceWritesBodyLocked(p.ID, `{"text":"v1","order":7}`)
		savePrompt(t, mac, p.ID, "", "v0")
	}
	w.mu.Unlock()
	for round := 0; mac.SyncMachines(context.Background()) != nil; round++ {
		if round == 3 {
			t.Fatal("still failing three rounds on")
		}
	}
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v1" || !strings.Contains(body, `"order":7`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the other device's v1 in both", got, body)
	}
}

// #390 r6: prompt a is at the journal's bound with a new edit waiting, and
// b alone is past the quota. The dispatch sends only b and is refused;
// recovery splits what was sent, so b is not asked again.
func TestAQuotaRefusalSplitsWhatWasSent(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	a := savePrompt(t, mac, "", "", "a0")
	syncEach(t, mac)
	failEdits(t, w, mac, a, "a1", "a2")
	savePrompt(t, mac, a.ID, "", "a3")
	quota := w.usedBytes() + 10
	w.mu.Lock()
	w.quotaBytes = quota
	posts := w.posts
	w.mu.Unlock()
	savePrompt(t, mac, "", "", strings.Repeat("b", 100))
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a round with a refused write reported success")
	}
	w.mu.Lock()
	sent := w.posts - posts
	w.mu.Unlock()
	if sent != 1 {
		t.Fatalf("%d uploads; want b's one, not asked again", sent)
	}
}

// refusedEdits saves each text over p and syncs it with the service out of
// pushes (429): each send is refused.
func refusedEdits(t *testing.T, w *syncWorker, d *Desk, p SavedPrompt, texts ...string) {
	t.Helper()
	for _, text := range texts {
		w.mu.Lock()
		w.rateLimit, w.windowPosts = 1, 1
		w.mu.Unlock()
		savePrompt(t, d, p.ID, "", text)
		if err := d.SyncMachines(context.Background()); err == nil {
			t.Fatalf("a refused upload of %q reported success", text)
		}
	}
	w.mu.Lock()
	w.rateLimit = 0
	w.mu.Unlock()
}

// #390 r6: v1 and v2 go unanswered; a minute and a half on, identical
// retries are refused (429). The refusals take their own deadlines with
// them: once the unanswered sends' deadlines pass, v3 goes.
func TestRefusedRetriesKeepOlderSendsDeadlines(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	failEdits(t, w, mac, p, "v1", "v2")
	serverClock(w, 90*time.Second)
	refusedEdits(t, w, mac, p, "v1", "v2")
	savePrompt(t, mac, p.ID, "", "v3")
	serverClock(w, pastDeadline)
	syncEach(t, mac)
	if body := w.livePrompts()[p.ID]; !strings.Contains(body, `"v3"`) {
		t.Fatalf("the account's copy: %s; want v3 once the unanswered sends' deadlines passed", body)
	}
}

// #390 r6: a send that went without a deadline stays a send that can land
// at any time when more than maxOpenSends identical ones push it out of
// the entry's open ids: v1's and v2's entries never settle by time, and
// v3 waits.
func TestASendTrimmedFromTheJournalKeepsItsMissingDeadline(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	w.noNow = true
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	failEdits(t, w, mac, p, "v1", "v2")
	w.mu.Lock()
	w.noNow = false
	w.mu.Unlock()
	for range maxOpenSends {
		failEdits(t, w, mac, p, "v1", "v2")
	}
	savePrompt(t, mac, p.ID, "", "v3")
	serverClock(w, pastDeadline)
	heldBack(t, w, mac, p.ID, `"v0"`)
}

// #359 r10: a held upload of v1 lands while another prompt uploads, after
// v0 was saved here again; the readback shows v1, and another device
// saves v3 before the next pull. The readback recorded v1 as this
// device's landed write, so v0 is an edit against it: kept, and sent.
func TestALandingSeenOnReadbackIsRecordedAtOnce(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	syncGivingUpTheUpload(t, w, mac)
	reverted := savePrompt(t, mac, p.ID, "", "v0")
	savePrompt(t, mac, "", "", "unrelated")
	w.mu.Lock()
	w.onPush = w.landHeldLocked
	w.mu.Unlock()
	syncEach(t, mac)
	w.anotherDeviceWrites(p.ID, "v3")
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got != reverted || !strings.Contains(body, `"v0"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the revert to v0 in both", got, body)
	}
}

// #359 r10: a dispatch whose round ended while it waited for the store
// lock journals nothing.
func TestACanceledDispatchJournalsNothing(t *testing.T) {
	d := newDesk(t.TempDir())
	if err := d.storeSyncState(syncState{AccountID: "acct"}); err != nil {
		t.Fatal(err)
	}
	p := savePrompt(t, d, "", "", "v1")
	part := []account.Change{{Collection: "prompts", ID: p.ID, Body: promptBody(p, nil)}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, _, err := d.recordAttempts(ctx, "acct", part, 0); !errors.Is(err, context.Canceled) {
		t.Fatalf("%v; want the dispatch stopped", err)
	}
	if state, _ := d.loadSyncState(); len(state.PromptAttempts) != 0 {
		t.Fatalf("journal %+v; want nothing recorded", state.PromptAttempts)
	}
}

// #359 r11: a merge commits machines.json, prompts.json and
// account-sync.json as one. When its commit record can't be written,
// nothing changes; when a file can't be written after it, the next load
// finishes the commit, so no reader sees one file from after the merge
// and another from before it.
func TestAMergeCommitsItsFilesAsOne(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Nickname: "v0", Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	pi := syncIDs(t, mac)["root@pi:22"]
	w.mu.Lock()
	w.rev++
	w.items[pi] = account.Item{Collection: "hosts", ID: pi, Rev: w.rev, Body: json.RawMessage(`{"nickname":"v1","host":"pi","port":22,"username":"root"}`)}
	w.otherDeviceWritesLocked(p.ID, "v1")
	w.mu.Unlock()
	files := []string{mac.machinesPath(), mac.promptsPath(), mac.syncStatePath()}
	read := func() [][]byte {
		var out [][]byte
		for _, f := range files {
			raw, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			out = append(out, raw)
		}
		return out
	}
	blocked := func(path string) func() {
		if err := os.Mkdir(path+".tmp", 0o700); err != nil {
			t.Fatal(err)
		}
		return func() { _ = os.Remove(path + ".tmp") }
	}

	before := read()
	unblock := blocked(mac.commitPath())
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a merge whose commit couldn't be written reported success")
	}
	unblock()
	for i, raw := range read() {
		if !bytes.Equal(raw, before[i]) {
			t.Fatalf("%s changed though the commit failed:\n%s", files[i], raw)
		}
	}

	unblock = blocked(mac.promptsPath())
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a merge whose prompts couldn't be written reported success")
	}
	unblock()
	ms, err := mac.Machines()
	if err != nil || len(ms) != 1 || ms[0].Nickname != "v1" {
		t.Fatalf("mac's machines %+v (%v); want pi as v1", ms, err)
	}
	if got := promptsOf(t, mac)[p.ID]; got.Text != "v1" {
		t.Fatalf("mac's prompt %+v; want v1, the commit finished", got)
	}
	state, err := mac.loadSyncState()
	if err != nil || state.PromptBaseline[p.ID].Text != "v1" || state.Baseline[pi].Nickname != "v1" {
		t.Fatalf("baselines %+v, %+v (%v); want v1 for both", state.PromptBaseline[p.ID], state.Baseline[pi], err)
	}
	if _, err := os.Stat(mac.commitPath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the commit record is still there (%v)", err)
	}
}

// #359 r11: a pull in pages. The first shows this device's held upload of
// v1 landed; another device saves v3 before the second. v0 was saved here
// again meanwhile: the landing is recorded as the pages came, so v0 is an
// edit against v1, kept and sent over v3.
func TestALandingOnAnEarlierPageIsKept(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	q := savePrompt(t, mac, "", "", "q0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	syncGivingUpTheUpload(t, w, mac)
	reverted := savePrompt(t, mac, p.ID, "", "v0")
	w.landHeld()
	w.mu.Lock()
	w.otherDeviceWritesLocked(q.ID, "q1")
	w.pageSize = 1
	w.onNextPage = func() { w.otherDeviceWritesLocked(p.ID, "v3") }
	w.mu.Unlock()
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got != reverted || !strings.Contains(body, `"v0"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the revert to v0 in both", got, body)
	}
}

// #390 r7: an upload of v1 is held past its not_after and refused when it
// arrives; another device then saves the same v1, stamped after that
// deadline. It can't be this device's upload: it is taken here (where v0
// was saved again), not overwritten with v0.
func TestARowWrittenAfterTheDeadlineIsNotTheUpload(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	syncGivingUpTheUpload(t, w, mac)
	savePrompt(t, mac, p.ID, "", "v0")
	serverClock(w, pastDeadline)
	w.landHeld()
	w.anotherDeviceWrites(p.ID, "v1")
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v1" || !strings.Contains(body, `"v1"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the other device's v1 in both", got, body)
	}
}

// #390 r7: an upgrade from main, whose state kept only the title and text
// of a prompt's unanswered upload (promptsSent). v0 was agreed, v1 was
// uploaded (it landed, at order 0) and its reply lost, and v0 was saved
// again here. The migrated record matches v1 on title and text, so v0 is an
// edit against it: kept, and sent, as main did.
func TestAnUpgradeKeepsARevertOverAnOldUnansweredUpload(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	state, err := mac.loadSyncState()
	if err != nil {
		t.Fatal(err)
	}
	// main's form of the state (git show origin/main:app/desk_account_sync.go):
	// no journal, the upload in flight in promptsSent.
	old, _ := json.Marshal(map[string]any{"accountId": "acct", "mirror": state.Mirror, "promptsPulled": true,
		"promptBaseline": state.PromptBaseline, "promptsSent": map[string]any{p.ID: map[string]string{"text": "v1"}}})
	if err := os.WriteFile(mac.syncStatePath(), old, 0o600); err != nil {
		t.Fatal(err)
	}
	w.anotherDeviceWrites(p.ID, "v1") // the upload, landed
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v0" || !strings.Contains(body, `"v0"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the revert to v0 in both", got, body)
	}
}

// cancelOn is a transport that ends the round (cancel) once the nth answer
// to a method's requests has arrived and been read in full, running then
// first (on the round's side).
type cancelOn struct {
	base   http.RoundTripper
	method string
	mu     sync.Mutex
	nth    int
	seen   int
	cancel context.CancelFunc
	then   func()
}

func (c *cancelOn) RoundTrip(r *http.Request) (*http.Response, error) {
	resp, err := c.base.RoundTrip(r)
	if err != nil || r.Method != c.method || r.URL.Path != "/v1/sync" {
		return resp, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cancel == nil {
		return resp, nil
	}
	if c.seen++; c.seen != c.nth {
		return resp, nil
	}
	raw, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	resp.Body = io.NopCloser(bytes.NewReader(raw))
	if c.then != nil {
		c.then()
	}
	c.cancel()
	return resp, err
}

// deviceVia is a device signed in to srv whose requests go through rt.
func deviceVia(t *testing.T, srv *httptest.Server, rt http.RoundTripper) *Desk {
	t.Helper()
	d := device(t, srv)
	raw, _ := json.Marshal(map[string]string{"refresh_token": fmt.Sprintf("r1.%022d.%043d", 1, 0), "account_id": "acct"})
	d.account = account.New(srv.URL, "linux", &signedInStore{raw: raw}, &http.Client{Transport: rt})
	return d
}

// #390 r7: a round canceled once its readback has arrived, before it is
// applied, applies none of it and doesn't count as a good sync.
func TestACanceledReadbackIsNotApplied(t *testing.T) {
	quietSync(t)
	_, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodGet}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	state, _ := mac.loadSyncState()
	before := *state.LastSync
	savePrompt(t, mac, p.ID, "", "v1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transport.mu.Lock()
	transport.nth, transport.seen, transport.cancel = 2, 0, cancel // the pull, then the readback
	transport.mu.Unlock()
	if err := mac.SyncMachines(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("%v; want the round ended", err)
	}
	state, _ = mac.loadSyncState()
	if *state.LastSync != before {
		t.Fatalf("last good sync %+v; want it left at %+v", *state.LastSync, before)
	}
}

// #359 r11: an upload refused (429) as the round ends, while the store is
// busy: the round lets go at once, the refusal owed, and the next round
// writes it first.
func TestARefusalOwedByAnEndedRoundIsWrittenNextRound(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodPost, nth: 1}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.mu.Lock()
	w.rateLimit, w.windowPosts = 1, 1
	w.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transport.mu.Lock()
	transport.cancel, transport.then = cancel, mac.storeMu.Lock // the store busy as the refusal comes
	transport.mu.Unlock()
	done := make(chan error, 1)
	go func() { done <- mac.SyncMachines(ctx) }()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("%v; want the round ended", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the ended round still waits for the store")
	}
	mac.storeMu.Unlock()
	state, _ := mac.loadSyncState()
	open := slices.Concat(func() [][]string {
		var out [][]string
		for _, a := range state.PromptAttempts[p.ID] {
			out = append(out, a.Open)
		}
		return out
	}()...)
	if len(open) != 1 {
		t.Fatalf("open sends %v; want the refused one, its answer owed", open)
	}
	w.mu.Lock()
	w.rateLimit = 0
	w.mu.Unlock()
	transport.mu.Lock()
	transport.cancel = nil
	transport.mu.Unlock()
	syncEach(t, mac)
	owed := len(mac.accountSync.owed)
	if owed != 0 {
		t.Fatalf("%d answers still owed; want the next round to have written them", owed)
	}
	state, _ = mac.loadSyncState()
	for _, a := range state.PromptAttempts[p.ID] {
		if slices.Contains(a.Open, open[0]) {
			t.Fatalf("journal %+v; want the refused send settled", state.PromptAttempts[p.ID])
		}
	}
}

// #390 r7, #359 r11: a sign-out and a sign-in again to the same account
// (a real handoff) while a round runs: the round was the old session's,
// and sends nothing under the new one.
func TestARoundStaysInTheSessionItBeganIn(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	w.handoffAccount = "acct"
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	q := savePrompt(t, mac, "", "", "q0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.anotherDeviceWrites(q.ID, "q1")
	var once sync.Once
	publishSavedPrompts = func([]SavedPrompt) { // after the merge took q1, before the upload
		once.Do(func() {
			_ = mac.account.SignOut(context.Background())
			if _, err := mac.account.StartSignIn("google"); err != nil {
				t.Error(err)
				return
			}
			if _, err := mac.account.FinishSignIn(context.Background(), strings.Repeat("c", 43)); err != nil {
				t.Error(err)
			}
		})
	}
	w.mu.Lock()
	posts := w.posts
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err != nil {
		t.Fatalf("an abandoned round: %v; want nothing to report", err)
	}
	w.mu.Lock()
	sent := w.posts - posts
	w.mu.Unlock()
	if sent != 0 {
		t.Fatalf("%d uploads under the new session; want none from the old round", sent)
	}
}

// #359 r12: the first page of a pull shows this device's held upload of v1
// landed; the account is then restored to before it, so the next page is
// told to start over (410). The full pull finds the restored prompt (old):
// the discarded history's landing is not recorded, so v0 (agreed, and
// saved here again) is no edit, and old is taken, not overwritten.
func TestALandingFromAHistoryAResetDiscardedIsNotKept(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "old")
	syncEach(t, mac)
	w.mu.Lock()
	backup := w.items[p.ID]
	w.mu.Unlock()
	savePrompt(t, mac, p.ID, "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	syncGivingUpTheUpload(t, w, mac)
	savePrompt(t, mac, p.ID, "", "v0")
	w.landHeld()
	w.mu.Lock()
	w.otherDeviceWritesBodyLocked("00000000-0000-4000-8000-0000000000aa", `{"text":"q","order":1}`)
	w.pageSize = 1
	w.onNextPage = func() {
		w.restoreTo(backup.Rev)
		w.items[p.ID] = backup
	}
	w.mu.Unlock()
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "old" || !strings.Contains(body, `"old"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the restored old in both", got, body)
	}
}

// #359 r12: an answer's baseline goes in only while it is the newest news of
// its item: not when the mirror already holds the item at a later revision,
// nor when the send it answers was settled since (a late, owed answer).
// A baseline is never put back.
func TestAStaleAnswerNeverPutsABaselineBack(t *testing.T) {
	const p, h = "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
	state := func() *syncState {
		return &syncState{
			Mirror: account.Mirror{Prompts: []account.RemotePrompt{{ID: p, Rev: 7, Body: account.PromptBody{Text: "v2"}}},
				Hosts: []account.RemoteHost{{ID: h, Rev: 9, Body: account.HostBody{Host: "new", Username: "root"}}}},
			PromptBaseline: map[string]promptFields{p: {Text: "v2"}},
			Baseline:       map[string]account.HostBody{h: {Host: "new", Username: "root"}},
			PromptAttempts: map[string][]promptAttempt{p: {{Base: 5, Hash: "h", Open: []string{"s1"}}}},
		}
	}
	answer := func(send string, prompt, host int64) owedAnswer {
		return owedAnswer{acct: "acct", sent: map[string]sentAttempt{p: {ID: send, Base: 5}}, out: &pushOutcome{applied: []appliedChange{
			{Change: account.Change{Collection: "prompts", ID: p, Body: account.PromptBody{Text: "v1"}}, Rev: prompt},
			{Change: account.Change{Collection: "hosts", ID: h, Body: account.HostBody{Host: "old", Username: "root"}}, Rev: host},
		}}}
	}
	for _, c := range []struct {
		name         string
		ans          owedAnswer
		prompt, host string
	}{
		{"older than the mirror", answer("s1", 6, 8), "v2", "new"},
		{"its send settled since", answer("gone", 8, 10), "v2", "old"},
		{"the newest news", answer("s1", 8, 10), "v1", "old"},
	} {
		s := state()
		c.ans.apply(s)
		if got, host := s.PromptBaseline[p].Text, s.Baseline[h].Host; got != c.prompt || host != c.host {
			t.Errorf("%s: baselines %q and %q; want %q and %q", c.name, got, host, c.prompt, c.host)
		}
	}
}

// #390 r8: an owed answer the next merge applies is let go as soon as that
// merge's commit record is in place: its files may fail to be written
// after it, and the replay finishes them, but the answer is not applied a
// second time later.
func TestAnOwedAnswerGoesWithTheCommitThatHoldsIt(t *testing.T) {
	quietSync(t)
	_, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	state, err := mac.loadSyncState()
	if err != nil {
		t.Fatal(err)
	}
	base := state.Mirror.Prompts[0].Rev
	state.PromptAttempts = map[string][]promptAttempt{p.ID: {{Base: base, Hash: "x", Open: []string{"s1"}}}}
	if err := mac.storeSyncState(state); err != nil {
		t.Fatal(err)
	}
	mac.accountSync.owed = []owedAnswer{{acct: "acct", sent: map[string]sentAttempt{p.ID: {ID: "s1", Base: base}}}} // a refusal
	if err := os.Mkdir(mac.syncStatePath()+".tmp", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a merge whose state couldn't be written reported success")
	}
	_ = os.Remove(mac.syncStatePath() + ".tmp")
	owed := len(mac.accountSync.owed)
	if owed != 0 {
		t.Fatalf("%d answers still owed; want the one the commit record holds let go", owed)
	}
	if state, err := mac.loadSyncState(); err != nil || len(state.PromptAttempts[p.ID]) != 0 {
		t.Fatalf("journal %+v (%v); want the refused send settled by the replayed commit", state.PromptAttempts[p.ID], err)
	}
}

// #390 r8: an upload of v1 is refused (429), and the journal write that
// would record it fails. The answer is kept, and the next round writes it:
// when another device then saves the same v1, it is that device's, taken
// here (where v0 was saved again), not the refused upload landing.
func TestARefusalWhoseWriteFailedIsKept(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodPost, nth: 1}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.mu.Lock()
	w.rateLimit, w.windowPosts = 1, 1
	w.mu.Unlock()
	blocked := mac.syncStatePath() + ".tmp"
	transport.mu.Lock()
	transport.cancel = func() {} // the round goes on
	transport.then = func() { _ = os.Mkdir(blocked, 0o700) }
	transport.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a round whose answer couldn't be written reported success")
	}
	_ = os.Remove(blocked)
	transport.mu.Lock()
	transport.cancel = nil
	transport.mu.Unlock()
	w.mu.Lock()
	w.rateLimit = 0
	w.mu.Unlock()
	savePrompt(t, mac, p.ID, "", "v0")
	w.anotherDeviceWrites(p.ID, "v1")
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v1" || !strings.Contains(body, `"v1"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the other device's v1 in both", got, body)
	}
}

// #390 r8: a pull in pages. The first row of the prompt past the held
// upload's base is another device's x: it decides that upload did not
// land, so a later page's v1 (the same text, saved by a third device) is
// that device's, taken here (where v0 was saved again).
func TestTheFirstRowPastASendsBaseDecidesIt(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	syncGivingUpTheUpload(t, w, mac) // held, never applied
	savePrompt(t, mac, p.ID, "", "v0")
	w.mu.Lock()
	w.otherDeviceWritesLocked(p.ID, "x")
	w.otherDeviceWritesBodyLocked("00000000-0000-4000-8000-0000000000aa", `{"text":"q","order":1}`)
	w.pageSize = 1
	w.onNextPage = func() { w.otherDeviceWritesLocked(p.ID, "v1") } // after the first page
	w.mu.Unlock()
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v1" || !strings.Contains(body, `"v1"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the third device's v1 in both", got, body)
	}
}

// #390 r8: a conflict's row (another device's x) is the first past the
// held upload's base, so it decides that upload did not land; the retry's
// pull then shows a third device's v1, which is taken here (where v0 was
// saved again), not taken for the held upload.
func TestAConflictsRowDecidesBeforeTheRetryPull(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	syncGivingUpTheUpload(t, w, mac) // held, never applied
	savePrompt(t, mac, p.ID, "", "v2")
	w.mu.Lock()
	w.onPush = func() {
		w.otherDeviceWritesLocked(p.ID, "x")
		savePrompt(t, mac, p.ID, "", "v0")
	}
	w.afterPush = func() { w.otherDeviceWritesLocked(p.ID, "v1") }
	w.mu.Unlock()
	for round := 0; mac.SyncMachines(context.Background()) != nil; round++ {
		if round == 3 {
			t.Fatal("still failing three rounds on")
		}
	}
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v1" || !strings.Contains(body, `"v1"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the third device's v1 in both", got, body)
	}
}

// #390 r8: a store wait ends with its round and leaves no waiter behind:
// once the holder lets go, the lock is free at once.
func TestAStoreWaitEndsWithItsRound(t *testing.T) {
	var l storeLock
	l.Lock()
	ctx, cancel := context.WithCancel(context.Background())
	go cancel()
	if l.LockCtx(ctx) {
		t.Fatal("a wait whose round ended took the lock")
	}
	l.Unlock()
	select {
	case l.ch() <- struct{}{}:
	default:
		t.Fatal("the lock is taken by a wait that ended")
	}
}

// #390 e8debfe review: work for a round that ended doesn't take even a
// free lock (LockCtx); writing down an answer already received does
// (LockBestEffort), but doesn't wait for a held one once the round ended.
func TestTheStoreLocksTwoPolicies(t *testing.T) {
	var l storeLock
	ended, cancel := context.WithCancel(context.Background())
	cancel()
	for range 64 { // a free slot and an ended ctx are both ready: never the slot
		if l.LockCtx(ended) {
			t.Fatal("work for a round that ended took the free lock")
		}
	}
	if !l.LockBestEffort(ended) {
		t.Fatal("an answer already received was not written down with the lock free")
	}
	if l.LockBestEffort(ended) {
		t.Fatal("an answer for a round that ended waited for, and took, a held lock")
	}
	l.Unlock()
}

// #390 e8debfe review: a hold of the store looks for a commit record to
// replay once, at its first file access; later loads in the same hold
// don't look again, and the next hold does.
func TestAStoreHoldReplaysOnce(t *testing.T) {
	d := newDesk(t.TempDir())
	d.storeMu.Lock()
	if _, err := d.loadSyncState(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(d.commitPath(), []byte("{damaged"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := d.loadSyncState(); err != nil {
		t.Fatalf("%v; want the hold's second load not to replay again", err)
	}
	d.storeMu.Unlock()
	d.storeMu.Lock()
	_, err := d.loadSyncState()
	d.storeMu.Unlock()
	if err == nil {
		t.Fatal("the next hold didn't replay the record left")
	}
}

// signInAgainOnPost is a transport that signs d out and in again to the
// same account once, just as d's first push goes out.
type signInAgainOnPost struct {
	base http.RoundTripper
	d    *Desk
	t    *testing.T
	once sync.Once
}

func (s *signInAgainOnPost) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Method == http.MethodPost && r.URL.Path == "/v1/sync" {
		s.once.Do(func() {
			_ = s.d.account.SignOut(context.Background())
			if _, err := s.d.account.StartSignIn("google"); err != nil {
				s.t.Error(err)
				return
			}
			if _, err := s.d.account.FinishSignIn(context.Background(), strings.Repeat("c", 43)); err != nil {
				s.t.Error(err)
			}
		})
	}
	return s.base.RoundTrip(r)
}

// #390 r8: the old session's upload goes out as a sign-in again to the
// same account completes, and gets no answer (503): that round's failure
// is not the new session's.
func TestAnOldRoundDoesNotMarkTheNewSessionFailed(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	w.handoffAccount = "acct"
	transport := &signInAgainOnPost{base: srv.Client().Transport, t: t}
	mac := deviceVia(t, srv, transport)
	transport.d = mac
	savePrompt(t, mac, "", "", "v0")
	w.mu.Lock()
	w.failPush = true
	w.mu.Unlock()
	_ = mac.SyncMachines(context.Background())
	if mac.syncFailed("acct") {
		t.Fatal("the new session shows the old round's failure")
	}
}

// #359 r13: one upload writes p and is turned down for q (another device's
// copy), and the round ends while the answer waits for the store. The
// whole answer is owed as one, the write and the conflict, and the next
// round writes all of it.
func TestAMixedAnswerIsOwedWhole(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodPost, nth: 1}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "p0")
	q := savePrompt(t, mac, "", "", "q0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "p1")
	savePrompt(t, mac, q.ID, "", "q1")
	w.mu.Lock()
	w.onPush = func() { w.otherDeviceWritesLocked(q.ID, "from linux") }
	w.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transport.mu.Lock()
	transport.cancel, transport.then = cancel, mac.storeMu.Lock // the store busy as the answer comes
	transport.mu.Unlock()
	done := make(chan error, 1)
	go func() { done <- mac.SyncMachines(ctx) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the ended round still waits for the store")
	}
	owed := slices.Clone(mac.accountSync.owed)
	mac.storeMu.Unlock()
	if len(owed) != 1 || owed[0].out == nil || len(owed[0].out.applied) != 1 || owed[0].out.applied[0].ID != p.ID ||
		len(owed[0].out.conflicts) != 1 || owed[0].out.conflicts[0].ID != q.ID {
		t.Fatalf("owed %+v; want one answer with p's write and q's conflict", owed)
	}
	transport.mu.Lock()
	transport.cancel = nil
	transport.mu.Unlock()
	syncEach(t, mac)
	left := len(mac.accountSync.owed)
	if left != 0 {
		t.Fatalf("%d answers still owed; want the next round to have written them", left)
	}
}

// endedRoundOwing runs a round its transport ends (cancel) once the first
// upload's answer has arrived, while the store is busy: the answer is owed.
func endedRoundOwing(t *testing.T, mac *Desk, transport *cancelOn) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transport.mu.Lock()
	transport.nth, transport.seen, transport.cancel, transport.then = 1, 0, cancel, mac.storeMu.Lock
	transport.mu.Unlock()
	done := make(chan error, 1)
	go func() { done <- mac.SyncMachines(ctx) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the ended round still waits for the store")
	}
	mac.storeMu.Unlock()
	transport.mu.Lock()
	transport.cancel = nil
	transport.mu.Unlock()
	if owed := len(mac.accountSync.owed); owed != 1 {
		t.Fatalf("%d answers owed; want the ended round's one", owed)
	}
}

// #359 r14: the upload of v2 is turned down (another device's x) as its
// round ends, the answer owed; the account is then restored to before x,
// and the held upload of v1 lands in the restored history. The owed answer
// is of the history that is gone, so it settles only its own send: v1 is
// still this device's landing, and v0, saved here since, goes.
func TestAnOwedConflictFromAGoneHistorySettlesOnlyItsSend(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodPost}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	w.mu.Lock()
	backup := w.items[p.ID]
	w.mu.Unlock()
	savePrompt(t, mac, p.ID, "", "v1")
	syncGivingUpTheUpload(t, w, mac) // held, never applied
	savePrompt(t, mac, p.ID, "", "v2")
	w.mu.Lock()
	w.onPush = func() { w.otherDeviceWritesLocked(p.ID, "x") }
	w.mu.Unlock()
	endedRoundOwing(t, mac, transport)
	savePrompt(t, mac, p.ID, "", "v0")
	w.mu.Lock()
	w.restoreTo(backup.Rev)
	w.items[p.ID] = backup
	w.floor = backup.Rev + 1 // the next pull is told to start over
	w.mu.Unlock()
	w.landHeld()
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v0" || !strings.Contains(body, `"v0"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want v0, saved here after v1 landed, in both", got, body)
	}
}

// #359 r14-1: the upload of v1 is turned down (another device's x) as its
// round ends with the store busy. Its send is settled before any store
// wait, so when another device then saves the same v1, the next merge
// takes it as that device's (here, where v0 was saved again), not as the
// turned-down upload landing.
func TestATurnedDownUploadIsSettledBeforeAnyStoreWait(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodPost}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.mu.Lock()
	w.onPush = func() { w.otherDeviceWritesLocked(p.ID, "x") }
	w.mu.Unlock()
	endedRoundOwing(t, mac, transport)
	savePrompt(t, mac, p.ID, "", "v0")
	w.anotherDeviceWrites(p.ID, "v1")
	syncEach(t, mac)
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v1" || !strings.Contains(body, `"v1"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the other device's v1 in both", got, body)
	}
}

// #390 r9: an upload of v1 is refused (429) and only the journal write
// that would record it fails; the app is then closed and opened again on
// the same data, the answer owed in memory gone. The send's marker kept
// the refusal: when another device saves the same v1, it is taken here
// (where v0 was saved again), not mistaken for the refused upload landing
// and overwritten. The marker goes with the send.
func TestARefusalWhoseWriteFailedOutlivesARestart(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodPost, nth: 1}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.mu.Lock()
	w.rateLimit, w.windowPosts = 1, 1
	w.mu.Unlock()
	blocked := mac.syncStatePath() + ".tmp"
	transport.mu.Lock()
	transport.cancel = func() {} // the round goes on
	transport.then = func() { _ = os.Mkdir(blocked, 0o700) }
	transport.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a round whose answer couldn't be written reported success")
	}
	_ = os.Remove(blocked)
	w.mu.Lock()
	w.rateLimit = 0
	w.mu.Unlock()
	reopened := reopen(t, srv, mac)
	savePrompt(t, reopened, p.ID, "", "v0")
	w.anotherDeviceWrites(p.ID, "v1")
	syncEach(t, reopened)
	if got, body := promptsOf(t, reopened)[p.ID], w.livePrompts()[p.ID]; got.Text != "v1" || !strings.Contains(body, `"v1"`) {
		t.Fatalf("the reopened app's prompt %+v, the account's %s; want the other device's v1 in both", got, body)
	}
	if markers, err := os.ReadDir(reopened.sendMarkersDir()); err != nil || len(markers) != 0 {
		t.Fatalf("send markers %v (%v); want none once no send is open", markers, err)
	}
}

// #390 r9: a merge that changes no machine leaves machines.json as it is.
func TestAMergeLeavesMachinesAloneWhenNoneChanged(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	if err := mac.SaveMachine(Machine{Nickname: "pi", Host: "pi", User: "root", KeyPath: "/k"}, ""); err != nil {
		t.Fatal(err)
	}
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	before, err := os.Stat(mac.machinesPath())
	if err != nil {
		t.Fatal(err)
	}
	w.anotherDeviceWrites(p.ID, "v1")
	syncEach(t, mac)
	if promptsOf(t, mac)[p.ID].Text != "v1" {
		t.Fatal("the merge did not take the other device's v1")
	}
	after, err := os.Stat(mac.machinesPath())
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("machines.json was written again by a merge that changed no machine")
	}
}

// reopen is the app opened again on d's data (d's memory gone), signed in
// to srv's account.
func reopen(t *testing.T, srv *httptest.Server, d *Desk) *Desk {
	t.Helper()
	again := newDesk(d.dir)
	signInTo(again, srv, "acct")
	again.accountStore = account.NewSecretsStore(noSecrets{}, errors.New("not found"))
	return again
}

// #390 r15: the service takes the upload of v1 while v0 is saved here
// again (a revert), and only the journal write recording its answer
// fails; the app is then opened again on the same data, and another
// device edits the prompt (x). The send's marker kept the acknowledgement:
// v0 is an edit of the v1 the account took, so it goes over x, not x
// over it.
func TestAnAcceptedUploadOutlivesARestart(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodPost, nth: 1}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.mu.Lock()
	w.onPush = func() { savePrompt(t, mac, p.ID, "", "v0") } // the revert, as v1 goes
	w.mu.Unlock()
	blocked := mac.syncStatePath() + ".tmp"
	transport.mu.Lock()
	transport.cancel = func() {} // the round goes on
	transport.then = func() { _ = os.Mkdir(blocked, 0o700) }
	transport.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a round whose answer couldn't be written reported success")
	}
	_ = os.Remove(blocked)
	reopened := reopen(t, srv, mac)
	w.anotherDeviceWrites(p.ID, "x")
	syncEach(t, reopened)
	if got, body := promptsOf(t, reopened)[p.ID], w.livePrompts()[p.ID]; got.Text != "v0" || !strings.Contains(body, `"v0"`) {
		t.Fatalf("the reopened app's prompt %+v, the account's %s; want the revert v0 in both", got, body)
	}
}

// #390 r15: the held upload of v1 lands just before the upload of v2,
// which is turned down with v1's row; v0 is saved here again meanwhile,
// and the account is restored (to a backup holding old) before the
// readback. The conflict's row is of the history the restore discarded,
// so it decides nothing: v0, agreed before the push, is no edit, and the
// restored old is taken, not overwritten.
func TestAConflictsRowFromAHistoryTheReadbackFindsGoneDecidesNothing(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "old")
	q := savePrompt(t, mac, "", "", "q0")
	syncEach(t, mac)
	w.mu.Lock()
	backupRev, backupP, backupQ := w.rev, w.items[p.ID], w.items[q.ID]
	w.mu.Unlock()
	savePrompt(t, mac, p.ID, "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	syncGivingUpTheUpload(t, w, mac) // held, never answered
	savePrompt(t, mac, p.ID, "", "v2")
	savePrompt(t, mac, q.ID, "", "q1") // taken, so the round reads back
	w.mu.Lock()
	w.onPush = func() {
		w.landHeldLocked()
		savePrompt(t, mac, p.ID, "", "v0")
	}
	w.afterPush = func() {
		w.restoreTo(backupRev)
		w.items[p.ID], w.items[q.ID] = backupP, backupQ
	}
	w.mu.Unlock()
	for round := 0; mac.SyncMachines(context.Background()) != nil; round++ {
		if round == 3 {
			t.Fatal("still failing three rounds on")
		}
	}
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "old" || !strings.Contains(body, `"old"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the restored old in both", got, body)
	}
}

// #390 r15: a draft held back at the journal's bound (two unanswered
// uploads of it) is never dispatched, so a round the rate limit stops
// resumes from the next write that can go, not from the held draft.
func TestAHeldDraftDoesNotPinTheRateLimitCursor(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	w.noNow = true
	mac := device(t, srv)
	d := savePrompt(t, mac, "", "", "d0")
	s := savePrompt(t, mac, "", "", "s0")
	syncEach(t, mac)
	for _, text := range []string{"d1", "d2"} {
		savePrompt(t, mac, d.ID, "", text)
		syncGivingUpTheUpload(t, w, mac) // held, never answered
	}
	savePrompt(t, mac, d.ID, "", "d3") // a third variant waits for a slot
	savePrompt(t, mac, s.ID, "", "s1")
	w.mu.Lock()
	w.rateLimit, w.windowPosts = 1, 1
	w.mu.Unlock()
	var api *account.APIError
	if err := mac.SyncMachines(context.Background()); !errors.As(err, &api) || api.Status != http.StatusTooManyRequests {
		t.Fatalf("%v; want the round stopped by the rate limit", err)
	}
	state, err := mac.loadSyncState()
	if err != nil {
		t.Fatal(err)
	}
	if want := "prompts/" + s.ID; state.PushFrom != want {
		t.Fatalf("next round starts from %q; want %q, the write the rate limit stopped", state.PushFrom, want)
	}
}

// #390 r15: a machine renamed on another device, in a merge whose commit
// a failed write leaves to the replay: the replay moves the board cache
// with the machine, as the commit would have.
func TestAReplayedRenameMovesTheBoardCache(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	m := Machine{Host: "pi", User: "root", KeyPath: "/k"}
	if err := mac.SaveMachine(m, ""); err != nil {
		t.Fatal(err)
	}
	syncEach(t, mac)
	b := BoardUpdate{MachineID: machineID(m), ListedAt: "2026-11-13T00:00:00Z"}
	b.Board.Total = 1
	mac.boards.store(b)
	if mac.boards.load(machineID(m), "") == nil {
		t.Fatal("no board cached")
	}
	pi := syncIDs(t, mac)["root@pi:22"]
	w.mu.Lock()
	w.rev++
	w.items[pi] = account.Item{Collection: "hosts", ID: pi, Rev: w.rev, Body: json.RawMessage(`{"nickname":"","host":"pi2","port":22,"username":"root"}`)}
	w.mu.Unlock()
	blocked := mac.syncStatePath() + ".tmp"
	if err := os.Mkdir(blocked, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a merge whose state couldn't be written reported success")
	}
	_ = os.Remove(blocked)
	syncEach(t, mac) // replays the commit first
	if _, renamed := syncIDs(t, mac)["root@pi2:22"]; !renamed {
		t.Fatalf("machines %v; want pi renamed to pi2", syncIDs(t, mac))
	}
	if mac.boards.load(machineID(m), "") != nil {
		t.Fatal("the renamed machine's old board is still cached")
	}
}

// #390 r15: a folder sync that fails is an error, unless the system
// doesn't sync folders.
func TestOnlyAnUnsupportedFolderSyncIsIgnored(t *testing.T) {
	if err := syncDir(filepath.Join(t.TempDir(), "gone")); err == nil && runtime.GOOS != "windows" {
		t.Fatal("a folder that can't be opened synced")
	}
	for _, c := range []struct {
		err         error
		unsupported bool
	}{
		{syscall.EINVAL, true},
		{&os.PathError{Op: "sync", Path: "d", Err: syscall.ENOTSUP}, true},
		{&os.PathError{Op: "sync", Path: "d", Err: syscall.EIO}, false},
		{nil, false},
	} {
		if got := dirSyncUnsupported(c.err); got != c.unsupported {
			t.Errorf("%v: unsupported %v; want %v", c.err, got, c.unsupported)
		}
	}
}

// #390 r15: an acknowledgement a marker holds is applied with an owed
// answer's guards: in the history it was sent in, it retires the sends at
// its base and makes its write what the saved copy is judged against,
// unless the mirror holds the prompt past it; in another history it
// retires only its own send.
func TestAMarkersAcknowledgementKeepsTheGuards(t *testing.T) {
	const p = "00000000-0000-4000-8000-000000000001"
	for _, c := range []struct {
		name     string
		history  int64
		mirror   int64
		judgedBy string // "hash": the acknowledged write; "baseline": the old copy
		left     int
	}{
		{"its history", 0, 5, "hash", 0},
		{"the mirror past it", 0, 7, "baseline", 0},
		{"another history", 1, 5, "baseline", 1},
	} {
		d := newDesk(t.TempDir())
		state := &syncState{
			History:        c.history,
			Mirror:         account.Mirror{Prompts: []account.RemotePrompt{{ID: p, Rev: c.mirror, Body: account.PromptBody{Text: "v0"}}}},
			PromptBaseline: map[string]promptFields{p: {Text: "v0"}},
			PromptAttempts: map[string][]promptAttempt{p: {{Base: 5, Hash: "h", Open: []string{"s1", "s2"}}}},
		}
		if err := os.MkdirAll(d.sendMarkersDir(), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d.sendMarkersDir(), "s1"), []byte("a:6:H:0"), 0o600); err != nil {
			t.Fatal(err)
		}
		d.foldMarkers(state)
		judgedBy := "baseline"
		if _, kept := state.PromptBaseline[p]; !kept && state.PromptBaselineHash[p] == "H" {
			judgedBy = "hash"
		}
		left := 0
		for _, a := range state.PromptAttempts[p] {
			left += len(a.Open)
		}
		if judgedBy != c.judgedBy || left != c.left {
			t.Errorf("%s: judged by the %s, %d sends open; want the %s, %d", c.name, judgedBy, left, c.judgedBy, c.left)
		}
	}
}

// #443: on an empty account, the held first upload of v1 lands just
// before the upload of v2, which is turned down with v1's row; v1 is saved
// here again meanwhile, and another device writes v3. The readback (from
// revision 0, a plain snapshot, not a restart) confirms the conflict's
// history: v1 is the agreed copy, so v3 is taken, not overwritten.
func TestAReadbackFromRevisionZeroKeepsConflictEvidence(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v1")
	syncGivingUpTheUpload(t, w, mac) // held, never answered
	savePrompt(t, mac, p.ID, "", "v2")
	savePrompt(t, mac, "", "", "q") // taken, so the round reads back
	w.mu.Lock()
	w.onPush = func() {
		w.landHeldLocked()
		savePrompt(t, mac, p.ID, "", "v1")
	}
	w.afterPush = func() { w.otherDeviceWritesLocked(p.ID, "v3") }
	w.mu.Unlock()
	for round := 0; mac.SyncMachines(context.Background()) != nil; round++ {
		if round == 3 {
			t.Fatal("still failing three rounds on")
		}
	}
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v3" || !strings.Contains(body, `"v3"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the other device's v3 in both", got, body)
	}
}

// #442: the held upload of v1 lands just before the upload of v2, which is
// turned down with v1's row; v0 is saved here again meanwhile, another
// device writes v3, and the readback never comes back (the round ends);
// the app is then opened again. The conflict's row was kept: the next
// pull confirms its history, so v1 is the agreed copy and v0 an edit,
// which goes over v3.
func TestConflictEvidenceOutlivesAFailedReadbackAndARestart(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodGet}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	syncGivingUpTheUpload(t, w, mac) // held, never answered
	savePrompt(t, mac, p.ID, "", "v2")
	savePrompt(t, mac, "", "", "q") // taken, so the round reads back
	w.mu.Lock()
	w.onPush = func() {
		w.landHeldLocked()
		savePrompt(t, mac, p.ID, "", "v0")
	}
	w.afterPush = func() { w.otherDeviceWritesLocked(p.ID, "v3") }
	w.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transport.mu.Lock()
	transport.nth, transport.seen, transport.cancel = 2, 0, cancel // the pull, then the readback
	transport.mu.Unlock()
	if err := mac.SyncMachines(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("%v; want the round ended before its readback was applied", err)
	}
	reopened := reopen(t, srv, mac)
	for round := 0; reopened.SyncMachines(context.Background()) != nil; round++ {
		if round == 3 {
			t.Fatal("still failing three rounds on")
		}
	}
	if got, body := promptsOf(t, reopened)[p.ID], w.livePrompts()[p.ID]; got.Text != "v0" || !strings.Contains(body, `"v0"`) {
		t.Fatalf("the reopened app's prompt %+v, the account's %s; want the revert v0 in both", got, body)
	}
}

// #439: as in TestAnAcceptedUploadOutlivesARestart, the reopened app
// recovers the acknowledgement of v1 from its marker, and the revert v0 is
// an edit over another device's x; but its upload is refused (429). The
// acknowledgement stays what v0 is judged against (no older copy stands
// in for it), so the next round sends v0 again instead of taking x.
func TestARecoveredAcknowledgementOutlivesARateLimitedRevert(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodPost, nth: 1}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.mu.Lock()
	w.onPush = func() { savePrompt(t, mac, p.ID, "", "v0") } // the revert, as v1 goes
	w.mu.Unlock()
	blocked := mac.syncStatePath() + ".tmp"
	transport.mu.Lock()
	transport.cancel = func() {} // the round goes on
	transport.then = func() { _ = os.Mkdir(blocked, 0o700) }
	transport.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a round whose answer couldn't be written reported success")
	}
	_ = os.Remove(blocked)
	reopened := reopen(t, srv, mac)
	w.anotherDeviceWrites(p.ID, "x")
	w.mu.Lock()
	w.rateLimit, w.windowPosts = 1, 1
	w.mu.Unlock()
	var api *account.APIError
	if err := reopened.SyncMachines(context.Background()); !errors.As(err, &api) || api.Status != http.StatusTooManyRequests {
		t.Fatalf("%v; want the revert's upload refused by the rate limit", err)
	}
	w.mu.Lock()
	w.rateLimit = 0
	w.mu.Unlock()
	syncEach(t, reopened)
	if got, body := promptsOf(t, reopened)[p.ID], w.livePrompts()[p.ID]; got.Text != "v0" || !strings.Contains(body, `"v0"`) {
		t.Fatalf("the reopened app's prompt %+v, the account's %s; want the revert v0 in both", got, body)
	}
}

// #441: a send's marker is reserved at its full size before dispatch, and
// every answer, the longest acknowledgement included, overwrites it in
// place at that size: recording an answer never needs room a disk that
// filled after dispatch no longer has.
func TestASendsMarkerNeverGrows(t *testing.T) {
	const p = "00000000-0000-4000-8000-000000000001"
	d := newDesk(t.TempDir())
	sent := map[string]sentAttempt{p: {ID: "s1", Base: 1, History: math.MaxInt64}}
	if err := d.reserveSends(sent); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(d.sendMarkersDir(), "s1")
	size := func() int64 {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		return info.Size()
	}
	reserved := size()
	d.markAnswered(sent, &pushOutcome{applied: []appliedChange{{Change: account.Change{Collection: "prompts", ID: p, Body: account.PromptBody{Text: "v1"}}, Rev: math.MaxInt64}}})
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := size(); got != reserved || !strings.HasPrefix(string(raw), fmt.Sprintf("a:%d:", int64(math.MaxInt64))) || !strings.HasSuffix(strings.TrimRight(string(raw), " "), fmt.Sprintf(":%d", int64(math.MaxInt64))) {
		t.Fatalf("marker %q, %d bytes; want the whole acknowledgement in the %d bytes reserved", raw, got, reserved)
	}
}

// #440: the upload of v1 is taken while v0 (agreed before it) is saved
// here again, and only the journal write recording the answer fails; the
// app is opened again, and its first pull is told to start over (410):
// the account was restored to a backup holding old. The pull's history is
// worked out before the marker's acknowledgement is folded, so that
// acknowledgement (of the history the restore discarded) retires only its
// send: v0, agreed before it, is no edit, and the restored old is taken.
func TestAnAcknowledgementFromBeforeARestoreSetsNoBaseline(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodPost, nth: 1}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "old")
	syncEach(t, mac)
	w.mu.Lock()
	backup := w.items[p.ID]
	w.mu.Unlock()
	savePrompt(t, mac, p.ID, "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.mu.Lock()
	w.onPush = func() { savePrompt(t, mac, p.ID, "", "v0") }
	w.mu.Unlock()
	blocked := mac.syncStatePath() + ".tmp"
	transport.mu.Lock()
	transport.cancel = func() {} // the round goes on
	transport.then = func() { _ = os.Mkdir(blocked, 0o700) }
	transport.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a round whose answer couldn't be written reported success")
	}
	_ = os.Remove(blocked)
	w.mu.Lock()
	w.restoreTo(backup.Rev)
	w.items[p.ID] = backup
	w.floor = backup.Rev + 1 // the next pull is told to start over
	w.mu.Unlock()
	reopened := reopen(t, srv, mac)
	syncEach(t, reopened)
	if got, body := promptsOf(t, reopened)[p.ID], w.livePrompts()[p.ID]; got.Text != "old" || !strings.Contains(body, `"old"`) {
		t.Fatalf("the reopened app's prompt %+v, the account's %s; want the restored old in both", got, body)
	}
}

// #390 e8debfe review (the reviewer's sequence for #443): on an empty
// account, the held upload of v1 lands just before the saved v2 is turned
// down with v1's row; an unrelated write goes in, and another device
// saves v3 before the readback. The readback from revision 0 is no
// restart: v1 stays the agreed copy, so the saved v2 is an edit, and it
// goes over v3.
func TestAReadbackFromRevisionZeroKeepsASavedEdit(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v1")
	syncGivingUpTheUpload(t, w, mac) // held, never answered
	savePrompt(t, mac, p.ID, "", "v2")
	savePrompt(t, mac, "", "", "q") // the unrelated write, taken
	w.mu.Lock()
	w.onPush = func() { w.landHeldLocked() }
	w.afterPush = func() { w.otherDeviceWritesLocked(p.ID, "v3") }
	w.mu.Unlock()
	for round := 0; mac.SyncMachines(context.Background()) != nil; round++ {
		if round == 3 {
			t.Fatal("still failing three rounds on")
		}
	}
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v2" || !strings.Contains(body, `"v2"`) {
		t.Fatalf("mac's prompt %+v, the account's %s; want the saved v2 in both", got, body)
	}
}

// #390 e8debfe review: the service takes the upload of v1 and only the
// journal write recording its answer fails; the app is opened again with
// v1 still saved, and its first pull is told to start over (410): the
// account was restored to a backup holding v0. The acknowledgement (of
// the history the restore discarded) still makes v1 an agreed body, so
// the saved v1 is no edit, and the restored v0 is taken, not overwritten.
func TestAnUneditedAcknowledgedPromptDoesNotUndoARestore(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodPost, nth: 1}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	w.mu.Lock()
	backup := w.items[p.ID]
	w.mu.Unlock()
	savePrompt(t, mac, p.ID, "", "v1")
	blocked := mac.syncStatePath() + ".tmp"
	transport.mu.Lock()
	transport.cancel = func() {} // the round goes on
	transport.then = func() { _ = os.Mkdir(blocked, 0o700) }
	transport.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a round whose answer couldn't be written reported success")
	}
	_ = os.Remove(blocked)
	w.mu.Lock()
	w.restoreTo(backup.Rev)
	w.items[p.ID] = backup
	w.floor = backup.Rev + 1 // the next pull is told to start over
	posts := w.posts
	w.mu.Unlock()
	reopened := reopen(t, srv, mac)
	syncEach(t, reopened)
	w.mu.Lock()
	sent := w.posts - posts
	w.mu.Unlock()
	if got, body := promptsOf(t, reopened)[p.ID], w.livePrompts()[p.ID]; got.Text != "v0" || !strings.Contains(body, `"v0"`) || sent != 0 {
		t.Fatalf("the reopened app's prompt %+v, the account's %s, %d uploads; want the restored v0 in both and none", got, body, sent)
	}
}

// #390 e8debfe review: a draft's first upload is turned down with a
// tombstone (another device created and deleted its id meanwhile); the
// readback then finds the account restored to a backup that never held
// that id (a 410). The tombstone was of the history the restore
// discarded: it deletes nothing here, and the draft goes up.
func TestATurnedDownTombstoneFromADiscardedHistoryKeepsADraft(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	q := savePrompt(t, mac, "", "", "q0")
	syncEach(t, mac)
	w.mu.Lock()
	backupRev, backupQ := w.rev, w.items[q.ID]
	w.mu.Unlock()
	savePrompt(t, mac, q.ID, "", "q1")
	syncEach(t, mac) // the mirror moves past the backup
	const draft = "00000000-0000-4000-8000-0000000000bb"
	savePrompt(t, mac, draft, "", "draft")
	savePrompt(t, mac, q.ID, "", "q2") // taken, so the round reads back
	w.mu.Lock()
	w.onPush = func() {
		w.otherDeviceWritesLocked(draft, "elsewhere")
		w.tombstone(draft)
	}
	w.afterPush = func() {
		w.restoreTo(backupRev)
		w.items[q.ID] = backupQ
	}
	w.mu.Unlock()
	for round := 0; mac.SyncMachines(context.Background()) != nil; round++ {
		if round == 3 {
			t.Fatal("still failing three rounds on")
		}
	}
	if got, body := promptsOf(t, mac)[draft], w.livePrompts()[draft]; got.Text != "draft" || !strings.Contains(body, `"draft"`) {
		t.Fatalf("mac's draft %+v, the account's %s; want the draft in both", got, body)
	}
}

// #390 e8debfe review: an answer that names neither a write nor a
// conflict for a change sent doesn't say whether it landed: the round
// fails, and the upload's send stays open (it may have landed).
func TestAnAnswerWithoutAnOutcomeLeavesTheSendOpen(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	mac := device(t, srv)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.mu.Lock()
	w.muteApplied = true
	w.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil || !strings.Contains(err.Error(), "no outcome") {
		t.Fatalf("%v; want the round failed for the answer's missing outcome", err)
	}
	state, err := mac.loadSyncState()
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(state.PromptAttempts[p.ID], func(a promptAttempt) bool { return len(a.Open) == 1 }) {
		t.Fatalf("journal %+v; want the upload's send still open", state.PromptAttempts[p.ID])
	}
}

// failGet is a transport that fails the nth GET of /v1/sync once armed.
type failGet struct {
	base      http.RoundTripper
	mu        sync.Mutex
	nth, seen int
}

func (f *failGet) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Method == http.MethodGet && r.URL.Path == "/v1/sync" {
		f.mu.Lock()
		f.seen++
		fail := f.nth > 0 && f.seen == f.nth
		f.mu.Unlock()
		if fail {
			return nil, errors.New("connection reset")
		}
	}
	return f.base.RoundTrip(r)
}

// heldConflictOf is a turned-down answer of history 0 holding a live row
// of prompt id at rev.
func heldConflictOf(id string, rev int64) heldConflict {
	return heldConflict{Conflict: turnedDown{Conflict: account.Conflict{Collection: "prompts", ID: id, Server: &account.Item{Collection: "prompts", ID: id, Rev: rev, Body: json.RawMessage(`{"text":"old","order":0}`)}}}}
}

// #448 review, #390 r17: a draft's upload was turned down with a tombstone
// (held); the account is then restored, and the pull told to start over
// (410), but its restart fails, so the round ends before any store step
// could record the restart; the app is then opened again. The 410 was
// kept: the next round's pull, an ordinary one, folds it first, so the
// discarded history's tombstone deletes nothing, and the draft goes up.
func TestA410WhoseRestartFailsStillEndsTheHistory(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &failGet{base: srv.Client().Transport}
	mac := deviceVia(t, srv, transport)
	savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	const draft = "00000000-0000-4000-8000-0000000000bb"
	savePrompt(t, mac, draft, "", "draft")
	state, err := mac.loadSyncState()
	if err != nil {
		t.Fatal(err)
	}
	state.HeldConflicts = []heldConflict{{Conflict: turnedDown{Conflict: account.Conflict{Collection: "prompts", ID: draft,
		Server: &account.Item{Collection: "prompts", ID: draft, Rev: state.Mirror.Rev + 1, Deleted: true}}}}}
	if err := mac.storeSyncState(state); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.floor = w.rev + 1 // the pull is told to start over
	w.mu.Unlock()
	transport.mu.Lock()
	transport.nth, transport.seen = 2, 0 // the restart
	transport.mu.Unlock()
	err = mac.SyncMachines(context.Background())
	if err == nil {
		t.Fatal("a round whose restarted pull failed reported success")
	}
	w.mu.Lock()
	w.floor = 0
	w.mu.Unlock()
	reopened := reopen(t, srv, mac)
	syncEach(t, reopened)
	if got, body := promptsOf(t, reopened)[draft], w.livePrompts()[draft]; got.Text != "draft" || !strings.Contains(body, `"draft"`) {
		t.Fatalf("the draft here %+v, in the account %s; want it in both", got, body)
	}
}

// #448 review: a pull from revision 0 told to start over on a later page
// (the account restored between its pages) restarts too, and ends the
// history it began in.
func TestA410OnALaterPageOfAPullFromZeroEndsTheHistory(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	w.seedPrompt("00000000-0000-4000-8000-0000000000a1", `{"text":"a","order":0}`)
	w.seedPrompt("00000000-0000-4000-8000-0000000000a2", `{"text":"b","order":1}`)
	mac := device(t, srv)
	if err := mac.storeSyncState(syncState{AccountID: "acct", PromptsPulled: true}); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.pageSize = 1
	w.onNextPage = func() { w.restoreTo(0) }
	w.mu.Unlock()
	syncEach(t, mac)
	if state, err := mac.loadSyncState(); err != nil || state.History != 1 {
		t.Fatalf("history %d (%v); want the restart to end the first", state.History, err)
	}
}

// #448 review: a held conflict's row no newer than the copy the state
// already holds (live or a tombstone) never rewinds it: it is landing
// evidence only.
func TestAnOldConflictRowNeverRewindsTheMirror(t *testing.T) {
	const p, q = "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
	state := &syncState{
		Mirror:        account.Mirror{Rev: 9, Prompts: []account.RemotePrompt{{ID: p, Rev: 9, Body: account.PromptBody{Text: "new"}}}},
		Removed:       map[string]int64{"prompts/" + q: 8},
		HeldConflicts: []heldConflict{heldConflictOf(p, 5), heldConflictOf(q, 6)},
	}
	if confirmed := confirmConflicts(state); len(confirmed) != 0 || state.Removed["prompts/"+q] != 8 {
		t.Fatalf("adopted %+v, removed %v; want neither older row taken", confirmed, state.Removed)
	}
}

// #448 review, #390 r17: a held conflict saying the account holds no such
// item (its tombstone pruned) is landing evidence only once the state
// holds the item at another revision than the change was based on (it
// was written again since); at that base, it still removes it.
func TestAnAbsentConflictRowRemovesOnlyAtItsBase(t *testing.T) {
	const p = "00000000-0000-4000-8000-000000000001"
	absent := heldConflict{Conflict: turnedDown{Conflict: account.Conflict{Collection: "prompts", ID: p}, Base: 3}}
	for _, c := range []struct {
		name    string
		rev     int64
		removes bool
	}{
		{"written again since", 9, false},
		{"still at its base", 3, true},
	} {
		state := &syncState{
			Mirror:        account.Mirror{Rev: 9, Prompts: []account.RemotePrompt{{ID: p, Rev: c.rev, Body: account.PromptBody{Text: "v"}}}},
			HeldConflicts: []heldConflict{absent},
		}
		if removes := len(confirmConflicts(state)) == 1; removes != c.removes {
			t.Errorf("%s: removes %v; want %v", c.name, removes, c.removes)
		}
	}
}

// #448 review: a marker whose send an earlier fold already retired is
// replayed as nothing: only the fold that retires a still-open send
// records what it wrote.
func TestAMarkerOfARetiredSendRecordsNothing(t *testing.T) {
	const p = "00000000-0000-4000-8000-000000000001"
	d := newDesk(t.TempDir())
	state := &syncState{
		Mirror:         account.Mirror{Prompts: []account.RemotePrompt{{ID: p, Rev: 5, Body: account.PromptBody{Text: "v0"}}}},
		PromptBaseline: map[string]promptFields{p: {Text: "v0"}},
		PromptAttempts: map[string][]promptAttempt{p: {{Base: 5, Hash: "h", Open: []string{"s1", "s2"}}}},
	}
	if err := os.MkdirAll(d.sendMarkersDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	for send, marker := range map[string]string{"s1": "a:6:H1:0", "s2": "a:7:H2:0"} {
		if err := os.WriteFile(filepath.Join(d.sendMarkersDir(), send), []byte(marker), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	d.foldMarkers(state)
	if got := state.PromptBaselineHash[p]; got != "H1" {
		t.Fatalf("agreed hash %q; want H1, from the fold that retired the open sends", got)
	}
}

// acceptedButUnwritten runs a round in which the service takes the upload
// and only the writes recording its answer fail: the acknowledgement is
// owed in memory and kept in the send's marker.
func acceptedButUnwritten(t *testing.T, mac *Desk, transport *cancelOn) {
	t.Helper()
	blocked := mac.syncStatePath() + ".tmp"
	transport.mu.Lock()
	transport.nth, transport.seen = 1, 0
	transport.cancel = func() {} // the round goes on
	transport.then = func() { _ = os.Mkdir(blocked, 0o700) }
	transport.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a round whose answer couldn't be written reported success")
	}
	_ = os.Remove(blocked)
	transport.mu.Lock()
	transport.cancel = nil
	transport.mu.Unlock()
}

// #390 r17 (variant a): the service takes the upload of v1 and the writes
// recording its answer fail; the app stays open, and the next pull is told
// to start over (410): the account was restored to a backup holding v0.
// The owed acknowledgement makes v1 an agreed body, so the unchanged saved
// v1 is no edit: the restored v0 is taken, and nothing is uploaded.
func TestAnOwedAcknowledgementDoesNotUndoARestore(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodPost}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	w.mu.Lock()
	backup := w.items[p.ID]
	w.mu.Unlock()
	savePrompt(t, mac, p.ID, "", "v1")
	acceptedButUnwritten(t, mac, transport)
	w.mu.Lock()
	w.restoreTo(backup.Rev)
	w.items[p.ID] = backup
	w.floor = backup.Rev + 1 // the next pull is told to start over
	posts := w.posts
	w.mu.Unlock()
	syncEach(t, mac)
	w.mu.Lock()
	sent := w.posts - posts
	w.mu.Unlock()
	if got, body := promptsOf(t, mac)[p.ID], w.livePrompts()[p.ID]; got.Text != "v0" || !strings.Contains(body, `"v0"`) || sent != 0 {
		t.Fatalf("mac's prompt %+v, the account's %s, %d uploads; want the restored v0 in both and none", got, body, sent)
	}
}

// #390 r17 (variant b): the service takes a new prompt's first upload and
// the writes recording its answer fail; the app is opened again, and its
// first pull is told to start over (410): the account was restored to a
// backup from before the prompt. The account held it (the marker's
// acknowledgement) and now lacks it, so the restore deleted it: it goes
// here too, and is not uploaded as a new draft.
func TestAnAcknowledgedPromptARestoreDropsIsNotUploadedAgain(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodPost}
	mac := deviceVia(t, srv, transport)
	savePrompt(t, mac, "", "", "q")
	syncEach(t, mac)
	w.mu.Lock()
	backupRev := w.rev
	w.mu.Unlock()
	p := savePrompt(t, mac, "", "", "v1")
	acceptedButUnwritten(t, mac, transport)
	w.mu.Lock()
	w.restoreTo(backupRev)
	w.floor = backupRev + 1 // the next pull is told to start over
	posts := w.posts
	w.mu.Unlock()
	reopened := reopen(t, srv, mac)
	syncEach(t, reopened)
	w.mu.Lock()
	sent := w.posts - posts
	w.mu.Unlock()
	_, here := promptsOf(t, reopened)[p.ID]
	_, there := w.livePrompts()[p.ID]
	if here || there || sent != 0 {
		t.Fatalf("here %v, in the account %v, %d uploads; want the prompt gone from both and nothing uploaded", here, there, sent)
	}
}

// #390 r18: the service takes the upload of v1 while the revert v0 is
// saved here, and only the writes recording its answer fail. Account B
// then signs in on the same data; its first pull is told to start over
// (410) on its second page, and its restart fails before the switch is
// committed. Back on A, another device writes x. B's 410 is B's: A's
// history goes on, so its acknowledgement still makes v0 an edit over
// v1, and the revert goes over x.
func TestAnotherAccountsResetIsNotThisOnes(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &cancelOn{base: srv.Client().Transport, method: http.MethodPost}
	mac := deviceVia(t, srv, transport)
	p := savePrompt(t, mac, "", "", "v0")
	savePrompt(t, mac, "", "", "q") // so a pull of one item a page has two
	syncEach(t, mac)
	savePrompt(t, mac, p.ID, "", "v1")
	w.mu.Lock()
	w.onPush = func() { savePrompt(t, mac, p.ID, "", "v0") } // the revert, as v1 goes
	w.mu.Unlock()
	acceptedButUnwritten(t, mac, transport)
	gets := &failGet{base: srv.Client().Transport, nth: 3} // page one, page two (410), the restart
	b := newDesk(mac.dir)
	raw, _ := json.Marshal(map[string]string{"refresh_token": fmt.Sprintf("r1.%022d.%043d", 2, 0), "account_id": "acct-2"})
	b.account = account.New(srv.URL, "linux", &signedInStore{raw: raw}, &http.Client{Transport: gets})
	b.accountStore = account.NewSecretsStore(noSecrets{}, errors.New("not found"))
	w.mu.Lock()
	w.pageSize = 1
	w.onNextPage = func() { w.floor = w.rev + 1 }
	w.mu.Unlock()
	if err := b.SyncMachines(context.Background()); err == nil {
		t.Fatal("B's round whose restarted pull failed reported success")
	}
	w.mu.Lock()
	w.pageSize, w.floor = 0, 0
	w.mu.Unlock()
	a := reopen(t, srv, mac)
	w.anotherDeviceWrites(p.ID, "x")
	syncEach(t, a)
	if got, body := promptsOf(t, a)[p.ID], w.livePrompts()[p.ID]; got.Text != "v0" || !strings.Contains(body, `"v0"`) {
		t.Fatalf("A's prompt %+v, the account's %s; want the revert v0 in both", got, body)
	}
}

// #390 r18: a 410 was folded and committed (ResetsSeen 1) but the reset
// record's write failed (it says 0); the app is opened again. A later 410
// whose restart fails is numbered past the committed one (2), so the next
// ordinary pull folds it, and the discarded history's tombstone doesn't
// delete the saved draft.
func TestAResetIsNumberedPastTheOneCommitted(t *testing.T) {
	quietSync(t)
	w, srv := newWorker(t, "")
	transport := &failGet{base: srv.Client().Transport}
	mac := deviceVia(t, srv, transport)
	savePrompt(t, mac, "", "", "v0")
	syncEach(t, mac)
	const draft = "00000000-0000-4000-8000-0000000000bb"
	savePrompt(t, mac, draft, "", "draft")
	state, err := mac.loadSyncState()
	if err != nil {
		t.Fatal(err)
	}
	state.ResetsSeen = 1
	state.HeldConflicts = []heldConflict{{Conflict: turnedDown{Conflict: account.Conflict{Collection: "prompts", ID: draft,
		Server: &account.Item{Collection: "prompts", ID: draft, Rev: state.Mirror.Rev + 1, Deleted: true}}}}}
	if err := mac.storeSyncState(state); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.floor = w.rev + 1 // the pull is told to start over
	w.mu.Unlock()
	transport.mu.Lock()
	transport.nth, transport.seen = 2, 0 // the restart
	transport.mu.Unlock()
	if err := mac.SyncMachines(context.Background()); err == nil {
		t.Fatal("a round whose restarted pull failed reported success")
	}
	w.mu.Lock()
	w.floor = 0
	w.mu.Unlock()
	reopened := reopen(t, srv, mac)
	syncEach(t, reopened)
	if got, body := promptsOf(t, reopened)[draft], w.livePrompts()[draft]; got.Text != "draft" || !strings.Contains(body, `"draft"`) {
		t.Fatalf("the draft here %+v, in the account %s; want it in both", got, body)
	}
}
