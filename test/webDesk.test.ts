// The browser guest Desk's own logic, each against the Go it ports: the start from the page's
// fragment (web/start.ts), the grant it keeps, the availability and receipts runGuest and
// submitPanePrompt publish, and pane.stream frames as TerminalChanged carries them.
import { expect, test } from "bun:test";
import { GuestError, HerdrAPIError, hostOffline, rateLimited, relayRefused, revoked } from "../src/webguest/errors";
import { fingerprint, goTime, guestAvailability, guestList, paneStreamFrame, pageAccess, promptReceipt, PROMPT_WAIT, rateLimitedMessage, sharedListing } from "../src/web/desk";
import { inviteText, start, takeFragment, welcome } from "../src/web/start";
import type { Access } from "../src/mygo";

const access = (guestID: string): Access => ({
 guestID, guestName: "ada", machineLabel: "burj", ownerName: "Jerry", agentName: "docs", agentTarget: "t1",
 endpoint: { relay: "https://guest.herdrup.app", hostID: "HOST", hostPublicKey: "" }, acceptedAt: "2026-11-03T00:00:00Z",
});

test("the fragment leaves the address bar before it is read, query kept", () => {
 const calls: string[] = [];
 const payload = takeFragment({ hash: "#eyJ2IjoxfQ%3D%3D", pathname: "/web/", search: "?x=1" }, { state: null, replaceState: (_s, _t, url) => { calls.push(String(url)); } });
 expect(calls).toEqual(["/web/?x=1"]);
 expect(payload).toBe("eyJ2IjoxfQ==");
 expect(takeFragment({ hash: "", pathname: "/web/", search: "" }, { state: null, replaceState: () => { throw new Error("no fragment, no rewrite"); } })).toBe("");
});

test("a payload names its invite: the long v1 form, a short link on this relay, or a whole link", () => {
 expect(inviteText("eyJ2IjoxfQ", "https://guest.herdrup.app")).toBe("herdrup://guest-invite#eyJ2IjoxfQ");
 const short = "A".repeat(12) + "B".repeat(22);
 expect(inviteText(short, "https://guest.herdrup.app")).toBe(`https://guest.herdrup.app/i/${short}`);
 expect(inviteText("https://guest.herdrup.app/i#abc", "https://x")).toBe("https://guest.herdrup.app/i#abc");
});

function fakeDesk(kept: Access[], accept: (text: string) => Promise<Access>) {
 const log: string[] = [];
 return {
  log,
  desk: {
   sharedConnections: async () => kept,
   acceptGuestInvitation: async (text: string) => { log.push("accept " + text); return accept(text); },
   connectGuest: async (id: string) => { log.push("connect " + id); },
  },
 };
}

test("first visit redeems and connects; a later visit resumes; nothing kept says whom to ask", async () => {
 const first = fakeDesk([], async () => access("G1"));
 expect(await start(first.desk, "PAYLOAD", "https://guest.herdrup.app", () => null)).toEqual({ kind: "connected", id: "HOST/G1" });
 expect(first.log).toEqual(["accept herdrup://guest-invite#PAYLOAD", "connect HOST/G1"]);

 const later = fakeDesk([access("G1")], async () => { throw new Error("unreachable"); });
 expect(await start(later.desk, "", "https://guest.herdrup.app", () => null)).toEqual({ kind: "connected", id: "HOST/G1" });
 expect(later.log).toEqual(["connect HOST/G1"]);

 const none = fakeDesk([], async () => access("G1"));
 expect(await start(none.desk, "", "https://x", () => null)).toEqual({ kind: "welcome", welcome: welcome(null) });
 expect(welcome(null).title).toBe("Open the invite link the owner sent you");
 expect(await start(none.desk, "", "https://x", () => "Jerry")).toEqual({ kind: "welcome", welcome: welcome("Jerry") });
 expect(welcome("Jerry").title).toBe("Ask Jerry for a new invite");
 expect(none.log).toEqual([]);
});

test("a link opened again resumes the kept grant; a failed first redemption says why", async () => {
 const used = new GuestError("other", "This invitation was already used. Ask the owner for a new one.");
 const again = fakeDesk([access("G1")], async () => { throw used; });
 expect(await start(again.desk, "PAYLOAD", "https://x", () => "Jerry")).toEqual({ kind: "connected", id: "HOST/G1" });
 const fresh = fakeDesk([], async () => { throw used; });
 expect(await start(fresh.desk, "PAYLOAD", "https://x", () => null)).toEqual({ kind: "welcome", welcome: welcome(null, used.message) });
});

