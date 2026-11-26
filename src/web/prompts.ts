// desk_prompts.go and desk_account_sync.go for the browser: the same saved-prompt Desk methods over
// localStorage, and their sync with the HerdrUp account's prompts collection through this page's
// account session (account.ts). The browser saves no machines: the sync reads the account's hosts
// only to count them (the account page's SYNCED), and writes nothing but prompts.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AccountSyncStatus, SavedPrompt } from "../mygo";
import { untilAborted } from "../webguest/abort";
import { AccountServiceError, pullSince, SignedOutError, type Pull, type SyncChange, type SyncItem, type SyncPushBody, type WebAccount } from "./account";
import { emit } from "./events";
import { withStorageLock, type AbortableLocks } from "./locks";

/** The browser's one record of the saved prompts and the account sync's state (Stored). */
export const SAVED_PROMPTS_KEY = "herdrup.guest.savedPrompts";
/** Where the sync state was kept on its own before (account-sync.json's place): read once into
 *  the record, and removed after the record's first write. */
export const ACCOUNT_SYNC_KEY = "herdrup.web.accountSync";

type KeyValue = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
/** The saved prompts and the sync state, one localStorage record written with one setItem (under
 *  the storage lock, PROMPTS_LOCK): what the saved prompts are and what this browser agreed with
 *  the account about them (baseline, sent-write record, mirror) change together or not at all, so
 *  no write that storage refuses can leave a saved prompt read as an edit it isn't. sync is null
 *  with no sync state; absent in a record from before, whose state is still under ACCOUNT_SYNC_KEY. */
interface Stored { prompts: SavedPrompt[]; imported?: boolean; sync?: SyncState | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** As promptID: the id lowercased, or a new one when it isn't a UUID. */
function promptID(id: string): string {
 const lower = id.trim().toLowerCase();
 return UUID.test(lower) ? lower : crypto.randomUUID();
}

/** The record, with a sync state from before taken in (Stored). A damaged one is an error, never
 *  a silent restart, which would drop pending deletes. */
function readPrompts(storage: KeyValue): Stored {
 const raw = storage.getItem(SAVED_PROMPTS_KEY);
 const stored = raw === null ? { prompts: [] } : JSON.parse(raw) as Stored;
 if (!Object.hasOwn(stored, "sync")) {
  const before = storage.getItem(ACCOUNT_SYNC_KEY);
  stored.sync = before === null ? null : JSON.parse(before) as SyncState;
 }
 return stored;
}
/** Writes the whole record in one setItem; a sync state from before goes once it holds it. */
function writePrompts(storage: KeyValue, stored: Stored) {
 storage.setItem(SAVED_PROMPTS_KEY, JSON.stringify({ ...stored, sync: stored.sync ?? null }));
 if (storage.getItem(ACCOUNT_SYNC_KEY) !== null) storage.removeItem(ACCOUNT_SYNC_KEY);
}

// ---- The sync state (desk_account_sync.go syncState, prompts and the account's hosts) ----

/** The prompts collection's allowlist (§5.1): a title (none when empty), the text, its place. */
export interface PromptBody { title?: string; text: string; order?: number }
/** An account prompt as pulled: updated_ms is when the service wrote it, on its clock (absent in
 *  a mirror from before). */
export interface RemotePrompt { id: string; rev: number; body: PromptBody; updated_ms?: number }
/** An account machine: the browser only counts them. */
export interface RemoteHost { id: string; rev: number }
/** The account's hosts and prompts as last pulled, and the revision to pull from next. gone holds
 *  the revisions of the prompt tombstones pulled: a prompt written again names its tombstone's
 *  revision as the one it is based on (base_rev). */
export interface Mirror { rev: number; hosts: RemoteHost[]; prompts: RemotePrompt[]; gone?: Record<string, number> }
/** What one device's edit of a prompt changes for every device: its title (the nickname, trimmed)
 *  and its text. Its place in the list is not part of it. */
export interface PromptFields { title: string; text: string }

/** This browser's unsettled sends of one prompt with one content (hash) on one revision (base,
 *  the base_rev sent). The rules, shared with desk_account_sync.go:
 *  - Every send gets its own id, added to open right before its HTTP POST (each dispatch,
 *    retries included); an identical send joins the entry, which keeps at most MAX_OPEN_SENDS ids
 *    (identical content is identical evidence). No prompt text is kept here, only the hash.
 *  - A send can land only while the prompt's row is still at its base (the service's base_rev
 *    precondition, sync.ts:351). So an id leaves open on a definite answer about its own POST: a
 *    4xx refusal (nothing written), taken on its status line, before its body is read or the push
 *    is retried or split; an abort before the request was sent; an applied answer; a conflict.
 *    Every open send of the prompt at that base is settled at once by an applied answer whose rev
 *    isn't the base. An applied answer at the base itself (an identical write keeps its rev,
 *    sync.ts:16, :355) settles nothing but its own send. A conflict settles only its own send at
 *    once; its row is kept pending (PendingConflict) until the next pull that completes, which
 *    takes it in ahead of its own rows unless a 410 came first (another history): a row that is one
 *    of this prompt's open contents past their base is that send landing (the row's content
 *    becomes the agreed one, and every send at that base settles), recorded before the pull's
 *    rows can fold another device's write over it.
 *  - Pulls never remove an entry: only the merge consumes it, after using it, once nothing of it
 *    is open or the prompt's revision on the account (its row's, its tombstone's, 0 for none) has
 *    moved off its base. A pulled copy whose hash is an open entry's and whose rev is past the
 *    entry's base is that write landing (forward progress: a lower revision is an older history,
 *    not this write).
 *  - Facts hold within one history only: after a 410 reset nothing counts as settled for what was
 *    seen before it; every entry still held is judged against the restored rows (one back at its
 *    base stays open). Entries retired before a reset can't come back: their late commit is a
 *    foreign write to the next pull. Base 0 assumes no request outlives tombstone pruning (90
 *    days, or 2,000 newer deletes: sync.ts:19-22, :357-362), which could empty a row again.
 *  - Expiry (themartianapp/herdrup#826). The service's contract: every sync answer carries its
 *    clock as now_ms, a pull's read before (or atomically with) the snapshot its rows come from;
 *    a push carries not_after, which the service checks inside the write itself, so a push it
 *    applies past not_after writes nothing (409 expired), however late the request reaches it.
 *    Each push carries not_after = the newest now_ms this page has seen + 120 s (none while none
 *    was seen), recorded per send in deadlines (an id absent from it went without one). An
 *    entry's deadline is the latest of its open sends', 0 while any open send has none (it may
 *    land whenever); a send that leaves open takes its deadline with it, so a refused retry
 *    doesn't extend older sends'. An entry from before keeps no deadlines: 0. An open entry whose
 *    row is still at its base when a pull's now_ms (the earliest of its pages) is past a nonzero
 *    deadline didn't land and won't: that pull's rows were read after the deadline passed, and
 *    nothing can be written past it. The merge consumes it then; only the merge, which sees the
 *    row, settles by time. The device's clock is never used. A service without now_ms (an answer
 *    lacking it) settles nothing by time: the cap holds.
 *  - Bound: at most MAX_PROMPT_VARIANTS entries a prompt. At the cap a new content isn't sent
 *    (no stale content is sent again either): the round is incomplete until an entry settles,
 *    by an answer or by expiry, and then the newest edit goes. So the record holds at most
 *    MAX_PROMPT_VARIANTS hashes a prompt. A record write that doesn't fit the browser's storage
 *    fails the round before anything is sent. */
export interface PromptAttempt { base: number; hash: string; open: string[]; deadlines?: Record<string, number> }

/** deadlines' key for the sends trimmed past MAX_OPEN_SENDS: their combined deadline (0 if any
 *  went without one, else the latest), kept while the entry is, as they may still land. */
const TRIMMED = "";
/** The entry with only the open sends keep says, their deadlines, and the trimmed sends' fold. */
const keepOpen = (e: PromptAttempt, keep: (id: string) => boolean): PromptAttempt => {
 const open = e.open.filter(keep);
 const deadlines = Object.fromEntries(Object.entries(e.deadlines ?? {}).filter(([id]) => id === TRIMMED || open.includes(id)));
 return { base: e.base, hash: e.hash, open, ...(Object.keys(deadlines).length > 0 ? { deadlines } : {}) };
};
/** An entry's deadline (PromptAttempt, Expiry): the latest of its open sends' and its trimmed
 *  sends' fold, 0 while any of them has none. */
export function deadlineOf(e: PromptAttempt): number {
 const deadlines = e.deadlines ?? {};
 let latest = 0;
 for (const id of Object.hasOwn(deadlines, TRIMMED) ? [...e.open, TRIMMED] : e.open) {
  const d = Object.hasOwn(deadlines, id) ? deadlines[id]! : 0;
  if (d === 0) return 0;
  latest = Math.max(latest, d);
 }
 return latest;
}

/** A prompt's newest send: the content the merge compares the saved copy with when nothing else
 *  was agreed. (A state from before also holds its base, body, send id and sequence here, and
 *  promptsSendSeq: nothing reads them.) */
export interface LastSend { hash: string }

/** The identity of a prompt's content (its newest send, LastSend): SHA-256 (hex) of [title, text]. */
export const fieldsHash = (f: PromptFields): string => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([f.title, f.text]))));
/** The identity of a sent body in the sent-write record (PromptAttempt): SHA-256 (hex) of [title,
 *  text, order or null], the whole body, so a row only matches a send when it is that body: another
 *  device's copy of the same text at another place isn't this browser's write landing. */
export const sentHash = (b: PromptBody): string => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([b.title ?? "", b.text, b.order ?? null]))));

/** What the service answered about one send: applied (the revision the prompt is at now), a
 *  conflict, or refused (a 4xx, or a 401 before a retry: nothing written). */
export type SendAnswer = { applied: number } | "conflict" | "refused";

/** The settlement an answer about one send at base gives its prompt's open sends (PromptAttempt):
 *  applied at another revision settles every one at that base; applied at the base itself (an
 *  identical write), a conflict (the row it met may be another of these landing: the merge tells)
 *  or a refusal only its own. Returns the entries left. */
export function settleSends(entries: readonly PromptAttempt[], sendId: string, base: number, answer: SendAnswer): PromptAttempt[] {
 const all = answer !== "refused" && answer !== "conflict" && answer.applied !== base;
 return entries
  .map(e => all && e.base === base ? { ...e, open: [] } : keepOpen(e, s => s !== sendId))
  .filter(e => e.open.length > 0);
}

