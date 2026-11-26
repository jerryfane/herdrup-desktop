import { Desk, type AgentTarget, type BoardUpdate, type ConnState, type Row } from "./mygo";
import type { ShareSettings } from "./settings";
import { node } from "./guestAccept";
import { paintShape } from "./continuous";
import { RELAY_RECONNECTING } from "./chatPoll";
import { ACCOUNT_TITLE } from "./herdrupAccount";
import { guestRowLine, rowStatus } from "./rowStatus";
// The guest's Settings page reuses the owner's Settings styles (its machine card, page body);
// the browser guest loads no owner Settings, so it imports them here.
import "./settings.css";

type GuestState = NonNullable<ConnState["guest"]>;

/** Leave share's words. A share in the HerdrUp account (Access.accountBound, #700) leaves every
 *  device signed in to it (forgetGuestConnection deletes the account's item); a plain one, this
 *  device. */
export function leaveWords(access: Pick<GuestState["access"], "machineLabel" | "agentName" | "ownerName" | "accountBound">): { title: string; message: string; note: string } {
 const back = `To come back, ${access.ownerName} has to send a new invite.`;
 return access.accountBound
  ? { title: `Leave ${access.machineLabel} on all your devices?`, message: `${access.agentName} disappears from every device signed in to your HerdrUp account.`, note: `You stop seeing ${access.agentName} on all your devices. ${back}` }
  : { title: `Leave ${access.machineLabel}?`, message: `${access.agentName} disappears from this device.`, note: `You stop seeing ${access.agentName}. ${back}` };
}

/** What the guest home borrows from the owner's sidebar (main.ts): its symbols, the roster row's
 * avatar with its status badge (faces.ts rowAvatar), the initial placement and the loading spinner. */
export interface GuestHomeDeps {
 symbol(name: string, size: number, weight: string): Promise<HTMLElement>;
 rowAvatar(row: Row): HTMLElement;
 placeInitials(root: ParentNode): Promise<void>;
 spinner: string;
}

/** herdrup's GuestHomeView (App/GuestHomeView.swift, f2df68b) in the sidebar: the owner's
 * top bar and glass tab bar (main.ts buildTopBar/buildTabBar) frame it, this draws the
 * list under the bar, and Settings (App/GuestSettingsView.swift) in the detail column. */
