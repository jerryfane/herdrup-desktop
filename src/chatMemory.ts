import type { Entry, TranscriptPage } from "./interactionModel";

/** Each agent's chat as last read, in memory only for the app's lifetime (herdrup slow-network
 *  fix 4, Desktop variant: transcripts are never written to disk, herdr-app 470300). Opening an
 *  agent again draws it at once; the next read asks only for what came after it. */

/** Agents remembered; the least recently opened goes first. */
export const CHAT_MEMORY_AGENTS = 8;
/** A chat with more loaded entries than this is not kept. */
export const CHAT_MEMORY_MAX_ENTRIES = 2_000;

export interface RememberedChat { page: TranscriptPage; entries: Entry[]; oldestCursor: string | undefined }

const chats = new Map<string, RememberedChat>();

/** The chat last read for `key`, now the most recently used; undefined when none. */
export function recallChat(key: string): RememberedChat | undefined {
 const chat = chats.get(key);
 if (chat) { chats.delete(key); chats.set(key, chat); }
 return chat;
}

/** Keeps `chat` for `key` (dropping it when it has too many entries) and the newest agents only. */
export function rememberChat(key: string, chat: RememberedChat) {
 chats.delete(key);
 if (chat.entries.length > CHAT_MEMORY_MAX_ENTRIES) return;
 chats.set(key, chat);
 while (chats.size > CHAT_MEMORY_AGENTS) chats.delete(chats.keys().next().value!);
}

/** Forgets every chat: the connection ended (disconnect, a removed machine, a left share). */
export function forgetChats() { chats.clear(); }
