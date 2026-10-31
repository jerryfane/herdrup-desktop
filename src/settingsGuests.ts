import { Desk } from "./mygo";
import type { PeerSummary, SavedMachineStatus } from "./mygo";
import { guestOwnerName } from "./guestInviteModel";

type Machine = { alias: string; label: string };
type Grant = { terminal_id?: string; agent_name?: string };
type Guest = { guest_id: string; name: string; grant?: Grant; revoked?: boolean; share_gram?: boolean; last_seen_ms?: number; fingerprint?: string; device?: string };
type Invite = { invite_id: string; name: string; grant?: Grant; share_gram?: boolean; created_ms?: number; expires_ms?: number; used_by?: string };
type Entry = { event: string; guest_id?: string; name?: string; pane?: string; ts_ms: number; fingerprint?: string; text?: string; method?: string; file?: { name?: string; size?: number } };
type Listing = { guests?: Guest[]; invites?: Invite[]; link?: { state: string; last_error?: string } };
type Result = { machine: Machine; listing?: Listing; entries?: Entry[]; error?: string; auditError?: string; missingFeature?: boolean };
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

export class GuestSettings {
  readonly root = el("section", "settings-guests");
  private content = el("div");
  private token = "";
  private machines: Machine[] = [{ alias: "", label: "Home box" }];
  private results: Result[] = [];
  private generation = 0;
  private loaded = false;
  private modal: HTMLDialogElement | null = null;
  private pending = new Map<string, { value: boolean }>();
  private running = new Set<string>();
  private revoking = new Set<string>();
  constructor(private report: (message: unknown) => void, private summarize: (value: string) => void) {
    const input = el("input"); input.placeholder = "Your name"; input.setAttribute("aria-label", "Your name"); input.autocomplete = "name";
    const explanation = el("p", "settings-row-subtitle");
    let saved = ""; try { saved = localStorage.getItem("guest.ownerName") ?? ""; } catch { /* empty until a name can be saved */ }
    input.value = saved;
    const describe = () => {
      explanation.textContent = `People you share with see “Shared by ${guestOwnerName(input.value) ?? "you"}”. New invites use it.`;
    };
    input.oninput = () => { try { localStorage.setItem("guest.ownerName", input.value); saved = input.value; } catch (error) { input.value = saved; this.report(error); } describe(); };
    describe(); const owner = el("div", "settings-guest-owner"); owner.append(input, explanation);
    this.root.append(this.content, group("YOUR NAME", [owner])); this.render();
  }
  setScope(token: string) {
    if (token === this.token) return;
    this.closeDialogs(); this.token = token; this.generation++; this.results = []; this.loaded = false;
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
  closeDialogs() { this.modal?.close(); }
  private async refresh() {
    const token = this.token, at = ++this.generation;
    const results = await Promise.all(this.machines.map(async machine => {
      try { return { ...JSON.parse(await Desk.settingsGuestMachine(token, machine.alias)), machine } as Result; }
      catch (error) { return { machine, error: String(error) } as Result; }
    }));
    if (token !== this.token || at !== this.generation) return;
    this.results = results; this.loaded = true; this.render();
  }
  private key(machine: Machine, id: string) { return JSON.stringify([this.token, machine.alias, id]); }
  private render() {
    const people = this.results.flatMap(result => (result.listing?.guests ?? []).filter(guest => !guest.revoked).map(guest => ({ machine: result.machine, guest }))).sort((a, b) => (b.guest.last_seen_ms ?? 0) - (a.guest.last_seen_ms ?? 0));
    const invites = this.results.flatMap(result => (result.listing?.invites ?? []).filter(invite => !invite.used_by && (invite.expires_ms === undefined || invite.expires_ms > Date.now())).map(invite => ({ machine: result.machine, invite }))).sort((a, b) => (b.invite.created_ms ?? 0) - (a.invite.created_ms ?? 0));
    const failures = this.results.filter(result => result.error && (!result.missingFeature || !result.machine.alias));
    const summary: string[] = [];
    if (people.length) {
      const agents = new Set(people.map(({ machine, guest }) => JSON.stringify([machine.alias, guest.grant?.terminal_id ?? guest.grant?.agent_name ?? ""])));
      summary.push(`${people.length} ${people.length === 1 ? "person" : "people"}`, `${agents.size} agent${agents.size === 1 ? "" : "s"}`);
    }
    if (invites.length) summary.push(`${invites.length} invite${invites.length === 1 ? "" : "s"}`);
    this.summarize(!this.loaded ? "" : summary.length ? summary.join(" · ")
      : failures.some(result => !result.machine.alias) ? "Unavailable" : "Nobody yet");
    const peopleRows = people.map(({ machine, guest }) => this.personRow(machine, guest));
    if (!peopleRows.length) peopleRows.push(note(!this.token ? "Connect to a home box to manage shared access." : !this.loaded ? "Loading…" : failures.length ? "Shared access could not be loaded from every machine." : "Nobody has access. Share an agent from its ••• menu."));
    this.content.replaceChildren(group("PEOPLE", peopleRows));
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
  private personRow(machine: Machine, guest: Guest) {
    const row = el("div", "settings-guest-person"), top = el("div", "settings-guest-top"), identity = el("span", "settings-account-identity", Array.from(guest.name)[0]?.toUpperCase() || "?"); identity.setAttribute("aria-hidden", "true");
    const key = this.key(machine, guest.guest_id), sharing = this.pending.get(key)?.value ?? guest.share_gram ?? false;
    const lines = el("div", "settings-row-lines"); lines.append(el("div", "settings-row-label", guest.name), el("div", "settings-row-subtitle", `${guest.grant?.agent_name || "An agent"} on ${machine.label}${sharing ? " · Gram shared" : ""}`));
    const seconds = guest.last_seen_ms === undefined ? null : Math.max(0, (Date.now() - guest.last_seen_ms) / 1000), active = seconds !== null && seconds <= 300;
    const presence = el("div", "settings-guest-presence"), dot = el("span", "settings-status-dot"); dot.dataset.state = active ? "reachable" : "unreachable";
    presence.append(dot, document.createTextNode(seconds === null ? "accepted · not connected yet" : active ? `active · ${age(seconds)}` : `last active ${age(seconds)}`)); lines.append(presence);
    if (guest.fingerprint) lines.append(el("div", "settings-account-email", [guest.fingerprint, guest.device].filter(Boolean).join(" · ")));
    const revoke = button("Revoke", () => this.confirmRevoke(machine, guest)); revoke.disabled = this.revoking.has(key); revoke.setAttribute("aria-label", `Revoke ${guest.name}`);
    top.append(identity, lines, revoke);
    const toggle = el("label", "settings-guest-toggle"), caption = el("span", "settings-row-lines"); caption.append(el("span", "settings-row-label", "Share Gram"), el("span", "settings-row-subtitle", `${guest.name} sees what ${guest.grant?.agent_name || "the agent"} sends you, and is notified`));
    const checkbox = el("input"); checkbox.type = "checkbox"; checkbox.checked = sharing; checkbox.setAttribute("aria-label", `Share Gram with ${guest.name}`); checkbox.disabled = this.revoking.has(key);
    checkbox.onchange = () => { this.pending.set(key, { value: checkbox.checked }); if (!this.running.has(key)) void this.sendSharing(machine, guest, key); };
    toggle.append(caption, checkbox); row.append(top, toggle); return row;
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
    const cancel = button("Cancel", () => { void this.revoke(machine, invite.invite_id, true); }); cancel.disabled = this.revoking.has(this.key(machine, invite.invite_id)); cancel.setAttribute("aria-label", `Cancel invite for ${invite.name}`);
    row.append(lines, cancel); return row;
  }
  private confirmRevoke(machine: Machine, guest: Guest) {
    this.closeDialogs(); const token = this.token, modal = el("dialog", "settings-sheet"); this.modal = modal;
    const header = el("header", "settings-sheet-header"); header.append(el("h2", "", `Revoke ${guest.name}?`), button("Close", () => modal.close()));
    modal.append(header, el("p", "", `${guest.name} loses access to ${guest.grant?.agent_name || "the agent"} right away, and any open session closes.`), button("Cancel", () => modal.close()), button("Revoke", () => { modal.close(); if (token === this.token) void this.revoke(machine, guest.guest_id, false); }));
    modal.addEventListener("close", () => { if (this.modal === modal) this.modal = null; modal.remove(); }, { once: true }); document.body.append(modal); modal.showModal();
  }
  private async revoke(machine: Machine, id: string, invite: boolean) {
    const token = this.token, key = this.key(machine, id); if (this.revoking.has(key)) return;
    this.revoking.add(key); this.render();
    try { await Desk.revokeGuestAccess(token, machine.alias, id, invite); } catch (error) { if (token === this.token) this.report(error); }
    finally { this.revoking.delete(key); if (token === this.token) await this.refresh(); }
  }
  private logRow(entry: Entry, guest?: Guest) {
    const row = el("div", "settings-guest-log"), header = el("div", "settings-guest-log-header"), who = entry.name || "A guest", agent = guest?.grant?.agent_name || entry.pane || "the agent";
    const headlines: Record<string, string> = { prompt: `${who} → ${agent}`, upload: `${who} → ${agent}`, accepted: `${who} joined`, connected: `${who} connected`, denied: `${who} was refused`, paused: `${who} paused`, revoked: `${who} revoked` };
    header.append(el("span", "", headlines[entry.event] || `${who} ${entry.event}`), el("time", "", clock(entry.ts_ms))); row.append(header);
    const details: Record<string, string> = { accepted: "Accepted your invite", connected: `Opened ${agent}`, denied: `Blocked ${entry.method || "a request"}`, paused: `${agent} left the foreground, so the stream paused`, revoked: "Access revoked" };
    const text = entry.event === "prompt" ? entry.text || "" : entry.event === "upload" ? `${entry.file?.name || "a file"}${entry.file?.size !== undefined ? " · " + entry.file.size.toLocaleString() + " bytes" : ""}` : details[entry.event];
    if (text) row.append(el("p", "settings-guest-log-body", text));
    if (entry.fingerprint) row.append(el("div", "settings-account-email", "key " + [entry.fingerprint, guest?.device].filter(Boolean).join(" · ")));
    return row;
  }
}