export interface SyncState {
 /** The account this state belongs to: another account starts over (a full pull, then push). */
 accountId: string;
 mirror: Mirror;
 /** Set once mirror holds the account's prompts. */
 promptsPulled?: boolean;
 /** Prompts deleted here and not yet pushed. */
 promptDeletes?: string[];
 /** Each prompt's fields as this browser last agreed them with the account. */
 promptBaseline?: Record<string, PromptFields>;
 /** Each prompt's agreement known only by the hash of what was written (fieldsHash): an
  *  acceptance recovered from its marker (settleAccepted). It stands as the prompt's baseline
  *  until a later agreement replaces it (a fields baseline, which comes first, or the prompt
  *  going). */
 promptBaselineHash?: Record<string, string>;
 /** Each prompt's body accepted in a history since replaced (a restore), by its hash: it was this
  *  browser's last agreed version there, so a saved copy equal to it is no edit (the restored row
  *  wins, #359 round-12 review finding 1), though it agrees no revision in this history. Used by
  *  the next merge, and consumed by it. */
 promptPriorHash?: Record<string, string>;
 /** Each prompt's unsettled sends, oldest first (PromptAttempt). */
 promptAttempts?: Record<string, PromptAttempt[]>;
 /** Each prompt's newest send (LastSend), kept until the merge has used it. */
 promptsLastSent?: Record<string, LastSend>;
 /** Prompts the readback after this browser's push showed deleted elsewhere: the mirror is past
  *  their tombstones, so the next sync takes them as known (consumed by its first state write). */
 promptsGone?: string[];
 /** Each prompt's push conflict a pull has yet to confirm (PendingConflict, takeConflicts). */
 promptConflicts?: Record<string, PendingConflict>;
 /** The write a round starts from when the last one stopped short (out of pushes): every write
  *  gets its turn, however many before it don't fit the account's quota. */
 promptsTurn?: string;
 /** The newest sync of accountId that finished well: when, and what the account held then. */
 lastSync?: AccountSyncStatus;
 /** The account history's generation as this browser saw it: raised by every 410 a pull meets,
  *  by the first step that folds it (foldResets). An answer read in another history settles only
  *  its own sends: what its rows showed belongs to the history replaced. */
 history?: number;
 /** The count of 410s (resetKey) the history has taken in (foldResets). */
 resetsFolded?: number;
}

/** The one landing match (PromptAttempt), for the merge, a page as it arrives, a readback and a
 *  conflict: the entry of entries whose send a pulled row is, if any. Sends that can't be it are
 *  left out before the row is hashed: an entry needs an open send, or its trimmed sends' fold,
 *  written no later than its deadline (a row the service wrote after a send's not_after isn't that
 *  send: themartianapp/herdrup#826; with no deadline or no updated_ms it may be), and a base the
 *  row moved forward from (a lower revision is an older history); then the row's whole body must
 *  be the entry's (sentHash). */
export function matchLanding(row: RemotePrompt, entries: readonly PromptAttempt[]): PromptAttempt | undefined {
 // updated_ms must be D1's clock at the write, as not_after is checked there: themartianapp/herdrup#828.
 const inTime = (deadline: number | undefined) => deadline === undefined || deadline === 0 || row.updated_ms === undefined || row.updated_ms <= deadline;
 const eligible = entries.filter(a => row.rev > a.base && (a.open.some(s => inTime(a.deadlines?.[s]))
  || (a.deadlines !== undefined && Object.hasOwn(a.deadlines, TRIMMED) && inTime(a.deadlines[TRIMMED]))));
 if (eligible.length === 0) return undefined;
 const h = sentHash(row.body);
 return eligible.find(a => a.hash === h);
}

/** Rows a pull or an answer shows, in order, against this browser's open sends (matchLanding): the
 *  first row of a prompt past a send's base decides that send. One that is its write landing is
 *  recorded at once, before a later row or pull can fold another device's write over it: its
 *  content becomes the agreed one (baseline). Every send at a base the row is past settles then,
 *  landed or not: the prompt moved off that base, so no later row (a page after, a retry's pull
 *  after a conflict) can be that send any more. A conflict's own send is retired before its row is
 *  matched (PendingConflict), so it is no evidence. Returns whether state changed. */
export function landRows(state: SyncState, rows: readonly RemotePrompt[]): boolean {
 const attempts = state.promptAttempts ?? {};
 let changed = false;
 for (const row of rows) {
  if (!Object.hasOwn(attempts, row.id)) continue;
  const list = attempts[row.id]!, landed = matchLanding(row, list);
  const left = list.filter(a => a.base >= row.rev);
  if (landed === undefined && left.length === list.length) continue;
  changed = true;
  if (landed !== undefined) (state.promptBaseline ??= {})[row.id] = bodyFields(row.body);
  if (left.length > 0) attempts[row.id] = left; else delete attempts[row.id];
 }
 return changed;
}
/** landRows over items in the order they came (a completed pull's, each page as it arrived and
 *  before any fold; a readback's; a push's conflict rows): only items of a prompt with sends in
 *  the record are decoded and matched, once each. A tombstone past a send's base decides it too
 *  (not landed). Returns whether state changed. */
function landItems(state: SyncState, items: readonly SyncItem[]): boolean {
 let changed = false;
 for (const it of items) {
  const attempts = state.promptAttempts ?? {};
  if (it.collection !== "prompts" || !Object.hasOwn(attempts, it.id)) continue;
  if (it.deleted) {
   const list = attempts[it.id]!, left = list.filter(a => a.base >= it.rev);
   if (left.length === list.length) continue;
   changed = true;
   if (left.length > 0) attempts[it.id] = left; else delete attempts[it.id];
   continue;
  }
  const r = promptRow(it);
  if (r && landRows(state, [r])) changed = true;
 }
 return changed;
}

const readSyncState = (storage: KeyValue): SyncState | null => readPrompts(storage).sync ?? null;

/** Each send's marker (PromptAttempt), a key of its own, `herdrup.sync.send.<prompt>.<send id>`:
 *  "o" while it may be open, "r" once it was definitely not written (a 4xx, a conflict, or never
 *  sent), "a:<rev>:<hash>:<history>" once the service answered it applied at rev (hash: fieldsHash
 *  of what it wrote; history: SyncState.history when it was sent). Every value is MARKER_WIDTH
 *  long: "o" and "r" are padded to it, and an acceptance's numbers are zero-padded to their widest.
 *  The "o" is written before the send is journaled or dispatched (a send whose marker storage
 *  refuses isn't sent), so whatever its answer, it later only overwrites a value with one of the
 *  same length, in place, with no lock: that can't take storage over its quota (browsers count a
 *  key's and its value's length: replacing a value with one as long adds nothing; WHATWG HTML Web
 *  Storage setItem throws QuotaExceededError only "if the new value couldn't be set"), and a throw
 *  is still handled (the record, owed). No other tab writes the key, so none is lost, and every
 *  tab sees the answer before the record has it: a send marked "r" never landed. Whatever holds
 *  the storage lock next folds "r"s and "a"s into the record (foldMarkers), and removes them and
 *  every marker of a send the record no longer holds open (settled, or retired); the "o" of a send
 *  still open stays however old, as its answer's reserved place. */
const SEND_PREFIX = "herdrup.sync.send.";
const sendMarker = (prompt: string, send: string) => `${SEND_PREFIX}${prompt}.${send}`;
/** Digits of a revision or history in an acceptance's marker: Number.MAX_SAFE_INTEGER's. */
const MARK_DIGITS = 16;
const markNumber = (n: number) => String(n).padStart(MARK_DIGITS, "0");
/** An acceptance's marker value (sendMarkers): the revision written, the hash of what it wrote,
 *  and the account history it was written in (SyncState.history). */
const acceptedMarker = (rev: number, hash: string, history: number) => `a:${markNumber(rev)}:${hash}:${markNumber(history)}`;
/** Every marker value's length (sendMarker): an acceptance's, its hash a SHA-256 in hex. */
const MARKER_WIDTH = acceptedMarker(0, "0".repeat(64), 0).length;
const MARK_OPEN = "o".padEnd(MARKER_WIDTH, "-"), MARK_REFUSED = "r".padEnd(MARKER_WIDTH, "-");
type Accepted = { rev: number; hash: string; history: number };
type SendMark = { prompt: string; send: string; refused: boolean; accepted?: Accepted };
/** The markers in storage: prompt, send id, and whether it was refused or accepted (by its first
 *  letter; a marker from before isn't padded). */
function sendMarkers(storage: KeyValue): SendMark[] {
 const out: SendMark[] = [];
 for (let i = 0; i < storage.length; i++) {
  const key = storage.key(i);
  if (key === null || !key.startsWith(SEND_PREFIX)) continue;
  const rest = key.slice(SEND_PREFIX.length), dot = rest.lastIndexOf("."), value = storage.getItem(key) ?? "";
  if (dot <= 0) continue;
  const [kind, rev, hash, history] = value.split(":");
  out.push({ prompt: rest.slice(0, dot), send: rest.slice(dot + 1), refused: value[0] === "r", ...(kind === "a" && hash ? { accepted: { rev: Number(rev), hash, history: Number(history ?? 0) } } : {}) });
 }
 return out;
}
/** Settles state's sends that refused names (send id → prompt; settleSends, refused). Returns
 *  whether state changed. */
function settleRefused(state: SyncState, refused: ReadonlyMap<string, string>): boolean {
 const attempts = state.promptAttempts ?? {};
 let changed = false;
 for (const [send, prompt] of refused) {
  if (!Object.hasOwn(attempts, prompt)) continue;
  const list = attempts[prompt]!, left = settleSends(list, send, 0, "refused");
  if (left.length === list.length && left.every((e, i) => e.open.length === list[i]!.open.length)) continue;
  changed = true;
  if (left.length > 0) attempts[prompt] = left; else delete attempts[prompt];
 }
 return changed;
}
/** One write the service took: its prompt and send, the revision it wrote (rev), the hash of what
 *  it wrote (fieldsHash), the history it was sent in, and what it wrote when known (an answer read
 *  here; a marker keeps only the hash). */
interface Acceptance { prompt: string; send: string; rev: number; hash: string; history: number; fields?: PromptFields }
/** The one settlement of an acceptance, whether its answer is read here (live), found in its
 *  marker (recovered) or written late (an owed settlement replayed), in any order:
 *   - sent in another history (a restore since), it retires only its own send: what it wrote is no
 *     part of the account now, and it agrees nothing there; what it wrote was the last version
 *     agreed, though, which a saved copy can't be an edit of (promptPriorHash). Only the
 *     settlement that retires the send, still open in the record, says so: once retired (by an
 *     earlier one, in this tab or another), a replay does nothing, and the next merge has already
 *     judged the saved copy against it (a later save is an edit);
 *   - while its send is open, the send settles as applied (and every send at its base with it);
 *     unless the mirror holds the prompt past rev (a later agreement), what it wrote is agreed: its
 *     fields (promptBaseline) when known, else its hash alone (promptBaselineHash), which the merge
 *     judges the saved copy against until a later agreement replaces it;
 *   - once settled, it agrees nothing more, but the live answer of an acceptance recovered first
 *     turns its hash into the fields it agreed.
 *  Returns whether state changed. */
