// Shared cross-platform Gram Markdown conformance corpus & deterministic property/fuzz tests.
// Fixture file test/fixtures/gram-markdown-fixtures.json is kept byte-identical with
// themartianapp/herdrup's Tests/HerdrKitTests/Fixtures/gram-markdown-fixtures.json.
import { describe, expect, test } from "bun:test";
import corpus from "./fixtures/gram-markdown-fixtures.json";
import { parseGramMessage, type GramBlock } from "../src/gramMarkdown";

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

interface ParsedTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: Map<string, string>;
}

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const FORBIDDEN_ELEMENTS = new Set(["script", "iframe", "object", "embed", "img"]);
const SAFE_HREF_RE = /^(?:https?:\/\/|mailto:)/i;

// Minimal quote-aware HTML tag tokenizer so quoted attribute values (e.g. title="mentions onload=literal")
// are never mistaken for live event-handler attributes, and top-level block order can be projected exactly.
function tokenizeHTMLTags(html: string): ParsedTag[] {
  const tags: ParsedTag[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    let pos = lt + 1;
    let closing = false;
    if (html[pos] === "/") {
      closing = true;
      pos++;
    }
    const nameStart = pos;
    while (pos < html.length && /[A-Za-z0-9-]/.test(html[pos]!)) pos++;
    const name = html.slice(nameStart, pos).toLowerCase();
    if (!name) {
      i = lt + 1;
      continue;
    }
    const attrs = new Map<string, string>();
    let selfClosing = false;
    while (pos < html.length) {
      while (pos < html.length && /\s/.test(html[pos]!)) pos++;
      if (html[pos] === ">") {
        pos++;
        break;
      }
      if (html[pos] === "/" && html[pos + 1] === ">") {
        selfClosing = true;
        pos += 2;
        break;
      }
      const attrStart = pos;
      while (pos < html.length && !/[\s=/>]/.test(html[pos]!)) pos++;
      const attrName = html.slice(attrStart, pos).toLowerCase();
      if (!attrName) {
        pos++;
        continue;
      }
      while (pos < html.length && /\s/.test(html[pos]!)) pos++;
      let value = "";
      if (html[pos] === "=") {
        pos++;
        while (pos < html.length && /\s/.test(html[pos]!)) pos++;
        const quote = html[pos];
        if (quote === '"' || quote === "'") {
          pos++;
          const valStart = pos;
          while (pos < html.length && html[pos] !== quote) pos++;
          value = html.slice(valStart, pos);
          if (html[pos] === quote) pos++;
        } else {
          const valStart = pos;
          while (pos < html.length && !/[\s>]/.test(html[pos]!)) pos++;
          value = html.slice(valStart, pos);
        }
      }
      attrs.set(attrName, value);
    }
    tags.push({ name, closing, selfClosing: selfClosing || VOID_ELEMENTS.has(name), attrs });
    i = pos;
  }
  return tags;
}

function decodeHrefForCheck(raw: string): string {
  const decoded = raw.replace(/&(?:amp|colon|sol|Tab|NewLine|#(\d+)|#[xX]([0-9a-fA-F]+));/g, (m, dec?: string, hex?: string) => {
    if (dec !== undefined) {
      const cp = Number.parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    if (hex !== undefined) {
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    if (m === "&colon;") return ":";
    if (m === "&sol;") return "/";
    if (m === "&Tab;") return "\t";
    if (m === "&NewLine;") return "\n";
    return "&";
  });
  return decoded.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\n\r]/g, "");
}

