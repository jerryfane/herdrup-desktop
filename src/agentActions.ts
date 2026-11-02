// The sheets behind the agent menus (Desk.agentMenu on a row, Desk.paneMenu
// on the agent page), as herdrup presents them: Rename agent, Restart agent?
// and Swap subscription? (App/HerdrApp.swift agentActions 3432-3500), the
// avatar sheet with its Move and scale crop (App/AgentAvatarViews.swift
// 288-620) and Switch harness (App/AgentSessionTransferSheet.swift). Go
// builds the menus; a row item that needs one of these sends
// events.agentActionRequested, and the page answers it here.
import { Desk, events, type AgentAction, type AvatarChoice, type Row } from "./mygo";
import { avatarFace, MASCOTS, mascotName, mascotURL } from "./avatars";
import {
  agentFrom, AVATAR_PIXEL_SIZE, clampZoom, CROP_VIEWPORT, dragOffset, encodeWithinLimit, existingTransfer, harnessDisplayName,
  integralCropRect, renameField, transferPhaseIsConclusive, transferPhaseIsTerminal, workingSize,
  type TransferAgent, type TransferInfo,
} from "./agentActionsModel";
import "./agentActions.css";

/** What the sheets borrow from the Agents list (main.ts). */
export interface AgentActionDeps {
  /** The roster row of a pane on the shown board. */
  row(paneID: string): Row | undefined;
  /** The row's initial tile (AgentInitialTile). */
  tile(r: Row): HTMLElement;
  /** The row's status badge, null for none. */
  badge(r: Row): Promise<HTMLElement | null>;
  /** Places the initials of the tiles under root once they are laid out. */
  placeInitials(root: ParentNode): Promise<void>;
  symbol(name: string, size: number, weight: string): Promise<HTMLElement>;
}
let deps: AgentActionDeps;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node;
}
function button(text: string, cls: string, run: () => void) {
  const node = el("button", cls, text); node.type = "button"; node.onclick = run; return node;
}
/** A failed Desk call's text: mygo rejects with a CallError whose message
 * is Go's error. */
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

/** herdrup's roster perform() (HerdrApp.swift 2249-2257) discloses a failed
 * action as "couldn't <verb> <title>: <error>"; the desktop shows it as the
 * native alert Go uses for Stop and Archive. */
async function perform(verb: string, title: string, op: () => Promise<unknown>) {
  try { await op(); }
  catch (error) { void Desk.alertAgentFailure(`Couldn't ${verb} ${title}`, failure(error)); }
}

/** A sheet: a header with leading and trailing toolbar slots around the
 * title, over a scrolling body. It removes itself once closed. */
function sheet(cls: string) {
  const dialog = el("dialog", `agent-sheet ${cls}`);
  const header = el("header"), leading = el("div", "leading"), title = el("h2"), trailing = el("div", "trailing");
  header.append(leading, title, trailing);
  dialog.append(header);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  return { dialog, leading, title, trailing };
}

/** The row menu's confirmation (SwiftUI confirmationDialog): the title,
 * its message, Cancel and the destructive action. Resolves true when the
 * action was chosen. */
function confirmAction(title: string, message: string, action: string): Promise<boolean> {
  const dialog = el("dialog", "folder-naming agent-confirm");
  const buttons = el("div", "buttons");
  let chosen = false;
  buttons.append(button("Cancel", "ghost", () => dialog.close()), button(action, "destructive", () => { chosen = true; dialog.close(); }));
  dialog.append(el("h2", "", title), el("p", "", message), buttons);
  document.body.append(dialog);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  dialog.addEventListener("close", () => { dialog.remove(); resolve(chosen); });
  dialog.showModal();
  return promise;
}

/** RenameSheet for an agent (HerdrApp.swift 3566-3586, 9585-9655): AGENT
 * NAME, normalised to herdr's grammar with "Will be saved as" when that
 * changes it, Save and Cancel. Saving renames, then Go refreshes the folder
 * and star membership the server moved to the new name. */
