// The owner's first screen in the browser (web owner access mockup 1): approving this browser,
// one card per phase of ownerApproval.ts, and, once approved, the machines it may reach.

import type { EnvelopeMachine, EnvelopeSkipped } from "../webguest/approve";
import type { OwnerPhase } from "./ownerApproval";
import type { OwnerRecord } from "./ownerStore";
import { statusText, type MachineStatus } from "./ownerProbe";

/** What this browser is called on the account's devices and on the approval sheet: "Chrome on
 *  macOS", from the user agent; "Web browser" when it can't tell. */
export function browserDeviceName(ua: string): string {
 const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /(Chrome|CriOS)\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
 const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "ChromeOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS"
  : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
 if (browser && os) return `${browser} on ${os}`;
 return browser || (os ? `Browser on ${os}` : "Web browser");
}

export interface OwnerActions { again(): void; guestInstead(): void; open(machine: EnvelopeMachine): void }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
 const e = document.createElement(tag);
 if (cls) e.className = cls;
 if (text !== undefined) e.textContent = text;
 return e;
}

function button(cls: string, text: string, run: () => void) {
 const b = el("button", cls, text); b.type = "button";
 b.addEventListener("click", run);
 return b;
}

function waiting(spinnerSVG: string) {
 const w = el("div", "web-owner-waiting");
 const spin = el("span", "web-owner-spinner"); spin.innerHTML = spinnerSVG; spin.setAttribute("aria-hidden", "true");
 w.append(spin, document.createTextNode("Waiting…"));
 w.setAttribute("role", "status");
 return w;
}

const SKIP_TEXT: Record<EnvelopeSkipped["reason"], string> = {
 needs_update: "Needs a herdr update",
 unsupported: "Doesn't support browser access",
 unreachable: "Couldn't be reached when you approved",
 relay_not_allowed: "Uses a relay this page can't reach",
};

const until = (unix: number) => new Date(unix * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** The machines every verified approver granted, one row each (the latest grant per machine). */
export function approvedMachines(record: OwnerRecord): { machines: EnvelopeMachine[]; skipped: EnvelopeSkipped[] } {
 const machines = new Map<string, EnvelopeMachine>();
 const skipped = new Map<string, EnvelopeSkipped>();
 for (const a of record.approvers) {
  for (const m of a.envelope.machines) {
   const had = machines.get(m.hostID);
   if (had === undefined || m.expiresUnix > had.expiresUnix) machines.set(m.hostID, m);
  }
  for (const s of a.envelope.skipped) skipped.set(s.hostItemID, s);
 }
 const granted = new Set([...machines.values()].map(m => m.hostItemID));
 return { machines: [...machines.values()], skipped: [...skipped.values()].filter(s => !granted.has(s.hostItemID)) };
}

/** The card for phase; deviceName is this browser's name, statuses each machine's probe. */
export function ownerCard(phase: OwnerPhase, deviceName: string, actions: OwnerActions, spinnerSVG: string,
 statuses: ReadonlyMap<string, MachineStatus> = new Map()): HTMLElement {
 const card = el("div", "web-welcome-card web-owner-card");
 const guest = () => button("web-owner-link", "Use a guest invitation instead", actions.guestInstead);
 const again = (label = "Ask again") => button("web-owner-action", label, actions.again);
 switch (phase.kind) {
  case "starting":
  case "waiting":
   card.append(el("h1", "", "Approve this browser"),
    el("p", "", `Open HerdrUp on your Mac, PC or iPhone. It will ask to approve ${deviceName}.`),
    waiting(spinnerSVG), guest(),
    el("p", "web-owner-note", "This browser made its own key. Your machines accept it only after you approve it."));
   break;
  case "code": {
   const digits = el("div", "web-owner-code");
   digits.setAttribute("aria-label", `Code ${phase.code.split("").join(" ")}`);
   for (const d of phase.code) digits.append(el("span", "", d));
   card.append(el("h1", "", "Enter this code in HerdrUp"),
    el("p", "", `${phase.approver} opened the request to approve ${deviceName}. Type these 4 digits there.`),
    digits, waiting(spinnerSVG));
   break;
  }
  case "denied":
   card.append(el("h1", "", "Not approved"), el("p", "", "HerdrUp didn't approve this browser."), again(), guest());
   break;
  case "expired":
   card.append(el("h1", "", "The request expired"), el("p", "", "No device approved this browser in time."), again(), guest());
   break;
  case "failed": {
   const problem = el("p", "web-welcome-error", phase.problem); problem.setAttribute("role", "alert");
   card.append(el("h1", "", "Couldn't ask for approval"), problem, again("Try again"), guest());
   break;
  }
  case "unsupported":
   card.append(el("h1", "", "This browser can't be approved"),
    el("p", "", "It can't keep its key out of reach of the page's scripts. Use a current Chrome, Edge, Firefox or Safari to reach your machines from the web."), guest());
   break;
  case "elsewhere":
   card.append(el("h1", "", "Approving in another tab"), el("p", "", "Finish there, or close that tab and try again here."), again("Try again"));
   break;
  case "approved":
   card.append(...approvedList(phase.record, statuses, actions.open));
   break;
 }
 return card;
}

function approvedList(record: OwnerRecord, statuses: ReadonlyMap<string, MachineStatus>, open: (m: EnvelopeMachine) => void): HTMLElement[] {
 const { machines, skipped } = approvedMachines(record);
 const names = [...new Set(record.approvers.map(a => a.name))].join(", ");
 const list = el("ul", "web-owner-machines");
 for (const m of machines) {
  const row = el("li");
  const status = statuses.get(m.hostID);
  const b = button("web-owner-machine", "", () => open(m));
  const lines = el("span", "web-owner-machine-lines");
  lines.append(el("strong", "", m.label), el("span", "", statusText(status)));
  b.append(lines, el("span", "web-owner-machine-access", `${m.scope === "terminal" ? "Chat and terminal" : "Chat"} · until ${until(m.expiresUnix)}`));
  b.disabled = status?.kind === "ended";
  row.append(b);
  list.append(row);
 }
 for (const s of skipped) {
  const row = el("li");
  row.append(el("strong", "", s.label), el("span", "", SKIP_TEXT[s.reason] + (s.version ? ` (herdr ${s.version})` : "")));
  list.append(row);
 }
 return [el("h1", "", "Your machines"), el("p", "", `Approved by ${names}. Open a machine to chat with its agents.`), list];
}
