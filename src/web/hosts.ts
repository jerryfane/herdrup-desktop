// The web owner's host home: src/hosts.ts for the browser build (vite.web.config.ts swaps it in, as
// it swaps mygo). Where the desktop lists saved SSH hosts and pairs machines, the browser shows its
// owner access (ownerApproval.ts, ownerScreen.ts): asking to be approved, then the machines it was
// approved for. Picking one opens the owner link (desk.ts connectOwner) and shows its agents; the
// shell's back ("Choose host") comes here again, and Settings' Reconnect opens the same machine.

import type { initHosts as desktopHosts } from "../hosts";
// The host home's place in the window (the sidebar gives way to it), as the desktop's.
import "../hosts.css";
import { ACCOUNT_TITLE, HerdrUpAccountPanel } from "../herdrupAccount";
import { errorText } from "../errors";
import type { EnvelopeMachine } from "../webguest/approve";
import { AccountServiceError, SignedOutError } from "./account";
import { bootMarks } from "./bootChoice";
import { approvalRunning, closingLink, followSession, OwnerWork } from "./ownerSession";
import { currentOwnerLink } from "./ownerLink";
import { events } from "./events";
import { ownerAccess, ownerDesk, pageExit } from "./mygo";
import { ownerKey, refreshLists, runApproval, type OwnerPhase } from "./ownerApproval";
import { probeList, type MachineStatus } from "./ownerProbe";
import { OwnerRuns } from "./ownerRuns";
import { approvedMachines, arrives, ownerCard, thisBrowser, type OwnerCard } from "./ownerScreen";
import { IndexedDBOwnerStore, type OwnerRecord } from "./ownerStore";
import { statementCache } from "./statements";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
 const e = document.createElement(tag);
 if (cls) e.className = cls;
 if (text !== undefined) e.textContent = text;
 return e;
}

/** The page starts over for whoever is signed in now (boot.ts chooses again): a sign-out, another
 *  account, or the person asking for the guest page (a choice, which takes the place of the page
 *  starting over: one way out, pageExit); never while a sign-out is being sent. */
function startOver(guestInstead = false) {
 pageExit.leave(() => { if (guestInstead) bootMarks().chooseGuest(); location.reload(); }, guestInstead);
}

