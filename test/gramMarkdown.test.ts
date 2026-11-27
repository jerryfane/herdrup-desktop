import { expect, test } from "bun:test";
import { parseGramMessage } from "../src/gramMarkdown";

test("single paragraph stays non-rich and preserves single-newline breaks", () => {
  const msg = "Deployed. vetrina.dev is live.\n• Build 412 passed\n• 2 migrations ran clean";
  const blocks = parseGramMessage(msg);
  expect(blocks.length).toBe(1);
  const block = blocks[0]!;
  expect(block.kind).toBe("markdown");
  if (block.kind !== "markdown") return;
  expect(block.rich).toBe(false);
  expect(block.hasTable).toBe(false);
  expect(block.html).toContain("<br>");
  expect(block.html).toContain("Build 412 passed");
});

test("paragraphs, headings, unordered/ordered/task lists, quotes, rules, and inline styles render as rich markdown", () => {
  const md = [
    "## Release summary",
    "",
    "Shipped **v1.2** with *zero* downtime and `herdr` update.",
    "",
    "Second paragraph with ~~old~~ [docs](https://herdrup.app) and https://guest.herdrup.app.",
    "",
    "- First item",
    "- Second item",
    "  - Nested detail",
    "- [x] Merged",
    "- [ ] Follow-up",
    "",
    "1. Step one",
    "2. Step two",
    "",
    "> Quoted note",
    "",
    "---",
  ].join("\n");
  const blocks = parseGramMessage(md);
  expect(blocks.length).toBe(1);
  const block = blocks[0]!;
  expect(block.kind).toBe("markdown");
  if (block.kind !== "markdown") return;
  expect(block.rich).toBe(true);
  expect(block.hasTable).toBe(false);
  expect(block.html).toContain("<h2>Release summary</h2>");
  expect(block.html).toContain("<strong>v1.2</strong>");
  expect(block.html).toContain("<em>zero</em>");
  expect(block.html).toContain("<code>herdr</code>");
  expect(block.html).toContain("<del>old</del>");
  expect(block.html).toContain('href="https://herdrup.app"');
  expect(block.html).toContain('href="https://guest.herdrup.app"');
  expect(block.html).toContain("<ul>");
  expect(block.html).toContain("<ol>");
  expect(block.html).toContain('class="gcheck checked"');
  expect(block.html).toContain('class="gcheck unchecked"');
  expect(block.html).not.toContain("<input");
  expect(block.html).toContain("<blockquote>");
  expect(block.html).toContain("<hr>");
});

test("GFM tables are detected and rendered with alignment; stray pipes stay plain paragraphs", () => {
  const table = [
    "Results:",
    "",
    "| Service | Latency | Delta |",
    "|---|:---:|---:|",
    "| API | 42ms | +12% |",
    "| Relay | 18ms | -4% |",
  ].join("\n");
  const blocks = parseGramMessage(table);
  expect(blocks.length).toBe(1);
  const block = blocks[0]!;
  expect(block.kind).toBe("markdown");
  if (block.kind !== "markdown") return;
  expect(block.rich).toBe(true);
  expect(block.hasTable).toBe(true);
  expect(block.html).toContain("<table>");
  expect(block.html).toContain("<th>Service</th>");
  expect(block.html).toContain('<td align="center">42ms</td>');
  expect(block.html).toContain('<td align="right">+12%</td>');

  const stray = parseGramMessage("plain prose with a | pipe");
  expect(stray).toHaveLength(1);
  expect(stray[0]).toMatchObject({ kind: "markdown", rich: false, hasTable: false });
});

test("nested tables inside blockquotes are detected", () => {
  const blocks = parseGramMessage("> | A | B |\n> |---|---|\n> | 1 | 2 |");
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ kind: "markdown", rich: true, hasTable: true });
});

test("whole-message parsing preserves indented list fences, tilde fences containing backticks, and cross-fence reference links", () => {
  // 1. Indented backtick fence inside a list item stays one single list with continuation inside the item,
  //    and retains exact parsed code text (including a trailing blank line) for Copy.
  const nestedList = [
    "- Run build:",
    "  ```sh",
    "  make test",
    "",
    "  ```",
    "  Then verify output.",
    "- Deploy",
  ].join("\n");
  const listBlocks = parseGramMessage(nestedList);
  expect(listBlocks).toHaveLength(1);
  expect(listBlocks[0]!.kind).toBe("markdown");
  if (listBlocks[0]!.kind === "markdown") {
    expect((listBlocks[0]!.html.match(/<ul>/g) ?? []).length).toBe(1);
    expect(listBlocks[0]!.html).toContain("Then verify output.");
    expect(listBlocks[0]!.html).toContain("<pre><code");
    expect(listBlocks[0]!.codes).toEqual([{ code: "make test\n", language: "sh" }]);
  }

  // 2. Tilde-fenced Markdown example containing literal backticks stays one single top-level code block.
  const tildeExample = "~~~md\nExample:\n```sh\necho hi\n```\n~~~";
  expect(parseGramMessage(tildeExample)).toEqual([
    { kind: "code", code: "Example:\n```sh\necho hi\n```", language: "md" },
  ]);

  // 3. Reference link whose definition sits after a code block resolves cleanly with no trailing empty block.
  const refMsg = "Read [Guide][docs].\n\n```sh\nmake\n```\n\n[docs]: https://herdrup.app/docs";
  const refBlocks = parseGramMessage(refMsg);
  expect(refBlocks).toHaveLength(2);
  expect(refBlocks[0]!.kind).toBe("markdown");
  if (refBlocks[0]!.kind === "markdown") {
    expect(refBlocks[0]!.html).toContain('href="https://herdrup.app/docs"');
    expect(refBlocks[0]!.html).toContain(">Guide</a>");
  }
  expect(refBlocks[1]).toEqual({ kind: "code", code: "make", language: "sh" });
});

test("bare www autolinks upgrade to https while preserving query entities and explicit http destinations", () => {
  const msg = "Bare www.example.com and query www.example.test/path?x=1&amp;y=2 vs explicit [www.example.com](http://www.example.com) and <http://www.example.com>.";
  const blocks = parseGramMessage(msg);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.kind).toBe("markdown");
  if (blocks[0]!.kind !== "markdown") return;
  expect(blocks[0]!.html).toContain('Bare <a href="https://www.example.com">www.example.com</a>');
  expect(blocks[0]!.html).toContain('query <a href="https://www.example.test/path?x=1&amp;amp;y=2">www.example.test/path?x=1&amp;amp;y=2</a>');
  expect(blocks[0]!.html).toContain('explicit <a href="http://www.example.com">www.example.com</a>');
  expect(blocks[0]!.html).toContain('and <a href="http://www.example.com">http://www.example.com</a>');
});
