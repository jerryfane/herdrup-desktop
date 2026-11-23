package main

import (
	"cmp"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/account"
)

// Machine and prompt sync through the HerdrUp account (design #698 §5,
// hosts and prompts collections; accounts step 5 PR B). Only what
// identifies a machine travels: nickname, host, port, username and whether
// it signs in with a key. The key path, keys, passwords, pins and session
// never do. A synced machine another device added shows on this one to pair
// (SyncedMachines); its key or password is entered here. A saved prompt
// travels whole (title, text, order) and shows on every device.

// syncState is account-sync.json: the account's hosts and prompts as last
// synced (what a local edit is measured against), and the deletes not yet
// pushed.
//
// The invariant across files: a merge's writes of machines.json,
// prompts.json and this file are one (commitMerge). Its baselines classify
// the machines and prompts saved beside them, so a reader never sees one
// file from after a merge and another from before it: a pulled copy saved
// without its baseline would read as a local edit (and go back over newer
// writes), a baseline saved without its copy would read the saved copy as
// one. Every load replays a commit a failure left half applied
// (replayCommit) before reading.
type syncState struct {
	// AccountID is the account this state and the machines' sync ids belong
	// to: another account starts over (a full pull, adopt, then push).
	AccountID string         `json:"accountId"`
	Mirror    account.Mirror `json:"mirror"`
	Deletes   []string       `json:"deletes,omitempty"`
	// Baseline is each machine's shared fields (sharedFields) as this
	// device last agreed them with the account, by sync id: a machine that
	// differs from it was edited here. Device-local fields such as whether
	// this device signs in with a key are not part of it.
	Baseline map[string]account.HostBody `json:"baseline,omitempty"`
	// PromptsPulled is set once Mirror holds the account's prompts: a state
	// from before prompts synced pulls everything once.
	PromptsPulled bool `json:"promptsPulled,omitempty"`
	// PromptDeletes are prompts deleted here and not yet pushed.
	PromptDeletes []string `json:"promptDeletes,omitempty"`
	// PromptBaseline is each prompt's fields as this device last agreed
	// them with the account: a prompt that differs from it was edited here.
	PromptBaseline map[string]promptFields `json:"promptBaseline,omitempty"`
	// PromptAttempts is the journal of prompt writes sent, by prompt id
	// (promptAttempt), and PromptLastSent each prompt's newest send
	// (lastSend). The keys are new (older forms: promptsSent, the newest
	// fields alone, and promptsSending, the ids alone; loadSyncState takes
	// both in), so an older app ignores them instead of reading their
	// shape as damage.
	PromptAttempts map[string][]promptAttempt `json:"promptAttempts,omitempty"`
	PromptLastSent map[string]lastSend        `json:"promptLastSent,omitempty"`
	// Removed are the tombstones pulled, by "collection/id": the revision
	// a write of the item again is based on.
	Removed map[string]int64 `json:"removed,omitempty"`
	// PromptsGone and HostsGone are the tombstones from other devices that
	// the last readback passed: the next sync, pulling from after them,
	// still knows the account held those items.
	PromptsGone []string `json:"promptsGone,omitempty"`
	HostsGone   []string `json:"hostsGone,omitempty"`
	// PushFrom is the write ("collection/id") the next round's pushes
	// start from: a round the service's rate limit stopped leaves it at the
	// first write it didn't settle, so the writes past a long run of
	// refusals get their turn.
	PushFrom string `json:"pushFrom,omitempty"`
	// History counts the account's histories this state has seen: a pull
	// told to start over (410) or a full readback replaces the history, and
	// bumps it. An answer to a send journaled in another history settles
	// only that send (owedAnswer.apply): its rows and revisions are of a
	// history that is gone.
	History int64 `json:"history,omitempty"`
	// LastSync is the newest sync of AccountID that finished well: when,
	// and the items the account held then.
	LastSync *AccountSyncStatus `json:"lastSync,omitempty"`
}

// promptAttempt is the journal's entry for the unanswered sends of one
// prompt with the same body (Hash, sendHash of the body sent: title, text
// and order; a hash, never the text) on the same base_rev: their ids
// (Open), and the deadline each carried (Deadlines).
//
// The journal's invariant: every POST adds its own id, even when an
// identical send is still out, just before it goes (the replay after a
// refused credential included), and only what settles a send takes it
// out of Open; an entry with no open id goes. A dispatch that provably
// wrote nothing settles only that send: refused (any 4xx, settled as soon
// as its status line is read), or failed before it had a connection
// (account.Client.Push says where Go can prove that; once connected it
// can't, and a failure leaves the send open). A canceled round prepares
// nothing. A conflict retires that send, and its row is the first word on
// the prompt's other sends below its revision (decideSends): one landed if
// it holds that one's body (the baseline becomes the row), and all of
// them settle either way, at once, before any later row could hide a
// landing or be taken for one; a pull's rows (in the order they came) and
// a readback's decide the same. With base_rev, an unanswered send at
// base r can land only while the account's row is still at r, so these
// settle every open send of the prompt at r: an applied answer at a
// revision other than r, and a pull showing the row at another revision
// (or absent, for r above 0). An applied answer at r itself (an identical
// copy, not written again) settles only that send. No answer (5xx, a lost
// connection) leaves it open, until its deadline below. Rows decide sends
// as above; otherwise only the merge consumes entries,
// judging their base against the mirror it merges. These facts hold
// within one history: a full pull after a restore (410) can bring a row
// back to an entry's base, so nothing seen before it settles anything,
// and the merge judges every open entry against the restored rows; an
// entry retired before the restore stays retired, and its late commit is
// a foreign write to the next pull. A base-0 send is settled once a row
// exists, which assumes no request outlives the service's tombstone
// pruning (90 days, or 2,000 deletes past it), which could make the row
// vanish again.
//
// The deadline (themartianapp/herdrup#826): the service's sync answers
// carry its clock (now_ms), and a push may carry not_after, the newest
// now_ms this device has seen plus two minutes. The service checks
// not_after inside the write itself (one D1 batch: a push past it, a late
// one included, writes nothing and is refused 409 expired), and reads a
// pull's now_ms before, or atomically with, the snapshot the pull returns.
// So a pull whose now_ms (its earliest page's) is past an entry's deadline,
// with the row still at the entry's base, shows none of its sends landed
// or ever will: it settles the entry as not landed. Each send keeps its
// own not_after (Deadlines, by id; none for one that carried none, when no
// now_ms was seen yet: it can land at any time), and leaves with its id;
// sends dropped past maxOpenSends can still land, so theirs fold into
// Deadlines[""] (0 if one had none, else the latest), which leaves only
// with the entry. The entry's deadline is the latest of its open sends'
// and the fold, and none if any has none. An answer without now_ms is a
// service without #826: nothing settles by time. Neither clock is the
// device's.
//
// The merge reads an open entry whose content the account now holds at a
// revision past its base as that write landing, and lastSend as what this
// device last sent (which tells whether the saved copy was edited since:
// a newer edit saved here is never taken for the copy that was sent).
// A prompt deleted here keeps the entries that can still land, and its
// delete waits for their copy.
//
// The bound: at most maxVariants entries per prompt. A send that would
// open another is not sent: the new edit waits, and the round is
// incomplete, until a definite answer, a pull or a passed deadline
// settles an entry; then the newest edit goes (never an older body
// again). At most maxOpenSends ids stay open per entry, the oldest going
// first (landing is judged per entry). So the journal stays within
// maxVariants entries per prompt, whatever the failures; writing it is
// part of the round, and a round whose state write fails stops before it
// sends. An entry with no hash is one kept from before hashes were, and
// tells nothing but that; a Legacy one was migrated from a state that kept
// only the title and text sent (promptsSent), so its Hash is promptHash's
// and it matches a row on those alone.
//
// One rule decides whether a row is one of these sends landing
// (landedEntry), for the merge, a conflict's row, a pull's pages and a
// readback alike: an entry with a send that may have written the row (an
// open one other than a send the service turned down, or the trimmed
// ones; with no deadline, or one the row's updated_ms is not past: the
// service writes a push only up to its not_after, and stamps the row with
// that push's time, sync.ts UPSERT), based below the row's revision, whose
// body the row holds.
type promptAttempt struct {
	Base int64    `json:"base"`
	Hash string   `json:"hash,omitempty"`
	Open []string `json:"open,omitempty"`
	// Deadlines are the not_after of the open sends (the service's Unix
	// ms) by id, absent for one sent without; "" folds the trimmed ones.
	Deadlines map[string]int64 `json:"deadlines,omitempty"`
	Legacy    bool             `json:"legacy,omitempty"`
}

// mayHaveWritten is whether one of a's sends, other than except, may have
// written a row stamped updatedMs (0: unknown) at revision rev
// (promptAttempt).
func (a promptAttempt) mayHaveWritten(rev, updatedMs int64, except string) bool {
	if rev <= a.Base {
		return false
	}
	// This relies on updated_ms being D1's clock at the write, the clock
	// not_after is judged by (themartianapp/herdrup#828); a row stamped
	// with the Worker's arrival time could pass for an expired upload.
	inTime := func(deadline int64) bool { return deadline == 0 || updatedMs == 0 || updatedMs <= deadline }
	if fold, trimmed := a.Deadlines[""]; trimmed && inTime(fold) {
		return true
	}
	return slices.ContainsFunc(a.Open, func(id string) bool { return id != except && inTime(a.Deadlines[id]) })
}

// landedEntry is the index in entries of the one whose send landed as row
// (promptAttempt's rule; except, a send the service turned down), or -1.
// The row is hashed only once an entry may have written it.
func landedEntry(row account.RemotePrompt, entries []promptAttempt, except string) int {
	var body, fields string
	return slices.IndexFunc(entries, func(a promptAttempt) bool {
		if !a.mayHaveWritten(row.Rev, row.UpdatedMs, except) {
			return false
		}
		if a.Legacy {
			if fields == "" {
				fields = promptHash(bodyFields(row.Body))
			}
			return a.Hash == fields
		}
		if body == "" {
			body = sendHash(row.Body)
		}
		return a.Hash == body
	})
}

