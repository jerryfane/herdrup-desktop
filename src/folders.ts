// Agent folders and stars in the Agents list (herdrup#552): the order the
// list draws its rows in, the folder row, the star after an agent's name,
// the right-click menus and the folder-name prompt. The layout itself is
// Go's (internal/herdr/folders.go, herdrup AgentFolderLayout).
import { Desk, events, type Board, type Folder, type FolderNaming, type Row } from "./mygo";

/** One line of the roster as drawn. */
export type Entry =
  | { kind: "agent"; row: Row }
  | { kind: "folder"; folder: Folder }
  | { kind: "disclosure"; key: "idle" | "archived"; title: string; count: number }
  | { kind: "archived"; row: Row };

/** The roster in herdrup's order (App/HerdrApp.swift agentRosterRows and
 * sectionView): each section's items, Idle behind its "Idle N" disclosure
 * (N counts the agents in its folders too), the empty folders after the
 * sections, then the "Archived" disclosure. `board` is the search board
 * while searching: every item shows, with no disclosure, no empty folders
 * and no archived agents. */
export function rosterEntries(board: Board, open: { idle: boolean; archived: boolean }, searching: boolean): Entry[] {
  const out: Entry[] = [];
  const items = (s: Board["sections"][number]) => {
    for (const it of s.items) {
      if (it.kind === "folder" && it.folder) out.push({ kind: "folder", folder: it.folder });
      else if (it.row) out.push({ kind: "agent", row: it.row });
    }
  };
  for (const s of board.sections) {
    if (s.key === "idle" && !searching) {
      out.push({ kind: "disclosure", key: "idle", title: "Idle", count: s.agentCount });
      if (open.idle) items(s);
    } else {
      items(s);
    }
  }
  if (searching) return out;
  for (const f of board.emptyFolders) out.push({ kind: "folder", folder: f });
  if (board.archived.length > 0) {
    out.push({ kind: "disclosure", key: "archived", title: "Archived", count: board.archived.length });
    if (open.archived) for (const r of board.archived) out.push({ kind: "archived", row: r });
  }
  return out;
}

/** What folders.ts borrows from main.ts to draw. */
export interface FolderDeps {
  el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K];
  symbol(name: string, size: number, weight: string): Promise<HTMLElement>;
  /** A member's picture inside the folder's (no badge). */
  picture(r: Row): HTMLElement;
}

/** The star after a starred agent's name: star.fill 12 semibold in
 * waiting (herdrup card()). */
export async function star(d: FolderDeps): Promise<HTMLElement> {
  const s = d.el("span", "star");
  s.title = "starred";
  s.append(await d.symbol("star.fill", 12, "semibold"));
  return s;
}

/** Right-click on an agent row: Star/Unstar and Move to folder. */
export function agentMenu(row: HTMLElement, r: Row) {
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void Desk.agentMenu(r.id);
  });
}

/** A folder row (herdrup AgentFolderRow): its picture, the name, "N
 * agents", the waiting and stopped counts and a chevron that turns when
 * open, over the line that says who needs you. A click opens or closes it
 * on this device; right-click renames, moves or deletes it. */
export async function folderRow(f: Folder, d: FolderDeps): Promise<HTMLElement> {
  const row = d.el("div", "row folder" + (f.waiting > 0 ? " waiting" : ""));
  row.dataset.folder = f.id;
  const pic = d.el("div", "folder-pic");
  for (let i = 0; i < f.picture.length; i += 2) {
    const line = d.el("div", "line");
    for (const m of f.picture.slice(i, i + 2)) line.append(d.picture(m));
    pic.append(line);
  }
  const text = d.el("div", "text");
  const line1 = d.el("div", "line1");
  const chev = d.el("span", "chev" + (f.open ? " open" : ""));
  chev.append(await d.symbol("chevron.right", 12, "semibold"));
  line1.append(d.el("span", "name t-row-name", f.name), d.el("span", "count t-row-age", f.count), d.el("span", "spacer"));
  if (f.waiting > 0) line1.append(d.el("span", "count-pill waiting t-count-pill", String(f.waiting)));
  if (f.stopped > 0) line1.append(d.el("span", "count-pill stopped t-count-pill", String(f.stopped)));
  line1.append(chev);
  text.append(line1, d.el("div", "preview t-row-preview", f.summary));
  row.append(pic, text);
  row.addEventListener("click", () => {
    void Desk.setFolderOpen(f.id, !f.open);
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void Desk.folderMenu(f.id);
  });
  return row;
}

/** herdrup's "New folder" / "Rename folder" alert: a "Folder name" field
 * with Cancel and Create (or Rename). Resolves to the text, or null when
 * cancelled. */
export function askFolderName(n: FolderNaming, d: Pick<FolderDeps, "el">): Promise<string | null> {
  const rename = n.kind === "rename";
  const dialog = d.el("dialog", "folder-naming");
  const form = d.el("form");
  form.method = "dialog";
  const input = d.el("input");
  input.placeholder = "Folder name";
  input.value = n.name;
  const buttons = d.el("div", "buttons");
  const cancel = d.el("button", "ghost", "Cancel");
  cancel.type = "button";
  const ok = d.el("button", "", rename ? "Rename" : "Create");
  ok.type = "submit";
  buttons.append(cancel, ok);
  form.append(d.el("h2", "", rename ? "Rename folder" : "New folder"), input, buttons);
  dialog.append(form);
  document.body.append(dialog);
  // Not Promise.withResolvers: the project targets ES2022 (tsconfig lib),
  // and older system webviews lack it.
  let resolve: (v: string | null) => void = () => {};
  const promise = new Promise<string | null>((r) => (resolve = r));
  let answer: string | null = null;
  cancel.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", () => {
    answer = input.value;
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    resolve(answer);
  });
  dialog.showModal();
  input.select();
  return promise;
}

/** Answers Go's requests for a folder name. */
export function initFolders(d: Pick<FolderDeps, "el">) {
  events.folderNamingRequested.on(async (n) => {
    const text = await askFolderName(n, d);
    if (text !== null) await Desk.nameFolder(n, text);
  });
}
