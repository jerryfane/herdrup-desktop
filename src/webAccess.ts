// Web owner access, the approving computer's side (WIRE-PLAN §2, D1; mockups
// herdrup-accounts-mockups/web-owner sections 2 and 5): while the app is in front and signed in,
// it looks for browsers asking to reach the owner's machines (no push in v1), and opens
// "Approve a browser?", or, while the user is typing, says so in the sidebar's foot until Review or
// a pause in typing opens it (#464). The user types the code the browser shows, picks machines,
// access and time, and this computer adds a grant on each machine over SSH. Desktop only: the web
// guest is the browser being approved, never the approver.

import "./webAccess.css";
import { Desk, events } from "./mygo";
import type { WebAccessLength, WebAccessMachine } from "./mygo";
import { errorText } from "./errors";
import { symbolNow } from "./symbol";
import { webGuest } from "./platform";
import { ACCESS_CHOICES, askOffered, canApprove, choiceLabel, CodePress, codeInput, codeSlots, lengthLabel, machinesNote, machinesSummary, nextRequest, resultLines, skipReason,
 slotSelection, timeSummary, wrongCode, type WebAccessRequestView } from "./webAccessModel";

/** How often to look for requests while the window is in front: the service allows 30 approval
 *  calls a minute per account, and a request lasts 10 minutes. */
const POLL_MS = 8000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
 const n = document.createElement(tag);
 if (cls) n.className = cls;
 if (text !== undefined) n.textContent = text;
 return n;
}

/** A row of radios as one control; each radio is also added to radios. */
function segmented(name: string, options: readonly (readonly [string, string])[], value: string, onChange: (v: string) => void, radios: HTMLInputElement[]): HTMLElement {
 const box = el("div", "web-access-segmented"); box.setAttribute("role", "radiogroup"); box.setAttribute("aria-label", name);
 for (const [v, label] of options) {
  const id = `web-access-${name}-${v}`;
  const input = el("input"); input.type = "radio"; input.name = `web-access-${name}`; input.value = v; input.id = id; input.checked = v === value;
  input.onchange = () => { if (input.checked) onChange(v); };
  const l = el("label", "", label); l.htmlFor = id;
  box.append(input, l);
  radios.push(input);
 }
 return box;
}

/** The clock the For row reads its end date from, and a way to look again later that returns its
 *  cancel (tests pass their own). */
export interface SheetClock { now(): number; after(ms: number, f: () => void): () => void }
const systemClock: SheetClock = { now: Date.now, after: (ms, f) => { const t = setTimeout(f, ms); return () => clearTimeout(t); } };

/** Machines, Access and For as rows: each says its choice and opens in place to change it. The
 *  terminal warning sits in the Access row outside the part that closes, so it shows whenever
 *  terminal access is chosen. For starts at the longest length. Access, For and the warning follow
 *  their own choices; For's end date is a preview that follows the clock until granted says grants
 *  exist, or stop. freeze holds the Access and For choices (an approval is out with them). The
 *  sheet writes the Machines row's summary (showMachines) and reads choice. */
