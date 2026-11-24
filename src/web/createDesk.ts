// desk_create.go and internal/engine/create.go for the browser's owner link: New agent (agent.kinds,
// fs.list_dir, then pane.split → agent.start, closing the new pane when the start is refused) and
// New terminal (pane.split, then saved in terminalsDesk.ts). One creation at a time, as Go's Desk:
// opened on the owner link's board, it ends when closed, when another opens, or with the link.
// herdr allows these methods to a terminal-scope owner link only (herdr#510); the shell offers
// New agent and New terminal only there (main.ts ownerWrites).

import type { AgentCreationResult, Desk as GoDesk, TerminalCreationResult } from "../mygo";
import { normalizeAgentName } from "../agentActionsModel";
import { sleep } from "../webguest/abort";
import { HerdrAPIError, NotSentError } from "../webguest/errors";
import { pathBase, type AgentInfo } from "./board";
import { ErrUnsupported, ResultTagError } from "./engine";
import { boardLink, CLOSING_WAIT_MS, currentOwnerLink, onLinkClosing, ownerCall, OwnerRefusedError, type OwnerLink } from "./ownerLink";
import type { StartWatch } from "./startedAgents";
import { persistAndKeep, TerminalNotKeptError } from "./terminalsDesk";

type DeskFns = typeof GoDesk;

/** desk_create.go creationSession. */
interface Creation {
 token: string;
 /** The saved-terminals bucket (the machine's hostID), kept even if the link changes. */
 host: string;
 link: OwnerLink;
 /** Ends with closeCreation or the next openCreation. */
 life: AbortController;
 /** life and the link's: what the creation's requests end with (viewRequest). */
 signal: AbortSignal;
 /** v.mu: one create at a time. */
 busy: boolean;
 used: boolean;
 /** The new pane an agent.start found still busy with its shell's start, kept with the folder it
  *  was split in and its attempt's roster watch for the next Start (ShellStartingError); closed
  *  when the creation or its link ends. */
 kept: Kept | null;
}

interface Kept {
 pane: EmptyPane;
 folder: string;
 watch: StartWatch;
}

/** A pane a creation splits that runs nothing so far, owned by its creation and link from before
 *  the split is asked until it is closed or an agent may run in it. Its one cleanup (cleanup) is
 *  shared by whoever ends it: the creation's end (closeCreation, the next openCreation, its sheet
 *  gone), the link's (before its connection goes, onLinkClosing), and the creation's own failure
 *  paths. It waits first for the split's answer (an end while it is out still closes the pane it
 *  made), then for a start out on the pane (within the link's closing wait): one that never went
 *  out or herdr refused leaves the pane empty and it closes; one that may have reached herdr
 *  leaves it alone. */
class EmptyPane {
 /** The pane's id once the split answered. */
 id = "";
 /** The split: the pane's id, or the split's failure (no pane this side knows to close). */
 readonly made: Promise<string>;
 /** An agent.start is out on the pane, or came back without a definite refusal. */
 startOut = false;
 /** Settles once the last start's outcome is classified (startOut set). */
 #starting: Promise<void> = Promise.resolve();
 #cleanup: Promise<unknown> | null = null;
 /** The one decision on the pane between its cleanup and a save (createTerminal): "closing" from
  *  the moment its cleanup begins (the pane closes, and nothing keeps it after, a split answered
  *  later included), "kept" once a save's record was written (the cleanup leaves it). Whichever
  *  comes first stands. */
 #claim: "closing" | "kept" | null = null;
 readonly #off: () => void;