// deadline is the entry's deadline (promptAttempt): the latest of its
// sends' not_after, 0 (none: never by time) if any send has none.
func (a promptAttempt) deadline() int64 {
	var latest int64
	for _, id := range a.Open {
		d := a.Deadlines[id]
		if d == 0 {
			return 0
		}
		latest = max(latest, d)
	}
	if fold, trimmed := a.Deadlines[""]; trimmed {
		if fold == 0 {
			return 0
		}
		latest = max(latest, fold)
	}
	return latest
}

// sendHash identifies the body of a prompt write in the journal: title,
// text and order (a copy with the same text in another place is another
// device's write).
func sendHash(b account.PromptBody) string {
	raw, _ := json.Marshal([]any{b.Title, b.Text, b.Order})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// lastSend is a prompt's newest send (promptAttempt): the hash of its
// title and text (promptHash, what a saved prompt has to compare).
// Only the merge drops it, once it has used it and the prompt has no entry
// left. (A state from before keeps the send's base, body, id and sequence
// number here too; nothing reads them, and they are dropped.)
type lastSend struct {
	Hash string `json:"hash"`
}

const (
	// maxVariants bounds a prompt's journal entries (promptAttempt).
	maxVariants = 2
	// maxOpenSends bounds promptAttempt.Open.
	maxOpenSends = 8
)

// promptHash identifies a prompt's synced content in the journal.
func promptHash(f promptFields) string {
	raw, _ := json.Marshal([]string{f.Title, f.Text})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (d *Desk) syncStatePath() string { return filepath.Join(d.dir, "account-sync.json") }

// loadSyncState reads account-sync.json; none yet is an empty state, and an
// unreadable or damaged one is an error (never a silent restart, which
// would drop pending deletes). d.storeMu must be held.
func (d *Desk) loadSyncState() (syncState, error) {
	if err := d.replayCommit(); err != nil {
		return syncState{}, err
	}
	raw, err := os.ReadFile(d.syncStatePath())
	if errors.Is(err, os.ErrNotExist) {
		return syncState{}, nil
	}
	if err != nil {
		return syncState{}, err
	}
	// The state and the older forms of PromptAttempts are read in one go:
	// one of the wrong type is a damaged state too. Their writes were sent
	// with no base: they could land while the account lacks the prompt.
	var file struct {
		syncState
		Sent    map[string]promptFields `json:"promptsSent"`
		Sending []string                `json:"promptsSending"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return syncState{}, fmt.Errorf("account sync state %s: %w", d.syncStatePath(), err)
	}
	s := file.syncState
	attempted := func(id string, f *promptFields) {
		if _, ok := s.PromptAttempts[id]; ok {
			return
		}
		if s.PromptAttempts == nil {
			s.PromptAttempts = map[string][]promptAttempt{}
		}
		entry := promptAttempt{Open: []string{"legacy"}}
		if f != nil {
			entry.Hash, entry.Legacy = promptHash(*f), true // the order sent is unknown
			if s.PromptLastSent == nil {
				s.PromptLastSent = map[string]lastSend{}
			}
			s.PromptLastSent[id] = lastSend{Hash: promptHash(*f)}
		}
		s.PromptAttempts[id] = []promptAttempt{entry}
	}
	for id, f := range file.Sent {
		attempted(id, &f)
	}
	for _, id := range file.Sending {
		attempted(id, nil)
	}
	return s, nil
}

// storeSyncState writes account-sync.json alone (atomically), after any
// commit a failure left. d.storeMu must be held.
func (d *Desk) storeSyncState(s syncState) error {
	if err := d.replayCommit(); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(d.syncStatePath(), raw)
}

// syncCommit is sync-commit.json: one merge's new machines.json and
// prompts.json (each none when unchanged), account-sync.json and the
// machines whose id it changed (Renamed, from → to), in one record
// (syncState's invariant).
type syncCommit struct {
	Machines json.RawMessage   `json:"machines,omitempty"`
	Prompts  json.RawMessage   `json:"prompts,omitempty"`
	Sync     json.RawMessage   `json:"sync"`
	Renamed  map[string]string `json:"renamed,omitempty"`
}

func (d *Desk) commitPath() string { return filepath.Join(d.dir, "sync-commit.json") }

// commitMerge writes a merge's machines (nil: unchanged), prompts (nil:
// unchanged), sync state and machine renames as one: the commit record
// first, in one atomic write (until it is in place nothing has changed),
// then each file and the board cache, then the record goes. A failure
// after the record leaves it, and the next load finishes it
// (replayCommit). recorded is whether the record is in place: from then
// on the commit holds what it applied (the owed answers a merge paid),
// even when err says a file failed. d.storeMu must be held.
func (d *Desk) commitMerge(machines []byte, ps *promptStore, renamed map[string]string, s syncState) (recorded bool, err error) {
	c := syncCommit{Machines: machines, Renamed: renamed}
	if ps != nil {
		if c.Prompts, err = encodePrompts(*ps); err != nil {
			return false, err
		}
	}
	if c.Sync, err = json.MarshalIndent(s, "", "  "); err != nil {
		return false, err
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return false, err
	}
	if err := writeFileAtomic(d.commitPath(), raw); err != nil {
		return false, err
	}
	return true, d.applyCommit(c)
}

// applyCommit writes a commit record's files and moves the board cache of
// each renamed machine (as SaveMachine: the cache follows a machine's id),
// then removes the record. Doing them again is harmless, so a replay may
// repeat what a failed apply already did.
func (d *Desk) applyCommit(c syncCommit) error {
	if c.Machines != nil {
		if err := writeFileAtomic(d.machinesPath(), c.Machines); err != nil {
			return err
		}
	}
	if c.Prompts != nil {
		if err := writeFileAtomic(d.promptsPath(), c.Prompts); err != nil {
			return err
		}
	}
	if err := writeFileAtomic(d.syncStatePath(), c.Sync); err != nil {
		return err
	}
	for from, to := range c.Renamed {
		d.boards.forget(from)
		d.boards.allow(to)
	}
	return os.Remove(d.commitPath())
}

// replayCommit finishes a merge's commit a failure left half applied, so
// the files are read as all after it. Each load calls it first. d.storeMu
// must be held.
func (d *Desk) replayCommit() error {
	raw, err := os.ReadFile(d.commitPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var c syncCommit
	if err := json.Unmarshal(raw, &c); err != nil {
		return fmt.Errorf("account sync commit %s: %w", d.commitPath(), err)
	}
	return d.applyCommit(c)
}

// sharedFields are the fields one device's edit of a machine changes for
// every device: nickname, host, port and username.
func sharedFields(m Machine) account.HostBody {
	port := m.Port
	if port == 0 {
		port = 22
	}
	return account.HostBody{Nickname: m.Nickname, Host: m.Host, Port: port, Username: m.User}
}

func sharedOf(b account.HostBody) account.HostBody {
	if b.Port == 0 {
		b.Port = 22
	}
	return account.HostBody{Nickname: b.Nickname, Host: b.Host, Port: b.Port, Username: b.Username}
}

// hostBody is what a saved machine syncs as, over base (the account's copy,
// so fields this app doesn't keep, such as label, are kept). Whether it
// signs in with a key is this device's: it is sent for a new machine only,
// and an edit keeps the account's value.
func hostBody(m Machine, base account.HostBody) account.HostBody {
	b := base
	s := sharedFields(m)
	b.Nickname, b.Host, b.Port, b.Username = s.Nickname, s.Host, s.Port, s.Username
	if b.AuthKind == "" {
		b.AuthKind = "password"
		if m.KeyPath != "" {
			b.AuthKind = "key"
		}
	}
	return b
}

// sameHost reports whether a machine's shared fields equal body's.
func sameHost(m Machine, body account.HostBody) bool {
	return sharedFields(m) == sharedOf(body)
}

// SyncedMachine is an account machine this device hasn't saved: the
// "Welcome back" list offers to pair it (1B).
type SyncedMachine struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname,omitempty"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	// Key says the machine signs in with a key, so pairing asks for one.
	Key bool `json:"key"`
}

// SyncedMachinesChanged tells the page the account's machines changed.
var SyncedMachinesChanged = mygo.NewEvent[[]SyncedMachine]("syncedMachines:changed")

var publishSyncedMachines = func(m []SyncedMachine) { SyncedMachinesChanged.Broadcast(m) }

// accountSync runs one sync at a time: a call waits for the one running and
// then makes its own, so it returns once a sync that began after it is done.
// turn is that one place (newDesk makes it): a call holds it by filling it,
// and one whose context ends while it waits leaves without syncing.
// failed holds the accounts whose newest finished sync failed: the host
// home's account avatar says "needs attention" while the signed-in one is
// among them. It has its own lock, as accountState reads it while a sync
// holds turn.
type accountSync struct {
	turn     chan struct{}
	failedMu sync.Mutex
	failed   map[string]bool
	// owed are answers to sent requests not yet written (settleSend);
	// the next merge's commit writes them. rows are conflict rows waiting
	// for their history to be confirmed (heldRow). Only the round holding
	// turn touches them, so turn is their lock too.
	owed []owedAnswer
	rows []heldRow
}

// syncRoundTimeout bounds each sync round, its wait for the turn included:
// a stalled one can't hold every later sync's turn.
var syncRoundTimeout = time.Minute

// errSyncAbandoned is a sync dropped because the session became another
// account's (or ended) while it ran: it neither failed nor succeeded.
var errSyncAbandoned = errors.New("account sync abandoned: the session changed")

// syncFailed is whether acct's newest finished sync failed.
func (d *Desk) syncFailed(acct string) bool {
	d.accountSync.failedMu.Lock()
	defer d.accountSync.failedMu.Unlock()
	return d.accountSync.failed[acct]
}

// noteSync records how acct's sync ended, leaving every other account's
// result as it was, and tells the page when that changes whether acct needs
// attention.
func (d *Desk) noteSync(acct string, failed bool) {
	d.accountSync.failedMu.Lock()
	was := d.accountSync.failed[acct]
	if failed {
		if d.accountSync.failed == nil {
			d.accountSync.failed = map[string]bool{}
		}
		d.accountSync.failed[acct] = true
	} else {
		delete(d.accountSync.failed, acct)
	}
	d.accountSync.failedMu.Unlock()
	if was != failed {
		publishAccount(d.accountState(""))
	}
}

// SyncedMachines is the account's machines this device hasn't saved, as
// last synced (no network).
func (d *Desk) SyncedMachines() ([]SyncedMachine, error) {
	cur, _ := d.account.Current()
	if cur == nil {
		return []SyncedMachine{}, nil
	}
	d.storeMu.Lock()
	st, err := d.load()
	state, stateErr := d.loadSyncState()
	d.storeMu.Unlock()
	if err = errors.Join(err, stateErr); err != nil {
		return nil, err
	}
	if state.AccountID != cur.AccountID {
		// Another account's machines: nothing until this one has synced.
		return []SyncedMachine{}, nil
	}
	return unsavedHosts(st.Machines, state.Mirror.Hosts), nil
}

func unsavedHosts(local []Machine, mirror []account.RemoteHost) []SyncedMachine {
	saved := map[account.HostIdentity]bool{}
	for _, m := range local {
		saved[account.IdentityOf(hostBody(m, account.HostBody{}))] = true
	}
	out := []SyncedMachine{}
	for _, h := range mirror {
		if saved[account.IdentityOf(h.Body)] {
			continue
		}
		saved[account.IdentityOf(h.Body)] = true // a fork shows once
		port := h.Body.Port
		if port == 0 {
			port = 22
		}
		out = append(out, SyncedMachine{ID: h.ID, Nickname: h.Body.Nickname, Host: h.Body.Host, Port: port, User: h.Body.Username, Key: h.Body.AuthKind != "password"})
	}
	return out
}

// SyncMachines is one sync round with the account: it pulls the account's
// machines and prompts, merges them into the saved ones and pushes this
// device's changes. Without a session it does nothing. It ends by
// syncRoundTimeout, or sooner when ctx ends, waiting for its turn
// included: a call whose ctx ends before its turn returns ctx's error
// without syncing.
func (d *Desk) SyncMachines(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, syncRoundTimeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case d.accountSync.turn <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-d.accountSync.turn }()
	round, signedIn, err := d.account.Round()
	if err == nil && signedIn {
		err = d.syncMachinesOnce(ctx, round)
	}
	if errors.Is(err, account.ErrSignedOut) {
		publishAccount(d.accountState(""))
		return nil
	}
	// A sync the session left (another account, a sign-in again, or none)
	// says nothing about this account: its last result stands. The same
	// holds for a round whose session ended as it finished: its result is
	// not the session now signed in's.
	if errors.Is(err, errSyncAbandoned) || signedIn && !d.account.Holds(round) {
		return nil
	}
	if signedIn {
		d.noteSync(round.Account, err != nil)
	}
	return err
}

// syncPasses is how many times one round pushes. A change the service
// turns down (another device wrote its item since this device's pull) is
// merged with the account's copy and sent again in the same round; after
// the last push pass one more merge runs without pushing, and a round
// whose merge still has writes to send fails (errSyncConflicted).
const syncPasses = 3

var (
	// errTurnedDown is a pass the service turned a change down in, and
	// nothing else went wrong: the round goes on with another pass.
	errTurnedDown = errors.New("account sync: a change was turned down")
	// errSyncConflicted is a round that ended with changes still to send
	// after syncPasses pushes the service turned down.
	errSyncConflicted = errors.New("account sync: the account kept changing under this device's changes; they go next time")
	// errUnsendable is a round that left a saved prompt the service would
	// not take (too long, even without an order) here, unsent.
	errUnsendable = errors.New("account sync: a saved prompt is too large for the account to take")
	// errEditHeldBack is a round that held a prompt's edit back: earlier
	// sends of it are unsettled up to the journal's bound (maxVariants).
	errEditHeldBack = errors.New("account sync: an edit waits for earlier uploads of its prompt to settle; it goes next time")
	// errDeleteHeldBack is a round that kept a prompt's delete back behind
	// an upload of it that may still land (it goes once a copy shows, or
	// once nothing can land).
	errDeleteHeldBack = errors.New("account sync: a delete waits for an earlier upload of its prompt to settle; it goes next time")
	// errDeleteUndone is a round whose readback found a restored account
	// holding an item it deleted: the delete goes again next time.
	errDeleteUndone = errors.New("account sync: a restore of the account brought back a deleted item; it is deleted again next time")
)

// syncMachinesOnce is one round for account acct, the one signed in when it
// began: every pass is acct's, and a session that became another account's
// (or none) abandons the round.
func (d *Desk) syncMachinesOnce(ctx context.Context, round account.Round) error {
	for pass := 0; ; pass++ {
		if err := d.syncPass(ctx, round, pass < syncPasses); !errors.Is(err, errTurnedDown) {
			return err
		}
	}
}

// syncPass is one pull, merge and (with push) push of a round for account
// acct: errTurnedDown when the service turned a change down. Without push,
// a merge that has changes to send is errSyncConflicted.
func (d *Desk) syncPass(ctx context.Context, round account.Round, push bool) error {
	// The round belongs to the session it started in (round): once that
	// ends (a sign-out, another account, or a sign-in again to this one),
	// its result is dropped, and nothing is sent or written for it. Its
	// requests check the same (account.Client.PullSince, Push).
	acct := round.Account
	still := func() bool { return d.account.Holds(round) }
	if !still() {
		return errSyncAbandoned
	}
	if !d.storeMu.LockCtx(ctx) {
		return ctx.Err()
	}
	state, err := d.loadSyncState()
	d.storeMu.Unlock()
	if err != nil {
		return err
	}
	switched := state.AccountID != acct
	if switched {
		// Another account (or the first sync): pull everything first and
		// adopt its ids before this device pushes anything.
		state = syncState{AccountID: acct}
	}
	since := state.Mirror.Rev
	if !state.PromptsPulled {
		// A mirror from before prompts synced lacks the account's prompts.
		since = 0
	}
	pull, err := d.account.PullSince(ctx, round, since)
	if errors.Is(err, account.ErrAccountChanged) {
		return errSyncAbandoned
	}
	if err != nil {
		return err
	}
	old := state.Mirror
	mirror, tombstoned := old.Apply(pull)
	// The ids the account is known to have held: a machine with one of
	// these that the account no longer lists was deleted elsewhere; any
	// other id it doesn't list was never acknowledged, and is pushed again.
	// The last readback may have passed other devices' deletes (HostsGone;
	// none for another account, whose state starts over).
	known := map[string]bool{}
	for _, h := range old.Hosts {
		known[h.ID] = true
	}
	for id := range tombstoned.Hosts {
		known[id] = true
	}
	for _, id := range state.HostsGone {
		known[id] = true
	}
	// The same for prompts, but on this device's first prompt sync none is
	// known (AccountLocalSync.swift): the account's old deletes don't take
	// prompts this device never synced.
	knownPrompts := map[string]bool{}
	for _, p := range old.Prompts {
		knownPrompts[p.ID] = true
	}
	if state.PromptsPulled {
		for id := range tombstoned.Prompts {
			knownPrompts[id] = true
		}
		for _, id := range state.PromptsGone {
			knownPrompts[id] = true
		}
	}

	// The lock may be long in coming: the wait ends with the round, and a
	// round past its deadline applies nothing.
	if !d.storeMu.LockCtx(ctx) {
		return ctx.Err()
	}
	if !still() {
		d.storeMu.Unlock()
		return errSyncAbandoned
	}
	if err := ctx.Err(); err != nil {
		d.storeMu.Unlock()
		return err
	}
	st, err := d.load()
	if err != nil {
		d.storeMu.Unlock()
		return err
	}
	// To tell whether the merge changed the machines (Machine is
	// comparable).
	loadedActive, loadedMachines := st.Active, slices.Clone(st.Machines)
	latest, err := d.loadSyncState()
	if err != nil {
		d.storeMu.Unlock()
		return err
	}
	ps, err := d.loadPrompts()
	if err != nil {
		d.storeMu.Unlock()
		return err
	}
	if !switched {
		// A pull told to start over (410) replaced the history.
		if pull.Full && since != 0 {
			latest.History++
		}
		// Answers to requests an earlier round sent not yet written
		// (settleSend), those only send markers hold (foldMarkers: a run
		// of the app that ended first), the conflict rows of this history
		// (confirmRows), then the pull's rows, page by page in the order
		// they came: the first row of a prompt past a send's base decides
		// that send, landed or not, and no later row revives it
		// (decideSends).
		d.payOwed(acct, &latest)
		d.foldMarkers(&latest)
		d.confirmRows(&latest)
		for _, it := range pull.Items {
			if it.Collection == "prompts" {
				decideSends(&latest, it, "")
			}
		}
	}
	pending, baseline := latest.Deletes, latest.Baseline
	pendingPrompts, promptBaseline, lastSync, attempts := latest.PromptDeletes, latest.PromptBaseline, latest.LastSync, latest.PromptAttempts
	lastSent := latest.PromptLastSent
	removed, pushFrom := latest.Removed, latest.PushFrom
	if switched {
		pending, baseline = nil, nil
		pendingPrompts, promptBaseline, lastSync, attempts = nil, nil, nil, nil
		lastSent = nil
		removed, pushFrom = nil, ""
		for i := range st.Machines {
			st.Machines[i].SyncID = ""
		}
	}
	removed = noteRemoved(removed, pull.Full, tombstoned, mirror)
	changes, deletes, renamed, baseline := mergeMachines(&st, old, mirror, known, pending, baseline)
	prompts, promptChanges, promptDeletes, promptBaseline, unsendable := mergePrompts(ps.Prompts, old.Prompts, mirror.Prompts, knownPrompts, pendingPrompts, promptBaseline, attempts, lastSent)
	promptsChanged := !slices.Equal(prompts, ps.Prompts)
	// Every change is based on the revision this device last saw of its
	// item (base_rev: the service writes it only from there): the
	// mirror's, a tombstone's, or 0 for one the account never held.
	changes = append(changes, promptChanges...)
	revs := baseRevs(mirror, removed)
	for i := range changes {
		changes[i].Base = revs[changes[i].Collection+"/"+changes[i].ID]
	}
	// The writes that may still land: those the pull is past, or past
	// their deadline (promptAttempt), are settled.
	attempts = settleAttempts(attempts, revs, pull.NowMs)
	// A delete made here of a prompt whose upload may still land (sent,
	// unanswered, and based on the revision the account still holds, 0
	// for none) stays pending, unsent while the account holds no live
	// copy: the service takes a delete of an item it doesn't hold as done
	// without writing anything (sync.ts UPSERT), and the late upload would
	// bring the prompt back. Once a copy shows, the merge deletes it.
	deleteWaits := false
	for _, id := range pendingPrompts {
		if !slices.Contains(promptDeletes, id) && !slices.ContainsFunc(prompts, func(p SavedPrompt) bool { return p.ID == id }) &&
			slices.ContainsFunc(attempts[id], func(a promptAttempt) bool { return len(a.Open) > 0 && a.Base == revs["prompts/"+id] }) {
			promptDeletes = append(promptDeletes, id)
			deleteWaits = true
		}
	}
	// Deletes go first (they free room); the writes start where the last
	// round the rate limit stopped left off (PushFrom).
	var dels, writes []account.Change
	for _, c := range changes {
		if c.Deleted {
			dels = append(dels, c)
		} else {
			writes = append(writes, c)
		}
	}
	if i := slices.IndexFunc(writes, func(c account.Change) bool { return c.Collection+"/"+c.ID == pushFrom }); i > 0 {
		writes = slices.Concat(writes[i:], writes[:i])
	}
	// A prompt neither saved here nor waiting for its tombstone needs no
	// entry. The merge has used each prompt's last send: once no entry is
	// left, it goes too.
	for id := range attempts {
		if !slices.ContainsFunc(prompts, func(p SavedPrompt) bool { return p.ID == id }) && !slices.Contains(promptDeletes, id) {
			delete(attempts, id)
		}
	}
	lastSent = maps.Clone(lastSent)
	maps.DeleteFunc(lastSent, func(id string, _ lastSend) bool { return len(attempts[id]) == 0 })
	removed = usedRemoved(removed, st.Machines, deletes, prompts, promptDeletes, attempts)
	state = syncState{AccountID: acct, Mirror: mirror, Deletes: deletes, Baseline: baseline, PromptsPulled: true,
		PromptDeletes: promptDeletes, PromptBaseline: promptBaseline, PromptAttempts: attempts, PromptLastSent: lastSent,
		Removed: removed, PushFrom: pushFrom, LastSync: lastSync, History: latest.History}
	// The machines, prompts and the state that classifies them, as one
	// (syncState).
	var changedPrompts *promptStore
	if promptsChanged {
		ps.Prompts = prompts
		changedPrompts = &ps
	}
	var machines []byte
	if st.Active != loadedActive || !slices.Equal(st.Machines, loadedMachines) {
		if machines, err = encodeMachines(st); err != nil {
			d.storeMu.Unlock()
			return err
		}
	}
	recorded, err := d.commitMerge(machines, changedPrompts, renamed, state)
	if recorded {
		// The record holds what the merge paid, even if a file failed.
		d.accountSync.owed, d.accountSync.rows = nil, nil
		d.dropSendMarkers(state)
	}
	if err != nil {
		d.storeMu.Unlock()
		return err
	}
	d.storeMu.Unlock()
	if promptsChanged {
		publishSavedPrompts(listOf(prompts))
	}
	if !push && len(changes) > 0 {
		return errSyncConflicted
	}

	queue, err := account.Batches(slices.Concat(dels, writes))
	if err != nil {
		return err
	}
	// acked are the changes the service wrote (or already held), conflicts
	// the ones it turned down because their base was stale, and settled
	// the writes this round is done with. unsent is why a change is still
	// here unsent at the end of the round, which then fails.
	var acked []account.Change
	var conflicts []account.Conflict
	settled := map[string]bool{}
	// heldBack are the writes prepare held back at dispatch (a prompt's
	// variants at maxVariants): no work for a resumed round to start from.
	heldBack := map[string]bool{}
	var unsent error
	if deleteWaits {
		unsent = errDeleteHeldBack // the round is incomplete until the delete goes
	}
	// send pushes what of planned holds at dispatch (recordAttempts), and
	// returns what the (last) dispatch sent.
	send := func(planned []account.Change) ([]account.Change, error) {
		var part []account.Change
		var sent map[string]sentAttempt
		res, err := d.account.Push(ctx, round, func(notAfter int64) ([]account.Change, error) {
			var held []string
			var err error
			part, sent, held, err = d.recordAttempts(ctx, acct, planned, notAfter)
			for _, id := range held {
				heldBack["prompts/"+id] = true
			}
			if len(held) > 0 && unsent == nil {
				unsent = errEditHeldBack
			}
			return part, err
		}, func() error {
			// The dispatch provably wrote nothing (refused, told by its
			// status line before its body, or never connected): its sends
			// are settled now, before any refresh and replay.
			err := d.settleSend(ctx, acct, sent, nil, nil)
			sent = nil
			return err
		})
		if err != nil {
			return part, err
		}
		if len(part) == 0 {
			return nil, nil
		}
		stale := map[string]bool{}
		for _, c := range res.Conflicts {
			stale[c.Collection+"/"+c.ID] = true
		}
		conflicts = append(conflicts, res.Conflicts...)
		var applied []account.Change
		for _, c := range part {
			settled[c.Collection+"/"+c.ID] = true
			if !stale[c.Collection+"/"+c.ID] {
				applied = append(applied, c)
			}
		}
		acked = append(acked, applied...)
		return part, d.settleSend(ctx, acct, sent, applied, &res)
	}
	for len(queue) > 0 {
		part := queue[0]
		queue = queue[1:]
		dispatched, err := send(part)
		if err == nil {
			continue
		}
		var api *account.APIError
		if errors.As(err, &api) && api.Status == http.StatusTooManyRequests {
			// Out of pushes for now (the service's rate limit): the rest go
			// next round, from the first write this one didn't settle.
			unsent = err
			break
		}
		if !overQuota(err) && !tooLarge(err) {
			// Nothing is lost: an unacknowledged id is pushed again next
			// time, and pending deletes stay pending. Another account's
			// session gets none of this account's changes.
			if errors.Is(err, account.ErrAccountChanged) {
				return errSyncAbandoned
			}
			return err
		}
		// The service refuses a push past the account's quota, or past its
		// size limit, whole: the changes that dispatch sent (dispatched;
		// prepare may have dropped some of part) are split. Past the quota,
		// its deletes (which free room) go on their own first, and its
		// writes are halved; past the size limit, it is halved, deletes and
		// all (order kept, so deletes stay ahead). Each part goes in or is
		// refused alone. A part refused alone is not asked again this round
		// (no smaller request holds it), and leaves the round incomplete; a
		// split whose parts all go in does not.
		var partDels, partWrites []account.Change
		for _, c := range dispatched {
			if c.Deleted {
				partDels = append(partDels, c)
			} else {
				partWrites = append(partWrites, c)
			}
		}
		switch {
		case tooLarge(err) && len(dispatched) > 1:
			half := (len(dispatched) + 1) / 2
			queue = append([][]account.Change{dispatched[:half], dispatched[half:]}, queue...)
		case len(partDels) > 0 && len(partWrites) > 0:
			queue = append([][]account.Change{partDels, partWrites}, queue...)
		case len(partWrites) > 1:
			half := (len(partWrites) + 1) / 2
			queue = append([][]account.Change{partWrites[:half], partWrites[half:]}, queue...)
		default:
			unsent = err
			for _, c := range part {
				settled[c.Collection+"/"+c.ID] = true
			}
		}
	}
	pushFrom = ""
	if api := (*account.APIError)(nil); errors.As(unsent, &api) && api.Status == http.StatusTooManyRequests {
		if i := slices.IndexFunc(writes, func(c account.Change) bool {
			return !settled[c.Collection+"/"+c.ID] && !heldBack[c.Collection+"/"+c.ID]
		}); i >= 0 {
			pushFrom = writes[i].Collection + "/" + writes[i].ID
		}
	}
	var readBack account.Pull
	if len(acked) > 0 {
		// Read our own writes back, so the mirror holds what the account holds.
		readBack, err = d.account.PullSince(ctx, round, mirror.Rev)
		if errors.Is(err, account.ErrAccountChanged) {
			return errSyncAbandoned
		}
		if err != nil {
			return err
		}
	}
	// The readback, the turned-down copies and the round's result are
	// applied only by a round still running once it has the store (the
	// answers to its requests were written as they came, settleSend).
	if !d.storeMu.LockCtx(ctx) {
		return ctx.Err()
	}
	if !still() {
		d.storeMu.Unlock()
		return errSyncAbandoned
	}
	if err := ctx.Err(); err != nil {
		d.storeMu.Unlock()
		return err
	}
	state, err = d.loadSyncState()
	if err != nil {
		d.storeMu.Unlock()
		return err
	}
	// A change the service turned down (its base was stale) is not
	// acknowledged, and the copy the service answered with is the
	// account's for that item, whatever this device held: none (the next
	// write creates it), a tombstone (deleted elsewhere), or a newer copy.
	// An empty pull can't bring it (a pruned tombstone). The next pass
	// merges it as usual, a local edit against the account's copy.
	state.Mirror = state.Mirror.Adopt(conflicts)
	var turnedDownGone []account.Conflict
	for _, c := range conflicts {
		key := c.Collection + "/" + c.ID
		delete(state.Removed, key)
		if c.Server != nil && c.Server.Deleted {
			if state.Removed == nil {
				state.Removed = map[string]int64{}
			}
			state.Removed[key] = c.Server.Rev
			turnedDownGone = append(turnedDownGone, c)
		}
	}
	newTombstones := len(turnedDownGone) > 0 // added since the merge's prune
	if len(acked) > 0 {
		pushed, wrote := map[string]bool{}, map[string]bool{}
		for _, c := range acked {
			if c.Deleted {
				pushed[c.Collection+"/"+c.ID] = true
			} else {
				wrote[c.Collection+"/"+c.ID] = true
			}
		}
		held := state.Mirror
		var readGone account.Tombstones
		state.Mirror, readGone = state.Mirror.Apply(readBack)
		if readBack.Full {
			state.History++ // a restore under the push: another history
		}
		state.Removed = noteRemoved(state.Removed, readBack.Full, readGone, state.Mirror)
		newTombstones = newTombstones || len(readGone.Hosts)+len(readGone.Prompts) > 0
		// The conflict rows of the history the readback confirms, then the
		// readback's rows, decide the held uploads below them as the pull's
		// do, at once: the next pull may already hold another device's
		// write over a landing.
		d.confirmRows(&state)
		for _, it := range readBack.Items {
			if it.Collection == "prompts" {
				decideSends(&state, it, "")
			}
		}
		// A full readback is the account's history started over (a
		// restore): present is what the restored account holds.
		present := map[string]bool{}
		if readBack.Full {
			for _, h := range state.Mirror.Hosts {
				present["hosts/"+h.ID] = true
			}
			for _, p := range state.Mirror.Prompts {
				present["prompts/"+p.ID] = true
			}
		}
		// A delete the service took stays pending when the restored history
		// still holds the item: the next round deletes it there again.
		state.Deletes = slices.DeleteFunc(state.Deletes, func(id string) bool { return pushed["hosts/"+id] && !present["hosts/"+id] })
		state.PromptDeletes = slices.DeleteFunc(state.PromptDeletes, func(id string) bool { return pushed["prompts/"+id] && !present["prompts/"+id] })
		if unsent == nil && (slices.ContainsFunc(state.Deletes, func(id string) bool { return pushed["hosts/"+id] }) ||
			slices.ContainsFunc(state.PromptDeletes, func(id string) bool { return pushed["prompts/"+id] })) {
			unsent = errDeleteUndone // the round is incomplete until it goes
		}
		// Deletes from other devices the readback passed: the local copies
		// go next time, unless edited, instead of being uploaded again.
		// After a restore, what the mirror held and the restored account
		// doesn't is gone as well, except what this round just wrote.
		var goneHosts, gonePrompts []string
		for id := range readGone.Hosts {
			if !pushed["hosts/"+id] {
				goneHosts = append(goneHosts, id)
			}
		}
		for id := range readGone.Prompts {
			if !pushed["prompts/"+id] {
				gonePrompts = append(gonePrompts, id)
			}
		}
		if readBack.Full {
			for _, h := range held.Hosts {
				if key := "hosts/" + h.ID; !present[key] && !wrote[key] && !pushed[key] {
					goneHosts = append(goneHosts, h.ID)
				}
			}
			for _, p := range held.Prompts {
				if key := "prompts/" + p.ID; !present[key] && !wrote[key] && !pushed[key] {
					gonePrompts = append(gonePrompts, p.ID)
				}
			}
		}
		state.HostsGone, state.PromptsGone = goneHosts, gonePrompts
	}
	for _, c := range turnedDownGone {
		if c.Collection == "hosts" {
			state.HostsGone = append(state.HostsGone, c.ID)
		} else {
			state.PromptsGone = append(state.PromptsGone, c.ID)
		}
	}
	state.PushFrom = pushFrom
	// The merge pruned the tombstones; again only when the push or its
	// readback changed what that saw: tombstones added, or pending deletes
	// and open sends settled.
	if newTombstones || len(state.Deletes) < len(deletes) || len(state.PromptDeletes) < len(promptDeletes) || len(state.PromptAttempts) < len(attempts) {
		state.Removed = usedRemoved(state.Removed, st.Machines, state.Deletes, prompts, state.PromptDeletes, state.PromptAttempts)
	}
	// A round that left a change unsent did not finish well: the status
	// keeps the last one that did, and so does a pass whose turned-down
	// changes the next pass sends again.
	if unsent == nil && len(conflicts) == 0 && !unsendable {
		state.LastSync = &AccountSyncStatus{LastSyncedMs: time.Now().UnixMilli(), Machines: len(state.Mirror.Hosts), Prompts: len(state.Mirror.Prompts)}
	}
	err = d.storeSyncState(state)
	d.storeMu.Unlock()
	if err != nil {
		return err
	}
	if len(acked) > 0 {
		d.accountSync.rows = nil // the readback's state holds what they decided
	}
	publishSyncedMachines(unsavedHosts(st.Machines, state.Mirror.Hosts))
	switch {
	case unsent != nil:
		return unsent
	case len(conflicts) > 0:
		return errTurnedDown
	case unsendable:
		return errUnsendable
	}
	return nil
}

// usedRemoved keeps the tombstone revisions (syncState.Removed) a later
// write may be based on: those of machines and prompts saved here, of
// pending deletes, and of prompts with sends that may still land. Any
// other comes back, if ever needed, with a stale base's conflict. It
// prunes removed, which the caller owns, in place, and notes only the
// tombstones it holds.
func usedRemoved(removed map[string]int64, machines []Machine, hostDeletes []string, prompts []SavedPrompt, promptDeletes []string, attempts map[string][]promptAttempt) map[string]int64 {
	if len(removed) == 0 {
		return removed
	}
	used := make(map[string]bool, len(removed))
	use := func(key string) {
		if _, held := removed[key]; held {
			used[key] = true
		}
	}
	for _, m := range machines {
		use("hosts/" + m.SyncID)
	}
	for _, id := range hostDeletes {
		use("hosts/" + id)
	}
	for _, p := range prompts {
		use("prompts/" + p.ID)
	}
	for _, id := range promptDeletes {
		use("prompts/" + id)
	}
	for id := range attempts {
		use("prompts/" + id)
	}
	if len(used) < len(removed) {
		maps.DeleteFunc(removed, func(key string, _ int64) bool { return !used[key] })
	}
	return removed
}

// overQuota is the service refusing a push whole for the account's storage
// quota (403 quota).
func overQuota(err error) bool {
	var api *account.APIError
	return errors.As(err, &api) && api.Status == http.StatusForbidden && api.Code == "quota"
}

// tooLarge is the service refusing a push whole for its size (413
// too_large).
func tooLarge(err error) bool {
	var api *account.APIError
	return errors.As(err, &api) && api.Status == http.StatusRequestEntityTooLarge
}

// baseRevs is each item's revision as last pulled, by "collection/id":
// the mirror's, or its tombstone's (removed).
func baseRevs(m account.Mirror, removed map[string]int64) map[string]int64 {
	revs := maps.Clone(removed)
	if revs == nil {
		revs = map[string]int64{}
	}
	for _, h := range m.Hosts {
		revs["hosts/"+h.ID] = h.Rev
	}
	for _, p := range m.Prompts {
		revs["prompts/"+p.ID] = p.Rev
	}
	return revs
}

// noteRemoved is removed (syncState.Removed) after a pull with these
// tombstones (all of them when full) folded into mirror m: an item m holds
// again is no longer removed.
func noteRemoved(removed map[string]int64, full bool, gone account.Tombstones, m account.Mirror) map[string]int64 {
	out := map[string]int64{}
	if !full {
		maps.Copy(out, removed)
	}
	for id, rev := range gone.Hosts {
		out["hosts/"+id] = rev
	}
	for id, rev := range gone.Prompts {
		out["prompts/"+id] = rev
	}
	for _, h := range m.Hosts {
		delete(out, "hosts/"+h.ID)
	}
	for _, p := range m.Prompts {
		delete(out, "prompts/"+p.ID)
	}
	return out
}

// settleAttempts is the merge consuming the journal's entries it has used
// (promptAttempt): it keeps those that may still land, with a send open,
// based on the revision the account holds the prompt at (revs, as
// baseRevs), and not past their deadline at the pull's now_ms (nowMs; 0
// for none, which settles nothing by time).
func settleAttempts(attempts map[string][]promptAttempt, revs map[string]int64, nowMs int64) map[string][]promptAttempt {
	out := map[string][]promptAttempt{}
	for id, entries := range attempts {
		entries = slices.DeleteFunc(slices.Clone(entries), func(a promptAttempt) bool {
			return len(a.Open) == 0 || a.Base != revs["prompts/"+id] || a.deadline() > 0 && nowMs > a.deadline()
		})
		if len(entries) > 0 {
			out[id] = entries
		}
	}
	return out
}

// sentAttempt is one send of a prompt write: its id in the journal entry
// of its base, and the history it was journaled in (syncState.History).
type sentAttempt struct {
	ID      string
	Base    int64
	History int64
}

// recordAttempts adds a send to the journal for each prompt write in part,
// just before it goes, and returns the changes to send and the sends by
// prompt id. The saved prompts are read again first, under the same lock:
// a write of a prompt deleted since the merge planned it, or saved since
// with other fields, is not sent (the save asked for another sync, which
// sends it). A write that would open a third variant of a prompt
// (maxVariants) is not sent either: held names those prompts (an edit
// waits for a slot, promptAttempt). Each send records the deadline it carries
// (notAfter, 0 for none) by its id (promptAttempt.Deadlines). A part
// without prompt writes leaves the state file alone; a state write that
// fails stops the request, and so does ctx ending while the lock was
// awaited.
func (d *Desk) recordAttempts(ctx context.Context, acct string, part []account.Change, notAfter int64) (out []account.Change, sent map[string]sentAttempt, held []string, err error) {
	if !slices.ContainsFunc(part, func(c account.Change) bool { _, ok := c.Body.(account.PromptBody); return ok }) {
		return part, nil, nil, nil
	}
	if !d.storeMu.LockCtx(ctx) {
		return nil, nil, nil, ctx.Err()
	}
	defer d.storeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, nil, nil, err
	}
	ps, err := d.loadPrompts()
	if err != nil {
		return nil, nil, nil, err
	}
	saved := map[string]promptFields{}
	for _, p := range ps.Prompts {
		saved[p.ID] = fieldsOf(p)
	}
	planned := slices.DeleteFunc(slices.Clone(part), func(c account.Change) bool {
		b, ok := c.Body.(account.PromptBody)
		f, kept := saved[c.ID]
		return ok && (!kept || f != bodyFields(b))
	})
	if !slices.ContainsFunc(planned, func(c account.Change) bool { _, ok := c.Body.(account.PromptBody); return ok }) {
		return planned, nil, nil, nil
	}
	state, err := d.loadSyncState()
	if err != nil || state.AccountID != acct {
		return nil, nil, nil, err
	}
	if state.PromptAttempts == nil {
		state.PromptAttempts = map[string][]promptAttempt{}
	}
	if state.PromptLastSent == nil {
		state.PromptLastSent = map[string]lastSend{}
	}
	sent = map[string]sentAttempt{}
	for _, c := range planned {
		b, ok := c.Body.(account.PromptBody)
		if !ok {
			out = append(out, c)
			continue
		}
		base, hash := c.Base, sendHash(b)
		entries := state.PromptAttempts[c.ID]
		j := slices.IndexFunc(entries, func(a promptAttempt) bool { return a.Base == base && a.Hash == hash })
		if j < 0 {
			if len(entries) >= maxVariants {
				held = append(held, c.ID)
				continue
			}
			entries, j = append(entries, promptAttempt{Base: base, Hash: hash}), len(entries)
		}
		var id [8]byte
		if _, err := rand.Read(id[:]); err != nil {
			return nil, nil, nil, err
		}
		s := sentAttempt{ID: hex.EncodeToString(id[:]), Base: base, History: state.History}
		a := &entries[j]
		a.Open = append(a.Open, s.ID)
		if notAfter != 0 {
			if a.Deadlines == nil {
				a.Deadlines = map[string]int64{}
			}
			a.Deadlines[s.ID] = notAfter
		}
		if n := len(a.Open); n > maxOpenSends {
			// The oldest go; they can still land, so their deadlines fold.
			for _, dropped := range a.Open[:n-maxOpenSends] {
				d := a.Deadlines[dropped]
				fold, trimmed := a.Deadlines[""]
				switch {
				case d == 0 || trimmed && fold == 0:
					fold = 0
				default:
					fold = max(fold, d)
				}
				if a.Deadlines == nil {
					a.Deadlines = map[string]int64{}
				}
				delete(a.Deadlines, dropped)
				a.Deadlines[""] = fold
			}
			a.Open = slices.Delete(a.Open, 0, n-maxOpenSends)
		}
		state.PromptAttempts[c.ID] = entries
		state.PromptLastSent[c.ID] = lastSend{Hash: promptHash(bodyFields(b))}
		sent[c.ID] = s
		out = append(out, c)
	}
	if len(sent) == 0 {
		return out, sent, held, nil
	}
	if err := d.reserveSends(sent); err != nil {
		return out, sent, held, err // nothing journaled, nothing sent
	}
	return out, sent, held, d.storeSyncState(state)
}

// settleSend records the service's answer (res) to one request's sends
// (sent, as recordAttempts returned them), as the journal's invariant has
// it (promptAttempt): what it wrote (applied) is what this device and the
// account now agree on. An applied answer at a revision other than the
// send's base settles every open send of the prompt at that base; an
// applied answer at the base itself and a refusal (res nil) settle only
// that send. A conflict's row decides the sends below its revision
// (decideSends: another of them landed as it, or none did) once a later
// step confirms its history (heldRow), before that step's own rows, so a
// later pull of another device's write can't hide a landing nor be taken
// for one. An entry with no open send goes. An answer that changes none of
// that leaves the state file alone. The answer is kept in memory first
// (owedAnswer) and let go only once a write holding it succeeded: a wait
// for the store the round gave up, or a state that couldn't be read or
// written, leaves it for the next merge's commit (payOwed); writing one
// twice changes nothing. The answer for each send is also put in its
// marker first (markAnswered), so a run of the app that ends before any
// write holding it still knows how the send ended.
func (d *Desk) settleSend(ctx context.Context, acct string, sent map[string]sentAttempt, applied []account.Change, res *account.PushResult) error {
	if len(sent) == 0 && !slices.ContainsFunc(applied, func(c account.Change) bool { return c.Body != nil }) {
		return nil
	}
	// Only this round touches owed until it ends (accountSync), so the
	// answer is still the last one when it is written.
	n := len(d.accountSync.owed)
	answer := owedAnswer{acct: acct, sent: sent, applied: applied, res: res}
	d.accountSync.owed = append(d.accountSync.owed, answer)
	if res != nil {
		for id, s := range sent {
			for _, c := range res.Conflicts {
				if c.Collection == "prompts" && c.ID == id && c.Server != nil {
					d.accountSync.rows = append(d.accountSync.rows, heldRow{acct: acct, history: s.History, row: *c.Server, except: s.ID})
				}
			}
		}
	}
	d.markAnswered(sent, applied, res)
	if !d.storeMu.LockCtx(ctx) {
		return ctx.Err()
	}
	defer d.storeMu.Unlock()
	state, err := d.loadSyncState()
	if err != nil {
		return err
	}
	if state.AccountID == acct && answer.apply(&state) {
		if err := d.storeSyncState(state); err != nil {
			return err
		}
	}
	d.accountSync.owed = d.accountSync.owed[:n]
	return nil
}

// heldRow is a conflict's row (settleSend) for the sends of its prompt
// other than except: in the history the request went to, it decides them
// (decideSends), but a restore may have discarded that history since.
// Each step that learns the account's history (a merge's pull, a
// readback) applies the rows of that history first (confirmRows), and
// drops the others.
type heldRow struct {
	acct    string
	history int64
	row     account.Item
	except  string
}

// confirmRows applies the held rows of state's history; the caller lets
// every one go once a write holding state succeeds. d.storeMu must be
// held.
func (d *Desk) confirmRows(state *syncState) {
	for _, h := range d.accountSync.rows {
		if h.acct == state.AccountID && h.history == state.History {
			decideSends(state, h.row, h.except)
		}
	}
}

// owedAnswer is a service's answer to one request (settleSend), kept in
// memory until a write holding it succeeds.
type owedAnswer struct {
	acct    string
	sent    map[string]sentAttempt
	applied []account.Change
	res     *account.PushResult
}

// payOwed applies the answers owed for acct to state, in the order they
// came (another account's can't apply); the round lets every one go once
// a commit holding state is recorded. d.storeMu must be held.
func (d *Desk) payOwed(acct string, state *syncState) {
	for _, ans := range d.accountSync.owed {
		if ans.acct == acct {
			ans.apply(state)
		}
	}
}

// A send's marker is sync-sends/<send id>, which outlives the app: "o"
// while it may land, "r" once it is known refused, and
// "a:<rev>:<hash>:<history>" once the service wrote it (at rev, the
// promptHash of what it wrote, journaled in history). recordAttempts
// writes "o" before the journal holds the send (no marker, no send);
// settleSend writes the answer before it waits for the store, "r" in
// place and "a" by a synced rename; each merge settles the open sends by
// their markers (foldMarkers) and, once its commit is recorded, removes
// the markers of sends no longer open (dropSendMarkers). An answer is lost
// only if both its marker and every write holding it fail, and the app
// ends before a later merge writes the answer still owed.
func (d *Desk) sendMarkersDir() string { return filepath.Join(d.dir, "sync-sends") }

// reserveSends writes the "o" marker of each of sent, synced.
func (d *Desk) reserveSends(sent map[string]sentAttempt) error {
	dir := d.sendMarkersDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for _, s := range sent {
		if err := writeMarker(filepath.Join(dir, s.ID), os.O_CREATE|os.O_TRUNC, 'o'); err != nil {
			return err
		}
	}
	return syncDir(dir)
}

// markAnswered writes the markers of sent as the answer res (nil: none,
// the request refused or never sent) settles them: "r" for a send not
// written (no answer, or its conflict), "a" for one it wrote (applied).
// One that fails leaves the answer to the one owed in memory.
func (d *Desk) markAnswered(sent map[string]sentAttempt, applied []account.Change, res *account.PushResult) {
	for id, s := range sent {
		path := filepath.Join(d.sendMarkersDir(), s.ID)
		if res == nil || slices.ContainsFunc(res.Conflicts, func(c account.Conflict) bool { return c.Collection == "prompts" && c.ID == id }) {
			_ = writeMarker(path, 0, 'r')
			continue
		}
		i := slices.IndexFunc(applied, func(c account.Change) bool { return c.Collection == "prompts" && c.ID == id })
		if i < 0 {
			continue
		}
		b, ok := applied[i].Body.(account.PromptBody)
		for _, a := range res.Applied {
			if ok && a.Collection == "prompts" && a.ID == id {
				_ = writeFileAtomic(path, fmt.Appendf(nil, "a:%d:%s:%d", a.Rev, promptHash(bodyFields(b)), s.History))
			}
		}
	}
}

// writeMarker writes v as the one byte of the marker at path, in place,
// and syncs it.
func writeMarker(path string, flag int, v byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|flag, 0o600)
	if err != nil {
		return err
	}
	_, err = f.WriteAt([]byte{v}, 0)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return err
}

// foldMarkers settles each open send of state by its marker, with an owed
// answer's guards: "r" retires it; "a" is its acknowledgement. In the
// history the send was journaled in, that retires every open send at its
// base (the write landed past it) and, unless the mirror holds the prompt
// past the write, makes what it wrote the copy the saved one is judged
// against (PromptLastSent; the older baseline goes). In another history
// it retires only its own send.
func (d *Desk) foldMarkers(state *syncState) {
	type marked struct {
		prompt, send string
		base         int64
		marker       string
	}
	var found []marked
	for id, entries := range state.PromptAttempts {
		for _, a := range entries {
			for _, open := range a.Open {
				if raw, err := os.ReadFile(filepath.Join(d.sendMarkersDir(), open)); err == nil {
					found = append(found, marked{id, open, a.Base, string(raw)})
				}
			}
		}
	}
	for _, m := range found {
		if !slices.ContainsFunc(state.PromptAttempts[m.prompt], func(a promptAttempt) bool { return slices.Contains(a.Open, m.send) }) {
			continue // settled by an earlier one
		}
		if m.marker == "r" {
			retireSends(state, m.prompt, m.base, m.send, false)
			continue
		}
		f := strings.Split(m.marker, ":")
		if len(f) != 4 || f[0] != "a" {
			continue
		}
		rev, revErr := strconv.ParseInt(f[1], 10, 64)
		history, historyErr := strconv.ParseInt(f[3], 10, 64)
		if revErr != nil || historyErr != nil {
			continue
		}
		same := history == state.History
		retireSends(state, m.prompt, m.base, m.send, same && rev != m.base)
		if same && !slices.ContainsFunc(state.Mirror.Prompts, func(r account.RemotePrompt) bool { return r.ID == m.prompt && r.Rev > rev }) {
			if state.PromptLastSent == nil {
				state.PromptLastSent = map[string]lastSend{}
			}
			state.PromptLastSent[m.prompt] = lastSend{Hash: f[2]}
			delete(state.PromptBaseline, m.prompt)
		}
	}
}

// retireSends takes send (every open one when all) out of prompt id's
// journal entry at base, an entry left with none going too, and says
// whether that changed state.
func retireSends(state *syncState, id string, base int64, send string, all bool) bool {
	changed := false
	entries := state.PromptAttempts[id]
	for j := range entries {
		if entries[j].Base != base {
			continue
		}
		before := len(entries[j].Open)
		entries[j].Open = slices.DeleteFunc(entries[j].Open, func(open string) bool {
			if all || open == send {
				delete(entries[j].Deadlines, open) // its deadline leaves with it
				return true
			}
			return false
		})
		changed = changed || len(entries[j].Open) != before
	}
	entries = slices.DeleteFunc(entries, func(a promptAttempt) bool { return len(a.Open) == 0 })
	if len(entries) == 0 {
		delete(state.PromptAttempts, id)
	} else {
		state.PromptAttempts[id] = entries
	}
	return changed
}

// dropSendMarkers removes the markers of the sends state holds no longer
// open; an open send's marker is never removed. One left goes next time.
func (d *Desk) dropSendMarkers(state syncState) {
	markers, err := os.ReadDir(d.sendMarkersDir())
	if err != nil {
		return
	}
	open := map[string]bool{}
	for _, entries := range state.PromptAttempts {
		for _, a := range entries {
			for _, id := range a.Open {
				open[id] = true
			}
		}
	}
	for _, m := range markers {
		if !open[m.Name()] {
			_ = os.Remove(filepath.Join(d.sendMarkersDir(), m.Name()))
		}
	}
}

// apply records the answer in state, and says whether that changed it. A
// baseline is never put back: a write's is applied only while the answer
// is the newest news of its item (stale).
func (ans owedAnswer) apply(state *syncState) bool {
	sent, applied, res := ans.sent, ans.applied, ans.res
	changed := false
	for _, c := range applied {
		if ans.stale(state, c) {
			continue
		}
		switch b := c.Body.(type) {
		case account.HostBody:
			if state.Baseline == nil {
				state.Baseline = map[string]account.HostBody{}
			}
			state.Baseline[c.ID], changed = sharedOf(b), true
		case account.PromptBody:
			if state.PromptBaseline == nil {
				state.PromptBaseline = map[string]promptFields{}
			}
			state.PromptBaseline[c.ID], changed = bodyFields(b), true
		}
	}
	for id, s := range sent {
		all := false // the answer settles every open send at s.Base
		// Its revisions speak of the history it was sent in: in another
		// one, it settles only its own send. A conflict's row waits for
		// its history to be confirmed (heldRow).
		if res != nil && s.History == state.History {
			for _, a := range res.Applied {
				all = all || a.Collection == "prompts" && a.ID == id && a.Rev != s.Base
			}
		}
		if retireSends(state, id, s.Base, s.ID, all) {
			changed = true
		}
	}
	return changed
}

// stale is whether state already knows newer of c than this answer's write
// of it: the mirror holds the item at a revision past the one the answer
// gave, or (a prompt) the send it answers is no longer open (a pull or
// another answer settled it). Its baseline would then go back. Answers
// owed by an ended round (settleSend) are written later, so this matters
// most for them.
func (ans owedAnswer) stale(state *syncState, c account.Change) bool {
	if ans.res != nil {
		for _, a := range ans.res.Applied {
			if a.Collection != c.Collection || a.ID != c.ID {
				continue
			}
			newer := func(rev int64) bool { return rev > a.Rev }
			switch c.Collection {
			case "prompts":
				if slices.ContainsFunc(state.Mirror.Prompts, func(r account.RemotePrompt) bool { return r.ID == c.ID && newer(r.Rev) }) {
					return true
				}
			case "hosts":
				if slices.ContainsFunc(state.Mirror.Hosts, func(h account.RemoteHost) bool { return h.ID == c.ID && newer(h.Rev) }) {
					return true
				}
			}
		}
	}
	if s, sent := ans.sent[c.ID]; sent && c.Collection == "prompts" {
		return s.History != state.History || !slices.ContainsFunc(state.PromptAttempts[c.ID], func(a promptAttempt) bool { return slices.Contains(a.Open, s.ID) })
	}
	return false
}

// decideSends takes row (a prompts item the service answered, or a pull or
// readback read, in the order they came) as the first word on its prompt's
// sends based below its revision: one of them landed as row if it holds
// that send's body (landedEntry; except, a send the service turned down),
// and then row becomes the baseline; either way every send below row's
// revision is settled (a tombstone's too): the row moved past their base,
// so none lands after it, and no later row can be taken for one. Recorded
// at once, a later pull of another device's write can't hide a landing;
// the mirror's row is only the next write's base. It reports whether it
// changed state.
func decideSends(state *syncState, row account.Item, except string) bool {
	entries := state.PromptAttempts[row.ID]
	if !slices.ContainsFunc(entries, func(a promptAttempt) bool { return a.Base < row.Rev }) {
		return false
	}
	var b account.PromptBody
	if !row.Deleted && json.Unmarshal(row.Body, &b) == nil {
		if j := landedEntry(account.RemotePrompt{ID: row.ID, Rev: row.Rev, UpdatedMs: row.UpdatedMs, Body: b}, entries, except); j >= 0 {
			if state.PromptBaseline == nil {
				state.PromptBaseline = map[string]promptFields{}
			}
			state.PromptBaseline[row.ID] = bodyFields(b)
		}
	}
	if entries = slices.DeleteFunc(slices.Clone(entries), func(a promptAttempt) bool { return a.Base < row.Rev }); len(entries) == 0 {
		delete(state.PromptAttempts, row.ID)
	} else {
		state.PromptAttempts[row.ID] = entries
	}
	return true
}

// AccountSyncStatus is what the account page shows about sync.
type AccountSyncStatus struct {
	// LastSyncedMs is when the newest sync of the signed-in account
	// finished well, 0 for never.
	LastSyncedMs int64 `json:"lastSyncedMs"`
	// Machines and Prompts are the items of each the account holds, as of
	// the newest finished sync.
	Machines int `json:"machines"`
	Prompts  int `json:"prompts"`
}

// AccountSyncStatus is the signed-in account's newest good sync (no
// network): when, and what the account held then. All zero when signed
// out or before this account's first good sync.
func (d *Desk) AccountSyncStatus() (AccountSyncStatus, error) {
	cur, _ := d.account.Current()
	if cur == nil {
		return AccountSyncStatus{}, nil
	}
	d.storeMu.Lock()
	state, err := d.loadSyncState()
	d.storeMu.Unlock()
	if err != nil || state.AccountID != cur.AccountID || state.LastSync == nil {
		return AccountSyncStatus{}, err
	}
	return *state.LastSync, nil
}

// AccountSyncNow runs a sync round now (the account page's "Sync now") and
// then tells the page the account's state, whichever way it ended.
func (d *Desk) AccountSyncNow(ctx context.Context) error {
	err := d.SyncMachines(ctx)
	publishAccount(d.accountState(""))
	return err
}

// promptFields are what one device's edit of a prompt changes for every
// device: its title (the nickname, trimmed) and its text. Its place in the
// list is not part of it.
type promptFields struct {
	Title string `json:"title,omitempty"`
	Text  string `json:"text"`
}

func fieldsOf(p SavedPrompt) promptFields {
	return promptFields{Title: strings.TrimSpace(p.Nickname), Text: p.Text}
}

func bodyFields(b account.PromptBody) promptFields {
	return promptFields{Title: b.Title, Text: b.Text}
}

// promptBody is what a saved prompt syncs as (§5.1): no title when it has
// no nickname.
func promptBody(p SavedPrompt, order *float64) account.PromptBody {
	f := fieldsOf(p)
	return account.PromptBody{Title: f.Title, Text: f.Text, Order: order}
}

// mergePrompts applies the account's prompts (mirror; old is the copy last
// synced, known the ids the account is known to have held) to the saved
// prompts, as AccountLocalSync.swift does, and returns the prompts to keep
// and the changes to push. deletes are prompts deleted here and not yet
// pushed; it returns those left, and the fields agreed with the account.
//   - a prompt edited here since the last sync keeps its fields and is
//     pushed with the account's order (a new place after the last when the
//     account deleted it meanwhile);
//   - one not edited here takes the account's title and text;
//   - one the account held and doesn't now was deleted elsewhere: it goes;
//   - one the account never held is pushed after the account's last;
//   - an account prompt not here is added at the end, in the account's
//     order, unless it was deleted here (its tombstone is pushed).
//
// A prompt the service would refuse (no text, too long) is not sent: it
// stays here, is tried again next time, and the round reports it
// (unsendable). A body only its order makes too large goes without one,
// new or edited, and so does a new one past the largest order the
// service takes (it sorts last). One past the account's caps is sent all
// the same, and the service decides (the push halves around its refusal).
// attempts and lastSent are the journal of writes sent (promptAttempt),
// read here; the caller consumes what this merge used.
func mergePrompts(local []SavedPrompt, old, mirror []account.RemotePrompt, known map[string]bool, deletes []string, baseline map[string]promptFields, attempts map[string][]promptAttempt, lastSent map[string]lastSend) (next []SavedPrompt, changes []account.Change, left []string, nextBaseline map[string]promptFields, unsendable bool) {
	// held is the account's prompts by id, read only: the rows still to
	// add here are the ones no saved prompt kept (inUse); before, the
	// copies last synced.
	held := map[string]account.RemotePrompt{}
	last := -1.0
	for _, r := range mirror {
		held[r.ID] = r
		if r.Body.Order != nil && *r.Body.Order > last {
			last = *r.Body.Order
		}
	}
	before := make(map[string]promptFields, len(old))
	for _, r := range old {
		before[r.ID] = bodyFields(r.Body)
	}
	// landed is the account's copy of a prompt when it is a write of this
	// device's that landed (landedEntry), worked out once per prompt with
	// journal entries (landedCopies).
	type landedCopy struct {
		fields promptFields
		ok     bool
	}
	landedCopies := map[string]landedCopy{}
	landed := func(id string) (promptFields, bool) {
		if c, seen := landedCopies[id]; seen {
			return c.fields, c.ok
		}
		r, pulled := held[id]
		if !pulled || len(attempts[id]) == 0 {
			return promptFields{}, false
		}
		var c landedCopy
		if landedEntry(r, attempts[id], "") >= 0 {
			c = landedCopy{bodyFields(r.Body), true}
		}
		landedCopies[id] = c
		return c.fields, c.ok
	}
	// agreed is what this device and the account last agreed on for a
	// prompt (promptAttempt): a landed write, else the baseline, else the
	// account's copy from before baselines were kept.
	agreed := func(id string) (promptFields, bool) {
		if f, ok := landed(id); ok {
			return f, true
		}
		if f, ok := baseline[id]; ok {
			return f, true
		}
		if f, ok := before[id]; ok {
			return f, true
		}
		return promptFields{}, false
	}
	// edited is whether the saved copy differs from what was agreed; with
	// no landed write or baseline, from what this device last sent
	// (lastSent) ahead of the old copy, which may be the copy a
	// turned-down send was answered with. After a restore (a full pull or
	// readback) this decides who wins on purpose: the restored copy wins
	// over a saved copy equal to the last agreed version, an accepted
	// upload included (whenever it was accepted, this round or long ago),
	// and only edits made since the last agreement survive. Taking an
	// accepted upload for an edit would push again what the restore took
	// away (#359 round-12 review, finding 1; job
	// local-review-review-router-18eade224b01da40-1).
	edited := func(p SavedPrompt) bool {
		_, isLanded := landed(p.ID)
		_, hasBaseline := baseline[p.ID]
		if last, sent := lastSent[p.ID]; !isLanded && !hasBaseline && sent && last.Hash != "" {
			return promptHash(fieldsOf(p)) != last.Hash
		}
		f, ok := agreed(p.ID)
		return ok && fieldsOf(p) != f
	}
	pending := map[string]bool{}
	for _, id := range deletes {
		pending[id] = true
	}
	// writing are the prompts this sync means to write, sent or not: each
	// keeps its old baseline until the service acknowledges it.
	writing := map[string]bool{}
	// write is the one body builder for creates and edits: the order kept
	// when it fits, left out when it alone makes the body too large. It
	// returns the order sent (nil for none, or for nothing sent).
	write := func(p SavedPrompt, order *float64) *float64 {
		writing[p.ID] = true
		body := promptBody(p, order)
		valid := account.ValidPrompt(body)
		if !valid && body.Order != nil {
			body.Order = nil
			valid = account.ValidPrompt(body)
		}
		if !valid {
			unsendable = true
			return nil
		}
		changes = append(changes, account.Change{Collection: "prompts", ID: p.ID, Body: body})
		return body.Order
	}
	var fresh []SavedPrompt
	for _, p := range local {
		edited := edited(p)
		r, here := held[p.ID]
		switch {
		case here && edited:
			next = append(next, p)
			if fieldsOf(p) != bodyFields(r.Body) {
				write(p, r.Body.Order)
			}
		case here:
			next = append(next, SavedPrompt{ID: p.ID, Nickname: r.Body.Title, Text: r.Body.Text})
		case known[p.ID] && !edited:
			// Deleted on another device.
		default:
			next = append(next, p)
			fresh = append(fresh, p)
		}
	}
	inUse := map[string]bool{}
	for _, p := range next {
		inUse[p.ID] = true
	}
	for _, id := range deletes {
		if _, ok := held[id]; ok && !inUse[id] {
			changes = append(changes, account.Change{Collection: "prompts", ID: id, Deleted: true})
			left = append(left, id)
		}
	}
	for _, p := range fresh {
		// An order past the service's largest goes without one; the next
		// keeps last.
		var order *float64
		if last+1 <= account.MaxPromptOrder {
			o := last + 1
			order = &o
		}
		if sent := write(p, order); sent != nil {
			last = *sent
		}
	}
	var added []account.RemotePrompt
	for _, r := range mirror {
		if !inUse[r.ID] && !pending[r.ID] {
			added = append(added, r)
		}
	}
	slices.SortStableFunc(added, func(a, b account.RemotePrompt) int {
		if c := cmpOrder(a.Body.Order, b.Body.Order); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	for _, r := range added {
		next = append(next, SavedPrompt{ID: r.ID, Nickname: r.Body.Title, Text: r.Body.Text})
	}
	// What this device and the account now agree on: each prompt the
	// account holds, as it stands after the merge.
	nextBaseline = map[string]promptFields{}
	for _, p := range next {
		_, isHeld := held[p.ID]
		switch {
		case writing[p.ID]:
			if f, ok := agreed(p.ID); ok {
				nextBaseline[p.ID] = f
			}
		case isHeld:
			nextBaseline[p.ID] = fieldsOf(p)
		}
	}
	return next, changes, left, nextBaseline, unsendable
}

// cmpOrder sorts by order, a prompt without one last.
func cmpOrder(a, b *float64) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return 1
	case b == nil:
		return -1
	}
	return cmp.Compare(*a, *b)
}

// mergeMachines applies the account's hosts (mirror; old is the copy last
// synced, known the ids the account is known to have held) to the saved
// machines and returns the changes to push, one per id. deletes are
// machines removed here and not yet pushed; it returns those left.
func mergeMachines(st *machineStore, old, mirror account.Mirror, known map[string]bool, deletes []string, baseline map[string]account.HostBody) (changes []account.Change, left []string, renamed map[string]string, nextBaseline map[string]account.HostBody) {
	renamed = map[string]string{}
	now := map[string]account.HostBody{}
	for _, h := range mirror.Hosts {
		now[h.ID] = h.Body
	}
	// A machine was edited here when its shared fields differ from what this
	// device last agreed with the account (its baseline; the last mirror for
	// a machine from before baselines). Device-local fields never count.
	agreed := func(id string) (account.HostBody, bool) {
		if b, ok := baseline[id]; ok {
			return b, true
		}
		for _, h := range old.Hosts {
			if h.ID == id {
				return sharedOf(h.Body), true
			}
		}
		return account.HostBody{}, false
	}
	// An edit made here since the last sync wins over the account's copy:
	// the last write to reach the service wins (§5.3), and this one hasn't.
	edited := map[int]bool{}
	for i, m := range st.Machines {
		if base, ok := agreed(m.SyncID); m.SyncID != "" && ok && sharedFields(m) != base {
			edited[i] = true
		}
	}
	local := make([]account.LocalHost, len(st.Machines))
	for i, m := range st.Machines {
		local[i] = account.LocalHost{SyncID: m.SyncID, Body: hostBody(m, account.HostBody{}), Edited: edited[i]}
	}
	plan, err := account.PlanHosts(local, mirror.Hosts, known)
	if err != nil {
		log.Printf("account sync: %v", err)
		return nil, deletes, renamed, baseline
	}
	// One change per id: the service refuses a push naming an id twice.
	seen := map[string]bool{}
	add := func(c account.Change) {
		if !seen[c.ID] {
			seen[c.ID] = true
			changes = append(changes, c)
		}
	}
	for i, id := range plan.Adopt {
		st.Machines[i].SyncID = id
	}
	for i, id := range plan.Push {
		st.Machines[i].SyncID = id
		add(account.Change{Collection: "hosts", ID: id, Body: hostBody(st.Machines[i], account.HostBody{})})
	}
	for i, m := range st.Machines {
		body, ok := now[m.SyncID]
		if !ok || plan.Push[i] != "" {
			continue
		}
		switch {
		case edited[i] && !sameHost(m, body):
			add(account.Change{Collection: "hosts", ID: m.SyncID, Body: hostBody(m, body)})
		case !edited[i] && !sameHost(m, body):
			// Changed on another device: take its fields. The machine's key
			// path and session stay this device's. Its saved id
			// (user@host:port) may change with them; Active follows, and a
			// change onto another saved machine's id is left for the person.
			next := m
			next.Nickname, next.Host, next.Port, next.User = body.Nickname, body.Host, body.Port, body.Username
			if next.Port == 0 {
				next.Port = 22
			}
			from, to := machineID(m), machineID(next)
			if to != from && st.find(to) >= 0 {
				continue
			}
			st.Machines[i] = next
			if to != from {
				if st.Active == from {
					st.Active = to
				}
				renamed[from] = to
			}
		}
	}
	// Deleted on another device: off this device's list (a live connection
	// stays until it ends).
	gone := map[int]bool{}
	for _, i := range plan.Gone {
		gone[i] = true
	}
	if len(gone) > 0 {
		kept := st.Machines[:0]
		for i, m := range st.Machines {
			if gone[i] {
				if st.Active == machineID(m) {
					st.Active = ""
				}
				continue
			}
			kept = append(kept, m)
		}
		st.Machines = kept
	}
	// A machine still saved here (removed, then added again) keeps its item.
	inUse := map[string]bool{}
	for _, m := range st.Machines {
		inUse[m.SyncID] = true
	}
	for _, id := range plan.Delete {
		if !inUse[id] {
			add(account.Change{Collection: "hosts", ID: id, Deleted: true})
		}
	}
	for _, id := range deletes {
		if _, ok := now[id]; ok && !inUse[id] {
			add(account.Change{Collection: "hosts", ID: id, Deleted: true})
			left = append(left, id)
		}
	}
	// What this device and the account now agree on: a machine's shared
	// fields as they stand after the merge. One whose remote change couldn't
	// be applied here keeps its own, so it isn't pushed back as an edit.
	// A machine this sync writes keeps its old baseline until the service
	// acknowledges the write (ackBaseline): a refused push must leave the
	// edit an edit, to be sent again.
	nextBaseline = map[string]account.HostBody{}
	writing := map[string]bool{}
	for _, c := range changes {
		if !c.Deleted {
			writing[c.ID] = true
		}
	}
	for _, m := range st.Machines {
		if m.SyncID == "" {
			continue
		}
		if !writing[m.SyncID] {
			nextBaseline[m.SyncID] = sharedFields(m)
		} else if base, ok := agreed(m.SyncID); ok {
			nextBaseline[m.SyncID] = base
		}
	}
	return changes, left, renamed, nextBaseline
}

// machineSyncEvery is how often a signed-in app syncs machines while open.
const machineSyncEvery = 15 * time.Minute

// startMachineSync syncs at launch and then every machineSyncEvery; a
// signed-out app makes no account calls.
func (d *Desk) startMachineSync() {
	go func() {
		for {
			if s, _ := d.account.Current(); s != nil {
				d.syncMachinesSoon()
			}
			time.Sleep(machineSyncEvery)
		}
	}()
}

// backgroundMachineSync is false in tests that sync by hand.
var backgroundMachineSync = true

// syncMachinesSoon runs a sync in the background after a local change
// (SyncMachines bounds it by syncRoundTimeout).
func (d *Desk) syncMachinesSoon() {
	if !backgroundMachineSync {
		return
	}
	go func() {
		if err := d.SyncMachines(context.Background()); err != nil {
			log.Printf("account sync: %v", err)
		}
	}()
}
