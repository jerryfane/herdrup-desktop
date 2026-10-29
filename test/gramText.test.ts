// `segments` tests translated case by case from herdrup 9876878
// Tests/HerdrKitTests/GramTextTests.swift; each `test` names its XCTest. The summary, preview
// and fold tests after them cover HerdrApp.swift `summary`/`preview(of:)` and GramCards.swift
// `GramFoldingText`, which herdrup has no unit tests for.
import { expect, test } from "bun:test";
import {
  agentName,
  expiredFilePreview,
  foldToggleLabel,
  GRAM_FOLDED_LINE_LIMIT,
  gramTextFolds,
  rowPreview,
  savedPreview,
  segments,
  summary,
  type GramTextSegment,
} from "../src/gramText";

const text = (t: string): GramTextSegment => ({ kind: "text", text: t });
const code = (c: string, language: string | null): GramTextSegment => ({ kind: "code", code: c, language });

test("testPlainTextIsOneTextSegment", () => {
  expect(segments("Digest ready: 7 trends.\nTwo need your call.")).toEqual([
    text("Digest ready: 7 trends.\nTwo need your call."),
  ]);
});

test("testEmptyTextHasNoSegments", () => {
  expect(segments("")).toEqual([]);
});

test("testTextBeforeAndAfterACodeBlockLoseOnlyTheNewlineNextToTheFence", () => {
  expect(segments("Scaffold is up. Run it with:\n```\ncd ~/src/amigo-poc && pnpm dev\n```\nThen open it.")).toEqual([
    text("Scaffold is up. Run it with:"),
    code("cd ~/src/amigo-poc && pnpm dev", null),
    text("Then open it."),
  ]);
  // Only ONE newline is the fence's: a blank line before or after stays in the prose.
  expect(segments("Before\n\n```\nx\n```\n\nAfter")).toEqual([text("Before\n"), code("x", null), text("\nAfter")]);
});

test("testTheLanguageIsTheFirstWordAfterTheFence", () => {
  expect(segments("```swift\nlet a = 1\n```")).toEqual([code("let a = 1", "swift")]);
  expect(segments("```  bash title=run.sh\nls -la\n```")).toEqual([code("ls -la", "bash")]);
  expect(segments("```   \nplain\n```")).toEqual([code("plain", null)]);
});

test("testMultiLineCodeKeepsItsLinesAndIndentation", () => {
  expect(segments("```py\ndef f():\n    return 1\n\nprint(f())\n```")).toEqual([
    code("def f():\n    return 1\n\nprint(f())", "py"),
  ]);
});

test("testAnEmptyCodeBlockIsStillCode", () => {
  expect(segments("```\n```")).toEqual([code("", null)]);
});

test("testAdjacentFencesAreTwoBlocksWithNoEmptyTextBetween", () => {
  expect(segments("```sh\nmake\n```\n```json\n{}\n```")).toEqual([code("make", "sh"), code("{}", "json")]);
  // A blank line between them is whitespace-only prose: dropped, not an empty bubble.
  expect(segments("```\na\n```\n\n```\nb\n```")).toEqual([code("a", null), code("b", null)]);
});

test("testAnUnclosedFenceIsTextToTheEnd", () => {
  expect(segments("Try this:\n```bash\nrm -rf build\nand then rebuild")).toEqual([
    text("Try this:\n```bash\nrm -rf build\nand then rebuild"),
  ]);
});

test("testAnUnclosedFenceAfterAClosedBlockOnlySwallowsTheRest", () => {
  expect(segments("```\none\n```\nnote\n```\ntwo")).toEqual([code("one", null), text("note\n```\ntwo")]);
});

test("testALaterUnclosedFenceDoesNotRecoverIntoCode", () => {
  // The four-tick fence never closes (``` is shorter), so everything after it is prose,
  // even though a later ```py … ``` pair would close on its own.
  const t = "````\na\n```py\nb\n```";
  expect(segments(t)).toEqual([text(t)]);
});

test("testTheClosingFenceNeedsAtLeastTheOpeningTicks", () => {
  expect(segments("````md\n```\ninner\n```\n````")).toEqual([code("```\ninner\n```", "md")]);
});

test("testALongerClosingFenceClosesTheBlock", () => {
  // At least the opening ticks, not exactly: four ticks close a three-tick fence.
  expect(segments("```\na\n````")).toEqual([code("a", null)]);
  expect(segments("```sh\nmake\n`````\nDone")).toEqual([code("make", "sh"), text("Done")]);
});

