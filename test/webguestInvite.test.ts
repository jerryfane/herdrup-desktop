// Ports of internal/guest/invite_test.go and short_invite_test.go.
import { afterEach, expect, test } from "bun:test";
import { GuestError } from "../src/webguest/errors";
import { APP_LINK_PREFIX, decode64, httpSealedInviteFetch, linkParts, MAX_SEALED_INVITE, openSealed, parseInvite, resolveInvite, SEALED_INVITE_DEADLINE_MS, sealedURL, socketURL, type SealedInviteFetch } from "../src/webguest/invite";

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const now = 1800000000 * 1000;
const kindOf = async (promise: Promise<unknown>) => {
 try { await promise; return "accepted"; } catch (error) { return error instanceof GuestError ? error.kind : String(error); }
};
const syncKind = (fn: () => unknown) => kindOf((async () => fn())());

// A link that carries its payload must never reach the network.
const offline: SealedInviteFetch = async () => { throw new Error("a link that carries its payload was fetched"); };

test("invitation origin, expiry and identity boundaries (invite_test.go:16-56)", async () => {
 const encoded = (size: number) => b64url(new Uint8Array(size).fill(7));
 const fields: Record<string, unknown> = { v: 1, relay: "https://relay.example/base", host_id: encoded(16), host_pub: encoded(32), invite_id: encoded(16), secret: encoded(32), machine_label: "Mac", owner_name: "Owner", agent_name: "Agent", guest_name: "guest-1", expires_unix: now / 1000 + 60 };
 const payload = () => b64url(new TextEncoder().encode(JSON.stringify(fields)));
 for (const link of [APP_LINK_PREFIX + payload(), "https://relay.example/base/i/" + payload(), "https://relay.example/base/i#" + payload(), "Join my agent: " + APP_LINK_PREFIX + payload() + " Thanks!"]) {
  const invite = await resolveInvite(link, { now, fetchSealed: offline });
  expect(invite.guestName).toBe("guest-1");
  expect(invite.endpoint.hostPublicKey.length).toBe(32);
  expect(String(invite)).toBe("guest invitation (bearer secret redacted)");
  expect(JSON.stringify(invite)).not.toContain(encoded(32));
 }
 for (const prefix of ["https://evil.example/base/i/", "https://relay.example/other/i/", "http://relay.example/base/i/", "https://relay.example:444/base/i/"]) {
  expect(await kindOf(resolveInvite(prefix + payload(), { now, fetchSealed: offline }))).toBe("not_invite");
 }
 for (const [key, value] of [["host_pub", encoded(16)], ["secret", encoded(16)], ["host_id", encoded(32)], ["invite_id", encoded(32)], ["relay", "http://public.example"], ["guest_name", "-guest"], ["owner_name", "Owner\nInjected"], ["machine_label", "x".repeat(129)], ["agent_name", "Agent\u200b"], ["expires_unix", 0], ["v", "1"]] as const) {
  const old = fields[key];
  fields[key] = value;
  expect(await kindOf(resolveInvite(APP_LINK_PREFIX + payload(), { now, fetchSealed: offline }))).toBe("not_invite");
  fields[key] = old;
 }
 fields.v = 2;
 const newer = await resolveInvite(APP_LINK_PREFIX + payload(), { now, fetchSealed: offline }).catch((error: Error) => error.message);
 expect(newer).toBe("This invitation requires another version of herdrup. Update the app and ask the owner for a new link.");
 fields.v = 1;
 fields.machine_label = "e\u0301".repeat(128);
 expect((await resolveInvite(APP_LINK_PREFIX + payload(), { now, fetchSealed: offline })).machineLabel).toBe("e\u0301".repeat(128));
 fields.machine_label = "Mac";
 fields.expires_unix = now / 1000;
 expect(await kindOf(resolveInvite(APP_LINK_PREFIX + payload(), { now, fetchSealed: offline }))).toBe("expired");
 expect(await syncKind(() => parseInvite("not a link", now))).toBe("not_invite");
});

