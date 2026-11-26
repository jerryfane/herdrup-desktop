// "Pair ‹device›?", the approving computer's sheet for another app device of the account that asks to
// be added to the owner's machines (herdr-app PLAN, 26 Nov 2026, option B: code first). The look in
// webAccess.ts opens it, or its notice while the user is typing. Step 1: the user types the code the
// new device shows (codeField, 3 tries). Step 2: every saved machine, ticked when this computer can
// add the key there (probes fill the rows in as they land), greyed with the reason when it can't.
// Approve adds the key one machine at a time (a spinner per row), then the results, with Try again
// for a machine that failed. Same parts as "Approve a browser?" (webAccess.css, buttons.css).

import "./webAccess.css";
import { Desk, events } from "./mygo";
import type { PairApproveResult, WebAccessMachine } from "./mygo";
import { errorText } from "./errors";
import { symbolNow } from "./symbol";
import { codeField } from "./codeField";
import type { SheetClock } from "./webAccess";
import { codeInput, wrongCode } from "./webAccessModel";
import {
 approveLabel, deviceName, expiresText, failureLine, keyNote, PAIR_ENDED, platformLine, probeReason, resultLead, retryLabel, rowStatusText,
 type PairRequestView, type PairRowView, type ProbeState, type RowStatus,
} from "./pairApprovalModel";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
 const n = document.createElement(tag);
 if (cls) n.className = cls;
 if (text !== undefined) n.textContent = text;
 return n;
}

/** This computer, as a machine it can't reach says it. */
function here(): string {
 return globalThis.navigator?.platform?.startsWith("Mac") ? "this Mac" : "this computer";
}

type Step = "code" | "machines" | "adding" | "result" | "ended";

/** One saved machine on the sheet: what a probe found, and once ticked and approved, its outcome. */
interface Row {
 m: WebAccessMachine;
 probe: ProbeState;
 version: string;
 status?: RowStatus;
 reason?: string;
 keyLabel?: string;
 box: HTMLInputElement;
 sub: HTMLElement;
 state: HTMLElement;
 node: HTMLElement;
}

