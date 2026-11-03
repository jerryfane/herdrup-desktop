// Guest invitations in every link form, ported from internal/guest/invite.go (which follows herdrup
// GuestInvite.swift at f2df68b): the app link, the web link's path and legacy fragment forms, and
// the short link whose sealed invite is fetched from its own relay and opened with its key.

import { expired, inviteRevoked, inviteUnreachable, notInvite, other } from "./errors";

export const APP_LINK_PREFIX = "herdrup://guest-invite#";

/** Where a grant's host is reached (invite.go:34-38). */
export interface Endpoint {
 relay: string;
 hostID: string;
 hostPublicKey: Uint8Array;
}

/** The relay WebSocket for an endpoint (invite.go:40-57). */
export function socketURL(endpoint: Endpoint): string {
 const u = relayURL(endpoint.relay);
 if (u === null) throw notInvite();
 const scheme = u.protocol === "http:" ? "ws:" : "wss:";
 return scheme + "//" + u.host + u.pathname.replace(/\/+$/, "") + "/v1/guest/" + endpoint.hostID;
}

/** A decoded v1 invitation. Its bearer secret is private: it only leaves through helloPayload,
 *  inside the Noise handshake (invite.go:59-71). */
export class Invite {
 readonly #inviteID: string;
 readonly #secret: string;
 constructor(
  readonly endpoint: Endpoint,
  readonly machineLabel: string,
  readonly ownerName: string,
  readonly agentName: string,
  readonly guestName: string,
  readonly expires: Date,
  inviteID: string,
  secret: string,
 ) {
  this.#inviteID = inviteID;
  this.#secret = secret;
 }

 toString() { return "guest invitation (bearer secret redacted)"; }
 toJSON() { return this.toString(); }

 /** The redeeming hello, message 1's payload (session.go:220-225). */
 helloPayload(device: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, invite_id: this.#inviteID, secret: this.#secret, device }));
 }
}

/** Go's decode64 (invite.go:73-86): base64url unless the value has + or /, padded if it has =.
 *  Like Go's decoder it skips \r and \n, and allows nonzero trailing bits. */
export function decode64(value: string): Uint8Array | null {
 const url = !/[+/]/.test(value);
 const match = (url ? /^([A-Za-z0-9_-]*)(=*)$/ : /^([A-Za-z0-9+/]*)(=*)$/).exec(value.replace(/[\r\n]/g, ""));
 if (match === null) return null;
 const [, body = "", pad = ""] = match;
 // Unpadded: any length but 4n+1. Padded: 4n+2 then "==", or 4n+3 then "=".
 if (pad === "" ? body.length % 4 === 1 : pad.length > 2 || pad.length !== 4 - body.length % 4) return null;
 const binary = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
 return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** invite.go:88-99. */
export function validGuestName(value: string): boolean {
 return /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value);
}

const graphemes = new Intl.Segmenter();
/** invite.go:101-103: not blank, at most 128 graphemes, no control or format characters. */
export function validLabel(value: string): boolean {
 if (value.trim() === "" || /[\p{Cc}\p{Cf}]/u.test(value)) return false;
 let count = 0;
 for (const _ of graphemes.segment(value)) if (++count > 128) return false;
 return true;
}

/** A relay URL as invite.go:105-113 admits it: https, or http on loopback only. */
function relayURL(text: string): URL | null {
 let u: URL;
 try { u = new URL(text); } catch { return null; }
 if (u.hostname === "") return null;
 if (u.protocol === "https:") return u;
 return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") ? u : null;
}

const FIELDS = ["v", "relay", "host_id", "host_pub", "invite_id", "secret", "machine_label", "owner_name", "agent_name", "guest_name", "expires_unix"] as const;
type Field = (typeof FIELDS)[number];

/** The v1 validation every link form runs, a short link's opened invite included (invite.go:123-167).
 *  Fields match as Go's encoding/json matches them: exactly, else case-insensitively; null is absent. */
