// A fake document for tests that draw real page code (Bun has no DOM): the approve sheet's rows,
// code field and sheet (webAccessModel.test.ts), the web owner's menus and agent sheets
// (webAgentActions.test.ts), the host home's parts and notice in the browser, and its sign-in
// (webOwnerScreen.test.ts), and the agent's page with an open topic (topicChatPage.test.ts). It
// behaves as a browser's does only where that code depends on it.

/** An event target that keeps the listeners it holds, to see a press stop being followed. A
 *  listener added with a signal goes when it aborts, and isn't added once it has. */
export class Listened extends EventTarget {
 readonly held = new Map<string, Set<unknown>>();
 count(type: string) { return this.held.get(type)?.size ?? 0; }
 /** Every listener held, of any type. */
 total() { return [...this.held.values()].reduce((n, s) => n + s.size, 0); }
 override addEventListener(type: string, l: EventListenerOrEventListenerObject | null, o?: AddEventListenerOptions | boolean) {
  const signal = typeof o === "object" ? o.signal : undefined;
  if (signal?.aborted) return;
  if (!this.held.has(type)) this.held.set(type, new Set());
  this.held.get(type)!.add(l);
  signal?.addEventListener("abort", () => this.held.get(type)?.delete(l), { once: true });
  super.addEventListener(type, l, o);
 }
 override removeEventListener(type: string, l: EventListenerOrEventListenerObject | null, o?: EventListenerOptions | boolean) {
  this.held.get(type)?.delete(l);
  super.removeEventListener(type, l, o);
 }
}

/** The document: its body, the element with focus, visibility, and its window (defaultView). */
export class FakeDocument extends EventTarget {
 readonly body: FakeElement;
 readonly defaultView = new Listened();
 activeElement: FakeElement | null = null;
 visibilityState = "visible";
 /** The root element (getComputedStyle reads its custom properties: none here). */
 readonly documentElement: FakeElement;
 constructor() { super(); this.body = new FakeElement("body", this); this.documentElement = new FakeElement("html", this); }
 createElement(tag: string) { return new FakeElement(tag, this); }
 /** A text node: an element of tag "#text" holding the text. */
 createTextNode(text: string) { const node = new FakeElement("#text", this); node.textContent = text; return node; }
 getElementById(id: string) { return this.body.all().find(n => n.id === id) ?? null; }
 /** The element under a point: the one a test points at (a file dropped there, say). */
 pointed: FakeElement | null = null;
 elementFromPoint(_x: number, _y: number) { return this.pointed; }
 /** A range over nothing laid out: it has no line boxes. */
 createRange() { return { selectNodeContents() {}, getClientRects: () => [] }; }
}

/** The DOM the page code uses, behaving as a browser's does where that code depends on it: events
 *  reach listeners and on* handlers; click() does nothing on a disabled or hidden control and ticks
 *  a radio (unticking the rest of its group) or checkbox, and a click on a label activates its
 *  control (for/id, or the one inside it);
 *  focus() needs an enabled element in the document; showModal() needs a dialog in the document
 *  that isn't open, and moves the focus into it (the dialog itself here: its focusing steps' last
 *  resort); close() fires "close". Text appended to an element adds to its textContent;
 *  text() is the element's text with all it holds. Layout sizes are plain fields a test sets;
 *  inserted counts the times the element was put into a parent (a detach and re-attach counts
 *  again: a browser restarts its animations then). */
