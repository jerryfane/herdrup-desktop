import { expect, test } from "bun:test";
import { storedSidebarWidth } from "../src/sidebar";

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
