// Owner request 2026-11-01 (herdr-app 383362, 383484): after the owner has sent five
// prompts to agents, ask once for a GitHub star. Only a confirmed owner agent prompt
// counts (as native): never Gram posts, guest sends, failed or unconfirmed sends, or raw
// terminal keystrokes. Either answer hides the ask for good. Reference and smoke
// captures never show it unless herdrupStarPrompt is set.

export const STAR_URL = "https://github.com/themartianapp/herdrup";
export const STAR_AFTER_SENDS = 5;
const SENT = "starPrompt.sentPrompts";
const DISMISSED = "starPrompt.dismissed";

type Store = Pick<Storage, "getItem" | "setItem">;
type Flags = { herdrupHoldsStill?: boolean; herdrupStarPrompt?: boolean; __herdrupSmokeErrors?: unknown };

const listeners = new Set<() => void>();

/** The page's storage, or null where reaching it throws (a SecurityError, or no
 *  localStorage at all). Acquired inside the guard: a default `= localStorage`
 *  would throw before any try (issue #80). */
function local(): Store | null {
  try { return localStorage; } catch { return null; }
}

export function sentPrompts(store: Store | null = local()): number {
  try {
    const value = Number(store?.getItem(SENT));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch { return 0; }
}

/** One successful owner send. The count stops at the threshold: past it, only
 *  the dismissal matters. Never throws: it runs after a delivered prompt, and a
 *  failure here must not reach the send's failure path (issue #80). */
export function recordOwnerSend(store: Store | null = local()) {
  try {
    if (!store) return;
    const sent = sentPrompts(store);
    if (sent >= STAR_AFTER_SENDS) return;
    store.setItem(SENT, String(sent + 1));
    if (sent + 1 === STAR_AFTER_SENDS) for (const listener of listeners) listener();
  } catch (error) { console.warn("star prompt count not saved", error); }
}

export function starPromptDismissed(store: Store | null = local()): boolean {
  try { return store?.getItem(DISMISSED) === "1"; } catch { return false; }
}

/** "Star on GitHub" and "Not now" both end the ask. Persist first: a failed save
 *  must not make the UI promise it will stay away. */
export function dismissStarPrompt(store: Store | null = local()) {
  if (!store) throw new Error("no storage for the star ask");
  store.setItem(DISMISSED, "1");
  for (const listener of listeners) listener();
}

/** Screenshot (herdrupHoldsStill) and smoke runs hide the ask; herdrupStarPrompt is
 *  the explicit test flag that shows it there. */
export function capturesHideStarPrompt(flags: Flags = globalThis as Flags): boolean {
  if (flags.herdrupStarPrompt === true) return false;
  return flags.herdrupHoldsStill === true || "__herdrupSmokeErrors" in flags;
}

/** Without storage the ask never shows: it could not remember an answer. */
export function showsStarPrompt(guest: boolean, store: Store | null = local(), flags: Flags = globalThis as Flags): boolean {
  return !guest && !!store && !capturesHideStarPrompt(flags) && !starPromptDismissed(store) && sentPrompts(store) >= STAR_AFTER_SENDS;
}

export function onStarPromptChanged(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
