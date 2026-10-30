import { Desk, events } from "./mygo";
import type { AccountLoginState } from "./mygo";

type Account = {
  id: string; kind: string; label: string; config_dir: string; email?: string; active: boolean;
  readiness?: { ready: boolean; detail?: string };
  usage?: { plan?: string; tier?: string; source?: string; primary_used_percent?: number; secondary_used_percent?: number; resets_at?: string; windows?: { label: string; used_percent?: number; resets_at?: string }[] };
};
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
}
function button(label: string, action: () => void) {
  const node = el("button", "", label); node.type = "button"; node.onclick = action; return node;
}
function accountsFrom(json: string): Account[] { return (JSON.parse(json) as { accounts: Account[] }).accounts ?? []; }

export class AccountSettings {
  readonly root = el("section", "settings-section");
  private token = "";
  private accounts: Account[] = [];
  private modal: HTMLDialogElement | null = null;
  private busy = false;
  private loading = false;
  private error = "";
  private menu: { id: string; token: string; account: Account } | null = null;
  constructor(private report: (message: unknown) => void) {
    events.settingsAccountMenu.on(choice => {
      const menu = this.menu;
      if (!menu || menu.id !== choice.id || menu.token !== choice.token || this.token !== choice.token) return;
      this.menu = null; this.performAction(menu.account, choice.action, choice.agentCount);
    });
    this.render();
  }
  setScope(token: string) {
    if (token === this.token) return;
    this.closeDialogs(); this.token = token; this.accounts = []; this.error = ""; this.busy = false;
    this.loading = !!token; this.render();
    if (token) void this.refresh();
  }
  closeDialogs() { this.menu = null; this.modal?.close(); }
  private dialog(title: string) {
    this.closeDialogs(); const modal = el("dialog", "settings-sheet");
    const header = el("header", "settings-sheet-header"); header.append(el("h2", "", title), button("Close", () => modal.close()));
    modal.append(header); document.body.append(modal); this.modal = modal;
    modal.addEventListener("close", () => { if (this.modal === modal) this.modal = null; modal.remove(); }, { once: true });
    return modal;
  }
  private async refresh() {
    const token = this.token;
    try { const accounts = accountsFrom(await Desk.settingsAccounts(token)); if (this.token === token) this.accounts = accounts; }
    catch (error) { if (this.token === token) this.error = String(error); }
    finally { if (this.token === token) { this.loading = false; this.render(); } }
  }
  private render() {
    const card = el("div", "settings-group");
    for (const account of this.accounts) card.append(this.accountRow(account));
    if (!this.accounts.length) {
      const empty = el("div", "settings-account-empty");
      empty.append(el("p", "", this.loading ? "Loading accounts…" : this.token ? "No accounts configured." : "Connect to a home box to see its accounts."));
      if (!this.loading && this.token) empty.append(el("p", "settings-row-subtitle", "Subscriptions set up on your home box appear here."));
      card.append(empty);
    }
    const add = button("Add account", () => this.add()); add.className = "settings-plain-row"; add.disabled = !this.token || this.busy;
    const guide = button("How accounts work", () => this.guide()); guide.className = "settings-plain-row";
    card.append(add, guide);
    this.root.replaceChildren(el("h2", "settings-section-label", "ACCOUNTS"), card);
    if (this.error) this.root.append(el("p", "settings-inline-error", this.error));
  }
  private accountRow(account: Account) {
    const node = el("div", "settings-account-row"); node.tabIndex = 0;
    const identity = el("span", "settings-account-identity", account.kind.slice(0, 1).toUpperCase()); identity.setAttribute("aria-hidden", "true");
    const lines = el("div", "settings-row-lines");
    lines.append(el("div", "settings-row-label", account.label), el("div", "settings-row-subtitle", [account.kind, account.usage?.plan || account.usage?.tier].filter(Boolean).join(" · ")));
    if (account.email) lines.append(el("div", "settings-account-email", account.email));
    if (account.readiness && !account.readiness.ready) lines.append(el("div", "settings-row-subtitle", account.readiness.detail || "Not ready to resume agents"));
    const trailing = el("div", "settings-account-trailing");
    const windows = account.usage?.windows?.length ? account.usage.windows : [
      { label: "5h", used_percent: account.usage?.primary_used_percent, resets_at: account.usage?.resets_at },
      { label: "Weekly", used_percent: account.usage?.secondary_used_percent },
    ];
    for (const window of windows) {
      if (window.used_percent === undefined) continue;
      const meter = el("div", "settings-usage"), percent = Math.max(0, Math.min(100, window.used_percent));
      const progress = el("progress"); progress.max = 100; progress.value = percent; progress.setAttribute("aria-hidden", "true");
      meter.append(progress, el("span", "settings-usage-essential", `${Math.round(percent)}% · ${window.label}`));
      let description = `${Math.round(percent)}% · ${window.label}`;
      if (window.resets_at) {
        const reset = new Date(window.resets_at);
        if (!Number.isNaN(reset.getTime())) {
          const hint = reset.toDateString() === new Date().toDateString() ? reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : reset.toLocaleDateString([], { weekday: "short" });
          meter.append(el("span", "settings-usage-reset", `· ${hint}`)); description += ` · resets ${hint}`; meter.title = `Resets ${reset.toLocaleString()}`;
        }
      }
      if (account.usage?.source === "live") description += " · live";
      meter.setAttribute("aria-label", description); meter.setAttribute("role", "img");
      trailing.append(meter);
    }
    const status = el("span", "settings-account-status"); const dot = el("span", "settings-status-dot"); dot.dataset.state = account.active ? "reachable" : "unreachable";
    status.append(dot); status.setAttribute("aria-label", account.active ? "active" : "exhausted");
    if (!account.active) { status.append(document.createTextNode("exhausted")); status.classList.add("settings-account-exhausted"); }
    trailing.append(status);
    const actions = button("•••", () => this.actions(account)); actions.setAttribute("aria-label", `Actions for ${account.label}`); actions.disabled = this.busy;
    node.append(identity, lines, trailing, actions);
    node.addEventListener("contextmenu", event => { event.preventDefault(); if (!this.busy) this.actions(account); });
    node.addEventListener("keydown", event => { if (event.key === "F10" && event.shiftKey || event.key === "ContextMenu") { event.preventDefault(); if (!this.busy) this.actions(account); } });
    return node;
  }
  private actions(account: Account) {
    const id = crypto.randomUUID(), token = this.token; this.menu = { id, token, account };
    void Desk.settingsAccountMenu(token, id, account.id).catch(error => { if (this.menu?.id === id && token === this.token) this.report(error); });
  }
  private performAction(account: Account, action: string, count: number) {
    if (action === "login") { this.login(account); return; }
    if (action === "swap") {
      this.confirm(`Use ${account.label} for all ${account.kind} agents?`, `This restarts ${count} agent${count === 1 ? "" : "s"} on this subscription.`, `Move ${count} agents`, async token => {
        const result = await Desk.swapSettingsAccount(token, account.id); if (token === this.token) { this.report(result); await this.refresh(); }
      });
    } else if (action === "logout") {
      this.confirm(`Log out ${account.label}?`, "This clears this account's Claude sign-in, not its registration or other accounts.", "Log out", async token => {
        const accounts = accountsFrom(await Desk.logoutSettingsAccount(token, account.id));
        if (token === this.token) { this.accounts = accounts; this.report("Logout command sent. The refreshed account identity is shown below."); }
      });
    } else if (action === "remove") {
      this.confirm(`Remove ${account.label}?`, "Remove its registration from the home box. Its config directory and credentials stay in place and can be registered again.", "Remove account", async token => {
        const accounts = accountsFrom(await Desk.removeSettingsAccount(token, account.id)); if (token === this.token) this.accounts = accounts;
      });
    }
  }
  private confirm(title: string, description: string, label: string, action: (token: string) => Promise<void>) {
    const token = this.token, modal = this.dialog(title); modal.append(el("p", "", description));
    modal.append(button("Cancel", () => modal.close()), button(label, () => {
      modal.close(); if (token !== this.token || this.busy) return;
      this.busy = true; this.render();
      void action(token).catch(error => { if (token === this.token) this.report(error); }).finally(() => { if (token === this.token) { this.busy = false; this.render(); } });
    })); modal.showModal();
  }
  private add() {
    const token = this.token, modal = this.dialog("Add account"), form = el("form", "settings-account-form");
    const kind = el("select"); kind.setAttribute("aria-label", "Account kind");
    for (const name of ["claude", "codex", "kimi"]) { const option = el("option", "", name); option.value = name; kind.append(option); }
    const label = el("input"); label.placeholder = "Claude · work"; label.setAttribute("aria-label", "Account label"); label.required = true;
    const error = el("p", "settings-inline-error"); const submit = el("button", "", "Add account"); submit.type = "submit";
    form.append(el("label", "", "Kind"), kind, el("label", "", "Label"), label, el("p", "settings-row-subtitle", "Sign in to it next, or later, from Accounts."), error, submit);
    form.onsubmit = event => {
      event.preventDefault(); if (token !== this.token || submit.disabled) return;
      submit.disabled = true; const selectedKind = kind.value, selectedLabel = label.value.trim();
      void Desk.createSettingsAccount(token, selectedKind, selectedLabel).then(json => {
        if (token !== this.token) return;
        this.accounts = accountsFrom(json); this.render();
        const created = this.accounts.findLast(account => account.kind === selectedKind && account.label === selectedLabel);
        const stillOpen = modal.open; modal.close();
        if (stillOpen && created?.kind === "claude" && created.config_dir) this.login(created);
      }).catch(reason => { if (token === this.token && modal.open) { error.textContent = String(reason); submit.disabled = false; } });
    };
    modal.append(form); modal.showModal(); label.focus();
  }
  private login(account: Account) {
    const token = this.token, loginID = crypto.randomUUID(), modal = this.dialog(`Log in · ${account.label}`);
    const status = el("p", "", "Getting a sign-in link…"), link = button("Open sign-in link", () => { if (current?.url) void Desk.openExternalURL(current.url).catch(error => { status.textContent = String(error); }); });
    link.disabled = true;
    const code = el("input"); code.type = "password"; code.autocomplete = "off"; code.placeholder = "Paste authorization code"; code.setAttribute("aria-label", "Authorization code");
    const form = el("form", "settings-account-form"), submit = el("button", "", "Sign in"); submit.type = "submit"; submit.disabled = true;
    form.append(code, submit);
    let current: AccountLoginState | null = null, timer = 0, serial = 0, closed = false, sending = false, starting = false;
    const valid = () => !closed && token === this.token && modal.open;
    const update = (state: AccountLoginState) => {
      current = state; status.textContent = state.message; link.disabled = !state.url;
      submit.disabled = sending || !state.url || state.phase === "submitting" || state.phase === "signedIn";
      code.disabled = state.phase === "signedIn";
    };
    const poll = async (at: number) => {
      if (!valid() || at !== serial) return;
      try {
        const state = await Desk.pollAccountLogin(token, loginID); if (!valid() || at !== serial) return; update(state);
        if (state.phase === "signedIn") { code.value = ""; timer = window.setTimeout(() => { if (valid()) { modal.close(); void this.refresh(); } }, 1600); return; }
      } catch (error) { if (valid() && at === serial) status.textContent = String(error); }
      if (valid() && at === serial) timer = window.setTimeout(() => { void poll(at); }, 4000);
    };
    const start = async (setup: boolean) => {
      if (starting || sending || !valid()) return;
      starting = true;
      const at = ++serial; window.clearTimeout(timer); submit.disabled = true; link.disabled = true; code.value = ""; status.textContent = "Getting a sign-in link…";
      try { const state = await Desk.startAccountLogin(token, loginID, account.id, setup); if (valid() && at === serial) { update(state); void poll(at); } }
      catch (error) { if (valid() && at === serial) status.textContent = String(error); }
      finally { starting = false; }
    };
    form.onsubmit = event => {
      event.preventDefault(); if (submit.disabled || !code.value.trim()) return;
      sending = true; submit.disabled = true; const at = ++serial; window.clearTimeout(timer);
      void Desk.submitAccountLogin(token, loginID, code.value).then(() => { if (valid() && at === serial && current) update({ ...current, phase: "submitting", message: "Signing you in…" }); })
        .catch(error => { if (valid() && at === serial) status.textContent = String(error); })
        .finally(() => { sending = false; if (valid() && at === serial && current) { submit.disabled = current.phase === "submitting" || current.phase === "signedIn"; void poll(at); } });
    };
    const setup = button("Use setup token instead", () => {
      // Setup-token creates a long-lived credential; choose it deliberately.
      const warning = el("p", "", "Setup token creates a long-lived token. Keep it in this account's config home; never export CLAUDE_CODE_OAUTH_TOKEN globally.");
      const proceed = button("Continue with setup token", () => { warning.remove(); proceed.remove(); setup.disabled = false; void start(true); });
      setup.disabled = true; modal.append(warning, proceed);
    });
    modal.append(el("p", "settings-row-subtitle", account.config_dir), status, link, form, button("Start browser sign-in again", () => { void start(false); }), setup);
    modal.addEventListener("close", () => { closed = true; serial++; window.clearTimeout(timer); code.value = ""; void Desk.closeAccountLogin(token, loginID).catch(() => undefined); }, { once: true });
    modal.showModal(); void start(false);
  }
  private guide() {
    const modal = this.dialog("How accounts work");
    modal.append(el("p", "", "Accounts are subscriptions registered on your home box. Their credentials stay in separate config directories on that box, never in this app."), el("p", "", "Add an account, then sign in. Claude supports in-app sign-in; for Codex or Kimi, sign in on the box using that account's config directory."), el("p", "", "Use an account's menu to move all agents of the same kind, log out, or remove its registration. Moving agents restarts their current turns. Readiness and usage are checked by the home box."));
    modal.showModal();
  }
}
