import { Desk } from "./mygo";
import type { NotificationSettings, NotificationPreferences } from "./mygo";

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

  constructor(private report: (error: unknown) => void, private summarize: (value: string) => void) { this.render(); }
  async refresh() {
    if (this.loading || this.running.size) return;
    this.loading = true;
    try { this.state = await Desk.getNotificationSettings(); }
    catch (error) { this.report(error); }
    finally { this.loading = false; this.render(); }
  }
  private render() {
    const focused = this.root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.preference : undefined;
    const card = el("div", "settings-group");
    const rows: [keyof NotificationPreferences, string][] = [["needsInput", "An agent needs input"], ["dies", "An agent dies"], ["finishes", "An agent finishes"], ["gram", "A gram message arrives"]];
    this.summarize(this.state ? `${rows.filter(([key]) => this.pending.get(key) ?? this.state!.preferences[key]).length} of ${rows.length}` : "");
    for (const [key, title] of rows) {
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
      catch (error) { this.status.textContent = String(error); }
      finally { test.disabled = !this.state?.supported; }
    };
    card.append(test);
    this.root.replaceChildren(el("h2", "settings-section-label", "NOTIFY ME WHEN"), card,
      el("p", "settings-row-subtitle", "Alerts work while Herdrup is running and connected. Exit and finished-turn alerts require live events from the home box. Gram arrivals are checked while its page is closed; existing unread messages do not alert when you connect."));
    if (focused) this.root.querySelector<HTMLInputElement>(`input[data-preference="${focused}"]`)?.focus();
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
}