export function initGuestHome(sidebar: HTMLElement, detail: HTMLElement, deps: GuestHomeDeps, callbacks: {
 hosts(): void; open(target: AgentTarget): void;
}, options: { settings: boolean; account?: () => HTMLElement | null; shared?: () => HTMLElement | null } = { settings: true }) {
 const navigation = node("section", "guest-navigation"); navigation.hidden = true;
 const settings = node("section", "guest-settings settings-detail"); settings.hidden = true;
 // Where the owner's roster sits: between the top bar and the sidebar's foot (the tab bar).
 sidebar.insertBefore(navigation, document.getElementById("sidebar-foot")); detail.append(settings);
 let last = "", generation = 0;

 /** The share removed (Leave, or Remove once access is lost): forget it and go back to
  * the machine list (GuestHomeView.swift 360-363). The confirmationDialog is the row
  * menu's (agentActions.ts confirmAction); it stays open with the error if forgetting fails. */
 function confirmLeave(title: string, message: string, label: string, id: string) {
  const dialog = node("dialog", "folder-naming agent-confirm"); const controls = node("div", "buttons");
  const error = node("p", "guest-error"); error.setAttribute("role", "alert");
  const confirm = node("button", "button-destructive", label); confirm.type = "button";
  confirm.onclick = () => {
   confirm.disabled = true;
   void Desk.forgetGuestConnection(id).then(() => { dialog.close(); callbacks.hosts(); }).catch(failure => { error.textContent = String(failure); confirm.disabled = false; });
  };
  const cancel = node("button", "button-secondary", "Cancel"); cancel.type = "button"; cancel.onclick = () => dialog.close();
  controls.append(cancel, confirm);
  dialog.append(node("h2", "", title), node("p", "", message), controls, error);
  dialog.addEventListener("close", () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
 }

 /** message(icon:title:body:extra:) (GuestHomeView.swift 284-309): a 46 pt raised disc with
  * the symbol, the title, the body, centred on a surface card with the hairline. */
 async function message(icon: string, title: string, body: string, extra?: HTMLElement) {
  const card = node("div", "guest-home-message");
  card.dataset.testid = "guest-home-message";
  const disc = node("span", "guest-home-message-icon"); disc.append(await deps.symbol(icon, 18, "semibold"));
  card.append(disc, node("strong", "", title), node("p", "", body));
  if (extra) card.append(extra);
  return card;
 }

 /** agentRow (GuestHomeView.swift 232-276): the owner's roster row (main.ts agentRow), the
  * avatar with its status badge, the name over "<kind> · <state>" (meta, 278-282). An archived
  * agent reads "<kind> · <archived note>"; with no listed agent, or one the host says isn't running
  * (availability "paused"), it reads "Agent unavailable" with the avatar dimmed and no badge
  * (235-245, 255). `archivedNote` is undefined for a live agent (rowStatus.ts guestRowLine). */
 function agentRow(name: string, row: Row | undefined, archivedNote: string | undefined, running: boolean, selected: boolean, open: (() => void) | null) {
  const item = node("div", "row guest-agent-row" + (running && row?.badge === "waiting" ? " waiting" : "") + (row && running ? "" : " unavailable") + (selected ? " selected" : ""));
  item.dataset.testid = "guest-agent-row";
  item.setAttribute("role", "button");
  item.setAttribute("aria-current", String(selected));
  item.setAttribute("aria-disabled", String(!open));
  if (open) {
   item.tabIndex = 0;
   item.onclick = open;
   item.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } };
  }
  let face: HTMLElement;
  if (row) face = deps.rowAvatar(running ? row : { ...row, badge: "" });
  else {
   // No listed agent: the default tile with the share's initial (AgentAvatarView(agent: nil)).
   face = node("div", "avatar"); const tile = node("div", "tile tint-0");
   tile.append(node("span", "initial", (name.trim()[0] ?? "?").toUpperCase())); face.append(tile);
  }
  // Decorative: the name and the second line beside it say who it is and its status.
  face.setAttribute("aria-hidden", "true");
  const text = node("div", "text"), line1 = node("div", "line1"), chev = node("span", "chev");
  chev.setAttribute("aria-hidden", "true");
  void deps.symbol("chevron.right", 12, "semibold").then(s => chev.append(s));
  line1.append(node("span", "name t-row-name", name), node("span", "spacer"), chev);
  const line = guestRowLine(row, running, archivedNote);
  const meta = line.kind === "live" ? [line.row.agent, rowStatus(line.row.badge)].filter(Boolean).join(" · ")
   : line.kind === "archived" ? line.text : "Agent unavailable";
  text.append(line1, node("div", "preview t-row-preview", meta));
  item.append(face, text);
  return item;
 }

 function update(state: ConnState, latest: BoardUpdate | null, selected: "agents" | "settings", visible: boolean, openPane: string | null) {
  navigation.hidden = !visible || selected !== "agents"; settings.hidden = !options.settings || !visible || selected !== "settings";
  if (!visible || !state.guest) { last = ""; return; }
  const guest = state.guest, access = guest.access;
  const id = `${access.endpoint.hostID}/${access.guestID}`;
  // Only this share's board (desk_guest.go publishes it as "guest:<id>"): an owner
  // board still held from before the switch must never show here.
  const board = latest?.machineID === `guest:${id}` ? latest : null;
  const section = board?.board.sections.find(s => s.rows.length > 0);
  const row = section?.rows[0] ?? board?.board.archived[0];
  // A live agent has no archive note; an archived one has its note ("" without one).
  const archivedNote = section ? undefined : row?.archivedNote ?? "";
  // The account panel's presence too: the service's answer can come after Settings was drawn.
  const signature = JSON.stringify([guest, state.phase, state.message, !!board, row, archivedNote, selected, openPane === row?.id, !!options.account?.()]);
  if (signature === last) return; last = signature;
  const version = ++generation;
  void (async () => {
   // sharedBy (GuestHomeView.swift 180-194): whose machine this is, where the owner's
   // roster has its search field.
   const header = node("header", "guest-home-header");
   const title = node("h2", "", access.machineLabel); title.dataset.testid = "guest-home-title";
   header.append(title, node("p", "", `Shared by ${access.ownerName} · 1 agent`));
   // content (GuestHomeView.swift 196-230), by the connection's phase.
   let content: HTMLElement;
   if (state.phase === "error" && guest.availability === "offline") {
    content = await message("wifi.slash", `${access.machineLabel} is offline`, `${access.agentName} will show here again when the machine is back.`);
   } else if (state.phase === "error" && guest.availability === "lost") {
    // person.crop.circle.badge.xmark has no stand-in on Windows and Linux (symbols.go).
    const remove = node("button", "guest-destructive button-destructive", "Remove share"); remove.type = "button";
    remove.onclick = () => confirmLeave(`Remove ${access.machineLabel}?`, `${access.ownerName} no longer shares ${access.agentName} with you.`, "Remove share", id);
    content = await message("xmark", `${access.agentName}: access removed`, `${access.ownerName} no longer shares ${access.agentName} with you.`, remove);
   } else if (state.phase === "error") {
    content = await message("exclamationmark.triangle", `Can't reach ${access.agentName}`, state.message);
   } else if (guest.availability === "reconnecting" && !board) {
    // The relay refuses this network's connects for now (429): Go waits and tries again.
    content = await message("arrow.clockwise", RELAY_RECONNECTING, state.message);
   } else if (state.phase !== "connected" || !board) {
    // .loading: ProgressView, 64 pt tall, 26 below the header.
    content = node("div", "guest-home-loading"); content.innerHTML = deps.spinner;
    content.setAttribute("role", "status"); content.setAttribute("aria-label", "Connecting");
   } else {
    const open = row ? () => callbacks.open({ machineID: board.machineID, session: board.session, paneID: row.id }) : null;
    content = agentRow(access.agentName, row, archivedNote, guest.availability !== "paused", openPane === row?.id, open);
   }
   // Listed before the relay's 429: the row stays, and says it is reconnecting below it.
   const reconnecting = guest.availability === "reconnecting" && board ? node("p", "guest-home-note", `${RELAY_RECONNECTING} ${state.message}`) : null;
   reconnecting?.setAttribute("role", "status");
   // GuestShellStyle.note, 18 below; neutral here (no colour-coded cards).
   const note = node("p", "guest-home-note", `You can see only the agents ${access.ownerName} shares with you.`);
   if (version !== generation) return;
   navigation.replaceChildren(header, content, ...(reconnecting ? [reconnecting] : []), note);
   // The content is the shared agent's row, a message or the spinner: only the row is ever selected.
   if (content.classList.contains("selected")) {
    const surface = node("div", "row-selection");
    surface.setAttribute("aria-hidden", "true"); content.prepend(surface);
    paintShape(surface, { radius: parseFloat(getComputedStyle(content).getPropertyValue("--radius-selection")), fill: "var(--color-surface-raised)" });
   }
   await deps.placeInitials(navigation);
  })();
  if (selected !== "settings" || !options.settings) return;
  // GuestSettingsView (App/GuestSettingsView.swift 19-89). sharedAgentCard (90-121) is the
  // owner Settings' machine card (settings.ts): the 60 pt disc, the name, who shared it and
  // the machine.
  const card = node("div", "settings-machine-card");
  const disc = node("span", "settings-machine-disc", (access.agentName.trim()[0] ?? "?").toUpperCase());
  disc.style.setProperty("--disc-size", "var(--size-machine-card-avatar)"); disc.setAttribute("aria-hidden", "true");
  const lines = node("div", "settings-machine-card-lines");
  lines.append(node("span", "settings-machine-card-name", access.agentName), node("span", "settings-machine-card-status", `Shared by ${access.ownerName}`), node("span", "settings-machine-version", access.machineLabel));
  card.append(disc, lines);
  const body = node("div", "settings-page-body");
  // The HerdrUp account (herdrupAccount.ts HerdrUpAccountPanel), in the browser guest only, once
  // the account service offers web sign-in here: the desktop's guest mode has it in its own Settings.
  const account = options.account?.() ?? null;
  const accountPart: HTMLElement[] = [];
  if (account) {
   const accountCard = node("div", "guest-card guest-settings-card guest-account"); accountCard.append(account);
   accountPart.push(node("h3", "guest-settings-section", ACCOUNT_TITLE), accountCard);
  }
  // The account's shares (sharedWithYou.ts sharedSection, the browser guest's: web/main.ts): every
  // share in reach from here, each opening in place of this one. It shows and hides itself.
  const shared = options.shared?.() ?? null;
  body.append(card, ...accountPart, ...(shared ? [shared] : []), ...shareDetails(guest));
  settings.replaceChildren(node("h1", "settings-page-title", "Settings"), body);
 }

 /** The share's own settings (GuestSettingsView.swift 30-89): who shared what, this device's
  *  key to compare, and Leave share. */
 function shareDetails(guest: GuestState): HTMLElement[] {
  const access = guest.access, id = `${access.endpoint.hostID}/${access.guestID}`;
  const keyValue = (key: string, value: string, mono = false) => {
   const item = node("div", "guest-key-value"); item.append(node("dt", "", key), node("dd", mono ? "mono" : "", value)); return item;
  };
  const shared = node("dl", "guest-card guest-settings-card");
  shared.append(keyValue("Machine", access.machineLabel), keyValue("Shared by", access.ownerName), keyValue("Agent", access.agentName, true), keyValue("You appear as", access.guestName, true));
  const device = node("div", "guest-card guest-settings-card guest-device-key");
  const fingerprint = node("span", "", guest.fingerprint || "Unavailable"); fingerprint.dataset.testid = "guest-settings-fingerprint";
  device.append(node("span", "", "Device key"), fingerprint);
  const leave = node("button", "guest-leave button-destructive button-large", "Leave share"); leave.type = "button"; leave.dataset.testid = "guest-leave";
  const words = leaveWords(access);
  leave.onclick = () => confirmLeave(words.title, words.message, "Leave share", id);
  return [node("h3", "guest-settings-section", "Shared with you"), shared, node("h3", "guest-settings-section", "This device"), device,
   node("p", "guest-settings-note", `${access.ownerName} sees the same key next to your name, so you can compare them.`), leave,
   node("p", "guest-settings-note guest-leave-note", words.note)];
 }

 /** The share's page for the app's own Settings (settings.ts, the desktop's guest mode). */
 function shareSettings(guest: GuestState, connectOwn: () => void): ShareSettings {
  const access = guest.access;
  return {
   key: JSON.stringify([access.endpoint.hostID, access.guestID, access.agentName, access.ownerName, access.machineLabel, access.guestName, guest.fingerprint]),
   agentName: access.agentName, ownerName: access.ownerName, machineLabel: access.machineLabel, connectOwn,
   details: () => { const wrap = node("div", "guest-settings guest-share-details"); wrap.append(...shareDetails(guest)); return wrap; },
  };
 }
 return { update, shareSettings };
}
