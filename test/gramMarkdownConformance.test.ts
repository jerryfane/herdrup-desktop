// Shared cross-platform Gram Markdown conformance corpus & deterministic property/fuzz tests.
// Fixture file test/fixtures/gram-markdown-fixtures.json is kept byte-identical with
// themartianapp/herdrup's Tests/HerdrKitTests/Fixtures/gram-markdown-fixtures.json.
import { describe, expect, test } from "bun:test";
import corpus from "./fixtures/gram-markdown-fixtures.json";
import { parseGramMessage } from "../src/gramMarkdown";

interface FixtureExpect {
  blocks: string[];
  hasTable: boolean;
  hasCode: boolean;
  containsText: string[];
  allowedLinks: string[];
  forbiddenSubstrings: string[];
}
interface FixtureCase {
  id: string;
  input: string;
  expect: FixtureExpect;
}

const SAFE_HREF_RE = /^(?:https?:\/\/|mailto:)/i;
const HREF_ATTR_RE = /\bhref="([^"]*)"/gi;
const EVENT_HANDLER_TAG_RE = /<[^>]*\bon(?:error|load|click|mouseover|focus)\s*=/i;

function combinedOutput(input: string) {
  const blocks = parseGramMessage(input);
  const html = blocks.map(b => b.kind === "markdown" ? b.html : "").join("\n");
  const codeText = blocks.map(b => b.kind === "code" ? b.code : b.codes.map(c => c.code).join("\n")).join("\n");
  const hasTable = blocks.some(b => b.kind === "markdown" && b.hasTable);
  const hasCode = blocks.some(b => b.kind === "code" || b.codes.length > 0);
  return { blocks, html, codeText, allText: html + "\n" + codeText, hasTable, hasCode };
}

function assertSafeHTML(html: string, context: string) {
  const lower = html.toLowerCase();
  for (const bad of ["<script", "<iframe", "<object", "<embed", "<img "]) {
    expect(lower, `${context}: unexpected ${bad}`).not.toContain(bad);
  }
  expect(EVENT_HANDLER_TAG_RE.test(html), `${context}: live HTML event handler attribute`).toBe(false);
  HREF_ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HREF_ATTR_RE.exec(html)) !== null) {
    const href = match[1] ?? "";
    expect(SAFE_HREF_RE.test(href), `${context}: unsafe href "${href}"`).toBe(true);
  }
}

describe("shared Gram Markdown conformance corpus", () => {
  for (const c of corpus.cases as FixtureCase[]) {
    test(`fixture: ${c.id}`, () => {
      const out = combinedOutput(c.input);
      expect(out.blocks.length).toBeGreaterThan(0);
      expect(out.hasTable).toBe(c.expect.hasTable);
      expect(out.hasCode).toBe(c.expect.hasCode);

      for (const expectedBlock of c.expect.blocks) {
        if (expectedBlock === "table") expect(out.html).toContain("<table>");
        else if (expectedBlock.startsWith("heading:")) {
          const level = expectedBlock.split(":")[1];
          expect(out.html).toContain(`<h${level}>`);
        } else if (expectedBlock === "list:unordered") expect(out.html).toContain("<ul>");
        else if (expectedBlock.startsWith("list:ordered")) {
          const start = expectedBlock.split(":")[2];
          expect(out.html).toContain("<ol");
          if (start && start !== "1") expect(out.html).toContain(`start="${start}"`);
        } else if (expectedBlock === "quote") expect(out.html).toContain("<blockquote>");
        else if (expectedBlock === "rule") expect(out.html).toContain("<hr>");
        else if (expectedBlock.startsWith("code")) {
          expect(out.hasCode).toBe(true);
          const lang = expectedBlock.split(":")[1];
          if (lang) {
            const topCode = out.blocks.find(b => b.kind === "code");
            expect(topCode?.kind === "code" ? topCode.language : "").toBe(lang);
          }
        }
      }

      for (const text of c.expect.containsText) {
        expect(out.allText).toContain(text);
      }
      for (const href of c.expect.allowedLinks) {
        expect(out.html).toContain(`href="${href}"`);
      }
      for (const forbidden of c.expect.forbiddenSubstrings) {
        expect(out.html.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
      assertSafeHTML(out.html, c.id);
    });
  }
});

// Deterministic PRNG (mulberry32) for pre-PR property/fuzz invariants.
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  "# Heading",
  "## Subheading",
  "Plain text **bold** *italic* ~~del~~ `code`",
  "- bullet item",
  "  - nested bullet",
  "- [x] done",
  "- [ ] todo",
  "1. first\n2. second",
  "| A | B |\n|---|---|\n| 1 | 2 |",
  "> quoted line",
  ">>> deep quote",
  "---",
  "```sh\necho <script>1</script>\n```",
  "~~~md\n```ts\nconst x = 1;\n```\n~~~",
  "[safe](https://herdrup.app)",
  "[mail](mailto:ops@herdrup.app)",
  "[bad-js](javascript:alert(1))",
  "[bad-data](data:text/html,<script>1</script>)",
  "ftp://[2001:db8::1]/report@example.test",
  "https://guest.herdrup.app/web/?a=1&b=2",
  "<script>alert(1)</script><img src=x onerror=alert(1)>",
  "foo | bar & baz < qux > end",
  "`unclosed backtick **bold**",
  "",
];

test("property/fuzz: 400 seeded randomized markdown documents never crash or emit unsafe HTML/links", () => {
  const rand = mulberry32(0x5eed2026);
  for (let i = 0; i < 400; i++) {
    const lineCount = 1 + Math.floor(rand() * 14);
    const lines: string[] = [];
    for (let j = 0; j < lineCount; j++) {
      lines.push(FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]!);
    }
    const doc = lines.join("\n");
    const out = combinedOutput(doc);
    assertSafeHTML(out.html, `fuzz#${i}`);
  }
});

test("property/fuzz: 1,500-line adversarial input parses in bounded linear time (< 2s)", () => {
  const lines: string[] = [];
  for (let i = 0; i < 500; i++) {
    lines.push(`- item ${i} with **bold** \`code\` ftp://host/${i} <script>${i}</script>`);
    lines.push(`  ~~~md`);
    lines.push(`  > quote ${i} | col`);
  }
  const doc = lines.join("\n");
  const start = performance.now();
  const out = combinedOutput(doc);
  const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(2000);
  assertSafeHTML(out.html, "adversarial-1500");
});
