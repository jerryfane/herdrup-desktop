/** SwiftUI's continuous-corner shapes, which herdrup's Capsule() and
 * RoundedRectangle(cornerRadius:) draw by default (their style defaults to
 * .continuous). CSS border-radius draws circular arcs, which differ at every
 * capsule end and card corner. The geometry was read from SwiftUI's own paths
 * (Shape.path(in:), macOS 26.6.2; test/swiftui-paths.swift regenerates
 * test/swiftui-paths.txt, which test/continuous.test.ts checks against).
 *
 * Each corner is three cubic Béziers whose points are multiples of the
 * radius r, measured from the corner along each side. On a side whose half
 * is shorter than the corner's normal reach (1.528665 r), the outer curve
 * starts at the side's middle and its two control points are interpolated
 * between their capsule values (half = r) and their normal ones. */

const REACH = 1.528665;
// The outer curve's control points along the side: normal, and at half = r.
const CP_FAR = 1.08849;
const CP_NEAR = 0.868407;
const CP_FAR_CAPSULE = 0.96;
const CP_NEAR_CAPSULE = 0.82;
// The points of the curve round the corner, constant at any size: where it
// bends off each side, and the middle curve's control points.
const BEND_ALONG = 0.631494;
const BEND_ACROSS = 0.074911;
const MID_ALONG = 0.372824;
const MID_ACROSS = 0.16906;

/** Where the outer curve starts on a side of half-length `half`, and its two
 * control points, as distances from the corner. */
function side(half: number, r: number): [start: number, far: number, near: number] {
  if (half >= REACH * r) return [REACH * r, CP_FAR * r, CP_NEAR * r];
  const t = (half / r - 1) / (REACH - 1);
  return [half, (CP_FAR_CAPSULE + t * (CP_FAR - CP_FAR_CAPSULE)) * r, (CP_NEAR_CAPSULE + t * (CP_NEAR - CP_NEAR_CAPSULE)) * r];
}

const n = (v: number) => +v.toFixed(4);

/** An SVG path for a w×h continuous rounded rectangle with corner radius r
 * at (x, y). r is clamped to half the shorter side, so r = min(w, h) / 2 is
 * a Capsule. (SwiftUI was measured only up to that clamp.) */
export function continuousPath(w: number, h: number, r: number, x = 0, y = 0): string {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r === 0) return `M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`;
  const [hs, hFar, hNear] = side(w / 2, r); // along the top and bottom
  const [vs, vFar, vNear] = side(h / 2, r); // along the left and right
  const b0 = BEND_ALONG * r, b1 = BEND_ACROSS * r;
  const m0 = MID_ALONG * r, m1 = MID_ACROSS * r;
  // One corner at (cx, cy); (sx, sy) point from it into the shape. Distances
  // are (along the horizontal side, along the vertical side). Drawn from the
  // horizontal side to the vertical one, or the other way when `fromVertical`.
  const corner = (cx: number, cy: number, sx: number, sy: number, fromVertical: boolean) => {
    const pt = (dx: number, dy: number) => `${n(cx + sx * dx)} ${n(cy + sy * dy)}`;
    const curves = [
      [pt(hFar, 0), pt(hNear, 0), pt(b0, b1)],
      [pt(m0, m1), pt(m1, m0), pt(b1, b0)],
      [pt(0, vNear), pt(0, vFar), pt(0, vs)],
    ];
    if (!fromVertical) return curves.map((c) => `C${c.join(" ")}`).join("");
    // Reversed: each curve's control points swap and it ends where the
    // previous one began.
    const starts = [pt(hs, 0), pt(b0, b1), pt(b1, b0)];
    return curves
      .map(([c1, c2], i) => `C${c2} ${c1} ${starts[i]}`)
      .reverse()
      .join("");
  };
  const L = x, T = y, R = x + w, B = y + h;
  return (
    `M${n(L + hs)} ${n(T)}H${n(R - hs)}` +
    corner(R, T, -1, 1, false) +
    `V${n(B - vs)}` +
    corner(R, B, -1, -1, true) +
    `H${n(L + hs)}` +
    corner(L, B, 1, -1, false) +
    `V${n(T + vs)}` +
    corner(L, T, 1, 1, true) +
    "Z"
  );
}

/** What paintShape draws behind an element: a fill, and optionally a stroke
 * centred on the shape's edge, as SwiftUI's .fill and .stroke. Colours are CSS
 * values (custom properties work). */
export interface ShapeStyle {
  radius: number | "capsule";
  fill: string;
  stroke?: string;
  strokeWidth?: number;
}

// The SVG overhangs the element by this many whole points on every side, so
// a centred stroke fits and the SVG's origin stays on the element's pixel
// grid (WebKit snaps an SVG's origin to a device pixel).
const PAD = 2;
const painted = new WeakMap<Element, ShapeStyle>();
let resized: ResizeObserver | undefined;

function draw(el: HTMLElement) {
  const style = painted.get(el);
  const svg = el.querySelector<SVGSVGElement>(":scope > svg.continuous-shape");
  if (!style || !svg) return;
  const w = el.offsetWidth, h = el.offsetHeight;
  const r = style.radius === "capsule" ? Math.min(w, h) / 2 : style.radius;
  svg.setAttribute("width", String(w + 2 * PAD));
  svg.setAttribute("height", String(h + 2 * PAD));
  svg.setAttribute("viewBox", `0 0 ${w + 2 * PAD} ${h + 2 * PAD}`);
  const d = continuousPath(w, h, r, PAD, PAD);
  for (const path of svg.querySelectorAll("path")) path.setAttribute("d", d);
}

/** Draws `style` behind `el`'s content as an SVG continuous shape that follows
 * the element's size. The element must be positioned (relative or absolute)
 * and must not paint its own background; its content must be positioned so it
 * paints above the shape (`.shaped > :not(.continuous-shape)` does that). */
export function paintShape(el: HTMLElement, style: ShapeStyle) {
  painted.set(el, style);
  el.classList.add("shaped");
  let svg = el.querySelector<SVGSVGElement>(":scope > svg.continuous-shape");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("continuous-shape");
    svg.style.inset = `${-PAD}px`;
    el.prepend(svg);
  }
  // Colours go in style, not presentation attributes, so custom properties work.
  const stroke = style.stroke
    ? `<path style="fill: none; stroke: ${style.stroke}; stroke-width: ${style.strokeWidth ?? 1}px"/>`
    : "";
  svg.innerHTML = `<path style="fill: ${style.fill}"/>${stroke}`;
  draw(el);
  resized ??= new ResizeObserver((entries) => {
    for (const e of entries) draw(e.target as HTMLElement);
  });
  resized.observe(el);
}
