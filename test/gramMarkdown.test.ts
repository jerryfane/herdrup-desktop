import { expect, test } from "bun:test";
import { analyzeGramMarkdown, hasMarkdownTable, parseGramMarkdown } from "../src/gramMarkdown";

test("single paragraph stays non-rich and preserves single-newline breaks", () => {
  const msg = "Deployed. vetrina.dev is live.\n• Build 412 passed\n• 2 migrations ran clean";
  expect(analyzeGramMarkdown(msg)).toEqual({ rich: false, hasTable: false });
  const out = parseGramMarkdown(msg);
  expect(out.rich).toBe(false);
  expect(out.hasTable).toBe(false);
  expect(out.html).toContain("<br>");
  expect(out.html).toContain("Build 412 passed");
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
  const out = parseGramMarkdown(md);
  expect(out.rich).toBe(true);
  expect(out.hasTable).toBe(false);
  expect(out.html).toContain("<h2>Release summary</h2>");
  expect(out.html).toContain("<strong>v1.2</strong>");
  expect(out.html).toContain("<em>zero</em>");
  expect(out.html).toContain("<code>herdr</code>");
  expect(out.html).toContain("<del>old</del>");
  expect(out.html).toContain('href="https://herdrup.app"');
  expect(out.html).toContain('href="https://guest.herdrup.app"');
  expect(out.html).toContain("<ul>");
  expect(out.html).toContain("<ol>");
  expect(out.html).toContain('class="gcheck checked"');
  expect(out.html).toContain('class="gcheck unchecked"');
  expect(out.html).not.toContain("<input");
  expect(out.html).toContain("<blockquote>");
  expect(out.html).toContain("<hr>");
});

test("GFM tables are detected and rendered with alignment; stray pipes stay plain paragraphs", () => {
  const table = [
    "Results:",
    "",
    "| Service | Latency | Delta |",
    "|---|---:|---:|",
    "| API | 42ms | +12% |",
    "| Relay | 18ms | -4% |",
  ].join("\n");
  expect(hasMarkdownTable(table)).toBe(true);
  const out = parseGramMarkdown(table);
  expect(out.rich).toBe(true);
  expect(out.hasTable).toBe(true);
  expect(out.html).toContain("<table>");
  expect(out.html).toContain("<th>Service</th>");
  expect(out.html).toContain('<td align="right">+12%</td>');

  expect(hasMarkdownTable("plain prose with a | pipe")).toBe(false);
  expect(hasMarkdownTable("no pipes at all")).toBe(false);
  expect(analyzeGramMarkdown("plain prose with a | pipe")).toEqual({ rich: false, hasTable: false });
});

test("nested tables inside blockquotes or lists are detected by hasMarkdownTable", () => {
  const quoted = "> | A | B |\n> |---|---|\n> | 1 | 2 |";
  expect(hasMarkdownTable(quoted)).toBe(true);
});
