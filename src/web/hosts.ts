// The web owner's host home: src/hosts.ts for the browser build (vite.web.config.ts swaps it in, as
// it swaps mygo). The desktop's host home (hostHome.ts: its header, account avatar, sections and
// rows) without saved SSH hosts, pairing, invites or setup: in their place the browser's owner
// access (ownerApproval.ts, ownerScreen.ts), asking to be approved, then the machines it was
// approved for. Picking one opens the owner link (desk.ts connectOwner) and shows its agents; the
// shell's back ("Choose host") comes here again, and Settings' Reconnect opens the same machine.
// The account avatar opens Settings, HerdrUp account, where Sign out is.

import type { initHosts as desktopHosts } from "../hosts";
import desktopIcon from "../../third_party/phosphor/web/desktop.svg?url";
import { element as el, hostGlyph, hostHomeHeader, type BrowserAccess } from "../hostHome";
import { ACCOUNT_TITLE, HerdrUpAccountPanel } from "../herdrupAccount";
import { errorText } from "../errors";
import type { EnvelopeMachine } from "../webguest/approve";
import { AccountServiceError, SignedOutError } from "./account";
import { bootMarks } from "./bootChoice";
import { approvalRunning, closingLink, followSession, OwnerWork } from "./ownerSession";
import { currentOwnerLink } from "./ownerLink";
import { Desk, events, ownerAccess, ownerDesk, pageExit } from "./mygo";
import { refreshLists, runApproval, type OwnerPhase } from "./ownerApproval";
import { ownerKey } from "./browserKey";
import { probeList, type MachineStatus } from "./ownerProbe";
import { OwnerRuns } from "./ownerRuns";
import { approvalParts, approvedMachines, machineAccess, machineSection, noticeCard, ownerLayout, thisBrowser, type MachineSection, type RowGlyphs } from "./ownerScreen";
import { IndexedDBOwnerStore, type OwnerRecord } from "./ownerStore";
import { sharedMachines, sharedSection, syncedSharesNow } from "../sharedWithYou";

/** The page starts over for whoever is signed in now (boot.ts chooses again): a sign-out, another
 *  account, or the person asking for the guest page (a choice, which takes the place of the page
 *  starting over: one way out, pageExit); never while a sign-out is being sent. */
function startOver(guestInstead = false) {
 pageExit.leave(() => { if (guestInstead) bootMarks().chooseGuest(); location.reload(); }, guestInstead);
}

