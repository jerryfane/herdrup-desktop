// The chat's poll. A guest's every transcript read is its own relay WebSocket and Noise handshake
// (internal/guest/transport.go), and the relay refuses a network past 30 guest connects a minute,
// so a guest polls as herdrup's ChatModel does (herdrup ca284ac App/ChatView.swift:103-113,
// 196-225): every 3 s while a send waits to show up in the transcript or while omp works, every
// 30 s otherwise. herdrup's owner chat also follows the pane's events (ChatView.swift:227-241);
// the owner here has none and keeps its 1.5 s poll over SSH, which has no connect limit.

import type { Entry } from "./interactionModel";

/** ChatModel.fastPollSeconds: while a send waits to show up, or while omp works. */
export const CHAT_POLL_FAST_MS = 3_000;
/** ChatModel.waitForPoll's slow poll: a backstop while the agent is idle. */
export const CHAT_POLL_IDLE_MS = 30_000;
/** The owner's poll over SSH. */
export const CHAT_POLL_OWNER_MS = 1_500;
/** How long a send keeps the poll fast (ChatModel.followSend): TranscriptOutbox.unseenAfter, the
 *  minute before an unmatched send is demoted, plus the poll that demotes it. */
export const CHAT_SEND_FOLLOW_MS = 60_000 + CHAT_POLL_FAST_MS;

export interface ChatPollState {
 guest: boolean;
 /** The transcript's `working`: omp is on a turn. */
 working: boolean;
 /** A send has not shown up in the transcript yet. */
 sendPending: boolean;
 /** Until when (ms) the last send keeps the poll fast. */
 followUntil: number;
 now: number;
}

/** The wait before the next transcript read (ChatModel.waitForPoll, ChatView.swift:207-213). */
export function chatPollDelay(s: ChatPollState): number {
 if (!s.guest) return CHAT_POLL_OWNER_MS;
 if (s.sendPending && s.now < s.followUntil) return CHAT_POLL_FAST_MS;
 return s.working ? CHAT_POLL_FAST_MS : CHAT_POLL_IDLE_MS;
}

/** What a guest's page says while the relay refuses its connects with 429 rate_limited: Go backs
 *  off and reconnects by itself (relayBackoff, internal/guest/transport.go), so this replaces
 *  "Can't reach" and the chat's offer of the Terminal, which goes through the same relay. */
export const RELAY_RECONNECTING = "Reconnecting…";

/** The relay's 429 as Go words it (guest.ErrRateLimited). */
export function isRelayRateLimited(message: string): boolean {
 return message.includes("The relay is receiving too many connections");
}

/** Whether a transcript read shows a pending send: a user entry in the live tail (`page`, read
 *  after the last cursor) that the page did not hold before the read (`held`). Older history
 *  from "Earlier messages" is held, not new, so it never stands in for the unseen prompt. */
export function sendShown(held: ReadonlySet<string>, page: readonly Entry[]): boolean {
 return page.some(entry => entry.kind === "user" && !held.has(entry.id));
}