export function decodeInviteJSON(raw: Uint8Array): Invite {
 let parsed: unknown;
 try { parsed = JSON.parse(new TextDecoder().decode(raw)); } catch { throw notInvite(); }
 if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) throw notInvite();
 const wire: Partial<Record<Field, unknown>> = {};
 let mistyped = false;
 for (const [key, value] of Object.entries(parsed ?? {})) {
  const field = FIELDS.find((f) => f === key) ?? FIELDS.find((f) => f === key.toLowerCase());
  if (field === undefined || value === null) continue;
  const integer = field === "v" || field === "expires_unix";
  if (integer ? !Number.isSafeInteger(value) : typeof value !== "string") mistyped = true;
  else wire[field] = value;
 }
 if (mistyped) throw notInvite();
 const text = (field: Field) => (wire[field] as string | undefined) ?? "";
 if ((wire.v ?? 0) !== 1) throw other("This invitation requires another version of herdrup. Update the app and ask the owner for a new link.");
 if (relayURL(text("relay")) === null) throw notInvite();
 const sizes: [Field, number][] = [["host_id", 16], ["host_pub", 32], ["invite_id", 16], ["secret", 32]];
 let hostPublicKey: Uint8Array | null = null;
 for (const [field, size] of sizes) {
  const decoded = decode64(text(field));
  if (decoded === null || decoded.length !== size) throw notInvite();
  if (field === "host_pub") hostPublicKey = decoded;
 }
 const expires = (wire.expires_unix as number | undefined) ?? 0;
 if (!validGuestName(text("guest_name")) || !validLabel(text("machine_label")) || !validLabel(text("owner_name")) || !validLabel(text("agent_name")) || expires <= 0) throw notInvite();
 return new Invite({ relay: text("relay"), hostID: text("host_id"), hostPublicKey: hostPublicKey! }, text("machine_label"), text("owner_name"), text("agent_name"), text("guest_name"), new Date(expires * 1000), text("invite_id"), text("secret"));
}

// A short link's last path segment: a 12-character id (9 random bytes) then a 22-character key
// (16 random bytes), both base64url without padding (invite.go:169-178).
const SEALED_ID_LENGTH = 12;
const SEALED_KEY_LENGTH = 22;
/** The longest sealed invite the relay stores. */
export const MAX_SEALED_INVITE = 2048;
/** The whole short-invite fetch's deadline. */
export const SEALED_INVITE_DEADLINE_MS = 15_000;

/** One link split into what it carries (invite.go:180-189). payload is the base64url v1 invite,
 *  empty for a short link; id and key name a short link's sealed invite; web is the relay the
 *  link points at (origin and path before /i), absent for the app link. */
export interface InviteLink {
 payload: string;
 id: string;
 key: string;
 web?: { url: URL; path: string };
}

/** invite.go:191-234: the app link, and the web link's path and fragment forms. */
export function linkParts(text: string): InviteLink | null {
 if (text.startsWith(APP_LINK_PREFIX)) {
  const payload = text.slice(APP_LINK_PREFIX.length);
  return payload === "" ? null : { payload, id: "", key: "" };
 }
 let u: URL;
 try { u = new URL(text); } catch { return null; }
 // u.search is empty for a bare "?", which Go's ForceQuery still refuses.
 if (u.protocol !== "https:" || u.hostname === "" || u.username !== "" || u.password !== "" || u.href.split("#", 1)[0]!.includes("?")) return null;
 const path = u.pathname;
 let payload: string;
 let base: string;
 let short = false;
 if (u.hash.length > 1) {
  if (!path.endsWith("/i")) return null;
  payload = u.hash.slice(1);
  base = path.slice(0, -2);
 } else {
  const marker = path.lastIndexOf("/i/");
  if (marker < 0) return null;
  payload = path.slice(marker + 3);
  base = path.slice(0, marker);
  if (payload.includes("/")) return null;
  short = !text.includes("#") && shortSegment(payload);
 }
 if (payload === "") return null;
 const web = { url: new URL(u.origin), path: base };
 if (short) return { payload: "", id: payload.slice(0, SEALED_ID_LENGTH), key: payload.slice(SEALED_ID_LENGTH), web };
 return { payload, id: "", key: "", web };
}

/** invite.go:236-249: exactly 34 base64url characters. */
export function shortSegment(segment: string): boolean {
 return segment.length === SEALED_ID_LENGTH + SEALED_KEY_LENGTH && /^[A-Za-z0-9_-]+$/.test(segment);
}

/** Where the link's own relay serves its sealed invite: the id only, never the key (invite.go:251-258). */
export function sealedURL(link: InviteLink): string {
 return link.web!.url.origin + link.web!.path + "/v1/invite/" + link.id;
}

/** invite.go:260-271. */
function sameRelay(a: URL, aPath: string, b: URL): boolean {
 const port = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");
 return a.protocol === b.protocol && a.hostname.toLowerCase() === b.hostname.toLowerCase() && port(a) === port(b) && aPath.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "");
}

/** invite.go:273-286: a web link only counts on its own invite's relay, and must not have expired. */
function admit(invite: Invite, web: InviteLink["web"], now: number): void {
 if (web !== undefined) {
  const relay = relayURL(invite.endpoint.relay);
  if (relay === null || !sameRelay(web.url, web.path, relay)) throw notInvite();
 }
 if (now >= invite.expires.getTime()) throw expired();
}

/** The text itself, then each whitespace-separated word in it (invite.go:288-298). */
function candidates(text: string): string[] {
 const trimmed = text.trim();
 return [trimmed, ...trimmed.split(/\s+/).filter((word) => word !== "" && word !== trimmed)];
}

