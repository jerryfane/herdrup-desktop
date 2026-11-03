/** The terminal's font list: the machine font, then herdrup's terminal symbols, then the machine
 *  font's own fallbacks (LiveTerminalView.swift fontCascade). Symbols come before every system
 *  font so an emoji font that maps the same private-use codepoints cannot hide them; the font
 *  claims no other codepoints, so emoji still reach the system. */
export const TERMINAL_SYMBOLS_FAMILY = "Herdrup Symbols";

export function terminalFontFamily(machine: string): string {
 const families = machine.split(",").map(family => family.trim()).filter(Boolean);
 if (families.some(family => family.replace(/["']/g, "") === TERMINAL_SYMBOLS_FAMILY)) return families.join(", ");
 families.splice(Math.min(1, families.length), 0, `"${TERMINAL_SYMBOLS_FAMILY}"`);
 return families.join(", ");
}

let requested = false;
/** Starts loading the symbols as a terminal opens, so its first frame of icons isn't drawn while
 *  the font file is still on its way. Once per page. */
export function loadTerminalSymbols() {
 if (requested || typeof document === "undefined" || !document.fonts) return;
 requested = true;
 void document.fonts.load(`12px "${TERMINAL_SYMBOLS_FAMILY}"`, "\ue0a0").catch(error => console.warn("Terminal symbols font failed to load", error));
}