function settleAccepted(state: SyncState, a: Acceptance): boolean {
 if (a.history !== (state.history ?? 0)) {
  if (!settleRefused(state, new Map([[a.send, a.prompt]]))) return false;
  (state.promptPriorHash ??= {})[a.prompt] = a.hash;
  return true;
 }
 const attempts = state.promptAttempts ?? {}, list = Object.hasOwn(attempts, a.prompt) ? attempts[a.prompt]! : [];
 const entry = list.find(e => e.open.includes(a.send)), hashes = state.promptBaselineHash;
 if (entry === undefined) {
  if (a.fields === undefined || hashes?.[a.prompt] !== a.hash) return false;
  (state.promptBaseline ??= {})[a.prompt] = a.fields;
  delete hashes[a.prompt];
  return true;
 }
 const left = settleSends(list, a.send, entry.base, { applied: a.rev });
 if (left.length > 0) attempts[a.prompt] = left; else delete attempts[a.prompt];
 if ((state.mirror.prompts.find(r => r.id === a.prompt)?.rev ?? -1) > a.rev) return true;
 if (a.fields !== undefined) {
  (state.promptBaseline ??= {})[a.prompt] = a.fields;
  if (hashes) delete hashes[a.prompt];
 } else {
  (state.promptBaselineHash ??= {})[a.prompt] = a.hash;
  if (state.promptBaseline) delete state.promptBaseline[a.prompt];
 }
 return true;
}
/** The 410s the sync has met for one account, in every tab: `herdrup.sync.reset.<account>`, a
 *  count tabs only raise. It is written with no lock the moment a pull is answered 410
 *  (noteReset), before anything waits: a step that would write it under the storage lock can be
 *  cancelled first (the round's deadline, another tab holding the lock), and the reset would be
 *  lost, with the evidence of the history it ended still pending. One key per account: a 410 met
 *  for another account (its first pull, cancelled before the switch to it was written) is never
 *  taken into this one's history. Its value is MARK_DIGITS digits, zero-padded, reserved at that
 *  width when a sync of the account starts (reserveResets): every later write replaces it in
 *  place, and can't take storage over its quota. A tab writes past the count it reads, the one
 *  it wrote last and the one the record took in (resetsFolded: a write that failed while its count
 *  was still taken in must not make a later 410 reuse it); a read and a write of one key can
 *  interleave with another tab's, so a tab that read before this one wrote may write a lower
 *  count after it: the writer reads again and writes again until the key holds at least its own.
 *  Two tabs meeting resets at once may write the same count: any increase is what counts. Never
 *  cleared. The key before these, `herdrup.sync.reset`, names no account: it is never read, and
 *  goes when a sync starts. */
const RESET_PREFIX = "herdrup.sync.reset.", UNSCOPED_RESET_KEY = "herdrup.sync.reset";
const resetKey = (acct: string) => `${RESET_PREFIX}${acct}`;
const readResets = (storage: KeyValue, acct: string) => Number(storage.getItem(resetKey(acct)) ?? 0) || 0;
/** acct's resetKey at its full width, written once (a write that storage refuses fails the
 *  round); the unscoped key from before goes. */
function reserveResets(storage: KeyValue, acct: string) {
 if (storage.getItem(UNSCOPED_RESET_KEY) !== null) storage.removeItem(UNSCOPED_RESET_KEY);
 if (storage.getItem(resetKey(acct)) === null) storage.setItem(resetKey(acct), markNumber(0));
}
/** The 410s met for state's account since it last took them in (resetKey): a new history. Every
 *  step that reads evidence of the one before (markers: foldMarkers; pending conflicts:
 *  takeConflicts, after it) folds them first: the history is raised, the pending conflicts go,
 *  and the count is recorded. Returns whether state changed. */
function foldResets(storage: KeyValue, state: SyncState): boolean {
 const seen = readResets(storage, state.accountId);
 if (seen <= (state.resetsFolded ?? 0)) return false;
 state.history = (state.history ?? 0) + 1;
 delete state.promptConflicts;
 state.resetsFolded = seen;
 return true;
}
/** The 410s met since the last fold (foldResets), then the markers folded into state (in
 *  memory): refusals, then acceptances (settleAccepted); changed says whether state changed.
 *  Once the record is written with written as its state, clear removes the markers folded and
 *  those of sends written no longer holds open. */
function foldMarkers(storage: KeyValue, state: SyncState): { changed: boolean; clear: (written: SyncState) => void } {
 const markers = sendMarkers(storage);
 let changed = foldResets(storage, state);
 if (settleRefused(state, new Map(markers.filter(m => m.refused).map(m => [m.send, m.prompt])))) changed = true;
 for (const m of markers) if (m.accepted && settleAccepted(state, { prompt: m.prompt, send: m.send, ...m.accepted })) changed = true;
 return {
  changed,
  clear: written => {
   for (const m of markers) if (m.refused || m.accepted || !(written.promptAttempts?.[m.prompt] ?? []).some(a => a.open.includes(m.send))) storage.removeItem(sendMarker(m.prompt, m.send));
  },
 };
}

/** A push's conflict, kept per prompt until a later pull establishes the history it came from
 *  (SyncState.promptConflicts): the history it was answered in, and the account's row for the
 *  prompt then (null: none). Its own send is retired with it, so its row is no evidence of it.
 *  With no row, base is the revision that send was based on: the mirror may drop the id only
 *  while it still holds it there (adoptable). */
export interface PendingConflict { history: number; row: SyncItem | null; base?: number }
/** What the service answered one change a push sent, with its send id (none for a delete): applied
 *  at the revision the item is at now, a conflict with the account's row (null: none), or none of
 *  them (no answer). */
type Outcome = { change: SyncChange; send: string | undefined } & ({ kind: "applied"; rev: number } | { kind: "conflict"; row: SyncItem | null } | { kind: "none" });
/** Takes state's pending conflicts out for a pull that just completed: those of another history
 *  are dropped (a 410 raised it: foldResets, which the step ran first); the others' rows are
 *  matched against the open sends (landItems) ahead of the pull's own rows, and returned (by
 *  prompt), for the mirror ahead of the pull's fold (adoptable, adoptRows). */
function takeConflicts(state: SyncState): Map<string, PendingConflict> {
 const pending = state.promptConflicts ?? {}, out = new Map<string, PendingConflict>();
 delete state.promptConflicts;
 for (const [id, c] of Object.entries(pending)) {
  if (c.history !== (state.history ?? 0)) continue;
  out.set(id, c);
  if (c.row !== null) landItems(state, [c.row]);
 }
 return out;
}
/** The rows of conflicts (by prompt) that may change the mirror m (adoptRows): a row newer than
 *  what m holds for its id (live or tombstone, 0 for none); none (null) only while m still holds
 *  the id at the revision the conflicting send was based on. Any other is landing evidence only:
 *  m, its cursor past it, already holds what came after it (another tab synced since). */
function adoptable(m: Mirror, conflicts: ReadonlyMap<string, PendingConflict>): Map<string, SyncItem | null> {
 const out = new Map<string, SyncItem | null>();
 if (conflicts.size === 0) return out;
 const revs = new Map(m.prompts.map(r => [r.id, r.rev]));
 for (const [id, c] of conflicts) {
  const held = revs.get(id) ?? (m.gone !== undefined && Object.hasOwn(m.gone, id) ? m.gone[id]! : 0);
  if (c.row === null ? held === (c.base ?? 0) : c.row.rev > held) out.set(id, c.row);
 }
 return out;
}

/** A body's field as Go's decoder takes it into a struct: absent or null is undefined; the wrong
 *  type, or a body that isn't an object, is refused (null bodies hold nothing the merge keeps). */
const REFUSED = Symbol("refused");
function field<T extends "string" | "number">(body: unknown, name: string, type: T): (T extends "string" ? string : number) | undefined | typeof REFUSED {
 if (typeof body !== "object" || body === null || Array.isArray(body)) return REFUSED;
 const v = (body as Record<string, unknown>)[name];
 if (v === undefined || v === null) return undefined;
 return typeof v === type ? v as T extends "string" ? string : number : REFUSED;
}

/** A pulled prompts item (account.RemotePrompts): null for a tombstone; undefined for one without
 *  text, which is none the service would hold, and is skipped. */
function promptRow(it: SyncItem): RemotePrompt | null | undefined {
 if (it.deleted) return null;
 const title = field(it.body, "title", "string"), text = field(it.body, "text", "string"), order = field(it.body, "order", "number");
 if (title === REFUSED || text === REFUSED || order === REFUSED || !text) return undefined;
 return { id: it.id, rev: it.rev, body: { ...(title ? { title } : {}), text, ...(order !== undefined ? { order } : {}) }, ...(typeof it.updated_ms === "number" ? { updated_ms: it.updated_ms } : {}) };
}

/** The prompts a pull's items delete (their tombstones); live rows are the mirror fold's. */
const promptTombstones = (items: SyncItem[]): string[] => items.filter(it => it.collection === "prompts" && it.deleted).map(it => it.id);

/** A pulled hosts item (account.RemoteHosts): one without host or user, or with a field of the
 *  wrong type, is skipped, so the count is the desktop's. */
function hostRow(it: SyncItem): RemoteHost | null | undefined {
 if (it.deleted) return null;
 const b = it.body;
 const fields = [field(b, "nickname", "string"), field(b, "port", "number"), field(b, "auth_kind", "string"), field(b, "label", "string")];
 const host = field(b, "host", "string"), username = field(b, "username", "string");
 if (fields.includes(REFUSED) || host === REFUSED || username === REFUSED || !host || !username) return undefined;
 return { id: it.id, rev: it.rev };
}

/** Patches one collection with a pull's items (ordered: oldest revision first), each replacing
 *  what is held (all of them when full): a pull's pages are read one at a time, so an item can
 *  show live on one page and deleted, at a newer revision, on a later one. */
function fold<T extends { id: string; rev: number }>(held: T[], full: boolean, ordered: SyncItem[], collection: string, row: (it: SyncItem) => T | null | undefined): T[] {
 const byID = new Map<string, T>();
 if (!full) for (const it of held) byID.set(it.id, it);
 for (const it of ordered) {
  if (it.collection !== collection || (byID.get(it.id)?.rev ?? -1) > it.rev) continue;
  const r = row(it);
  if (r === null) byID.delete(it.id); else if (r !== undefined) byID.set(it.id, r);
 }
 return [...byID.values()].sort((a, b) => a.rev - b.rev);
}

/** Folds a pull into the mirror (Mirror.Apply): its items ordered once, for both collections. */
export function applyPull(m: Mirror, p: Pull): Mirror {
 const ordered = [...p.items].sort((a, b) => a.rev - b.rev);
 const gone = p.full ? {} : { ...m.gone };
 for (const it of ordered) if (it.collection === "prompts") { if (it.deleted) gone[it.id] = it.rev; else delete gone[it.id]; }
 return { rev: p.rev, hosts: fold(m.hosts, p.full, ordered, "hosts", hostRow), prompts: fold(m.prompts, p.full, ordered, "prompts", promptRow), gone };
}

/** The mirror with the service's rows for some prompts taken in, each as what the account holds
 *  for its id now (a push's conflicts, adoptable): none (null) drops the id and its tombstone, so
 *  the next write of it is based on 0; a tombstone is recorded with its revision; a live row
 *  replaces the copy held. */
function adoptRows(m: Mirror, rows: ReadonlyMap<string, SyncItem | null>): Mirror {
 if (rows.size === 0) return m;
 const gone = { ...m.gone }, prompts = m.prompts.filter(r => !rows.has(r.id));
 for (const [id, row] of rows) {
  delete gone[id];
  if (row === null) continue;
  if (row.deleted) { gone[id] = row.rev; continue; }
  const r = promptRow(row);
  if (r) prompts.push(r);
 }
 return { ...m, prompts: prompts.sort((a, b) => a.rev - b.rev), gone };
}

