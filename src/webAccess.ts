// Web owner access, the approving computer's side (WIRE-PLAN §2, D1; mockups
// herdrup-accounts-mockups/web-owner sections 2 and 5): while the app is in front and signed in,
// it looks for browsers asking to reach the owner's machines (no push in v1), and opens
// "Approve a browser?", or, while the user is typing, says so among the window's notices until Review or
// a pause in typing opens it (#464). The user types the code the browser shows, picks machines,
// access and time, and this computer adds a grant on each machine over SSH. The same look finds
// another app device asking to pair (pairApproval.ts). Desktop only: the web guest is the browser
// being approved, never the approver.

import "./webAccess.css";
import { Desk, events } from "./mygo";
import type { WebAccessLength, WebAccessMachine } from "./mygo";
import { errorText } from "./errors";
import { symbolNow } from "./symbol";
import { webGuest } from "./platform";
import { noticeRegion } from "./notices";
import { codeField } from "./codeField";
import { showPairSheet } from "./pairApproval";
import { pairNotice } from "./pairApprovalModel";
import { ACCESS_CHOICES, APPROVAL_POLL_MS, approvalPollDelay, askOffered, canApprove, choiceLabel, codeInput, isApprovalRateLimited, lengthLabel, machinesNote, machinesSummary, nextRequest, resultLines, skipReason,
 timeSummary, wrongCode, type WebAccessRequestView } from "./webAccessModel";

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

/** clock is the For row's and the pair sheet's, and times the pause in typing and the recheck of
 *  what the service offers (tests pass their own). paused reports when the list poll is redundant
 *  (e.g. this computer is waiting on its own pair request, sharing the account's approval budget). */
