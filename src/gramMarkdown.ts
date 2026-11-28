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
// character references already present in prose tokens.
const escapeHTMLPreservingEntities = (s: string) =>
  s.replace(/&(?!#?\w+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Single word-boundary predicate shared by `bareAutolink.start()` and `bareAutolink.tokenizer()` so
// `www.`, `WWW.`, `https?://`, `ftp://`, and bare emails follow one consistent boundary rule.
const isWordChar = (ch: string) => /[A-Za-z0-9]/.test(ch);
const isEmailLocalChar = (ch: string) => /[A-Za-z0-9._%+-]/.test(ch);
const isEmailStartChar = (ch: string) => /[A-Za-z0-9+%]/.test(ch);
const BARE_WEB_SCAN = /(?:(?:https?|ftp):\/\/|www\.)/gi;
const BARE_EMAIL_DOMAIN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const BARE_EMAIL_RE = /^([A-Za-z0-9+%][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/;

/** Finds the earliest index of a bare email candidate starting before `webIdx` (or anywhere in
 *  `src` when `webIdx === -1`) in O(N) without regex backtracking and without scanning past an
 *  already-settled earlier web URL match. */
function findEmailStart(src: string, webIdx: number): number {
  let maxAt = src.length;
  if (webIdx !== -1) {
    // An email starting before `webIdx` can only place its `@` at or before the end of the
    // contiguous email-local run covering `webIdx` (e.g. `ops+www.alerts@example.com`).
    maxAt = webIdx;
    while (maxAt < src.length && isEmailLocalChar(src[maxAt]!)) maxAt++;
  }
  let pos = 0;
  while (pos <= maxAt && pos < src.length) {
    const at = src.indexOf("@", pos);
    if (at === -1 || at > maxAt) return -1;
    pos = at + 1;
    if (at === 0 || !isEmailLocalChar(src[at - 1]!)) continue;
    if (!BARE_EMAIL_DOMAIN.test(src.slice(at + 1))) continue;
    let start = at - 1;
    while (start > 0 && isEmailLocalChar(src[start - 1]!)) start--;
    // Use the exact same leading character rule (`isEmailStartChar`) as `BARE_EMAIL_RE` so
    // `+ops@example.test` matches consistently at any position while `_ops@example.test_` leaves
    // leading `_` for Marked's emphasis parser (#659).
    while (start < at && !isEmailStartChar(src[start]!)) start++;
    if (start < at && (start === 0 || !isWordChar(src[start - 1]!))) {
      return start;
    }
  }
  return -1;
}

/** Trims trailing prose punctuation and unmatched closing brackets from a bare URL in O(N)
 *  without repeated string splits or regex rescans, while preserving terminal semicolons only
 *  when the URL ends inside its query component (before any `#` fragment). */
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
  const hashIndex = raw.indexOf("#");
  const inQuery = (idx: number) => queryIndex !== -1 && idx > queryIndex && (hashIndex === -1 || idx < hashIndex);
  let end = raw.length;
  while (end > 0) {
    const tail = raw[end - 1]!;
    if (tail === ";") {
      if (inQuery(end - 1)) break;
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

/** Reads a raw Markdown destination (angle-bracketed `<...>` or balanced-paren token) from the
 *  start of `tail` (after skipping leading whitespace), preserving backslash escapes. */
function readRawMarkdownDest(tail: string): string | null {
  let i = 0;
  while (i < tail.length && /\s/.test(tail[i]!)) i++;
  if (i >= tail.length) return null;
  if (tail[i] === "<") {
    const start = ++i;
    while (i < tail.length) {
      if (tail[i] === "\\") { i += 2; continue; }
      if (tail[i] === ">") return tail.slice(start, i);
      i++;
    }
    return null;
  }
  const start = i;
  let parens = 0;
  while (i < tail.length) {
    const ch = tail[i]!;
    if (ch === "\\") { i += 2; continue; }
    if (/\s/.test(ch)) break;
    if (ch === "(") parens++;
    else if (ch === ")") {
      if (parens === 0) break;
      parens--;
    }
    i++;
  }
  return tail.slice(start, i);
}

const normalizeDefKey = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();

/** Extracts the raw destination from a link reference definition token (`[tag]: dest ...`). */
function extractDefRawDest(raw: string): string | null {
  let i = 0;
  while (i < raw.length && /\s/.test(raw[i]!)) i++;
  if (raw[i] !== "[") return null;
  i++;
  while (i < raw.length) {
    if (raw[i] === "\\") { i += 2; continue; }
    if (raw[i] === "]" && raw[i + 1] === ":") return readRawMarkdownDest(raw.slice(i + 2));
    i++;
  }
  return null;
}

/** Extracts the raw destination from an image token using Marked's already-parsed `token.text`
 *  boundary for inline images (`![<text>](<dest>)`) or the captured raw reference definition
 *  table for reference images (`![alt][ref]`, `![ref][]`, `![ref]`) (#657, #658). */
function resolveImageRawDest(token: Tokens.Image, rawDefs: Map<string, string>): string | null {
  const altPrefix = `![${token.text}]`;
  if (!token.raw.startsWith(altPrefix)) return null;
  const afterAlt = token.raw.slice(altPrefix.length);
  if (afterAlt.startsWith("(")) {
    return readRawMarkdownDest(afterAlt.slice(1));
  }
  let refLabel: string;
  if (afterAlt.startsWith("[") && afterAlt.endsWith("]") && afterAlt.length > 2) {
    refLabel = afterAlt.slice(1, -1);
  } else {
    refLabel = token.text;
  }
  return rawDefs.get(normalizeDefKey(refLabel)) ?? null;
}

/** Serializes a raw Markdown link/image destination into an HTML `href` attribute value:
 *  backslash-escaped punctuation (e.g. `\&amp;`, `\&copy;`) is emitted literally via `escapeHTML`,
 *  unescaped HTML character references (e.g. `&#59;`, `&#X3B;`, `&amp;`, `&copy;`) stay verbatim
 *  for the browser to decode, and bare `&`/`<`/`>`/`"` are escaped once. */
function serializeMarkdownHref(rawDest: string): string {
  let out = "";
  for (let i = 0; i < rawDest.length; i++) {
    const ch = rawDest[i]!;
    if (ch === "\\" && i + 1 < rawDest.length && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(rawDest[i + 1]!)) {
      out += escapeHTML(rawDest[++i]!);
    } else if (ch === "&") {
      const ent = /^&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]+);/.exec(rawDest.slice(i));
      if (ent) {
        out += ent[0];
        i += ent[0].length - 1;
      } else {
        out += "&amp;";
      }
    } else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else out += ch;
  }
  return out;
}

type AnnotatedImageToken = Tokens.Image & { gramSerializedHref?: string };

function collectRawDefs(tokens: Token[], out: Map<string, string>): void {
  for (const token of tokens) {
    if (token.type === "def") {
      const def = token as Tokens.Def;
      const key = normalizeDefKey(def.tag);
      if (!out.has(key)) {
        const dest = extractDefRawDest(def.raw);
        if (dest !== null) out.set(key, dest);
      }
    } else if (token.type === "list") {
      for (const item of (token as Tokens.List).items) collectRawDefs(item.tokens, out);
    } else if ("tokens" in token && Array.isArray(token.tokens)) {
      collectRawDefs(token.tokens, out);
    }
  }
}

function annotateImageHrefs(tokens: Token[], rawDefs: Map<string, string>): void {
  for (const token of tokens) {
    if (token.type === "image") {
      const img = token as AnnotatedImageToken;
      const rawDest = resolveImageRawDest(img, rawDefs);
      if (rawDest !== null) img.gramSerializedHref = serializeMarkdownHref(rawDest);
    } else if (token.type === "list") {
      for (const item of (token as Tokens.List).items) annotateImageHrefs(item.tokens, rawDefs);
    } else if (token.type === "table") {
      const table = token as Tokens.Table;
      for (const cell of table.header) annotateImageHrefs(cell.tokens, rawDefs);
      for (const row of table.rows) {
        for (const cell of row) annotateImageHrefs(cell.tokens, rawDefs);
      }
    } else if ("tokens" in token && Array.isArray(token.tokens)) {
      annotateImageHrefs(token.tokens, rawDefs);
    }
  }
}

/** Renders Markdown inline tokens as escaped plain text while keeping code spans literal
 *  (so `` `&amp;` `` stays `&amp;` while prose `&amp;` displays as `&`). */
function renderPlainAlt(tokens: Token[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "codespan":
        out += escapeHTML((token as Tokens.Codespan).text);
        break;
      case "escape":
        out += escapeHTML((token as Tokens.Escape).text);
        break;
      case "html":
        out += escapeHTML(token.raw);
        break;
      case "br":
        out += " ";
        break;
      case "text": {
        const textToken = token as Tokens.Text;
        out += textToken.tokens?.length
          ? renderPlainAlt(textToken.tokens)
          : escapeHTMLPreservingEntities(textToken.text);
        break;
      }
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) {
          out += renderPlainAlt(token.tokens);
        } else if ("text" in token && typeof token.text === "string") {
          out += escapeHTMLPreservingEntities(token.text);
        }
        break;
    }
  }
  return out;
}

function imageAltLabel(token: Tokens.Image): string {
  const alt = token.tokens?.length
    ? renderPlainAlt(token.tokens)
    : escapeHTMLPreservingEntities(token.text || "");
  return alt || (token.href ? escapeHTML(token.href) : "");
}

/** Replaces nested `image` tokens inside a Markdown link with already-escaped plain text tokens
 *  so linked badges (`[![Build](img)](link)`) keep the outer authored destination without nested
 *  anchors or module-wide state. Allocates nothing when no image is present. */
function flattenLinkImages(tokens: Token[]): Token[] {
  let next: Token[] | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    let replacement: Token = token;
    if (token.type === "image") {
      replacement = { type: "text", raw: token.raw, text: imageAltLabel(token as Tokens.Image), escaped: true } as Tokens.Text;
    } else if ("tokens" in token && Array.isArray(token.tokens)) {
      const inner = flattenLinkImages(token.tokens);
      if (inner !== token.tokens) {
        replacement = { ...token, tokens: inner };
      }
    }
    if (replacement !== token) {
      if (next === null) next = tokens.slice(0, i);
      next.push(replacement);
    } else if (next !== null) {
      next.push(token);
    }
  }
  return next ?? tokens;
}

const gramMarked = new Marked({ gfm: true, breaks: true });
gramMarked.use({
  // Disable Marked's built-in GFM `url` tokenizer so one unified `bareAutolink` extension
  // classifies bare emails, `http(s)://`, `www.`, and unsupported `ftp://` spans cleanly without
  // competing boundary rules, truncated email local parts (#653), or rescanned FTP tails.
  tokenizer: {
    url() {
      return undefined;
    },
  },
  extensions: [
    {
      name: "bareAutolink",
      level: "inline",
      start(src: string) {
        let best = -1;
        BARE_WEB_SCAN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = BARE_WEB_SCAN.exec(src)) !== null) {
          if (match.index === 0 || !isWordChar(src[match.index - 1]!)) {
            best = match.index;
            break;
          }
        }
        const emailStart = findEmailStart(src, best);
        if (emailStart !== -1 && (best === -1 || emailStart < best)) {
          best = emailStart;
        }
        return best === -1 ? undefined : best;
      },
      tokenizer(src: string, tokens) {
        if (this.lexer.state.inLink) return undefined;
        const prev = tokens.at(-1);
        if (prev && prev.type === "text" && prev.raw.length > 0 && isWordChar(prev.raw[prev.raw.length - 1]!)) {
          return undefined;
        }
        // Unsupported `ftp://` bare URLs are consumed as one plain-text token so their host/user
        // suffix (`ftp://www.example.test`, `ftp://ops@example.test`) is never rescanned.
        const ftpCap = /^(ftp:\/\/[^\s<>"]+)/i.exec(src);
        if (ftpCap) {
          const raw = trimBareUrl(ftpCap[1]!);
          if (raw.length > "ftp://".length) {
            return { type: "text", raw, text: escapeHTML(raw), escaped: true };
          }
        }
        // Explicit `http(s)://` bare URLs.
        const httpCap = /^(https?:\/\/[^\s<>"]+)/i.exec(src);
        if (httpCap) {
          const raw = trimBareUrl(httpCap[1]!);
          if (!/^https?:\/\/$/i.test(raw)) {
            return { type: "bareAutolink", raw, text: raw, href: raw };
          }
        }
        // Complete bare email addresses (including `ops+www.alerts@example.com`, `+ops@example.test`,
        // and `www.ops@example.com`). Only reject web-URL suffixes (`/`, `?`, `#`, `:`) when a
        // competing `www.` candidate owns them (`www.ops@example.com/report`), so ordinary emails
        // followed by prose punctuation (`ops@example.test:`, `docs@example.test?`) still link.
        const emailCap = BARE_EMAIL_RE.exec(src);
        if (emailCap) {
          const raw = emailCap[1]!;
          const next = src[raw.length];
          const isWwwCandidate = /^www\./i.test(raw);
          if (next !== "@" && (!isWwwCandidate || next === undefined || !"/?#:".includes(next))) {
            return { type: "bareAutolink", raw, text: raw, href: `mailto:${raw}` };
          }
        }
        // Bare `www.` web URLs (upgraded to `https://`, case-insensitive).
        const wwwCap = /^(www\.[^\s<>"]+)/i.exec(src);
        if (wwwCap) {
          const raw = trimBareUrl(wwwCap[1]!);
          if (!/^www\.$/i.test(raw)) {
            return { type: "bareAutolink", raw, text: raw, href: `https://${raw}` };
          }
        }
        return undefined;
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
    // Flatten any nested image tokens inside a Markdown link before delegating to Marked's link
    // renderer so linked image badges open the authored outer link (#647).
    link(token: Tokens.Link) {
      const flattened = flattenLinkImages(token.tokens);
      return Renderer.prototype.link.call(this, flattened === token.tokens ? token : { ...token, tokens: flattened });
    },
    // Keep remote images disabled without turning image-only Markdown messages into empty
    // bubbles: emit an anchor only for openable http(s) destinations, using the raw destination
    // annotated from the inline syntax or reference definition (#655, #657, #658).
    image(token: Tokens.Image) {
      const label = imageAltLabel(token);
      if (!token.href || !/^https?:\/\//i.test(token.href)) return label;
      const href = (token as AnnotatedImageToken).gramSerializedHref ?? escapeHTMLPreservingEntities(token.href);
      return `<a href="${href}">${label}</a>`;
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

function codeTokenToBlock(token: Tokens.Code): NestedCodeBlock {
  const language = (token.lang ?? "").trim().split(/\s+/)[0] || null;
  return { code: token.text, language };
}

function collectCodeBlocks(tokens: Token[], out: NestedCodeBlock[]): void {
  for (const token of tokens) {
    if (token.type === "code") {
      out.push(codeTokenToBlock(token as Tokens.Code));
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
  const rawDefs = new Map<string, string>();
  collectRawDefs(tokens, rawDefs);
  annotateImageHrefs(tokens, rawDefs);
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
      out.push({ kind: "code", ...codeTokenToBlock(token as Tokens.Code) });
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
