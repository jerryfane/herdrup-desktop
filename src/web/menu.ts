// The desktop's native popup menus (mygo.NewMenu(...).Popup, desk_groups.go popup) as an in-page
// menu: it opens where the pointer last was (or the focused element, from the keyboard), and the
// choice comes back as the Go menu item's Click would send it.

import "./menu.css";

export interface MenuEntry { label: string; disabled?: boolean; separator?: boolean }

let pointer: { x: number; y: number } | null = null;
addEventListener("pointerdown", (event) => { pointer = { x: event.clientX, y: event.clientY }; }, true);
addEventListener("contextmenu", (event) => { pointer = { x: event.clientX, y: event.clientY }; }, true);
addEventListener("keydown", () => { pointer = null; }, true);

let open: { close(choice: string | null): void } | null = null;

/** Shows entries; resolves to the chosen label, or null when dismissed. */
export function showMenu(entries: MenuEntry[]): Promise<string | null> {
 open?.close(null);
 const { promise, resolve } = Promise.withResolvers<string | null>();
 const menu = document.createElement("div");
 menu.className = "web-menu"; menu.setAttribute("role", "menu");
 const items: HTMLButtonElement[] = [];
 for (const entry of entries) {
  if (entry.separator) { menu.append(document.createElement("hr")); continue; }
  const item = document.createElement("button");
  item.type = "button"; item.textContent = entry.label; item.setAttribute("role", "menuitem");
  item.disabled = !!entry.disabled;
  item.onclick = () => close(entry.label);
  if (!item.disabled) items.push(item);
  menu.append(item);
 }
 const dismiss = (event: Event) => { if (!menu.contains(event.target as Node)) close(null); };
 const keys = (event: KeyboardEvent) => {
  if (event.key === "Escape") { event.preventDefault(); close(null); return; }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1) + (at < 0 && event.key === "ArrowDown" ? 0 : 0)) % items.length]?.focus();
  const next = at < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
  items[next]?.focus();
 };
 const anchor = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
 function close(choice: string | null) {
  if (open !== handle) return;
  open = null;
  removeEventListener("pointerdown", dismiss, true); removeEventListener("keydown", keys, true); removeEventListener("blur", blur);
  menu.remove();
  anchor?.focus({ preventScroll: true });
  resolve(choice);
 }
 const blur = () => close(null);
 const handle = { close };
 open = handle;
 document.body.append(menu);
 const box = menu.getBoundingClientRect(), rect = anchor?.getBoundingClientRect();
 const at = pointer ?? (rect ? { x: rect.left, y: rect.bottom } : { x: innerWidth / 2, y: innerHeight / 2 });
 menu.style.left = `${Math.max(4, Math.min(at.x, innerWidth - box.width - 4))}px`;
 menu.style.top = `${Math.max(4, Math.min(at.y, innerHeight - box.height - 4))}px`;
 addEventListener("pointerdown", dismiss, true); addEventListener("keydown", keys, true); addEventListener("blur", blur);
 if (!pointer) items[0]?.focus();
 return promise;
}
