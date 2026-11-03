// GramCodeBlock (herdrup GramCards.swift 472-580), which Chat uses too
// (ChatMarkdownView.swift 51): one line with a trailing doc.on.doc glyph, or a
// header with the language and "Copy", over the scrolling code.
import { paintShape } from "./continuous";
import { Desk } from "./mygo";
import { symbolNow } from "./symbol";
import { codeLanguage, codeSpans, type CodeLanguage } from "./codeHighlighter";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** `copied`: this code is CopiedCommandReceipt's text; `onCopy` records it
 * after the clipboard write. */
export function codeBlock(code: string, language: string | null, copied: boolean, onCopy: () => void, syntax = false): HTMLElement {
  const b = el("div", syntax ? "gcode syntax" : "gcode");
  // Chat's blocks take the chat palette's code colours; Gram's stay plain (GramCodeBlock syntax:
  // .current in ChatMarkdownView, nil in Gram).
  paintShape(b, syntax
    ? { radius: 11, fill: "var(--chat-code-background)", stroke: "var(--chat-code-border)", strokeWidth: 1 }
    : { radius: 11, fill: "var(--color-ground-machine)", stroke: "var(--color-hairline)", strokeWidth: 1 });
  const copy = (e: Event) => {
    e.stopPropagation();
    void Desk.gramCopyText(code);
    onCopy();
  };
  const pre = el("pre", "gcode-text");
  const known = syntax ? codeLanguage(language) : null;
  if (known) pre.append(highlighted(code, known)); else pre.textContent = code;
  const scroll = el("div", "gcode-scroll");
  scroll.append(pre);
  const button = (cls: string) => {
    const c = el("button", cls + (copied ? " copied" : ""));
    c.type = "button";
    c.setAttribute("aria-label", copied ? "Copied" : "Copy code");
    c.addEventListener("click", copy);
    return c;
  };
  if (!code.includes("\n")) {
    b.classList.add("one-line");
    const c = button("gcode-copy-glyph");
    c.append(symbolNow(copied ? "checkmark" : "doc.on.doc", 14, "semibold"));
    b.append(scroll, c);
  } else {
    const head = el("div", "gcode-head");
    if (language) head.append(el("span", "gcode-lang", language));
    head.append(el("span", "gcode-spacer"));
    const c = button("gcode-copy");
    c.append(symbolNow(copied ? "checkmark" : "doc.on.doc", 11, "semibold"), el("span", "", copied ? "Copied" : "Copy"));
    head.append(c);
    b.append(head, scroll);
  }
  return b;
}

/** CopiedCommandReceipt for a block that redraws itself: "Copied" for 1.6 s,
 * then back. */
export function selfCopyingCodeBlock(code: string, language: string | null, syntax = false): HTMLElement {
  let timer: number | undefined;
  const draw = (copied: boolean): HTMLElement => codeBlock(code, language, copied, () => {
    const next = draw(true);
    current.replaceWith(next);
    current = next;
    clearTimeout(timer);
    timer = window.setTimeout(() => { const back = draw(false); current.replaceWith(back); current = back; }, 1600);
  }, syntax);
  let current = draw(false);
  return current;
}

/** The code as text runs, each token in its kind's chat colour and plain text uncoloured, so the
 *  block's code-text colour shows (ChatPalette.swift ChatCodeHighlights.styled). One fragment, filled
 *  a node at a time: a long block has more tokens than a call may take arguments (#122). */
export function highlighted(code: string, language: CodeLanguage): DocumentFragment {
  const out = document.createDocumentFragment();
  for (const span of codeSpans(code, language)) {
    if (!span.kind) { out.appendChild(document.createTextNode(span.text)); continue; }
    const run = document.createElement("span");
    run.className = `code-${span.kind}`; run.textContent = span.text;
    out.appendChild(run);
  }
  return out;
}