/** The mirror with the tombstone revisions (gone) of the ids ids() names alone, pruned in place:
 *  those saved here, waiting for their tombstone, or with attempts left are the ones a write can
 *  still be based on. With no tombstone held, ids isn't asked. */
function tombstonesFor(m: Mirror, ids: () => Iterable<string>): Mirror {
 const gone = m.gone;
 if (gone === undefined) return m;
 let keep: Set<string> | null = null;
 for (const id in gone) if (!(keep ??= new Set(ids())).has(id)) delete gone[id];
 return m;
}

// ---- The service's limits (AccountService sync.ts; account/prompts.go, account/sync.go) ----

const MAX_PROMPT_TITLE = 128, MAX_PROMPT_TEXT = 8192, MAX_PROMPT_ORDER = 2 ** 53 - 1, MAX_ITEM_BYTES = 16 * 1024;
const MAX_PUSH_CHANGES = 100, MAX_PUSH_BYTES = 256 * 1024;
/** The request around a push's changes: `{"changes":[`, `]` and its deadline (the largest
 *  not_after a push can carry, PromptAttempt Expiry) and `}`. */
const PUSH_OVERHEAD = `{"changes":[],"not_after":${Number.MAX_SAFE_INTEGER}}`.length;

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;
/** An unpaired surrogate: text that isn't valid UTF-8. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** Whether the service would take b (account.ValidPrompt): a push holding one it refuses is refused
 *  whole, so such a prompt is not sent. Its stored size is JSON.stringify's, as the service's. */
export function validPrompt(b: PromptBody): boolean {
 const title = b.title ?? "";
 if (LONE_SURROGATE.test(title) || LONE_SURROGATE.test(b.text)) return false;
 if ([...title].length > MAX_PROMPT_TITLE || b.text === "" || utf8(b.text) > MAX_PROMPT_TEXT) return false;
 if (/\p{Cc}/u.test(title) || /[^\P{Cc}\t\n\r]/u.test(b.text)) return false;
 if (b.order !== undefined && (Number.isNaN(b.order) || Math.abs(b.order) > MAX_PROMPT_ORDER)) return false;
 return utf8(JSON.stringify(b)) <= MAX_ITEM_BYTES;
}

/** changes split into pushes the service takes (account.Batches): at most 100 each, and each
 *  request body at most 256 KiB. Order is kept. */
export function batches(changes: SyncChange[]): SyncChange[][] {
 const out: SyncChange[][] = [];
 let start = 0, size = PUSH_OVERHEAD;
 changes.forEach((c, i) => {
  const raw = utf8(JSON.stringify(c));
  let n = raw + (i > start ? 1 : 0); // the comma
  if (i > start && (i - start === MAX_PUSH_CHANGES || size + n > MAX_PUSH_BYTES)) {
   out.push(changes.slice(start, i));
   start = i; size = PUSH_OVERHEAD; n = raw;
  }
  size += n;
 });
 if (start < changes.length) out.push(changes.slice(start));
 return out;
}

// ---- The merge (desk_account_sync.go mergePrompts, AccountLocalSync.swift) ----

const fieldsOf = (p: SavedPrompt): PromptFields => ({ title: p.nickname.trim(), text: p.text });
const bodyFields = (b: PromptBody): PromptFields => ({ title: b.title ?? "", text: b.text });
const sameFields = (a: PromptFields, b: PromptFields) => a.title === b.title && a.text === b.text;

/** What a saved prompt syncs as (§5.1): no title when it has no nickname. */
function promptBody(p: SavedPrompt, order: number | undefined): PromptBody {
 const f = fieldsOf(p);
 return { ...(f.title ? { title: f.title } : {}), text: f.text, ...(order !== undefined ? { order } : {}) };
}

/** By order, a prompt without one last. */
function cmpOrder(a: number | undefined, b: number | undefined): number {
 if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
 return a < b ? -1 : a > b ? 1 : 0;
}

export interface PromptMerge {
 next: SavedPrompt[]; changes: SyncChange[]; left: string[]; baseline: Record<string, PromptFields>;
 /** The agreements known by hash alone left (SyncState.promptBaselineHash). */
 baselineHash: Record<string, string>;
 /** The sent-write record left once the merge has used it (PromptAttempt, LastSend). */
 attempts: Record<string, PromptAttempt[]>; lastSent: Record<string, LastSend>;
 /** Saved prompts the service would refuse (no text, too long), kept here unsent. */
 unsendable: string[];
}

/** The sent-write record the merge reads (SyncState): open sends, each prompt's newest send, the
 *  agreements known by hash alone (SyncState.promptBaselineHash), the bodies accepted in a history
 *  since replaced (SyncState.promptPriorHash), the account's tombstone revisions (Mirror.gone), and
 *  the service's clock when the pull began (Pull nowMs, null when unknown). */
export interface MergeRecord {
 attempts?: Readonly<Record<string, PromptAttempt[]>>; lastSent?: Readonly<Record<string, LastSend>>;
 baselineHash?: Readonly<Record<string, string>>; priorHash?: Readonly<Record<string, string>>;
 gone?: Readonly<Record<string, number>>; pulledNow?: number | null;
}

/** Applies the account's prompts (mirror; old is the copy last synced, known the ids the account
 *  is known to have held) to the saved prompts, and returns the prompts to keep and the changes to
 *  push. deletes are prompts deleted here and not yet pushed; it returns those left, and the
 *  fields agreed with the account.
 *   - a prompt edited here since the last sync keeps its fields and is pushed with the account's
 *     order (a new place after the last when the account deleted it meanwhile);
 *   - one not edited here takes the account's title and text;
 *   - one the account held and doesn't now was deleted elsewhere: it goes;
 *   - one the account never held is pushed after the account's last;
 *   - an account prompt not here is added at the end, in the account's order, unless it was
 *     deleted here (its tombstone is pushed).
 *  A prompt the service would refuse (no text, too long) is not sent: it stays here, it is listed
 *  as unsendable, and is tried again next time. Every other one is sent, even past the account's
 *  caps: the service's quota answer decides which fit (the push loop). A body keeps its order
 *  unless the order alone makes it too large. record is this browser's sent-write record
 *  (MergeRecord): a pulled copy whose hash is an open send's that it moved forward is that write
 *  landing, and is what both agree on, ahead of baseline and old; then an agreement known by hash
 *  alone; otherwise the newest send's hash tells whether a prompt with no baseline was edited
 *  here since. A prompt deleted here with a send that may still land stays a pending delete
 *  although the account doesn't hold it. It returns the record left: sends with nothing open, or
 *  whose prompt's revision moved off their base, are consumed, and a newest send once its prompt
 *  has none left; an agreement known by hash alone stays while its prompt is written again (until
 *  an agreement by fields replaces it). */
