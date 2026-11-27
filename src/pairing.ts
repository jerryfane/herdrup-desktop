import { Desk, type PairedMachine, type PairingOffer, type PairingPreview, type PairRequestMachine, type PairRequestView, type SavedMachine, type SyncedMachine } from "./mygo";
import { hostRowChevron, hostRowIcon, hostRowLines, hostRowValue, hostSection } from "./hostHome";
import { scanQR } from "./qrScanner";
import "./pairing.css";
import { errorText } from "./errors";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; }
function button(text: string, run: () => void) { const node = el("button", "", text); node.type = "button"; node.onclick = run; return node; }
let active: HTMLDialogElement | null = null;

/** The pairing sheet: scan herdr pair's code with the camera, or paste the code or its
 *  herdrup://pair# link. `offer` opens it on the confirmation of a link the system opened
 *  (Desk.takePairingLink), whose token stays in Go: a pasted or opened code pairs only on
 *  Connect. */
export function showPairing(saved: () => Promise<void>, open: (machine: PairedMachine) => Promise<void>, manual: () => void, offer?: PairingOffer) {
  active?.close();
  let disposed = false, stopCamera: (() => void) | null = null, phase: "scan" | "paste" | "confirm" | "pair" | "result" = "scan";
  const sheet = el("dialog", "settings-sheet pairing-sheet"), header = el("header", "settings-sheet-header"), heading = el("h2", "", "Scan to connect");
  heading.id = "pairing-title"; sheet.setAttribute("aria-labelledby", heading.id);
  header.append(heading, button("Cancel", () => sheet.close()));
  const content = el("div", "pairing-content"); content.setAttribute("aria-live", "polite"); sheet.append(header, content);
  function stop() { stopCamera?.(); stopCamera = null; }
  const pasteButton = () => button("Paste pairing code", paste);
  function failure(title: string, message: string) {
    if (disposed) return;
    stop(); phase = "result";
    content.replaceChildren(el("h3", "", title), el("p", "", message), button("Try again", start), pasteButton(), button("Add host manually", () => { sheet.close(); manual(); }));
  }
  const invalid = () => failure("Pairing didn't work", "That code isn't a herdr pairing code. On your computer, run herdr pair and scan the code it prints.");
  async function pair(redeem: () => Promise<PairedMachine>) {
    phase = "pair"; content.replaceChildren(el("p", "pairing-progress", "Connecting…"));
    try {
      const machine = await redeem();
      await saved(); if (disposed) return;
      phase = "result";
      const openButton = button("Open it", () => {
        openButton.disabled = true;
        void open(machine).then(() => { if (!disposed) sheet.close(); }).catch(error => {
          if (disposed) return;
          openButton.disabled = false;
          status.textContent = `The host is saved, but couldn't connect: ${errorText(error)}`; status.hidden = false;
        });
      });
      const status = el("p", "pairing-error"); status.hidden = true; status.setAttribute("role", "status");
      const command = el("code", "pairing-command", "herdr");
      content.replaceChildren(el("h3", "", "Connected"), el("p", "", `${machine.label} is saved on this device. If herdr isn't running on that computer yet, start it there:`), command, button("Copy command", () => { void Desk.gramCopyText("herdr").catch(error => { if (!disposed) { status.textContent = errorText(error); status.hidden = false; } }); }), openButton, status);
    } catch (error) { failure("Pairing didn't work", errorText(error)); }
  }
  async function found(text: string) {
    if (disposed || phase !== "scan") return;
    stop();
    // Cheap shape validation happens before showing Connecting. The backend owns
    // authoritative version, address and fingerprint validation and all secrets.
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      if (!value || typeof value !== "object" || !Number.isInteger(value.v) || !Number.isInteger(value.port) || [value.host, value.user, value.token, value.fp].some(field => typeof field !== "string")) throw new Error("not a pairing payload");
    } catch { invalid(); return; }
    await pair(() => Desk.pairMachine(text));
  }
  /** What a pasted or opened code names (Go reads it, nothing is sent), then Connect. */
  function confirm(preview: PairingPreview, redeem: () => Promise<PairedMachine>) {
    if (disposed) return;
    stop(); phase = "confirm"; heading.textContent = "Pair with this computer?";
    const row = (label: string, value: string, cls = "") => { const node = el("div", "pairing-confirm-row"); node.append(el("span", "pairing-confirm-label", label), el("span", `pairing-confirm-value ${cls}`.trim(), value)); return node; };
    const connect = button("Connect", () => { heading.textContent = "Scan to connect"; void pair(redeem); });
    connect.className = "pairing-connect";
    content.replaceChildren(
      el("p", "", "Herdrup adds a key of its own to this computer's SSH login. Check that this is your computer, and that its host key matches the one herdr pair printed."),
      row("Computer", `${preview.user}@${preview.host}`), row("Host key", preview.fingerprint, "pairing-fingerprint"),
      connect, button("Cancel", () => sheet.close()));
    connect.focus();
  }
  async function confirmPasted(text: string) {
    let preview: PairingPreview;
    try { preview = await Desk.inspectPairingCode(text); }
    catch (error) { heading.textContent = "Scan to connect"; failure("Pairing didn't work", errorText(error)); return; }
    confirm(preview, () => Desk.pairMachine(text));
  }
  function paste() {
    if (disposed || phase === "pair") return;
    stop(); phase = "paste"; heading.textContent = "Paste pairing code";
    const field = el("textarea", "pairing-paste"); field.rows = 4; field.spellcheck = false; field.setAttribute("aria-label", "Pairing code");
    field.placeholder = "herdrup://pair#… or the code herdr pair prints";
    const next = button("Continue", () => { const text = field.value.trim(); if (text) void confirmPasted(text); });
    next.disabled = true; field.oninput = () => { next.disabled = field.value.trim() === ""; };
    content.replaceChildren(el("p", "", "Paste the pairing link or code you were given, or the one herdr pair prints on your computer."), field, next, button("Use the camera", () => { heading.textContent = "Scan to connect"; start(); }));
    field.focus();
  }
  function start() {
    if (disposed || phase === "pair") return;
    stop(); phase = "scan";
    const camera = el("div", "pairing-camera"), video = el("video"); video.muted = true; video.playsInline = true; video.autoplay = true;
    video.setAttribute("aria-label", "Pairing code camera");
    const frame = el("div", "pairing-guide"); frame.setAttribute("aria-hidden", "true"); camera.append(video, frame);
    content.replaceChildren(camera, el("p", "", "On your computer, run herdr pair. Point the camera at the code it prints. Both devices must be on the same private network."), pasteButton());
    stopCamera = scanQR(video, text => { void found(text); }, message => failure("Can't use the camera", message));
  }
  // An opened link not paired here is forgotten in Go when the sheet goes.
  sheet.addEventListener("close", () => { disposed = true; stop(); if (offer && phase !== "pair" && phase !== "result") void Desk.discardPairingLink(offer.id).catch(() => {}); if (active === sheet) active = null; sheet.remove(); }, { once: true });
  active = sheet; document.body.append(sheet); sheet.showModal();
  if (offer) confirm(offer.preview, () => Desk.pairOpenedLink(offer.id)); else start();
}