 /** Owns the pane split asks for on link, until end (the creation's requests' signal: its end and
  *  its link's): split runs once the ownership is in place. */
 constructor(readonly link: OwnerLink, end: AbortSignal, split: () => Promise<string>) {
  const offLink = onLinkClosing(link, () => this.cleanup());
  const ended = () => { void this.cleanup(); };
  end.addEventListener("abort", ended, { once: true });
  this.#off = () => { offLink(); end.removeEventListener("abort", ended); };
  this.made = split().then((id) => this.id = id);
  this.made.catch(this.#off);
  if (end.aborted) ended();
 }

 /** The creation or its link ended: the pane closes, and a save keeps nothing (persistAndKeep). */
 get taken(): boolean { return this.#claim === "closing"; }

 /** A save's record was written: the pane is kept (its cleanup leaves it). persistAndKeep checks
  *  taken, writes and keeps in one synchronous step under the terminal store's lock; a write
  *  storage refused throws first, so the cleanup still closes the pane. */
 keep() { this.#claim = "kept"; }

 /** desk_create.go cleanupCreatedPane, once, whoever asks: unless a save kept the pane, it is
  *  taken back (taken), and once the split and any start settled, closed on its own link whatever
  *  that link's life, unless a start may have reached herdr. The close's failure, or null (closed,
  *  kept, no pane, or left to a start). The link's end waits for it (up to CLOSING_WAIT_MS), and
  *  the pane is the link's no more once it settled. */
 cleanup(): Promise<unknown> {
  this.#cleanup ??= (async () => {
   if (this.#claim === "kept") return null;
   this.#claim = "closing";
   if (!await this.made.then(() => true, () => false)) return null;
   await this.#starting;
   if (this.startOut) return null;
   return await this.link.client.call("pane.close", { pane_id: this.id }, "ok", "", AbortSignal.timeout(CLOSING_WAIT_MS)).then(
    () => null, (error: unknown) => error instanceof HerdrAPIError && error.code === "owner_forbidden" ? new OwnerRefusedError("pane.close") : error).finally(this.#off);
  })();
  return this.#cleanup;
 }

 /** An agent runs, or may run, in the pane: it is the roster's or the user's now. */
 release() { this.#off(); }

 /** call for this pane's agent.start: startOut until herdr answered it definitively, or the
  *  transport says the request never went out (NotSentError). */
 async start<T>(call: () => Promise<T>): Promise<T> {
  this.startOut = true;
  const settled = Promise.withResolvers<void>();
  this.#starting = settled.promise;
  try {
   return await call();
  } catch (error) {
   if (notMutated(error)) this.startOut = false;
   throw error;
  } finally { settled.resolve(); }
 }
}

let creation: Creation | null = null;

const CHANGED = "creation connection or session changed; request was not sent";
const text = (error: unknown) => error instanceof Error ? error.message : String(error);
/** bridge.APIError: herdr answered with a refusal (owner_forbidden comes as OwnerRefusedError). */
const refused = (error: unknown) => error instanceof HerdrAPIError || error instanceof OwnerRefusedError;

/** desk_create.go creationView. A creation's life ends only with closeCreation, the next
 *  openCreation or its link, so the open one on the current link is alive. */
function creationView(token: string): Creation {
 const v = creation;
 if (v === null || v.token !== token || currentOwnerLink() !== v.link) throw new Error(CHANGED);
 return v;
}

/** One herdr call on the creation's own link, never on a link opened since: ownerCall sends
 *  nothing once another link (or none) is open (NotSentError). */
function call<T>(v: Creation, method: string, params: unknown, tag: string, signal = v.signal): Promise<T> {
 return ownerCall<T>(method, params, tag, { signal, link: v.link });
}

/** A pane a start left empty (busy, or the request never sent): kept for the next Start while its
 *  sheet lives, else its watch ends; the creation's end has the pane cleaned up (EmptyPane). */
function keepEmpty(v: Creation, pane: EmptyPane, folder: string, watch: StartWatch) {
 if (creation === v && !v.signal.aborted) { v.kept = { pane, folder, watch }; return; }
 watch.end();
}

/** The kept pane, taken back from the creation (its link still owns it). */
function takeKept(v: Creation): Kept | null {
 const kept = v.kept;
 v.kept = null;
 return kept;
}

/** A creation's end: its requests stop (which has each of its panes cleaned up, EmptyPane), and
 *  the roster watch of the pane it kept for another start ends. */
function endCreation(v: Creation) {
 v.life.abort(new Error(CHANGED));
 takeKept(v)?.watch.end();
}

/** herdr's pane.process_info result (herdrapi PaneProcessInfo). */
export interface PaneProcessInfo {
 shell_pid?: number | null;
 foreground_process_group_id?: number | null;
 foreground_processes?: { pid: number; name: string; argv?: string[] }[];
}

const SHELLS = ["sh", "bash", "dash", "zsh", "fish", "ksh", "mksh", "csh", "tcsh", "elvish", "xonsh", "nu", "pwsh", "powershell", "cmd"];

/** engine shellName. */
function shellName(name: string): boolean {
 const i = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
 if (i >= 0) name = name.slice(i + 1);
 if (/[^\x00-\x7f]/.test(name)) return false;
 name = name.replace(/^-+/, "");
 while (name.endsWith(".exe")) name = name.slice(0, -".exe".length);
 return SHELLS.includes(name.toLowerCase());
}

/** engine shellInitializing: the pane's shell still owns the foreground (its rc files run). */
function shellInitializing(info: PaneProcessInfo | undefined): boolean {
 const shell = info?.shell_pid;
 if (shell == null || info!.foreground_process_group_id == null || shell !== info!.foreground_process_group_id) return false;
 return (info!.foreground_processes ?? []).some(p => p.pid === shell && (shellName(p.name) || (!!p.argv?.length && shellName(p.argv[0]!))));
}

/** One new pane's readiness wait (createAgent's), its operations bound to the pane: start is its
 *  agent.start, classified for the pane's teardown as it goes (EmptyPane.start); probe is its
 *  pane.process_info, ended by signal (the wait's deadline and the creation's end). */
export interface ShellReadyOps {
 start(): Promise<AgentInfo>;
 probe(signal: AbortSignal): Promise<PaneProcessInfo | undefined>;
}
/** The readiness wait's time: its pauses and its one deadline. */
export interface Clock {
 sleep(ms: number, signal: AbortSignal): Promise<void>;
 /** A signal that aborts ms from now. */
 timeout(ms: number): AbortSignal;
}

const realClock: Clock = { sleep, timeout: (ms) => AbortSignal.timeout(ms) };

/** engine StartAgentWhenShellReady's bounded wait for a starting shell. */
const SHELL_READY_MS = 2000;

/** An agent.start herdr refused as busy (agent_pane_busy) while this link can't see whether the new
 *  pane's shell is still starting: an owner gate refusing pane.process_info, a host without it, or
 *  a probe or wait that didn't finish. The start's outcome is known (it didn't run): the pane is
 *  kept for another Start, never closed nor started again on its own. */
export class ShellStartingError extends Error {
 constructor() {
  super("The new pane's shell is still starting; try again in a moment.");
  this.name = "ShellStartingError";
 }
}

/** engine StartAgentWhenShellReady: the native client's bounded shell-rc retry. Only a definitive
 *  agent_pane_busy is retried, while the shell still owns the foreground process group. The whole
 *  wait, probes and pauses included, has one deadline (SHELL_READY_MS from the first busy answer):
 *  when it runs out, the last busy answer stands. As Go, a host without pane.process_info is
 *  retried within it and a refused probe isn't; a busy start that outlasts either throws
 *  ShellStartingError, as nothing told the shell apart from another program. So does a probe or a
 *  pause that fails otherwise (a sheet or link ending): the pane runs nothing. A start whose answer
 *  isn't a definite busy is never repeated. */
export async function startAgentWhenShellReady(ops: ShellReadyOps, signal: AbortSignal, clock: Clock = realClock): Promise<AgentInfo> {
 let previous: unknown = null, unsupported = false, unseen = false, wait: AbortSignal | null = null;
 const initializing = async (): Promise<boolean> => {
  if (unsupported) return true;
  try {
   return shellInitializing(await ops.probe(AbortSignal.any([signal, wait!])));
  } catch (error) {
   if (error instanceof ErrUnsupported) { unsupported = unseen = true; return true; }
   if (error instanceof OwnerRefusedError) { unseen = true; return false; }
   if (refused(error) || error instanceof ResultTagError) return false;
   throw error;
  }
 };
 const busy = (failure: unknown) => unseen ? new ShellStartingError() : failure;
 /** work within the wait after busy answered: the wait running out leaves busy standing; any other
  *  failure leaves the pane as busy left it, empty. */
 const waited = async <T>(busyAnswer: unknown, work: () => Promise<T>): Promise<T> => {
  try { return await work(); } catch { throw wait!.aborted ? busy(busyAnswer) : new ShellStartingError(); }
 };
 for (;;) {
  if (previous !== null && !await waited(previous, initializing)) throw busy(previous);
  let failure: unknown;
  try {
   return await ops.start();
  } catch (error) { failure = error; }
  if (!(failure instanceof HerdrAPIError) || failure.code !== "agent_pane_busy") throw failure;
  wait ??= clock.timeout(SHELL_READY_MS);
  if (!await waited(failure, initializing)) throw busy(failure);
  const pause = AbortSignal.any([signal, wait]);
  await waited(failure, () => clock.sleep(100, pause));
  previous = failure;
 }
}

/** engine SplitPane: a pane below the focused one, focused, in cwd when given. Until it is handed
 *  to the transport it is the creation's request like any other: the creation or its link ending
 *  drops it unsent (NotSentError). Once sent, herdr may make the pane and only its answer names
 *  it: that is waited for past their end, up to CLOSING_WAIT_MS more (ownerCall's unsent and reply
 *  window), and the pane it names is closed by its owners' end (EmptyPane). The window's listener
 *  and timer last only while the split is out. */
async function splitPane(v: Creation, cwd: string): Promise<string> {
 const params = { direction: "down", ...(cwd !== "" ? { cwd } : {}), focus: true };
 const reply = new AbortController();
 let timer: ReturnType<typeof setTimeout> | undefined;
 const arm = () => { timer = setTimeout(() => reply.abort(v.signal.reason), CLOSING_WAIT_MS); };
 if (v.signal.aborted) arm(); else v.signal.addEventListener("abort", arm, { once: true });
 try {
  return (await ownerCall<{ pane: { pane_id: string } }>("pane.split", params, "pane_info", { link: v.link, unsent: v.signal, signal: reply.signal })).pane.pane_id;
 } finally {
  v.signal.removeEventListener("abort", arm);
  clearTimeout(timer);
 }
}

/** Whether a failed creation call (pane.split, agent.start) definitely changed nothing: herdr
 *  refused it, doesn't know it, or the request never went out. Anything else (a lost answer, a
 *  timeout) leaves the machine unknown. */
function notMutated(error: unknown): boolean {
 return refused(error) || error instanceof ErrUnsupported || error instanceof NotSentError;
}

/** cleanupCreatedPane for an agent that didn't start: failed once its pane is closed, else uncertain. */
async function agentNotStarted(v: Creation, pane: EmptyPane, cause: unknown): Promise<AgentCreationResult> {
 const failure = await pane.cleanup();
 if (failure !== null) return { phase: "uncertain", paneID: pane.id, name: "", message: `Agent did not start: ${text(cause)}. Could not close empty pane ${pane.id}: ${text(failure)}` };
 v.used = false;
 return { phase: "failed", paneID: "", name: "", message: text(cause) };
}

export const createDesk = {
 async openCreation(machineID: string, session: string, token: string): Promise<void> {
  if (token === "" || token.length > 128) throw new Error("invalid creation token");
  const link = boardLink(machineID, session);
  if (creation !== null) endCreation(creation);
  const life = new AbortController();
  creation = { token, host: link.machine.hostID, link, life, signal: AbortSignal.any([life.signal, link.signal]), busy: false, used: false, kept: null };
 },
 async closeCreation(token: string): Promise<void> {
  if (creation?.token !== token) return;
  endCreation(creation);
  creation = null;
 },
 /** The kinds the host offers; none from a host without agent.kinds, so the sheet's own fallback
  *  list applies (create.ts). */
 async creationKinds(token: string): Promise<string> {
  const v = creationView(token);
  let kinds: { kind: string; installed: boolean }[] = [];
  try {
   kinds = (await call<{ kinds: { kind: string; installed: boolean }[] }>(v, "agent.kinds", {}, "agent_kinds")).kinds;
  } catch (error) {
   if (!(error instanceof ErrUnsupported)) throw error;
  }
  return JSON.stringify(kinds.map(k => ({ installed: k.installed, kind: k.kind })));
 },
 async creationDirectory(token: string, folder: string): Promise<string> {
  const v = creationView(token);
  const listing = await call<{ entries: { is_dir: boolean; name: string }[]; path: string }>(v, "fs.list_dir", folder !== "" ? { path: folder } : {}, "dir_list");
  return JSON.stringify({ entries: listing.entries.map(e => ({ is_dir: e.is_dir, name: e.name })), path: listing.path });
 },
 async createAgent(token: string, folder: string, kind: string): Promise<AgentCreationResult> {
  const v = creationView(token);
  if (v.busy) throw new Error("an agent is already starting");
  v.busy = true;
  try {
   if (v.used) throw new Error("this creation already started or has an uncertain result; inspect the board before creating another agent");
   folder = folder.trim(); kind = kind.trim();
   if (kind === "" || (folder !== "" && !folder.startsWith("/"))) throw new Error("choose an agent kind and an absolute folder path, or leave the folder empty");
   const name = normalizeAgentName(folder !== "" && folder !== "/" ? pathBase(folder) : kind);
   v.used = true;
   let pane: EmptyPane, watch: StartWatch;
   const kept = takeKept(v);
   if (kept !== null && kept.folder === folder) ({ pane, watch } = kept);
   else {
    // Another folder needs another pane: the one kept in the old folder goes first.
    kept?.watch.end();
    const failure = kept === null ? null : await kept.pane.cleanup();
    if (failure !== null) return { phase: "uncertain", paneID: kept!.pane.id, name: "", message: `Could not close empty pane ${kept!.pane.id}: ${text(failure)}` };
    // The roster's lists from here on may have the new pane (startedAgents.ts).
    watch = v.link.watchStart();
    pane = new EmptyPane(v.link, v.signal, () => splitPane(v, folder));
    try {
     await pane.made;
    } catch (error) {
     watch.end();
     if (notMutated(error)) { v.used = false; return { phase: "failed", paneID: "", name: "", message: text(error) }; }
     return { phase: "uncertain", paneID: "", name: "", message: "The new-pane result is unknown. Inspect the machine before creating another pane: " + text(error) };
    }
   }
   // A creation closed or a link ended meanwhile ends the start's requests (signal): a start then
   // out is uncertain, as Go's cancelled context; one herdr already refused as busy isn't.
   let agent: AgentInfo;
   try {
    agent = await startAgentWhenShellReady({
     start: () => pane.start(async () => (await call<{ agent: AgentInfo }>(v, "agent.start", { name, kind, pane_id: pane.id }, "agent_started")).agent),
     probe: async (signal) => (await call<{ process_info?: PaneProcessInfo }>(v, "pane.process_info", { pane_id: pane.id }, "pane_process_info", signal)).process_info,
    }, v.signal);
   } catch (error) {
    // A busy pane, or a start that never went out: the pane runs nothing and may be tried again.
    if (error instanceof ShellStartingError || error instanceof NotSentError) { keepEmpty(v, pane, folder, watch); v.used = false; return { phase: "failed", paneID: "", name: "", message: error.message }; }
    watch.end();
    if (notMutated(error)) return await agentNotStarted(v, pane, error);
    pane.release();
    return { phase: "uncertain", paneID: pane.id, name: "", message: `Start outcome is unknown for pane ${pane.id}. It was not closed or retried; inspect the machine: ${text(error)}` };
   }
   pane.release();
   // It opens and runs before the roster lists it, and the roster lists it at once (desk.ts).
   watch.started(agent);
   return { phase: "started", paneID: agent.pane_id ?? "", name, message: "" };
  } finally { v.busy = false; }
 },
 async createTerminal(token: string): Promise<TerminalCreationResult> {
  const v = creationView(token);
  if (v.busy) throw new Error("creation is already in progress");
  v.busy = true;
  try {
   if (v.used) throw new Error("this creation request was already sent; inspect its result before creating another");
   v.used = true;
   const pane = new EmptyPane(v.link, v.signal, () => splitPane(v, ""));
   try {
    await pane.made;
   } catch (error) {
    if (notMutated(error)) { v.used = false; return { phase: "failed", message: text(error) }; }
    return { phase: "uncertain", message: "The new-terminal result is unknown. Inspect the original machine before creating another: " + text(error) };
   }
   try {
    // Kept in the creation's machine even if the link changed while the split was pending, unless
    // the creation or its link ended first (TerminalNotKeptError: the pane closes, nothing is saved).
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
    const terminal = await persistAndKeep(pane, v.host, { id, paneID: pane.id, createdUnixMs: Date.now() });
    pane.release();
    return { phase: "started", terminal, message: "" };
   } catch (error) {
    // The save's failure says what was lost; the close's outcome is said here, once.
    const lost = `The new terminal wasn't saved on this device: ${text(error)}.`;
    const failure = await pane.cleanup();
    if (failure !== null) return { phase: "uncertain", message: `${lost} Could not close its pane ${pane.id}: ${text(failure)}` };
    if (!(error instanceof TerminalNotKeptError)) v.used = false;
    return { phase: "failed", message: `${lost} Its pane was closed.` };
   }
  } finally { v.busy = false; }
 },
} satisfies Partial<DeskFns>;