export function choiceRows(list: HTMLElement, machinesOpen: boolean, lengths: readonly WebAccessLength[], clock = systemClock) {
 const choice = { scope: "terminal", length: lengths.at(-1)?.id ?? "" };
 const rows = el("div", "web-access-rows");
 const row = (key: string, open: boolean, ...nodes: HTMLElement[]) => {
  const head = el("button", "web-access-row-head"); head.type = "button";
  const value = el("span", "web-access-row-value");
  // The app's chevron glyph (as hosts.ts draws its disclosure), turned up while the row is open.
  const chevron = el("span", "web-access-chevron"); chevron.setAttribute("aria-hidden", "true");
  chevron.append(symbolNow("chevron.down", 11, "semibold"));
  head.append(el("span", "web-access-row-key", key), value, chevron);
  const body = el("div", "web-access-row-body"); body.append(...nodes);
  const show = (o: boolean) => { head.setAttribute("aria-expanded", String(o)); body.hidden = !o; };
  head.onclick = () => show(head.getAttribute("aria-expanded") !== "true");
  show(open);
  const r = el("div", "web-access-row"); r.append(head, body); rows.append(r);
  return { row: r, value };
 };
 const machinesRow = row("Machines", machinesOpen, list);
 const radios: HTMLInputElement[] = [];
 const accessRow = row("Access", true, segmented("access", ACCESS_CHOICES, choice.scope, v => { choice.scope = v; paintAccess(); }, radios));
 const terminalNote = el("p", "web-access-warning", "Terminal access is a shell on these machines: it can do anything you can do there.");
 accessRow.row.append(terminalNote);
 const forRow = row("For", false, segmented("time", lengths.map(l => [l.id, lengthLabel(l.seconds)] as const), choice.length, v => { choice.length = v; paintFor(); }, radios));
 function paintAccess(): void {
  accessRow.value.textContent = choiceLabel(ACCESS_CHOICES, choice.scope);
  terminalNote.hidden = choice.scope !== "terminal";
 }
 // Until grants exist, For's end date is a preview that moves with the clock (past midnight it's a
 // day later), so it looks again at each minute's turn. Once they exist For says the length the
 // approval was sent with and the expiries the machines recorded (a retry keeps both), or no date
 // if those aren't known.
 let cancel = () => {};
 let grant: { length: string; ends: readonly number[] } | null = null;
 function paintFor(): void {
  cancel(); cancel = () => {};
  const length = lengths.find(l => l.id === (grant?.length ?? choice.length));
  if (!length) forRow.value.textContent = "";
  else if (grant) forRow.value.textContent = timeSummary(length.seconds, grant.ends);
  else {
   const now = clock.now();
   forRow.value.textContent = timeSummary(length.seconds, [now + length.seconds * 1000]);
   cancel = clock.after(60_000 - now % 60_000, paintFor);
  }
 }
 paintAccess();
 paintFor();
 return {
  rows, choice: choice as Readonly<typeof choice>,
  showMachines: (summary: string) => { machinesRow.value.textContent = summary; },
  freeze: (on: boolean) => { for (const r of radios) r.disabled = on; },
  /** Grants exist, made for length (the ID the approval was sent with), ending at ends (Unix ms). */
  granted: (length: string, ends: readonly number[]) => { grant = { length, ends }; paintFor(); },
  stop: () => cancel(),
 };
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

/** How long typing must pause before a request that came while the user was typing opens its
 *  sheet (#464). */
export const TYPING_PAUSE_MS = 5000;

/** Input types that take no typing: a focused one is not text being written. */
const UNTYPED_INPUTS: Record<string, true> = { button: true, checkbox: true, color: true, file: true, hidden: true, image: true, radio: true, range: true, reset: true, submit: true };

/** Whether node takes typing: a text field, a textarea or editable content. */
export function takesTyping(node: Element | null): boolean {
 if (!node) return false;
 if ((node as HTMLElement).isContentEditable === true) return true;
 const tag = node.tagName.toLowerCase();
 return tag === "textarea" || (tag === "input" && !UNTYPED_INPUTS[(node as HTMLInputElement).type]);
}

/** clock is the For row's, and times the pause in typing (tests pass their own). */
export function initWebAccess(clock: SheetClock = systemClock): void {
 if (webGuest) return;
 const closed = new Set<string>();
 // The request whose sheet, or notice, is up.
 let open: string | null = null;
 // The service's last answer to "do you offer browser approval?"; an error isn't kept.
 let offered: { offered: boolean; at: number } | null = null;
 let timer: ReturnType<typeof setTimeout> | undefined;
 // When the user last typed anywhere in the window.
 let typedAt = -Infinity;
 const typed = () => { typedAt = clock.now(); };
 document.addEventListener("keydown", typed, true);
 document.addEventListener("input", typed, true);

 const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void look(); }, POLL_MS); };
 async function look(): Promise<void> {
  try {
   if (document.visibilityState !== "visible" || open !== null) return;
   const state = await Desk.accountState();
   if (!state.signedIn) { offered = null; return; }
   if (askOffered(offered, Date.now())) offered = { offered: await Desk.webAccessOffered(), at: Date.now() };
   if (!offered?.offered) return;
   const req = nextRequest(await Desk.webAccessRequests() as WebAccessRequestView[], closed);
   if (!req) return;
   const lengths = await Desk.webAccessLengths();
   const done = () => { closed.add(req.id); open = null; };
   if (takesTyping(document.activeElement)) notify(req, lengths, done);
   else await showSheet(req, lengths, done);
  } catch { /* the next look tries again */ }
  finally { schedule(); }
 }
 document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { clearTimeout(timer); void look(); } });
 events.accountChanged.on(() => { offered = null; });
 schedule();

 /** A request that came while the user was typing: a modal sheet would take the keys mid-word
  *  (its code field kept four of them, #464), so a line in the sidebar's foot says so instead,
  *  taking no focus. Review opens the sheet, and so does a pause in typing. */
 function notify(req: WebAccessRequestView, lengths: readonly WebAccessLength[], done: () => void): void {
  open = req.id;
  const notice = el("div", "web-access-notice"); notice.setAttribute("role", "status");
  const review = el("button", "button-secondary button-compact", "Review"); review.type = "button";
  notice.append(el("span", "web-access-notice-text", "A browser wants to reach your machines."), review);
  (document.getElementById("sidebar-foot") ?? document.body).prepend(notice);
  let cancel = () => {};
  const sheet = () => {
   cancel(); notice.remove();
   showSheet(req, lengths, done).catch(() => { /* as a look's: the next look tries again */ });
  };
  review.onclick = sheet;
  // The first look comes a full pause after the notice; a later one a full pause after the last key.
  const wait = (ms: number) => {
   cancel = clock.after(ms, () => {
    const paused = clock.now() - typedAt;
    if (paused >= TYPING_PAUSE_MS) sheet(); else wait(TYPING_PAUSE_MS - paused);
   });
  };
  wait(TYPING_PAUSE_MS);
 }

 async function showSheet(req: WebAccessRequestView, lengths: readonly WebAccessLength[], done: () => void): Promise<void> {
  open = req.id;
  const machines: WebAccessMachine[] = await Desk.webAccessMachines().catch(() => []);
  const dialog = el("dialog", "folder-naming web-access");
  dialog.setAttribute("aria-label", "Approve a browser");
  const title = el("h2", "", "Approve a browser?");
  const lead = el("p", "web-access-lead", `${req.browserName} wants to reach your machines.`);
  const status = el("p", "web-access-status", "Waiting for the browser to show its code…");
  const code = el("input", "web-access-code"); code.inputMode = "numeric"; code.autocomplete = "one-time-code";
  code.maxLength = 4; code.disabled = true; code.setAttribute("aria-label", "Code shown in the browser");
  // The code first (proposal D): four boxes drawn under the one input, which takes the typing and
  // draws its digits in the boxes (webAccess.css), so its caret sits in the box it edits. The
  // boxes show the caret and selection, and a click on a box takes that box's digit.
  const boxes = el("span", "web-access-boxes"); boxes.setAttribute("aria-hidden", "true");
  const digits = [0, 1, 2, 3].map(() => boxes.appendChild(el("span", "web-access-box")));
  const codeBox = el("span", "web-access-codebox"); codeBox.append(boxes, code);
  const codeLabel = el("label", "web-access-field"); codeLabel.append(el("span", "", "Enter the code shown in the browser"), codeBox);
  const slots = () => {
   const n = code.value.length;
   codeSlots(n, code.selectionStart ?? n, code.selectionEnd ?? n).forEach((s, i) => {
    const d = digits[i]!;
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
  for (const type of ["keyup", "select", "focus"]) code.addEventListener(type, slots);

  const ticked = new Set(machines.filter(m => m.available).map(m => m.id));
  const list = el("div", "web-access-machines"); list.setAttribute("role", "group"); list.setAttribute("aria-label", "Machines");
  const machineBoxes: [HTMLInputElement, WebAccessMachine][] = [];
  for (const m of machines) {
   const row = el("label", "web-access-machine");
   const box = el("input"); box.type = "checkbox"; box.checked = ticked.has(m.id); box.disabled = !m.available;
   box.onchange = () => { if (box.checked) ticked.add(m.id); else ticked.delete(m.id); update(); };
   const text = el("span", "web-access-machine-text"); text.append(el("span", "", m.label));
   if (!m.available) text.append(el("span", "web-access-dim", skipReason(m.unavailable ?? "")));
   row.append(box, text); list.append(row);
   machineBoxes.push([box, m]);
  }
  if (!machines.length) list.append(el("p", "web-access-dim", "Add a machine first."));

  const choices = choiceRows(list, ticked.size === 0, lengths);
  // While an approval is out, and after a lost answer until it settles, Machines, Access and For
  // are held. unsettled is the choices of an approval whose answer was lost: Try again resends
  // exactly those (Go resends that report) without checking the code again, the button says so,
  // and For describes them.
  let unsettled: { machines: string[]; scope: string; length: string } | null = null;
  const freeze = (on: boolean) => {
   choices.freeze(on);
   for (const [box, m] of machineBoxes) box.disabled = on || !m.available;
  };

  const problem = el("p", "web-access-problem"); problem.hidden = true;
  const deny = el("button", "button-secondary", "Deny"); deny.type = "button";
  // Shown once a denial failed: this computer won't approve any more, and the request ends on its own.
  const close = el("button", "button-secondary", "Close"); close.type = "button"; close.hidden = true;
  const approve = el("button", "", "Approve"); approve.type = "button";
  const buttons = el("div", "buttons"); buttons.append(close, deny, approve);
  dialog.append(title, lead, codeLabel, status, choices.rows, el("p", "web-access-dim web-access-note", machinesNote(machines)), problem, buttons);

  // busy: a call is in flight (Approve and Deny wait for each other). locked: the choices no longer
  // do anything (approved, too many codes, or a pending answer). finished: the request is over.
  let busy = false, locked = false, finished = false;
  const lock = () => { locked = true; for (const i of dialog.querySelectorAll("input")) i.disabled = true; };
  const end = () => { finished = true; lock(); approve.hidden = true; close.hidden = true; deny.textContent = "Done"; };
  const update = () => {
   deny.disabled = busy;
   approve.disabled = busy || finished || (!unsettled && (locked || !canApprove(code.value, ticked.size) || code.disabled));
   slots();
   choices.showMachines(machinesSummary(machines, ticked));
  };
  const say = (text: string) => { problem.textContent = text; problem.hidden = !text; };
  code.oninput = () => { code.value = codeInput(code.value); say(""); update(); };

  // The code field takes the focus only from the sheet itself (showModal moves it in): never from
  // a field the user is typing in outside it (#464).
  const focusCode = () => { if (dialog.contains(document.activeElement)) code.focus(); };
  const off = events.webAccessUpdate.on(u => {
   if (u.id !== req.id) return;
   if (u.state === "ready") { status.textContent = "The browser shows a code now."; if (!locked) { code.disabled = false; focusCode(); } update(); return; }
   end(); status.textContent = u.problem || "This request ended.";
   update();
  });
  const run = async (f: () => Promise<void>) => {
   busy = true; update();
   try { await f(); } catch (error) { say(errorText(error)); } finally { busy = false; update(); }
  };
  deny.onclick = () => {
   if (finished) { dialog.close(); return; }
   void run(async () => {
    try { await Desk.webAccessDeny(req.id); }
    catch (error) { say(errorText(error)); close.hidden = false; lock(); return; }
    finished = true; dialog.close();
   });
  };
  close.onclick = () => { finished = true; dialog.close(); };
  approve.onclick = () => {
   const again = unsettled;
   const out = again ?? { machines: [...ticked], ...choices.choice };
   if (!again) freeze(true);
   void run(async () => {
    try {
     say("");
     if (!again) {
      const check = await Desk.webAccessCheckCode(req.id, code.value);
      if (!check.ok) {
       say(wrongCode(check));
       code.value = "";
       if (check.left === 0) { lock(); if (check.denied) end(); else close.hidden = false; }
       else focusCode();
       return;
      }
     }
     approve.textContent = "Approving…";
     unsettled = null;
     try {
      const result = await Desk.webAccessApprove(req.id, out.machines, out.scope, out.length);
      const { done: approved, unsure, lines } = resultLines(result);
      say(lines.join(" "));
      if (unsure) unsettled = out;
      // The grants exist now: For says what they were made with, no longer a preview.
      if (approved || unsure) choices.granted(out.length, result.expires ?? []);
      if (unsure) lock();
      if (approved) { end(); status.textContent = "Approved. The browser can open your machines now."; }
     } finally { approve.textContent = unsettled ? "Try again" : "Approve"; }
    } finally { if (!unsettled && !locked) freeze(false); }
   });
  };
  dialog.addEventListener("cancel", event => { if (!finished) event.preventDefault(); });
  dialog.addEventListener("close", () => { off(); choices.stop(); presses.close(); dialog.remove(); done(); }, { once: true });
  document.body.append(dialog);
  update();
  dialog.showModal();
  try { await Desk.webAccessStart(req.id); }
  catch (error) { end(); status.textContent = errorText(error); }
 }
}
