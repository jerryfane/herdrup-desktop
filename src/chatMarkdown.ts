import { marked, type Token, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { Desk } from "./mygo";

type Mermaid = { initialize(options: object): void; render(id: string, text: string): Promise<{ svg: string }> };
declare global { interface Window { mermaid?: Mermaid } }
let loading: Promise<Mermaid> | null = null;
let diagramID = 0;
function mermaid(): Promise<Mermaid> {
 if (!loading) {
  const { promise, resolve, reject } = Promise.withResolvers<Mermaid>();
  loading = promise;
  const script = document.createElement("script"); script.src = "/mermaid/mermaid.min.js";
  script.onload = () => {
   if (!window.mermaid) { reject(new Error("Diagram renderer unavailable")); return; }
   window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "dark", htmlLabels: false, flowchart: { htmlLabels: false } });
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
  void Desk.openExternalURL(link.getAttribute("href") ?? "").catch(() => {});
 });
 for (const code of body.querySelectorAll<HTMLElement>("pre code.language-mermaid")) {
  const source = code.textContent ?? "";
  void mermaid().then(m => m.render(`chat-diagram-${++diagramID}`, source)).then(({ svg }) => {
   const diagram = document.createElement("div"); diagram.className = "chat-diagram";
   diagram.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
   code.parentElement?.replaceWith(diagram);
  }).catch(() => { code.title = "Diagram could not be rendered; source is shown."; });
 }
 for (const pre of body.querySelectorAll("pre")) {
  const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "Copy";
  const code = pre.querySelector("code")?.textContent ?? "";
  copy.onclick = () => { void Desk.gramCopyText(code); };
  pre.append(copy);
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
  event.preventDefault(); void Desk.openExternalURL(link.getAttribute("href") ?? "").catch(() => {});
 });
 return body;
}
