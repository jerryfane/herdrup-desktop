// Touch has no right click: holding a finger still for half a second opens the same menu as
// right-clicking does on the desktop, as a long press does on iPhone (rover, gitmoot 456087:
// RoverOS runs herdrup on a phone). Every right-click menu listens for `contextmenu`, so the
// long press sends that event where the finger is. Only when a menu takes it (cancels the event)
// are the native long-press menu and the click that ends the touch dropped; elsewhere (a text
// field, a form) the hold keeps its native editing menu and the next click (herdrup #675 review).

const HOLD_MS = 500;
const SLOP_PX = 10;

export function enableLongPress(root: Document = document) {
  let timer = 0, startX = 0, startY = 0, target: Element | null = null, fired = false;
  const cancel = () => { clearTimeout(timer); timer = 0; target = null; };
  root.addEventListener("pointerdown", event => {
    fired = false;
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    cancel();
    target = event.target as Element | null; startX = event.clientX; startY = event.clientY;
    timer = window.setTimeout(() => {
      timer = 0;
      if (!target?.isConnected) return;
      // A menu that opens cancels the event; nothing listening leaves the touch to the system.
      fired = !target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: startX, clientY: startY, button: 2 }));
    }, HOLD_MS);
  }, true);
  root.addEventListener("pointermove", event => {
    if (timer && Math.hypot(event.clientX - startX, event.clientY - startY) > SLOP_PX) cancel();
  }, true);
  root.addEventListener("pointerup", () => { if (timer) cancel(); }, true);
  root.addEventListener("pointercancel", cancel, true);
  // A native long-press menu would open a second one over ours.
  root.addEventListener("contextmenu", event => { if (event.isTrusted && fired) event.preventDefault(); }, true);
  root.addEventListener("click", event => { if (fired) { fired = false; event.stopPropagation(); event.preventDefault(); } }, true);
}
