// Web owner access, the approving computer's side (WIRE-PLAN §2, D1; mockups
// herdrup-accounts-mockups/web-owner sections 2 and 5): while the app is in front and signed in,
// it looks for browsers asking to reach the owner's machines (no push in v1), and opens
// "Approve a browser?". The user types the code the browser shows, picks machines, access and
// time, and this computer adds a grant on each machine over SSH. Desktop only: the web guest is
// the browser being approved, never the approver.

import "./webAccess.css";
import { Desk, events } from "./mygo";
import type { WebAccessLength, WebAccessMachine } from "./mygo";
import { errorText } from "./errors";
import { symbolNow } from "./symbol";
import { webGuest } from "./platform";
import { ACCESS_CHOICES, askOffered, canApprove, choiceLabel, codeInput, codeSlots, lengthLabel, machinesNote, machinesSummary, nextRequest, plainClick, resultLines, skipReason,
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

function segmented(name: string, options: readonly (readonly [string, string])[], value: string, onChange: (v: string) => void): HTMLElement {
 const box = el("div", "web-access-segmented"); box.setAttribute("role", "radiogroup"); box.setAttribute("aria-label", name);
 for (const [v, label] of options) {
  const id = `web-access-${name}-${v}`;
  const input = el("input"); input.type = "radio"; input.name = `web-access-${name}`; input.value = v; input.id = id; input.checked = v === value;
  input.onchange = () => { if (input.checked) onChange(v); };
  const l = el("label", "", label); l.htmlFor = id;
  box.append(input, l);
 }
 return box;
}

/** Machines, Access and For as rows: each says its choice and opens in place to change it. The
 *  terminal warning sits in the Access row outside the part that closes, so it shows whenever
 *  terminal access is chosen. For starts at the longest length. Access, For and the warning follow
 *  their own choices; the sheet writes the Machines row's summary (showMachines) and reads choice. */
export function choiceRows(list: HTMLElement, machinesOpen: boolean, lengths: readonly WebAccessLength[]) {
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
 const accessRow = row("Access", true, segmented("access", ACCESS_CHOICES, choice.scope, v => { choice.scope = v; paint(); }));
 const terminalNote = el("p", "web-access-warning", "Terminal access is a shell on these machines: it can do anything you can do there.");
 accessRow.row.append(terminalNote);
 const forRow = row("For", false, segmented("time", lengths.map(l => [l.id, lengthLabel(l.seconds)] as const), choice.length, v => { choice.length = v; paint(); }));
 function paint(): void {
  accessRow.value.textContent = choiceLabel(ACCESS_CHOICES, choice.scope);
  const length = lengths.find(l => l.id === choice.length);
  forRow.value.textContent = length ? timeSummary(length.seconds, Date.now()) : "";
  terminalNote.hidden = choice.scope !== "terminal";
 }
 paint();
 return { rows, choice: choice as Readonly<typeof choice>, showMachines: (summary: string) => { machinesRow.value.textContent = summary; } };
}

export function initWebAccess(): void {
 if (webGuest) return;
 const closed = new Set<string>();
 let open: string | null = null;
 // The service's last answer to "do you offer browser approval?"; an error isn't kept.
 let offered: { offered: boolean; at: number } | null = null;
 let timer: ReturnType<typeof setTimeout> | undefined;

 const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void look(); }, POLL_MS); };
 async function look(): Promise<void> {
  try {
   if (document.visibilityState !== "visible" || open !== null) return;
   const state = await Desk.accountState();
   if (!state.signedIn) { offered = null; return; }
   if (askOffered(offered, Date.now())) offered = { offered: await Desk.webAccessOffered(), at: Date.now() };
   if (!offered?.offered) return;
   const req = nextRequest(await Desk.webAccessRequests() as WebAccessRequestView[], closed);
   if (req) await showSheet(req, await Desk.webAccessLengths(), () => { closed.add(req.id); open = null; });
  } catch { /* the next look tries again */ }
  finally { schedule(); }
 }
 document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { clearTimeout(timer); void look(); } });
 events.accountChanged.on(() => { offered = null; });
 schedule();

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
  // A plain click on a box takes its digit; a drag, double click or shift-click keeps the
  // selection it made. The second press of a double click lands on the digit the first one took,
  // which would start dragging that selection, so it's dropped first and the press selects the
  // code as in any field.
  code.addEventListener("mousedown", event => {
   if (event.detail > 1) code.setSelectionRange(code.selectionStart, code.selectionStart);
  });
  code.addEventListener("click", event => {
   if (plainClick(event, code.selectionStart ?? 0, code.selectionEnd ?? 0)) {
    const slot = digits.findIndex(d => event.clientX < d.getBoundingClientRect().right);
    code.setSelectionRange(...slotSelection(slot < 0 ? 3 : slot, code.value.length));
   }
   slots();
  });
  for (const type of ["keyup", "select", "focus"]) code.addEventListener(type, slots);

  const ticked = new Set(machines.filter(m => m.available).map(m => m.id));
  const list = el("div", "web-access-machines"); list.setAttribute("role", "group"); list.setAttribute("aria-label", "Machines");
  for (const m of machines) {
   const row = el("label", "web-access-machine");
   const box = el("input"); box.type = "checkbox"; box.checked = ticked.has(m.id); box.disabled = !m.available;
   box.onchange = () => { if (box.checked) ticked.add(m.id); else ticked.delete(m.id); update(); };
   const text = el("span", "web-access-machine-text"); text.append(el("span", "", m.label));
   if (!m.available) text.append(el("span", "web-access-dim", skipReason(m.unavailable ?? "")));
   row.append(box, text); list.append(row);
  }
  if (!machines.length) list.append(el("p", "web-access-dim", "Add a machine first."));

  const choices = choiceRows(list, ticked.size === 0, lengths);

  const problem = el("p", "web-access-problem"); problem.hidden = true;
  const deny = el("button", "ghost", "Deny"); deny.type = "button";
  // Shown once a denial failed: this computer won't approve any more, and the request ends on its own.
  const close = el("button", "ghost", "Close"); close.type = "button"; close.hidden = true;
  const approve = el("button", "", "Approve"); approve.type = "button";
  const buttons = el("div", "buttons"); buttons.append(close, deny, approve);
  dialog.append(title, lead, codeLabel, status, choices.rows, el("p", "web-access-dim web-access-note", machinesNote(machines)), problem, buttons);

  // busy: a call is in flight (Approve and Deny wait for each other). locked: the choices no longer
  // do anything (approved, too many codes, or a pending answer). finished: the request is over.
  let busy = false, locked = false, finished = false, retry = false;
  const lock = () => { locked = true; for (const i of dialog.querySelectorAll("input")) i.disabled = true; };
  const end = () => { finished = true; lock(); approve.hidden = true; close.hidden = true; deny.textContent = "Done"; };
  const update = () => {
   deny.disabled = busy;
   approve.disabled = busy || finished || (!retry && (locked || !canApprove(code.value, ticked.size) || code.disabled));
   slots();
   choices.showMachines(machinesSummary(machines, ticked));
  };
  const say = (text: string) => { problem.textContent = text; problem.hidden = !text; };
  code.oninput = () => { code.value = codeInput(code.value); say(""); update(); };

  const off = events.webAccessUpdate.on(u => {
   if (u.id !== req.id) return;
   if (u.state === "ready") { status.textContent = "The browser shows a code now."; if (!locked) { code.disabled = false; code.focus(); } update(); return; }
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
  approve.onclick = () => void run(async () => {
   say("");
   if (!retry) {
    const check = await Desk.webAccessCheckCode(req.id, code.value);
    if (!check.ok) {
     say(wrongCode(check));
     code.value = "";
     if (check.left === 0) { lock(); if (check.denied) end(); else close.hidden = false; }
     else code.focus();
     return;
    }
   }
   approve.textContent = "Approving…";
   retry = false;
   try {
    const result = await Desk.webAccessApprove(req.id, [...ticked], choices.choice.scope, choices.choice.length);
    const { done: approved, unsure, lines } = resultLines(result);
    say(lines.join(" "));
    retry = unsure;
    if (unsure) lock();
    if (approved) { end(); status.textContent = "Approved. The browser can open your machines now."; }
   } finally { approve.textContent = retry ? "Try again" : "Approve"; }
  });
  dialog.addEventListener("cancel", event => { if (!finished) event.preventDefault(); });
  dialog.addEventListener("close", () => { off(); dialog.remove(); done(); }, { once: true });
  document.body.append(dialog);
  update();
  dialog.showModal();
  try { await Desk.webAccessStart(req.id); }
  catch (error) { end(); status.textContent = errorText(error); }
 }
}
