import { expect, test } from "bun:test";
import { cleanCSS, diagramKind, isAllowedReference, looksLikeSVG, rootSize, substitute } from "../src/svgDiagram";

// Owner report 2026-11-06: an agent's ```svg block showed as code on desktop; the app draws it.
test("svg and xml fences holding an svg root are drawn and other fences stay code", () => {
  const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  expect(diagramKind("svg", svg)).toBe("svg");
  expect(diagramKind("SVG", svg)).toBe("svg");
  expect(diagramKind("xml", `<?xml version="1.0"?>\n<!-- drawn -->\n${svg}\n`)).toBe("svg");
  expect(diagramKind("xml", "<config><svg/></config>")).toBeNull();
  expect(diagramKind("xml", "<svgx></svgx>")).toBeNull();
  expect(diagramKind("xml", "<svg>")).toBeNull();
  expect(diagramKind("mermaid", "flowchart LR")).toBe("mermaid");
  expect(diagramKind("html", svg)).toBeNull();
  expect(diagramKind(null, svg)).toBeNull();
});

test("theme variables replace var() in attributes and unknown ones keep their fallback or stay", () => {
  const theme = { fg: "#eef0f7", border: "#666d91" };
  expect(substitute("var(--fg)", theme)).toBe("#eef0f7");
  expect(substitute("var( --border )", theme)).toBe("#666d91");
  expect(substitute("var(--nope, #123456)", theme)).toBe("#123456");
  expect(substitute("var(--nope)", theme)).toBe("var(--nope)");
  expect(substitute("var(--constructor)", theme)).toBe("var(--constructor)");
  expect(substitute("url(#g) var(--fg)", theme)).toBe("url(#g) #eef0f7");
});

test("css keeps references inside the document and loads nothing", () => {
  expect(cleanCSS("@import url(https://x.test/a.css); fill: url(#grad); background: url('https://x.test/i.png')"))
    .toBe(" fill: url(#grad); background: none");
  expect(cleanCSS("mask: url( '#m' )")).toBe("mask: url( '#m' )");
  expect(isAllowedReference("#node")).toBe(true);
  expect(isAllowedReference("data:image/png;base64,AAAA")).toBe(true);
  expect(isAllowedReference("data:image/svg+xml,<svg/>")).toBe(false);
  expect(isAllowedReference("https://x.test/a.png")).toBe(false);
  expect(isAllowedReference("javascript:alert(1)")).toBe(false);
});

test("the root draws at its own size from width height and viewBox", () => {
  expect(rootSize(null, null, "0 0 900 640")).toEqual({ width: 900, height: 640 });
  expect(rootSize("450", null, "0 0 900 640")).toEqual({ width: 450, height: 320 });
  expect(rootSize(null, "320px", "0,0,900,640")).toEqual({ width: 450, height: 320 });
  expect(rootSize("100%", "50%", "0 0 900 640")).toEqual({ width: 900, height: 640 });
  expect(rootSize(null, null, null)).toEqual({ width: 300, height: 150 });
  expect(rootSize("600", null, null)).toEqual({ width: 600, height: 300 });
  expect(rootSize(null, null, "0 0 0 10")).toEqual({ width: 300, height: 150 });
  expect(rootSize("20000", "10", null)).toBeNull();
});
