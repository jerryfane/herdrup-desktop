// A chat reply's ```svg block (or an ```xml one holding an <svg>), drawn as an image
// (SVGDiagram.swift, ChatMermaidView.swift at herdrup main). The SVG is agent-written, so it
// is parsed and written out again rather than passed through: anything that can run or load is
// dropped, not escaped. The page then shows it as an <img>, which runs no script and loads
// nothing, so this is one of two layers.

/** Larger sources stay code. */
export const maxBytes = 256 * 1024;
export const maxElements = 10_000;
/** A side longer than this (in SVG user units) is not a diagram anyone can read. */
export const maxSide = 16_384;
/** The size an SVG with neither a usable width/height nor a viewBox draws at, as browsers do. */
const defaultSize = { width: 300, height: 150 };

export type SanitizedSVG = { svg: string; width: number; height: number };

/** Whether an ```xml fence holds an SVG document: an <svg> root after any prolog, comment or
 *  doctype, ending in </svg>. Cheap on purpose; sanitizeSVG decides whether it really is one. */
export function looksLikeSVG(source: string): boolean {
  let rest = source.trimStart();
  for (;;) {
    const close = rest.startsWith("<?") ? "?>" : rest.startsWith("<!--") ? "-->" : rest.startsWith("<!") ? ">" : null;
    if (close === null) break;
    const end = rest.indexOf(close);
    if (end < 0) return false;
    rest = rest.slice(end + close.length).trimStart();
  }
  return /^<svg[\s>/]/.test(rest) && source.trimEnd().endsWith("</svg>");
}

/** The diagram a fence's language names, if the chat draws it. */
export function diagramKind(language: string | null, source: string): "mermaid" | "svg" | null {
  switch (language?.toLowerCase()) {
    case "mermaid": return "mermaid";
    case "svg": return "svg";
    case "xml": return looksLikeSVG(source) ? "svg" : null;
    default: return null;
  }
}

/** What a screen reader reads for a drawn SVG: its <title> when it has one. */
export function accessibilityLabel(source: string): string {
  const title = /<title>([\s\S]*?)<\/title>/.exec(source)?.[1]?.trim() ?? "";
  return title === "" || title.includes("<") ? "SVG image" : `SVG image, ${title}`;
}

/** Elements dropped with their whole subtree (compared lowercased). */
const droppedElements = new Set([
  "script", "foreignobject", "iframe", "object", "embed", "audio", "video", "canvas",
  "set", "animate", "animatemotion", "animatetransform", "animatecolor", "discard",
  "handler", "listener",
]);

/** An href that stays inside the document (#id) or is an inline raster image. */
export function isAllowedReference(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return true;
  const lower = trimmed.toLowerCase();
  return ["data:image/png", "data:image/jpeg", "data:image/jpg", "data:image/gif", "data:image/webp"]
    .some(prefix => lower.startsWith(prefix + ";") || lower.startsWith(prefix + ","));
}

/** CSS with nothing that loads: no @import, no url() outside the document. The lookahead
 *  starts right after `url(` so spaces before a quoted `#id` cannot be backtracked into. */