export function initWebAccess(clock: SheetClock = systemClock, paused: () => boolean = () => false): void {
 if (webGuest) return;
 const closed = new Set<string>();
 // The request whose sheet, or notice, is up: one at a time, of either kind.
 let open: string | null = null;
 // The service's last answer to "which approvals do you offer?" (one /v1/health read for both
 // kinds). A refresh that fails keeps it; with none yet, the look ends and the next asks again.
 let offers: { browsers: boolean; pairs: boolean; at: number } | null = null;
 let timer: ReturnType<typeof setTimeout> | undefined;
 // Consecutive poll failures (reset on a successful list read or sign-in change) and the earliest
 // clock time a visibilitychange may trigger an immediate look while backed off.
 let failures = 0;
 let backoffUntil = 0;
 // When the user last typed anywhere in the window.
 let typedAt = -Infinity;
 const typed = () => { typedAt = clock.now(); };
 document.addEventListener("keydown", typed, true);
 document.addEventListener("input", typed, true);

 const schedule = (ms = APPROVAL_POLL_MS) => { clearTimeout(timer); timer = setTimeout(() => { void look(); }, ms); };
 const machinesNow = (): Promise<WebAccessMachine[]> => Desk.webAccessMachines().catch(() => []);
 // A look in flight: it alone picks a request and puts up its notice or sheet, so the timer's
 // look and one from coming back to the window never put up two for one request.
 let looking = false;
 // One read lists both kinds (GET /v1/approvals?kind=any), so pair requests add no call to the
 // account's approval rate; requests of a kind the service offers open in the service's order.
 async function look(): Promise<void> {
  if (looking) return;
  looking = true;
  let nextDelay = APPROVAL_POLL_MS;
  try {
   if (document.visibilityState !== "visible" || open !== null || paused()) return;
   const state = await Desk.accountState();
   if (!state.signedIn) { offers = null; failures = 0; backoffUntil = 0; return; }
   if (askOffered(offers, clock.now())) {
    try { offers = { ...await Desk.approvalsOffered(), at: clock.now() }; }
    catch (error) { if (!offers) throw error; offers = { ...offers, at: clock.now() }; }
   }
   if (!offers?.browsers && !offers?.pairs) return;
   const requests = await Desk.approvalRequests();
   failures = 0;
   backoffUntil = 0;
   const next = nextRequest(requests, offers, closed);
   if (!next) return;
   let id: string, text: string, sheet: (machines: readonly WebAccessMachine[]) => Promise<void>;
   const done = () => { closed.add(id); open = null; };
   const { pair, browser } = next;
   if (pair) {
    id = pair.id; text = pairNotice(pair);
    sheet = machines => { open = pair.id; return showPairSheet(pair, machines, done, clock); };
   } else if (browser) {
    const lengths = await Desk.webAccessLengths();
    id = browser.id; text = "A browser wants to reach your machines.";
    sheet = machines => showSheet(browser, lengths, machines, done);
   } else return;
   // Typing owns the focus: the notice at once; its sheet asks for the machines when it opens.
   if (takesTyping(document.activeElement)) { notify(id, text, sheet); return; }
   const machines = await machinesNow();
   // Checked again after the last wait, right before the sheet would open: typing may have begun meanwhile.
   if (takesTyping(document.activeElement)) notify(id, text, sheet);
   else await sheet(machines);
  } catch (error) {
   failures = Math.min(failures + 1, 5);
   nextDelay = approvalPollDelay(failures, isApprovalRateLimited(error));
   backoffUntil = clock.now() + nextDelay;
  }
  finally { looking = false; schedule(nextDelay); }
 }
 document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const wait = backoffUntil - clock.now();
  if (wait > 0) { schedule(wait); return; }
  clearTimeout(timer);
  void look();
 });
 events.accountChanged.on(() => { offers = null; failures = 0; backoffUntil = 0; });
 schedule();

 /** A request that came while the user was typing: a modal sheet would take the keys mid-word
  *  (its code field kept four of them, #464), so a line among the window's notices (notices.ts)
  *  says so instead, taking no focus. Review opens the sheet, and so does a pause in typing that
  *  still holds once the sheet is ready to open (#474). On desktop this notice is how a pair
  *  request arrives while the app is open (no OS notification). */
 function notify(id: string, text: string, sheet: (machines: readonly WebAccessMachine[]) => Promise<void>): void {
  open = id;
  const notice = el("div", "web-access-notice"); notice.setAttribute("role", "status");
  const review = el("button", "button-secondary button-compact", "Review"); review.type = "button";
  notice.append(el("span", "web-access-notice-text", text), review);
  noticeRegion().prepend(notice);
  let cancel = () => {};
  const pause = () => clock.now() - typedAt;
  // The notice stays until the sheet opens. Typing may resume while the machines come: then,
  // unless Review asked for the sheet, the notice waits for the next pause.
  let reviewed = false, fetching = false;
  const present = async () => {
   if (fetching) return;
   fetching = true;
   const machines = await machinesNow();
   fetching = false;
   if (!reviewed && pause() < TYPING_PAUSE_MS) { wait(TYPING_PAUSE_MS - pause()); return; }
   notice.remove();
   await sheet(machines);
  };
  const show = () => { present().catch(() => { /* as a look's: the next look tries again */ }); };
  review.onclick = () => { reviewed = true; cancel(); show(); };
  // The first look comes a full pause after the notice; a later one a full pause after the last key.
  const wait = (ms: number) => {
   cancel = clock.after(ms, () => {
    if (pause() >= TYPING_PAUSE_MS) show(); else wait(TYPING_PAUSE_MS - pause());
   });
  };
  wait(TYPING_PAUSE_MS);
 }

 /** Synchronous up to showModal: nothing can take the keys between the caller's check and it. */
 async function showSheet(req: WebAccessRequestView, lengths: readonly WebAccessLength[], machines: readonly WebAccessMachine[], done: () => void): Promise<void> {
  open = req.id;
  const dialog = el("dialog", "folder-naming web-access");
  dialog.setAttribute("aria-label", "Approve a browser");
  const title = el("h2", "", "Approve a browser?");
  const lead = el("p", "web-access-lead", `${req.browserName} wants to reach your machines.`);
  const status = el("p", "web-access-status", "Waiting for the browser to show its code…");
  const { field: codeLabel, input: code, slots, close: closeCode } = codeField("Enter the code shown in the browser", "Code shown in the browser");

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
  dialog.addEventListener("close", () => { off(); choices.stop(); closeCode(); dialog.remove(); done(); }, { once: true });
  document.body.append(dialog);
  update();
  dialog.showModal();
  try { await Desk.webAccessStart(req.id); }
  catch (error) { end(); status.textContent = errorText(error); }
 }
}
