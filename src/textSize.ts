// Swift's device-local terminal.fontSize and chat.fontSize settings. Terminal
// zoom never changes Chat's independent scale, and neither scales the chrome.
export type TextSurface = "terminal" | "chat";
const defaults = { terminal: 12.5, chat: 16 } as const;
const sizes = { terminal: read("terminal"), chat: read("chat") };
let appScale = readAppScale();
const listeners = new Set<() => void>();
function bounded(surface: TextSurface, points: number) {
  if (!Number.isFinite(points)) throw new Error("Text size must be a finite number.");
  return Math.min(24, Math.max(surface === "terminal" ? 9 : 12, points));
}
function read(surface: TextSurface): number {
  try {
    const value = localStorage.getItem(`${surface}.fontSize`);
    return value === null ? defaults[surface] : bounded(surface, Number(value));
  } catch { return defaults[surface]; }
}
function readAppScale(): number {
  try {
    const stored = localStorage.getItem("ui.fontScale"), value = stored === null ? 1 : Number(stored);
    return Number.isFinite(value) ? Math.min(1.4, Math.max(0.9, value)) : 1;
  } catch { return 1; }
}
function applyTextScales() {
  document.documentElement.style.setProperty("--chat-text-scale", String(sizes.chat / defaults.chat));
  document.documentElement.style.setProperty("--ui-font-scale", String(appScale));
}
applyTextScales();
export function uiFontScale() { return appScale; }
export function changeUIFontScale(delta: number | "reset") {
  if (delta !== "reset" && !Number.isFinite(delta)) throw new Error("Text scale must be a finite number.");
  const next = delta === "reset" ? 1 : Math.min(1.4, Math.max(0.9, Math.round((appScale + delta) * 10) / 10));
  localStorage.setItem("ui.fontScale", String(next));
  appScale = next;
  applyTextScales();
  for (const listener of listeners) listener();
}
export function textSize(surface: TextSurface) { return sizes[surface]; }
export function changeTextSize(surface: TextSurface, delta: number | "reset") {
  const next = delta === "reset" ? defaults[surface] : bounded(surface, sizes[surface] + delta);
  // Persist first: a failed save must not make the UI promise a remembered value.
  localStorage.setItem(`${surface}.fontSize`, String(next));
  sizes[surface] = next;
  applyTextScales();
  for (const listener of listeners) listener();
}
export function onTextSizeChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
