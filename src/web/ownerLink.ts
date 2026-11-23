// The open owner link (desk.ts connectOwner), for the browser Desk's method groups
// (web/mygo.ts): a group calls herdr on it with ownerCall, reads the machine, scope and last
// agent list, and hears each new link. desk.ts alone sets it; one link at a time, as Go's Desk.

import type { EnvelopeMachine } from "../webguest/approve";
import { HerdrAPIError } from "../webguest/errors";
import type { AgentInfo } from "./board";
import { untagged, type GuestClient } from "./engine";

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
}

let current: OwnerLink | null = null;
let settingsToken = "";
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
 settingsToken = "";
 for (const f of [...watchers]) f(link);
}

/** For desk.ts only (openSettings / closeSettings): the Settings scope's token, "" when closed. */
export function setOwnerSettings(token: string): void { settingsToken = token; }

/** desk_settings.go settingsView: the link Settings opened token on, for a group's Settings page
 *  methods (they take the token). */
export function settingsLink(token: string): OwnerLink {
 if (current === null || token === "" || token !== settingsToken) throw new Error("Settings changed: open it again");
 return current;
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

/** One herdr call on the open link: the result without its tag. Throws "not connected" without a
 *  link, OwnerRefusedError on owner_forbidden, ErrUnsupported for a capability the host lacks,
 *  else the transport's or herdr's error. It ends with the link, or with signal. */
export async function ownerCall<T>(method: string, params: unknown, tag: string, options: { capability?: string; signal?: AbortSignal } = {}): Promise<T> {
 const link = current;
 if (link === null) throw new Error("not connected");
 const signal = options.signal ? AbortSignal.any([link.signal, options.signal]) : link.signal;
 try {
  return untagged<T>(await link.client.call(method, params, tag, options.capability ?? "", signal));
 } catch (error) {
  throw error instanceof HerdrAPIError && error.code === "owner_forbidden" ? new OwnerRefusedError(method) : error;
 }
}
