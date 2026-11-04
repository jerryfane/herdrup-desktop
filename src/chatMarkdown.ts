import { marked, type Token, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { Desk } from "./mygo";
import { selfCopyingCodeBlock } from "./codeBlock";

type Mermaid = { initialize(options: object): void; render(id: string, text: string): Promise<{ svg: string }> };
declare global { interface Window { mermaid?: Mermaid } }
let loading: Promise<Mermaid> | null = null;
let diagramID = 0;

/** A clicked link's destination: an HTML anchor's href, or a diagram's SVG anchor, which Mermaid
 *  writes as xlink:href. Opened through openExternalURL's scheme allow-list either way. */
export function linkTarget(link: Element): string {
 return link.getAttribute("href") ?? link.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? link.getAttribute("xlink:href") ?? "";
}
function mermaid(): Promise<Mermaid> {
 if (!loading) {
  const { promise, resolve, reject } = Promise.withResolvers<Mermaid>();
  loading = promise;
  const script = document.createElement("script"); script.src = `${import.meta.env.BASE_URL}mermaid/mermaid.min.js`;
  script.onload = () => {
   if (!window.mermaid) { reject(new Error("Diagram renderer unavailable")); return; }
   // Labels must stay SVG text: the sanitizer below keeps no foreignObject. `secure` makes a
   // diagram's frontmatter or directive unable to turn HTML labels back on; Mermaid deletes
   // those keys at every depth (its sanitize), so flowchart.htmlLabels is held too.
   const secure = ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "htmlLabels"];
   window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "dark", htmlLabels: false, flowchart: { htmlLabels: false }, secure });
   resolve(window.mermaid);
  };
  script.onerror = () => reject(new Error("Could not load diagram renderer"));
  document.head.append(script);
 }
 return loading;
}
export function markdown(text: string): HTMLElement {
 const body = document.createElement("div"); body.className = "chat-markdown";
 body.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
  USE_PROFILES: { html: true }, FORBID_TAGS: ["img", "video", "audio", "iframe", "style", "form", "input"],
  FORBID_ATTR: ["style"],
 });
 body.addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest("a");
  if (!link) return;
  e.preventDefault();
  void Desk.openExternalURL(linkTarget(link)).catch(() => {});
 });
 // A fenced block is GramCodeBlock (ChatMarkdownView.swift 51); a diagram replaces
 // its block once drawn, else its source stays as one (ChatMermaidView.swift 190).
 for (const pre of body.querySelectorAll("pre")) {
  const code = pre.querySelector("code");
  const source = code?.textContent ?? pre.textContent ?? "";
  const language = /(?:^|\s)language-(\S+)/.exec(code?.className ?? "")?.[1] ?? null;
  const host = document.createElement("div"); host.className = "chat-code";
  host.append(selfCopyingCodeBlock(source.replace(/\n$/, ""), language, true));
  pre.replaceWith(host);
  if (language !== "mermaid") continue;
  void mermaid().then(m => m.render(`chat-diagram-${++diagramID}`, source)).then(({ svg }) => {
   const diagram = document.createElement("div"); diagram.className = "chat-diagram";
   diagram.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
   // The sanitizer keeps no foreignObject. Some diagrams (journey) draw an SVG-text copy of
   // each such label; one whose dropped label text appears nowhere else lost it: keep the
   // source instead (#142).
   const words = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
   const kept = words(diagram.textContent);
   const lost = DOMPurify.removed.some(r => "element" in r && r.element instanceof Element && r.element.localName === "foreignObject"
    && words(r.element.textContent) !== "" && !kept.includes(words(r.element.textContent)));
   if (lost) throw new Error("HTML labels");
   host.replaceWith(diagram);
  }).catch(() => { host.title = "Diagram could not be rendered; source is shown."; });
 }
 // ChatMarkdownTable: a horizontal scroller around a rounded, clipped frame whose
 // columns share the width but never shrink below 96 pt (scaled) each.
 for (const table of body.querySelectorAll("table")) {
  const scroller = document.createElement("div"); scroller.className = "chat-table";
  const frame = document.createElement("div"); frame.className = "chat-table-frame";
  const columns = Math.max(1, ...[...table.rows].map(row => row.cells.length));
  frame.style.setProperty("--table-columns", String(columns));
  // ChatView.swift ChatStyle.ok for gains; not a generated design token (as the plan card).
  frame.style.setProperty("--chat-ok", "#7fc89a");
  table.replaceWith(scroller); frame.append(table); scroller.append(frame);
  for (const cell of table.querySelectorAll("td")) {
   const value = cell.textContent?.trim() ?? "";
   if (/^[0-9+\-−$]/.test(value) && /[0-9]/.test(value)) cell.classList.add("chat-table-number", ...(value.startsWith("+") ? ["chat-table-gain"] : []));
  }
 }
 return body;
}

// One selectable text surface, matching Swift's readable message: explicit list
// markers, tab-separated table cells, source for diagrams, and no Copy controls.
export function readableMarkdown(text: string): HTMLElement {
 const inline = (text: string) => {
  const span = document.createElement("span");
  span.innerHTML = DOMPurify.sanitize(marked.parseInline(text, { async: false }) as string, {
   ALLOWED_TAGS: ["strong", "em", "del", "code", "a", "br"], ALLOWED_ATTR: ["href"],
  });
  for (const br of span.querySelectorAll("br")) br.replaceWith("\n");
  return span;
 };
 const blocks = (tokens: Token[], depth = 0, separator = "\n\n"): HTMLElement => {
  const body = document.createElement("span");
  for (const token of tokens) {
   let block: Node;
   switch (token.type) {
    case "space": case "checkbox": continue; // A task's marker is emitted by its list item.
    case "heading": {
     const heading = document.createElement("strong"); heading.append(inline(token.text)); block = heading; break;
    }
    case "code": {
     const code = document.createElement("code"); code.textContent = token.text; block = code; break;
    }
    case "hr": block = document.createTextNode("———"); break;
    case "blockquote": block = blocks((token as Tokens.Blockquote).tokens, depth); break;
    case "list": {
     const list = document.createElement("span");
     token.items.forEach((item: { task: boolean; checked?: boolean; tokens: Token[] }, index: number) => {
      if (index) list.append("\n");
      const marker = item.task ? item.checked ? "☑ " : "☐ " : token.ordered ? `${Number(token.start) + index}. ` : "• ";
      list.append("    ".repeat(depth) + marker, blocks(item.tokens, depth + 1, "\n"));
     });
     block = list; break;
    }
    case "table": {
     const table = document.createElement("span");
     const row = (cells: { text: string }[], header: boolean) => {
      const line = document.createElement(header ? "strong" : "span");
      cells.forEach((cell, index) => { if (index) line.append("\t"); line.append(inline(cell.text)); });
      return line;
     };
     table.append(row(token.header, true));
     for (const cells of token.rows) table.append("\n", row(cells, false));
     block = table; break;
    }
    default: block = inline("text" in token ? token.text : token.raw);
   }
   if (body.childNodes.length) body.append(separator);
   body.append(block);
  }
  return body;
 };
 const body = document.createElement("div"); body.className = "chat-readable-text";
 body.append(blocks(marked.lexer(text)));
 body.addEventListener("click", event => {
  const link = (event.target as HTMLElement).closest("a");
  if (!link) return;
  event.preventDefault(); void Desk.openExternalURL(linkTarget(link)).catch(() => {});
 });
 return body;
}