function renameAgent(action: AgentAction) {
  const { dialog, leading, title } = sheet("agent-rename-sheet");
  title.textContent = "Rename agent";
  leading.append(button("Cancel", "dim", () => dialog.close()));
  const form = el("form", "agent-sheet-body agent-rename");
  const input = el("input");
  input.placeholder = "e.g. planner"; input.value = action.name;
  input.autocapitalize = "off"; input.autocomplete = "off"; input.spellcheck = false;
  input.setAttribute("aria-label", "Agent name");
  const preview = el("p", "agent-rename-preview");
  const save = el("button", "agent-rename-save", "Save"); save.type = "submit";
  form.append(el("label", "agent-micro-label", "AGENT NAME"), input, preview,
    el("p", "agent-rename-footnote", "Lowercase letters, digits, - and _. Another agent can then read this one by name."), save);
  const update = () => {
    const field = renameField(input.value);
    preview.textContent = `Will be saved as ${field.effective}`; preview.hidden = !field.showPreview;
    save.disabled = !field.canSave;
  };
  input.addEventListener("input", update); update();
  form.addEventListener("submit", event => {
    event.preventDefault();
    const field = renameField(input.value);
    if (!field.canSave) return;
    dialog.close();
    void perform("rename", action.title, () => Desk.renameAgent(action.paneID, field.effective));
  });
  dialog.append(form);
  dialog.showModal();
  input.select();
}

/** Restart agent? (HerdrApp.swift 3434-3452): a plain agent.restart, no
 * account. */
async function restartAgent(action: AgentAction) {
  if (!await confirmAction("Restart agent?", `Interrupts ${action.title}'s current turn. Its session is preserved and reopened with --resume.`, "Restart")) return;
  await perform("restart", action.title, () => Desk.restartAgent(action.paneID, ""));
}

/** Swap subscription? (HerdrApp.swift 3453-3473): agent.restart on the
 * chosen account. */
async function swapSubscription(action: AgentAction) {
  const account = action.account;
  if (!account) return;
  if (!await confirmAction("Swap subscription?",
    `Switches ${action.title} to ${account.label} and restarts it. This interrupts its current turn. The session is reopened with --resume on the new subscription.`, "Swap")) return;
  await perform("swap", action.title, () => Desk.restartAgent(action.paneID, account.id));
}

/** An avatar at a diameter as herdrup's AgentAvatar draws it: the face with
 * the row's status badge on top (the badge keeps its size). */
async function avatarWithBadge(r: Row, face: HTMLElement, size: number) {
  const a = el("div", "avatar");
  a.style.setProperty("--avatar-size", `${size}px`);
  a.append(face);
  const b = await deps.badge(r);
  if (b) a.append(b);
  return a;
}

