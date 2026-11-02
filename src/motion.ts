/**
 * herdrup's SwiftUI animations as CSS: each named motion is a duration and an easing.
 *
 * SwiftUI's `.spring(response:dampingFraction:)` and `.smooth(duration:)` (a spring with no
 * bounce whose response is the duration) are a damped harmonic oscillator. Their curve is
 * sampled here into CSS `linear()` stops, and the duration is the time the spring takes to
 * settle within 0.1 % of its target, so a CSS transition draws the same motion. Plain eases
 * (`.easeOut(duration:)`) map to CSS's own curves.
 *
 * The values are set on :root at start (main.ts) as `--motion-<name>-duration` and
 * `--motion-<name>-ease`. Under `prefers-reduced-motion: reduce` every duration is 0, as
 * herdrup passes a nil animation (or an opacity-only fade) when Reduce Motion is on.
 */

export interface Motion { duration: number; ease: string }

/** The spring's progress at `t` seconds, 0 to 1 (overshooting when underdamped). */
export function springAt(t: number, response: number, damping: number): number {
  const w = (2 * Math.PI) / response;
  if (damping >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
  const wd = w * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
}

/** Seconds until the spring stays within `tolerance` of its target. */
export function springSettle(response: number, damping: number, tolerance = 0.001): number {
  const step = 0.001;
  let last = 0;
  for (let t = 0; t < 10; t += step) if (Math.abs(1 - springAt(t, response, damping)) > tolerance) last = t;
  return last + step;
}

export function spring(response: number, damping: number, samples = 40): Motion {
  const duration = springSettle(response, damping);
  const stops: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const v = i === samples ? 1 : springAt((duration * i) / samples, response, damping);
    stops.push(String(Math.round(v * 10000) / 10000));
  }
  return { duration, ease: `linear(${stops.join(", ")})` };
}

/** `.smooth(duration:)`: no bounce, response = duration. */
export const smooth = (duration: number) => spring(duration, 1);
export const eased = (duration: number, ease: string): Motion => ({ duration, ease });

/** Every motion the desktop draws, by name, each citing herdrup 9845ecf. */
export const MOTIONS: Record<string, Motion> = {
  // HerdrApp.swift 637: the machine's home replacing the connect screen.
  home: smooth(0.35),
  // HerdrApp.swift 2837: the selected tab's pill slides between tabs. The split view's own
  // column animation (~0.3 s, toggleSidebar) uses the same smooth curve.
  tab: smooth(0.3),
  sidebar: smooth(0.3),
  // HerdrApp.swift 3160-3179: an agent's page fades in and slides 40 pt from the right.
  page: eased(0.26, "ease-out"),
  // NeedsYouPill.swift 95.
  pill: spring(0.32, 0.86),
  // AgentFolderViews.swift 222: folder and row motion.
  folder: spring(0.3, 0.86),
  // ComposerView.swift 314-315: the field growing a line; the composer rearranging.
  grow: spring(0.34, 0.86),
  rearrange: spring(0.38, 0.8),
  // ChatView.swift 1051/1116 disclosures, Gram's Saved toggle (GramView.swift 751), the
  // terminal's jump and history capsules (HerdrApp.swift 5944-5952).
  quick: eased(0.15, "ease-in-out"),
  // CopyForAgentButton.swift 40: the setup guides' copy card swapping to "Copied".
  copied: eased(0.15, "ease-out"),
  // GramCards.swift 282 (Read more); CopyForAgentButton.swift 43; the host row's release
  // (HerdrApp.swift 770).
  settle: eased(0.2, "ease-out"),
  // ConversationColumn.swift 213: the column's resize handles appearing.
  handle: eased(0.12, "ease-out"),
  // ChatScrollPosition.swift 54: the chat jump button's glide to the tail,
  // UIView.animate(withDuration: 0.3, options: .curveEaseOut). Drawn by glideChatToLatest
  // (interaction.ts) a frame at a time along easeOut, as scrollTop has no CSS transition.
  glide: eased(0.3, "ease-out"),
};

/** Sets every motion's CSS variables on `root`. */
export function applyMotions(root: HTMLElement, reduce: boolean) {
  for (const [name, m] of Object.entries(MOTIONS)) {
    root.style.setProperty(`--motion-${name}-duration`, reduce ? "0s" : `${Math.round(m.duration * 1000)}ms`);
    root.style.setProperty(`--motion-${name}-ease`, m.ease);
  }
}

/** A motion's current duration in seconds (0 under Reduce Motion or before applyMotions). */
export function motionSeconds(name: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--motion-${name}-duration`).trim();
  return value.endsWith("ms") ? parseFloat(value) / 1000 : parseFloat(value) || 0;
}

/** CSS `ease-out`, UIKit's `.curveEaseOut`: cubic-bezier(0, 0, 0.58, 1), the progress at time
 *  fraction `x` (0 to 1). For motion drawn frame by frame, where no CSS curve applies. */
export function easeOut(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // x(t) = 3(1-t)t²·0.58 + t³ rises monotonically, so bisect for the t that gives x.
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 40; i++) {
    t = (lo + hi) / 2;
    if (3 * (1 - t) * t * t * 0.58 + t * t * t < x) lo = t; else hi = t;
  }
  return 3 * (1 - t) * t * t + t * t * t;
}

/** Animates `el` from `from` px tall to the height it has now, as SwiftUI animates a view
 *  whose content grew or shrank inside `withAnimation`. */
export function animateHeight(el: HTMLElement, from: number, name: string) {
  const seconds = motionSeconds(name);
  const to = el.getBoundingClientRect().height;
  if (!seconds || Math.abs(to - from) < 1) return;
  const s = el.style;
  s.height = `${from}px`; s.overflow = "hidden";
  void el.offsetHeight;
  s.transition = `height var(--motion-${name}-duration) var(--motion-${name}-ease)`;
  s.height = `${to}px`;
  let timer = 0;
  const done = (event?: TransitionEvent) => {
    if (event && (event.target !== el || event.propertyName !== "height")) return;
    s.height = s.overflow = s.transition = "";
    el.removeEventListener("transitionend", done); clearTimeout(timer);
  };
  el.addEventListener("transitionend", done);
  timer = window.setTimeout(done, seconds * 1000 + 100);
}

/** Every <details> under `root` opens and closes with ChatView's disclosure motion
 *  (`withAnimation(.easeInOut(duration: 0.15))`, ChatView.swift 1051/1116). */
export function animateDisclosures(root: HTMLElement) {
  const before = new WeakMap<HTMLDetailsElement, number>();
  root.addEventListener("click", event => {
    const details = (event.target as Element | null)?.closest?.("summary")?.parentElement;
    if (details instanceof HTMLDetailsElement) before.set(details, details.getBoundingClientRect().height);
  }, true);
  // toggle does not bubble; a capturing listener still sees it.
  root.addEventListener("toggle", event => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !before.has(details)) return;
    animateHeight(details, before.get(details)!, "quick");
    before.delete(details);
  }, true);
}
