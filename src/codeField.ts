// The 4-digit code field an approving computer types another device's code into: "Approve a browser?"
// (webAccess.ts) and "Pair ‹device›?" (pairApproval.ts). Four boxes drawn under one input, which takes
// the typing (webAccess.css .web-access-codebox).

import { CodePress, codeSlots, slotSelection } from "./webAccessModel";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
 const n = document.createElement(tag);
 if (cls) n.className = cls;
 if (text !== undefined) n.textContent = text;
 return n;
}

/** The code first (proposal D): four boxes drawn under the one input, which takes the typing; the
 *  boxes draw its digits, each centred in its own box whatever the font's metrics, and show the
 *  caret and selection (webAccess.css), and a click on a box takes that box's digit. caption, when
 *  given, is written over the boxes; label names the input. The input starts disabled. slots()
 *  repaints the boxes (after the value changes); close() stops following presses. */
export function codeField(caption: string, label: string) {
 const code = el("input", "web-access-code"); code.inputMode = "numeric"; code.autocomplete = "one-time-code";
 code.maxLength = 4; code.disabled = true; code.setAttribute("aria-label", label);
 const boxes = el("span", "web-access-boxes"); boxes.setAttribute("aria-hidden", "true");
 const digits = [0, 1, 2, 3].map(() => boxes.appendChild(el("span", "web-access-box")));
 const codeBox = el("span", "web-access-codebox"); codeBox.append(boxes, code);
 const field = el("label", "web-access-field");
 if (caption) field.append(el("span", "", caption));
 field.append(codeBox);
 const slots = () => {
  const n = code.value.length;
  codeSlots(n, code.selectionStart ?? n, code.selectionEnd ?? n).forEach((s, i) => {
   const d = digits[i]!;
   d.textContent = code.value[i] ?? "";
   d.classList.toggle("filled", s.filled); d.classList.toggle("selected", s.selected); d.classList.toggle("active", s.active);
  });
 };
 // A plain click on a box takes its digit; a drag (even one that came back to its start), a
 // double click or a shift-click keeps the selection the field made (followPresses). The second
 // press of a double click lands on the digit the first one took, which would start dragging that
 // selection, so it's dropped first and the press selects the code as in any field.
 const presses = followPresses(code);
 code.addEventListener("mousedown", event => {
  if (event.detail > 1) code.setSelectionRange(code.selectionStart, code.selectionStart);
 });
 code.addEventListener("click", event => {
  if (presses.plainClick(event)) {
   const slot = digits.findIndex(d => event.clientX < d.getBoundingClientRect().right);
   code.setSelectionRange(...slotSelection(slot < 0 ? 3 : slot, code.value.length));
  }
  slots();
 });
 // Typing renders through oninput (the sheet's), after the value is cleaned; these follow the caret.
 for (const type of ["keyup", "select", "focus"]) code.addEventListener(type, slots);
 return { field, input: code, slots, close: () => presses.close() };
}

/** Follows one primary-pointer press on input, the code field. Its pointerdown starts the press and
 *  captures that pointer on input, so the pointer's moves, release and cancel all come to input,
 *  even off the window. The pointer that pressed keeps the press through its release and its
 *  click: only its moves count, its release stops following, and its cancel, or a close, forgets
 *  the press, which then isn't a click. Another pointer, even another device's primary one, can't
 *  take the press over or end it, and its click isn't this press's. If the capture is lost before
 *  the release, or input's window loses focus, the press is over. close() lets go of a pointer the
 *  field still holds and removes every listener this installed, so a field that stays in the
 *  document holds no pointer and follows no further presses. */
export function followPresses(input: HTMLInputElement) {
 const win = input.ownerDocument.defaultView;
 const listening = new AbortController();
 const { signal } = listening;
 let press: { pointer: number; gesture: CodePress; down: boolean } | null = null;
 const ours = (event: Event): PointerEvent | null => {
  const e = event as PointerEvent;
  return press?.down && e.pointerId === press.pointer ? e : null;
 };
 const follow = (event: Event) => {
  const e = ours(event);
  if (e && press) press.gesture.move(e.clientX, e.clientY);
 };
 const stop = () => input.removeEventListener("pointermove", follow);
 const drop = () => { stop(); press = null; };
 input.addEventListener("pointerdown", event => {
  const e = event as PointerEvent;
  // A press still down belongs to its pointer; the same pointer pressing again means its release
  // never reached the sheet, so that press is over.
  if (!e.isPrimary || e.button !== 0 || (press?.down && press.pointer !== e.pointerId)) return;
  press = { pointer: e.pointerId, gesture: new CodePress(e.clientX, e.clientY), down: true };
  input.addEventListener("pointermove", follow, { signal });
  input.setPointerCapture(e.pointerId);
 }, { signal });
 input.addEventListener("pointerup", event => { if (ours(event) && press) { stop(); press.down = false; } }, { signal });
 input.addEventListener("pointercancel", event => { if (ours(event)) drop(); }, { signal });
 input.addEventListener("lostpointercapture", event => { if (ours(event)) drop(); }, { signal });
 win?.addEventListener("blur", drop, { signal });
 return {
  /** Whether this click ends a plain click on the code; the press is done either way. A click the
   *  browser says came from another pointer (pointerId) leaves the press alone. */
  plainClick(click: { detail: number; shiftKey: boolean; pointerId?: number }): boolean {
   if (!press || (click.pointerId !== undefined && click.pointerId !== press.pointer)) return false;
   const plain = press.gesture.plainClick(click);
   drop();
   return plain;
  },
  close: () => {
   // Only a pointer still down is captured, so releasing it can't fail.
   if (press && input.hasPointerCapture(press.pointer)) input.releasePointerCapture(press.pointer);
   drop();
   listening.abort();
  },
 };
}
