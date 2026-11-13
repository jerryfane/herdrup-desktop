import { beforeEach, expect, test } from "bun:test";
import { forgetScreens, recallScreen, rememberScreen, SCREEN_MEMORY_AGENTS, SCREEN_MEMORY_MAX_CHARS } from "../src/terminalMemory";

// Slow-network fix 4 on Desktop: a terminal reopened shows its last screen as plain text from
// memory (never disk) until the stream's first screen; bounded, and gone with the connection.
beforeEach(forgetScreens);

test("a screen is kept trimmed, cut to its newest part, and a blank one forgets it", () => {
 rememberScreen("a", "$ ls\nfile\n\n   \n");
 expect(recallScreen("a")).toBe("$ ls\nfile");
 rememberScreen("a", "x".repeat(SCREEN_MEMORY_MAX_CHARS) + "TAIL");
 expect(recallScreen("a")!.endsWith("TAIL")).toBe(true);
 expect(recallScreen("a")!.length).toBe(SCREEN_MEMORY_MAX_CHARS);
 rememberScreen("a", "\n  \n");
 expect(recallScreen("a")).toBeUndefined();
});

test("only the most recently stored screens are kept, and a connection ending forgets all", () => {
 for (let i = 0; i <= SCREEN_MEMORY_AGENTS; i++) rememberScreen(`t${i}`, `screen ${i}`);
 expect(recallScreen("t0")).toBeUndefined();
 expect(recallScreen(`t${SCREEN_MEMORY_AGENTS}`)).toBe(`screen ${SCREEN_MEMORY_AGENTS}`);
 forgetScreens();
 expect(recallScreen(`t${SCREEN_MEMORY_AGENTS}`)).toBeUndefined();
});
