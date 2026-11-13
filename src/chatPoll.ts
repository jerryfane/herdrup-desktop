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

/** A prompt the reader sent that the transcript does not show yet (TranscriptOutbox.swift),
 *  drawn at the chat's tail the moment it is sent. */
export type OutgoingState = "sending" | "submitted" | "unconfirmed" | "notSeen";
/** `guest` is the sender's guest name, "" for the owner: herdr records a guest's prompt with
 *  author "guest" and that name (normalize.rs user_author), the owner's as "owner". */
/** `files` are the attached files' names and kinds, empty for text alone; shown folded under the
 *  bubble until the transcript's own prompt (with their Gram ids) replaces it
 *  (ChatView.outgoingBubble). */
export interface Outgoing { id: string; text: string; files: { name: string; isImage: boolean }[]; guest: string; state: OutgoingState; until: number }

/** The line under an outgoing bubble (ChatView.outgoingBubble). */
export function outgoingReceipt(state: OutgoingState): string {
 switch (state) {
  case "sending": return "Sending…";
  case "submitted": return "Accepted by agent";
  case "unconfirmed": return "Confirmation pending";
  case "notSeen": return "Not seen in chat · check Terminal";
 }
}

/** TranscriptOutbox.normalized: CRLF as LF, trimmed. */
function normalized(text: string): string {
 return text.replace(/\r\n?/g, "\n").trim();
}

/** Whether `recorded` (normalized) is the prompt an outgoing message became. A send with files
 *  goes out as its caption, a blank line and the files' reference, or the reference alone
 *  (paneAttachmentPrompt, desk_interaction_compose.go): "[… attached via Herdr Gram …]". */
function sentAs(o: Outgoing, recorded: string): boolean {
 const caption = normalized(o.text);
 if (!o.files.length) return caption === recorded;
 // The caption goes out untrimmed (only the whole prompt is normalized here), so whatever
 // whitespace ended it sits before the blank line and the reference (#138).
 if (caption && !recorded.startsWith(caption)) return false;
 const rest = recorded.slice(caption.length);
 const reference = rest.trimStart();
 return (!caption || (rest !== reference && rest.includes("\n\n"))) && reference.startsWith("[") && reference.includes(" attached via Herdr Gram");
}

/** After a transcript read (TranscriptOutbox.reconcile): a new user entry in the live tail
 *  removes the oldest outgoing prompt with the same author and the text it was sent as.
 *  Another person's prompt, or another prompt of the same author, removes nothing. One still
 *  unseen after its minute reads "Not seen in chat" (TranscriptOutbox.unseenAfter). */
export function reconcileOutgoing(outgoing: readonly Outgoing[], held: ReadonlySet<string>, page: readonly Entry[], now: number): Outgoing[] {
 const left = [...outgoing];
 for (const entry of page) {
  if (entry.kind !== "user" || held.has(entry.id)) continue;
  const guest = entry.author === "guest" ? (typeof entry.author_name === "string" ? entry.author_name : "") : "";
  const author = entry.author === "guest" ? `guest:${guest}` : "owner";
  const text = normalized(entry.text ?? "");
  const index = left.findIndex(o => (o.guest ? `guest:${o.guest}` : "owner") === author && sentAs(o, text));
  if (index >= 0) left.splice(index, 1);
 }
 return left.map(o => o.state !== "sending" && o.state !== "notSeen" && now >= o.until ? { ...o, state: "notSeen" } : o);
}
