// placeInitials (faces.ts) on a tile not in the document: it is skipped before its style is read,
// so no font load is asked for it. Bun has no DOM: a stand-in document, style and tile for this.
import { afterAll, expect, test } from "bun:test";

const loads: string[] = [];
const styled: unknown[] = [];
const kept = { document: Reflect.get(globalThis, "document"), getComputedStyle: Reflect.get(globalThis, "getComputedStyle"), devicePixelRatio: Reflect.get(globalThis, "devicePixelRatio") };
Reflect.set(globalThis, "devicePixelRatio", 1);
Reflect.set(globalThis, "document", {
 createElement: () => ({ getContext: () => ({ font: "", measureText: () => ({ width: 0 }) }) }),
 fonts: { load: async (font: string) => { loads.push(font); return []; } },
});
Reflect.set(globalThis, "getComputedStyle", (element: unknown) => {
 styled.push(element);
 return { fontWeight: "600", fontSize: "13px", fontFamily: "Inter" };
});
afterAll(() => {
 for (const [name, value] of Object.entries(kept)) {
  if (value === undefined) Reflect.deleteProperty(globalThis, name);
  else Reflect.set(globalThis, name, value);
 }
});

/** A tile whose letter is in the document or not. */
function tile(connected: boolean) {
 const glyph = { isConnected: connected, textContent: "A", style: { left: "" } };
 return { glyph, tile: { querySelector: () => glyph, getBoundingClientRect: () => ({ width: 24 }) } };
}

test("a tile not in the document is skipped before its style is read; one in it is placed", async () => {
 const { placeInitials } = await import("../src/faces");
 const detached = tile(false), attached = tile(true);
 const root = { querySelectorAll: () => [detached.tile, attached.tile] };
 await placeInitials(root as unknown as ParentNode);
 expect([styled, loads, detached.glyph.style.left, attached.glyph.style.left]).toEqual([[attached.glyph], ["600 13px Inter"], "", "12px"]);
});