test("availability reads the transport's errors as desk_guest.go guestAvailability does", () => {
 expect(guestAvailability(revoked())).toBe("lost");
 expect(guestAvailability(hostOffline())).toBe("offline");
 expect(guestAvailability(rateLimited())).toBe("reconnecting");
 expect(guestAvailability(relayRefused())).toBe("reconnecting");
 expect(guestAvailability(new HerdrAPIError("guest_paused", "paused", {}))).toBe("");
 expect(guestAvailability(new Error("x"))).toBe("");
 // runGuest rounds the wait up to whole seconds.
 expect(rateLimitedMessage(14_001)).toBe("The relay is receiving too many connections from this network. Trying again in 15 s.");
});

test("the shared agent is listed by terminal or pane id, paused when missing or guest_running is false", () => {
 const list = guestList({ type: "agent_list", agents: [{ pane_id: "p0", terminal_id: "other" }, { pane_id: "p1", terminal_id: "t1", guest_running: false }, { pane_id: "t2" }] });
 expect(list.running).toEqual([true, false, true]);
 expect(sharedListing(list, "t1")).toEqual({ agents: [list.agents[1]!], availability: "paused" });
 expect(sharedListing(list, "t2")).toEqual({ agents: [list.agents[2]!], availability: "" });
 expect(sharedListing(list, "gone")).toEqual({ agents: [], availability: "paused" });
});

test("a prompt waits as the native submitPrompt does, and its receipt is Go's", () => {
 expect(PROMPT_WAIT).toEqual({ timeout_ms: 6000, until: ["working", "idle", "blocked", "done", "unknown"] });
 expect(promptReceipt({ delivery: "submitted" }, null)).toBe(`{"delivery":"submitted"}`);
 expect(promptReceipt({}, null)).toBe(`{"delivery":"submitted"}`);
 expect(promptReceipt({ delivery: "written_to_pty" }, null)).toBe(`{"delivery":"written_to_pty","note":"Sent to terminal; agent submission not verified"}`);
 // A timeout or a lost reply could duplicate a resend: the draft is consumed, unconfirmed.
 expect(JSON.parse(promptReceipt(null, new HerdrAPIError("agent_prompt_stalled", "", {}))).delivery).toBe("unconfirmed");
 expect(JSON.parse(promptReceipt(null, rateLimited())).delivery).toBe("unconfirmed");
 expect(() => promptReceipt(null, new HerdrAPIError("guest_paused", "the agent is paused", {}))).toThrow("herdr: guest_paused: the agent is paused");
});

test("pane.stream lines become TerminalChanged frames, omitting what Go omits; an error line ends it", () => {
 expect(paneStreamFrame({ stream: "pane.bytes", frame: "reset", seq: 10, epoch: 2, cols: 80, rows: 24, data_b64: "aGk=", history_b64: "", history_cursor: "c1", lagged: false, extra: 1 }))
  .toEqual({ stream: "pane.bytes", frame: "reset", seq: 10, epoch: 2, cols: 80, rows: 24, data_b64: "aGk=", history_b64: "", history_cursor: "c1" });
 expect(paneStreamFrame({ stream: "pane.bytes", frame: "data", seq: 12, epoch: 2, data_b64: "eA==", lagged: true })).toEqual({ stream: "pane.bytes", frame: "data", seq: 12, epoch: 2, data_b64: "eA==", lagged: true });
 expect(() => paneStreamFrame({ error: { code: "guest_paused", message: "paused" } })).toThrow("pane.stream ended: herdr: guest_paused: paused");
 expect(() => paneStreamFrame({ stream: "other" })).toThrow(`pane.stream: pane.stream line has stream "other", want "pane.bytes"`);
});

test("the grant reads as Go's JSON Access; the device key's fingerprint is identity.go's", () => {
 const page = pageAccess({ guestID: "G", guestName: "ada", machineLabel: "m", ownerName: "o", agentName: "a", agentTarget: "t", endpoint: { relay: "https://r", hostID: "H", hostPublicKey: new Uint8Array([0xfb, 0xff]) }, acceptedAt: new Date(Date.UTC(2026, 10, 3, 1, 2, 3, 500)) });
 expect(page.endpoint.hostPublicKey).toBe("+/8=");
 expect(page.acceptedAt).toBe("2026-11-03T01:02:03.5Z");
 expect(goTime(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01-01T00:00:00Z");
 // sha256 of 32 zero bytes is 66687aadf862bd77…
 expect(fingerprint(new Uint8Array(32))).toBe("SHA256:6668·7aad·f862·bd77");
});
