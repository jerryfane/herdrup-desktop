import { expect, test } from "bun:test";
import { reserveFootNotices, storedSidebarWidth } from "../src/sidebar";

// HerdrApp.swift recordSidebarWidth keeps the width inside sidebarWidthRange; a damaged or
// missing value must not leave the column at 0 or past the window.
test("a stored sidebar width is clamped to the bounds and falls back to the minimum", () => {
 expect(storedSidebarWidth(null, 320, 460)).toBe(320);
 expect(storedSidebarWidth("", 320, 460)).toBe(320);
 expect(storedSidebarWidth("wide", 320, 460)).toBe(320);
 expect(storedSidebarWidth("380.6", 320, 460)).toBe(381);
 expect(storedSidebarWidth("100", 320, 460)).toBe(320);
 expect(storedSidebarWidth("9999", 320, 460)).toBe(460);
});

// #475: the lists, and the phone's detail, leave room for every notice in the sidebar's foot,
// the Topics switch's and the approval notice alike, as they show, hide and rewrap.
test("--foot-notice is the foot's height but the padding that holds the tab bar, kept live, and the root says when a notice shows", () => {
 const G = globalThis as { ResizeObserver?: unknown; getComputedStyle?: unknown };
 const saved = { ResizeObserver: G.ResizeObserver, getComputedStyle: G.getComputedStyle };
 let resized = () => {};
 G.ResizeObserver = class { constructor(f: () => void) { resized = f; } observe() {} };
 G.getComputedStyle = () => ({ paddingBottom: "88px" });
 try {
  const foot = { offsetHeight: 88 };
  const props = new Map<string, string>(), classes = new Set<string>();
  const root = {
   style: { setProperty: (name: string, value: string) => props.set(name, value) },
   classList: { toggle: (name: string, on: boolean) => { if (on) classes.add(name); else classes.delete(name); } },
  };
  // Only offsetHeight, style.setProperty and classList.toggle are read: stand-ins for the foot and the root.
  reserveFootNotices(foot as unknown as HTMLElement, root as unknown as HTMLElement);
  resized();
  expect(props.get("--foot-notice")).toBe("0px");
  expect(classes.has("foot-notice")).toBe(false);
  // The approval notice (41) and the Topics switch's with its margin (52) over the bar.
  foot.offsetHeight = 88 + 41 + 52;
  resized();
  expect(props.get("--foot-notice")).toBe("93px");
  expect(classes.has("foot-notice")).toBe(true);
  foot.offsetHeight = 88 + 41;
  resized();
  expect(props.get("--foot-notice")).toBe("41px");
 } finally {
  G.ResizeObserver = saved.ResizeObserver;
  G.getComputedStyle = saved.getComputedStyle;
 }
});
