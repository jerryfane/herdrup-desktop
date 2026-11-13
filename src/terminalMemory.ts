/** Each agent's terminal screen as last seen, as plain text, in memory only for the app's
 *  lifetime (herdrup slow-network fix 4; never on disk, herdr-app 470300). Reopening the terminal
 *  shows it until the stream's first screen arrives. */

/** Screens remembered; the least recently stored goes first. */
export const SCREEN_MEMORY_AGENTS = 8;
/** A screen longer than this is cut to its last part. */
export const SCREEN_MEMORY_MAX_CHARS = 64 * 1024;

const screens = new Map<string, string>();

/** The screen last stored for `key`, or undefined. */
export function recallScreen(key: string): string | undefined { return screens.get(key); }

/** Keeps `text` (trailing blank lines dropped, cut to its last SCREEN_MEMORY_MAX_CHARS) for `key`;
 *  a blank screen forgets it. */
export function rememberScreen(key: string, text: string) {
 screens.delete(key);
 const screen = text.replace(/\s+$/, "").slice(-SCREEN_MEMORY_MAX_CHARS);
 if (!screen) return;
 screens.set(key, screen);
 while (screens.size > SCREEN_MEMORY_AGENTS) screens.delete(screens.keys().next().value!);
}

/** Forgets every screen: the connection ended. */
export function forgetScreens() { screens.clear(); }
