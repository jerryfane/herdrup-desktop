// desk_prompts.go for the browser guest: the same saved-prompt Desk methods over localStorage. The
// web guest has no account sync, so the list stays in this browser.
import type { SavedPrompt } from "../mygo";
import { emit } from "./events";

export const SAVED_PROMPTS_KEY = "herdrup.guest.savedPrompts";

interface Stored { prompts: SavedPrompt[]; imported?: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** As promptID: the id lowercased, or a new one when it isn't a UUID. */
function promptID(id: string): string {
 const lower = id.trim().toLowerCase();
 return UUID.test(lower) ? lower : crypto.randomUUID();
}

/** `storage` is looked up on each call, not when the module loads: a browser that refuses storage
 *  (a throwing `localStorage` getter) still starts, and the prompt calls reject with its error. */
export function createPromptsDesk(storage: () => Pick<Storage, "getItem" | "setItem"> = () => localStorage) {
 const read = (): Stored => JSON.parse(storage().getItem(SAVED_PROMPTS_KEY) ?? `{"prompts":[]}`) as Stored;
 const write = (stored: Stored) => storage().setItem(SAVED_PROMPTS_KEY, JSON.stringify(stored));
 return {
  async savedPrompts(): Promise<SavedPrompt[]> { return read().prompts; },
  async savePrompt(p: SavedPrompt): Promise<SavedPrompt[]> {
   if (!p.text.trim()) throw new Error("a prompt needs text");
   const stored = read(), saved = { ...p, nickname: p.nickname.trim() };
   const i = p.id ? stored.prompts.findIndex(q => q.id === p.id.toLowerCase()) : -1;
   if (i >= 0) stored.prompts[i] = { ...saved, id: stored.prompts[i]!.id };
   else stored.prompts.push({ ...saved, id: promptID(p.id) });
   write(stored); emit("savedPromptsChanged", stored.prompts);
   return stored.prompts;
  },
  async deletePrompt(id: string): Promise<SavedPrompt[]> {
   const stored = read();
   stored.prompts = stored.prompts.filter(p => p.id !== id.toLowerCase());
   write(stored); emit("savedPromptsChanged", stored.prompts);
   return stored.prompts;
  },
  async importSavedPrompts(list: SavedPrompt[]): Promise<SavedPrompt[]> {
   const stored = read();
   if (stored.imported) return stored.prompts;
   const have = new Set(stored.prompts.map(p => p.id));
   for (const p of list) {
    if (!p.text?.trim()) continue;
    const id = promptID(p.id ?? "");
    if (have.has(id)) continue;
    have.add(id); stored.prompts.push({ id, nickname: (p.nickname ?? "").trim(), text: p.text });
   }
   stored.imported = true; write(stored);
   return stored.prompts;
  },
 };
}
