/** Which transcript rows Chat draws (herdrup ChatView drawWindow, #672). A chat following an
 *  agent for hours kept every row it had merged attached to the page; now it draws a window:
 *  the newest RENDER_WINDOW rows at first, more revealed from the top on request, and, while it
 *  follows the tail, slid back to the newest RENDER_WINDOW once it holds more than
 *  FOLLOWED_WINDOW_CAP. Every loaded row stays in memory and searchable; only drawing is bounded. */

/** Rows drawn at first and revealed per request at the top: a few screens. */
export const RENDER_WINDOW = 40;
/** Following the tail, the drawn window may grow to this many rows before it slides back. */
export const FOLLOWED_WINDOW_CAP = RENDER_WINDOW * 2;

/** A row as the window sees it: a day label draws with the row under it. */
export interface WindowRow { kind: string; id: string }

/** The index of the first drawn row: the window's top row (`from`; null or gone, the newest
 *  RENDER_WINDOW), with the day label over it. */
export function drawnStart(rows: readonly WindowRow[], from: string | null): number {
 const index = from === null ? -1 : rows.findIndex(row => row.id === from);
 if (index < 0) return Math.max(0, rows.length - RENDER_WINDOW);
 return index > 0 && rows[index - 1]!.kind === "day" ? index - 1 : index;
}

/** The window whose top is row `index` (clamped). Its top is never a day label, which comes and
 *  goes as older turns merge above it: the row under the label is the top and draws the label. */
export function windowStarting(rows: readonly WindowRow[], index: number): string | null {
 if (!rows.length) return null;
 let i = Math.min(Math.max(index, 0), rows.length - 1);
 if (rows[i]!.kind === "day" && i + 1 < rows.length) i++;
 return rows[i]!.id;
}

/** New rows arrived: a chat following its tail that draws more than FOLLOWED_WINDOW_CAP rows
 *  slides its top down to the newest RENDER_WINDOW (the rows that go are above the screen). A
 *  reader who scrolled up keeps every drawn row until they come back down. */
export function slidWindow(rows: readonly WindowRow[], from: string | null, following: boolean): string | null {
 if (!following || rows.length - drawnStart(rows, from) <= FOLLOWED_WINDOW_CAP) return from;
 return windowStarting(rows, rows.length - RENDER_WINDOW);
}

/** The window after revealing RENDER_WINDOW more rows above `top` (the row on top before older
 *  rows merged above it, if any): null when `top` is gone. */
export function revealedAbove(rows: readonly WindowRow[], top: string | null): string | null {
 const index = top === null ? -1 : rows.findIndex(row => row.id === top);
 return index < 0 ? null : windowStarting(rows, index - RENDER_WINDOW);
}

/** Whether the pending question shows as its own card: unless its transcript row is drawn (a row
 *  above the window is not on the page, so its card would be missing). */
export function pendingCardShown(rows: readonly WindowRow[], start: number, pendingID: string): boolean {
 return !rows.slice(start).some(row => row.id === pendingID);
}

/** How near the top, in pixels, the reader is "at the top" (ChatView topSentinel: within 40). */
export const TOP_SLOP = 40;
/** The older page's load: idle, in flight ("Loading earlier messages"), or failed (Retry). */
export type OlderLoad = "idle" | "loading" | "failed";

/** What reaching the top of the chat does (herdrup ChatView showOlder/loadOlder): the next
 *  window of rows already loaded ("reveal"), else the next older page ("fetch"), else nothing.
 *  Not while Find holds the chat, and not before the chat landed on its newest rows: rows that
 *  overflow while it still follows the tail put the top on screen only until it lands. A failed
 *  load waits for Retry; `fetches` false (a page that still shows the top) reveals only, and
 *  offers the next page to tap instead ("offer"): a view the rows don't fill never scrolls again,
 *  and a touch has no wheel (herdrup-desktop #239). */
export function topAction(v: {
 scrollTop: number; scrollHeight: number; clientHeight: number; following: boolean; finding: boolean;
 drawnStart: number; olderPage: boolean; load: OlderLoad; fetches: boolean;
}): "none" | "reveal" | "fetch" | "offer" {
 if (v.finding || v.scrollTop > TOP_SLOP) return "none";
 if (v.following && v.scrollHeight - v.clientHeight > TOP_SLOP) return "none";
 if (v.drawnStart > 0) return "reveal";
 if (!v.olderPage || v.load !== "idle") return "none";
 return v.fetches ? "fetch" : "offer";
}
