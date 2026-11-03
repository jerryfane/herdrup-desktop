/** The browser guest build (vite.web.config.ts's mode): no Go behind the page, Symbols draws the
 *  open stand-ins and there is no dictation. */
export const webGuest = import.meta.env.MODE === "guest-web";

/** Whether Symbols draws the real SF Symbols: the app on macOS (symbols_darwin.go). */
export function appleSymbols(): boolean {
 return !webGuest && navigator.platform.startsWith("Mac");
}