test("invite fields decode as Go's decode64 does", () => {
 const bytes = Uint8Array.from({ length: 16 }, (_, i) => 250 - i);
 const std = Buffer.from(bytes).toString("base64");
 expect(decode64(b64url(bytes))).toEqual(bytes);
 expect(decode64(std)).toEqual(bytes);
 expect(decode64(std.replace(/=+$/, ""))).toEqual(bytes);
 expect(decode64(b64url(bytes) + "==")).toEqual(bytes);
 expect(decode64(b64url(bytes) + "=")).toBeNull();
 expect(decode64("A")).toBeNull();
 expect(decode64("ab-+")).toBeNull();
 expect(decode64("ab!c")).toBeNull();
});

test("the relay socket URL keeps the relay's path and drops query and fragment (invite.go:40-57)", () => {
 const endpoint = { hostID: "HOST", hostPublicKey: new Uint8Array(32) };
 expect(socketURL({ ...endpoint, relay: "https://guest.herdrup.themartian.app" })).toBe("wss://guest.herdrup.themartian.app/v1/guest/HOST");
 expect(socketURL({ ...endpoint, relay: "https://relay.example:8443/base/?q=1#f" })).toBe("wss://relay.example:8443/base/v1/guest/HOST");
 expect(socketURL({ ...endpoint, relay: "http://127.0.0.1:4000" })).toBe("ws://127.0.0.1:4000/v1/guest/HOST");
 expect(() => socketURL({ ...endpoint, relay: "http://relay.example" })).toThrow(GuestError);
});

// The known-answer vector the daemon, the relay page, herdrup and the Go client check
// (short_invite_test.go:31-60, herdrup GuestInviteTests.swift:294-321 at f2df68b).
const katID = "AQIDBAUGBwgJ";
const katKey = "EBESExQVFhcYGRobHB0eHw";
const katLink = "https://guest.herdrup.themartian.app/i/AQIDBAUGBwgJEBESExQVFhcYGRobHB0eHw";
const katNonceHex = "303132333435363738393a3b";
const katBlob = "MDEyMzQ1Njc4OTo76HmMcTjDzE3OdSaDaK9beuTqzPLVVEUBKIa8OWJbqs8XDxQL0uQJSTWFeZvgkikIe1wxOA3sk7Hb4x6wjfHjOvVi3zfizc3/SM6+90bB9XIi6BXSmuiq8Z6OGZXR7UrLkh6Inxwh/qbAALuB4Rutr24iIC1sU1lG5r7/RWTqMxLRqqDKR32zUCL9iDYu8gaErdUgZeTfpeik9cwTC2mS9pAAakSI/hIczZymbpBb/IrgIv1W3sHDAfC08BLtejXbbxeRGf9jCWTISaVmJu0US2YeF36Re83O9PTtHSl952NNjZtz9hsOMylQomFWeNSDDtRe9oRVNidH/AW4KZnvLpFPC8I0/kZw6IIj18rkR0tEUuZ6ftnsFbrAvQs7hsQn4o6LtYtbJsZ6qhrglLQsb2yiyz5ilcqpXIOl+XaAEjfijL7c8KyX2hbUvWFDH6GS2VWqnlXnKt0SW0rQEaZ4ZBTtBAhU9uehul9N9CJXoQq1";
const katPlaintext = `{"agent_name":"demo","expires_unix":4102444800,"guest_name":"guest","host_id":"QUFBQUFBQUFBQUFBQUFBQQ","host_pub":"QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI","invite_id":"Q0NDQ0NDQ0NDQ0NDQ0NDQw","machine_label":"test-box","owner_name":"Owner","relay":"https://guest.herdrup.themartian.app","secret":"REREREREREREREREREREREREREREREREREREREREREQ","v":1}`;

