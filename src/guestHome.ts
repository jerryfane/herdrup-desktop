import { Desk, type AgentTarget, type BoardUpdate, type ConnState } from "./mygo";
import { action, details, node } from "./guestAccept";

export function initGuestHome(sidebar: HTMLElement, detail: HTMLElement, callbacks: {
 agents(): void; settings(): void; hosts(): void; terminal(): void; open(target: AgentTarget): void;
}) {
 const navigation = node("section", "guest-navigation"); navigation.hidden = true;
 const settings = node("section", "guest-settings"); settings.hidden = true;
 sidebar.append(navigation); detail.append(settings);
 let last = "";
 function update(state: ConnState, board: BoardUpdate | null, selected: "agents" | "settings", gram: boolean, visible: boolean) {
  navigation.hidden = !visible; settings.hidden = !visible || selected !== "settings";
  if (!visible || !state.guest) { last = ""; return; }
  const guest = state.guest, access = guest.access;
  const row = board?.board.sections.flatMap(section => section.rows)[0] ?? board?.board.archived[0];
  const signature = JSON.stringify([guest, state.phase, state.message, row?.id, row?.name, selected, gram]);
  if (signature === last) return; last = signature;
  const header = node("header", "guest-home-header"); header.append(action("Hosts", callbacks.hosts), node("h2", "", access.machineLabel));
  const card = action("", () => { if (board && row) callbacks.open({ machineID: board.machineID, session: board.session, paneID: row.id }); });
  card.className = "guest-agent-card"; card.disabled = !row || state.phase !== "connected";
  card.append(node("strong", "", access.agentName), node("span", "", `Shared by ${access.ownerName}`), node("span", "", access.machineLabel));
  const status = node("p", "guest-connection-state", state.phase === "error" ? state.message : state.phase === "connecting" ? "Connecting…" : !row ? "The shared agent isn't running right now." : "");
  status.setAttribute("role", "status");
  const tabs = node("nav", "guest-tabs");
  const agents = action("Agents", callbacks.agents), preferences = action("Settings", callbacks.settings);
  agents.setAttribute("aria-current", String(selected === "agents")); preferences.setAttribute("aria-current", String(selected === "settings")); tabs.append(agents, preferences);
  navigation.replaceChildren(header, card, status);
  if (gram) navigation.append(action("Back to Terminal", callbacks.terminal));
  navigation.append(tabs);
  if (selected !== "settings") return;
  const leave = action("Leave share", () => {
   const dialog = node("dialog", "host-password"); const controls = node("div", "guest-tabs");
   const error = node("p", "guest-error"); error.setAttribute("role", "alert");
   const confirm = action("Leave share", () => {
    confirm.disabled = true;
    void Desk.forgetGuestConnection(`${access.endpoint.hostID}/${access.guestID}`).then(() => { dialog.close(); callbacks.hosts(); }).catch(failure => { error.textContent = String(failure); confirm.disabled = false; });
   });
   controls.append(action("Cancel", () => dialog.close()), confirm);
   dialog.append(node("h2", "", `Leave ${access.machineLabel}?`), node("p", "", `${access.agentName} disappears from this device. To come back, ${access.ownerName} must send a new invitation.`), controls, error);
   dialog.addEventListener("close", () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
  });
  settings.replaceChildren(node("h2", "", "Settings"), node("h3", "", access.agentName), node("p", "", `Shared by ${access.ownerName}`), node("h3", "", "Shared with you"),
   details([["Machine", access.machineLabel], ["Shared by", access.ownerName], ["Agent", access.agentName], ["You appear as", access.guestName]]), node("h3", "", "This device"), details([["Device key", guest.fingerprint]]),
   node("p", "guest-note", `${access.ownerName} sees the same key next to your name, so you can compare them.`), leave);
 }
 return { update };
}
