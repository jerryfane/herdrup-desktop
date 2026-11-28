// Rich Markdown parsing and rendering for Gram messages (paragraphs, headings, lists, task items,
// tables, blockquotes, rules, code blocks, inline bold/italic/code/strikethrough/links, and bare
// URLs). Each message is lexed ONCE as a whole document so nested fences inside lists, tilde
// fences containing backticks, and reference links defined across code blocks parse intact.
import { Marked, Renderer, type Token, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { Desk } from "./mygo";
import { selfCopyingCodeBlock } from "./codeBlock";
import { prepareMarkdownTables } from "./markdownTable";
import { MESSAGE_SANITIZE_CONFIG } from "./messageSanitize";

const escapeHTML = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Like Marked's `escape(s, false)`: escapes raw `&`, `<`, `>`, `"` without double-escaping
// entities already decoded/preserved by Marked in parsed inline tokens or Markdown link hrefs.
const escapeHTMLPreservingEntities = (s: string) =>
  s.replace(/&(?!#?\w+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Single case-insensitive boundary rule shared by `start()` and `tokenizer()` so lowercase
// `www.` and mixed-case `WWW.` follow identical recognition rules (including inside quotes).
const BARE_URL_START = /(?:^|[\s(\[{"'*_~])(?:https?:\/\/|www\.)/i;
const BARE_URL_PREV = /[\s(\[{"'*_~]$/;

/** Trims trailing prose punctuation and unmatched closing brackets from a bare URL in O(N)
 *  without repeated string splits, while preserving terminal entity-like query semicolons such
 *  as `www.example.test/?q=1&amp;`. */
function trimBareUrl(raw: string): string {
  let openParen = 0;
  let closeParen = 0;
  let openBracket = 0;
  let closeBracket = 0;
  let openBrace = 0;
  let closeBrace = 0;
  for (let i = 0; i < raw.length; i++) {
    switch (raw[i]) {
      case "(": openParen++; break;
      case ")": closeParen++; break;
      case "[": openBracket++; break;
      case "]": closeBracket++; break;
      case "{": openBrace++; break;
      case "}": closeBrace++; break;
    }
  }
  const queryIndex = raw.indexOf("?");
  let end = raw.length;
  while (end > 0) {
    const tail = raw[end - 1]!;
    if (tail === ";") {
      if (queryIndex !== -1 && end - 1 > queryIndex && /&[A-Za-z0-9#]+;$/.test(raw.slice(queryIndex + 1, end))) {
        break;
      }
      end--;
      continue;
    }
    if ("?!.,:*_~'\"".includes(tail)) {
      end--;
      continue;
    }
    if (tail === ")" && closeParen > openParen) {
      closeParen--;
      end--;
      continue;
    }
    if (tail === "]" && closeBracket > openBracket) {
      closeBracket--;
      end--;
      continue;
    }
    if (tail === "}" && closeBrace > openBrace) {
      closeBrace--;
      end--;
      continue;
    }
    break;
  }
  return raw.slice(0, end);
}

let renderLinkDepth = 0;

const gramMarked = new Marked({ gfm: true, breaks: true });
gramMarked.use({
  // Delegate bare email autolinks (`ops@example.test`) to Marked's default `url` tokenizer while
  // routing bare `http(s)://` and `www.` URLs through our case-insensitive `bareUrl` extension so
  // `WWW.Example.com/Runbook` stays clickable, `www.` upgrades to `https://`, literal query
  // entities (`?q=1&copy;more`, `?q=1&amp;`) are never decoded or truncated, and explicit
  // Markdown links (`[www.example.com](http://www.example.com)`) keep their authored scheme.
  tokenizer: {
    url(src: string) {
      if (/^(?:https?:\/\/|www\.)/i.test(src)) return undefined;
      return false;
    },
  },
  extensions: [
    {
      name: "bareUrl",
      level: "inline",
      start(src: string) {
        const match = BARE_URL_START.exec(src);
        if (!match) return undefined;
        return match.index + (match[0].length - match[0].replace(/^[\s(\[{"'*_~]/, "").length);
      },
      tokenizer(src: string, tokens) {
        if (this.lexer.state.inLink) return undefined;
        const prev = tokens.at(-1);
        if (prev && !BARE_URL_PREV.test(prev.raw)) return undefined;
        const cap = /^((?:https?:\/\/|www\.)[^\s<>"]+)/i.exec(src);
        if (!cap) return undefined;
        const raw = trimBareUrl(cap[1]!);
        if (/^(?:www\.|https?:\/\/)$/i.test(raw)) return undefined;
        const href = /^www\./i.test(raw) ? `https://${raw}` : raw;
        return { type: "bareUrl", raw, text: raw, href };
      },
      renderer(token) {
        return `<a href="${escapeHTML(String(token.href))}">${escapeHTML(String(token.text))}</a>`;
      },
    },
  ],
  renderer: {
    checkbox({ checked }: Tokens.Checkbox) {
      const state = checked ? "checked" : "unchecked";
      const label = checked ? "Checked" : "Unchecked";
      return `<span class="gcheck ${state}" aria-label="${label}">${checked ? "☑" : "☐"}</span> `;
    },
    // Render unsupported raw HTML syntax (e.g. `<environment>` or raw `<pre><code>...`) literally
    // instead of letting DOMPurify drop unknown tags or emit stray DOM `<pre>` elements that
    // shift nested Markdown code-block matching (#645, herdrup#901).
    html({ raw, block }: Tokens.HTML | Tokens.Tag) {
      if (!block) return escapeHTML(raw);
      const trimmed = raw.trimEnd();
      return trimmed ? `<p>${escapeHTML(trimmed)}</p>\n` : "";
    },
    // Track nested link rendering so linked image badges (`[![Build](img)](link)`) render their
    // alt text inside the authored outer anchor instead of emitting nested `<a>` tags (#647).
    link(token: Tokens.Link) {
      renderLinkDepth++;
      try {
        return Renderer.prototype.link.call(this, token);
      } finally {
        renderLinkDepth--;
      }
    },
    // Keep remote images disabled without turning image-only Markdown messages into empty
    // bubbles: render parsed plain alt text (preserving HTML entities without double-escaping)
    // as label text inside an existing link, or as a safe link for standalone images.
    image({ href, text, tokens }: Tokens.Image) {
      const parsedAlt = tokens?.length
        ? escapeHTMLPreservingEntities(this.parser.parseInline(tokens, this.parser.textRenderer))
        : escapeHTMLPreservingEntities(text || "");
      const label = parsedAlt || (href ? escapeHTMLPreservingEntities(href) : "");
      if (renderLinkDepth > 0 || !href) return label;
      return `<a href="${escapeHTMLPreservingEntities(href)}">${label}</a>`;
    },
  },
});

function tokenHasTable(token: Token): boolean {
  if (token.type === "table") return true;
  if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.some(tokenHasTable)) return true;
  if (token.type === "list") {
    return (token as Tokens.List).items.some((item) => item.tokens.some(tokenHasTable));
  }
  return false;
}

export interface NestedCodeBlock {
  code: string;
  language: string | null;
}

function collectCodeBlocks(tokens: Token[], out: NestedCodeBlock[]): void {
  for (const token of tokens) {
    if (token.type === "code") {
      const codeToken = token as Tokens.Code;
      const language = (codeToken.lang ?? "").trim().split(/\s+/)[0] || null;
      out.push({ code: codeToken.text, language });
    } else if (token.type === "list") {
      for (const item of (token as Tokens.List).items) collectCodeBlocks(item.tokens, out);
    } else if ("tokens" in token && Array.isArray(token.tokens)) {
      collectCodeBlocks(token.tokens, out);
    }
  }
}

export type GramMarkdownBlock =
  | {
      kind: "markdown";
      /** Unsanitized HTML produced by `marked`; browser callers render via `renderGramMarkdown`,
       *  which unconditionally sanitizes with DOMPurify. */
      html: string;
      /** True when the run has multiple blocks or any non-paragraph block; false for a single
       *  paragraph (keeps exact 8-line `-webkit-line-clamp: 8` folding). */
      rich: boolean;
      /** True when this run contains a Markdown table (widens the bubble to its cap). */
      hasTable: boolean;
      /** Nested code tokens inside this run (e.g. fenced blocks inside lists/quotes), keeping
       *  their exact parsed text including any trailing blank lines for the Copy button. */
      codes: NestedCodeBlock[];
    }
  | {
      kind: "code";
      code: string;
      language: string | null;
    };

/** Parses a whole Gram message ONCE into top-level code blocks (for the distinct card inset with
 *  the shared Copy receipt) and surrounding Markdown runs. Pure; safe without a DOM. */
export function parseGramMessage(text: string): GramMarkdownBlock[] {
  const tokens = gramMarked.lexer(text);
  const out: GramMarkdownBlock[] = [];
  let run: Token[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const meaningful = run.filter((t) => t.type !== "space" && t.type !== "def");
    const slice = run;
    run = [];
    if (meaningful.length === 0) return;
    const html = gramMarked.parser(slice);
    if (html.trim() === "") return;
    const hasTable = meaningful.some(tokenHasTable);
    const rich = meaningful.length > 1 || meaningful[0]!.type !== "paragraph";
    const codes: NestedCodeBlock[] = [];
    collectCodeBlocks(meaningful, codes);
    out.push({ kind: "markdown", html, rich, hasTable, codes });
  };

  for (const token of tokens) {
    if (token.type === "code") {
      flushRun();
      const codeToken = token as Tokens.Code;
      const language = (codeToken.lang ?? "").trim().split(/\s+/)[0] || null;
      out.push({ kind: "code", code: codeToken.text, language });
    } else {
      run.push(token);
    }
  }
  flushRun();
  return out;
}

/** Renders a parsed Gram Markdown run as a DOMPurify-sanitized DOM element ready for `.gprose`,
 *  with tables wrapped in scrollable rounded frames, links routed through `Desk.openExternalURL`,
 *  and any nested `<pre>` (e.g. a code fence inside a list item or blockquote) rendered with the
 *  Gram code block widget using the exact parsed code text. */
export function renderGramMarkdown(block: Extract<GramMarkdownBlock, { kind: "markdown" }>): HTMLElement {
  const body = document.createElement("div");
  body.className = block.rich ? "gprose-md" : "gprose-text";
  body.innerHTML = DOMPurify.sanitize(block.html, MESSAGE_SANITIZE_CONFIG);

  // Single-paragraph runs keep their inline nodes directly inside `.gprose-text` so
  // `-webkit-line-clamp: 8` clamps cleanly across WebKit/Blink without block wrapper quirks.
  if (!block.rich && body.children.length === 1 && body.firstElementChild?.tagName === "P") {
    const p = body.firstElementChild;
    body.replaceChildren(...p.childNodes);
  }

  for (const link of body.querySelectorAll("a")) {
    link.classList.add("glink");
  }

  body.addEventListener("click", (e) => {
    const link = (e.target as HTMLElement).closest("a");
    if (!link) return;
    e.preventDefault();
    void Desk.openExternalURL(link.getAttribute("href") ?? "").catch(() => {});
  });

  let nestedIndex = 0;
  for (const pre of body.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    const parsed = block.codes[nestedIndex++];
    const source = parsed ? parsed.code : (code?.textContent ?? pre.textContent ?? "").replace(/\n$/, "");
    const language = parsed
      ? parsed.language
      : /(?:^|\s)language-(\S+)/.exec(code?.className ?? "")?.[1] ?? null;
    const host = document.createElement("div");
    host.className = "gprose-code";
    host.append(selfCopyingCodeBlock(source, language, false));
    pre.replaceWith(host);
  }

  prepareMarkdownTables(body, {
    scroller: "gtable",
    frame: "gtable-frame",
    number: "gtable-number",
    gain: "gtable-gain",
  });

  return body;
}