/** Opens the sheet for req, with the saved machines; done runs once it closes. */
export async function showPairSheet(req: PairRequestView, machines: readonly WebAccessMachine[], done: () => void, clock: SheetClock): Promise<void> {
 const name = deviceName(req);
 const expiresAt = clock.now() + req.expiresIn * 1000;
 let step: Step = "code";
 // ready: the new device shows its code. busy: a call is out.
 // unsent: the service holds the approval but not this list (Go sends it again on Try again).
 let ready = false, busy = false, unsure = false, unsent = false;
 const ticked = new Set<string>();
 // Machines the user ticked or unticked: a probe that lands later leaves them as they are.
 const touched = new Set<string>();

 const dialog = el("dialog", "folder-naming web-access pair-approve");
 dialog.setAttribute("aria-label", `Pair ${name}`);
 const title = el("h2", "", `Pair ${name}?`);
 const lead = el("p", "web-access-lead");
 const { field, input: code, slots, close: closeCode } = codeField("", `Code shown on ${name}`);
 const status = el("p", "web-access-status pair-approve-status");
 const mark = el("span", "pair-approve-mark"); mark.setAttribute("aria-hidden", "true");
 mark.append(symbolNow("checkmark", 12, "semibold"));
 const statusText = el("span", "pair-approve-status-text");
 const expiry = el("span", "pair-approve-expiry");
 status.append(mark, statusText, expiry);

 const list = el("div", "web-access-machines pair-approve-machines"); list.setAttribute("role", "group"); list.setAttribute("aria-label", "Machines");
 const rows: Row[] = machines.map(m => {
  const node = el("label", "web-access-machine pair-approve-machine");
  const box = el("input"); box.type = "checkbox";
  const text = el("span", "web-access-machine-text");
  const sub = el("span", "web-access-dim");
  text.append(el("span", "pair-approve-name", m.label), sub);
  const state = el("span", "pair-approve-state");
  node.append(box, text, state);
  list.append(node);
  const row: Row = { m, probe: m.available ? "checking" : "needs_key", version: "", box, sub, state, node };
  box.onchange = () => { touched.add(m.id); if (box.checked) ticked.add(m.id); else ticked.delete(m.id); paint(); };
  return row;
 });
 if (!machines.length) list.append(el("p", "web-access-dim", "Add a machine first."));
 const note = el("p", "web-access-dim web-access-note");
 const problem = el("p", "web-access-problem"); problem.hidden = true;
 const deny = el("button", "button-secondary", "Deny"); deny.type = "button";
 const retry = el("button", "button-secondary"); retry.type = "button"; retry.hidden = true;
 const primary = el("button", "", "Continue"); primary.type = "button";
 const buttons = el("div", "buttons"); buttons.append(deny, retry, primary);
 dialog.append(title, lead, field, status, list, note, problem, buttons);

 const say = (text: string) => { problem.textContent = text; problem.hidden = !text; };
 const failed = () => rows.filter(r => r.status === "failed");
 const views = (): PairRowView[] => rows.filter(r => r.status).map(r => ({ id: r.m.id, label: r.m.label, status: r.status!, reason: r.reason, keyLabel: r.keyLabel }));

 function paintRow(r: Row): void {
  const usable = r.probe === "ready";
  r.node.classList.toggle("unusable", !usable && !r.status);
  r.box.checked = ticked.has(r.m.id);
  r.box.disabled = step !== "machines" || busy || !usable;
  r.sub.textContent = usable ? "" : probeReason(r.probe, here(), r.version);
  r.sub.hidden = usable || r.probe === "checking";
  r.state.replaceChildren();
  if (r.status && ticked.has(r.m.id)) {
   if (r.status === "adding") { const spin = el("span", "ring-spinner"); spin.setAttribute("aria-hidden", "true"); r.state.append(spin); }
   if (r.status === "failed") { const dot = el("span", "pair-approve-dot"); dot.setAttribute("aria-hidden", "true"); r.state.append(dot); }
   r.state.append(rowStatusText(r.status, r.reason));
  } else if (r.probe === "checking" && step !== "ended") {
   r.state.append(probeReason("checking", here()));
  }
 }

 function paint(): void {
  const codeStep = step === "code";
  field.hidden = !codeStep;
  list.hidden = codeStep || step === "ended";
  note.hidden = codeStep || step === "ended";
  mark.hidden = step !== "machines";
  expiry.hidden = !(step === "code" && ready) && step !== "machines";
  status.hidden = step === "adding" || step === "result";
  switch (step) {
   case "code":
    lead.textContent = `${platformLine(req.platform)} wants to add its key to your machines. Enter the code shown on ${name}.`;
    if (ready) statusText.textContent = "Step 1 of 2 ·"; else statusText.textContent = `Waiting for ${name} to show its code…`;
    break;
   case "machines": lead.textContent = `Tick the machines that get ${name}'s key.`; statusText.textContent = "The code matches"; break;
   case "adding": lead.textContent = `Adding ${name}'s key, one machine at a time.`; break;
   case "result": lead.textContent = resultLead(name, views()); break;
   case "ended": lead.textContent = `${platformLine(req.platform)} wants to add its key to your machines.`; break;
  }
  expiry.textContent = expiresText(expiresAt - clock.now());
  note.textContent = keyNote(name, step === "result" ? views() : []);
  for (const r of rows) paintRow(r);
  const fails = failed();
  deny.hidden = step === "result" || step === "ended";
  deny.disabled = busy;
  retry.hidden = step !== "result" || (!fails.length && !unsent);
  retry.disabled = busy;
  if (!retry.hidden) retry.textContent = fails.length ? retryLabel(fails.map(f => f.m.label)) : "Send the list again";
  primary.classList.toggle("pair-approve-busy", step === "adding");
  switch (step) {
   case "code": primary.textContent = "Continue"; primary.disabled = busy || !ready || code.disabled || code.value.length !== 4; break;
   case "machines": primary.textContent = unsure ? "Try again" : approveLabel(ticked.size); primary.disabled = busy || (!unsure && ticked.size === 0); break;
   case "adding": primary.textContent = "Adding keys…"; primary.disabled = true; break;
   default: primary.textContent = "Done"; primary.disabled = busy;
  }
  slots();
 }

 // The time left, each second, while the request waits for this computer. Past it the request is
 // over (Go says so too, pair-approve:update).
 let stopTick = () => {};
 const tick = () => {
  stopTick();
  if (step !== "code" && step !== "machines") return;
  if (expiresAt - clock.now() <= 0) { end(PAIR_ENDED); return; }
  expiry.textContent = expiresText(expiresAt - clock.now());
  stopTick = clock.after(1000 - (expiresAt - clock.now()) % 1000, tick);
 };

 function end(text: string): void {
  step = "ended"; stopTick();
  code.disabled = true;
  statusText.textContent = text;
  say("");
  paint();
 }

 function showResult(result: PairApproveResult): void {
  for (const m of result.machines) {
   const r = rows.find(x => x.m.id === m.id);
   if (r) { r.status = m.status as RowStatus; r.reason = m.reason; r.keyLabel = m.keyLabel; }
  }
  step = "result"; stopTick(); unsent = result.unsent === true;
  say([failureLine(views()), result.problem ?? ""].filter(Boolean).join(" "));
  paint();
 }

 const focusCode = () => { if (dialog.contains(document.activeElement)) code.focus(); };
 code.oninput = () => { code.value = codeInput(code.value); say(""); paint(); };

 const offUpdate = events.pairApproveUpdate.on(u => {
  if (u.id !== req.id) return;
  if (u.state === "ready") {
   if (step !== "code") return;
   ready = true; code.disabled = false; paint(); focusCode(); tick();
   return;
  }
  if (step === "result") return;
  end(u.problem || PAIR_ENDED);
 });
 const offProgress = events.pairApproveProgress.on(p => {
  if (p.id !== req.id) return;
  const r = rows.find(x => x.m.id === p.machineId);
  if (!r) return;
  r.status = p.status as RowStatus; r.reason = p.reason; r.keyLabel = p.keyLabel;
  paint();
 });

 const run = async (f: () => Promise<void>) => {
  busy = true; paint();
  try { await f(); } catch (error) { say(errorText(error)); } finally { busy = false; paint(); }
 };

 // A denial that fails says why; Deny tries again.
 deny.onclick = () => {
  void run(async () => {
   await Desk.pairApproveDeny(req.id);
   step = "ended"; dialog.close();
  });
 };

 const continueWithCode = () => run(async () => {
  say("");
  const check = await Desk.pairApproveCheckCode(req.id, code.value);
  if (check.ok) { step = "machines"; code.disabled = true; return; }
  say(wrongCode(check, name));
  code.value = "";
  if (check.left === 0) { if (check.denied) end("Too many wrong codes. The request was denied."); else code.disabled = true; }
  else focusCode();
 });

 const approve = () => {
  const chosen = rows.filter(r => ticked.has(r.m.id));
  if (!unsure) for (const r of chosen) { r.status = "waiting"; r.reason = undefined; }
  step = "adding";
  void run(async () => {
   try {
    say("");
    const result = await Desk.pairApproveAdd(req.id, chosen.map(r => r.m.id));
    unsure = result.unsure === true;
    if (result.ended) { end(result.problem || PAIR_ENDED); return; }
    if (unsure) {
     step = "machines";
     say(`Couldn't tell whether ${name} got the list${result.problem ? ` (${result.problem})` : ""}. Try again sends the same list.`);
     return;
    }
    showResult(result);
   } catch (error) {
    // Nothing was sent: the machines can be ticked again.
    step = "machines";
    for (const r of chosen) if (r.status === "waiting") r.status = undefined;
    throw error;
   }
  });
 };

 retry.onclick = () => {
  const again = failed();
  for (const r of again) { r.status = "waiting"; r.reason = undefined; }
  step = "adding";
  void run(async () => {
   try {
    const result = await Desk.pairApproveRetry(req.id, again.map(r => r.m.id));
    showResult(result);
   } catch (error) {
    step = "result";
    throw error;
   }
  });
 };

 primary.onclick = () => {
  switch (step) {
   case "code": void continueWithCode(); return;
   case "machines": approve(); return;
   case "result": case "ended": dialog.close(); return;
  }
 };

 dialog.addEventListener("cancel", event => { if (step !== "result" && step !== "ended") event.preventDefault(); });
 dialog.addEventListener("close", () => { offUpdate(); offProgress(); stopTick(); closeCode(); dialog.remove(); done(); }, { once: true });
 document.body.append(dialog);
 paint();
 dialog.showModal();
 // Rows fill in as each machine answers; Go probes a few at a time.
 for (const r of rows) {
  if (r.probe !== "checking") continue;
  Desk.pairApproveProbe(r.m.id).then(p => {
   r.probe = p.state as ProbeState; r.version = p.version ?? "";
   if (r.probe === "ready" && !touched.has(r.m.id) && (step === "code" || step === "machines")) ticked.add(r.m.id);
  }, () => { r.probe = "unreachable"; }).finally(paint);
 }
 try { await Desk.pairApproveStart(req.id); }
 catch (error) { end(errorText(error)); }
}
