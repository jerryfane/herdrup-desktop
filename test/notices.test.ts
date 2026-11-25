import { afterEach, expect, test } from "bun:test";
import { noticeRegion } from "../src/notices";
import { FakeDocument } from "./fakeDom";

const G = globalThis as { document?: unknown; ResizeObserver?: unknown };
const saved = { document: G.document, ResizeObserver: G.ResizeObserver };
afterEach(() => { G.document = saved.document; G.ResizeObserver = saved.ResizeObserver; });

type Entry = { contentBoxSize: { blockSize: number }[] };

/** A window with a sidebar, whose ResizeObservers the test drives: observed lists what each
 *  observes, resize(i, height) reports a content-box height to the i-th, and foot() is the
 *  root's --foot-notice. */
function noticeWindow() {
 const observers: { report: (entries: Entry[]) => void; observed: unknown[] }[] = [];
 G.ResizeObserver = class {
  readonly observed: unknown[] = [];
  constructor(readonly report: (entries: Entry[]) => void) { observers.push(this); }
  observe(target: unknown) { this.observed.push(target); }
 };
 const props = new Map<string, string>();
 // Only style.setProperty is read from the root: a stand-in for it.
 const doc = Object.assign(new FakeDocument(), { documentElement: { style: { setProperty: (name: string, value: string) => props.set(name, value) } } });
 G.document = doc;
 const sidebar = doc.createElement("aside"); sidebar.id = "sidebar";
 doc.body.append(sidebar);
 return {
  doc, sidebar, observers,
  resize: (i: number, height: number) => observers[i]!.report([{ contentBoxSize: [{ blockSize: height }] }]),
  foot: () => props.get("--foot-notice"),
 };
}

// #486: the notices live in one region at the window's level, outside the sidebar, so a minimised
// sidebar's hidden, inert state doesn't reach them.
test("the window's notices have one region, a child of the body beside the sidebar, made once", () => {
 const w = noticeWindow();
 const region = noticeRegion();
 expect(noticeRegion()).toBe(region);
 expect(w.doc.body.children.filter(n => n.id === "notices")).toEqual([region as never]);
 expect(w.sidebar.all().some(n => n.id === "notices")).toBe(false);
 expect(region.className).toBe("notices");
});

// #475, #486, #490: the region is measured from the moment it is made, by one observer, so no notice
// sits in room nobody reserved: the lists, and the detail where the notices cross the window's
// bottom, leave the region's content box, fractions kept.
test("the region is made with its measure: --foot-notice is its content-box height as the observer reports it, kept live", () => {
 const w = noticeWindow();
 const region = noticeRegion();
 noticeRegion();
 expect(w.observers.map(o => o.observed)).toEqual([[region]]);
 w.resize(0, 93.16);
 expect(w.foot()).toBe("93.16px");
 w.resize(0, 0);
 expect(w.foot()).toBe("0px");
});
