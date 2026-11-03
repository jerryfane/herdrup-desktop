import { expect, test } from "bun:test";
import { terminalFontFamily } from "../src/terminalFont";

// Owner report 2026-11-03: omp's Nerd Font icons drew as empty boxes in Terminal. The symbols
// must sit right after IBM Plex Mono, ahead of every system fallback (LiveTerminalView.swift).
test("the terminal lists the symbols font right after the machine font", () => {
 expect(terminalFontFamily(`"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace`))
  .toBe(`"IBM Plex Mono", "Herdrup Symbols", ui-monospace, "SF Mono", Menlo, Consolas, monospace`);
 expect(terminalFontFamily(` "IBM Plex Mono" `)).toBe(`"IBM Plex Mono", "Herdrup Symbols"`);
 expect(terminalFontFamily(`"IBM Plex Mono", "Herdrup Symbols", monospace`)).toBe(`"IBM Plex Mono", "Herdrup Symbols", monospace`);
});