export const initHosts: typeof desktopHosts = (container, _form, showAgents, symbol, spinner, _holdChanged, openAccount) => {
 const home = el("div", "host-home");
 const header = hostHomeHeader(symbol, openAccount);
 header.title("Welcome back", "Signed in");
 // A browser that can't be approved keeps its own notice over the page (ownerScreen.ts noticeCard).
 const noticeScreen = el("section", "web-welcome"); noticeScreen.hidden = true;
 container.replaceChildren(home, noticeScreen);
 const store = new IndexedDBOwnerStore();
 const browser = thisBrowser(navigator.userAgent, navigator.maxTouchPoints);
 const deviceName = browser.name;
 const statements = ownerAccess.statements;
 const statuses = new Map<string, MachineStatus>();
 const runs = new OwnerRuns();
 // The account session owner links, probes and the approval belong to. A sign-out ends it, and
 // nothing new starts (Open, probes, Try again do nothing) until its own account is read back
 // (restored, a new session) or the page starts over.
 const work = new OwnerWork<EnvelopeMachine>();
 let phase: OwnerPhase = { kind: "starting" };
 let probing: (() => Promise<void>) | null = null;
 /** The machine picked last (connectOwner), for Settings' Reconnect; null before the first pick. */
 let opened: EnvelopeMachine | null = null;
 /** The machine whose link is being opened (connectOwner still out), null when none is. */
 let opening: EnvelopeMachine | null = null;
 let attempt = 0;
 /** The run whose list refresh is out (refreshShown), null when none is. */
 let refreshing: AbortSignal | null = null;
 /** The rows' glyphs, once drawn (null before: the rows draw without them, then again). */
 let glyphs: RowGlyphs | null = null;
 void Promise.all([hostGlyph(symbol, "desktopcomputer", desktopIcon), symbol("chevron.right", 13, "semibold")]).then(([icon, chevron]) => {
  glyphs = { icon: () => icon.cloneNode(true) as HTMLElement, chevron: () => chevron.cloneNode(true) as HTMLElement };
  draw();
 });

 // The header's avatar and title: the account as the service says (an older read never draws
 // over a newer one), as the desktop's host home reads it.
 let accountVersion = 0;
 const refreshAccount = async () => {
  const at = ++accountVersion;
  const state = await Desk.accountState().catch(() => null);
  const providers = state?.signedIn ? [] : await Desk.accountProviders().catch(() => null);
  if (at !== accountVersion) return;
  header.showAccount(state, providers === null || providers.length > 0);
  header.title("Welcome back", state?.signedIn && state.displayHint ? `Signed in · ${state.displayHint}` : "Signed in");
  const nextSignedIn = state?.signedIn === true;
  signedIn = nextSignedIn;
  if (signedIn && !container.hidden && !approvalStarted) { approvalStarted = true; begin(); }
  void refreshShared();
 };
 // SHARED WITH YOU (sharedWithYou.ts), as on the desktop's host home: the grant this browser
 // holds and the account's synced shares (#700).
 let signedIn = false;
 const sharedProblem = el("p", "host-home-message"); sharedProblem.setAttribute("role", "alert"); sharedProblem.hidden = true;
 const shared = sharedSection(symbol, showAgents, error => { sharedProblem.textContent = errorText(error); sharedProblem.hidden = false; }, () => opening !== null);
 shared.root.append(sharedProblem);
 let sharedVersion = 0;
 async function refreshShared() {
  const at = ++sharedVersion;
  const [grants, synced] = await Promise.all([Desk.sharedConnections().catch(() => []), syncedSharesNow(signedIn)]);
  if (at === sharedVersion) await shared.draw(sharedMachines(grants, synced));
 }
 events.syncedSharesChanged.on(() => { void refreshShared(); });
 events.accountChanged.on(() => { void refreshAccount(); });
 void refreshAccount();

 // The notice's account row (the notice as it was: signing out there, or in Settings, ends the
 // session).
 let approvalStarted = false;
 const account = new HerdrUpAccountPanel(() => { if (phase.kind === "unsupported") draw(); });
 followSession(ownerAccess.account, {
  // The session's work goes at once, its record (OwnerWork) saying what ran: the approval in
  // flight, the list's refresh, the probes, the link the end closes (closingLink: the one being
  // opened, else the open one, however its last list went; one still opening is forgotten, not
  // failed).
  end: () => {
   work.end(() => ({ approval: approvalRunning(phase.kind), listRefresh: refreshing !== null, probes: probing !== null,
    link: closingLink(opening, currentOwnerLink()) }));
   const wasOpening = opening !== null;
   runs.stop(); opening = null; refreshing = null; attempt++;
   if (probing !== null) { void probing(); probing = null; }
   if (wasOpening) draw();
  },
  startOver: () => { if (approvalStarted || !container.hidden) startOver(); },
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
  }, statements, deviceName, (hostID, status) => { statuses.set(hostID, status); shown?.showStatus(hostID, status); }, { signal: signal! });
 }

 /** The machines on screen: a probe's status goes into its row in place; with no row for the
  *  machine (the approval shows, or a machine this list doesn't have) the status waits in
  *  statuses for the next drawing. */
 let shown: MachineSection | null = null;
 function draw() {
  const layout = ownerLayout(phase);
  shown = null;
  noticeScreen.hidden = layout.view !== "notice";
  home.hidden = layout.view === "notice";
  if (layout.view === "notice") {
   const card = noticeCard(browser, () => startOver(true));
   if (account.available) { const part = el("div", "web-welcome-account"); part.append(el("h2", "", ACCOUNT_TITLE), account.root); card.append(part); }
   noticeScreen.replaceChildren(card);
   home.replaceChildren(header.root);
  } else if (layout.view === "list") {
   shown = machineSection(layout.record, statuses, glyphs, opening?.hostID ?? null, spinner, m => open(m));
   home.replaceChildren(header.root, shared.root, shown.root);
  } else {
   home.replaceChildren(header.root, shared.root, ...approvalParts(layout, browser, { again: begin, guestInstead: () => startOver(true) }, spinner));
  }
  probe();
 }

 /** Opens an approved machine: its owner link, then the shell's agents (show; a link opened again
  *  in place doesn't change what shows). Picking the machine whose link is open and usable (the
  *  owner Desk says, from that link's own state) goes straight back to it; again (Reconnect, a
  *  restored session) opens it anew. Its row says "Connecting…" meanwhile, as the desktop's. */
 function open(m: EnvelopeMachine, again = false, show = true) {
  const signal = work.signal;
  if (signal === null) return;
  if (!again && ownerDesk.ownerLinkUsable(m.hostID)) { showAgents(); return; }
  opened = m;
  opening = m;
  statuses.delete(m.hostID);
  const at = ++attempt;
  draw();
  ownerDesk.connectOwner(m, statements, deviceName, signal).then(() => {
   if (at !== attempt) return;
   opening = null;
   draw();
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
  phase = { kind: "starting" };
  runs.begin(ownerAccess.account.current?.accountID,
   run => runApproval({ account: ownerAccess.account, identities: ownerAccess.identities, store, deviceName }, (p: OwnerPhase) => {
    if (!runs.isCurrent(run)) return;
    phase = p;
    if (p.kind === "approved") void refreshShown(run, p.record);
    draw();
   }, run),
   error => { phase = { kind: "failed", problem: errorText(error) }; draw(); });
  draw();
 }

 new MutationObserver(() => {
  if (!container.hidden) {
   if (!signedIn && ownerAccess.account.current === null) {
    // Do not wipe an open modal (e.g., Leave confirmation showing an unsent-delete warning).
    const openDialog = document.querySelector("dialog[open]");
    if (openDialog) {
     openDialog.addEventListener("close", () => {
      if (!container.hidden && !signedIn && ownerAccess.account.current === null) startOver(true);
     }, { once: true });
     return;
    }
    startOver(true);
    return;
   }
   if (!approvalStarted) { approvalStarted = true; begin(); }
  }
  probe();
 }).observe(container, { attributes: true, attributeFilter: ["hidden"] });
 if (!container.hidden && ownerAccess.account.current !== null) { approvalStarted = true; begin(); }
 void account.refresh(true);

 return {
  refresh: async () => draw(),
  /** No hold: the shell shows the agents once a link opens, with its spinner until the list. */
  holdsHome: () => false,
  pairingActive: () => false,
  async reconnect() {
   if (opened === null) throw new Error("Choose a machine before reconnecting.");
   open(opened, true);
  },
  /** The opened machine's access, as the newest list has it (Settings → Machines). */
  access: (): BrowserAccess | null => opened === null || phase.kind !== "approved" ? null : machineAccess(phase.record, opened.hostID),
 };
};
