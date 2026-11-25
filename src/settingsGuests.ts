import { Desk } from "./mygo";
import type { PeerSummary, SavedMachineStatus } from "./mygo";
import { guestOwnerName } from "./guestInviteModel";
import { errorText } from "./errors";
import type { Glyph } from "./herdrupAccount";

type Machine = { alias: string; label: string };
type Grant = { terminal_id?: string; agent_name?: string };
/** guest.list's devices[] (herdr GuestDeviceInfo): a device the person added to an account-bound
 *  share after the one that accepted it, removed ones included. */
type Device = { fingerprint: string; device?: string; added_ms?: number; last_seen_ms?: number | null; removed?: boolean };
/** guest.list's guests[] (herdr GuestInfo). An older herdr sends no person, account_bound nor
 *  devices. */
export type Guest = {
  guest_id: string; name: string; grant?: Grant; revoked?: boolean; share_gram?: boolean; created_ms?: number; last_seen_ms?: number | null;
  fingerprint?: string; device?: string; account_bound?: boolean; person?: string; devices?: Device[];
};
type Invite = { invite_id: string; name: string; grant?: Grant; share_gram?: boolean; created_ms?: number; expires_ms?: number; used_by?: string };
type Entry = { event: string; guest_id?: string; name?: string; pane?: string; ts_ms: number; fingerprint?: string; text?: string; method?: string; file?: { name?: string; size?: number } };
type Listing = { guests?: Guest[]; invites?: Invite[]; link?: { state: string; last_error?: string } };
type Result = { machine: Machine; listing?: Listing; entries?: Entry[]; error?: string; auditError?: string; missingFeature?: boolean };

/** One device of a person on one machine: the devices their shares there admit now. */
export interface PersonDevice { fingerprint: string; name: string; addedMs: number; lastSeenMs: number | null; guests: string[] }
/** Everyone one person shares on one machine (herdr's `person`: their HerdrUp account on that
 *  host when account-bound, else the one device's fingerprint). Never grouped across machines. */
export interface Person { id: string; name: string; accountBound: boolean; guests: Guest[]; devices: PersonDevice[]; lastSeenMs: number | null }

const latest = (a: number | null, b: number | null | undefined) => b == null ? a : a === null ? b : Math.max(a, b);

/** The devices guest admits now: the one that accepted, then the ones added, less those removed (a
 *  removed entry may name the accepting device). The accepting device has no activity of its own on
 *  the wire: the share's last_seen_ms is any of its devices', so it stays the person's. */
function admitted(guest: Guest): Map<string, Omit<PersonDevice, "guests">> {
  const out = new Map<string, Omit<PersonDevice, "guests">>();
  if (guest.fingerprint) out.set(guest.fingerprint, { fingerprint: guest.fingerprint, name: guest.device || "A device", addedMs: guest.created_ms ?? 0, lastSeenMs: null });
  for (const d of guest.devices ?? []) {
    if (d.removed) out.delete(d.fingerprint);
    else out.set(d.fingerprint, { fingerprint: d.fingerprint, name: d.device || "A device", addedMs: d.added_ms ?? 0, lastSeenMs: d.last_seen_ms ?? null });
  }
  return out;
}

/** One machine's live guests by person (o1's PEOPLE), latest active first; `ungrouped` are the
 *  guests of an older herdr, which names no person: they keep a row each. */
