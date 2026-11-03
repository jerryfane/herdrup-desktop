// src/mygo.ts for the browser guest build (vite.web.config.ts aliases ./mygo and ../mygo here):
// the same exports, the types re-exported from the generated client so they never drift. Desk is
// the guest subset (desk.ts, gram.ts); any other method rejects, as there is no Go behind the page.

import type { Desk as GoDesk, Dictation as GoDictation } from "../mygo";
import { browserEnv, createGuestDesk } from "./desk";
import { gramDesk } from "./gram";

export type * from "../mygo";
export { events } from "./events";
export { Symbols } from "./symbols";

type DeskFns = typeof GoDesk;

const notAvailable = () => Promise.reject(new Error("Not available in the browser"));
const implemented: Partial<Record<keyof DeskFns, unknown>> = { ...gramDesk, ...createGuestDesk(browserEnv()) };

/** Every Desk method: the guest's, else one that rejects. Its shape is the generated client's. */
export const Desk = new Proxy(implemented, {
 get: (target, key) => (typeof key === "string" && key in target ? target[key as keyof DeskFns] : notAvailable),
}) as DeskFns;

/** No dictation in the browser (dictation.ts hides the microphone in this build). */
export const Dictation: typeof GoDictation = {
 start: () => Promise.reject(new Error("Dictation isn't available in the browser.")),
 stop: async () => {},
};
