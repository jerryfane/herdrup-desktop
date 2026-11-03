// The roster's faces, shared by the owner's roster (main.ts) and the guest home in both builds
// (guestHome.ts deps, web/main.ts): the avatar with its status badge, the initial tile and its
// placement, and the loading spinner.

import type { Row } from "./mygo";
import { avatarFace } from "./avatars";
import { continuousPath } from "./continuous";
import { symbol } from "./symbol";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const px = (name: string) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name).trim());

/** The badge's shape as herdrup draws it (AgentAvatar.glyph): a continuous
 * RoundedRectangle (continuous.ts) filled, then stroked in ground colour
 * centred on the same path, half of it outside. "Round" badges use herdrup's
 * literal corner radius 11, which on the 22 pt box is a continuous capsule,
 * not a circle; squares use radius.badgeSquare.
 *
 * The SVG overhangs the badge box by BADGE_PAD (whole points, more than half
 * the stroke) on every side, so its origin stays on a device pixel: WebKit
 * snaps an SVG's origin to the pixel grid, and an overhang of exactly half the
 * 2.5 pt stroke put it on a half pixel and moved the whole badge 0.5 px. */
const BADGE_PAD = 2;
function badgeShape(square: boolean): HTMLElement {
  const size = px("--size-status-badge");
  const stroke = px("--size-status-badge-stroke");
  const radius = square ? px("--radius-badge-square") : 11;
  const box = size + 2 * BADGE_PAD;
  const d = continuousPath(size, size, radius, BADGE_PAD, BADGE_PAD);
  const shape = el("span", "shape");
  shape.style.inset = `${-BADGE_PAD}px`;
  shape.innerHTML = `<svg width="${box}" height="${box}" viewBox="0 0 ${box} ${box}"><path class="fill" d="${d}"/><path class="edge" d="${d}" stroke-width="${stroke}"/></svg>`;
  return shape;
}

export async function badge(kind: string): Promise<HTMLElement | null> {
  const b = el("div", "badge " + kind);
  b.append(badgeShape(kind === "stopped" || kind === "offline"));
  switch (kind) {
    case "waiting":
      b.append(await symbol("exclamationmark", 10, "heavy"));
      return b;
    case "unrecognised":
      b.append(await symbol("questionmark", 10, "heavy"));
      return b;
    case "stopped":
      b.append(await symbol("xmark", 10, "heavy"));
      return b;
    case "offline":
      b.append(await symbol("wifi.slash", 10, "heavy"));
      return b;
    case "working": {
      // TurningRing(diameter: 12, lineWidth: 2) at rest (herdrup
      // App/DesignSystem.swift): Circle().trim(0, 0.72) in a 12 pt frame, so
      // the path's radius is 6 and the 2 pt round-capped stroke reaches 7,
      // past the frame (overflow: visible); from 3 o'clock clockwise, over
      // the ground-filled circle the other badges also have.
      const r = 6;
      const len = 2 * Math.PI * r;
      b.insertAdjacentHTML(
        "beforeend",
        `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="${r}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="${len * 0.72} ${len}"/></svg>`,
      );
      return b;
    }
  }
  return null;
}

const measure = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;

/** A tile with the agent's initial. placeInitials positions the letter once
 * the tile is in the document. */
export function initialTile(r: Row): HTMLElement {
  const tile = el("div", `tile tint-${r.tint}`);
  const glyph = el("span", "initial", r.initial);
  tile.append(glyph);
  return tile;
}

/** Puts each tile's initial where SwiftUI puts a centred Text: the run's
 * origin rounded to the nearest device pixel. Left to flex centring, WebKit
 * rounded fractions above a half down, which drew M and W 1 device pixel left
 * of herdrup's. The advance is measured in the letter's computed font, which
 * is loaded first: canvas text falls back to another face while a web font is
 * still loading, and `document.fonts.ready` does not wait for a face nothing
 * had asked for yet (the system font's narrower A put it 1 pixel right). */
export async function placeInitials(root: ParentNode) {
  const tiles = [...root.querySelectorAll<HTMLElement>(".tile")].flatMap((tile) => {
    const glyph = tile.querySelector<HTMLElement>(".initial");
    if (!glyph) return [];
    const s = getComputedStyle(glyph);
    return [{ tile, glyph, font: `${s.fontWeight} ${s.fontSize} ${s.fontFamily}` }];
  });
  await Promise.all([...new Set(tiles.map((t) => t.font))].map((f) => document.fonts.load(f)));
  for (const { tile, glyph, font } of tiles) {
    measure.font = font;
    const advance = measure.measureText(glyph.textContent ?? "").width;
    const box = tile.getBoundingClientRect().width;
    if (box <= 0) continue; // A hidden page is positioned when its layout becomes visible.
    glyph.style.left = `${Math.round(((box - advance) / 2) * devicePixelRatio) / devicePixelRatio}px`;
  }
}

export async function avatar(r: Row): Promise<HTMLElement> {
  const a = el("div", "avatar");
  a.append(avatarFace(r.avatar, () => initialTile(r)));
  const b = await badge(r.badge);
  if (b) a.append(b);
  return a;
}

// UIActivityIndicatorView (medium) frozen on its first frame, as herdrup's
// loading references show it (measured on both): 8 round-capped spokes 2.5 pt
// wide from radius 3.6 to 10 in a 20 pt box, textDim at opacity 0.85 at 9
// o'clock, then counter-clockwise 0.85 - 0.144 per spoke for three more, and
// the other four at 0.275.
export const spinnerSVG = (() => {
  let s = `<svg width="20" height="20" viewBox="-10 -10 20 20">`;
  for (let i = 0; i < 8; i++) {
    const opacity = i < 4 ? 0.85 - i * 0.144 : 0.275;
    s += `<rect x="-1.25" y="-10" width="2.5" height="6.4" rx="1.25" fill="currentColor" opacity="${opacity.toFixed(3)}" transform="rotate(${-90 - i * 45})"/>`;
  }
  return s + "</svg>";
})();