test("short invite known answer (short_invite_test.go:44-91)", async () => {
 const blob = new Uint8Array(Buffer.from(katBlob, "base64"));
 expect(Buffer.from(blob.subarray(0, 12)).toString("hex")).toBe(katNonceHex);
 const link = linkParts(katLink);
 expect(link?.payload).toBe("");
 expect(link?.id).toBe(katID);
 expect(link?.key).toBe(katKey);
 expect(new TextDecoder().decode(await openSealed(blob, katID, katKey))).toBe(katPlaintext);
 const fetched: string[] = [];
 const invite = await resolveInvite(katLink, { now, fetchSealed: async (url) => { fetched.push(url); return blob; } });
 expect(fetched).toEqual(["https://guest.herdrup.themartian.app/v1/invite/" + katID]);
 expect(invite.endpoint.relay).toBe("https://guest.herdrup.themartian.app");
 expect(invite.endpoint.hostID).toBe("QUFBQUFBQUFBQUFBQUFBQQ");
 expect(invite.endpoint.hostPublicKey).toEqual(new Uint8Array(32).fill(0x42));
 expect([invite.machineLabel, invite.ownerName, invite.agentName, invite.guestName, invite.expires.getTime()]).toEqual(["test-box", "Owner", "demo", "guest", 4102444800 * 1000]);
 expect(JSON.parse(new TextDecoder().decode(invite.helloPayload("Browser")))).toEqual({ v: 1, invite_id: "Q0NDQ0NDQ0NDQ0NDQ0NDQw", secret: "REREREREREREREREREREREREREREREREREREREREREQ", device: "Browser" });
 // The key opens only its own id's invite, and only with the right key.
 const tampered = blob.slice();
 tampered[tampered.length - 1]! ^= 1;
 for (const [name, open] of Object.entries({
  "other id": () => openSealed(blob, "AQIDBAUGBwgK", katKey),
  "other key": () => openSealed(blob, katID, "EBESExQVFhcYGRobHB0eHg"),
  tampered: () => openSealed(tampered, katID, katKey),
  "too short": () => openSealed(blob.subarray(0, 28), katID, katKey),
  "too long": () => openSealed(new Uint8Array(MAX_SEALED_INVITE + 1), katID, katKey),
  "bad key": () => openSealed(blob, katID, "EBESExQVFhcYGRobHB0eH"),
 })) {
  expect([name, await kindOf(open())]).toEqual([name, "not_invite"]);
 }
});

test("short iff the last path segment is exactly 34 base64url characters (short_invite_test.go:95-122)", async () => {
 const segment = katID + katKey;
 const base = "https://guest.herdrup.themartian.app/i/";
 const withPath = linkParts("https://example.org/herdr/i/" + segment);
 expect(withPath === null ? null : [withPath.id, withPath.key, sealedURL(withPath)]).toEqual([katID, katKey, "https://example.org/herdr/v1/invite/" + katID]);
 for (const long of [segment.slice(0, 33), segment + "A", segment.slice(0, 33) + "!", segment.slice(0, 33) + "=", segment.slice(0, 33) + ".", segment.slice(0, 33) + "~"]) {
  const link = linkParts(base + long);
  expect([long, link?.payload, link?.id]).toEqual([long, long, ""]);
 }
 for (const junk of [base + katID + "#" + katKey, base + segment + "#x", base + segment + "?q=1", base + segment + "/", base + segment + "/x", "http://guest.herdrup.themartian.app/i/" + segment, "https://guest.herdrup.themartian.app/" + segment, "https://user@guest.herdrup.themartian.app/i/" + segment]) {
  expect([junk, linkParts(junk)]).toEqual([junk, null]);
 }
 // A short link is never read as a payload, and a link that is not one never fetches.
 expect(await syncKind(() => parseInvite(katLink, now))).toBe("not_invite");
 for (const junk of [base + segment.slice(0, 33), base + segment + "#", base + segment + "?"]) {
  expect([junk, await kindOf(resolveInvite(junk, { now, fetchSealed: offline }))]).toEqual([junk, "not_invite"]);
 }
});

// A relay on 127.0.0.1 that a short link's https://relay.example origin is routed to, so the real
// fetch (redirect, body cap, deadline) runs over HTTP.
const testID = "k7Qp2xRmA1bC";
const testKey = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const relayOrigin = "https://relay.example";
const shortLinkOn = (base: string) => base + "/i/" + testID + b64url(testKey);
let servers: { stop(force?: boolean): void }[] = [];
afterEach(() => { for (const server of servers) server.stop(true); servers = []; });