export function mergePrompts(local: SavedPrompt[], old: RemotePrompt[], mirror: RemotePrompt[], known: ReadonlySet<string>,
 deletes: readonly string[], baseline: Readonly<Record<string, PromptFields>>, record: MergeRecord = {}): PromptMerge {
 const { attempts = {}, lastSent = {}, baselineHash = {}, priorHash = {}, gone = {}, pulledNow = null } = record;
 // The account's prompts by id, read only: the rows still to add here are the ones no saved
 // prompt kept (inUse).
 const held = new Map<string, RemotePrompt>();
 let last = -1;
 for (const r of mirror) {
  held.set(r.id, r);
  if (r.body.order !== undefined && r.body.order > last) last = r.body.order;
 }
 /** The prompt's revision on the account: its row's, its tombstone's, 0 for none. */
 const revOf = (id: string) => held.get(id)?.rev ?? (Object.hasOwn(gone, id) ? gone[id]! : 0);
 const attemptsOf = (id: string): readonly PromptAttempt[] => Object.hasOwn(attempts, id) ? attempts[id]! : [];
 /** A send that can still land: open, at the prompt's current revision. */
 const open = (id: string) => attemptsOf(id).some(a => a.open.length > 0 && a.base === revOf(id));
 /** What this browser and the account agreed for id, resolved once a prompt: a write of this
  *  browser the account holds although its answer never came (matchLanding), else the baseline. */
 const agreements = new Map<string, PromptFields | undefined>();
 const agreedKnown = (id: string): PromptFields | undefined => {
  if (!agreements.has(id)) {
   const pulled = held.get(id), landed = pulled !== undefined && matchLanding(pulled, attemptsOf(id)) !== undefined;
   agreements.set(id, landed ? bodyFields(pulled.body) : Object.hasOwn(baseline, id) ? baseline[id] : undefined);
  }
  return agreements.get(id);
 };
 const oldByID = new Map(old.map(r => [r.id, r]));
 const oldCopy = (id: string): PromptFields | undefined => {
  const p = oldByID.get(id);
  return p && bodyFields(p.body);
 };
 /** What this browser and the account last agreed on for id: agreedKnown, else the old mirror. */
 const agreed = (id: string): PromptFields | undefined => agreedKnown(id) ?? oldCopy(id);
 /** An agreement known by its hash alone (SyncState.promptBaselineHash), when none is known by
  *  its fields (agreedKnown, which is later). */
 const agreedHash = (id: string): string | undefined => agreedKnown(id) === undefined && Object.hasOwn(baselineHash, id) ? baselineHash[id] : undefined;
 /** Whether the account held id at some agreement with this browser: a baseline (by fields or
  *  hash), or a body accepted in a history since replaced (promptPriorHash). One it no longer
  *  holds, and that isn't edited here, went there (deleted, or not in the backup a restore
  *  brought back): it goes here too, and is never sent again as a draft. */
 const agreedOnce = (id: string) => Object.hasOwn(baseline, id) || Object.hasOwn(baselineHash, id) || Object.hasOwn(priorHash, id);
 /** Whether the saved copy p was edited here since: compared with what is agreed (agreedKnown,
  *  then agreedHash), then (none agreed) what this browser sent last (a conflict's server row is
  *  in old on the next pass: the saved copy is compared with what was sent, not with that), then
  *  the old mirror.
  *  After a restore (a pull that restarted after a 410) the same rule holds, on purpose: a saved copy
  *  equal to the last agreed version takes the restored row, and only edits made since that
  *  agreement survive. An accepted upload is the last agreed version, whether accepted long ago or
  *  in this very round (an acknowledgement applied before a readback that restarted keeps its baseline), so
  *  a restore that rolls it back wins; treating it as an edit here would push again what the
  *  restore removed (#359 round-12 review finding 1, job local-review-review-router-18eade224b01da40-1).
  *  So is one accepted in the history a restore replaced whose acceptance comes to light only
  *  after it (its marker: promptPriorHash): a saved copy equal to it is no edit either. */
 const editedHere = (p: SavedPrompt): boolean => {
  const fields = fieldsOf(p), agreedHere = agreedKnown(p.id);
  if (Object.hasOwn(priorHash, p.id) && priorHash[p.id] === fieldsHash(fields)) return false;
  if (agreedHere !== undefined) return !sameFields(fields, agreedHere);
  const hash = agreedHash(p.id);
  if (hash !== undefined) return fieldsHash(fields) !== hash;
  const newest = Object.hasOwn(lastSent, p.id) ? lastSent[p.id] : undefined;
  if (newest !== undefined) return fieldsHash(fields) !== newest.hash;
  const was = oldCopy(p.id);
  return was !== undefined && !sameFields(fields, was);
 };
 const pending = new Set(deletes);
 // The prompts this sync means to write, sent or not: each keeps its old baseline until the
 // service acknowledges it.
 const writing = new Set<string>();
 const changes: SyncChange[] = [];
 // Prompts the service would refuse whatever happens (no text, too long): kept here, unsent.
 const unsendable: string[] = [];
 /** Writes p with order, or without it when the order alone makes the body too large (creates
  *  and replacements alike); returns the order the body kept. */
 const write = (p: SavedPrompt, order: number | undefined): number | undefined => {
  writing.add(p.id);
  let body = promptBody(p, order);
  if (!validPrompt(body)) {
   body = promptBody(p, undefined);
   if (order === undefined || !validPrompt(body)) { unsendable.push(p.id); return undefined; }
  }
  changes.push({ collection: "prompts", id: p.id, body });
  return body.order;
 };
 const next: SavedPrompt[] = [], fresh: SavedPrompt[] = [];
 for (const p of local) {
  const edited = editedHere(p);
  const r = held.get(p.id)?.body;
  if (r !== undefined && edited) {
   next.push(p);
   if (!sameFields(fieldsOf(p), bodyFields(r))) write(p, r.order);
  } else if (r !== undefined) {
   next.push({ id: p.id, nickname: r.title ?? "", text: r.text });
  } else if ((known.has(p.id) || agreedOnce(p.id)) && !edited) {
   // Deleted on another device, or gone with a restore to a backup from before it.
  } else {
   next.push(p); fresh.push(p);
  }
 }
 const inUse = new Set(next.map(p => p.id));
 const left: string[] = [];
 for (const id of deletes) {
  if (inUse.has(id)) continue;
  if (held.has(id)) { changes.push({ collection: "prompts", id, deleted: true }); left.push(id); }
  // Not held, but a write of it may still land: deleted once a pull shows it did. (A delete of
  // an item the service doesn't hold writes nothing, so it can't stop the write landing.)
  else if (open(id)) left.push(id);
 }
 for (const p of fresh) {
  // An order past the service's largest goes without one (sorting last); the next keeps last.
  const kept = write(p, last + 1 <= MAX_PROMPT_ORDER ? last + 1 : undefined);
  if (kept !== undefined) last = kept;
 }
 const added = mirror.filter(r => !inUse.has(r.id) && !pending.has(r.id))
  .sort((a, b) => cmpOrder(a.body.order, b.body.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
 for (const r of added) next.push({ id: r.id, nickname: r.body.title ?? "", text: r.body.text });
 // What this browser and the account now agree on: each prompt the account holds, as it stands
 // after the merge. One written again keeps what was agreed, by its hash when that is all that is
 // known (not the older copy in old: the write may not land this time, as when out of pushes).
 const nextBaseline: Record<string, PromptFields> = {}, nextHash: Record<string, string> = {};
 for (const p of next) {
  const hash = writing.has(p.id) ? agreedHash(p.id) : undefined;
  if (hash !== undefined) nextHash[p.id] = hash;
  else if (writing.has(p.id)) { const f = agreed(p.id); if (f) nextBaseline[p.id] = f; }
  else if (held.has(p.id)) nextBaseline[p.id] = fieldsOf(p);
 }
 // The record left: sends consumed once nothing of them is open, the prompt's revision moved off
 // their base, or (still at their base) the pull's now_ms is past their deadline: the service
 // writes none of them from then on, so they didn't land and won't (PromptAttempt, Expiry). Those
 // of a prompt neither saved here nor waiting for its tombstone go too; a newest send goes with
 // its prompt's last open one.
 const keep = new Set([...next.map(p => p.id), ...left]);
 const leftAttempts: Record<string, PromptAttempt[]> = {};
 for (const [id, list] of Object.entries(attempts)) {
  const still = keep.has(id) ? list
   .filter(a => a.open.length > 0 && a.base === revOf(id) && !(pulledNow !== null && deadlineOf(a) > 0 && pulledNow > deadlineOf(a))) : [];
  if (still.length > 0) leftAttempts[id] = still;
 }
 const leftLastSent: Record<string, LastSend> = {};
 for (const [id, send] of Object.entries(lastSent)) if (Object.hasOwn(leftAttempts, id)) leftLastSent[id] = send;
 return { next, changes, left, baseline: nextBaseline, baselineHash: nextHash, attempts: leftAttempts, lastSent: leftLastSent, unsendable };
}

const samePrompts = (a: SavedPrompt[], b: SavedPrompt[]) =>
 a.length === b.length && a.every((p, i) => p.id === b[i]!.id && p.nickname === b[i]!.nickname && p.text === b[i]!.text);

// ---- The sync round (SyncMachines / syncMachinesOnce) ----

/** A sync dropped because the session became another account's (or ended) while it ran: it
 *  neither failed nor succeeded. */
class SyncAbandoned extends Error {
 constructor() { super("account sync abandoned: the session changed"); this.name = "SyncAbandoned"; }
}
/** A round that ended with a write the account still refused for a newer copy (conflicts), after
 *  PUSH_PASSES: the browser and the account still differ. */
class SyncConflict extends Error {
 constructor() { super("account sync: the account kept changing a prompt this browser changed; try again"); this.name = "SyncConflict"; }
}
/** How many times one round pushes: once, and again after each conflict, merged with the
 *  account's newer copy (desk_account_sync.go keeps the same bound). */
const PUSH_PASSES = 3;
/** The unanswered sends one record entry keeps (PromptAttempt), as desk_account_sync.go. */
const MAX_OPEN_SENDS = 8;
/** The distinct contents of a prompt the record holds sends of at once (PromptAttempt), as
 *  desk_account_sync.go. */
const MAX_PROMPT_VARIANTS = 2;
/** How long after the newest now_ms seen a push may still be written (its not_after: PromptAttempt,
 *  Expiry), as desk_account_sync.go. */
const NOT_AFTER_MS = 120_000;
/** A round that left a saved prompt unsent because the service would refuse it (too long). */
class PromptsUnsendable extends Error {
 constructor(count: number) { super(`account sync: ${count} saved prompt${count === 1 ? " is" : "s are"} too long for the account`); this.name = "PromptsUnsendable"; }
}
/** A round that held a change back: a saved edit whose prompt has MAX_PROMPT_VARIANTS earlier
 *  contents sent and unanswered, or a delete of a prompt the account doesn't hold yet with an upload
 *  of it that may still land (PromptAttempt): either may still land. */
class PromptsWaiting extends Error {
 constructor(what = "an edited prompt waits for earlier uploads of it to settle") { super(`account sync: ${what}`); this.name = "PromptsWaiting"; }
}
const DELETE_WAITS = "a deleted prompt waits for an earlier upload of it to settle";
const abandonedOnChange = async <T>(work: Promise<T>): Promise<T> => {
 try { return await work; }
 catch (error) { throw error instanceof AccountServiceError && error.code === "account_changed" ? new SyncAbandoned() : error; }
};
/** The service refused a push for the account's storage quota (403 quota): the whole push. */
const overQuota = (error: unknown): error is AccountServiceError => error instanceof AccountServiceError && error.status === 403 && error.code === "quota";
/** The service refused a push for its size (413 too_large: sync.ts:42, :367-371): the whole push. */
const tooLarge = (error: unknown): error is AccountServiceError => error instanceof AccountServiceError && error.status === 413;

/** The one storage lock (withStorageLock) of the saved prompts and the sync state, both keys: a
 *  round's merge writes them together, and a save or delete in another tab reads and writes them
 *  too. Each read-and-write takes it, so none lands between another's read and its write. */
const PROMPTS_LOCK = SAVED_PROMPTS_KEY;
/** The browser refused the storage lock (withStorageLock): nothing was read or written. */
class StorageLockRefused extends Error {
 constructor() { super("saved prompts: the browser refused the storage lock"); this.name = "StorageLockRefused"; }
}
/** Runs update under PROMPTS_LOCK and returns what it returned; its error, or the lock refused,
 *  throws. update is synchronous: it reads, changes and writes with nothing in between. With
 *  signal (work a round starts), the wait for the lock leaves when it aborts, and update doesn't
 *  run once it has: the abort's reason throws. */
async function underLock<T>(locks: AbortableLocks | null, update: () => T, signal?: AbortSignal): Promise<T> {
 let out: { value: T } | null = null;
 const ran = await withStorageLock(PROMPTS_LOCK, () => { signal?.throwIfAborted(); out = { value: update() }; }, locks, signal);
 signal?.throwIfAborted();
 if (!ran || out === null) throw new StorageLockRefused();
 return (out as { value: T }).value;
}

/** Where the sync keeps its state and how it takes turns with the page's other tabs. */
export interface SyncPlace {
 storage(): KeyValue;
 locks: AbortableLocks | null;
 /** Syncs run on their own after a local change (syncMachinesSoon); tests sync by hand. */
 background: boolean;
 now?: () => number;
 /** How long one sync call may take, its wait for its turn included (60 s; tests shorten it). */
 roundMs?: number;
}

/** The sync's turn across tabs: a lock of its own, apart from the account's refresh lock. A round
 *  spans requests, which a storage lock (PROMPTS_LOCK, held for one synchronous step) can't. */
const SYNC_LOCK = "herdrup-account-sync";
const NEVER: AccountSyncStatus = { lastSyncedMs: 0, machines: 0, prompts: 0 };

/** The account sync of this page's session (desk_account_sync.go SyncMachines and its status). */
export interface AccountSync {
 /** One sync round with the account: pulls its prompts and machines, merges the prompts into the
  *  saved ones and pushes this browser's changes. One at a time, in this page and across its tabs:
  *  a call waits for the one running, then makes its own. Each call ends by its deadline
  *  (roundMs), or sooner when signal aborts, waiting included: a stalled round can't hold every
  *  tab's turn. Without a session it does nothing. */
 sync(signal?: AbortSignal): Promise<void>;
 /** A sync in the background after a local change, or when a session begins. */
 soon(): void;
 /** Whether acct's newest finished sync failed. */
 failed(acct: string): boolean;
 /** The signed-in account's newest good sync (no network); all zero when signed out or before
  *  this account's first good sync. */
 status(): AccountSyncStatus;
 /** The saved-prompt Desk methods, over the sync's own storage (each change syncs soon after). */
 prompts: PromptsDesk;
}

/** finished is told after each round that finished, well or not (desk_account_sync.go
 *  AccountSyncNow's publishAccount): the account page reads SYNCED and whether the account needs
 *  attention (its newest sync failed) from it. */
export function createAccountSync(account: WebAccount, place: SyncPlace, finished: () => void): AccountSync {
 const now = place.now ?? Date.now;
 const failed = new Set<string>();
 let turns: Promise<unknown> = Promise.resolve();
 /** The newest now_ms the sync answers told this page, which a push's not_after counts from
  *  (PromptAttempt, Expiry); null when none did, or the newest answer had none (a service rolled
  *  back to one without themartianapp/herdrup#826: pushes go without not_after again). */
 let newestNow: number | null = null;
 const sawNow = (ms: number | null | undefined) => { newestNow = typeof ms === "number" ? Math.max(newestNow ?? ms, ms) : null; };

 /** Records how acct's sync ended, leaving every other account's result as it was. */
 const noteSync = (acct: string, didFail: boolean) => {
  if (didFail) failed.add(acct); else failed.delete(acct);
  finished();
 };

 /** Reads acct's sync state, folds the markers written since (foldMarkers), lets change edit it,
  *  and stores the record when either changed it (one write); the caller holds PROMPTS_LOCK. */
 const editStateNow = (acct: string, change: (state: SyncState) => boolean) => {
  const storage = place.storage(), stored = readPrompts(storage), state = stored.sync ?? null;
  if (state === null || state.accountId !== acct) return;
  const folded = foldMarkers(storage, state), changed = change(state);
  if (!folded.changed && !changed) return;
  writePrompts(storage, { ...stored, sync: state });
  folded.clear(state);
 };
 /** editStateNow under PROMPTS_LOCK; with signal, not once it aborted. */
 const editState = (acct: string, change: (state: SyncState) => boolean, signal?: AbortSignal) => underLock(place.locks, () => editStateNow(acct, change), signal);

 /** What answers about requests already sent, and landings a pull showed, owe acct's state: kept
  *  here first, then written with the round's signal. A round cancelled before they are written
  *  lets its turn go at once (no wait for another tab's storage lock); the next round writes what
  *  is owed when it starts. Each edit is idempotent. */
 const owed: { acct: string; edit: (state: SyncState) => boolean }[] = [];
 const payOwed = async (acct: string, signal: AbortSignal) => {
  const mine = owed.filter(o => o.acct === acct);
  if (mine.length === 0) return;
  await editState(acct, state => mine.reduce((changed, o) => o.edit(state) || changed, false), signal);
  for (const o of mine) { const i = owed.indexOf(o); if (i >= 0) owed.splice(i, 1); }
 };
 const owe = (acct: string, edit: (state: SyncState) => boolean, signal: AbortSignal) => { owed.push({ acct, edit }); return payOwed(acct, signal); };

 /** The count of 410s this tab wrote last, by account (resetKey). */
 const resetsWritten = new Map<string, number>();
 /** A 410 one of acct's pulls met: the account's history started over. Counted in its resetKey
  *  at once, with no lock and nothing awaited, past every count already used (the key's, this
  *  tab's last, the record's resetsFolded); the next step that folds evidence takes it in
  *  (foldResets). */
 const noteReset = (acct: string) => {
  const storage = place.storage(), state = readPrompts(storage).sync ?? null;
  const folded = state !== null && state.accountId === acct ? state.resetsFolded ?? 0 : 0;
  const mine = Math.max(resetsWritten.get(acct) ?? 0, readResets(storage, acct), folded) + 1;
  resetsWritten.set(acct, mine);
  while (readResets(storage, acct) < mine) storage.setItem(resetKey(acct), markNumber(mine));
 };

 /** Journals a send of each of part's writes, under ids (by prompt), in state (PromptAttempt): an
  *  identical one (same prompt, base and content) joins its entry, and becomes the prompt's newest
  *  send (LastSend). notAfter is the POST's not_after, 0 when it goes without one (Expiry). */
 const journal = (state: SyncState, part: readonly SyncChange[], notAfter: number, ids: ReadonlyMap<string, string>, hashes: ReadonlyMap<string, string>) => {
  const attempts = state.promptAttempts ??= {}, lastSent = state.promptsLastSent ??= {};
  for (const c of part) {
   const id = ids.get(c.id), hash = hashes.get(c.id);
   if (c.deleted || id === undefined || hash === undefined) continue;
   const base = c.base_rev ?? 0, list = attempts[c.id] ??= [];
   let entry = list.find(a => a.base === base && a.hash === hash);
   if (entry === undefined) list.push(entry = { base, hash, open: [] });
   entry.open.push(id);
   // Its not_after, by its id (none: it may land whenever, and its entry doesn't expire).
   if (notAfter > 0) (entry.deadlines ??= {})[id] = notAfter;
   // The oldest ids go past the cap (identical content is identical evidence); their deadlines
   // fold into TRIMMED, as they may still land.
   if (entry.open.length > MAX_OPEN_SENDS) {
    const deadlines = entry.deadlines ??= {};
    let fold = Object.hasOwn(deadlines, TRIMMED) ? deadlines[TRIMMED]! : -1;
    for (const s of entry.open.splice(0, entry.open.length - MAX_OPEN_SENDS)) {
     const d = Object.hasOwn(deadlines, s) ? deadlines[s]! : 0;
     fold = fold === 0 || d === 0 ? 0 : Math.max(fold, d);
     delete deadlines[s];
    }
    deadlines[TRIMMED] = fold;
   }
   lastSent[c.id] = { hash: fieldsHash(bodyFields(c.body as PromptBody)) };
  }
 };
 /** The write to send for c now (a POST's prepare): none when its prompt is no longer saved as
  *  planned, or at the variant cap (MAX_PROMPT_VARIANTS: deferred, the round is incomplete until
  *  an entry settles). */
 const sendable = (c: SyncChange, saved: ReadonlyMap<string, PromptFields>, state: SyncState | null): { change: SyncChange | null; deferred: boolean; hash?: string } => {
  if (c.deleted) return { change: c, deferred: false };
  const fields = bodyFields(c.body as PromptBody), now = saved.get(c.id);
  if (now === undefined || !sameFields(now, fields)) return { change: null, deferred: false };
  const base = c.base_rev ?? 0, hash = sentHash(c.body as PromptBody);
  const entries = (state?.promptAttempts?.[c.id] ?? []).filter(e => e.open.length > 0 && e.base === base);
  if (entries.some(e => e.hash === hash) || entries.length < MAX_PROMPT_VARIANTS) return { change: c, deferred: false, hash };
  return { change: null, deferred: true };
 };

 /** One pass of acct's round: pull, merge and, with push, send this browser's changes and read
  *  them back. Returns whether something is left to settle: with push, a conflict (the account
  *  holds a newer copy, adopted into the mirror, to merge with); without, changes the merge would
  *  still send. generation is the session's when the round began: a session that is no longer it
  *  (signed out, another account, or a new session of the same account) abandons the round at
  *  its next step, before anything more is read, written or sent. */
 async function once(signal: AbortSignal, push: boolean, acct: string, generation: number): Promise<boolean> {
  const still = () => account.current?.accountID === acct && account.generation === generation;
  if (!still()) throw new SyncAbandoned();
  const storage = place.storage();
  const before = readSyncState(storage);
  const switched = before?.accountId !== acct;
  // Another account (or the first sync): pull everything first and adopt its prompts before this
  // browser pushes anything.
  const state: SyncState = switched || before === null ? { accountId: acct, mirror: { rev: 0, hosts: [], prompts: [] } } : before;
  // A 410 is counted as it is met (noteReset), and the merge's fold takes it in first, so the
  // history is the new one before anything answered in the one replaced is folded (settleAccepted).
  const pulled = await abandonedOnChange(pullSince(account, acct, state.promptsPulled ? state.mirror.rev : 0, signal, generation, () => noteReset(acct)));
  // A pull with a page lacking now_ms forgets the newest one (sawNow).
  sawNow(pulled.nowMs === null ? null : pulled.newestMs);
  const synced = state.mirror;
  // The ids the account is known to have held: a prompt with one of these that the account no
  // longer lists was deleted elsewhere. On this browser's first prompt sync none is known: the
  // account's old deletes don't take prompts it never synced.
  const known = new Set(synced.prompts.map(p => p.id));
  // The readback after the last push may have passed other devices' deletes (promptsGone).
  if (state.promptsPulled) for (const id of [...promptTombstones(pulled.items), ...state.promptsGone ?? []]) known.add(id);

  // Read, merged and written in one step under the storage lock (a save or delete in another tab
  // comes wholly before it or after it), with one write of the record (Stored).
  const { merged, changes, promptsChanged, mirror } = await underLock(place.locks, () => {
   if (!still()) throw new SyncAbandoned();
   const stored = readPrompts(storage);
   const latest = switched ? null : stored.sync ?? null;
   // The markers written since go in first (a refused send never landed; an accepted one did);
   // then the conflicts a push met that no readback confirmed (takeConflicts); then the completed
   // pull's rows, in the order they came, before the fold: one of this browser's sends landing,
   // though a later row folds another device's write over it, is recorded (landItems). Another
   // account's state starts over: its markers are only cleaned up.
   const base = latest ?? { accountId: acct, mirror: { rev: 0, hosts: [], prompts: [] } };
   const folded = foldMarkers(storage, base);
   const conflicts = latest === null ? new Map<string, PendingConflict>() : takeConflicts(latest);
   if (latest !== null) landItems(latest, pulled.items);
   // The conflicts' rows are what the account held after the copy last synced: in it, as a
   // readback would have put them, before the pull's fold.
   const old = adoptRows(synced, adoptable(synced, conflicts)), mirror = applyPull(old, pulled);
   // A service without now_ms: no send expires (PromptAttempt, Expiry).
   if (pulled.nowMs === null && Object.keys(latest?.promptAttempts ?? {}).length > 0) console.warn("account sync: the service gives no now_ms; unanswered sends can't expire (themartianapp/herdrup#826)");
   const merged = mergePrompts(stored.prompts, old.prompts, mirror.prompts, known, latest?.promptDeletes ?? [], latest?.promptBaseline ?? {},
    { attempts: latest?.promptAttempts ?? {}, lastSent: latest?.promptsLastSent ?? {}, baselineHash: latest?.promptBaselineHash ?? {}, priorHash: latest?.promptPriorHash ?? {}, gone: mirror.gone ?? {}, pulledNow: pulled.nowMs });
   const lastSync = latest?.lastSync;
   // Each change names the revision it is based on (base_rev): the prompt's in the mirror, its
   // tombstone's, or 0 for none. The service writes it only while the prompt is still at that
   // revision, so a push given up that lands late can't overwrite what was written since.
   const revs = new Map(mirror.prompts.map(r => [r.id, r.rev]));
   const based = merged.changes.map(c => ({ ...c, base_rev: revs.get(c.id) ?? mirror.gone?.[c.id] ?? 0 }));
   // Deletes go first (they free room). The writes start where the last round stopped short
   // (promptsTurn), so a write that fits gets its turn however many before it don't.
   const writes = based.filter(c => !c.deleted), from = Math.max(0, writes.findIndex(c => c.id === latest?.promptsTurn));
   const changes = [...based.filter(c => c.deleted), ...writes.slice(from), ...writes.slice(0, from)];
   const promptsChanged = !samePrompts(merged.next, stored.prompts);
   const written: SyncState = {
    accountId: acct, mirror: tombstonesFor(mirror, () => [...merged.next.map(p => p.id), ...merged.left, ...Object.keys(merged.attempts)]),
    promptsPulled: true, promptDeletes: merged.left, promptBaseline: merged.baseline, promptAttempts: merged.attempts,
    promptsLastSent: merged.lastSent,
    ...(Object.keys(merged.baselineHash).length > 0 ? { promptBaselineHash: merged.baselineHash } : {}),
    ...(lastSync ? { lastSync } : {}),
    history: latest?.history ?? 0,
    ...(base.resetsFolded !== undefined ? { resetsFolded: base.resetsFolded } : {}),
   };
   writePrompts(storage, { ...stored, prompts: merged.next, sync: written });
   folded.clear(written);
   return { merged, changes, promptsChanged, mirror };
  }, signal);
  if (promptsChanged) emit("savedPromptsChanged", merged.next);
  // A prompt the service would refuse stays here, and the round doesn't finish well.
  const refused = merged.unsendable.length > 0 ? new PromptsUnsendable(merged.unsendable.length) : null;
  // A delete kept for an upload that may still land (the account doesn't hold the prompt yet) sends
  // nothing now: the round isn't complete until the delete went or is no longer needed.
  const dormant = merged.left.some(id => !changes.some(c => c.deleted && c.id === id));
  if (!push) {
   // A merge alone: the browser and the account agree when it has nothing to send.
   if (changes.length === 0 && refused === null && !dormant) await editState(acct, s => { s.lastSync = { lastSyncedMs: now(), machines: s.mirror.hosts.length, prompts: s.mirror.prompts.length }; return true; }, signal);
   if (refused !== null && changes.length === 0) throw refused;
   if (dormant && changes.length === 0) throw new PromptsWaiting(DELETE_WAITS);
   return changes.length > 0;
  }

  // acked: what the service took; answered: every change it answered for, taken or not;
  // conflictIds: the prompts whose write met a conflict (the account holds a newer copy: kept as
  // pending conflicts, SyncState.promptConflicts, until a pull confirms their history).
  const acked: SyncChange[] = [], answered = new Set<string>(), conflictIds = new Set<string>();
  let stopped = false;
  // A newer content held back at the variant cap: the newest send went again instead.
  let deferred = false;
  // Why a write is still here unsent at the end of the round, which then fails.
  let unsent: Error | null = refused;
  // The changes the latest request carried (prepare's subset of its planned part): a refusal of
  // it splits these, not the part planned.
  let dispatched: SyncChange[] = [];
  const send = async (planned: SyncChange[]) => {
   // The writes of the request about to go, their send ids by prompt (made), and whether that
   // request went to fetch (handed: PushDispatch.sending).
   let sent: SyncChange[] = [], made = new Map<string, string>(), handed = false;
   // The account history the request was journaled in (SyncState.history).
   let history = 0;
   // Made right before each request, the retry after a 401 included, against one snapshot under
   // the storage lock, written once: the refusals marked since go in; each write goes only as its
   // prompt is saved here now (one deleted or changed since the merge planned it is left for the
   // next pass, its save having queued a sync; one at the variant cap waits); each send's marker
   // is written first (one storage refuses isn't sent: nothing journaled), then it is journaled,
   // with the push's not_after (Expiry). What goes is a subset of what was planned, so the push's
   // size holds.
   const prepare = () => underLock(place.locks, (): SyncPushBody | null => {
    made = new Map(); handed = false;
    const stored = readPrompts(storage), state = stored.sync ?? null;
    if (state === null || state.accountId !== acct) throw new SyncAbandoned();
    const folded = foldMarkers(storage, state), saved = new Map(stored.prompts.map(p => [p.id, fieldsOf(p)]));
    history = state.history ?? 0;
    // Each outgoing write's variant, resolved once: its body's hash goes to the journal as it is.
    const hashes = new Map<string, string>();
    sent = [];
    for (const c of planned) {
     const s = sendable(c, saved, state);
     if (s.deferred) deferred = true;
     if (s.change) sent.push(s.change);
     if (s.hash !== undefined) hashes.set(c.id, s.hash);
    }
    dispatched = sent;
    const notAfter = newestNow === null ? 0 : newestNow + NOT_AFTER_MS;
    const ids = new Map(sent.filter(c => !c.deleted).map(c => [c.id, crypto.randomUUID()]));
    for (const [prompt, id] of ids) storage.setItem(sendMarker(prompt, id), MARK_OPEN);
    journal(state, sent, notAfter, ids, hashes);
    // One write, of the snapshot, when it changed (a delete-only push journals nothing).
    if (ids.size > 0 || folded.changed) { writePrompts(storage, { ...stored, sync: state }); folded.clear(state); }
    made = ids;
    if (sent.length === 0) return null;
    return notAfter === 0 ? { changes: sent } : { changes: sent, not_after: notAfter };
   }, signal);
   // The one place a request's sends retire as refused (PushDispatch.refused): a 4xx on its status
   // line, before the refresh and retry after a 401, or one never sent (an abort, the session
   // ending, or any other way out before its fetch). Each refusal overwrites its send's marker in
   // place, with no lock: every tab sees it before anything else can take the send for landed. A
   // storage that refuses even that leaves it to the record, owed.
   const refuse = async () => {
    // Each send id, with its prompt (settleRefused).
    const refusals = new Map([...made].map(([prompt, id]) => [id, prompt]));
    made = new Map();
    try { for (const [id, prompt] of refusals) storage.setItem(sendMarker(prompt, id), MARK_REFUSED); }
    catch { await owe(acct, state => settleRefused(state, refusals), signal); }
   };
   let answer;
   try { answer = await abandonedOnChange(account.syncPush({ prepare, refused: refuse, sending: () => { handed = true; } }, acct, signal, generation)); }
   finally {
    // Sends journaled whose request never went to fetch wrote nothing, whichever way it ended.
    if (!handed && made.size > 0) await refuse();
   }
   for (const c of planned) answered.add(c.id);
   if (answer === null) return;
   sawNow(answer.now_ms);
   // What the service answered each change sent, joined once by its id, and used for the markers,
   // the settlement and the readback alike: applied (at the revision it is at now), a conflict
   // (with the account's row, null: none), or neither, no answer at all: the round fails, and the
   // send stays open (it may have landed).
   const from = history;
   const applied = new Map(answer.applied.filter(a => a.collection === "prompts").map(a => [a.id, a.rev]));
   const conflicts = new Map(answer.conflicts.filter(c => c.collection === "prompts").map(c => [c.id, c.server]));
   const outcomes = sent.map((change): Outcome => {
    const send = made.get(change.id);
    if (applied.has(change.id)) return { change, send, kind: "applied", rev: applied.get(change.id)! };
    if (conflicts.has(change.id)) return { change, send, kind: "conflict", row: conflicts.get(change.id)! };
    return { change, send, kind: "none" };
   });
   // A conflict was not written: the prompt isn't at the revision the change named any more. It
   // is a definite refusal of that prompt's send, marked at once (as a 4xx's), before any wait:
   // no tab can take the send for landed meanwhile. Its row, what the account holds for the
   // prompt, is kept pending with the history it was answered in: a later pull confirms or drops
   // it (takeConflicts).
   const pending = new Map<string, PendingConflict>(), refused = new Map<string, string>();
   for (const o of outcomes) {
    if (o.kind !== "conflict") continue;
    pending.set(o.change.id, { history: from, row: o.row, ...(o.row === null ? { base: o.change.base_rev ?? 0 } : {}) });
    conflictIds.add(o.change.id);
    if (o.send === undefined) continue;
    refused.set(o.send, o.change.id);
    try { storage.setItem(sendMarker(o.change.id, o.send), MARK_REFUSED); } catch { /* the settlement records it */ }
   }
   // Each write taken is marked accepted at once, before any wait (sendMarker): a reload before
   // its settlement is written still knows it landed. Its marker's place was reserved at its
   // widest, so a full store takes it too.
   const accepted = outcomes.flatMap((o): Acceptance[] => {
    if (o.kind !== "applied" || o.send === undefined || o.change.deleted) return [];
    const fields = bodyFields(o.change.body as PromptBody);
    return [{ prompt: o.change.id, send: o.send, rev: o.rev, hash: fieldsHash(fields), history: from, fields }];
   });
   for (const a of accepted) try { storage.setItem(sendMarker(a.prompt, a.send), acceptedMarker(a.rev, a.hash, a.history)); } catch { /* owed */ }
   // The answer is one settlement, queued before any wait and written whole (owe): each conflict
   // retires its own send (settleRefused) and is kept pending, unless the account's history moved
   // on meanwhile (SyncState.history: what it showed is no part of this one); each write taken
   // settles as its marker would have (settleAccepted, which knows what it wrote).
   await owe(acct, state => {
    let changed = settleRefused(state, refused);
    for (const a of accepted) if (settleAccepted(state, a)) changed = true;
    if (pending.size > 0 && (state.history ?? 0) === from) { state.promptConflicts = { ...state.promptConflicts, ...Object.fromEntries(pending) }; changed = true; }
    return changed;
   }, signal);
   acked.push(...outcomes.flatMap(o => o.kind === "applied" ? [o.change] : []));
   const unanswered = outcomes.filter(o => o.kind === "none").length;
   if (unanswered > 0) throw new Error(`account service: no answer for ${unanswered} of the changes pushed`);
  };
  // Nothing is lost on a failure: an unacknowledged prompt is pushed again next time, and pending
  // deletes stay pending.
  const queue = batches(changes);
  while (queue.length > 0) {
   const planned = queue.shift()!;
   dispatched = [];
   try { await send(planned); }
   catch (error) {
    // Out of pushes for now (the service's rate limit): the rest go next round, from here.
    if (error instanceof AccountServiceError && error.status === 429) { unsent = error; stopped = true; break; }
    if (!overQuota(error) && !tooLarge(error)) throw error;
    // The service refuses a push past its size, or past the account's quota, whole: what it
    // refused is what that request carried. One past its size is halved, deletes and writes alike
    // (order kept, so deletes stay ahead). One past the quota sends its deletes (which free room)
    // on their own first, then halves its writes. Down to one alone, which stays here unsent (not
    // sent again this round) while the rest reach the account. Only such a final part refused
    // leaves the round incomplete: a split whose parts all land is not.
    const part = dispatched;
    const deletes = part.filter(c => c.deleted), writes = part.filter(c => !c.deleted);
    const halve = (list: SyncChange[]) => queue.unshift(list.slice(0, Math.ceil(list.length / 2)), list.slice(Math.ceil(list.length / 2)));
    if (tooLarge(error) && part.length > 1) halve(part);
    else if (overQuota(error) && deletes.length > 0 && writes.length > 0) queue.unshift(deletes, writes);
    else if (overQuota(error) && writes.length > 1) halve(writes);
    else { unsent = error; for (const c of part) answered.add(c.id); }
   }
  }
  // Read our own writes back, and what came after the conflicts' rows, so the mirror holds what
  // the account holds.
  const conflicted = conflictIds.size > 0;
  const readBack = acked.length > 0 || conflicted ? await abandonedOnChange(pullSince(account, acct, mirror.rev, signal, generation, () => noteReset(acct))) : null;
  if (readBack !== null) sawNow(readBack.nowMs === null ? null : readBack.newestMs);
  // A delete the service took whose prompt a restore brought back (set by the step below).
  let restored = false;
  // Read, changed and written in one step under the storage lock, as the merge.
  await underLock(place.locks, () => {
   if (!still()) throw new SyncAbandoned();
   const stored = readPrompts(storage), after = stored.sync!;
   // A readback that restarted after a 410 counted it as it was met; foldMarkers takes it in.
   const restarted = readBack?.restarted === true;
   const folded = foldMarkers(storage, after);
   if (readBack !== null) {
    const pushed = new Set(acked.filter(c => c.deleted).map(c => c.id));
    const pending = (after.promptDeletes ?? []).length;
    const held = after.mirror.prompts;
    // The pending conflicts' rows first (this pass's, and any a readback before missed), then
    // the readback's, in the order they came, before its fold (landItems). The conflicts' only
    // while the account is still their history: after a 410, what they showed goes with the
    // history it replaced (takeConflicts).
    const adopted = adoptable(after.mirror, takeConflicts(after));
    landItems(after, readBack.items);
    // A conflict's server row is what the account holds for that id: taken in before what came
    // after it (a pruned tombstone is no row at all, and no pull would show it went).
    after.mirror = applyPull(adoptRows(after.mirror, adopted), readBack);
    // The account's history started over (a restore) during the readback: present is what the
    // restored account holds. The baselines this round's acknowledgements wrote stay: the next
    // merge gives the restored rows the prompts still equal to them (editedHere: intended, #359
    // round-12 review finding 1).
    const present = restarted ? new Set(after.mirror.prompts.map(r => r.id)) : null;
    // A delete the service took stays pending when the restored history still holds the prompt:
    // the next round deletes it there again, and this one isn't complete.
    after.promptDeletes = (after.promptDeletes ?? []).filter(id => !pushed.has(id) || present?.has(id) === true);
    restored = present !== null && [...pushed].some(id => present.has(id));
    // Deletes from other devices the readback passed: the local copies go next time, unless edited.
    const gone = promptTombstones(readBack.items);
    if (present !== null) {
     // What the mirror held and the restored account doesn't is gone as well, except what this
     // round just wrote.
     const wrote = new Set(acked.filter(c => !c.deleted).map(c => c.id));
     gone.push(...held.filter(r => !present.has(r.id) && !wrote.has(r.id)).map(r => r.id));
    }
    // A conflict's tombstone is a delete from elsewhere too.
    for (const [id, row] of adopted) if (row?.deleted) gone.push(id);
    after.promptsGone = gone.filter(id => !pushed.has(id));
    // The sent writes stay as they are: the next merge settles those the mirror shows landed, once
    // it has used them to tell a write landing from an edit here. The merge pruned the tombstones;
    // again only when the readback or a conflict brought some, or deletes or sends settled since.
    const brought = readBack.full || readBack.items.some(it => it.collection === "prompts" && it.deleted) || [...adopted.values()].some(r => r?.deleted === true);
    const settled = after.promptDeletes.length < pending || Object.keys(merged.attempts).some(id => !Object.hasOwn(after.promptAttempts ?? {}, id));
    if (brought || settled) after.mirror = tombstonesFor(after.mirror, () => [...stored.prompts.map(p => p.id), ...after.promptDeletes ?? [], ...Object.keys(after.promptAttempts ?? {})]);
   }
   // Stopped short: the next round starts with the first write not answered that can go now (one
   // held back at the variant cap, which may stay held while no upload of it settles, or no longer
   // saved as planned, never pins it); with none, where the merge puts it.
   if (stopped) {
    const saved = new Map(stored.prompts.map(p => [p.id, fieldsOf(p)]));
    const turn = changes.find(c => !c.deleted && !answered.has(c.id) && sendable(c, saved, after).change !== null)?.id;
    if (turn !== undefined) after.promptsTurn = turn;
   }
   // A round that left a write unsent, held one back at the variant cap, kept a delete waiting (or
   // found one back after a restore), or one the account refused for a newer copy did not finish
   // well: SYNCED keeps the last one that did.
   if (unsent === null && !conflicted && !deferred && !dormant && !restored) after.lastSync = { lastSyncedMs: now(), machines: after.mirror.hosts.length, prompts: after.mirror.prompts.length };
   writePrompts(storage, { ...stored, sync: after });
   folded.clear(after);
  }, signal);
  if (unsent !== null) throw unsent;
  // A conflict's newer copy is merged on the next pass, which holds the edit back again if it
  // must; otherwise the edit held back waits for a later round.
  if (deferred && !conflicted) throw new PromptsWaiting();
  if (dormant && !conflicted) throw new PromptsWaiting(DELETE_WAITS);
  if (restored) throw new PromptsWaiting("a deleted prompt is back after the account was restored: it is deleted again next time");
  return conflicted;
 }

 async function round(signal: AbortSignal): Promise<void> {
  const cur = account.current;
  if (cur === null) return;
  // The session the round is for, from its start to its end (once).
  const generation = account.generation;
  try {
   // The account's resetKey place, before anything can meet a 410; then what an earlier round,
   // cancelled, still owes the state (owe).
   reserveResets(place.storage(), cur.accountID);
   await payOwed(cur.accountID, signal);
   // A conflict: the account holds a newer copy; merge with it and push again, PUSH_PASSES in
   // all. Still conflicted then, a merge alone tells whether anything is left to send. Every pass
   // is the session's the round began with.
   let left = false;
   for (let pass = 0; pass < PUSH_PASSES && (pass === 0 || left); pass++) left = await once(signal, true, cur.accountID, generation);
   if (left && await once(signal, false, cur.accountID, generation)) throw new SyncConflict();
  } catch (error) {
   // A session that ended told the page itself (account.ts onSessionChange); a sync the session
   // left (signed out, another account, or a new session even of the same account) says nothing
   // about the session now: its last result stands. (What the round's sent requests were
   // answered is recorded apart: owe.)
   if (error instanceof SignedOutError || error instanceof SyncAbandoned || account.generation !== generation) return;
   noteSync(cur.accountID, true);
   throw error;
  }
  if (account.generation === generation) noteSync(cur.accountID, false);
 }

 const sync = (signal?: AbortSignal): Promise<void> => {
  const deadline = AbortSignal.timeout(place.roundMs ?? 60_000);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const run = () => { bounded.throwIfAborted(); return round(bounded); };
  const turn = turns.then(() => place.locks ? place.locks.request(SYNC_LOCK, { signal: bounded }, run) : run());
  turns = turn.catch(() => {});
  // A call still waiting for its turn leaves when bounded aborts; the turn then passes at once.
  return untilAborted(turn, bounded);
 };
 const soon = () => { if (place.background) sync().catch(error => console.warn("account sync:", error)); };
 return {
  sync,
  soon,
  failed: acct => failed.has(acct),
  status() {
   const cur = account.current;
   if (cur === null) return { ...NEVER };
   const state = readSyncState(place.storage());
   return state === null || state.accountId !== cur.accountID || !state.lastSync ? { ...NEVER } : state.lastSync;
  },
  prompts: promptsDesk(soon, place.storage, place.locks),
 };
}

// ---- The Desk methods (desk_prompts.go) ----

/** The saved-prompt Desk methods (desk_prompts.go). */
export interface PromptsDesk {
 savedPrompts(): Promise<SavedPrompt[]>;
 savePrompt(p: SavedPrompt): Promise<SavedPrompt[]>;
 /** The account's other devices drop it too: the next sync pushes its tombstone. */
 deletePrompt(id: string): Promise<SavedPrompt[]>;
 importSavedPrompts(list: SavedPrompt[]): Promise<SavedPrompt[]>;
}

/** `storage` (the sync's) is looked up on each call, not when the module loads: a browser that
 *  refuses storage (a throwing `localStorage` getter) still starts, and the prompt calls reject
 *  with its error. Each change reads and writes under the storage lock (PROMPTS_LOCK), so none
 *  lands between a sync's read and its write in another tab. soon syncs after each change. */
function promptsDesk(soon: () => void, storage: () => KeyValue, locks: AbortableLocks | null): PromptsDesk {
 /** After a call that did change the saved prompts: every view hears it, and a sync follows. */
 const changed = (prompts: SavedPrompt[], did: boolean) => {
  if (did) { emit("savedPromptsChanged", prompts); soon(); }
  return prompts;
 };
 return {
  async savedPrompts(): Promise<SavedPrompt[]> { return readPrompts(storage()).prompts; },
  async savePrompt(p: SavedPrompt): Promise<SavedPrompt[]> {
   if (!p.text.trim()) throw new Error("a prompt needs text");
   const prompts = await underLock(locks, () => {
    const s = storage(), stored = readPrompts(s), saved = { ...p, nickname: p.nickname.trim() };
    const i = p.id ? stored.prompts.findIndex(q => q.id === p.id.toLowerCase()) : -1;
    if (i >= 0) stored.prompts[i] = { ...saved, id: stored.prompts[i]!.id };
    else stored.prompts.push({ ...saved, id: promptID(p.id) });
    writePrompts(s, stored);
    return stored.prompts;
   });
   return changed(prompts, true);
  },
  /** The account's other devices drop it too: the next sync pushes its tombstone. */
  async deletePrompt(id: string): Promise<SavedPrompt[]> {
   id = id.toLowerCase();
   const { prompts, did } = await underLock(locks, () => {
    const s = storage(), stored = readPrompts(s);
    const i = stored.prompts.findIndex(p => p.id === id);
    if (i < 0) return { prompts: stored.prompts, did: false };
    // A prompt the account holds, or may hold (a sync is sending it), is kept for a tombstone
    // before it goes; a damaged sync state refuses the delete (the account would never hear of
    // it). The next sync pushes the tombstone only if the account then holds the prompt. The
    // tombstone and the list without the prompt are one write (Stored).
    const state = stored.sync ?? null;
    const held = state !== null && (Object.hasOwn(state.promptBaseline ?? {}, id) || Object.hasOwn(state.promptAttempts ?? {}, id)
     || state.mirror.prompts.some(r => r.id === id));
    if (held && !(state.promptDeletes ?? []).includes(id)) stored.sync = { ...state, promptDeletes: [...state.promptDeletes ?? [], id] };
    stored.prompts.splice(i, 1);
    writePrompts(s, stored);
    return { prompts: stored.prompts, did: true };
   });
   return changed(prompts, did);
  },
  async importSavedPrompts(list: SavedPrompt[]): Promise<SavedPrompt[]> {
   const { prompts, did } = await underLock(locks, () => {
    const s = storage(), stored = readPrompts(s);
    if (stored.imported) return { prompts: stored.prompts, did: false };
    const have = new Set(stored.prompts.map(p => p.id));
    for (const p of list) {
     if (!p.text?.trim()) continue;
     const id = promptID(p.id ?? "");
     if (have.has(id)) continue;
     have.add(id); stored.prompts.push({ id, nickname: (p.nickname ?? "").trim(), text: p.text });
    }
    stored.imported = true; writePrompts(s, stored);
    return { prompts: stored.prompts, did: list.length > 0 };
   });
   // An import tells no view (the page asked for it and shows what comes back); it only syncs.
   if (did) soon();
   return prompts;
  },
 };
}