function projectTopLevelBlockTags(blocks: GramBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === "code") {
      out.push(block.language ? `code:${block.language}` : "code");
      continue;
    }
    let depth = 0;
    for (const tag of tokenizeHTMLTags(block.html)) {
      if (tag.closing) {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth === 0) {
        if (tag.name === "p") out.push("paragraph");
        else if (/^h[1-6]$/.test(tag.name)) out.push(`heading:${tag.name[1]}`);
        else if (tag.name === "ul") out.push("list:unordered");
        else if (tag.name === "ol") {
          const start = tag.attrs.get("start");
          out.push(start && start !== "1" ? `list:ordered:${start}` : "list:ordered");
        } else if (tag.name === "table") out.push("table");
        else if (tag.name === "blockquote") out.push("quote");
        else if (tag.name === "hr") out.push("rule");
        else if (tag.name === "pre") out.push("code");
      }
      if (!tag.selfClosing) depth++;
    }
  }
  return out;
}

function combinedOutput(input: string) {
  const blocks = parseGramMessage(input);
  const html = blocks.map(b => b.kind === "markdown" ? b.html : "").join("\n");
  const codeText = blocks.map(b => b.kind === "code" ? b.code : b.codes.map(c => c.code).join("\n")).join("\n");
  const hasTable = blocks.some(b => b.kind === "markdown" && b.hasTable);
  const hasCode = blocks.some(b => b.kind === "code" || b.codes.length > 0);
  return { blocks, html, codeText, allText: html + "\n" + codeText, hasTable, hasCode };
}

function assertSafeHTML(html: string, context: string) {
  for (const tag of tokenizeHTMLTags(html)) {
    if (tag.closing) continue;
    expect(FORBIDDEN_ELEMENTS.has(tag.name), `${context}: unexpected <${tag.name}>`).toBe(false);
    for (const [attrName, attrValue] of tag.attrs) {
      expect(attrName.startsWith("on"), `${context}: live event handler attribute ${attrName}`).toBe(false);
      if (attrName === "href") {
        const decoded = decodeHrefForCheck(attrValue);
        expect(SAFE_HREF_RE.test(decoded), `${context}: unsafe href "${attrValue}"`).toBe(true);
      }
    }
  }
}

describe("shared Gram Markdown conformance corpus", () => {
  for (const c of corpus.cases as FixtureCase[]) {
    test(`fixture: ${c.id}`, () => {
      const out = combinedOutput(c.input);
      expect(out.blocks.length).toBeGreaterThan(0);
      expect(projectTopLevelBlockTags(out.blocks)).toEqual(c.expect.blocks);
      expect(out.hasTable).toBe(c.expect.hasTable);
      expect(out.hasCode).toBe(c.expect.hasCode);

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

test("link scheme normalization preserves named whitespace entities and rejects non-URL whitespace/unsafe schemes", () => {
  const tab = combinedOutput("[docs](&Tab;https://example.test)");
  expect(tab.html).toContain('<a href="&Tab;https://example.test">docs</a>');
  assertSafeHTML(tab.html, "named-tab");

  const nl = combinedOutput("[docs](&NewLine;https://example.test)");
  expect(nl.html).toContain('<a href="&NewLine;https://example.test">docs</a>');
  assertSafeHTML(nl.html, "named-newline");

  const nbsp = combinedOutput("[docs](&#160;https://example.test)");
  expect(nbsp.html).not.toContain("<a ");
  expect(nbsp.html).toContain("docs");

  const badJsTab = combinedOutput("[bad](java&Tab;script:alert(1))");
  expect(badJsTab.html).not.toContain("<a ");
  expect(badJsTab.html).toContain("bad");

  // Quoted title attribute containing `onload=` text is not a live event handler.
  const quotedTitle = combinedOutput('[docs](https://example.test "mentions onload=literal")');
  expect(quotedTitle.html).toContain('title="mentions onload=literal"');
  assertSafeHTML(quotedTitle.html, "quoted-title");
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
  '[titled](https://herdrup.app "mentions onload=literal")',
  "[tab](&Tab;https://herdrup.app)",
  "[mail](mailto:ops@herdrup.app)",
  "[bad-js](javascript:alert(1))",
  "[bad-js-tab](java&Tab;script:alert(1))",
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

test("latency smoke: 1,500-line adversarial input parses well under budget (< 2s)", () => {
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