interface Hit { method: string; url: string; headers: Record<string, string> }
function serve(handle: (request: Request) => Response | Promise<Response>) {
 const hits: Hit[] = [];
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { hits.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers) }); return handle(request); } });
 servers.push(server);
 const local = `http://127.0.0.1:${server.port}`;
 const routed: typeof fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace(relayOrigin, local), init), { preconnect: fetch.preconnect });
 return { hits, local, routed };
}

async function seal(plaintext: Uint8Array, id: string, key: Uint8Array): Promise<Uint8Array> {
 const nonce = crypto.getRandomValues(new Uint8Array(12));
 const aes = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
 const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(id) }, aes, plaintext));
 return new Uint8Array([...nonce, ...sealed]);
}

function invitePayload(relay: string, change?: (fields: Record<string, unknown>) => void): Uint8Array {
 const encoded = (size: number) => b64url(new Uint8Array(size).fill(9));
 const fields: Record<string, unknown> = { v: 1, relay, host_id: encoded(16), host_pub: encoded(32), invite_id: encoded(16), secret: encoded(32), machine_label: "Mac", owner_name: "Owner", agent_name: "Agent", guest_name: "guest-1", expires_unix: now / 1000 + 60 };
 change?.(fields);
 return new TextEncoder().encode(JSON.stringify(fields));
}

const blobResponse = (blob: Uint8Array) => () => new Response(blob, { headers: { "Content-Type": "application/octet-stream" } });

test("a short link fetches only the id from its own relay (short_invite_test.go:200-223)", async () => {
 const blob = await seal(invitePayload(relayOrigin), testID, testKey);
 const relay = serve(blobResponse(blob));
 const invite = await resolveInvite("Join my agent: " + shortLinkOn(relayOrigin) + " thanks!", { now, fetchSealed: httpSealedInviteFetch(relay.routed) });
 expect([invite.endpoint.relay, invite.guestName, invite.agentName]).toEqual([relayOrigin, "guest-1", "Agent"]);
 expect(relay.hits.length).toBe(1);
 const hit = relay.hits[0]!;
 expect([hit.method, new URL(hit.url).pathname, new URL(hit.url).search]).toEqual(["GET", "/v1/invite/" + testID, ""]);
 expect(hit.url + JSON.stringify(hit.headers)).not.toContain(b64url(testKey));
 expect(hit.headers.cookie).toBeUndefined();
});

test("a short link opens only on the relay it names (short_invite_test.go:225-248)", async () => {
 let blob = new Uint8Array(0);
 const relay = serve(() => new Response(blob));
 const fetchSealed = httpSealedInviteFetch(relay.routed);
 for (const [name, payload] of Object.entries({
  "another relay": invitePayload("https://guest.herdrup.themartian.app"),
  "another relay path": invitePayload(relayOrigin + "/base"),
  "another port": invitePayload(relayOrigin + ":8443"),
  "damaged v1 field": invitePayload(relayOrigin, (f) => { f.secret = "short"; }),
  "not json": new TextEncoder().encode("not an invite"),
  "needs a newer app": invitePayload(relayOrigin, (f) => { f.v = 2; }),
 })) {
  blob = await seal(payload, testID, testKey);
  expect([name, await kindOf(resolveInvite(shortLinkOn(relayOrigin), { now, fetchSealed }))]).not.toEqual([name, "accepted"]);
 }
 blob = await seal(invitePayload(relayOrigin, (f) => { f.expires_unix = now / 1000; }), testID, testKey);
 expect(await kindOf(resolveInvite(shortLinkOn(relayOrigin), { now, fetchSealed }))).toBe("expired");
 blob = await seal(invitePayload(relayOrigin), "k7Qp2xRmA1bD", testKey);
 expect(await kindOf(resolveInvite(shortLinkOn(relayOrigin), { now, fetchSealed }))).toBe("not_invite");
});