/** Bytes as base64, in chunks small enough for String.fromCharCode. */
function base64(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** AgentAvatarSheet (AgentAvatarViews.swift 288-459): the agent at 96 pt,
 * "Use default" and the twelve mascots, Choose photo (cropped in Move and
 * scale), Remove photo while a photo is set, and Done. Every choice applies
 * at once through Desk.setAgentAvatar. Opened from the row menu and from the
 * agent page's ••• menu. */
export function openAvatarSheet(paneID: string, name: string) {
  const r = deps.row(paneID);
  if (!r) return;
  const { dialog, leading, title, trailing } = sheet("agent-avatar-sheet");
  // The appearance shown as current: the row's, then this sheet's own
  // choices as they apply (AgentAvatarDirectory's pending change).
  let current: { kind: string; mascot?: string; photo?: string } = { kind: r.avatar?.kind ?? "initial", mascot: r.avatar?.mascot };
  let loadingPhoto = false;
  const face = () => current.photo
    ? Object.assign(el("img", "face preview"), { src: current.photo, alt: "" })
    : avatarFace(current.kind === "initial" ? undefined : current.kind === "image" ? r.avatar : { kind: "mascot", mascot: current.mascot }, () => deps.tile(r));

  // Which screen is drawn: the sheet or the crop. A sheet still rendering
  // after the crop opened (or a newer render) draws nothing.
  let screen = 0;
  const main = async () => {
    const at = ++screen;
    const body = el("div", "agent-avatar-body");
    const hero = await avatarWithBadge(r, face(), 96);
    const grid = el("div", "agent-avatar-grid");
    // choiceCell (AgentAvatarViews.swift 376-393): the face ringed in text
    // when selected, the label under it.
    const choice = (label: string, aria: string, selected: boolean, faceNode: HTMLElement, run: () => void) => {
      const cell = button("", "agent-avatar-choice", run);
      cell.setAttribute("aria-label", aria); cell.setAttribute("aria-pressed", String(selected));
      const ring = el("span", "ring"); ring.append(faceNode);
      cell.append(ring, el("span", "", label));
      return cell;
    };
    grid.append(choice("Use default", `Use default, ${r.initial}`, current.kind === "initial", deps.tile(r), () => apply(null)));
    for (const mascot of MASCOTS) {
      const img = Object.assign(el("img", "face mascot"), { src: mascotURL(mascot), alt: "" });
      grid.append(choice(mascotName(mascot), mascotName(mascot), current.kind === "mascot" && current.mascot === mascot, img,
        () => apply({ kind: "mascot", mascot })));
    }
    const actions = el("div", "agent-avatar-actions");
    const choose = button("", "choose", () => picker.click());
    choose.disabled = loadingPhoto;
    choose.append(loadingPhoto ? el("span", "ring") : await deps.symbol("photo.on.rectangle", 15, "semibold"), "Choose photo");
    actions.append(choose);
    if (current.kind === "image") actions.append(button("Remove photo", "remove", () => apply(null)));
    body.append(hero, grid, actions);
    if (error) body.append(Object.assign(el("p", "agent-avatar-error", error), { role: "alert" }));
    body.append(el("p", "agent-avatar-note", "Guests you share this agent with will see this picture."));
    if (at !== screen) return;
    title.textContent = name;
    leading.replaceChildren();
    trailing.replaceChildren(button("Done", "", () => dialog.close()));
    dialog.querySelector(":scope > .agent-avatar-body")?.remove();
    dialog.append(body);
    void deps.placeInitials(body);
  };

  let error = "";
  // apply (AgentAvatarViews.swift 423-432): the error clears, the choice
  // applies, and a refusal reads "Couldn't change the picture: …" (Go
  // returns herdrup's describe() text).
  const apply = (choice: AvatarChoice | null, photo?: string) => {
    error = "";
    void Desk.setAgentAvatar(paneID, choice ?? { kind: "default" }).then(() => {
      current = choice === null ? { kind: "initial" } : choice.kind === "mascot" ? { kind: "mascot", mascot: choice.mascot } : { kind: "image", photo };
    }, reason => { error = `Couldn't change the picture: ${failure(reason)}`; }).finally(() => { if (dialog.open && !cropping) void main(); });
    void main();
  };

  // Choose photo: the system file panel, then the photo decoded upright and
  // at most 1600 px on its longest edge (AgentAvatarPhoto.downsampled,
  // AgentAvatarViews.swift 566-579; load, 434-444).
  let cropping = false;
  const picker = Object.assign(el("input"), { type: "file", accept: "image/*", hidden: true });
  dialog.append(picker);
  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (!file) return;
    loadingPhoto = true; void main();
    let work: HTMLCanvasElement | null = null;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const size = workingSize(bitmap.width, bitmap.height);
      work = Object.assign(el("canvas"), size);
      work.getContext("2d")!.drawImage(bitmap, 0, 0, size.width, size.height);
      bitmap.close();
    } catch { work = null; }
    loadingPhoto = false;
    if (!dialog.open) return;
    if (!work) { error = "That photo couldn't be read."; void main(); return; }
    error = "";
    crop(work);
  });

  // AgentAvatarCropView (AgentAvatarViews.swift 470-560): drag to move,
  // pinch (or the wheel) to zoom from 1 to 6, the crop shown in the 280 pt
  // square and as the 72 and 44 pt avatars; Use photo uploads the crop at
  // 256 px as JPEG within 64 KiB (normalised, 609-620).
  const crop = (work: HTMLCanvasElement) => {
    cropping = true; screen++;
    let zoom = 1, offset = { x: 0, y: 0 }, failed = false;
    const back = button("", "back", () => { cropping = false; void main(); });
    back.setAttribute("aria-label", "Back");
    void deps.symbol("chevron.left", 17, "semibold").then(glyph => back.prepend(glyph));
    back.append(name);
    const use = button("Use photo", "", async () => {
      const rect = integralCropRect(work.width, work.height, zoom, offset.x, offset.y);
      const out = Object.assign(el("canvas"), { width: AVATAR_PIXEL_SIZE, height: AVATAR_PIXEL_SIZE });
      out.getContext("2d", { alpha: false })!.drawImage(work, rect.x, rect.y, rect.width, rect.height, 0, 0, AVATAR_PIXEL_SIZE, AVATAR_PIXEL_SIZE);
      use.disabled = true;
      const data = await encodeWithinLimit(async quality => {
        const { promise, resolve } = Promise.withResolvers<Blob | null>();
        out.toBlob(resolve, "image/jpeg", quality);
        const blob = await promise;
        return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
      });
      use.disabled = false;
      if (!data) { failed = true; draw(); return; }
      cropping = false;
      const encoded = base64(data);
      apply({ kind: "image", imageBase64: encoded, mime: "image/jpeg" }, `data:image/jpeg;base64,${encoded}`);
    });
    title.textContent = "Move and scale";
    leading.replaceChildren(back); trailing.replaceChildren(use);

    const body = el("div", "agent-avatar-body agent-crop-body");
    const square = el("div", "agent-crop"), view = el("canvas"), circle = el("div", "agent-crop-circle");
    square.append(view, circle);
    const small = [el("canvas"), el("canvas")] as const;
    const previews = el("div", "agent-crop-previews");
    const problem = el("p", "agent-avatar-error", "That photo couldn't be made small enough.");
    const scale = Math.min(3, Math.max(1, Math.round(devicePixelRatio)));
    const paint = (canvas: HTMLCanvasElement, points: number) => {
      canvas.width = canvas.height = points * scale;
      const rect = integralCropRect(work.width, work.height, zoom, offset.x, offset.y);
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(work, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
    };
    const draw = () => { paint(view, CROP_VIEWPORT); paint(small[0], 72); paint(small[1], 44); problem.hidden = !failed; };
    void Promise.all([
      avatarWithBadge(r, Object.assign(small[0], { className: "face preview" }), 72),
      avatarWithBadge(r, Object.assign(small[1], { className: "face preview" }), 44),
    ]).then(nodes => previews.append(...nodes));
    body.append(square, previews, problem, el("p", "agent-crop-hint", "Drag to move, pinch to zoom."));
    draw();

    let drag: { id: number; x: number; y: number; start: { x: number; y: number } } | null = null;
    square.addEventListener("pointerdown", event => {
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: offset };
      square.setPointerCapture(event.pointerId); square.classList.add("dragging");
    });
    square.addEventListener("pointermove", event => {
      if (drag?.id !== event.pointerId) return;
      offset = dragOffset(drag.start, event.clientX - drag.x, event.clientY - drag.y, CROP_VIEWPORT, work.width, work.height, zoom);
      draw();
    });
    const release = (event: PointerEvent) => { if (drag?.id === event.pointerId) { drag = null; square.classList.remove("dragging"); } };
    square.addEventListener("pointerup", release);
    square.addEventListener("pointercancel", release);
    // A trackpad pinch arrives as ctrl+wheel (Chromium, WebKitGTK) or as
    // WebKit's gesture events (macOS); a mouse wheel zooms too.
    square.addEventListener("wheel", event => {
      event.preventDefault();
      zoom = clampZoom(zoom * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)));
      draw();
    }, { passive: false });
    let pinchStart = 1;
    square.addEventListener("gesturestart", event => { event.preventDefault(); pinchStart = zoom; });
    square.addEventListener("gesturechange", event => {
      event.preventDefault();
      // WebKit's GestureEvent, which lib.dom does not declare.
      if ("scale" in event && typeof event.scale === "number") { zoom = clampZoom(pinchStart * event.scale); draw(); }
    });
    dialog.querySelector(":scope > .agent-avatar-body")?.remove();
    dialog.append(body);
  };

  void main().then(() => dialog.showModal());
}

