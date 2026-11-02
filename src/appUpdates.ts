import { Desk, events } from "./mygo";
import type { AppUpdateState } from "./mygo";
import { version as packageVersion } from "../package.json";

// Herdrup Desktop updating itself (desk_updates_app.go). The herdr server's
// update is settingsUpdates.ts.

/** appUpdateInterval in desk_updates_app.go. */
export const appUpdateIntervalHours = 6;

/** The reference captures (refshot.go) compare Settings with herdrup's iPad screenshots, which have no
 *  app update row: it is the desktop's own, left out of them. */
export const appUpdatesShown = Reflect.get(globalThis, "herdrupHoldsStill") !== true;

/** The short status beside the App updates row. */
export function appUpdateSummary(s: AppUpdateState | null): string {
  switch (s?.phase) {
    case "disabled": return "Off";
    case "checking": return "Checking…";
    case "upToDate": return "Up to date";
    case "available": return "Update available";
    case "installing": { const p = appUpdatePercent(s); return p === null ? "Updating…" : `Updating · ${p}%`; }
    case "restarting": return "Restarting…";
    case "failed": return "Couldn't check";
    default: return "";
  }
}

/** How much of the download is done, 0-100, or null while its size is unknown. */
export function appUpdatePercent(s: AppUpdateState): number | null {
  return s.total > 0 ? Math.min(100, Math.floor(s.downloaded * 100 / s.total)) : null;
}

/** The line under the download's progress bar. */
export function appUpdateProgress(s: AppUpdateState): string {
  const mb = (n: number) => (n / 1048576).toFixed(1);
  if (s.total > 0) return `Downloading · ${mb(s.downloaded)} of ${mb(s.total)} MB`;
  return s.downloaded > 0 ? `Downloading · ${mb(s.downloaded)} MB` : "Downloading…";
}

/** When the last check ended: the time today, else the date and time. */
export function appUpdateCheckedLine(checkedAt: number, now = new Date()): string {
  if (!checkedAt) return "";
  const at = new Date(checkedAt), time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === now.toDateString() ? `Last checked at ${time}.` : `Last checked ${at.toLocaleDateString()} at ${time}.`;
}

let latest: AppUpdateState | null = null, started = false, heard = false;
const listeners = new Set<(s: AppUpdateState) => void>();
function publish(s: AppUpdateState) { latest = s; for (const listener of listeners) listener(s); }

/** Calls listener with the app update's state now (once read) and at every change. */
export function watchAppUpdate(listener: (s: AppUpdateState) => void): () => void {
  listeners.add(listener);
  if (latest) listener(latest);
  if (!started) {
    started = true;
    events.appUpdateChanged.on(s => { heard = true; publish(s); });
    // An event that came first is newer than this read.
    void Desk.appUpdate().then(s => { if (!heard) publish(s); }).catch(() => {});
  }
  return () => { listeners.delete(listener); };
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag); n.textContent = text; n.className = className; return n;
}

/** The App updates page: the running version, the last check, Check now, and one-click
 *  Update and restart when a newer version is out. Same card as the herdr update's. */
export class AppUpdateSettings {
  readonly root = node("section", "", "settings-update-card");
  private state: AppUpdateState | null = null;
  private pending = false;

  constructor(private report: (error: unknown) => void) {
    this.root.id = "app-update-card";
    this.root.setAttribute("aria-live", "polite");
    watchAppUpdate(s => { this.state = s; this.render(); });
    this.render();
  }
  private text(text: string, className = "") { this.root.append(node("p", text, className)); }
  private button(label: string, action: () => Promise<unknown>, id: string, disabled = false) {
    const b = node("button", label); b.type = "button"; b.id = id; b.disabled = disabled || this.pending;
    b.onclick = () => {
      this.pending = true; this.render();
      void action().catch(this.report).finally(() => { this.pending = false; this.render(); });
    };
    return b;
  }
  render() {
    const s = this.state; this.root.replaceChildren();
    this.root.dataset.phase = s?.phase ?? "";
    this.root.setAttribute("aria-busy", String(!s));
    const current = s?.current || packageVersion;
    const checked = s ? appUpdateCheckedLine(s.checkedAt) : "";
    const header = (text: string) => this.root.append(node("h2", text));
    const actions = node("div", "", "settings-update-actions");
    const every = `herdrup checks for new versions, previews included, every ${appUpdateIntervalHours} hours.`;
    switch (s?.phase) {
      case "disabled":
        header(`herdrup ${current}`);
        this.text(s.reason || "This build can't update itself.");
        return;
      case "checking":
        header(`herdrup ${current}`);
        this.text("Checking for updates…");
        break;
      case "upToDate":
        header("herdrup is up to date");
        this.text(`You have ${current}, the newest version.`);
        break;
      case "failed":
        header("Couldn't check for updates");
        this.text(s.error);
        this.text(`You have ${current}.`, "settings-update-faint");
        break;
      case "available":
      case "installing":
      case "restarting": {
        header(`Version ${s.version} is available`);
        this.text(`You have ${current}.`);
        if (s.notes.trim()) this.text(s.notes.trim(), "settings-update-notes");
        if (s.phase === "installing") {
          const steps = node("div", "", "settings-update-steps"), item = node("div"), bar = node("progress");
          bar.max = 1; const p = appUpdatePercent(s); if (p !== null) bar.value = p / 100; // indeterminate until the size is known
          bar.setAttribute("aria-label", "Download");
          item.append(bar, node("span", "Download")); steps.append(item); this.root.append(steps);
          this.text(appUpdateProgress(s));
        } else if (s.phase === "restarting") {
          this.text(`Restarting into ${s.version}…`);
        } else if (s.error) {
          this.text(`The update didn't install: ${s.error}`);
        }
        const busy = s.phase !== "available";
        actions.append(this.button("Update and restart", () => Desk.installAppUpdate(), "app-update-install", busy));
        actions.append(this.button("Release notes", () => Desk.openExternalURL(`https://github.com/jerryfane/herdrup-desktop/releases/tag/v${encodeURIComponent(s.version)}`), "app-update-notes"));
        this.root.append(actions);
        if (!busy) this.text("herdrup quits and opens the new version. Your agents keep running on their machines.", "settings-update-faint");
        return;
      }
      default:
        header(`herdrup ${current}`);
        this.text(s ? "Not checked yet." : "Reading the update status…");
        if (!s) return;
    }
    actions.append(this.button("Check now", () => Desk.checkAppUpdate(), "app-update-check", s.phase === "checking")); this.root.append(actions);
    this.text([checked, every].filter(Boolean).join(" "), "settings-update-faint");
  }
}
