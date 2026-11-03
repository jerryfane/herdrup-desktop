// The browser's one guest link: Desk's `link` for a guest (desk_guest.go ConnectGuest), the
// GuestTransport its calls go through. GuestTransport is the only place that opens relay sockets,
// so a herdr that serves several requests per session can be reused there alone.

import type { Access as GuestAccess } from "../mygo";
import type { Features, GuestTransport } from "../webguest/transport";

export type { GuestAccess };

export interface WebLink {
 /** The grant, as src/mygo.ts's ConnState.guest.access shows it. */
 readonly access: GuestAccess;
 /** The host's features from the last admission (Transport.Features). */
 features(): Features;
 /** One herdr request and its result. Errors are the transport's, worded as Go's guest client words
  *  them (webguest/errors.ts), herdr's API errors as HerdrAPIError ("herdr: code: message"). */
 call<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
 /** A request whose reply lines are read until the host closes (pane.stream): each line as parsed
  *  JSON, the acknowledgement first. Aborting signal closes the connection. */
 stream(method: string, params: unknown, signal: AbortSignal): AsyncIterable<unknown>;
}

let current: WebLink | null = null;
const watchers = new Set<(link: WebLink | null) => void>();

export function currentLink(): WebLink | null { return current; }

/** Calls f with each new link (null once none is connected); returns the unsubscribe. */
export function onLinkChanged(f: (link: WebLink | null) => void): () => void {
 watchers.add(f);
 return () => { watchers.delete(f); };
}

/** For desk.ts only: the link ConnectGuest made, or null after Forget. */
export function setLink(link: WebLink | null): void {
 if (link === current) return;
 current = link;
 for (const f of [...watchers]) f(link);
}

/** A WebLink over transport. access is the grant as the page shows it. */
export function transportLink(access: GuestAccess, transport: GuestTransport): WebLink {
 return {
  access,
  features: () => transport.features,
  call: async <T>(method: string, params?: unknown, signal?: AbortSignal) => await transport.call(method, params, { signal }) as T,
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