test("short link fetch failures (short_invite_test.go:250-280)", async () => {
 let status = 404;
 const relay = serve(() => new Response(status === 404 ? "not found" : null, { status }));
 const fetchSealed = httpSealedInviteFetch(relay.routed);
 const revoked = await resolveInvite(shortLinkOn(relayOrigin), { now, fetchSealed }).catch((error: GuestError) => error);
 expect(revoked instanceof GuestError && [revoked.kind, revoked.message]).toEqual(["invite_revoked", "This invite has expired or was revoked."]);
 for (status of [500, 429, 204]) {
  expect([status, await kindOf(resolveInvite(shortLinkOn(relayOrigin), { now, fetchSealed }))]).toEqual([status, "invite_unreachable"]);
 }
 const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
 const goneOrigin = `http://127.0.0.1:${gone.port}`;
 gone.stop(true);
 const unrouted: typeof fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace(relayOrigin, goneOrigin), init), { preconnect: fetch.preconnect });
 expect(await kindOf(resolveInvite(shortLinkOn(relayOrigin), { now, fetchSealed: httpSealedInviteFetch(unrouted) }))).toBe("invite_unreachable");
 const cancelled = new AbortController();
 const reason = new Error("review cancelled");
 cancelled.abort(reason);
 expect(await resolveInvite(shortLinkOn(relayOrigin), { now, fetchSealed, signal: cancelled.signal }).catch((error) => error)).toBe(reason);
});

test("every redirect is refused (short_invite_test.go:282-298)", async () => {
 const elsewhere = serve(blobResponse(await seal(invitePayload(relayOrigin), testID, testKey)));
 const relay = serve(() => Response.redirect(elsewhere.local + "/v1/invite/" + testID, 302));
 expect(await kindOf(resolveInvite(shortLinkOn(relayOrigin), { now, fetchSealed: httpSealedInviteFetch(relay.routed) }))).toBe("invite_unreachable");
 expect(elsewhere.hits.length).toBe(0);
});

test("the body is capped while it streams (short_invite_test.go:300-338)", async () => {
 let handle: (request: Request) => Response = () => new Response();
 const relay = serve((request) => handle(request));
 const fetchSealed = httpSealedInviteFetch(relay.routed, 10_000);
 const target = relayOrigin + "/v1/invite/" + testID;
 const exact = new Uint8Array(MAX_SEALED_INVITE).fill(7);
 handle = blobResponse(exact);
 expect(await fetchSealed(target)).toEqual(exact);
 // Bun.serve rewrites a streamed body's framing (and spins on an endless one), so the oversized
 // bodies are written on a raw socket, which then stays open without ending the body.
 const rawRelay = (head: string, body: string) => {
  const raw = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket) { socket.write(head + body); } } });
  servers.push(raw);
  return httpSealedInviteFetch((input, init) => fetch(String(input).replace(relayOrigin, `http://127.0.0.1:${raw.port}`), init), 10_000);
 };
 // Declared over the cap: refused from the head while the body stalls after one byte.
 let started = Date.now();
 expect(await kindOf(rawRelay(`HTTP/1.1 200 OK\r\nContent-Length: ${MAX_SEALED_INVITE + 1}\r\n\r\n`, "\x01")(target))).toBe("not_invite");
 expect(Date.now() - started).toBeLessThan(3_000);
 // Endless (chunked, never terminated): cut off after the cap, not at the deadline.
 started = Date.now();
 expect(await kindOf(rawRelay("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n", `200\r\n${"x".repeat(512)}\r\n`.repeat(16))(target))).toBe("not_invite");
 expect(Date.now() - started).toBeLessThan(5_000);
});

test("the deadline covers the whole exchange (short_invite_test.go:340-370)", async () => {
 let handle: (request: Request) => Response = () => new Response();
 const relay = serve((request) => handle(request));
 const fetchSealed = httpSealedInviteFetch(relay.routed, 300);
 const target = relayOrigin + "/v1/invite/" + testID;
 const silent = () => new Response(new ReadableStream({ start() {} }));
 // Real time on purpose: the deadline under test is the platform's clock and fetch's abort.
 const trickling = () => new Response(new ReadableStream({ async pull(c) { await Bun.sleep(50); c.enqueue(Uint8Array.of(1)); } }));
 for (const [name, h] of Object.entries({ silent, trickling })) {
  handle = h;
  const started = Date.now();
  expect([name, await kindOf(fetchSealed(target))]).toEqual([name, "invite_unreachable"]);
  expect(Date.now() - started).toBeLessThan(3_000);
 }
 expect(SEALED_INVITE_DEADLINE_MS).toBe(15_000);
});
