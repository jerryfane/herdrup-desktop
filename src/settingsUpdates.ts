import { Desk } from "./mygo";

interface Attempt {
  attempt_id: string; build_id: string; from: string; to: string; phase: string;
  bytes_done: number; bytes_total: number; restart_later: boolean;
  outcome?: string; message?: string; panes?: number;
}
interface UpdateState {
  known: boolean; version: string; flow: string; code: string; message: string;
  forbidden: boolean; restartLater: boolean; missing: string[];
  capabilities?: { server_update?: boolean; agent_groups?: boolean; agent_avatar?: boolean; agent_answer?: boolean };
  check?: {
    running: { version: string; build_id?: string; commit_time?: number };
    latest?: { version: string; build_id: string; commit_time: number; notes: string };
    update_available: boolean; mode: string; reason?: string;
  };
  pending?: Attempt; attempt?: Attempt;
}
const minCommitTime = 1793108998; // accepted Swift ServerRequirement.current
const baseVersion = (version: string) => version.split(/[- +]/, 1)[0] || version;
function labels(old: string, next: string): [string, string] {
  if (baseVersion(old) !== baseVersion(next)) return [baseVersion(old), baseVersion(next)];
  const oldDate = old.match(/\d{4}-\d{2}-\d{2}/)?.[0], nextDate = next.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  return oldDate && nextDate && oldDate !== nextDate ? [`${baseVersion(old)} of ${oldDate}`, `${baseVersion(next)} of ${nextDate}`] : [old, next];
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag); n.textContent = text; n.className = className; return n;
}

export class ServerUpdateSettings {
  readonly root = node("section", "", "settings-update-card");
  private token = "";
  private host = "Machine";
  private timer?: number;
  private generation = 0;
  private rendered = "";
  private pending = false;
  private modal?: HTMLDialogElement;
  private state?: UpdateState;

