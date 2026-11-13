import { beforeEach, expect, test } from "bun:test";
import { CHAT_MEMORY_AGENTS, CHAT_MEMORY_MAX_ENTRIES, forgetChats, recallChat, rememberChat } from "../src/chatMemory";
import type { Entry, TranscriptPage } from "../src/interactionModel";

// Slow-network fix 4 on Desktop: an agent opened again draws its chat at once from memory (never
// disk); memory holds the most recently opened agents only and ends with the connection.
const page = (after: string): TranscriptPage => ({ after, session_id: "s", entries: [] });
const entries = (n: number): Entry[] => Array.from({ length: n }, (_, i) => ({ kind: "user", id: `u${i}`, ts_ms: i, text: "x" }) as Entry);

beforeEach(forgetChats);

test("the least recently opened agent goes first, and opening one keeps it", () => {
 for (let i = 0; i < CHAT_MEMORY_AGENTS; i++) rememberChat(`a${i}`, { page: page(`${i}`), entries: entries(1), oldestCursor: undefined });
 expect(recallChat("a0")?.page.after).toBe("0"); // a0 is now the most recently used
 rememberChat("new", { page: page("n"), entries: entries(1), oldestCursor: undefined });
 expect(recallChat("a1")).toBeUndefined();
 expect(recallChat("a0")).toBeDefined();
 expect(recallChat("new")).toBeDefined();
});

test("a chat with too many entries is not kept, and a connection ending forgets all", () => {
 rememberChat("big", { page: page("1"), entries: entries(CHAT_MEMORY_MAX_ENTRIES + 1), oldestCursor: "c" });
 expect(recallChat("big")).toBeUndefined();
 rememberChat("small", { page: page("1"), entries: entries(3), oldestCursor: "c" });
 expect(recallChat("small")?.oldestCursor).toBe("c");
 forgetChats();
 expect(recallChat("small")).toBeUndefined();
});
