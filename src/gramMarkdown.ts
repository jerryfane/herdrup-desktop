// Rich Markdown rendering for Gram message prose (paragraphs, headings, lists, task items,
// tables, blockquotes, rules, inline bold/italic/code/strikethrough/links, and bare URLs).
// Fenced ``` code blocks are already split by gramText.ts into top-level GramCodeBlock segments;
// any remaining <pre> (indented code, tilde fences, or unclosed fences) becomes a code block too.
import { Marked, type Token, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { Desk } from "./mygo";
import { linkTarget } from "./chatMarkdown";
import { selfCopyingCodeBlock } from "./codeBlock";

const gramMarked = new Marked({ gfm: true, breaks: true });
gramMarked.use({
  renderer: {
    checkbox({ checked }: Tokens.Checkbox) {
      const state = checked ? "checked" : "unchecked";
      const label = checked ? "Checked" : "Unchecked";
      return `<span class="gcheck ${state}" aria-label="${label}">${checked ? "☑" : "☐"}</span> `;
    },
  },
});

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["img", "video", "audio", "iframe", "style", "form", "input"],
  FORBID_ATTR: ["style"],
};

function tokenHasTable(token: Token): boolean {
  if (token.type === "table") return true;
  if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.some(tokenHasTable)) return true;
  if (token.type === "list") {
    return (token as Tokens.List).items.some((item) => item.tokens.some(tokenHasTable));
  }
  return false;
}

export interface GramMarkdownShape {
  /** True when the segment contains multiple blocks or any non-paragraph block (heading, list,
   *  table, quote, rule, code); false for a single paragraph (keeps 8-line -webkit-line-clamp). */
  rich: boolean;
  /** True when the segment contains a Markdown table (widens the bubble to its cap). */
  hasTable: boolean;
}

/** Classifies a Gram prose segment before rendering (pure; safe without a DOM). */
export function analyzeGramMarkdown(text: string): GramMarkdownShape {
  const tokens = gramMarked.lexer(text);
  const blocks = tokens.filter((t) => t.type !== "space");
  const hasTable = blocks.some(tokenHasTable);
  const rich = blocks.length > 1 || (blocks.length === 1 && blocks[0]!.type !== "paragraph");
  return { rich, hasTable };
}

/** True when `text` contains a GitHub-flavored Markdown table. */
export function hasMarkdownTable(text: string): boolean {
  if (!text.includes("|")) return false;
  return analyzeGramMarkdown(text).hasTable;
}

/** Unsanitized Markdown parse result for unit testing token/HTML structure without a DOM.
 *  Browser callers MUST use `gramMarkdown()`, which unconditionally sanitizes with DOMPurify. */
export function parseGramMarkdown(text: string): { html: string; rich: boolean; hasTable: boolean } {
  const tokens = gramMarked.lexer(text);
  const blocks = tokens.filter((t) => t.type !== "space");
  const hasTable = blocks.some(tokenHasTable);
  const rich = blocks.length > 1 || (blocks.length === 1 && blocks[0]!.type !== "paragraph");
  return { html: gramMarked.parser(tokens), rich, hasTable };
}

export interface RenderedGramMarkdown {
  root: HTMLElement;
  rich: boolean;
  hasTable: boolean;
}

/** Renders a Gram prose segment as a sanitized DOM element ready for `.gprose`, with tables
 *  wrapped in scrollable rounded frames, links routed through `Desk.openExternalURL`, and any
 *  nested code blocks rendered with the Gram code block widget. */
export function gramMarkdown(text: string): RenderedGramMarkdown {
  const { html: raw, rich, hasTable } = parseGramMarkdown(text);
  const body = document.createElement("div");
  body.className = rich ? "gprose-md" : "gprose-text";
  body.innerHTML = DOMPurify.sanitize(raw, SANITIZE_CONFIG);

  // Single-paragraph messages keep their inline nodes directly inside `.gprose-text` so
  // `-webkit-line-clamp: 8` clamps cleanly across WebKit/Blink without block wrapper quirks.
  if (!rich && body.children.length === 1 && body.firstElementChild?.tagName === "P") {
    const p = body.firstElementChild;
    body.replaceChildren(...p.childNodes);
  }

  for (const link of body.querySelectorAll("a")) {
    link.classList.add("glink");
    const href = link.getAttribute("href") ?? "";
    const label = link.textContent ?? "";
    if (/^www\./i.test(label) && href.toLowerCase() === `http://${label.toLowerCase()}`) {
      link.setAttribute("href", `https://${label}`);
    }
  }

  body.addEventListener("click", (e) => {
    const link = (e.target as HTMLElement).closest("a");
    if (!link) return;
    e.preventDefault();
    void Desk.openExternalURL(linkTarget(link)).catch(() => {});
  });

  for (const pre of body.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    const source = code?.textContent ?? pre.textContent ?? "";
    const language = /(?:^|\s)language-(\S+)/.exec(code?.className ?? "")?.[1] ?? null;
    const host = document.createElement("div");
    host.className = "gprose-code";
    host.append(selfCopyingCodeBlock(source.replace(/\n$/, ""), language, false));
    pre.replaceWith(host);
  }

  for (const table of body.querySelectorAll("table")) {
    const scroller = document.createElement("div");
    scroller.className = "gtable";
    const frame = document.createElement("div");
    frame.className = "gtable-frame";
    const columns = Math.max(1, ...[...table.rows].map((row) => row.cells.length));
    frame.style.setProperty("--table-columns", String(columns));
    table.replaceWith(scroller);
    frame.append(table);
    scroller.append(frame);
    for (const cell of table.querySelectorAll("td")) {
      const value = cell.textContent?.trim() ?? "";
      if (/^[0-9+\-−$]/.test(value) && /[0-9]/.test(value)) {
        cell.classList.add("gtable-number", ...(value.startsWith("+") ? ["gtable-gain"] : []));
      }
    }
  }

  return { root: body, rich, hasTable };
}