  constructor(private report: (error: unknown) => void) {
    this.root.id = "server-update-card"; this.root.hidden = true;
    this.root.setAttribute("aria-live", "polite");
  }
  setScope(token: string, host = "Machine") {
    this.generation++; this.token = token; this.host = host;
    clearTimeout(this.timer); this.modal?.close(); this.pending = false;
    this.state = undefined; this.rendered = ""; this.root.hidden = true; this.root.replaceChildren();
    if (token) void this.read(true);
  }
  setHost(host: string) {
    if (this.host === host) return;
    this.host = host; this.render();
  }
  private async read(refresh: boolean) {
    const at = this.generation, token = this.token;
    if (!token) return;
    try {
      const raw = await Desk.settingsServerUpdate(token, refresh);
      if (at !== this.generation) return;
      this.state = JSON.parse(raw) as UpdateState;
      if (raw !== this.rendered) { this.rendered = raw; this.render(); }
    } catch (error) { if (at === this.generation) this.report(error); }
    finally {
      if (at === this.generation) {
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => { void this.read(false); }, 1000);
      }
    }
  }
  private button(label: string, action: () => void, id = "") {
    const b = node("button", label); b.type = "button"; b.id = id;
    b.disabled = this.pending; b.onclick = action; return b;
  }
  private text(text: string, faint = false) { this.root.append(node("p", text, faint ? "settings-update-faint" : "")); }
  private header(text: string) { this.root.append(node("h2", text)); }
  private command(command: string) {
    const row = node("div", "", "settings-update-command");
    const copy = this.button("Copy", () => { void Desk.gramCopyText(command).then(() => { copy.textContent = "Copied"; }).catch(this.report); });
    row.append(node("code", command), copy); this.root.append(row);
  }
  private cantSwitch(reason?: string) {
    if (reason === "systemd_main_process") return `${this.host} runs herdr as a system service, so it can't switch while running.`;
    if (reason === "endpoint_generation_changed") return `This version changes how herdr is reached, so ${this.host} can't switch while running.`;
    if (reason === "no_live_handoff") return `herdr on ${this.host} can't hand over while running.`;
    if (reason === "windows") return "herdr on Windows can't switch while running.";
    return `${this.host} can't switch herdr while it's running.`;
  }
  private async action(run: (token: string) => Promise<void>) {
    if (this.pending || !this.token) return;
    const at = this.generation, token = this.token;
    this.pending = true; this.render();
    try { await run(token); }
    catch (error) { if (at === this.generation) this.report(error); }
    finally {
      if (at === this.generation) { this.pending = false; this.rendered = ""; await this.read(false); }
    }
  }
  private confirm(buildID: string, restartLater: boolean, old: string, next: string) {
    this.modal?.close();
    const at = this.generation;
    const modal = node("dialog", "", "settings-sheet"); this.modal = modal;
    modal.id = "server-update-confirm";
    modal.append(node("h2", restartLater ? `Download herdr ${next} to ${this.host}?` : `Update herdr on ${this.host}?`));
    modal.append(node("p", restartLater
      ? "It installs now and starts the next time herdr restarts. Restarting herdr closes terminals; your layout comes back."
      : `From ${old} to ${next}. Terminals and agents keep running; the app reconnects in a few seconds.`));
    modal.append(this.button("Cancel", () => modal.close()), this.button(restartLater ? "Download" : "Update", () => {
      modal.close();
      if (at === this.generation) void this.action(token => Desk.applySettingsServerUpdate(token, buildID, restartLater));
    }, "server-update-confirm-apply"));
    modal.addEventListener("close", () => { modal.remove(); if (this.modal === modal) this.modal = undefined; }, { once: true });
    document.body.append(modal); modal.showModal();
  }
  private failed(s: UpdateState, outcome?: string) {
    const old = baseVersion(s.attempt?.from || s.check?.running.version || s.version);
    if (s.flow === "lostTrack") {
      this.header("Lost track of the update"); this.text(`${this.host} stopped answering while it switched. Your terminals keep running there.`);
    } else if (outcome === "needs_attention") {
      this.header(`herdr may need a hand on ${this.host}`); this.text("Open a terminal there and run herdr status server. Nothing was closed.");
    } else {
      this.header("Update didn't finish");
      this.text(outcome === "rolled_back" ? `The new version didn't pass its checks, so herdr switched back to ${old}. Your terminals are fine.`
        : old ? `Nothing changed. herdr ${old} is still running, and your terminals are fine.` : "Nothing changed. Your terminals are fine.");
    }
    const why = s.attempt?.message || s.message; if (why) this.text(why, true);
    const actions = node("div", "", "settings-update-actions");
    if (s.flow === "lostTrack") actions.append(this.button("Look again", () => { void this.action(token => Desk.recheckSettingsServerUpdate(token, true)); }, "server-update-look-again"));
    else if (outcome !== "rolled_back" && outcome !== "needs_attention" && s.code !== "update_unsupported_install" && s.code !== "update_not_available") {
      actions.append(this.button("Try again", () => { void this.action(token => Desk.recheckSettingsServerUpdate(token, false)); }, "server-update-retry"));
    }
    const copy = this.button("Copy details", () => {
      const details = `herdr update on ${this.host}\n${s.attempt ? JSON.stringify(s.attempt, null, 2) : `refused: ${s.code}\nmessage: ${s.message}`}`;
      void Desk.gramCopyText(details).then(() => { copy.textContent = "Copied"; }).catch(this.report);
    }, "server-update-copy-details");
    actions.append(copy); this.root.append(actions);
  }
  private render() {
    const s = this.state; this.root.replaceChildren(); this.root.hidden = true;
    if (!s || s.forbidden || !s.known) return;
    this.root.hidden = false; this.root.dataset.flow = s.flow;
    const a = s.attempt, c = s.check;
    if (s.flow === "running") {
      this.header("Updating herdr");
      const step = !a || a.phase === "downloading" ? 0 : ["verifying", "testing"].includes(a.phase) ? 1 : 2;
      const steps = node("div", "", "settings-update-steps");
      for (const [index, label] of ["Download", "Check", "Switch over"].entries()) {
        const item = node("div"), progress = node("progress"); progress.max = 1;
        progress.value = index < step ? 1 : index > step ? 0 : step === 0 ? (a?.bytes_total ? Math.min(1, a.bytes_done / a.bytes_total) : 0) : 1;
        item.append(progress, node("span", label)); steps.append(item);
      }
      this.root.append(steps);
      const mb = (n: number) => Math.round(n / 1048576);
      this.text(!a || a.phase === "downloading" ? `Downloading${a?.bytes_total ? ` · ${mb(a.bytes_done)} of ${mb(a.bytes_total)} MB` : "…"}`
        : a.phase === "verifying" ? "Checking the download…" : a.phase === "testing" ? "Checking the new version…"
        : a.phase === "installing" ? "Installing the new version…" : "Switching over. Reconnecting…");
      this.text("Your terminals stay open. You can leave this screen.", true); return;
    }
    if (s.flow === "lostTrack" || s.flow === "refused") { this.failed(s); return; }
    if (s.flow === "finished" && a?.outcome && a.outcome !== "downloaded_restart_required") {
      if (a.outcome === "updated" || a.outcome === "updated_disk_stale") {
        this.header(`herdr ${labels(a.from, a.to)[1]} is running`);
        this.text(a.panes === undefined ? "Your terminals and agents kept running." : `${a.panes} ${a.panes === 1 ? "terminal stayed" : "terminals stayed"} open.`);
        const caps = s.capabilities;
        const nowOn = (s.missing || []).filter(feature => feature === "folders" ? caps?.agent_groups : feature === "avatars" ? caps?.agent_avatar : caps?.agent_answer);
        if (nowOn.length) this.text(`Now on: ${nowOn.join(", ")}.`);
        if (a.outcome === "updated_disk_stale") this.text("herdr couldn't replace its copy on disk, so a full restart would start the old version.", true);
      } else this.failed(s, a.outcome);
      return;
    }
    if (!s.capabilities?.server_update) {
      this.header(`Update herdr once on ${this.host}`);
      this.text(`herdr ${baseVersion(s.version)} can't update itself from the app. Run this once on ${this.host}:`);
      this.command("herdr update --handoff");
      this.text("It asks before closing any terminal. After this, updates take one tap here.", true);
      this.text("If that doesn't work, reinstall and restart herdr. Restarting closes terminals:", true);
      this.command("curl -fsSL https://herdrup.themartian.app/install.sh | sh"); this.command("herdr server stop"); this.command("herdr"); return;
    }
    if (!c) { this.root.hidden = true; return; }
    const pending = s.flow === "finished" && a?.outcome === "downloaded_restart_required" ? a : s.pending;
    if (pending && c.running.build_id !== pending.build_id) {
      this.header("Downloaded. Finishes on next restart");
      this.text(`${this.cantSwitch(c.reason)} herdr ${labels(pending.from, pending.to)[1]} starts the next time herdr restarts.`);
      this.text("Restarting herdr closes terminals. Your layout comes back.", true); return;
    }
    const caps = s.capabilities;
    const missing = [!caps.agent_groups && "folders", !caps.agent_avatar && "avatars", !caps.agent_answer && "answers from notifications"].filter(Boolean) as string[];
    const meets = !missing.length && (c.running.commit_time === undefined || c.running.commit_time >= minCommitTime);
    if (!c.update_available || !c.latest || (!meets && c.latest.commit_time < minCommitTime)) {
      if (meets) this.root.hidden = true;
      else { this.header("A newer herdr is on its way"); this.text(`This app needs a newer herdr than has been published yet. ${this.host} has ${baseVersion(c.running.version)}.`); }
      return;
    }
    if (c.mode !== "live" && c.mode !== "restart_required") {
      this.header(`Update herdr on ${this.host}`);
      if (c.reason === "package_managed") this.text(`herdr on ${this.host} is installed by a package manager. Update it with Homebrew, mise or nix there.`);
      else if (c.reason === "windows") this.text(`herdr on Windows can't update itself from the app yet. Update it on ${this.host}.`);
      else { this.text(`herdr's folder on ${this.host} isn't writable, so the app can't update it. Run this on ${this.host}:`); this.command("herdr update --handoff"); }
      return;
    }
    const [old, next] = labels(c.running.version, c.latest.version), restart = c.mode === "restart_required";
    this.header(`Update herdr on ${this.host}`);
    this.text(missing.length ? `${missing.join(", ")} ${missing.length === 1 ? "needs" : "need"} herdr ${next}. ${this.host} has ${old}.` : `herdr ${next} is ready. ${this.host} has ${old}.`);
    if (c.latest.notes) this.text(`New in ${next}: ${c.latest.notes}`, true);
    if (restart) this.text(`${this.cantSwitch(c.reason)} It finishes the next time herdr restarts.`, true);
    const buildID = c.latest.build_id;
    this.root.append(this.button(restart ? "Download now, finish on restart" : "Update herdr", () => this.confirm(buildID, restart, old, next), "server-update-apply"));
    this.text(restart ? "Restarting herdr closes terminals. Your layout comes back." : "Takes about a minute. Terminals and agents keep running; the app reconnects by itself.", true);
  }
}