export function sharePeople(guests: readonly Guest[]): { people: Person[]; ungrouped: Guest[] } {
  const people = new Map<string, Person>(), ungrouped: Guest[] = [];
  for (const guest of guests) {
    if (guest.revoked) continue;
    if (!guest.person) { ungrouped.push(guest); continue; }
    let person = people.get(guest.person);
    if (!person) people.set(guest.person, person = { id: guest.person, name: guest.name, accountBound: false, guests: [], devices: [], lastSeenMs: null });
    person.guests.push(guest);
    person.accountBound ||= !!guest.account_bound;
    person.lastSeenMs = latest(person.lastSeenMs, guest.last_seen_ms);
    for (const device of admitted(guest).values()) {
      const known = person.devices.find(d => d.fingerprint === device.fingerprint);
      if (!known) { person.devices.push({ ...device, guests: [guest.guest_id] }); continue; }
      known.guests.push(guest.guest_id);
      known.addedMs = Math.min(known.addedMs, device.addedMs);
      known.lastSeenMs = latest(known.lastSeenMs, device.lastSeenMs);
    }
  }
  for (const person of people.values()) {
    // Named as their latest share names them; devices in the order they were added.
    person.name = person.guests.reduce((a, b) => (b.created_ms ?? 0) > (a.created_ms ?? 0) ? b : a).name;
    person.devices.sort((a, b) => a.addedMs - b.addedMs);
    for (const device of person.devices) person.lastSeenMs = latest(person.lastSeenMs, device.lastSeenMs);
  }
  return { people: [...people.values()].sort((a, b) => (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0)), ungrouped };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
}
function button(label: string, action: () => void) { const node = el("button", "settings-guest-action", label); node.type = "button"; node.onclick = action; return node; }
function group(title: string, rows: HTMLElement[]) {
  const section = el("section", "settings-section"), card = el("div", "settings-group"); card.append(...rows); section.append(el("h2", "settings-section-label", title), card); return section;
}
function note(text: string) { return el("p", "settings-guest-note", text); }
function age(seconds: number) { const n = Math.max(0, Math.floor(seconds)); return n < 60 ? "just now" : n < 3600 ? `${Math.floor(n / 60)} min ago` : n < 86400 ? `${Math.floor(n / 3600)} h ago` : `${Math.floor(n / 86400)} d ago`; }
function clock(ms: number) {
  const date = new Date(ms), today = date.toDateString() === new Date().toDateString();
  return date.toLocaleString("en-US", { ...(today ? {} : { month: "short", day: "numeric" }), hour: "2-digit", minute: "2-digit", hour12: false });
}
function day(ms: number) { return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" }); }
/** "active now" within 5 minutes, else how long ago; null: never connected. */
function seen(ms: number | null): { text: string; active: boolean } | null {
  if (ms === null) return null;
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  return seconds <= 300 ? { text: "active now", active: true } : { text: age(seconds), active: false };
}
/** A presence line: the dot (green while active) and what it says, by default when last seen. */
function presence(ms: number | null, suffix = "", text?: string) {
  const line = el("div", "settings-guest-presence"), dot = el("span", "settings-status-dot"), last = seen(ms);
  dot.dataset.state = last?.active ? "reachable" : "unreachable";
  line.append(dot, document.createTextNode(text ?? (last?.text ?? "not connected yet") + suffix)); return line;
}
function initial(name: string) { const node = el("span", "settings-account-identity", Array.from(name)[0]?.toUpperCase() || "?"); node.setAttribute("aria-hidden", "true"); return node; }
const agentName = (guest: Guest) => guest.grant?.agent_name || "An agent";
/** A device's glyph, from the name herdr keeps for it ("iPhone", "Chrome on macOS", "MacBook"). */
function deviceGlyph(name: string) {
  return /iphone/i.test(name) ? "iphone" : /ipad/i.test(name) ? "ipad" : /browser|chrome|safari|firefox|edge/i.test(name) ? "globe"
    : /mac|laptop/i.test(name) ? "laptopcomputer" : "desktopcomputer";
}

export class GuestSettings {
  readonly root = el("section", "settings-guests");
  private content = el("div");
  private owner: HTMLElement;
  private token = "";
  private machines: Machine[] = [{ alias: "", label: "Home box" }];
  private results: Result[] = [];
  private generation = 0;
  private loaded = false;
  private modal: HTMLDialogElement | null = null;
  private pending = new Map<string, { value: boolean }>();
  private running = new Set<string>();
  private revoking = new Set<string>();
  /** The person page open (o2): a person on one machine. */
  private open: { alias: string; person: string } | null = null;
  /** The page settings.ts was last told (paged): a person's name, or null for the list. */
  private shown: string | null = null;
  /** Closes the device menu this view opened (and its listeners); null while none is open. */
  private closeMenu: (() => void) | null = null;
  /** paged names the page shown: a person's name on their page, null on the list (settings.ts
   *  titles the page with it). */
  constructor(private report: (message: unknown) => void, private summarize: (value: string, header: string) => void,
    private glyph: Glyph, private paged: (title: string | null) => void = () => {}) {
    const input = el("input"); input.placeholder = "Your name"; input.setAttribute("aria-label", "Your name"); input.autocomplete = "name";
    const explanation = el("p", "settings-row-subtitle");
    let saved = ""; try { saved = localStorage.getItem("guest.ownerName") ?? ""; } catch { /* empty until a name can be saved */ }
    input.value = saved;
    const describe = () => {
      explanation.textContent = `People you share with see “Shared by ${guestOwnerName(input.value) ?? "you"}”. New invites use it.`;
    };
    input.oninput = () => { try { localStorage.setItem("guest.ownerName", input.value); saved = input.value; } catch (error) { input.value = saved; this.report(error); } describe(); };
    describe(); const owner = el("div", "settings-guest-owner"); owner.append(input, explanation);
    this.owner = group("YOUR NAME", [owner]);
    this.root.append(this.content, this.owner); this.render();
  }
  setScope(token: string) {
    if (token === this.token) return;
    this.closeDialogs(); this.token = token; this.generation++; this.results = []; this.loaded = false; this.open = null;
    this.pending.clear(); this.running.clear(); this.revoking.clear(); this.render();
    if (token) void this.refresh();
  }
  setMachines(localLabel: string, saved: SavedMachineStatus[], peers: PeerSummary[]) {
    const labels = new Map(peers.map(peer => [peer.alias, peer.label || peer.alias]));
    for (const machine of saved) if (machine.hasFederationPolicy || labels.has(machine.profileID)) labels.set(machine.profileID, machine.displayLabel.trim() || labels.get(machine.profileID) || machine.profileID);
    const machines = [{ alias: "", label: localLabel }, ...Array.from(labels, ([alias, label]) => ({ alias, label })).sort((a, b) => a.label.localeCompare(b.label) || a.alias.localeCompare(b.alias))];
    if (JSON.stringify(machines) === JSON.stringify(this.machines)) return;
    this.machines = machines; if (this.token) void this.refresh();
  }
  closeDialogs() { this.modal?.close(); this.closeMenu?.(); }
  /** Back to the list from a person's page; false when the list shows already. */
  back(): boolean { if (!this.open) return false; this.open = null; this.closeDialogs(); this.render(); return true; }
  /** Tells settings.ts the page shown when it changes. */
  private title(name: string | null) { if (name !== this.shown) { this.shown = name; this.paged(name); } }
  private async refresh() {
    this.closeMenu?.();
    const token = this.token, at = ++this.generation;
    const results = await Promise.all(this.machines.map(async machine => {
      try { return { ...JSON.parse(await Desk.settingsGuestMachine(token, machine.alias)), machine } as Result; }
      catch (error) { return { machine, error: errorText(error) } as Result; }
    }));
    if (token !== this.token || at !== this.generation) return;
    this.results = results; this.loaded = true; this.render();
  }
  private key(machine: Machine, id: string) { return JSON.stringify([this.token, machine.alias, id]); }
  private render() {
    const byMachine = this.results.map(result => ({ machine: result.machine, ...sharePeople(result.listing?.guests ?? []) }));
    const people = byMachine.flatMap(m => m.people.map(person => ({ machine: m.machine, person })))
      .sort((a, b) => (b.person.lastSeenMs ?? 0) - (a.person.lastSeenMs ?? 0));
    const ungrouped = byMachine.flatMap(m => m.ungrouped.map(guest => ({ machine: m.machine, guest }))).sort((a, b) => (b.guest.last_seen_ms ?? 0) - (a.guest.last_seen_ms ?? 0));
    const invites = this.results.flatMap(result => (result.listing?.invites ?? []).filter(invite => !invite.used_by && (invite.expires_ms === undefined || invite.expires_ms > Date.now())).map(invite => ({ machine: result.machine, invite }))).sort((a, b) => (b.invite.created_ms ?? 0) - (a.invite.created_ms ?? 0));
    const failures = this.results.filter(result => result.error && (!result.machine.alias || !result.missingFeature));
    const summary: string[] = [], count = people.length + ungrouped.length;
    if (count) {
      const agents = new Set([...people.flatMap(({ machine, person }) => person.guests.map(guest => ({ machine, guest }))), ...ungrouped]
        .map(({ machine, guest }) => JSON.stringify([machine.alias, guest.grant?.terminal_id ?? guest.grant?.agent_name ?? ""])));
      summary.push(`${count} ${count === 1 ? "person" : "people"}`, `${agents.size} agent${agents.size === 1 ? "" : "s"}`);
    }
    if (invites.length) summary.push(`${invites.length} invite${invites.length === 1 ? "" : "s"}`);
    // The page header keeps the full summary; the index row names people first, then
    // invites (HerdrApp.swift 8171-8177, GuestAccessSettings.swift 59-74).
    const header = !this.loaded ? "" : summary.length ? summary.join(" · ")
      : failures.some(result => !result.machine.alias) ? "Unavailable" : "Nobody yet";
    this.summarize(count ? `${count} ${count === 1 ? "person" : "people"}`
      : invites.length ? `${invites.length} invite${invites.length === 1 ? "" : "s"}` : header, header);
    const open = this.open && people.find(({ machine, person }) => machine.alias === this.open!.alias && person.id === this.open!.person);
    if (open) { this.renderPerson(open.machine, open.person); return; }
    this.open = null; this.title(null);
    this.owner.hidden = false;
    const peopleRows = [...people.map(({ machine, person }) => this.personRow(machine, person)), ...ungrouped.map(({ machine, guest }) => this.guestRow(machine, guest))];
    if (!peopleRows.length) peopleRows.push(note(!this.token ? "Connect to a home box to manage shared access." : !this.loaded ? "Loading…" : failures.length ? "Shared access could not be loaded from every machine." : "Nobody has access. Share an agent from its ••• menu."));
    this.content.replaceChildren(group("PEOPLE", peopleRows));
    if (people.some(({ person }) => person.accountBound)) this.content.append(note("With a HerdrUp account, a person is one row whatever devices they use. Removing them removes every device."));
    for (const result of failures) this.content.append(note(`${result.machine.label}: ${result.error}`));
    for (const result of this.results) if (result.listing?.link?.state === "retrying") this.content.append(note(`Relay link on ${result.machine.label} is retrying${result.listing.link.last_error ? ": " + result.listing.link.last_error : ""}`));
    if (invites.length) this.content.append(group("PENDING INVITES", invites.map(({ machine, invite }) => this.inviteRow(machine, invite))));
    const logRows: HTMLElement[] = this.results.filter(result => result.auditError).map(result => note(`Couldn't load the activity log${result.machine.alias ? " from " + result.machine.label : ""}: ${result.auditError}`));
    const log = this.results.flatMap(result => (result.entries ?? []).map(entry => ({ entry, guest: result.listing?.guests?.find(guest => guest.guest_id === entry.guest_id) }))).sort((a, b) => b.entry.ts_ms - a.entry.ts_ms);
    logRows.push(...log.map(({ entry, guest }) => this.logRow(entry, guest)));
    if (!logRows.length) logRows.push(note(!this.token ? "Connect to load the activity log." : !this.loaded ? "Loading…" : failures.length ? "The activity log is unavailable for machines whose shared access could not be loaded." : "Nothing yet. Every message and file a guest sends is recorded here."));
    this.content.append(group("ACTIVITY LOG", logRows));
    const refresh = button("Refresh", () => { if (this.token) void this.refresh(); }); refresh.disabled = !this.token; this.content.append(refresh);
  }
  /** o1: one person on one machine, opening their page. */
  private personRow(machine: Machine, person: Person) {
    const row = el("button", "settings-guest-person settings-guest-top settings-guest-open"); row.type = "button";
    row.setAttribute("aria-label", `${person.name}, ${person.guests.map(agentName).join(", ")} on ${machine.label}`);
    row.onclick = () => { this.open = { alias: machine.alias, person: person.id }; this.closeDialogs(); this.render(); };
    const lines = el("div", "settings-row-lines");
    lines.append(el("div", "settings-row-label", person.name), el("div", "settings-row-subtitle", `${person.guests.map(agentName).join(", ")} on ${machine.label}`),
      el("div", "settings-row-subtitle", person.accountBound ? `HerdrUp account · ${person.devices.map(d => d.name).join(", ") || "no devices"}` : `Only this device · ${person.devices[0]?.name || "A device"}`),
      presence(person.lastSeenMs));
    const chevron = el("span", "settings-guest-chevron", "›"); chevron.setAttribute("aria-hidden", "true");
    row.append(initial(person.name), lines, chevron); return row;
  }
  /** o2: a person's page on one machine: their agents, their devices, and Remove. */
  private renderPerson(machine: Machine, person: Person) {
    this.title(person.name); this.owner.hidden = true;
    const head = el("div", "settings-guest-page-head"), back = el("button", "settings-guest-back", "‹"); back.type = "button";
    back.setAttribute("aria-label", "Back to Shared access"); back.onclick = () => { this.back(); };
    const identity = el("div", "settings-guest-page-identity"), mark = initial(person.name); mark.classList.add("settings-guest-page-initial");
    // The share's activity is any of the person's devices': which one, the wire doesn't say.
    const last = seen(person.lastSeenMs);
    const status = presence(person.lastSeenMs, "", last ? (last.active ? "Active now" : `Last active ${last.text}`) : "Not connected yet");
    identity.append(mark, el("h2", "settings-guest-page-name", person.name), status,
      el("div", "settings-row-subtitle", person.accountBound ? `HerdrUp account · ${person.devices.length} device${person.devices.length === 1 ? "" : "s"}` : "Only this device"));
    head.append(back, identity);
    const agents = person.guests.map(guest => this.agentRow(machine, person, guest));
    const devices = person.devices.map(device => this.deviceRow(machine, person, device));
    if (!devices.length) devices.push(note("No device can open these shares now."));
    const remove = el("button", "button-destructive button-large settings-guest-remove", `Remove ${person.name}`); remove.type = "button";
    remove.disabled = this.revoking.has(this.key(machine, "person:" + person.id)); remove.onclick = () => this.confirmRemovePerson(machine, person);
    this.content.replaceChildren(head, group("AGENTS", agents), group("DEVICES", devices));
    if (person.accountBound) this.content.append(note(`A device is added when ${person.name} signs in to HerdrUp there and opens a share.`));
    this.content.append(remove, note(person.accountBound ? `Removes every agent ${person.name} has on ${machine.label}, on all ${person.devices.length === 1 ? "their device" : `${person.devices.length} devices`}.` : `Removes every agent ${person.name} has on ${machine.label}.`));
  }
  private agentRow(machine: Machine, person: Person, guest: Guest) {
    const key = this.key(machine, guest.guest_id), sharing = this.pending.get(key)?.value ?? guest.share_gram ?? false;
    const row = el("div", "settings-guest-person"), top = el("div", "settings-guest-top"), lines = el("div", "settings-row-lines");
    lines.append(el("div", "settings-row-label", agentName(guest)), el("div", "settings-row-subtitle", [`on ${machine.label}`, ...(guest.created_ms ? [`since ${day(guest.created_ms)}`] : []), ...(sharing ? ["Gram shared"] : [])].join(" · ")));
    const remove = button("Remove", () => this.confirmRevoke(machine, guest, person)); remove.disabled = this.revoking.has(key); remove.setAttribute("aria-label", `Remove ${agentName(guest)} from ${person.name}`);
    top.append(initial(agentName(guest)), lines, remove);
    row.append(top, this.gramToggle(machine, guest, key, sharing)); return row;
  }
  private deviceRow(machine: Machine, person: Person, device: PersonDevice) {
    const row = el("div", "settings-guest-top settings-guest-device"), lines = el("div", "settings-row-lines");
    const added = device.addedMs ? `added ${day(device.addedMs)}` : "";
    // An added device says when it was last active; the accepting one only when it was added.
    lines.append(el("div", "settings-row-label", device.name), device.lastSeenMs === null ? el("div", "settings-guest-presence", added) : presence(device.lastSeenMs, added ? ` · ${added}` : ""));
    row.append(this.glyph(deviceGlyph(device.name), 20), lines);
    // A plain share is its one device: Remove the person instead (herdr: guest_not_account_bound).
    if (person.accountBound) {
      const manage = el("button", "settings-guest-more"); manage.type = "button"; manage.append(this.glyph("ellipsis.circle", 22));
      manage.setAttribute("aria-label", `Manage ${device.name}`); manage.disabled = this.revoking.has(this.key(machine, "device:" + device.fingerprint));
      manage.onclick = event => { event.stopPropagation(); this.deviceMenu(machine, person, device, manage); };
      row.append(manage);
    }
    return row;
  }
  /** The device's ⋯ menu (as the account page's): Remove. */
  private deviceMenu(machine: Machine, person: Person, device: PersonDevice, anchor: HTMLElement) {
    this.closeMenu?.();
    const menu = el("div", "account-device-menu"); menu.setAttribute("role", "menu");
    // The one menu this view opened, closed with its listeners on a refresh, a navigation or a new scope.
    const close = () => { menu.remove(); document.removeEventListener("pointerdown", outside, true); removeEventListener("scroll", close, true); removeEventListener("resize", close); if (this.closeMenu === close) this.closeMenu = null; };
    this.closeMenu = close;
    const outside = (e: Event) => { if (!menu.contains(e.target as Node)) close(); };
    const remove = el("button", "", "Remove"); remove.type = "button"; remove.setAttribute("role", "menuitem");
    remove.onclick = () => { close(); this.confirmRemoveDevice(machine, person, device); };
    menu.append(remove); menu.onkeydown = e => { if (e.key === "Escape") { close(); anchor.focus(); } };
    document.body.append(menu);
    const r = anchor.getBoundingClientRect(), m = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.right - m.width, innerWidth - m.width - 8))}px`;
    menu.style.top = `${r.bottom + 4 + m.height > innerHeight ? Math.max(8, r.top - 4 - m.height) : r.bottom + 4}px`;
    document.addEventListener("pointerdown", outside, true); addEventListener("scroll", close, true); addEventListener("resize", close);
    remove.focus();
  }
  /** A confirmation with one destructive action; listed are what goes (o3). */
  private confirm(title: string, message: string, action: string, listed: HTMLElement[], run: () => void) {
    this.closeDialogs(); const token = this.token, modal = el("dialog", "folder-naming agent-confirm settings-guest-confirm"); this.modal = modal;
    const buttons = el("div", "buttons"), cancel = el("button", "button-secondary", "Cancel"), act = el("button", "button-destructive", action);
    cancel.type = act.type = "button"; cancel.onclick = () => modal.close(); act.onclick = () => { modal.close(); if (token === this.token) run(); };
    buttons.append(cancel, act);
    modal.append(el("h2", "", title), el("p", "", message));
    if (listed.length) { const list = el("div", "settings-group settings-guest-confirm-list"); list.append(...listed); modal.append(list); }
    modal.append(buttons);
    modal.addEventListener("close", () => { if (this.modal === modal) this.modal = null; modal.remove(); }, { once: true }); document.body.append(modal); modal.showModal();
  }
  private confirmRemovePerson(machine: Machine, person: Person) {
    const agents = el("div", "settings-guest-top"), agentLines = el("div", "settings-row-lines");
    agentLines.append(el("div", "settings-row-label", person.guests.map(agentName).join(", ")), el("div", "settings-row-subtitle", `on ${machine.label}`));
    agents.append(initial(agentName(person.guests[0]!)), agentLines);
    const devices = el("div", "settings-guest-top"), deviceLines = el("div", "settings-row-lines");
    deviceLines.append(el("div", "settings-row-label", person.devices.map(d => d.name).join(", ") || "No devices"), el("div", "settings-row-subtitle", `${person.devices.length} device${person.devices.length === 1 ? "" : "s"}`));
    devices.append(this.glyph(deviceGlyph(person.devices[0]?.name ?? ""), 20), deviceLines);
    this.confirm(`Remove ${person.name}?`, `${person.name} loses access on ${person.accountBound ? "every device" : "their device"} right away, and open sessions close. To come back, ${person.name} needs a new invite.`,
      `Remove ${person.name}`, [agents, devices], () => { void this.act(machine, "person:" + person.id, token => Desk.revokeGuestPerson(token, machine.alias, person.id)); });
  }
  /** Removes the device from every share of the person that admits it, while this Settings scope
   *  lasts: one that can't be updated doesn't stop the others, and each is said after. */
  private confirmRemoveDevice(machine: Machine, person: Person, device: PersonDevice) {
    this.confirm(`Remove ${device.name}?`, `${person.name} can no longer open ${person.guests.length === 1 ? agentName(person.guests[0]!) : "these agents"} on ${device.name}, and its open sessions close. ${person.name}'s other devices keep access.`,
      "Remove device", [], () => {
        void this.act(machine, "device:" + device.fingerprint, async token => {
          const failed: string[] = [];
          for (const id of device.guests) {
            if (token !== this.token) return;
            try { await Desk.removeGuestDevice(token, machine.alias, id, device.fingerprint); }
            catch (error) { failed.push(`Couldn't remove from ${agentName(person.guests.find(guest => guest.guest_id === id)!)}: ${errorText(error)}`); }
          }
          if (failed.length) throw new Error(failed.join("\n"));
        });
      });
  }
  /** A share of an older herdr (no person): today's row, Revoke and Share Gram on it. */
  private guestRow(machine: Machine, guest: Guest) {
    const row = el("div", "settings-guest-person"), top = el("div", "settings-guest-top");
    const key = this.key(machine, guest.guest_id), sharing = this.pending.get(key)?.value ?? guest.share_gram ?? false;
    const lines = el("div", "settings-row-lines"); lines.append(el("div", "settings-row-label", guest.name), el("div", "settings-row-subtitle", `${agentName(guest)} on ${machine.label}${sharing ? " · Gram shared" : ""}`));
    const seconds = guest.last_seen_ms == null ? null : Math.max(0, (Date.now() - guest.last_seen_ms) / 1000), active = seconds !== null && seconds <= 300;
    const line = el("div", "settings-guest-presence"), dot = el("span", "settings-status-dot"); dot.dataset.state = active ? "reachable" : "unreachable";
    line.append(dot, document.createTextNode(seconds === null ? "accepted · not connected yet" : active ? `active · ${age(seconds)}` : `last active ${age(seconds)}`)); lines.append(line);
    if (guest.fingerprint) lines.append(el("div", "settings-account-email", [guest.fingerprint, guest.device].filter(Boolean).join(" · ")));
    const revoke = button("Revoke", () => this.confirmRevoke(machine, guest)); revoke.disabled = this.revoking.has(key); revoke.setAttribute("aria-label", `Revoke ${guest.name}`);
    top.append(initial(guest.name), lines, revoke);
    row.append(top, this.gramToggle(machine, guest, key, sharing)); return row;
  }
  private gramToggle(machine: Machine, guest: Guest, key: string, sharing: boolean) {
    const toggle = el("label", "settings-guest-toggle"), caption = el("span", "settings-row-lines"); caption.append(el("span", "settings-row-label", "Share Gram"), el("span", "settings-row-subtitle", `${guest.name} sees what ${guest.grant?.agent_name || "the agent"} sends you, and is notified`));
    const checkbox = el("input"); checkbox.type = "checkbox"; checkbox.checked = sharing; checkbox.setAttribute("aria-label", `Share Gram with ${guest.name}`); checkbox.disabled = this.revoking.has(key);
    checkbox.onchange = () => { this.pending.set(key, { value: checkbox.checked }); if (!this.running.has(key)) void this.sendSharing(machine, guest, key); };
    toggle.append(caption, checkbox); return toggle;
  }
  private async sendSharing(machine: Machine, guest: Guest, key: string) {
    const token = this.token; this.running.add(key);
    try {
      while (token === this.token) {
        const choice = this.pending.get(key); if (!choice) return;
        let error: unknown = null;
        try { await Desk.setGuestGramSharing(token, machine.alias, guest.guest_id, choice.value); } catch (reason) { error = reason; }
        if (token !== this.token) return;
        if (this.pending.get(key) !== choice) continue;
        await this.refresh();
        if (token !== this.token) return;
        if (this.pending.get(key) !== choice) continue;
        this.pending.delete(key); this.render();
        if (error) this.report(error); return;
      }
    } finally { this.running.delete(key); }
  }
  private inviteRow(machine: Machine, invite: Invite) {
    const row = el("div", "settings-guest-top settings-guest-invite"), lines = el("div", "settings-row-lines");
    let detail = `${invite.grant?.agent_name || "An agent"} on ${machine.label}${invite.share_gram ? " · Gram shared" : ""}`;
    if (invite.expires_ms !== undefined) { const seconds = Math.max(0, Math.floor((invite.expires_ms - Date.now()) / 1000)); detail += seconds < 3600 ? ` · expires in ${Math.max(1, Math.floor(seconds / 60))} min` : ` · expires in ${Math.floor(seconds / 3600)} h`; }
    lines.append(el("div", "settings-row-label", invite.name), el("div", "settings-row-subtitle", detail));
    const cancel = button("Cancel", () => { void this.act(machine, invite.invite_id, token => Desk.revokeGuestAccess(token, machine.alias, invite.invite_id, true)); }); cancel.disabled = this.revoking.has(this.key(machine, invite.invite_id)); cancel.setAttribute("aria-label", `Cancel invite for ${invite.name}`);
    row.append(lines, cancel); return row;
  }
  /** Revoke one share: from a person's page, Remove an agent (o2); on an older herdr's row, Revoke. */
  private confirmRevoke(machine: Machine, guest: Guest, person?: Person) {
    const agent = agentName(guest), run = () => { void this.act(machine, guest.guest_id, token => Desk.revokeGuestAccess(token, machine.alias, guest.guest_id, false)); };
    if (person) this.confirm(`Remove ${agent}?`, `${person.name} loses access to ${agent} on ${person.accountBound ? "every device" : "their device"} right away, and any open session closes.`, "Remove", [], run);
    else this.confirm(`Revoke ${guest.name}?`, `${guest.name} loses access to ${guest.grant?.agent_name || "the agent"} right away, and any open session closes.`, "Revoke", [], run);
  }
  /** One change on machine (id names what it changes, so its controls wait), then the lists again.
   *  work gets the Settings scope it began in, and sends only on it. */
  private async act(machine: Machine, id: string, work: (token: string) => Promise<void>) {
    const token = this.token, key = this.key(machine, id); if (this.revoking.has(key)) return;
    this.revoking.add(key); this.render();
    try { await work(token); } catch (error) { if (token === this.token) this.report(error); }
    finally { this.revoking.delete(key); if (token === this.token) await this.refresh(); }
  }
  private logRow(entry: Entry, guest?: Guest) {
    const row = el("div", "settings-guest-log"), header = el("div", "settings-guest-log-header"), who = entry.name || "A guest", agent = guest?.grant?.agent_name || entry.pane || "the agent";
    const headlines: Record<string, string> = { prompt: `${who} → ${agent}`, upload: `${who} → ${agent}`, accepted: `${who} joined`, connected: `${who} connected`, denied: `${who} was refused`, paused: `${who} paused`, revoked: `${who} revoked`,
      device_added: `${who} added a device`, device_removed: `${who}'s device was removed` };
    header.append(el("span", "", headlines[entry.event] || `${who} ${entry.event}`), el("time", "", clock(entry.ts_ms))); row.append(header);
    const details: Record<string, string> = { accepted: "Accepted your invite", connected: `Opened ${agent}`, denied: `Blocked ${entry.method || "a request"}`, paused: `${agent} left the foreground, so the stream paused`, revoked: "Access revoked" };
    const device = entry.event === "device_added" || entry.event === "device_removed";
    // The device the entry is from, by its fingerprint, removed ones included: an account-bound
    // share has several, and herdr writes device_removed without its name.
    const named = guest && entry.fingerprint ? admitted({ ...guest, devices: (guest.devices ?? []).map(d => ({ ...d, removed: false })) }).get(entry.fingerprint)?.name : guest?.device;
    const text = entry.event === "prompt" ? entry.text || "" : entry.event === "upload" ? `${entry.file?.name || "a file"}${entry.file?.size !== undefined ? " · " + entry.file.size.toLocaleString() + " bytes" : ""}` : device ? entry.text || named || "A device" : details[entry.event];
    if (text) row.append(el("p", "settings-guest-log-body", text));
    if (entry.fingerprint) row.append(el("div", "settings-account-email", "key " + [entry.fingerprint, device ? (guest?.account_bound ? `from ${who}'s account` : "") : named].filter(Boolean).join(" · ")));
    return row;
  }
}