export function cleanCSS(css: string): string {
  return css.replace(/@import[^;]*(;|$)/gi, "").replace(/url\((?!\s*['"]?\s*#)[^)]*\)/gi, "none");
}

/** var(--name) / var(--name, fallback) replaced by the theme's value (or the fallback); an
 *  unknown variable with no fallback is left for CSS to resolve. */
export function substitute(value: string, variables: Record<string, string>): string {
  if (!value.includes("var(")) return value;
  return value.replace(/var\(\s*--([A-Za-z0-9_-]+)\s*(?:,\s*([^()]*?))?\s*\)/g,
    (whole, name: string, fallback: string | undefined) => (Object.hasOwn(variables, name) ? variables[name] : fallback) ?? whole);
}

/** A length in user units: a plain number or px. Percentages and other units say nothing
 *  about the drawing's own size. */
export function length(value: string | null): number | null {
  let text = value?.trim() ?? "";
  if (text.toLowerCase().endsWith("px")) text = text.slice(0, -2);
  if (!/^[+]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function viewBox(value: string | null): { width: number; height: number } | null {
  if (value === null) return null;
  const numbers = value.split(/[\s,]+/).filter(Boolean).map(Number);
  const [, , width = 0, height = 0] = numbers;
  if (numbers.length !== 4 || numbers.some(n => !Number.isFinite(n)) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/** The size the root draws at, from its own width, height and viewBox; null past maxSide. */
export function rootSize(widthAttr: string | null, heightAttr: string | null, viewBoxAttr: string | null): { width: number; height: number } | null {
  const box = viewBox(viewBoxAttr);
  let width = length(widthAttr), height = length(heightAttr);
  if (width === null && height === null) ({ width, height } = box ?? defaultSize);
  else if (height === null) height = width! * (box ?? defaultSize).height / (box ?? defaultSize).width;
  else if (width === null) width = height * (box ?? defaultSize).width / (box ?? defaultSize).height;
  return width! <= maxSide && height <= maxSide ? { width: width!, height } : null;
}

const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
const number = (value: number) => String(value);
const XLINK = "http://www.w3.org/1999/xlink";

/** `source` as an inert SVG document, or null when it is not one well-formed <svg> root (or is
 *  over the size caps): the caller then shows the code. `variables` (names without the leading
 *  --) define the custom properties an agent's SVG expects from its host page, e.g. var(--fg):
 *  once in a :root rule for CSS, and substituted into presentation attributes, which do not
 *  resolve var() everywhere. The root gets the SVG namespace, a viewBox and a numeric
 *  width/height, so it draws at a known size as an image. */
export function sanitizeSVG(source: string, variables: Record<string, string> = {},
  parse: (text: string) => Document = text => new DOMParser().parseFromString(text, "image/svg+xml")): SanitizedSVG | null {
  if (source === "" || new TextEncoder().encode(source).length > maxBytes) return null;
  // An agent may use the xlink prefix without declaring it; an XML parser refuses that.
  let text = source;
  if (/\sxlink:/.test(text) && !/xmlns:xlink\s*=/.test(text)) text = text.replace(/<svg(?=[\s>/])/, `<svg xmlns:xlink="${XLINK}"`);
  let doc: Document;
  try { doc = parse(text); } catch { return null; }
  if (doc.getElementsByTagName("parsererror").length || doc.getElementsByTagNameNS("*", "parsererror").length) return null;
  const root = doc.documentElement;
  if (!root || root.tagName !== "svg") return null;

  let output = "";
  let elements = 0;
  let size: { width: number; height: number } | null = null;
  const cap = 4 * maxBytes;
  const write = (element: Element, depth: number): boolean => {
    if (++elements > maxElements || output.length > cap) return false;
    const name = element.tagName;
    const lower = name.toLowerCase();
    if (droppedElements.has(lower) || name.includes(":")) return true;
    const attributes: Record<string, string> = {};
    for (const attr of element.attributes) {
      const key = attr.name.toLowerCase();
      if (key.startsWith("on") || key === "xml:base") continue;
      if (key === "href" || key.endsWith(":href")) {
        if (isAllowedReference(attr.value)) attributes[attr.name] = attr.value;
        continue;
      }
      if (key === "style") { attributes[attr.name] = cleanCSS(attr.value); continue; }
      const cleaned = /url\(/i.test(attr.value) ? cleanCSS(attr.value) : attr.value;
      attributes[attr.name] = substitute(cleaned, variables);
    }
    if (depth === 1) {
      size = rootSize(element.getAttribute("width"), element.getAttribute("height"), element.getAttribute("viewBox"));
      if (size === null) return false;
      attributes.xmlns = "http://www.w3.org/2000/svg";
      attributes.width = number(size.width);
      attributes.height = number(size.height);
      if (viewBox(element.getAttribute("viewBox")) === null) attributes.viewBox = `0 0 ${number(size.width)} ${number(size.height)}`;
    }
    output += "<" + name;
    for (const [key, value] of Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) output += ` ${key}="${escapeAttribute(value)}"`;
    output += ">";
    const names = Object.keys(variables).sort();
    if (depth === 1 && names.length) output += `<style>${escapeText(":root{" + names.map(n => `--${n}:${variables[n]}`).join(";") + "}")}</style>`;
    let style = "";
    for (const child of element.childNodes) {
      if (child.nodeType === 1) {
        if (!write(child as Element, depth + 1)) return false;
      } else if (child.nodeType === 3 || child.nodeType === 4) {
        if (lower === "style") style += child.nodeValue ?? "";
        else output += escapeText(child.nodeValue ?? "");
      }
      if (output.length + style.length > cap) return false;
    }
    if (lower === "style") output += escapeText(cleanCSS(style));
    output += `</${name}>`;
    return true;
  };
  if (!write(root, 1) || size === null) return null;
  const { width, height } = size as { width: number; height: number };
  return { svg: output, width, height };
}

/** The desktop palette under the names an agent's SVG uses for its host page's colours
 *  (MermaidRenderer.svgVariables, plus success/warning/danger), read from the page's tokens. */
export const svgTokenNames: Record<string, string> = {
  fg: "--color-text", text: "--color-text", foreground: "--color-text",
  muted: "--color-text-dim", dim: "--color-text-dim", secondary: "--color-text-dim",
  faint: "--color-text-faint", subtle: "--color-text-faint", border: "--color-text-faint", line: "--color-text-faint",
  bg: "--color-surface", background: "--color-surface",
  surface: "--color-surface-raised", panel: "--color-surface-raised",
  accent: "--color-brand",
  ok: "--status-done", green: "--status-done", success: "--status-done",
  warn: "--status-waiting", amber: "--status-waiting", warning: "--status-waiting",
  error: "--status-died", red: "--status-died", danger: "--status-died",
  info: "--status-working", blue: "--status-working",
};

export function svgVariables(style: Pick<CSSStyleDeclaration, "getPropertyValue">): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [name, token] of Object.entries(svgTokenNames)) {
    const value = style.getPropertyValue(token).trim();
    if (value !== "") variables[name] = value;
  }
  return variables;
}