export const initHosts: typeof desktopHosts = (container, _form, showAgents, _symbol, spinner) => {
 const screen = el("section", "web-welcome");
 container.replaceChildren(screen);
 const store = new IndexedDBOwnerStore();
 const browser = thisBrowser(navigator.userAgent, navigator.maxTouchPoints);
 const deviceName = browser.name;
 const statements = statementCache(ownerAccess.account);
 const statuses = new Map<string, MachineStatus>();
 const runs = new OwnerRuns();
 // The account session owner links, probes and the approval belong to. A sign-out ends it, and
 // nothing new starts (Open, probes, Try again do nothing) until its own account is read back
 // (restored, a new session) or the page starts over.
 const work = new OwnerWork<EnvelopeMachine>();
 let phase: OwnerPhase = { kind: "starting" };
 /** When the machine list arrived from the code (performance.now()), for its entrance; null when
  *  the list showed without that step (ownerCard's arrivedAt). */
 let arrivedAt: number | null = null;
 let probing: (() => Promise<void>) | null = null;
 /** The machine picked last (connectOwner), for Settings' Reconnect; null before the first pick. */
 let opened: EnvelopeMachine | null = null;
 /** The machine whose link is being opened (connectOwner still out), null when none is. */
 let opening: EnvelopeMachine | null = null;
 let attempt = 0;
 /** The run whose list refresh is out (refreshShown), null when none is. */
 let refreshing: AbortSignal | null = null;
 /** The open link's last state: picking its machine goes straight back to it unless it failed. */
 let linkPhase = "";
 events.stateChanged.on(s => { linkPhase = s.phase; });

 // The owner screen's account row (as the guest page's welcome has it): signing out there, or in
 // Settings, ends the session.
 const account = new HerdrUpAccountPanel(() => draw());
 followSession(ownerAccess.account, {
  // The session's work goes at once, its record (OwnerWork) saying what ran: the approval in
  // flight, the list's refresh, the probes, the link the end closes (closingLink: the one being
  // opened, else the open one, however its last list went; one still opening is forgotten, not
  // failed).
  end: () => {
   work.end(() => ({ approval: approvalRunning(phase.kind), listRefresh: refreshing !== null, probes: probing !== null,
    link: closingLink(opening, currentOwnerLink()) }));
   runs.stop(); opening = null; refreshing = null; attempt++;
   if (probing !== null) { void probing(); probing = null; }
  },
  startOver: () => startOver(),
  // The same account read back after a refused sign-out: what the end stopped starts again under
  // the new session; the screen stays as it was (an approval that had ended stays as it ended).
  restored: () => {
   const stopped = work.resume();
   if (stopped === null) return;
   if (stopped.approval) begin();
   if (stopped.listRefresh && phase.kind === "approved") {
    const record = phase.record;
    runs.begin(ownerAccess.account.current?.accountID, run => refreshShown(run, record), () => {});
   }
   if (stopped.probes) probe();
   if (stopped.link !== null) open(stopped.link, true, false);
  },
 });

 /** Asks every approved machine how it is while the list shows (one probeList per showing): the
  *  shell shows the host home by unhiding #connect (main.ts render). */
 function probe() {
  const signal = work.signal;
  const want = signal !== null && !container.hidden && phase.kind === "approved";
  if (want === (probing !== null)) return;
  if (!want) { void probing!(); probing = null; return; }
  probing = probeList(async () => {
   if (phase.kind !== "approved") return null;
   const record = phase.record;
   const key = await ownerKey(ownerAccess.identities).catch(() => null);
   return key === null ? null : { machines: approvedMachines(record).machines, key };
  }, statements, deviceName, (hostID, status) => { statuses.set(hostID, status); shown.showStatus(hostID, status); }, { signal: signal! });
 }

 /** The card on screen: a probe's status goes into its row in place; with no row for the machine
  *  (another screen, or a machine this list doesn't have) the status waits in statuses for the
  *  next drawing. */
 let shown: Pick<OwnerCard, "showStatus"> = { showStatus: () => false };
 function draw() {
  const card = ownerCard(phase, browser, { again: begin, guestInstead: () => startOver(true), open: m => open(m) }, spinner, statuses, arrivedAt);
  if (account.available) { const part = el("div", "web-welcome-account"); part.append(el("h2", "", ACCOUNT_TITLE), account.root); card.root.append(part); }
  screen.replaceChildren(card.root);
  shown = card;
  probe();
 }

 /** Opens an approved machine: its owner link, then the shell's agents (show; a link opened again
  *  in place doesn't change what shows). Picking the machine whose link is open (and not failed)
  *  goes straight back to it; again (Reconnect, a restored session) opens it anew. */
 function open(m: EnvelopeMachine, again = false, show = true) {
  const signal = work.signal;
  if (signal === null) return;
  if (!again && currentOwnerLink()?.machine.hostID === m.hostID && linkPhase !== "error") { showAgents(); return; }
  opened = m;
  opening = m;
  statuses.delete(m.hostID);
  const at = ++attempt;
  ownerDesk.connectOwner(m, statements, deviceName, signal).then(() => {
   if (at !== attempt) return;
   opening = null;
   if (show) showAgents();
  }, (error: unknown) => {
   if (at !== attempt) return;
   opened = null; opening = null;
   statuses.set(m.hostID, { kind: "problem", message: errorText(error) });
   draw();
  });
 }

 /** Newer lists for the approval shown (same account, same key), taken in the background; while
  *  it is out, it is part of the session's running work (refreshing). */
 async function refreshShown(run: AbortSignal, record: OwnerRecord) {
  refreshing = run;
  try {
   const key = await ownerKey(ownerAccess.identities).catch(() => null);
   if (key === null || !runs.isCurrent(run)) return;
   let fresh: OwnerRecord | undefined;
   try { fresh = await refreshLists(ownerAccess.account, record.account, key, store, deviceName, run); }
   catch (error) {
    if (runs.isCurrent(run) && ((error instanceof AccountServiceError && error.code === "account_changed") || error instanceof SignedOutError)) startOver();
    return;
   }
   if (fresh === undefined || !runs.isCurrent(run) || phase.kind !== "approved") return;
   phase = { kind: "approved", record: fresh };
   draw();
  } finally { if (refreshing === run) refreshing = null; }
 }

 /** The approval: what this account already has here shows, else this browser asks; Ask again
  *  goes the same way. */
 function begin() {
  if (work.signal === null) return;
  phase = { kind: "starting" }; arrivedAt = null;
  runs.begin(ownerAccess.account.current?.accountID,
   run => runApproval({ account: ownerAccess.account, identities: ownerAccess.identities, store, deviceName }, (p: OwnerPhase) => {
    if (!runs.isCurrent(run)) return;
    if (arrives(phase.kind, p.kind)) arrivedAt = performance.now();
    phase = p;
    if (p.kind === "approved") void refreshShown(run, p.record);
    draw();
   }, run),
   error => { phase = { kind: "failed", problem: errorText(error) }; draw(); });
  draw();
 }

 new MutationObserver(probe).observe(container, { attributes: true, attributeFilter: ["hidden"] });
 begin();
 void account.refresh(true);

 return {
  refresh: async () => draw(),
  /** No hold: the shell shows the agents once a link opens, with its spinner until the list. */
  holdsHome: () => false,
  async reconnect() {
   if (opened === null) throw new Error("Choose a machine before reconnecting.");
   open(opened, true);
  },
 };
};
