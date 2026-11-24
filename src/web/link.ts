// The browser's one active link: Desk's `link` for a guest (desk_guest.go ConnectGuest) or the
// owner's (connectOwner, with its owner context), the GuestTransport its calls go through.
// GuestTransport is the only place that opens relay sockets, so a herdr that serves several
// requests per session can be reused there alone. ownerLink.ts is the owner view of this record.

import type { Access as GuestAccess } from "../mygo";
import type { Features, GuestTransport } from "../webguest/transport";
import type { OwnerLink } from "./ownerLink";

export type { GuestAccess };

export interface WebLink {
 /** The grant, as src/mygo.ts's ConnState.guest.access shows it. */
 readonly access: GuestAccess;
 /** The host's features from the last admission (Transport.Features). */
 features(): Features;
 /** One herdr request and its result. Errors are the transport's, worded as Go's guest client words
  *  them (webguest/errors.ts), herdr's API errors as HerdrAPIError ("herdr: code: message").
  *  sendSignal ends it only while it is unsent (RequestOptions.sendSignal). */
 call<T = unknown>(method: string, params?: unknown, signal?: AbortSignal, sendSignal?: AbortSignal): Promise<T>;
 /** A request whose reply lines are read until the host closes (pane.stream): each line as parsed
  *  JSON, the acknowledgement first. Aborting signal closes the connection. */
 stream(method: string, params: unknown, signal: AbortSignal): AsyncIterable<unknown>;
}

/** The one active link record: the link and, for an owner link, its owner context, set together.
 *  It also owns the Settings scope opened on that owner link (its token, and a signal that ends
 *  with it); the token stays private: callers use only openSettings, closeSettings and
 *  settingsScope. A new link (or none) ends the scope with the record. ownerLink.ts re-exports
 *  currentOwnerLink and settingsScope as the owner groups' import surface. */
let active: { link: WebLink; owner: OwnerLink | null; settings: { token: string; life: AbortController } | null } | null = null;
const watchers = new Set<(link: WebLink | null, owner: OwnerLink | null) => void>();

const SETTINGS_CHANGED = "Settings changed: open it again";

export function currentLink(): WebLink | null { return active?.link ?? null; }

/** The active link's owner context; null for a guest's or none. */
export function currentOwnerLink(): OwnerLink | null { return active?.owner ?? null; }

/** Opens the Settings scope `token` on the active owner link, ending any other scope open before;
 *  the one already open under `token` stays as it is (its signal live). Nothing without an owner
 *  link. */
export function openSettings(token: string): void {
 if (!active?.owner || token === "" || active.settings?.token === token) return;
 active.settings?.life.abort(new Error(SETTINGS_CHANGED));
 active.settings = { token, life: new AbortController() };
}

/** Ends the Settings scope `token` when it is the one open (another's is left as it is). */
export function closeSettings(token: string): void {
 if (!active?.settings || active.settings.token !== token) return;
 active.settings.life.abort(new Error(SETTINGS_CHANGED));
 active.settings = null;
}

/** A Settings page's scope as an operation took it when it began: the owner link token's Settings
 *  were opened on, and the signal that ends with those Settings (Go's view.ctx: closed, replaced,
 *  or its link gone). */
export interface SettingsScope { readonly link: OwnerLink; readonly signal: AbortSignal }

/** The Settings scope `token` names, now. Throws "Settings changed" when it is not the one open on
 *  the active link. */
export function settingsScope(token: string): SettingsScope {
 if (!active?.owner || !active.settings || token === "" || active.settings.token !== token) throw new Error(SETTINGS_CHANGED);
 return { link: active.owner, signal: active.settings.life.signal };
}

/** Calls f with each new link (null once none is connected) and, for an owner link, its owner
 *  context, published together; returns the unsubscribe. */
export function onLinkChanged(f: (link: WebLink | null, owner: OwnerLink | null) => void): () => void {
 watchers.add(f);
 return () => { watchers.delete(f); };
}

/** For desk.ts only: the link ConnectGuest made (owner null) or connectOwner made (with its owner
 *  context), or null after Forget. */
export function setLink(link: WebLink | null, owner: OwnerLink | null = null): void {
 if (link === currentLink() && (link ? owner : null) === currentOwnerLink()) return;
 active?.settings?.life.abort(new Error(SETTINGS_CHANGED));
 active = link ? { link, owner, settings: null } : null;
 for (const f of [...watchers]) f(link, currentOwnerLink());
}

/** A WebLink over transport. access is the grant as the page shows it. */
export function transportLink(access: GuestAccess, transport: GuestTransport): WebLink {
 return {
  access,
  features: () => transport.features,
  call: async <T>(method: string, params?: unknown, signal?: AbortSignal, sendSignal?: AbortSignal) => await transport.call(method, params, { signal, sendSignal }) as T,
  async *stream(method: string, params: unknown, signal: AbortSignal) {
   const lines = await transport.openStream(method, params, { signal });
   const close = () => lines.close();
   signal.addEventListener("abort", close, { once: true });
   try {
    for await (const line of lines) yield JSON.parse(line) as unknown;
   } finally {
    signal.removeEventListener("abort", close);
    lines.close();
   }
  },
 };
}
