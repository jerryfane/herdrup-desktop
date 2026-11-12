import type { Plugin } from "postcss";
import valueParser from "postcss-value-parser";

// Swift Typography multiplies font points, not the window's geometry. Apply the
// same rule to app CSS at build time. Xterm owns its canvas/font measurement and
// vendor CSS; neither is scaled here. Relative em/% text already inherits scale.
const absoluteSize = /^[-+]?(?:\d*\.)?\d+(?:px|pt|pc|in|cm|mm|q|rem|vw|vh|vmin|vmax)$/i;
const fontSizeWord = /^[-+]?(?:\d*\.)?\d+(?:px|pt|pc|in|cm|mm|q|rem|em|ex|ch|lh|%|vw|vh|vmin|vmax)$/i;
const sizeFunctions = new Set(["calc", "min", "max", "clamp"]);
function variableName(node: valueParser.FunctionNode) {
  return node.nodes[0]?.type === "word" ? node.nodes[0].value : "";
}
function scaledSize(value: string, allowDirectVariable = true): string {
  const parsed = valueParser(value);
  const only = parsed.nodes.filter(node => node.type !== "space" && node.type !== "comment");
  parsed.walk(node => {
    const directVariable = allowDirectVariable && node.type === "function" && node.value === "var" && only.length === 1 && only[0] === node;
    const sizeVariable = node.type === "function" && node.value === "var" && variableName(node).endsWith("-size");
    if ((node.type === "word" && absoluteSize.test(node.value)) || directVariable || sizeVariable) {
      const replacement = valueParser(`calc(${valueParser.stringify(node)} * var(--ui-font-scale, 1))`).nodes[0];
      Object.assign(node, replacement);
      return false;
    }
    // A custom property's fallback must not be scaled separately from its value.
    if (node.type === "function" && node.value === "var") return false;
    return undefined;
  });
  return parsed.toString();
}

export function uiTypography(): Plugin {
  return {
    postcssPlugin: "herdrup-ui-typography",
    Declaration(declaration) {
      if (declaration.source?.input.file?.replaceAll("\\", "/").includes("/node_modules/")) return;
      if (declaration.value.includes("--ui-font-scale") || declaration.value.includes("--terminal-font-size")) return;
      if (declaration.prop === "font-size" || declaration.prop === "line-height") {
        declaration.value = scaledSize(declaration.value, declaration.prop === "font-size");
      } else if (declaration.prop === "font") {
        const parsed = valueParser(declaration.value);
        const index = parsed.nodes.findIndex(node =>
          (node.type === "word" && fontSizeWord.test(node.value)) ||
          (node.type === "function" && (sizeFunctions.has(node.value) || (node.value === "var" && variableName(node).endsWith("-size")))));
        if (index < 0) return; // inherit, system fonts, or a whole-font custom property
        const size = parsed.nodes[index];
        parsed.nodes.splice(index, 1, ...valueParser(scaledSize(valueParser.stringify(size))).nodes);
        const slash = parsed.nodes[index + 1];
        if (slash?.type === "div" && slash.value === "/" && parsed.nodes[index + 2]) {
          parsed.nodes.splice(index + 2, 1, ...valueParser(scaledSize(valueParser.stringify(parsed.nodes[index + 2]), false)).nodes);
        }
        declaration.value = parsed.toString();
      }
    },
  };
}
