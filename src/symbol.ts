import { Symbols } from "./mygo";

const symbolCache = new Map<string, Promise<HTMLElement>>();

/** An SF Symbol at a point size and weight, tinted by CSS `color`. Symbols
 * draws at 1, 2 or 3 pixels per point, so the page's ratio is clamped to
 * that. A symbol that fails is logged and left empty, not cached, so one
 * missing icon never stops the page from drawing. */
export function symbol(name: string, size: number, weight: string): Promise<HTMLElement> {
  const key = `${name}/${size}/${weight}`;
  let made = symbolCache.get(key);
  if (!made) {
    const scale = Math.min(3, Math.max(1, Math.round(devicePixelRatio)));
    made = Symbols.image(name, size, weight, scale).then((img) => {
      const el = document.createElement("span");
      el.className = "sym";
      el.style.width = `${img.width}px`;
      el.style.height = `${img.height}px`;
      el.style.setProperty("--sym", `url("${img.dataURL}")`);
      return el;
    });
    symbolCache.set(key, made);
    made.catch(() => symbolCache.delete(key));
  }
  return made.then(
    (el) => el.cloneNode(true) as HTMLElement,
    (err) => {
      console.error(`symbol ${key}:`, err);
      const empty = document.createElement("span");
      empty.className = "sym";
      return empty;
    },
  );
}

/** A symbol that fills in once drawn; `display: contents`, so it lays out as
 * the symbol itself. */
export function symbolNow(name: string, size: number, weight: string, cls = ""): HTMLElement {
  const host = document.createElement("span");
  host.className = "gi" + (cls ? " " + cls : "");
  void symbol(name, size, weight).then((s) => host.replaceChildren(s));
  return host;
}
