// Rich Markdown parsing and rendering for Gram messages (paragraphs, headings, lists, task items,
// tables, blockquotes, rules, code blocks, inline bold/italic/code/strikethrough/links, and bare
// URLs). Each message is lexed ONCE as a whole document so nested fences inside lists, tilde
// fences containing backticks, and reference links defined across code blocks parse intact.
import { Marked, Renderer, Tokenizer, type Token, type Tokens } from "marked";
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

const isWordChar = (ch: string) => /[A-Za-z0-9]/.test(ch);
const isEmailLocalChar = (ch: string) => /[A-Za-z0-9._%+-]/.test(ch);
const BARE_WEB_SCAN = /(?:(?:https?|ftp):\/\/|www\.)/gi;
// Leading `.` is excluded so an ellipsis (`...ops@example.test`) stays prose while valid
// leading `-`, `_` (unformatted), and `+` recipients remain intact (#662, #667).
const BARE_EMAIL_RE = /^([A-Za-z0-9_%+-][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/;

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

const stripAngleBrackets = (s: string) => (s.startsWith("<") && s.endsWith(">") ? s.slice(1, -1) : s);

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

function decodeSchemeEntities(href: string): string {
  return href.replace(/&(?:amp|colon|sol|#(\d+)|#[xX]([0-9a-fA-F]+));/gi, (match, dec?: string, hex?: string) => {
    if (dec !== undefined) {
      const cp = Number.parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (hex !== undefined) {
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    const lower = match.toLowerCase();
    if (lower === "&colon;") return ":";
    if (lower === "&sol;") return "/";
    return "&";
  });
}

type AnnotatedImageToken = Tokens.Image & { gramSerializedHref?: string };
type AnnotatedDefToken = Tokens.Def & { gramSerializedHref?: string };
type GramAutolinkToken = Tokens.Link & { gramAutolink?: boolean };

// Matches Marked's exact reference-label folding (`N(label.replace(/\s+/g, " "))`) so padded
// labels (`[  art  ]`) and Unicode case folds (`STRAẞE` == `STRASSE`) resolve identically (#666).
const foldRefLabel = (label: string) =>
  label.replace(/\s+/g, " ").trim().toLowerCase().toUpperCase().toLowerCase();

// Lazily built per-lex map of ONLY accepted `def` tokens (never rejected paragraph continuations
// like `- intro\n  [art]: ...`) keyed by Marked's `tokens.links` object (#665).
const rawDefsByLinks = new WeakMap<object, Map<string, string>>();

function collectAcceptedDefs(tokens: Token[], out: Map<string, string>): void {
  for (const token of tokens) {
    if (token.type === "def") {
      const def = token as AnnotatedDefToken;
      if (def.gramSerializedHref !== undefined && !out.has(def.tag)) {
        out.set(def.tag, def.gramSerializedHref);
      }
    } else if (token.type === "list") {
      for (const item of (token as Tokens.List).items) collectAcceptedDefs(item.tokens, out);
    } else if ("tokens" in token && Array.isArray(token.tokens)) {
      collectAcceptedDefs(token.tokens, out);
    }
  }
}

function acceptedRawDefs(tokens: Token[], links: object): Map<string, string> {
  let map = rawDefsByLinks.get(links);
  if (!map) {
    map = new Map();
    collectAcceptedDefs(tokens, map);
    rawDefsByLinks.set(links, map);
  }
  return map;
}

/** Finds the earliest case-insensitive bare web URL start (`http(s)://`, `ftp://`, `www.`) in
 *  `src` after a non-word character (excluding email local parts like `ops+WWW.alerts@example.com`)
 *  so `inlineText` clips *before* invoking Marked's native text scan on long paragraphs. */
function findClippedWebStart(src: string): number {
  BARE_WEB_SCAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_WEB_SCAN.exec(src)) !== null) {
    if (match.index === 0) continue;
    if (isWordChar(src[match.index - 1]!)) continue;
    let end = match.index;
    while (end < src.length && isEmailLocalChar(src[end]!)) end++;
    if (src[end] === "@") continue;
    return match.index;
  }
  return -1;
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
  // Use Marked's own tokenizer pipeline (`def`, `link`, `reflink`, `inlineText`, `url`) instead
  // of a pre-emphasis extension so:
  // - Raw image destinations are captured directly at Marked's own syntax boundaries (preserving
  //   escaped brackets in labels, tricky code spans, and Unicode reference folding `#657/#658/#661`).
  // - Marked's `emStrong` runs BEFORE `url()`, so `_ops@example.test_` becomes emphasized
  //   `ops@example.test` while unformatted `_ops@example.test` and `-ops@example.test` keep their
  //   leading characters (`#662`).
  // - `inlineText` stops before case-insensitive `WWW.` / `HTTP(S)://` / `FTP://` inside each text
  //   chunk without rescanning the rest of the message.
  tokenizer: {
    def(src: string) {
      const tok = Tokenizer.prototype.def.call(this, src);
      if (tok) {
        // Record the raw destination on the `def` token itself; `acceptedRawDefs()` only reads
        // definitions that `Lexer.blockTokens` actually accepts into `this.lexer.tokens` (#665).
        const cap = this.rules.block.def.exec(tok.raw);
        if (cap?.[2] !== undefined) {
          (tok as AnnotatedDefToken).gramSerializedHref = serializeMarkdownHref(stripAngleBrackets(cap[2].trim()));
        }
      }
      return tok;
    },
    link(src: string) {
      const tok = Tokenizer.prototype.link.call(this, src);
      // Only inspect `tok.raw` AFTER Marked has already accepted an image and resolved its
      // balanced-parenthesis boundary (zero regex overhead on prose/links; never absorbs `)` #664).
      if (tok && tok.type === "image") {
        const cap = this.rules.inline.link.exec(tok.raw);
        if (cap?.[2] !== undefined) {
          (tok as AnnotatedImageToken).gramSerializedHref = serializeMarkdownHref(stripAngleBrackets(cap[2].trim()));
        }
      }
      return tok;
    },
    reflink(src: string, links) {
      const tok = Tokenizer.prototype.reflink.call(this, src, links);
      if (tok && tok.type === "image") {
        const cap = this.rules.inline.reflink.exec(tok.raw) || this.rules.inline.nolink.exec(tok.raw);
        if (cap) {
          const key = foldRefLabel(cap[2] || cap[1] || "");
          const serialized = acceptedRawDefs(this.lexer.tokens, links).get(key);
          if (serialized !== undefined) {
            (tok as AnnotatedImageToken).gramSerializedHref = serialized;
          }
        }
      }
      return tok;
    },
    inlineText(src: string) {
      // Unsupported `ftp://` bare URLs stay one typed plain-text token so their host/user suffix
      // (`ftp://www.example.test`, `ftp://ops@example.test`) is never rescanned.
      const ftpCap = /^(ftp:\/\/[^\s<>"]+)/i.exec(src);
      if (ftpCap) {
        const raw = trimBareUrl(ftpCap[1]!);
        if (raw.length > "ftp://".length) {
          return { type: "text", raw, text: escapeHTML(raw), escaped: true };
        }
      }
      // Leave leading ellipsis dots as prose so `...ops@example.test` links `ops@example.test` (#667).
      const dotEmail = /^(\.+)([A-Za-z0-9_%+-][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/.exec(src);
      if (dotEmail) {
        const dots = dotEmail[1]!;
        return { type: "text", raw: dots, text: dots };
      }
      // Clip before Marked's native text scan so repeated uppercase `WWW.` links never cause
      // quadratic scanning across the rest of the paragraph.
      const clip = findClippedWebStart(src);
      const bounded = clip !== -1 ? src.slice(0, clip) : src;
      const tok = Tokenizer.prototype.inlineText.call(this, bounded);
      if (!tok) return tok;
      // Enforce the same word-boundary rule when Marked's native text rule splits right before
      // lowercase `www.` or `https?://` inside a word (e.g. `cowww.example.test`, `cohttps://...`).
      if (tok.raw.length > 0 && isWordChar(tok.raw[tok.raw.length - 1]!)) {
        const rest = src.slice(tok.raw.length);
        const glued = /^((?:(?:https?|ftp):\/\/|www\.)[^\s<>"]*)/i.exec(rest);
        if (glued) {
          const merged = tok.raw + trimBareUrl(glued[1]!);
          return { type: "text", raw: merged, text: escapeHTMLPreservingEntities(merged), escaped: false };
        }
      }
      return tok;
    },
    url(src: string) {
      if (this.lexer.state.inLink) return undefined;
      // Reject unsupported `ftp://` so `inlineText()` consumes it as one typed plain-text span.
      if (/^ftp:\/\//i.test(src)) return undefined;
      // Explicit `http(s)://` bare URLs.
      const httpCap = /^(https?:\/\/[^\s<>"]+)/i.exec(src);
      if (httpCap) {
        const raw = trimBareUrl(httpCap[1]!);
        if (!/^https?:\/\/$/i.test(raw)) {
          return { type: "link", raw, text: raw, href: raw, tokens: [], gramAutolink: true } as GramAutolinkToken;
        }
      }
      // Complete bare email addresses (including `+ops@`, `-ops@`, `_ops@` when unformatted,
      // `ops+www.alerts@`, and `www.ops@`). Only yield to a competing `www.` web URL when the
      // trimmed web candidate actually keeps a `/`, `?`, `#`, or `:` suffix (never sentence
      // punctuation like `www.ops@example.com?` or `www.ops@example.com:` — herdrup#920).
      const emailCap = BARE_EMAIL_RE.exec(src);
      if (emailCap) {
        const raw = emailCap[1]!;
        const next = src[raw.length];
        const wwwCap = /^www\./i.test(raw) ? /^(www\.[^\s<>"]+)/i.exec(src) : null;
        const wwwTrimmed = wwwCap ? trimBareUrl(wwwCap[1]!) : "";
        const webOwnsSuffix = wwwTrimmed.length > raw.length && "/?#:".includes(wwwTrimmed[raw.length]!);
        if (next !== "@" && !webOwnsSuffix) {
          return { type: "link", raw, text: raw, href: `mailto:${raw}`, tokens: [], gramAutolink: true } as GramAutolinkToken;
        }
      }
      // Bare `www.` web URLs (upgraded to `https://`, case-insensitive).
      const wwwCap = /^(www\.[^\s<>"]+)/i.exec(src);
      if (wwwCap) {
        const raw = trimBareUrl(wwwCap[1]!);
        if (!/^www\.$/i.test(raw)) {
          return { type: "link", raw, text: raw, href: `https://${raw}`, tokens: [], gramAutolink: true } as GramAutolinkToken;
        }
      }
      return undefined;
    },
  },
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
    // Render bare autolinks verbatim (preserving literal query entities) and flatten any nested
    // image tokens inside authored Markdown links so linked badges open the outer link (#647).
    link(token: Tokens.Link) {
      if ((token as GramAutolinkToken).gramAutolink) {
        return `<a href="${escapeHTML(token.href)}">${escapeHTML(token.text)}</a>`;
      }
      const flattened = flattenLinkImages(token.tokens);
      return Renderer.prototype.link.call(this, flattened === token.tokens ? token : { ...token, tokens: flattened });
    },
    // Keep remote images disabled without turning image-only Markdown messages into empty
    // bubbles: emit an anchor only for openable http(s) destinations, using the raw destination
    // captured at Marked's `link`/`def` tokenizer boundary (#655, #657, #658, #661).
    image(token: Tokens.Image) {
      const label = imageAltLabel(token);
      if (!token.href) return label;
      const href = (token as AnnotatedImageToken).gramSerializedHref ?? escapeHTMLPreservingEntities(token.href);
      if (!/^https?:\/\//i.test(decodeSchemeEntities(href))) return label;
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