// ---- Pair from another device (pair-v1), this computer as the new device ----
// n2: the choice between another device's approval and herdr pair; n3: the request waiting for that
// device, with the code once it opened it; n4: what was saved and reached; n5: how it ended. The
// card and the result section are host-home parts (hostHome.ts), drawn as the browser's approval
// (web/ownerScreen.ts approvalParts) is: neutral card, status as muted text, capsule buttons.

/** How this computer names itself in the sheet's words: "this Mac", "this PC", "this computer". */
export function thisDevice(platform: string): string {
  if (platform.startsWith("Mac")) return "this Mac";
  if (platform.startsWith("Win")) return "this PC";
  return "this computer";
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Names in a sentence: "a", "a and b", "a, b and c". */
export function nameList(names: readonly string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** m:ss left of seconds. */
export function minutesLeft(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The wait before the next read of a request: every 2 s for its first minute, then every 5 s
 *  (the approver's cadence, account approvalPoll); 2 s while an approved list is being saved; 5 s
 *  while a retry's list may still come; longer after failed reads, to 30 s. null: nothing more to
 *  read. */
export function pairReadDelay(view: PairRequestView, sinceStartMs: number, failures: number): number | null {
  let wait: number;
  switch (view.phase) {
    case "waiting": case "claimed": wait = sinceStartMs < 60_000 ? 2000 : 5000; break;
    case "approved": wait = 2000; break;
    case "done": if (!view.retryOpen) return null; wait = 5000; break;
    default: return null;
  }
  return Math.min(wait * 2 ** Math.min(failures, 4), 30_000);
}

/** Saved machines not tried yet: the connection tries run (Desk.pairRequestConnect). */
export function untried(view: PairRequestView): boolean {
  return view.machines.some(m => m.result === "saved" && !m.reach);
}

/** The page's next step for a request: try the saved machines (connect) or read it again, after
 *  wait ms (never 0: a step that settles nothing can't spin; longer after failures, to 30 s);
 *  null: nothing more to do. */
export function pairNextStep(view: PairRequestView, sinceStartMs: number, failures: number): { connect: boolean; wait: number } | null {
  if (untried(view)) return { connect: true, wait: Math.min(1000 * 2 ** Math.min(failures, 5), 30_000) };
  const wait = pairReadDelay(view, sinceStartMs, failures);
  return wait === null ? null : { connect: false, wait };
}

/** The page's failure count after a read that answered: a list that couldn't be saved yet
 *  (saveFailed) counts as a failed read, so the next one backs off; anything else resets it. */
export function pairFailuresAfter(view: PairRequestView, failures: number): number {
  return view.saveFailed ? failures + 1 : 0;
}

/** What the host home draws for a request: the card (n3 waiting/claimed, n3b approved while its
 *  machines are saved and tried, n5 ended), the result section (n4), or both. */
export function pairLayout(view: PairRequestView): { card: "waiting" | "claimed" | "approved" | "ended" | null; results: boolean } {
  switch (view.phase) {
    case "waiting": return { card: view.code ? "claimed" : "waiting", results: false };
    case "claimed": return { card: "claimed", results: false };
    case "approved": return { card: "approved", results: false };
    case "done": return untried(view) ? { card: "approved", results: false } : { card: null, results: view.machines.length > 0 };
    default: return { card: "ended", results: false };
  }
}

export interface PairChoice {
  /** How many machines the account has that this computer has no key for. */
  count: number;
  /** Whether one of them signs in with a password (it switches to a key here). */
  password: boolean;
  here: string;
  approve(): void;
  qr(): void;
}

/** n2's words and two actions: Approve from another device (filled), Use herdr pair (QR). */
export function pairChoiceParts(choice: PairChoice, qrIcon: HTMLElement | null, close: () => void): HTMLElement[] {
  const machines = choice.count === 1 ? "1 machine" : `${choice.count} machines`;
  const approve = button("Approve from another device", () => { close(); choice.approve(); }); approve.className = "button-filled button-large pairing-choice";
  const qr = button("Use herdr pair (QR)", () => { close(); choice.qr(); }); qr.className = "button-secondary button-large pairing-choice";
  if (qrIcon) { qrIcon.setAttribute("aria-hidden", "true"); qr.prepend(qrIcon); }
  const parts = [
    el("p", "pairing-choice-lead", `${capital(choice.here)} has ${machines} from your account, but no key for them yet. Choose how to add one.`),
    approve, el("p", "pairing-choice-note", `Your iPhone, iPad or Mac adds ${choice.here}'s key to the machines you tick. Nothing to type on the machines.`),
    qr, el("p", "pairing-choice-note", "On each machine run herdr pair, then scan the code it prints."),
  ];
  if (choice.password) parts.push(el("p", "pairing-choice-note pairing-choice-footnote", `Machines that log in with a password switch to a key on ${choice.here}.`));
  return parts;
}

/** n2: the sheet "Pair this device". */
export function showPairChoice(choice: PairChoice, qrIcon: HTMLElement | null) {
  active?.close();
  const sheet = el("dialog", "settings-sheet pairing-sheet pairing-choice-sheet"), header = el("header", "settings-sheet-header"), heading = el("h2", "", "Pair this device");
  heading.id = "pairing-choice-title"; sheet.setAttribute("aria-labelledby", heading.id);
  const cancel = button("Cancel", () => sheet.close()); cancel.className = "button-secondary";
  header.append(heading, cancel);
  const content = el("div", "pairing-content");
  content.append(...pairChoiceParts(choice, qrIcon, () => sheet.close()));
  sheet.append(header, content);
  sheet.addEventListener("close", () => { if (active === sheet) active = null; sheet.remove(); }, { once: true });
  active = sheet; document.body.append(sheet); sheet.showModal();
  return sheet;
}

export interface PairCardActions {
  cancel(): void;
  again(): void;
  qr(): void;
}

/** The card's status line: the spinner and what it waits for, as muted text. */
function pairStatus(spinner: string, text: string) {
  const line = el("div", "host-home-approval-status"); line.setAttribute("role", "status");
  const spin = el("span", "host-home-spinner"); spin.innerHTML = spinner; spin.setAttribute("aria-hidden", "true");
  line.append(spin, text);
  return line;
}

/** The code's four boxes; four faint dots until the approver opened the request. */
function pairDigits(code: string | undefined) {
  const box = el("div", code ? "host-home-code" : "host-home-code host-home-code-none");
  if (code) box.setAttribute("aria-label", `Code ${code.split("").join(" ")}`); else box.setAttribute("aria-hidden", "true");
  for (const d of code || "····") box.append(el("span", "", d));
  return box;
}

/** What went wrong while the request goes on (a list that couldn't be saved yet): muted, read out. */
function pairProblem(text: string) {
  const line = el("p", "host-home-approval-lead host-home-approval-problem", text); line.setAttribute("role", "alert");
  return line;
}

/** n3 and n5: the request as one host-home section, "PAIR THIS MAC". `expiresAt` is when it
 *  expires (ms), `account` the signed-in account's hint. */
export function pairRequestCard(view: PairRequestView, here: string, account: string, spinner: string, expiresAt: number, actions: PairCardActions): HTMLElement[] {
  const card = pairLayout(view).card;
  const { root, rows } = hostSection(`PAIR ${here.toUpperCase()}`, "host-home-approval");
  const head = el("div", "host-home-approval-head"); rows.append(head);
  const title = (text: string) => el("h3", "host-home-approval-title", text);
  const lead = (text: string) => el("p", "host-home-approval-lead", text);
  const approver = view.approver || "your other device";
  if (card === "ended") {
    const again = button("Ask again", actions.again); again.className = "button-filled button-large";
    const qr = button("Use herdr pair (QR)", actions.qr); qr.className = "button-secondary button-large";
    const row = el("div", "host-home-approval-actions"); row.append(again, qr);
    switch (view.phase) {
      case "denied": head.append(title("Not approved"), lead(`${view.approver || "Your other device"} didn't approve ${here}.`)); break;
      case "expired": head.append(title("The request expired"), lead(`No device approved ${here} in 10 minutes.`)); break;
      default: head.append(title(`Couldn't pair ${here}`), pairProblem(view.problem || "Something went wrong."));
    }
    head.append(lead("Ask again for a new code, or pair with herdr pair instead."), row);
    return [root];
  }
  if (card === "approved") {
    const names = view.machines.filter(m => m.result === "saved").map(m => m.label);
    head.append(pairStatus(spinner, names.length ? `Connecting to ${nameList(names)}…` : `${approver} is adding the key…`), title(`Approved on ${approver}`),
      lead(names.length ? `${capital(here)}'s key is on ${nameList(names)}. ${capital(here)} connects to each one now.`
        : `Adding ${here}'s key to the machines you ticked. ${capital(here)} connects to each one as soon as its key is there.`),
      pairDigits(view.code));
    if (view.problem) head.append(pairProblem(view.problem));
    return [root];
  }
  const claimed = card === "claimed";
  head.append(pairStatus(spinner, claimed ? `Opened on ${approver}` : "Waiting for your other device"), title("Approve on your iPhone, iPad or Mac"),
    lead(claimed ? `HerdrUp there asks to pair ${view.device}. Type these 4 digits there.` : `Open HerdrUp there. It asks to pair ${view.device}, and the code to type shows here.`),
    pairDigits(view.code));
  if (view.problem) head.append(pairProblem(view.problem));
  const cancel = button("Cancel", actions.cancel); cancel.className = "button-secondary button-large";
  const left = el("b", "", minutesLeft((expiresAt - Date.now()) / 1000));
  const tick = setInterval(() => { if (!left.isConnected) clearInterval(tick); else left.textContent = minutesLeft((expiresAt - Date.now()) / 1000); }, 1000);
  const expiry = el("span", "host-home-approval-expiry", "Expires in"); expiry.append(left);
  const row = el("div", "host-home-approval-actions"); row.append(cancel, expiry); head.append(row);
  const steps: [string, string][] = [
    ["Open HerdrUp", account ? `On your iPhone, iPad or Mac, signed in as ${account}.` : "On your iPhone, iPad or Mac, signed in to your account."],
    [`Pair ${view.device}?`, `Opens by itself and names ${here}.`],
    [view.code ? `Type ${view.code}` : "Type the code", "Then tick the machines and Approve."],
  ];
  for (const [i, [name, rest]] of steps.entries()) {
    const step = el("div", "host-home-row host-home-step");
    step.append(hostRowIcon(String(i + 1)), hostRowLines(name, rest));
    rows.append(step);
  }
  return [root, el("p", "host-home-note", `${capital(here)} made its own key. Your machines accept it only after you approve it.`)];
}

export interface PairResultActions {
  open(id: string): void;
  qr(): void;
  /** The saved host's menu (Edit, Delete), at x, y. */
  menu(id: string, x: number, y: number): void;
}

/** A machine the approver couldn't add, as the account's row under FROM YOUR ACCOUNT says it. */
export function notAddedLine(view: PairRequestView, m: PairRequestMachine): string {
  return `${view.approver || "Your other device"} couldn't add the key${m.reason ? `: ${m.reason}` : ""}`;
}

/** The saved profile a result row opens (its id now), joined by the profile id the save gave it
 *  and the address it saved it at (the result's), so a profile saved since at the same address,
 *  or the same profile edited to another one, is not the result's; null when the result saved
 *  none or its profile is gone or changed. Before the saved list is known (null), the result's
 *  own id. */
export function pairResultTarget(m: PairRequestMachine, saved: readonly SavedMachine[] | null): string | null {
  if ((m.result !== "saved" && m.result !== "kept") || m.reach === "removed" || m.reach === "changed" || !m.profileId) return null;
  if (saved === null) return m.id ?? null;
  return saved.find(s => s.localId === m.profileId && s.user === m.user && s.host === m.host && s.port === m.port)?.id ?? null;
}

/** n4: "PAIRED BY ‹APPROVER›", one row per machine of the list: saved ones open, with the saved
 *  host's menu (Edit, Delete); one this computer can't reach is dimmed with "Join its network to
 *  connect" and Use herdr pair; one it kept, couldn't save or no longer has says why. A machine
 *  the approver couldn't add shows here only when the account doesn't list it (`synced`): the
 *  account's row says it then. `saved`: the machines saved here now; null before they are known. */
export function pairResultSection(view: PairRequestView, here: string, synced: readonly SyncedMachine[], saved: readonly SavedMachine[] | null, glyphs: { machine(): HTMLElement; chevron(): HTMLElement }, spinner: string, actions: PairResultActions): HTMLElement[] {
  const { root, rows } = hostSection(`PAIRED BY ${(view.approver || "your other device").toUpperCase()}`, "host-home-paired");
  const away: string[] = [];
  for (const m of view.machines) {
    if (m.result === "failed" && synced.some(s => s.id === m.syncedId)) continue;
    // A machine saved here opens from its row (a dimmed one too, once its network is joined) and
    // has the saved host's menu; the rest only say why. Use herdr pair sits beside the row's
    // button, not in it.
    const id = pairResultTarget(m, saved);
    const gone = (m.result === "saved" || m.result === "kept") && id === null;
    const changed = gone && (m.reach === "changed" || (saved?.some(s => s.localId === m.profileId) ?? false));
    let second: string, value: HTMLElement | null = null, off = false, pair = false;
    switch (gone ? "gone" : m.result) {
      case "gone": second = changed ? `Changed on ${here} since it was saved` : `No longer saved on ${here}`; off = true; break;
      case "saved":
        if (m.reach === "online") { second = `${m.user}@${m.host}`; value = hostRowValue("Online"); }
        else if (m.reach === "unreachable") { second = "Join its network to connect"; off = pair = true; away.push(m.label); }
        else if (m.reach === "refused") { second = m.problem || "It refused this connection."; off = true; }
        else { second = `${m.user}@${m.host}`; value = hostRowValue("Connecting…"); }
        break;
      case "kept": second = `Already saved on ${here}, kept as it was`; break;
      case "pin_differs": second = `Not saved: ${here} knows another host key for it`; off = true; break;
      default: second = notAddedLine(view, m); off = true;
    }
    const row = el("div", "host-home-row host-home-paired-row");
    const body = id ? button("", () => actions.open(id)) : el("span", "");
    if (id) {
      body.oncontextmenu = event => { event.preventDefault(); actions.menu(id, event.clientX, event.clientY); };
      body.onkeydown = event => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault(); const rect = body.getBoundingClientRect(); actions.menu(id, rect.left + 20, rect.bottom);
      };
    }
    body.className = off ? "host-home-paired-body host-home-row-off" : "host-home-paired-body";
    body.append(hostRowIcon(glyphs.machine()), hostRowLines(m.label, second));
    if (value) body.append(value);
    if (id && !pair) body.append(m.reach ? hostRowChevron(glyphs.chevron()) : hostRowChevron(null, spinner));
    row.append(body);
    if (pair) { const qr = button("Use herdr pair", actions.qr); qr.className = "host-home-pair-synced"; row.append(qr); }
    rows.append(row);
  }
  // The list's problem shows even when no row does (each one the account's row says).
  const out = rows.childElementCount ? [root] : [];
  if (away.length) out.push(el("p", "host-home-note", `${nameList(away)} ${away.length === 1 ? "is" : "are"} on another network. Join it from ${here} (same Wi-Fi or Tailscale), then open ${away.length === 1 ? away[0] : "them"}. Nothing to approve again.`));
  if (view.problem) { const problem = el("p", "host-home-note"); problem.textContent = view.problem; problem.setAttribute("role", "status"); out.push(problem); }
  return out;
}
