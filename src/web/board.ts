// The guest's status board, built in the browser: internal/herdr BuildBoard(agents, View{}) and
// DisplayName, as desk_guest.go runGuest (:272-275) publishes them for the shared agent. With an
// empty View there is no query, no folder and no star, so folders.go layout only turns each
// section's rows into agent items. Pinned to Go by internal/herdr/testdata/web_board.golden.json.

import type { Avatar, Board, Item, Row, Section } from "../mygo";

/** The agent.list agent fields the board reads (herdrapi.AgentInfo, herdr's JSON names). A
 *  pointer field is absent or null when Go's is nil. */
export interface AgentInfo {
 pane_id?: string;
 terminal_id?: string;
 name?: string | null;
 terminal_title_stripped?: string | null;
 agent?: string | null;
 agent_status?: string;
 input_pending?: boolean | null;
 last_known_status?: string | null;
 /** An object when archived; any other value means not archived (herdrapi compat.go:5-25). */
 archived?: unknown;
 last_completed_turn?: { completed_unix_ms?: number } | null;
 cwd?: string | null;
 reachability?: string | null;
 avatar?: { style?: string; mascot?: string | null; sha256?: string | null } | null;
 account_unresolved?: boolean | null;
 account?: string | null;
 status_since_unix_ms?: number | null;
 machine_id?: string | null;
 machine_label?: string | null;
}

interface ArchivedInfo { at?: string; by?: string; reason?: string | null }

// board.go:20-38: the order is the board's point.
const enum Group { NeedsYou, Stopped, Unrecognised, Working, Idle }
const groupLabels = ["needs you", "stopped", "unrecognised", "working", "idle"];
const groupKeys = ["needsYou", "stopped", "unrecognised", "working", "idle"];
// board.go:249
const badgeOf = ["waiting", "stopped", "unrecognised", "working", "none"];
// avatar.go:11
const mascots = ["herdy", "bot", "blip", "tri", "squib", "zag", "cub", "dome", "pip", "prism", "nib", "drop"];

const str = (s: string | null | undefined) => s ?? "";

// compat.go:20: only an object is archived provenance.
function archivedOf(a: AgentInfo): ArchivedInfo | null {
 const v = a.archived;
 return typeof v === "object" && v !== null && !Array.isArray(v) ? v as ArchivedInfo : null;
}

// board.go:51-71, always live on the board.
function groupOf(a: AgentInfo): Group {
 const status = a.agent_status ?? "";
 if (a.input_pending === true || status === "blocked") return Group.NeedsYou;
 switch (status) {
  case "working": return Group.Working;
  case "idle": case "done": return Group.Idle;
  case "unknown": if (a.last_known_status === "blocked") return Group.NeedsYou;
 }
 return Group.Unrecognised;
}

// Go's string order is UTF-8 byte order, i.e. code point order; JS < compares UTF-16 units.
function goCompare(a: string, b: string): number {
 const n = Math.min(a.length, b.length);
 for (let i = 0; i < n; i++) {
  const x = a.charCodeAt(i), y = b.charCodeAt(i);
  if (x !== y) return fold(x) - fold(y);
 }
 return a.length - b.length;
}
const fold = (u: number) => u >= 0xe000 ? u - 0x800 : u >= 0xd800 ? u + 0x2000 : u;

/** BuildBoard(agents, View{}) (board.go:183-247 with folders.go:281-414 for no document). */
export function buildBoard(agents: AgentInfo[]): Board {
 const live: Array<{ info: AgentInfo; group: Group }> = [];
 const archived: Array<{ info: AgentInfo; arc: ArchivedInfo }> = [];
 for (const info of agents) {
  const arc = archivedOf(info);
  if (arc) archived.push({ info, arc });
  else live.push({ info, group: groupOf(info) });
 }
 // board.go:197-204: newest archived first.
 archived.sort((x, y) => goCompare(str(y.arc.at), str(x.arc.at)));
 const board: Board = { sections: [], archived: [], needsYou: 0, total: live.length, emptyFolders: [] };
 for (const { info, arc } of archived) {
  const row = rowOf(info, Group.Idle);
  row.archivedNote = archivedNote(arc);
  board.archived.push(row);
 }
 // board.go:205-221: by group, most recently finished turn, then pane id.
 // No completed turn sorts last (Go's math.MinInt64).
 const completed = (a: AgentInfo) => a.last_completed_turn == null ? -Infinity : a.last_completed_turn.completed_unix_ms ?? 0;
 live.sort((x, y) => {
  if (x.group !== y.group) return x.group - y.group;
  const tx = completed(x.info), ty = completed(y.info);
  if (tx !== ty) return tx > ty ? -1 : 1;
  return goCompare(str(x.info.pane_id), str(y.info.pane_id));
 });
 // board.go:222-239; folders.go:362-411 with no folder or star: every row an unstarred agent item.
 let section: Section | undefined;
 for (const { info, group } of live) {
  if (group === Group.NeedsYou) board.needsYou++;
  const row = rowOf(info, group);
  if (section === undefined || section.key !== groupKeys[group]) {
   section = { key: groupKeys[group]!, label: groupLabels[group]!, collapsed: group === Group.Idle, rows: [], items: [], agentCount: 0 };
   board.sections.push(section);
  }
  section.rows.push(row);
  section.items.push({ kind: "agent", row: { ...row } } satisfies Item);
  section.agentCount++;
 }
 return board;
}