function sleep(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** AgentSessionTransferSheet (App/AgentSessionTransferSheet.swift): prepare
 * (non-destructive) → review the visible-message and omission counts →
 * confirm, then follow the durable transfer state on agent.list until it is
 * final. Closing never cancels the transaction; reopening adopts it. */
async function switchHarness(action: AgentAction) {
  const to = action.target, from = action.source;
  if (!to || !from) return;
  const paneID = action.paneID;
  let terminalID = action.terminalID;
  let source = from, target = to.id;
  const accountsJSON = await Desk.transferAccounts().catch(() => "");
  // accounts.list as Go passes it on.
  const reply: { accounts?: { id: string; kind: string; label: string; active: boolean }[] } = accountsJSON ? JSON.parse(accountsJSON) : {};
  const accounts = reply.accounts ?? [];
  const opened = agentFrom(await Desk.transferAgentInfo(paneID, terminalID).catch(() => ""));
  if (opened?.terminal_id) terminalID = opened.terminal_id;
  // init (AgentSessionTransferSheet.swift 23-49): an unfinished transfer in this direction is adopted.
  let transfer: TransferInfo | null = existingTransfer(opened, source, target);
  let selectedAccountID = transfer?.target_account ?? "";
  let sourceStatus: string | null | undefined = opened?.agent_status;
  let busy = false, errorText: string | null = null, closed = false;

  const { dialog, leading, title } = sheet("agent-transfer-sheet");
  title.textContent = "Switch harness";
  leading.append(button("Close", "dim", () => dialog.close()));
  dialog.addEventListener("close", () => { closed = true; });
  const body = el("div", "agent-transfer-body"), bar = el("div", "agent-transfer-bar");
  dialog.append(body, bar);

  const targetAccounts = () => accounts.filter(account => account.kind === target);
  const selectedAccount = () => selectedAccountID === "" ? undefined : selectedAccountID;
  // selectedAccountLabel (59-64).
  const selectedAccountLabel = () => {
    const id = transfer?.target_account ?? selectedAccount();
    if (!id) return `Default ${harnessDisplayName(target)} account`;
    return targetAccounts().find(account => account.id === id)?.label ?? id;
  };
  const sourceIsIdle = () => sourceStatus === "idle";

  /** A span the symbol is drawn into once it renders, so it keeps its place. */
  const glyphBox = (cls: string, name: string, size: number) => {
    const box = el("span", cls); void deps.symbol(name, size, "semibold").then(glyph => box.append(glyph)); return box;
  };
  // harnessBadge (129-147): the harness's identity tile and its name.
  const harnessBadge = (harness: string) => {
    const badge = el("span", "agent-harness");
    const tint = harness.includes("claude") ? 1 : harness.includes("codex") ? 2 : harness.includes("gemini") ? 3 : 0;
    const glyph = harness.includes("claude") ? "\u2731" : harness.includes("codex") ? "C" : harness.includes("gemini") ? "\u2726" : harness.trim().charAt(0).toUpperCase() || "?";
    badge.append(el("span", `glyph tint-${tint}`, glyph), harnessDisplayName(harness));
    return badge;
  };
  // infoPanel (366-381), progressPanel (383-396), outcomePanel (398-415).
  const panel = (large: boolean, icon: HTMLElement, heading: string, text: string) => {
    const node = el("div", large ? "agent-panel large" : "agent-panel"), lines = el("div", "lines");
    lines.append(el("strong", "", heading), el("span", "", text));
    node.append(icon, lines);
    return node;
  };
  const infoPanel = (icon: string, heading: string, text: string) => panel(false, glyphBox("icon working", icon, 16), heading, text);
  const progressPanel = (heading: string, text: string) => panel(true, el("span", "ring"), heading, text);
  const outcomePanel = (icon: string, tone: string, heading: string, text: string) => panel(true, glyphBox(`icon ${tone}`, icon, 19), heading, text);
  const reviewRow = (label: string, value: string, strong: boolean) => {
    const row = el("div", "agent-review-row");
    row.append(el("span", "", label), el("span", strong ? "strong" : "", value));
    return row;
  };

  // targetReadinessText (424-435) and rollbackReadinessText (437-448).
  const targetReadinessText = () => {
    const s = harnessDisplayName(source);
    switch (target) {
      case "claude": return `Herdr is waiting for Claude Code's official integration to report the exact staged session. A mismatch restores ${s}.`;
      case "codex": return "Herdr is binding the exact Codex resume session and PID, then rereading the native target JSONL. The JSONL is the proof; the short observation window is not. Codex's later official report must still match.";
      case "omp": return "Herdr is binding the exact OMP session path, active leaf, and PID, then rereading the native target tree. The transcript is the proof; the short observation window is not.";
      default: return `Herdr cannot verify the unrecognised target harness ${target}.`;
    }
  };
  const rollbackReadinessText = () => {
    switch (source) {
      case "claude": return "The target did not take verified ownership. Herdr is reopening the original Claude Code session and waiting for its official session report.";
      case "codex": return "The target did not take verified ownership. Herdr is reopening the exact original Codex session and verifying its native JSONL against that session's PID.";
      case "omp": return "The target did not take verified ownership. Herdr is reopening the exact original OMP session path and verifying its active leaf and native tree against that session's PID.";
      default: return `The target did not take verified ownership. Herdr cannot automatically verify rollback for the unrecognised source harness ${source}.`;
    }
  };

  const render = () => {
    if (closed) return;
    const s = harnessDisplayName(source), t = harnessDisplayName(target);
    // directionHeader (110-127).
    const direction = el("div", "agent-transfer-direction"), harnesses = el("div", "agent-transfer-harnesses");
    harnesses.append(harnessBadge(source), glyphBox("", "arrow.right", 15), harnessBadge(target));
    direction.append(harnesses, el("h3", "agent-transfer-title", action.title),
      el("p", "agent-transfer-text", `Continue the same agent, pane, name, folder, and visible conversation in ${t}.`));
    const nodes: HTMLElement[] = [direction];
    if (!transfer) {
      // setup (149-180).
      const setup = el("div", "agent-transfer-section");
      const picker = el("select");
      picker.setAttribute("aria-label", "Target account");
      picker.append(Object.assign(el("option", "", `Default ${t} account`), { value: "" }));
      for (const account of targetAccounts()) picker.append(Object.assign(el("option", "", account.label + (account.active ? "" : " · exhausted")), { value: account.id }));
      picker.value = selectedAccountID;
      picker.onchange = () => { selectedAccountID = picker.value; };
      setup.append(el("p", "agent-transfer-label", "TARGET ACCOUNT"), picker,
        infoPanel("shield.lefthalf.filled", `Preparation does not stop ${s}`,
          `Herdr reads the source once, creates a native ${t} session, and rereads the destination file. You confirm only after the counts are ready.`));
      if (!sourceIsIdle()) {
        setup.append(infoPanel("hourglass", "Wait for this turn to finish",
          `The transcript must be still while Herdr verifies it. ${action.title} is ${sourceStatus ?? "not idle"} right now.`));
      }
      nodes.push(setup);
    } else {
      // transferStatus (183-234).
      switch (transfer.phase) {
        case "preparing": nodes.push(progressPanel(`Preparing ${t}`, `Reading and verifying both native transcripts. ${s} is still live.`)); break;
        case "ready": nodes.push(readyReview(transfer, s)); break;
        case "verifying_cutover": nodes.push(progressPanel("Rechecking both transcripts", `${s} is still live while Herdr verifies that the reviewed source and destination files are unchanged.`)); break;
        case "launching_target": case "awaiting_target": nodes.push(progressPanel(`Switching to ${t}`, targetReadinessText())); break;
        case "rolling_back": nodes.push(progressPanel(`Restoring ${s}`, rollbackReadinessText())); break;
        case "completed": nodes.push(outcomePanel("checkmark.circle.fill", "done", `Now running in ${t}`, "The verified target owns the same pane. You can continue the conversation there.")); break;
        case "rolled_back": nodes.push(outcomePanel("arrow.uturn.backward.circle.fill", "waiting", `Restored ${s}`, transfer.error ?? "The target could not be verified, so Herdr restored the original session and account.")); break;
        case "failed": nodes.push(outcomePanel("exclamationmark.triangle.fill", "died", "Transfer failed", transfer.error ?? "Herdr refused the transfer. Check the agent before trying again.")); break;
        default: nodes.push(outcomePanel("questionmark.circle.fill", "waiting", "Unknown transfer state", `The daemon reported ${transfer.phase}. Update herdrup before deciding whether the harness changed.`));
      }
    }
    // errorPanel (417-422).
    if (errorText) nodes.push(outcomePanel("exclamationmark.triangle.fill", "died", "Could not verify the transfer", errorText));
    body.replaceChildren(...nodes);
    bar.replaceChildren(actionButton());
  };

  // readyReview (236-276).
  const readyReview = (info: TransferInfo, s: string) => {
    const section = el("div", "agent-transfer-section");
    const review = el("div", "agent-review");
    review.append(reviewRow("Visible messages", String(info.message_count ?? 0), true), reviewRow("Target account", selectedAccountLabel(), true));
    const omissions = el("div", "agent-review"), o = info.omissions ?? {};
    for (const [label, count] of [["Tool records", o.tool_records], ["Reasoning records", o.reasoning_records], ["System records", o.system_records],
      ["Attachments", o.attachment_records], ["Metadata records", o.metadata_records], ["Unsupported blocks", o.unsupported_blocks],
      ["Sidechain records", o.sidechain_records]] as const) omissions.append(reviewRow(label, String(count ?? 0), (count ?? 0) > 0));
    section.append(outcomePanel("checkmark.shield.fill", "done", "Ready to switch",
      `${s} is still live. Confirming interrupts it only after Herdr rechecks that both verified files are unchanged.`),
    review, el("p", "agent-transfer-label", "NOT CARRIED INTO THE VISIBLE CHAT"), omissions,
    el("p", "agent-transfer-foot", "Only visible user and assistant text is translated. The source transcript is never modified."));
    return section;
  };

  // actionBar (279-315) and primaryButton (317-337).
  const actionButton = () => {
    const primary = (label: string, icon: string | null, disabled: boolean, run: () => void) => {
      const node = button("", "", run);
      node.disabled = disabled;
      if (disabled && busy) node.append(el("span", "ring"));
      if (icon) node.append(glyphBox("", icon, 15));
      node.append(label);
      return node;
    };
    const t = harnessDisplayName(target);
    if (!transfer) return primary(busy ? "Preparing…" : "Prepare transfer", busy ? null : "arrow.triangle.2.circlepath", busy || !sourceIsIdle(), () => { void prepare(); });
    if (transfer.phase === "ready") return primary(busy ? "Confirming…" : `Confirm switch to ${t}`, busy ? null : "arrow.right.circle.fill", busy, () => { void confirm(); });
    if (transfer.phase === "completed") return primary(`Switch back to ${harnessDisplayName(transfer.source)}`, "arrow.uturn.backward.circle.fill", false, beginReverseTransfer);
    if (transfer.phase === "rolled_back") return primary("Try switch again", "arrow.clockwise", false, retryRolledBackTransfer);
    if (transferPhaseIsTerminal(transfer.phase)) return primary("Close", null, false, () => dialog.close());
    return primary("Transfer in progress…", null, true, () => {});
  };

  /** The agent.list entry for this agent: by pane, or by terminal id. */
  const listed = async () => agentFrom(await Desk.transferAgentInfo(paneID, terminalID));

  // synchronizeTransfer (618-628).
  const synchronizeTransfer = (durable: TransferInfo, agentStatus: string | null | undefined) => {
    source = durable.source; target = durable.target;
    selectedAccountID = durable.target_account ?? "";
    sourceStatus = agentStatus; transfer = durable;
  };

  // beginReverseTransfer (451-462) and retryRolledBackTransfer (464-473).
  function beginReverseTransfer() {
    if (transfer?.phase !== "completed") return;
    const done = transfer;
    source = done.target; target = done.source;
    selectedAccountID = ""; transfer = null; errorText = null; busy = false; sourceStatus = null;
    render(); void pollSourceUntilIdle();
  }
  function retryRolledBackTransfer() {
    if (transfer?.phase !== "rolled_back") return;
    selectedAccountID = ""; transfer = null; errorText = null; busy = false; sourceStatus = null;
    render(); void pollSourceUntilIdle();
  }

  // prepare (475-503).
  const prepare = async () => {
    if (!sourceIsIdle()) return;
    busy = true; errorText = null; render();
    try {
      const updated = agentFrom(await Desk.prepareSessionTransfer(paneID, target, selectedAccount() ?? ""));
      const info = updated?.session_transfer;
      if (!info) throw new Error("Herdr returned no session-transfer state. The source was not treated as switched.");
      synchronizeTransfer(info, updated.agent_status); render();
      await pollTransfer(info.id);
    } catch (error) {
      const transportError = failure(error);
      if (await adoptDurableTransfer(null, false) && transfer) {
        const recovered = transfer;
        errorText = null;
        if (recovered.phase === "ready") busy = false;
        else { render(); await pollTransfer(recovered.id); }
        render(); return;
      }
      busy = false; errorText = transportError; render();
    }
  };

  // confirm (505-545).
  const confirm = async () => {
    const current = transfer;
    if (!current || current.phase !== "ready") return;
    busy = true; errorText = null; render();
    try {
      const updated = agentFrom(await Desk.confirmSessionTransfer(paneID, current.target, current.target_account ?? "", current.id));
      const info = updated?.session_transfer;
      if (!info) throw new Error("Herdr returned no session-transfer state. The source was not treated as switched.");
      synchronizeTransfer(info, updated.agent_status); render();
      await pollTransfer(info.id);
    } catch (error) {
      const transportError = failure(error);
      if (await adoptDurableTransfer(current.id, true) && transfer) {
        const recovered = transfer;
        if (recovered.id !== current.id) { busy = false; render(); return; }
        if (recovered.phase === "ready") {
          busy = false;
          errorText = "Herdr still reports this transfer as ready, so confirmation was not observed. You can confirm the same transaction again.";
        } else if (transferPhaseIsTerminal(recovered.phase)) {
          busy = false; errorText = null;
        } else {
          errorText = null; render(); await pollTransfer(recovered.id);
        }
        render(); return;
      }
      busy = false; errorText = transportError; render();
    }
  };

  // adoptDurableTransfer (547-568).
  const adoptDurableTransfer = async (expectedID: string | null, includeTerminal: boolean) => {
    try {
      const updated = await listed();
      const durable = updated?.session_transfer;
      if (!durable || (!includeTerminal && transferPhaseIsConclusive(durable.phase))) return false;
      synchronizeTransfer(durable, updated.agent_status);
      if (expectedID !== null && durable.id !== expectedID) {
        busy = false;
        errorText = "A different transfer replaced this transaction. Review the durable state shown here before taking another action.";
      }
      return true;
    } catch { return false; }
  };

  // pollTransfer (570-594): every 0.3 s, up to 400 times.
  const pollTransfer = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      if (closed) return;
      if (transfer) {
        if (transfer.id !== id || transfer.phase === "ready" || transferPhaseIsTerminal(transfer.phase)) { busy = false; render(); return; }
      }
      await refreshTransfer(id);
      render();
      await sleep(300);
    }
    busy = false;
    errorText = "Herdr has not reported a final state. Close and reopen this sheet to check the same transaction. Do not assume the harness changed.";
    render();
  };

  // refreshTransfer (596-616): a dropped poll keeps the last verified phase.
  const refreshTransfer = async (id: string) => {
    try {
      const updated = await listed();
      const durable = updated?.session_transfer;
      if (!durable) return;
      if (durable.id !== id) {
        synchronizeTransfer(durable, updated.agent_status);
        busy = false;
        errorText = "A different transfer replaced this transaction. Close and reopen to review the current one.";
        return;
      }
      synchronizeTransfer(durable, updated.agent_status);
      if (transferPhaseIsTerminal(durable.phase)) errorText = null;
    } catch { /* A daemon restart can drop a poll; the deadline above reports prolonged silence. */ }
  };

  // pollSourceUntilIdle (630-642): once a second until the source is idle.
  const pollSourceUntilIdle = async () => {
    while (!closed && !transfer && !sourceIsIdle()) {
      const before = sourceStatus;
      try {
        const updated = await listed();
        if (updated) sourceStatus = updated.agent_status;
      } catch { /* try again */ }
      // Redrawn only on a change, so an open account picker stays open.
      if (sourceStatus !== before) render();
      if (!sourceIsIdle()) await sleep(1000);
    }
  };

  render();
  dialog.showModal();
  // .task (99-106).
  if (transfer && transfer.phase !== "ready") { busy = true; render(); await pollTransfer(transfer.id); }
  else if (!transfer) await pollSourceUntilIdle();
}

/** Answers Go's requests from the agent row menu. */
export function initAgentActions(d: AgentActionDeps) {
  deps = d;
  events.agentActionRequested.on(action => {
    switch (action.kind) {
      case "rename": renameAgent(action); break;
      case "restart": void restartAgent(action); break;
      case "swap": void swapSubscription(action); break;
      case "avatar": openAvatarSheet(action.paneID, action.title); break;
      case "transfer": void switchHarness(action); break;
    }
  });
}
