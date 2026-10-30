import type { GramAttachment } from "./mygo";
import { onFileDrop } from "mygo-runtime";
import { chipGlyph, chipRing } from "./gramModel";

// AdaptiveComposer's editor stays in its card. The same textarea, selection,
// undo stack and send action remain mounted while the handle changes its height.
const editors = new Set<ComposerEditor>();
export function closeWriter() {
  for (const editor of editors) editor.collapse();
}

// MyGo supplies real native paths without reading large files into JS memory.
export function composerFileDrop(card: HTMLElement, attach: (paths: string[]) => void): () => void {
  const dragover = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  };
  card.addEventListener("dragover", dragover);
  const unsubscribe = onFileDrop(({ paths, x, y }) => {
    const target = document.elementFromPoint(x, y);
    if (paths.length && card.isConnected && target && card.contains(target)) attach(paths);
  });
  return () => { card.removeEventListener("dragover", dragover); unsubscribe(); };
}

// WebKit can hide native image metadata. Ask the OS for file/empty-metadata
// pastes; plain text (including a typed file URI) keeps native paste and undo.
export function composerClipboardPaste(input: HTMLTextAreaElement, paste: () => Promise<boolean>, report: (error: unknown) => void): () => void {
  let disposed = false, pending = false;
  const listener = (event: ClipboardEvent) => {
    const data = event.clipboardData;
    if (!event.isTrusted || !data || input.disabled || input.readOnly || !input.getClientRects().length) return;
    if (data.types.length && !data.types.includes("Files") && !data.types.includes("text/uri-list")) return;
    event.preventDefault();
    if (pending) { report(new Error("Wait for the current paste to finish.")); return; }
    const text = data.getData("text/plain"), before = input.value, start = input.selectionStart, end = input.selectionEnd;
    pending = true;
    void paste().then(handled => {
      if (handled || disposed || !input.isConnected || !input.getClientRects().length) return;
      if (!text) throw new Error("The clipboard does not offer a supported file representation.");
      if (input.value !== before || document.activeElement !== input || input.selectionStart !== start || input.selectionEnd !== end) {
        throw new Error("The reply changed before the paste completed. Paste again at the new cursor.");
      }
      if (!document.execCommand("insertText", false, text)) throw new Error("The clipboard text could not be inserted.");
    }).catch(error => { if (!disposed) report(error); }).finally(() => { pending = false; });
  };
  input.addEventListener("paste", listener);
  return () => { disposed = true; input.removeEventListener("paste", listener); };
}

export class ComposerEditor {
  readonly handle = document.createElement("button");
  private height: number | null = null;
  private natural = 24;
  private maximum = 24;
  private available = 0;
  private drag: { y: number; height: number; open: boolean; time: number; lastY: number; velocity: number } | null = null;
  constructor(private readonly card: HTMLElement, private readonly input: HTMLTextAreaElement, private readonly layout: () => void) {
    this.handle.type = "button";
    this.handle.className = "composer-expand-handle";
    this.handle.hidden = true;
    this.handle.setAttribute("aria-label", "Expand editor");
    card.append(this.handle);
    editors.add(this);
    this.handle.onpointerdown = e => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.handle.setPointerCapture(e.pointerId);
      this.drag = { y: e.clientY, height: this.height ?? this.natural, open: this.height !== null, time: e.timeStamp, lastY: e.clientY, velocity: 0 };
    };
    this.handle.onpointermove = e => {
      const drag = this.drag;
      if (!drag) return;
      const dt = e.timeStamp - drag.time;
      if (dt > 0) drag.velocity = (e.clientY - drag.lastY) / dt;
      drag.time = e.timeStamp; drag.lastY = e.clientY;
      if (Math.abs(e.clientY - drag.y) <= 3) return;
      const h = drag.height - (e.clientY - drag.y);
      this.height = h > this.maximum ? this.maximum + (h - this.maximum) * .25 : h < this.natural ? this.natural + (h - this.natural) * .25 : h;
      this.layout();
    };
    this.handle.onpointerup = e => {
      const drag = this.drag;
      if (!drag) return;
      this.drag = null;
      const delta = e.clientY - drag.y;
      const open = Math.abs(delta) <= 3 ? !drag.open : drag.height - delta - drag.velocity * 150 > (this.natural + this.maximum) / 2;
      this.height = open ? this.maximum : null;
      this.layout();
    };
    this.handle.onpointercancel = () => {
      if (!this.drag) return;
      this.height = this.drag.open ? this.maximum : null;
      this.drag = null; this.layout();
    };
    this.handle.onclick = e => {
      // Pointer gestures are handled above; keyboard/assistive activation has detail 0.
      if (e.detail !== 0) return;
      this.height = this.height === null ? this.maximum : null;
      this.layout();
    };
  }
  get open() { return this.height !== null; }
  update(lines: number, room: number, lineHeight = 24): number {
    this.natural = Math.min(lines, 5) * lineHeight;
    if (!this.input.value.trim()) this.height = null;
    if (!this.open && !this.drag) {
      const growth = Math.max(0, this.card.offsetHeight - 56 - (this.handle.hidden ? 0 : 9));
      this.available = Math.max(0, room - growth);
    }
    this.maximum = this.natural + Math.floor(Math.max(0, this.available - 48) / lineHeight) * lineHeight;
    if (this.height !== null && !this.drag) this.height = this.maximum;
    const visible = this.open || (lines >= 3 && this.maximum >= this.natural + lineHeight);
    this.handle.hidden = !visible;
    this.handle.setAttribute("aria-label", this.open ? "Collapse editor" : "Expand editor");
    this.handle.setAttribute("aria-expanded", String(this.open));
    this.card.classList.toggle("has-editor-handle", visible);
    this.card.classList.toggle("editor-open", this.open);
    return this.height ?? this.natural;
  }
  collapse() {
    if (this.height === null) return;
    this.height = null; this.drag = null; this.layout();
  }
  dispose() { editors.delete(this); this.handle.remove(); }
}

