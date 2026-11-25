// The open owner link (desk.ts connectOwner), for the browser Desk's method groups
// (web/mygo.ts): a group calls herdr on it with ownerCall and reads the machine, scope and last
// agent list. It is the owner view of link.ts's one active link record (desk.ts publishes the link
// with its owner context there), one link at a time, as Go's Desk.

import { sleep } from "../webguest/abort";
import type { EnvelopeMachine } from "../webguest/approve";
import { HerdrAPIError, notSent } from "../webguest/errors";
import type { AgentInfo } from "./board";
import type { OwnerGroups } from "./groups";
import type { StartWatch } from "./startedAgents";
import { untagged, type GuestClient, type Pong } from "./engine";
import { currentOwnerLink, settingsScope, type SettingsScope } from "./link";

// The active link record's owner accessors (link.ts), here as the owner groups import them.
export { currentOwnerLink, settingsScope, type SettingsScope };

export interface OwnerLink {
 /** The approved machine: hostID, label, the grant's scope and expiry. */
 readonly machine: EnvelopeMachine;
 /** The board this link publishes (BoardUpdate.machineID, "owner:<hostID>"; its session is ""). */
 readonly board: string;
 /** The engine client over the link (ping, the capability gate, tagged calls). */
 readonly client: GuestClient;
 /** Ends with the link: a leave, another machine, the account session's end. */
 readonly signal: AbortSignal;
 /** The scope herdr admitted the link under: "chat", "terminal", or "" before the first answer.
  *  Writes (herdr#510) exist only under "terminal". */
 scope(): string;
 /** The last agent.list. */
 agents(): readonly AgentInfo[];
 /** Lists again now and publishes the board (after a change a group made). */
 relist(): void;
 /** A creation's watch of the roster from before its split (startedAgents.ts): its acknowledged
  *  agent is provisional on this link until the roster decides, and the link lists again then. */
 watchStart(): StartWatch;
 /** The machine's folders and stars (groups.ts): the menus' document and the edits' queue. */
 readonly groups?: OwnerGroups;
}

/** app/federation.go ErrSessionChanged, as the desktop says it. */
export const SESSION_CHANGED = "the herdr session changed while machine status was read";

/** Whether a page's machineID and session name board (the owner link has one session, ""). */
export function onBoard(board: string, machineID: string, session: string): boolean {
 return board === machineID && (session === "" || session === "default");
}

/** desk_terminals.go terminalClient: the open link, when machineID and session name its board. */
export function boardLink(machineID: string, session: string): OwnerLink {
 const link = currentOwnerLink();
 if (link === null) throw new Error("not connected");
 if (!onBoard(link.board, machineID, session)) throw new Error(SESSION_CHANGED);
 return link;
}

/** linkClosing's longest wait for the groups' cleanup before the connection closes. */
export const CLOSING_WAIT_MS = 5000;
const closing = new WeakMap<OwnerLink, Set<() => Promise<unknown> | void>>();

/** f cleans up what a group made on link (a sign-in pane) when the link ends: it runs while the
 *  link's connection still carries requests, so it calls link.client itself (link.signal has ended,
 *  and ownerCall goes to the next link). Returns the unsubscribe. */
export function onLinkClosing(link: OwnerLink, f: () => Promise<unknown> | void): () => void {
 let fs = closing.get(link);
 if (fs === undefined) closing.set(link, fs = new Set());
 fs.add(f);
 return () => { fs.delete(f); };
}

/** For desk.ts only, as link ends: runs its closing cleanups; resolves when they settled, or after
 *  CLOSING_WAIT_MS, when the connection may close. */
export function linkClosing(link: OwnerLink): Promise<void> {
 const fs = [...(closing.get(link) ?? [])];
 closing.delete(link);
 if (fs.length === 0) return Promise.resolve();
 const work = Promise.allSettled(fs.map(async (f) => f()));
 return Promise.race([work.then(() => undefined), sleep(CLOSING_WAIT_MS)]);
}

/** desk_settings.go settingsView: the link Settings opened token on, for a group's Settings page
 *  methods (they take the token). A scope opened on another link (a leave, another machine) is
 *  over. */
export function settingsLink(token: string): OwnerLink { return settingsScope(token).link; }

/** What a web owner reads when herdr refuses a method to the owner's browser (owner_forbidden):
 *  the method isn't in its gate, or not under this link's scope. */
export const OWNER_REFUSED = "This machine's herdr doesn't allow that from a browser yet.";

export class OwnerRefusedError extends Error {
 constructor(readonly method: string) {
  super(OWNER_REFUSED);
  this.name = "OwnerRefusedError";
 }
}

