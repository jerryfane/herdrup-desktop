import { Desk, type AgentTarget, type BoardUpdate, type ConnState, type Row } from "./mygo";
import { node } from "./guestAccept";
import { paintShape } from "./continuous";
import { RELAY_RECONNECTING } from "./chatPoll";

/** What the guest home borrows from the owner's sidebar (main.ts): its symbols, the
 * roster's avatar with its status badge, the initial placement and the loading spinner. */
export interface GuestHomeDeps {
 symbol(name: string, size: number, weight: string): Promise<HTMLElement>;
 avatar(row: Row): Promise<HTMLElement>;
 placeInitials(root: ParentNode): Promise<void>;
 spinner: string;
}

/** herdrup's GuestHomeView (App/GuestHomeView.swift, f2df68b) in the sidebar: the owner's
 * top bar and glass tab bar (main.ts buildTopBar/buildTabBar) frame it, this draws the
 * list under the bar, and Settings (App/GuestSettingsView.swift) in the detail column. */
export function initGuestHome(sidebar: HTMLElement, detail: HTMLElement, deps: GuestHomeDeps, callbacks: {
 hosts(): void; open(target: AgentTarget): void;
}) {
 const navigation = node("section", "guest-navigation"); navigation.hidden = true;
 const settings = node("section", "guest-settings settings-detail"); settings.hidden = true;
 // Where the owner's roster sits: between the top bar and the floating tab bar.
 sidebar.insertBefore(navigation, document.getElementById("tabbar")); detail.append(settings);
 let last = "", generation = 0;

 /** The share removed (Leave, or Remove once access is lost): forget it and go back to
  * the machine list (GuestHomeView.swift 360-363). The confirmationDialog is the row
  * menu's (agentActions.ts confirmAction); it stays open with the error if forgetting fails. */
 function confirmLeave(title: string, message: string, label: string, id: string) {
  const dialog = node("dialog", "folder-naming agent-confirm"); const controls = node("div", "buttons");
  const error = node("p", "guest-error"); error.setAttribute("role", "alert");
  const confirm = node("button", "destructive", label); confirm.type = "button";
  confirm.onclick = () => {
   confirm.disabled = true;
   void Desk.forgetGuestConnection(id).then(() => { dialog.close(); callbacks.hosts(); }).catch(failure => { error.textContent = String(failure); confirm.disabled = false; });
  };
  const cancel = node("button", "ghost", "Cancel"); cancel.type = "button"; cancel.onclick = () => dialog.close();
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
  * avatar with its status badge, the name over "<kind> · <state>" (meta, 278-282), dimmed
  * and reading "Agent unavailable" when the host lists no agent. */
 async function agentRow(name: string, row: Row | undefined, state: string | undefined, selected: boolean, open: (() => void) | null) {
  const item = node("div", "row guest-agent-row" + (row?.badge === "waiting" ? " waiting" : "") + (row ? "" : " unavailable") + (selected ? " selected" : ""));
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
  if (row) face = await deps.avatar(row);
  else {
   // No listed agent: the default tile with the share's initial (AgentAvatarView(agent: nil)).
   face = node("div", "avatar"); const tile = node("div", "tile tint-0");
   tile.append(node("span", "initial", (name.trim()[0] ?? "?").toUpperCase())); face.append(tile);
  }
  const text = node("div", "text"), line1 = node("div", "line1"), chev = node("span", "chev");
  chev.append(await deps.symbol("chevron.right", 12, "semibold"));
  line1.append(node("span", "name t-row-name", name), node("span", "spacer"), chev);
  const meta = row ? [row.agent, state].filter(Boolean).join(" · ") : "Agent unavailable";
  text.append(line1, node("div", "preview t-row-preview", meta));
  item.append(face, text);
  return item;
 }

 function update(state: ConnState, latest: BoardUpdate | null, selected: "agents" | "settings", visible: boolean, openPane: string | null) {
  navigation.hidden = !visible || selected !== "agents"; settings.hidden = !visible || selected !== "settings";
  if (!visible || !state.guest) { last = ""; return; }
  const guest = state.guest, access = guest.access;
  const id = `${access.endpoint.hostID}/${access.guestID}`;
  // Only this share's board (desk_guest.go publishes it as "guest:<id>"): an owner
  // board still held from before the switch must never show here.
  const board = latest?.machineID === `guest:${id}` ? latest : null;
  const section = board?.board.sections.find(s => s.rows.length > 0);
  const row = section?.rows[0] ?? board?.board.archived[0];
  const rowState = section ? section.label : row?.archivedNote;
  const signature = JSON.stringify([guest, state.phase, state.message, !!board, row, rowState, selected, openPane === row?.id]);
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
    const remove = node("button", "guest-destructive", "Remove share"); remove.type = "button";
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
    content = await agentRow(access.agentName, row, rowState, openPane === row?.id, open);
   }
   // Listed before the relay's 429: the row stays, and says it is reconnecting below it.
   const reconnecting = guest.availability === "reconnecting" && board ? node("p", "guest-home-note", `${RELAY_RECONNECTING} ${state.message}`) : null;
   reconnecting?.setAttribute("role", "status");
   // GuestShellStyle.note, 18 below; neutral here (no colour-coded cards).
   const note = node("p", "guest-home-note", `You can see only the agents ${access.ownerName} shares with you.`);
   if (version !== generation) return;
   navigation.replaceChildren(header, content, ...(reconnecting ? [reconnecting] : []), note);
   const surface = content.classList.contains("selected") ? node("div", "row-selection") : null;
   if (surface) {
    surface.setAttribute("aria-hidden", "true"); content.prepend(surface);
    paintShape(surface, { radius: parseFloat(getComputedStyle(content).getPropertyValue("--radius-selection")), fill: "var(--color-surface-raised)" });
   }
   await deps.placeInitials(navigation);
  })();
  if (selected !== "settings") return;
  // GuestSettingsView (App/GuestSettingsView.swift 19-89). sharedAgentCard (90-121) is the
  // owner Settings' machine card (settings.ts): the 60 pt disc, the name, who shared it and
  // the machine.
  const card = node("div", "settings-machine-card");
  const disc = node("span", "settings-machine-disc", (access.agentName.trim()[0] ?? "?").toUpperCase());
  disc.style.setProperty("--disc-size", "var(--size-machine-card-avatar)"); disc.setAttribute("aria-hidden", "true");
  const lines = node("div", "settings-machine-card-lines");
  lines.append(node("span", "settings-machine-card-name", access.agentName), node("span", "settings-machine-card-status", `Shared by ${access.ownerName}`), node("span", "settings-machine-version", access.machineLabel));
  card.append(disc, lines);
  const keyValue = (key: string, value: string, mono = false) => {
   const item = node("div", "guest-key-value"); item.append(node("dt", "", key), node("dd", mono ? "mono" : "", value)); return item;
  };
  const shared = node("dl", "guest-card guest-settings-card");
  shared.append(keyValue("Machine", access.machineLabel), keyValue("Shared by", access.ownerName), keyValue("Agent", access.agentName, true), keyValue("You appear as", access.guestName, true));
  const device = node("div", "guest-card guest-settings-card guest-device-key");
  const fingerprint = node("span", "", guest.fingerprint || "Unavailable"); fingerprint.dataset.testid = "guest-settings-fingerprint";
  device.append(node("span", "", "Device key"), fingerprint);
  const leave = node("button", "guest-leave guest-destructive", "Leave share"); leave.type = "button"; leave.dataset.testid = "guest-leave";
  leave.onclick = () => confirmLeave(`Leave ${access.machineLabel}?`, `${access.agentName} disappears from this device.`, "Leave share", id);
  const body = node("div", "settings-page-body");
  body.append(card, node("h3", "guest-settings-section", "Shared with you"), shared, node("h3", "guest-settings-section", "This device"), device,
   node("p", "guest-settings-note", `${access.ownerName} sees the same key next to your name, so you can compare them.`), leave,
   node("p", "guest-settings-note guest-leave-note", `You stop seeing ${access.agentName}. To come back, ${access.ownerName} has to send a new invite.`));
  settings.replaceChildren(node("h1", "settings-page-title", "Settings"), body);
 }
 return { update };
}