export function composerGlyph(name: string, size: number): HTMLElement {
  const glyph = document.createElement("span"); glyph.className = "gglyph";
  glyph.style.width = glyph.style.height = `${size}px`;
  glyph.style.setProperty("--glyph", `url("/herdrup/composer/${name}.svg")`);
  return glyph;
}

interface SavedPrompt { id: string; nickname: string; text: string }
const promptStorageKey = "dev.herdr.savedPrompts.v1";

export class SavedPromptsMenu {
  readonly button = document.createElement("button");
  private readonly menu = document.createElement("div");
  private sheet: HTMLDialogElement | null = null;
  private outside = (event: PointerEvent) => {
    if (event.target instanceof Node && !this.menu.contains(event.target) && !this.button.contains(event.target)) this.menu.hidden = true;
  };
  constructor(private readonly onSelect: (text: string) => void, private readonly onError: (error: unknown) => void) {
    this.button.type = "button"; this.button.setAttribute("aria-label", "Saved prompts");
    this.button.append(composerGlyph("bookmark", 22));
    this.menu.className = "saved-prompts-menu"; this.menu.hidden = true; this.menu.setAttribute("role", "menu");
    this.button.onclick = () => {
      if (!this.menu.hidden) { this.menu.hidden = true; return; }
      try { this.render(this.load()); this.menu.hidden = false; this.menu.querySelector("button")?.focus(); }
      catch(error) { this.onError(error); }
    };
    this.menu.onkeydown = event => { if (event.key === "Escape") { event.stopPropagation(); this.menu.hidden = true; this.button.focus(); } };
    document.addEventListener("pointerdown", this.outside);
  }
  mount(parent: HTMLElement) { parent.append(this.button, this.menu); }
  private load(): SavedPrompt[] { return JSON.parse(localStorage.getItem(promptStorageKey) ?? "[]") as SavedPrompt[]; }
  private action(label: string, run: () => void) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.setAttribute("role", "menuitem");
    button.onclick = () => { try { run(); } catch(error) { this.onError(error); } }; return button;
  }
  private render(prompts: SavedPrompt[], deleting = false) {
    this.menu.replaceChildren();
    for (const prompt of prompts) {
      this.menu.append(this.action(prompt.nickname.trim() || prompt.text, () => {
        if (deleting) {
          localStorage.setItem(promptStorageKey, JSON.stringify(this.load().filter(item => item.id !== prompt.id)));
          this.render(this.load(), true);
        } else { this.menu.hidden = true; this.onSelect(prompt.text); }
      }));
    }
    if (prompts.length) this.menu.append(document.createElement("hr"));
    this.menu.append(this.action(deleting ? "Back" : "Save new prompt…", () => {
      if (deleting) this.render(this.load()); else { this.menu.hidden = true; this.edit(); }
    }));
    if (prompts.length && !deleting) this.menu.append(this.action("Delete a prompt", () => this.render(this.load(), true)));
  }
  private edit() {
    const sheet = document.createElement("dialog"); this.sheet = sheet; sheet.className = "save-prompt-sheet";
    const header = document.createElement("header"), title = document.createElement("strong");
    title.textContent = "Save prompt"; header.append(this.action("Cancel", () => sheet.close()), title);
    const form = document.createElement("form"), nickname = document.createElement("input"), text = document.createElement("textarea");
    nickname.placeholder = "e.g. daily standup"; nickname.autocomplete = "off";
    text.placeholder = "what to send the agent…"; text.rows = 3;
    for (const [caption, field] of [["NICKNAME", nickname], ["PROMPT", text]] as const) {
      const label = document.createElement("label"); label.textContent = caption; label.append(field); form.append(label);
    }
    const save = document.createElement("button"); save.type = "submit"; save.textContent = "Save prompt"; save.disabled = true;
    const error = document.createElement("p"); error.setAttribute("role", "alert");
    text.oninput = () => { save.disabled = !text.value.trim(); };
    form.onsubmit = event => {
      event.preventDefault(); if (!text.value.trim()) return;
      try {
        const prompts = this.load(); prompts.push({ id: crypto.randomUUID(), nickname: nickname.value.trim(), text: text.value.trim() });
        localStorage.setItem(promptStorageKey, JSON.stringify(prompts)); sheet.close();
      } catch(reason) { error.textContent = String(reason); }
    };
    form.append(save, error); sheet.append(header, form); document.body.append(sheet);
    sheet.addEventListener("close", () => { sheet.remove(); this.sheet = null; this.button.focus(); }, { once: true }); sheet.showModal();
  }
  dispose() {
    document.removeEventListener("pointerdown", this.outside);
    this.sheet?.close(); this.menu.remove(); this.button.remove();
  }
}