/** What an operation bound to one link reads once another link (or none) is open: it was not sent. */
export const LINK_CHANGED = "the machine changed; the request was not sent";

/** One herdr call on the open link: the result without its tag. options.link is the link the
 *  operation began on: when it is no longer the open one the call is not sent (LINK_CHANGED), so an
 *  operation never reaches the machine opened after it. That and "not connected" (no link) are
 *  NotSentError, as the transport's failures before a send are. Throws OwnerRefusedError on
 *  owner_forbidden, ErrUnsupported for a capability the host lacks, else the transport's or
 *  herdr's error. It ends with the link, or with signal. With unsent, the call has two lifetimes:
 *  until it is handed to the transport it ends with unsent, which the caller composes with the
 *  link's end itself (ownerSplit: the same lifetime arms its reply window), so not sent; once
 *  sent, only signal (its reply's window) ends it, the link's end included: herdr may have acted,
 *  and its answer is still wanted. */
export async function ownerCall<T>(method: string, params: unknown, tag: string, options: { capability?: string; signal?: AbortSignal; unsent?: AbortSignal; link?: OwnerLink | null } = {}): Promise<T> {
 const link = currentOwnerLink();
 if (options.link !== undefined && options.link !== link) throw notSent(new Error(LINK_CHANGED));
 if (link === null) throw notSent(new Error("not connected"));
 const capability = options.capability ?? "";
 try {
  if (options.unsent !== undefined) return untagged<T>(await link.client.call(method, params, tag, capability, options.signal, options.unsent));
  const signal = options.signal ? AbortSignal.any([link.signal, options.signal]) : link.signal;
  return untagged<T>(await link.client.call(method, params, tag, capability, signal));
 } catch (error) {
  throw error instanceof HerdrAPIError && error.code === "owner_forbidden" ? new OwnerRefusedError(method) : error;
 }
}

/** engine SplitPane on link, for an operation that lasts until `operation` ends (New terminal's
 *  creation, a Settings sign-in or logout): the new pane's id. Both ends are the helper's, composed
 *  once: the split lasts while the operation and the link both do. Until it is handed to the
 *  transport it ends with either, unsent (NotSentError); one already ended is never sent and arms
 *  nothing. Once sent, herdr may make the pane and only its answer names it: that is awaited until
 *  either ends and CLOSING_WAIT_MS more (ownerCall's unsent and reply window), so a slow relay
 *  admission takes none of that window. The window's listener and timer last only while the split
 *  is out. The pane it names is the caller's to keep or close. */
export async function ownerSplit(link: OwnerLink, operation: AbortSignal, params: Record<string, unknown>): Promise<string> {
 const ends = AbortSignal.any([link.signal, operation]);
 const reply = new AbortController();
 let timer: ReturnType<typeof setTimeout> | undefined;
 const arm = () => { timer = setTimeout(() => reply.abort(ends.reason), CLOSING_WAIT_MS); };
 // Already ended, the listener never runs: ownerCall's not-sent path, no timer.
 ends.addEventListener("abort", arm, { once: true });
 try {
  return (await ownerCall<{ pane: { pane_id: string } }>("pane.split", params, "pane_info", { link, unsent: ends, signal: reply.signal })).pane.pane_id;
 } finally {
  ends.removeEventListener("abort", arm);
  clearTimeout(timer);
 }
}

/** Every herdr call a Settings page makes (desk_settings.go's view.client under view.ctx), its writes
 *  above all: on the scope's link only, and cancelled with the scope (and options.signal), so a call
 *  not yet sent when Settings closes (one waiting for the relay to admit it) is never sent. */
export function settingsCall<T>(scope: SettingsScope, method: string, params: unknown, tag: string, options: { capability?: string; signal?: AbortSignal } = {}): Promise<T> {
 const signal = options.signal ? AbortSignal.any([scope.signal, options.signal]) : scope.signal;
 return ownerCall<T>(method, params, tag, { capability: options.capability, signal, link: scope.link });
}

/** A Settings page's ping (the machine's version, the update card's capabilities), as settingsCall:
 *  on the scope's link only and cancelled with the scope, so one still waiting for the relay when
 *  Settings closes is never sent. Through the client's own ping, which keeps its capability cache. */
export function settingsPing(scope: SettingsScope, signal?: AbortSignal): Promise<Pong> {
 if (currentOwnerLink() !== scope.link) return Promise.reject(new Error(LINK_CHANGED));
 return scope.link.client.ping(AbortSignal.any([scope.link.signal, scope.signal, ...(signal ? [signal] : [])]));
}
