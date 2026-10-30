import { marked } from "marked";
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
   window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark", htmlLabels: false, flowchart: { htmlLabels: false } });
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