export function composerRing(diameter: number, progress: number | null): HTMLElement {
  const r = (diameter - 2) / 2, len = 2 * Math.PI * r, c = diameter / 2;
  const box = document.createElement("span"); box.className = "gring" + (progress === null ? " spin" : "");
  box.style.width = box.style.height = `${diameter}px`;
  const share = progress === null ? 0.23 : Math.min(1, Math.max(0, progress));
  box.innerHTML = `<svg width="${diameter}" height="${diameter}" viewBox="0 0 ${diameter} ${diameter}"><circle class="track" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="2"/><circle class="share" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="2" stroke-linecap="round" stroke-dasharray="${len * share} ${len}" transform="rotate(-90 ${c} ${c})"/></svg>`;
  return box;
}

export function composerAttachment(c: GramAttachment, sending: boolean, removeFile: () => void, retry: () => void): HTMLElement {
  const box = document.createElement("div"); box.className = "gchip" + (c.failed ? " failed" : "");
  const pic = document.createElement("div"); pic.className = "gchip-icon" + (c.state === "sent" ? " sent" : "");
  const progress = chipRing(c);
  if (progress !== null) pic.append(composerRing(34, progress === "spin" ? null : progress));
  pic.append(composerGlyph(chipGlyph(c), 19));
  const lines = document.createElement("div"); lines.className = "gchip-lines";
  for (const [className, text] of [["gchip-name", c.name], ["gchip-status", c.label]]) {
    const line = document.createElement("span"); line.className = className!; line.textContent = text!; lines.append(line);
  }
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "gchip-remove";
  remove.setAttribute("aria-label", `Remove ${c.name}`); remove.disabled = sending; remove.append(composerGlyph("close", 15));
  remove.onclick = event => { event.stopPropagation(); removeFile(); };
  box.append(pic, lines, remove);
  if (c.state === "uploadFailed" && !sending) {
    pic.setAttribute("role", "button"); pic.tabIndex = 0; pic.setAttribute("aria-label", `Retry ${c.name}`);
    pic.onclick = retry;
    pic.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); retry(); } };
  }
  return box;
}
