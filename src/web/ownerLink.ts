// The open owner link (desk.ts connectOwner), for the browser Desk's method groups
// (web/mygo.ts): a group calls herdr on it with ownerCall, reads the machine, scope and last
// agent list, and hears each new link. desk.ts alone sets it; one link at a time, as Go's Desk.

import { sleep } from "../webguest/abort";
import type { EnvelopeMachine } from "../webguest/approve";
import { HerdrAPIError } from "../webguest/errors";
import type { AgentInfo } from "./board";
import type { OwnerGroups } from "./groups";
import { untagged, type GuestClient, type Pong } from "./engine";

export interface OwnerLink {
 /** The approved machine: hostID, label, the grant's scope and expiry. */
 readonly machine: EnvelopeMachine;
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
 /** The machine's folders and stars (groups.ts): the menus' document and the edits' queue. */
 readonly groups?: OwnerGroups;
}

let current: OwnerLink | null = null;
let settingsToken = "";
/** Ends with the open Settings scope: its token replaced or cleared, or its link gone. */
let settingsLife = new AbortController();
function setSettingsToken(token: string) {
 if (token === settingsToken) return;
 settingsLife.abort(new Error("Settings changed: open it again"));
 settingsLife = new AbortController();
 settingsToken = token;
}
const watchers = new Set<(link: OwnerLink | null) => void>();

export function currentOwnerLink(): OwnerLink | null { return current; }

/** Calls f with each new link, and null once none is open; returns the unsubscribe. */
export function onOwnerLinkChanged(f: (link: OwnerLink | null) => void): () => void {
 watchers.add(f);
 return () => { watchers.delete(f); };
}

/** For desk.ts only. A new link (or none) also ends the Settings scope opened on the last one. */
export function setOwnerLink(link: OwnerLink | null): void {
 if (link === current) return;
 current = link;
 setSettingsToken("");
 for (const f of [...watchers]) f(link);
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

/** For desk.ts only (openSettings / closeSettings): the Settings scope's token, "" when closed. */
export function setOwnerSettings(token: string): void { setSettingsToken(token); }

/** desk_settings.go settingsView: the link Settings opened token on, for a group's Settings page
 *  methods (they take the token). */
export function settingsLink(token: string): OwnerLink {
 if (current === null || token === "" || token !== settingsToken) throw new Error("Settings changed: open it again");
 return current;
}

/** The signal that ends with token's Settings scope (Go's view.ctx): closed, replaced, or its link
 *  gone. A Settings request carrying it is not sent once the scope has ended. */
export function settingsSignal(token: string): AbortSignal {
 settingsLink(token);
 return settingsLife.signal;
}

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
 *  operation never reaches the machine opened after it. Throws "not connected" without a link,
 *  OwnerRefusedError on owner_forbidden, ErrUnsupported for a capability the host lacks, else the
 *  transport's or herdr's error. It ends with the link, or with signal. */
export async function ownerCall<T>(method: string, params: unknown, tag: string, options: { capability?: string; signal?: AbortSignal; link?: OwnerLink | null } = {}): Promise<T> {
 const link = current;
 if (options.link !== undefined && options.link !== link) throw new Error(LINK_CHANGED);
 if (link === null) throw new Error("not connected");
 const signal = options.signal ? AbortSignal.any([link.signal, options.signal]) : link.signal;
 try {
  return untagged<T>(await link.client.call(method, params, tag, options.capability ?? "", signal));
 } catch (error) {
  throw error instanceof HerdrAPIError && error.code === "owner_forbidden" ? new OwnerRefusedError(method) : error;
 }
}

/** A Settings page's scope as an operation took it when it began: the link token's Settings were
 *  opened on, and the signal that ends with those Settings (settingsSignal). */
export interface SettingsScope { readonly link: OwnerLink; readonly signal: AbortSignal }

/** token's Settings scope, now (throws "Settings changed" when token's Settings are gone). */
export function settingsScope(token: string): SettingsScope {
 return { link: settingsLink(token), signal: settingsSignal(token) };
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
