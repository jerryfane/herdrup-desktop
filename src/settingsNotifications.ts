import { Desk } from "./mygo";
import type { NotificationSettings, NotificationPreferences } from "./mygo";
import { errorText } from "./errors";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
}

export class NotificationsSettings {
  readonly root = el("section", "settings-section");
  private state: NotificationSettings | null = null;
  private loading = false;
  private pending = new Map<keyof NotificationPreferences, boolean>();
  private running = new Set<keyof NotificationPreferences>();
  private status = el("p", "settings-row-subtitle");
  // "An agent finishes" while its save runs: off, mine or always.
  private finishPending: FinishChoice | null = null;
  private finishRunning = false;

  constructor(private report: (error: unknown) => void, private summarize: (value: string, header: string, warn: boolean) => void,
    private picker: (select: HTMLSelectElement) => HTMLElement) { this.render(); }
  async refresh() {
    if (this.loading || this.running.size || this.finishRunning) return;
    this.loading = true;
    try { this.state = await Desk.getNotificationSettings(); }
    catch (error) { this.report(error); }
    finally { this.loading = false; this.render(); }
  }
  private render() {
    const focused = this.root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.preference : undefined;
    const card = el("div", "settings-group");
    const rows: [keyof NotificationPreferences, string][] = [["needsInput", "An agent needs input"], ["dies", "An agent dies"], ["finishes", "An agent finishes"], ["gram", "A gram message arrives"]];
    const finish = this.finishPending ?? (this.state ? finishChoice(this.state.preferences) : "off");
    // HerdrApp.swift 8442-8454: "N of 4" on the index row, "N of 4 alerts on" in the page
    // header; amber "N on · blocked" while alerts are on but this session cannot deliver them.
    const on = this.state ? rows.filter(([key]) => key === "finishes" ? finish !== "off" : this.pending.get(key) ?? this.state!.preferences[key]).length : 0;
    const blocked = !!this.state && on > 0 && !this.state.supported;
    this.summarize(!this.state ? "" : blocked ? `${on} on · blocked` : `${on} of ${rows.length}`, this.state ? `${on} of ${rows.length} alerts on` : "", blocked);
    for (const [key, title] of rows) {
      if (key === "finishes") { card.append(this.finishesRow(finish)); continue; }
      const row = el("label", "settings-row settings-notification-toggle"), input = el("input", "settings-switch");
      input.type = "checkbox"; input.setAttribute("role", "switch"); input.setAttribute("aria-label", title);
      input.dataset.preference = key;
      input.checked = this.pending.get(key) ?? this.state?.preferences[key] ?? false; input.disabled = !this.state;
      input.onchange = () => { this.pending.set(key, input.checked); if (!this.running.has(key)) void this.save(key); };
      row.append(el("span", "settings-row-label", title), input); card.append(row);
    }
    const delivery = el("div", "settings-row"), lines = el("div", "settings-row-lines");
    lines.append(el("span", "settings-row-label", this.state?.supported ? "Desktop notifications" : this.state ? "Notifications unavailable" : "Loading notification settings…"));
    this.status = el("p", "settings-row-subtitle", this.state?.lastError || (this.state?.supported ? "This build can request desktop alerts. Use the test below to check this session; your operating system controls banners, sound and Do Not Disturb." : "Desktop alerts cannot be requested in this session. Your choices are still saved on this device."));
    lines.append(this.status); delivery.append(lines); card.append(delivery);
    const test = el("button", "settings-plain-row", "Send test notification"); test.type = "button"; test.disabled = !this.state?.supported;
    test.onclick = async () => {
      test.disabled = true;
      try { await Desk.testNotification(); this.status.textContent = "Test sent to the desktop service. Check your system's notification centre; delivery does not prove a banner was shown."; }
      catch (error) { this.status.textContent = errorText(error); }
      finally { test.disabled = !this.state?.supported; }
    };
    card.append(test);
    this.root.replaceChildren(el("h2", "settings-section-label", "NOTIFY ME WHEN"), card,
      el("p", "settings-row-subtitle", "Alerts work while herdrup is running and connected. Exit and finished-turn alerts require live events from the home box. Gram arrivals are checked while its page is closed; existing unread messages do not alert when you connect."));
    if (focused) this.root.querySelector<HTMLElement>(`[data-preference="${focused}"]`)?.focus();
  }
  private async save(key: keyof NotificationPreferences) {
    this.running.add(key);
    try {
      while (this.pending.has(key)) {
        const value = this.pending.get(key)!;
        await Desk.setNotificationPreference(key, value);
        if (this.state) this.state.preferences[key] = value;
        if (this.pending.get(key) === value) this.pending.delete(key);
      }
    } catch (error) { this.pending.delete(key); this.report(error); }
    finally { this.running.delete(key); this.render(); }
  }
  /** "An agent finishes": Off / Only my requests / Always (HerdrApp.swift finishesRow at herdrup
   *  a7887c1). Only my requests on a herdr without turn origins alerts every finished turn, and
   *  the row says so. */
  private finishesRow(choice: FinishChoice) {
    const row = el("label", "settings-row settings-notification-choice"), lines = el("span", "settings-row-lines");
    const select = el("select", "settings-choice");
    select.setAttribute("aria-label", "An agent finishes"); select.id = "settings-notify-finishes"; select.dataset.preference = "finishes";
    for (const [value, label] of FINISH_CHOICES) { const option = el("option", "", label); option.value = value; select.append(option); }
    select.value = choice; select.disabled = !this.state;
    select.onchange = () => { this.finishPending = select.value as FinishChoice; if (!this.finishRunning) void this.saveFinishes(); else this.render(); };
    lines.append(el("span", "settings-row-label", "An agent finishes"));
    if (choice === "mine" && this.state?.turnOrigin === false) {
      const note = el("span", "settings-row-subtitle", "Herdr on this machine can't tell your requests apart yet, so you'll hear about every agent that finishes.");
      note.id = "settings-notify-finishes-fallback"; lines.append(note);
    }
    row.append(lines, this.picker(select));
    return row;
  }
  private async saveFinishes() {
    this.finishRunning = true;
    try {
      while (this.finishPending !== null) {
        const choice = this.finishPending;
        await Desk.setFinishNotifications(choice);
        if (this.state) { this.state.preferences.finishes = choice !== "off"; this.state.preferences.finishesMineOnly = choice === "mine"; }
        if (this.finishPending === choice) this.finishPending = null;
      }
    } catch (error) { this.finishPending = null; this.report(error); }
    finally { this.finishRunning = false; this.render(); }
  }
}

type FinishChoice = "off" | "mine" | "always";
const FINISH_CHOICES: [FinishChoice, string][] = [["off", "Off"], ["mine", "Only my requests"], ["always", "Always"]];
function finishChoice(p: NotificationPreferences): FinishChoice {
  return !p.finishes ? "off" : p.finishesMineOnly ? "mine" : "always";
}
