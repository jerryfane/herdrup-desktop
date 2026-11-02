import { expect, test } from "bun:test";
import { CHAT_POLL_FAST_MS, CHAT_POLL_IDLE_MS, CHAT_POLL_OWNER_MS, CHAT_SEND_FOLLOW_MS, chatPollDelay, isRelayRateLimited } from "../src/chatPoll";

/** Chat reads in a simulated minute after the page's first, each scheduled by chatPollDelay. */
function readsInAMinute(guest: boolean, working: (now: number) => boolean, followUntil = 0, sentUsers = 0, shownUsers = (_now: number) => 0) {
 let reads = 0;
 for (let now = 0; ;) {
  const pending = followUntil > 0 && shownUsers(now) <= sentUsers;
  now += chatPollDelay({ guest, working: working(now), sendPending: pending, followUntil, now });
  if (now > 60_000) return reads;
  reads++;
 }
}

// herdrup ChatModel.waitForPoll (ca284ac App/ChatView.swift:207-213): 3 s while a send waits to
// show or omp works, 30 s otherwise.
test("a guest's chat polls as herdrup's: 3 s while working or a send is pending, else 30 s", () => {
 const at = { guest: true, working: false, sendPending: false, followUntil: 0, now: 0 };
 expect(chatPollDelay(at)).toBe(CHAT_POLL_IDLE_MS);
 expect(CHAT_POLL_IDLE_MS).toBe(30_000);
 expect(chatPollDelay({ ...at, working: true })).toBe(CHAT_POLL_FAST_MS);
 expect(CHAT_POLL_FAST_MS).toBe(3_000);
 expect(chatPollDelay({ ...at, sendPending: true, followUntil: CHAT_SEND_FOLLOW_MS })).toBe(CHAT_POLL_FAST_MS);
 // A send unseen past TranscriptOutbox.unseenAfter (60 s) plus one poll no longer keeps it fast.
 expect(CHAT_SEND_FOLLOW_MS).toBe(63_000);
 expect(chatPollDelay({ ...at, sendPending: true, followUntil: CHAT_SEND_FOLLOW_MS, now: CHAT_SEND_FOLLOW_MS })).toBe(CHAT_POLL_IDLE_MS);
});

// The relay allows a network 30 guest connects a minute, and every read is one; Go's status poll
// takes 4 more (desk_guest.go guestStatusPoll). Before: a read every 1.5 s, 40 a minute.
test("a guest whose agent is idle reads its chat twice a minute", () => {
 expect(readsInAMinute(true, () => false)).toBe(2);
 expect(readsInAMinute(true, () => true)).toBe(20);
 expect(readsInAMinute(true, () => true) + 4).toBeLessThan(30);
});

test("a guest's send reads fast until the prompt shows, then idles", () => {
 // The prompt shows at 6 s and the agent stays idle: reads at 3 and 6 s, then every 30 s.
 expect(readsInAMinute(true, () => false, CHAT_SEND_FOLLOW_MS, 0, now => now >= 6_000 ? 1 : 0)).toBe(3);
});

test("the owner keeps its 1.5 s poll over SSH, which has no connect limit", () => {
 expect(chatPollDelay({ guest: false, working: false, sendPending: false, followUntil: 0, now: 0 })).toBe(CHAT_POLL_OWNER_MS);
});

test("the relay's 429 reads as Go words it", () => {
 expect(isRelayRateLimited("The relay is receiving too many connections. Try again shortly.")).toBe(true);
 expect(isRelayRateLimited("The shared machine is busy. Try again shortly.")).toBe(false);
});
