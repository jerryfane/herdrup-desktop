// Web owner access, the approving computer's side (WIRE-PLAN §2, D1; mockups
// herdrup-accounts-mockups/web-owner sections 2 and 5): while the app is in front and signed in,
// it looks for browsers asking to reach the owner's machines (no push in v1), and opens
// "Approve a browser?". The user types the code the browser shows, picks machines, access and
// time, and this computer adds a grant on each machine over SSH. Desktop only: the web guest is
// the browser being approved, never the approver.

import "./webAccess.css";
import { Desk, events } from "./mygo";
import type { WebAccessMachine } from "./mygo";
import { errorText } from "./errors";
import { webGuest } from "./platform";
import { canApprove, codeInput, nextRequest, resultLines, skipReason, wrongCode, type WebAccessRequestView } from "./webAccessModel";

/** How often to look for requests while the window is in front: the service allows 30 approval
 *  calls a minute per account, and a request lasts 10 minutes. */
const POLL_MS = 8000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
 const n = document.createElement(tag);
 if (cls) n.className = cls;
 if (text !== undefined) n.textContent = text;
 return n;
}

function segmented(name: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLElement {
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

export function initWebAccess(): void {
 if (webGuest) return;
 const closed = new Set<string>();
 let open: string | null = null;
 let offered: boolean | null = null;
 let timer: ReturnType<typeof setTimeout> | undefined;

 const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void look(); }, POLL_MS); };
 async function look(): Promise<void> {
  try {
   if (document.visibilityState !== "visible" || open !== null) return;
   const state = await Desk.accountState();
   if (!state.signedIn) { offered = null; return; }
   offered ??= await Desk.webAccessOffered();
   if (!offered) return;
   const req = nextRequest(await Desk.webAccessRequests() as WebAccessRequestView[], closed);
   if (req) await showSheet(req, () => { closed.add(req.id); open = null; });
  } catch { /* the next look tries again */ }
  finally { schedule(); }
 }
 document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { clearTimeout(timer); void look(); } });
 events.accountChanged.on(() => { offered = null; });
 schedule();

 async function showSheet(req: WebAccessRequestView, done: () => void): Promise<void> {
  open = req.id;
  const machines: WebAccessMachine[] = await Desk.webAccessMachines().catch(() => []);
  const dialog = el("dialog", "folder-naming web-access");
  dialog.setAttribute("aria-label", "Approve a browser");
  const title = el("h2", "", "Approve a browser?");
  const lead = el("p", "web-access-lead", `${req.browserName} wants to reach your machines.`);
  const status = el("p", "web-access-status", "Waiting for the browser to show its code…");
  const code = el("input", "web-access-code"); code.inputMode = "numeric"; code.autocomplete = "one-time-code";
  code.maxLength = 4; code.disabled = true; code.setAttribute("aria-label", "Code shown in the browser"); code.placeholder = "····";
  const codeLabel = el("label", "web-access-field"); codeLabel.append(el("span", "", "Enter the code shown in the browser"), code);

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

  let scope = "terminal", length = "30d";
  const terminalNote = el("p", "web-access-dim", "Terminal access is a shell on these machines: it can do anything you can do there.");
  const access = segmented("access", [["terminal", "Chat and terminal"], ["chat", "Chat only"]], scope, v => { scope = v; terminalNote.hidden = v !== "terminal"; });
  const time = segmented("time", [["1d", "1 day"], ["7d", "7 days"], ["30d", "30 days"]], length, v => { length = v; });

  const problem = el("p", "web-access-problem"); problem.hidden = true;
  const deny = el("button", "ghost", "Deny"); deny.type = "button";
  const approve = el("button", "", "Approve"); approve.type = "button";
  const buttons = el("div", "buttons"); buttons.append(deny, approve);
  const section = (label: string, ...nodes: HTMLElement[]) => { const s = el("section", "web-access-section"); s.append(el("h3", "settings-section-label", label), ...nodes); return s; };
  dialog.append(title, lead, status, codeLabel, section("MACHINES", list, el("p", "web-access-dim", "Approving turns on web access on the machines you tick.")),
   section("ACCESS", access, terminalNote), section("FOR", time), problem, buttons);

  let busy = false, tries = 0, finished = false;
  // Once the request is approved, denied or gone, its choices no longer do anything: lock them.
  const end = () => { finished = true; for (const i of dialog.querySelectorAll("input")) i.disabled = true; approve.disabled = true; };
  const update = () => { approve.disabled = finished || !canApprove(code.value, ticked.size, busy) || code.disabled; };
  const say = (text: string) => { problem.textContent = text; problem.hidden = !text; };
  code.oninput = () => { code.value = codeInput(code.value); say(""); update(); };

  const off = events.webAccessUpdate.on(u => {
   if (u.id !== req.id) return;
   if (u.state === "ready") { status.textContent = "The browser shows a code now."; code.disabled = false; code.focus(); update(); return; }
   end(); status.textContent = u.problem || "This request ended.";
  });
  deny.onclick = async () => {
   if (!finished) await Desk.webAccessDeny(req.id).catch(() => {});
   finished = true; dialog.close();
  };
  approve.onclick = async () => {
   busy = true; update(); say("");
   try {
    const check = await Desk.webAccessCheckCode(req.id, code.value);
    if (!check.ok) {
     tries++; say(wrongCode(tries));
     if (check.denied) end();
     code.value = ""; code.focus();
     return;
    }
    approve.textContent = "Approving…";
    const result = await Desk.webAccessApprove(req.id, [...ticked], scope, length);
    const { done: approved, lines } = resultLines(result);
    say(lines.join(" "));
    if (approved) { end(); deny.textContent = "Done"; approve.hidden = true; status.textContent = "Approved. The browser can open your machines now."; }
   } catch (error) { say(errorText(error)); }
   finally { busy = false; if (!approve.hidden) approve.textContent = "Approve"; update(); }
  };
  dialog.addEventListener("cancel", event => { if (!finished) event.preventDefault(); });
  dialog.addEventListener("close", () => { off(); dialog.remove(); done(); }, { once: true });
  document.body.append(dialog);
  update();
  dialog.showModal();
  try { await Desk.webAccessStart(req.id); }
  catch (error) { end(); status.textContent = errorText(error); }
 }
}
