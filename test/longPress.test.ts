// The touch-hold menu (src/longPress.ts, herdrup #675 review): a hold drops the native long-press
// menu and the next click only when a menu took the synthetic contextmenu.
import { expect, jest, test } from "bun:test";
import { enableLongPress } from "../src/longPress";

class FakeMouseEvent extends Event {
 clientX: number; clientY: number; button: number;
 constructor(type: string, init: MouseEventInit = {}) { super(type, init); this.clientX = init.clientX ?? 0; this.clientY = init.clientY ?? 0; this.button = init.button ?? 0; }
}
(globalThis as { MouseEvent?: unknown }).MouseEvent ??= FakeMouseEvent;
(globalThis as { window?: unknown }).window ??= globalThis;

type Fake = { type: string; isTrusted?: boolean; defaultPrevented?: boolean; [k: string]: unknown };
function hold(handles: boolean) {
 // A document stand-in: its capture listeners, called with the events the system would send.
 const listeners = new Map<string, ((e: Fake) => void)[]>();
 const root = { addEventListener: (type: string, f: (e: Fake) => void) => listeners.set(type, [...listeners.get(type) ?? [], f]) };
 const send = (e: Fake) => {
  Object.assign(e, { preventDefault() { e.defaultPrevented = true; }, stopPropagation() {} });
  for (const f of listeners.get(e.type) ?? []) f(e);
  return e;
 };
 const target = Object.assign(new EventTarget(), { isConnected: true });
 if (handles) target.addEventListener("contextmenu", e => e.preventDefault());
 enableLongPress(root as unknown as Document);
 const pointer = (type: string) => send({ type, pointerType: "touch", isPrimary: true, clientX: 5, clientY: 5, target });
 jest.useFakeTimers();
 try { pointer("pointerdown"); jest.advanceTimersByTime(600); } finally { jest.useRealTimers(); }
 pointer("pointerup");
 // What the system sends after the hold: its own (trusted) contextmenu, then the click.
 const native = send({ type: "contextmenu", isTrusted: true });
 const click = send({ type: "click", isTrusted: true });
 return { nativeMenuDropped: !!native.defaultPrevented, clickDropped: !!click.defaultPrevented };
}

test("a hold a menu takes drops the native menu and the click that ends it", () => {
 expect(hold(true)).toEqual({ nativeMenuDropped: true, clickDropped: true });
});

test("a hold nothing takes (a text field) keeps the native menu and the next click", () => {
 expect(hold(false)).toEqual({ nativeMenuDropped: false, clickDropped: false });
});
