import { afterEach, expect, test } from "bun:test";
import { noticeRegion, reserveNotices } from "../src/notices";
import { FakeDocument } from "./fakeDom";

const G = globalThis as { document?: unknown; ResizeObserver?: unknown };
const saved = { document: G.document, ResizeObserver: G.ResizeObserver };
afterEach(() => { G.document = saved.document; G.ResizeObserver = saved.ResizeObserver; });

// #486: the notices live in one region at the window's level, outside the sidebar, so a minimised
// sidebar's hidden, inert state doesn't reach them.
test("the window's notices have one region, a child of the body beside the sidebar, made once", () => {
 const doc = new FakeDocument();
 G.document = doc;
 const sidebar = doc.createElement("aside"); sidebar.id = "sidebar";
 doc.body.append(sidebar);
 const region = noticeRegion();
 expect(noticeRegion()).toBe(region);
 expect(doc.body.children.filter(n => n.id === "notices")).toEqual([region as never]);
 expect(sidebar.all().some(n => n.id === "notices")).toBe(false);
 expect(region.className).toBe("notices");
});

// #475, #486: the lists, and the detail where the notices cross the window's bottom, leave the
// room the observer measures: the region's content box, fractions kept.
test("--foot-notice is the region's content-box height as the observer reports it, kept live", () => {
 type Entry = { contentBoxSize: { blockSize: number }[] };
 let resized = (_entries: Entry[]) => {};
 let observed: unknown = null;
 G.ResizeObserver = class { constructor(f: (entries: Entry[]) => void) { resized = f; } observe(target: unknown) { observed = target; } };
 const props = new Map<string, string>();
 const region = {};
 const root = { style: { setProperty: (name: string, value: string) => props.set(name, value) } };
 // Only style.setProperty is read from the root, and the region is only observed: stand-ins for both.
 reserveNotices(region as HTMLElement, root as unknown as HTMLElement);
 expect(observed).toBe(region);
 resized([{ contentBoxSize: [{ blockSize: 93.16 }] }]);
 expect(props.get("--foot-notice")).toBe("93.16px");
 resized([{ contentBoxSize: [{ blockSize: 0 }] }]);
 expect(props.get("--foot-notice")).toBe("0px");
});
