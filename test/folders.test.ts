import { expect, test } from "bun:test";
import { rosterEmptyLine, rosterEntries, type Entry } from "../src/folders";
import type { Board, Folder, Row } from "../src/mygo";

const row = (id: string): Row =>
  ({ id, title: id, agent: "", status: "", badge: "none", preview: "", initial: "A", tint: 0, match: [id], name: id, starred: false }) as Row;
const folder = (id: string): Folder => ({ id, name: id, open: false, waiting: 0, stopped: 0, count: "1 agent", summary: "idle", picture: [] });

const board: Board = {
  sections: [
    { key: "needsYou", label: "", collapsed: false, rows: [row("a")], agentCount: 1, items: [{ kind: "agent", row: row("a") }] },
    {
      key: "idle",
      label: "",
      collapsed: true,
      rows: [row("b")],
      // One loose agent and a folder of three: the disclosure counts four.
      agentCount: 4,
      items: [
        { kind: "folder", folder: folder("f") },
        { kind: "agent", row: row("b") },
      ],
    },
  ],
  archived: [row("z")],
  needsYou: 1,
  total: 5,
  emptyFolders: [folder("e")],
};

const names = (es: Entry[]) =>
  es.map((e) => (e.kind === "folder" ? `[${e.folder.id}]` : e.kind === "disclosure" ? `${e.title} ${e.count}` : e.kind === "archived" ? `~${e.row.id}` : e.row.id));

test("idle sits behind its disclosure, which counts the agents in its folders", () => {
  expect(names(rosterEntries(board, { idle: false, archived: false }, false))).toEqual(["a", "Idle 4", "[e]", "Archived 1"]);
});

test("open disclosures show their items, empty folders after the sections", () => {
  expect(names(rosterEntries(board, { idle: true, archived: true }, false))).toEqual(["a", "Idle 4", "[f]", "b", "[e]", "Archived 1", "~z"]);
});

test("a search shows every item with no disclosure, empty folder or archived agent", () => {
  expect(names(rosterEntries(board, { idle: false, archived: true }, true))).toEqual(["a", "[f]", "b"]);
});

// #34: every agent gone but a saved folder left: the folder is drawn, so it
// can still be opened, renamed or deleted, instead of "no agents".
test("an empty roster with a saved empty folder draws the folder", () => {
  const empty: Board = { sections: [], archived: [], needsYou: 0, total: 0, emptyFolders: [folder("e")] };
  expect(rosterEmptyLine(empty, empty, false)).toBeNull();
  expect(names(rosterEntries(empty, { idle: false, archived: false }, false))).toEqual(["[e]"]);
  const none: Board = { ...empty, emptyFolders: [] };
  expect(rosterEmptyLine(none, none, false)).toBe("no agents");
  // A search hides empty folders, so it finds nothing.
  expect(rosterEmptyLine(empty, none, true)).toBe("no matches");
});