test("testAnInfoStringWithABacktickIsNotAnOpeningFence", () => {
  // "```inline```" is prose, so the later bare ``` OPENS a fence (which never closes).
  expect(segments("```inline```\nrest\n```")).toEqual([text("```inline```\nrest\n```")]);
  expect(segments("```js `x`\ny\n```\n")).toEqual([text("```js `x`\ny\n```\n")]);
});

test("testWhitespaceOnlyProseIsDropped", () => {
  // Spaces and tabs between, before and after the blocks draw no empty bubble.
  expect(segments("  \n```\na\n```\n \t \n```\nb\n```\n   ")).toEqual([code("a", null), code("b", null)]);
  expect(segments(" \t")).toEqual([]);
});

test("testAFenceLineWithInfoDoesNotCloseABlock", () => {
  expect(segments("```\na\n```js\nb\n```")).toEqual([code("a\n```js\nb", null)]);
});

test("testInlineTriplesAreNotFences", () => {
  const t = "Use ```code``` inline, or say ``` mid-line.";
  expect(segments(t)).toEqual([text(t)]);
  expect(segments("```inline```\nrest")).toEqual([text("```inline```\nrest")]);
});

test("testIndentedFencesAndTrailingSpacesStillCount", () => {
  expect(segments("Steps:\n  ```zsh\n  brew install herdr\n  ```  \nDone")).toEqual([
    text("Steps:"),
    code("  brew install herdr", "zsh"),
    text("Done"),
  ]);
});

test("testCRLFLineEndingsReadAsLF", () => {
  expect(segments("Run:\r\n```bash\r\nmake test\r\nmake lint\r\n```\r\nDone\r\n")).toEqual([
    text("Run:"),
    code("make test\nmake lint", "bash"),
    text("Done\n"),
  ]);
});

test("desktop: a lone CR is not a line break", () => {
  // Swift splits on "\n" only, so "\r" alone stays in the text.
  expect(segments("a\rb")).toEqual([text("a\rb")]);
});

test("testTwoTicksAreNotAFence", () => {
  expect(segments("``\nx\n``")).toEqual([text("``\nx\n``")]);
});

// MARK: sidebar one-line form (desktop tests)

test("summary drops fences, keeps code, collapses whitespace", () => {
  expect(summary("Run:\n```sh\nmake   test\n```\n\n  Done\tnow")).toBe("Run: make test Done now");
});

test("summary of an empty caption reads as the file", () => {
  expect(summary("", "report.pdf")).toBe("report.pdf");
  expect(summary(" \n ", expiredFilePreview("report.pdf"))).toBe("report.pdf (expired)");
  expect(summary("")).toBe("");
  expect(summary("caption", "report.pdf")).toBe("caption");
});

test("agentName is the part after the last slash unless empty", () => {
  expect(agentName("hetzner-1/clientloop")).toBe("clientloop");
  expect(agentName("a/b/c")).toBe("c");
  expect(agentName("vetrina")).toBe("vetrina");
  expect(agentName("odd/")).toBe("odd/");
});

test("rowPreview: agent, direct post with bold addressee, queue post", () => {
  expect(rowPreview({ fromAgent: true, senderName: "clientloop", to: null, text: "Scaffold\nis up", fileName: null }))
    .toEqual([{ text: "clientloop: Scaffold is up", strong: false }]);
  expect(rowPreview({ fromAgent: false, senderName: "owner", to: "hetzner-1/vetrina", text: "ship it", fileName: null }))
    .toEqual([
      { text: "You: ", strong: false },
      { text: "vetrina", strong: true },
      { text: " ", strong: false },
      { text: "ship it", strong: false },
    ]);
  expect(rowPreview({ fromAgent: false, senderName: "owner", to: null, text: "", fileName: "a.png" })).toEqual([
    { text: "You: ", strong: false },
    { text: "a.png", strong: false },
  ]);
});

test("savedPreview: bare sender or You", () => {
  expect(savedPreview({ fromAgent: true, from: "hetzner-1/clientloop", text: "hi\n there", fileName: null })).toBe(
    "clientloop: hi there",
  );
  expect(savedPreview({ fromAgent: false, from: "owner", text: "", fileName: "x.zip" })).toBe("You: x.zip");
});

// MARK: folding (desktop tests)

test("folds past eight lines by more than half a point", () => {
  expect(GRAM_FOLDED_LINE_LIMIT).toBe(8);
  expect(gramTextFolds(160, 160)).toBe(false);
  expect(gramTextFolds(160.5, 160)).toBe(false);
  expect(gramTextFolds(160.6, 160)).toBe(true);
  expect(foldToggleLabel(false)).toBe("Read more");
  expect(foldToggleLabel(true)).toBe("Show less");
});
