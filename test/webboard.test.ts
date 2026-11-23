import { expect, test } from "bun:test";
import { buildBoard, displayName, type AgentInfo, type BoardView } from "../src/web/board";
import plain from "../internal/herdr/testdata/web_board_cases.json";
import viewed from "../internal/herdr/testdata/web_board_view_cases.json";
import golden from "../internal/herdr/testdata/web_board.golden.json";

// internal/herdr/board_web_test.go writes the golden from Go's BuildBoard and DisplayName: the
// plain cases with View{} (a guest's board), then the view cases with their folders, stars, open
// folders and search (an owner's); the browser's board must be the same JSON, fields Go omits
// omitted too.
const herds = viewed.herds as Record<string, AgentInfo[]>;
const cases: { name: string; agents: AgentInfo[]; view?: BoardView }[] = [
 ...plain.map((c) => ({ name: c.name, agents: c.agents as AgentInfo[] })),
 ...viewed.cases.map((c) => ({ name: c.name, agents: herds[c.herd]!, view: c.view as BoardView })),
];

test("the golden covers every fixture", () => {
 expect(golden.map((c) => c.name)).toEqual(cases.map((c) => c.name));
});

for (const [i, c] of cases.entries()) {
 test(`board as Go builds it: ${c.name}`, () => {
  const want = golden[i]!;
  expect(JSON.parse(JSON.stringify(buildBoard(c.agents, c.view)))).toStrictEqual(want.board);
  expect(c.agents.map(displayName)).toEqual(want.displayNames);
 });
}