export class FakeElement extends Listened {
 className = ""; textContent = ""; hidden = false; disabled = false; type = ""; name = ""; value = ""; id = ""; htmlFor = ""; checked = false;
 inputMode = ""; autocomplete = ""; maxLength = -1; selectionStart = 0; selectionEnd = 0; open = false;
 innerHTML = ""; title = ""; src = ""; alt = ""; href = ""; target = ""; rel = ""; readOnly = false; placeholder = ""; rows = 0;
 clientWidth = 0; clientHeight = 0; offsetWidth = 0; offsetHeight = 0; scrollHeight = 0; scrollTop = 0;
 inserted = 0;
 onclick: ((e: Event) => void) | null = null; onchange: ((e: Event) => void) | null = null; oninput: ((e: Event) => void) | null = null;
 parent: FakeElement | null = null;
 readonly children: FakeElement[] = [];
 readonly attributes = new Map<string, string>();
 readonly classList = { toggle() {}, add() {}, remove() {}, contains: (name: string) => this.className.split(" ").includes(name) };
 /** Inline style: properties set directly or with setProperty (custom properties too). */
 readonly style: Record<string, string> = Object.defineProperty({}, "setProperty", { value(this: Record<string, string>, name: string, value: string) { this[name] = value; } });
 readonly dataset: Record<string, string> = {};
 get isConnected() { return this.connected(); }
 /** The pointers captured on this element, in order, and the ones it holds now (a release, a
 *  pointerup or a pointercancel lets go, as a browser's implicit release does). */
 readonly captured: number[] = [];
 readonly holding = new Set<number>();
 constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) { super(); }
 setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
 getAttribute(name: string) { return this.attributes.get(name) ?? null; }
 append(...nodes: (FakeElement | string)[]) {
  for (const n of nodes) {
   if (typeof n === "string") { this.textContent += n; continue; }
   n.remove(); n.parent = this; this.children.push(n); n.inserted++;
  }
 }
 appendChild(n: FakeElement) { this.append(n); return n; }
 prepend(...nodes: FakeElement[]) {
  for (const n of nodes.toReversed()) { n.remove(); n.parent = this; this.children.unshift(n); n.inserted++; }
 }
 /** node before ref (at the end for null), moved from where it was. */
 insertBefore(node: FakeElement, ref: FakeElement | null) {
  node.remove();
  const at = ref === null ? -1 : this.children.indexOf(ref);
  if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
  node.parent = this; node.inserted++;
  return node;
 }
 get firstChild(): FakeElement | null { return this.children[0] ?? null; }
 get firstElementChild(): FakeElement | null { return this.children.find(c => c.tagName !== "#text") ?? null; }
 get childElementCount(): number { return this.children.filter(c => c.tagName !== "#text").length; }
 get nextSibling(): FakeElement | null { const siblings = this.parent?.children; return siblings?.[siblings.indexOf(this) + 1] ?? null; }
 get parentElement(): FakeElement | null { return this.parent; }
 select() {}
 replaceChildren(...nodes: (FakeElement | string)[]) {
  for (const c of [...this.children]) c.remove();
  this.textContent = "";
  this.append(...nodes);
 }
 remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
 all(): FakeElement[] { return [this, ...this.children.flatMap(c => c.all())]; }
 contains(n: unknown): boolean { return this.all().includes(n as FakeElement); }
 text(): string { return this.all().map(n => n.textContent).join(""); }
 /** The first element inside matching a tag and classes ("div", ".a.b", "div.a") or a data-id
  *  (`[data-id="…"]`, as a chat finds its kept row); null for any other selector. */
 querySelector(selector: string): FakeElement | null {
  const id = /^\[data-id="(.*)"\]$/.exec(selector);
  if (id) return this.all().find(n => n !== this && n.dataset.id === id[1]) ?? null;
  const m = /^([a-z0-9]*)((?:\.[\w-]+)*)$/i.exec(selector);
  if (!m) return null;
  const [, tag, classes] = m;
  const wanted = classes!.split(".").filter(Boolean);
  return this.all().find(n => n !== this && (!tag || n.tagName === tag) && wanted.every(c => n.className.split(" ").includes(c))) ?? null;
 }
 querySelectorAll(tag: string) { return this.all().filter(n => n !== this && n.tagName === tag); }
 /** Drawn: neither it nor anything it sits in is hidden. */
 shown(): boolean { return !this.hidden && (this.parent?.shown() ?? true); }
 connected(): boolean { return this === this.ownerDocument.body || (this.parent?.connected() ?? false); }
 override dispatchEvent(e: Event): boolean {
  const ok = super.dispatchEvent(e);
  ({ click: this.onclick, change: this.onchange, input: this.oninput } as Record<string, ((e: Event) => void) | null>)[e.type]?.call(this, e);
  if (e.type === "pointerup" || e.type === "pointercancel") this.holding.delete((e as PointerEvent).pointerId);
  return ok;
 }
 click(): void {
  if (this.disabled || !this.shown()) return;
  const ticks = this.type === "checkbox" || (this.type === "radio" && !this.checked);
  if (ticks && this.type === "radio") for (const r of this.ownerDocument.body.all()) if (r.type === "radio" && r.name === this.name) r.checked = false;
  if (ticks) this.checked = this.type === "radio" || !this.checked;
  this.dispatchEvent(new Event("click"));
  if (ticks) this.dispatchEvent(new Event("change"));
  if (this.tagName === "label") this.control()?.click();
 }
 /** A label's control: the element in the document whose id is its for, else the input inside it. */
 control(): FakeElement | undefined {
  if (this.htmlFor) return this.connected() ? this.ownerDocument.body.all().find(n => n.id === this.htmlFor) : undefined;
  return this.all().find(n => n.tagName === "input");
 }
 focus(): void { if (!this.disabled && this.connected()) this.ownerDocument.activeElement = this; }
 setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
 getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 100, height: 100 }; }
 /** One box while drawn in the document, none otherwise (a browser's for an element not rendered). */
 getClientRects() { return this.connected() && this.shown() ? [this.getBoundingClientRect()] : []; }
 /** An animation that ends at once: what it animated stays as drawn. */
 animate() { return { cancel() {}, finish() {}, finished: Promise.resolve(), onfinish: null }; }
 setPointerCapture(id: number) { this.captured.push(id); this.holding.add(id); }
 hasPointerCapture(id: number) { return this.holding.has(id); }
 releasePointerCapture(id: number) { this.holding.delete(id); }
 showModal(): void {
  if (this.open || !this.connected()) throw new Error("InvalidStateError: showModal on a dialog that's open or not in the document");
  this.open = true;
  this.ownerDocument.activeElement = this;
 }
 close(): void { if (!this.open) return; this.open = false; this.dispatchEvent(new Event("close")); }
}
