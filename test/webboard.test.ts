import { expect, test } from "bun:test";
import { buildBoard, displayName, type AgentInfo } from "../src/web/board";
import cases from "../internal/herdr/testdata/web_board_cases.json";
import golden from "../internal/herdr/testdata/web_board.golden.json";

// internal/herdr/board_web_test.go writes the golden from Go's BuildBoard(agents, View{}) and
// DisplayName; the browser's board must be the same JSON, fields Go omits omitted too.
test("the golden covers every fixture", () => {
 expect(golden.map((c) => c.name)).toEqual(cases.map((c) => c.name));
});

for (const [i, c] of cases.entries()) {
 test(`board as Go builds it: ${c.name}`, () => {
  const agents = c.agents as AgentInfo[];
  const want = golden[i]!;
  expect(JSON.parse(JSON.stringify(buildBoard(agents)))).toStrictEqual(want.board);
  expect(agents.map(displayName)).toEqual(want.displayNames);
 });
}