/** Every link form that carries its payload; a short link needs the network and is not an invite
 *  here (invite.go:300-324). now is milliseconds since the epoch. */
export function parseInvite(text: string, now: number): Invite {
 let failure: unknown = null;
 for (const candidate of candidates(text)) {
  const link = linkParts(candidate);
  if (link === null || link.payload === "") continue;
  try {
   const raw = decode64(link.payload);
   if (raw === null) throw notInvite();
   const invite = decodeInviteJSON(raw);
   admit(invite, link.web, now);
   return invite;
  } catch (error) {
   failure ??= error;
  }
 }
 throw failure ?? notInvite();
}

/** Fetches a short link's sealed invite from its relay URL; resolves to the blob or rejects with
 *  the invite_revoked, invite_unreachable or not_invite GuestError, or the caller's abort. */
export type SealedInviteFetch = (url: string, signal?: AbortSignal) => Promise<Uint8Array>;

export interface ResolveOptions {
 /** Milliseconds since the epoch; default Date.now(). */
 now?: number;
 signal?: AbortSignal;
 fetchSealed?: SealedInviteFetch;
}

/** An invitation from any link form, or text holding one. A short link's sealed invite is fetched
 *  from the link's own relay, opened with the link's key, must name that relay, and then passes the
 *  same v1 validation as a long link (invite.go:330-363). */
export async function resolveInvite(text: string, options: ResolveOptions = {}): Promise<Invite> {
 const now = options.now ?? Date.now();
 const fetchSealed = options.fetchSealed ?? httpSealedInviteFetch();
 for (const candidate of candidates(text)) {
  const link = linkParts(candidate);
  if (link === null || link.payload !== "") continue;
  const blob = await fetchSealed(sealedURL(link), options.signal);
  const invite = decodeInviteJSON(await openSealed(blob, link.id, link.key));
  admit(invite, link.web, now);
  return invite;
 }
 return parseInvite(text, now);
}

/** AES-128-GCM under the link's 16-byte key, laid out nonce (12) || ciphertext || tag (16) and
 *  authenticated with the ASCII id (invite.go:365-386). */
export async function openSealed(blob: Uint8Array, id: string, key: string): Promise<Uint8Array> {
 const secret = /^[A-Za-z0-9_-]*$/.test(key) ? decode64(key) : null;
 if (secret === null || secret.length !== 16 || blob.length <= 12 + 16 || blob.length > MAX_SEALED_INVITE) throw notInvite();
 try {
  const aes = await crypto.subtle.importKey("raw", secret as BufferSource, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(0, 12) as BufferSource, additionalData: new TextEncoder().encode(id), tagLength: 128 }, aes, blob.subarray(12) as BufferSource);
  return new Uint8Array(plain);
 } catch {
  throw notInvite();
 }
}

/** One GET that stays on the link's relay (a redirect reads as unreachable), with a deadline over the
 *  whole exchange, reading at most one byte past MAX_SEALED_INVITE (invite.go:388-431). No cookies or
 *  referrer go with it. */
export function httpSealedInviteFetch(fetchFn: typeof fetch = globalThis.fetch.bind(globalThis), deadlineMs = SEALED_INVITE_DEADLINE_MS): SealedInviteFetch {
 return async (url, signal) => {
  const unreachable = () => signal?.aborted ? signal.reason : inviteUnreachable();
  if (signal?.aborted) throw signal.reason;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const forward = () => controller.abort();
  signal?.addEventListener("abort", forward, { once: true });
  try {
   let response: Response;
   try {
    response = await fetchFn(url, { method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal });
   } catch {
    throw unreachable();
   }
   // A browser's manual redirect is an opaque response with status 0.
   if (response.status !== 200 || Number(response.headers.get("Content-Length") ?? 0) > MAX_SEALED_INVITE) {
    void response.body?.cancel().catch(() => {});
    throw response.status === 404 ? inviteRevoked() : response.status !== 200 ? inviteUnreachable() : notInvite();
   }
   const blob = new Uint8Array(MAX_SEALED_INVITE + 1);
   let length = 0;
   try {
    const reader = response.body?.getReader();
    while (reader !== undefined && length <= MAX_SEALED_INVITE) {
     const { done, value } = await reader.read();
     if (done) break;
     blob.set(value.subarray(0, blob.length - length), length);
     length += value.length;
    }
    if (length > MAX_SEALED_INVITE) void reader?.cancel().catch(() => {});
   } catch {
    throw unreachable();
   }
   if (length > MAX_SEALED_INVITE) throw notInvite();
   return blob.slice(0, length);
  } finally {
   clearTimeout(timer);
   signal?.removeEventListener("abort", forward);
  }
 };
}