// board.go:251-281
function rowOf(a: AgentInfo, g: Group): Row {
 const title = displayName(a);
 const row: Row = {
  id: str(a.pane_id), title, agent: str(a.agent), status: a.agent_status ?? "", badge: badgeOf[g]!,
  preview: preview(a), initial: initial(title), tint: tintIndex(title), match: [title], name: str(a.name),
  starred: false, avatar: avatarOf(a),
 };
 for (const s of [str(a.name), str(a.terminal_title_stripped)]) if (s !== "" && s !== title) row.match.push(s);
 if (a.reachability === "unreachable") row.badge = "offline";
 // Go's omitempty: false, "" and a nil pointer are left out.
 if (archivedOf(a) === null && a.reachability === "degraded") row.stale = true;
 if (a.account_unresolved === true) row.noAccount = true;
 if (str(a.account) !== "") row.account = str(a.account);
 if (a.status_since_unix_ms != null) row.statusSinceUnixMs = a.status_since_unix_ms;
 const act = activity(str(a.terminal_title_stripped));
 if (act !== "") row.activity = act;
 return row;
}

// board.go:284-301
function preview(a: AgentInfo): string {
 let folder = "";
 if (a.cwd != null) {
  const f = pathBase(a.cwd);
  if (f !== "/" && f !== ".") folder = f;
 }
 const act = activity(str(a.terminal_title_stripped));
 if (folder !== "" && act !== "") return folder + " · " + act;
 return folder || act || str(a.pane_id);
}

// Go path.Base.
function pathBase(p: string): string {
 if (p === "") return ".";
 p = p.replace(/\/+$/, "");
 return p === "" ? "/" : p.slice(p.lastIndexOf("/") + 1);
}

// Go unicode.IsSpace (JS \s differs: it takes U+FEFF and not U+0085).
const space = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const leadingSpace = new RegExp(`^[${space}]+`);
const trailingSpace = new RegExp(`[${space}]+$`);

// board.go:304-312
function initial(name: string): string {
 name = name.replace(leadingSpace, "").replace(trailingSpace, "");
 if (name === "") return "?";
 return upperRune(String.fromCodePoint(name.codePointAt(0)!));
}

// Go unicode.ToUpper: the simple mapping, one rune. JS toUpperCase applies the special
// (multi-rune) mappings; of those runes only Greek with ypogegrammeni have a simple one.
function upperRune(r: string): string {
 const up = r.toUpperCase();
 if ([...up].length === 1) return up;
 const c = r.codePointAt(0)!;
 if (c >= 0x1f80 && c <= 0x1faf) return String.fromCodePoint(c | 0x08);
 if (c === 0x1fb3 || c === 0x1fc3 || c === 0x1ff3) return String.fromCodePoint(c + 9);
 return r;
}

// board.go:316-322: FNV-1a 64 over the UTF-8 bytes, high bits folded down.
const utf8 = new TextEncoder();
function tintIndex(name: string): number {
 let h = 0xcbf29ce484222325n;
 for (const b of utf8.encode(name)) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
 return Number((h ^ (h >> 32n)) % 4n);
}

// board.go:326-336
function archivedNote(arc: ArchivedInfo): string {
 const by = str(arc.by) !== "" ? "archived by " + arc.by : "archived";
 const reason = str(arc.reason);
 return reason !== "" ? by + " · " + reason : by;
}

/** DisplayName (board.go:340-353): name, else terminal title, else pane id, with a federated
 *  agent's machine alias replaced by the machine's label. */
export function displayName(a: AgentInfo): string {
 const raw = str(a.name) || str(a.terminal_title_stripped) || str(a.pane_id);
 const id = str(a.machine_id), label = str(a.machine_label);
 if (id === "" || label === "" || !raw.startsWith(id + "/")) return raw;
 return label + "/" + raw.slice(id.length + 1);
}

// board.go:357-369: the prompt and spinner glyphs at the start of a terminal title go.
function activity(title: string): string {
 let rest = title;
 let sawPrompt = false;
 for (;;) {
  rest = rest.replace(leadingSpace, "");
  const cut = rest.indexOf(" ");
  const token = cut < 0 ? rest : rest.slice(0, cut);
  const isPrompt = token === "π";
  if (token === "" || !(isPrompt || isSpinner(token) || (sawPrompt && token === ">"))) return rest;
  sawPrompt ||= isPrompt;
  rest = rest.slice(token.length);
 }
}

// board.go:372-379
function isSpinner(token: string): boolean {
 for (const ch of token) {
  const c = ch.codePointAt(0)!;
  if (!(c >= 0x2800 && c <= 0x28ff) && !"✳✶✻✽✢✱".includes(ch)) return false;
 }
 return true;
}

// avatar.go:29-45
function avatarOf(a: AgentInfo): Avatar {
 const av = a.avatar;
 if (av == null) return { kind: "initial" };
 if (av.style === "mascot") {
  const m = str(av.mascot);
  if (mascots.includes(m)) return { kind: "mascot", mascot: m };
 } else if (av.style === "image") {
  // herdrup lower-cases the sha on decode, then requires 64 hex (avatar.go:57-67).
  const sha = str(av.sha256).toLowerCase();
  if (/^[0-9a-f]{64}$/.test(sha)) {
   const target = avatarTarget(a);
   return target === "" ? { kind: "image", sha256: sha } : { kind: "image", sha256: sha, target };
  }
 }
 return { kind: "initial" };
}

// avatar.go:72-86
function avatarTarget(a: AgentInfo): string {
 const pane = str(a.pane_id), terminal = str(a.terminal_id);
 if (a.machine_id == null && terminal !== "") return terminal;
 return pane || terminal || str(a.name);
}
