import { describe, expect, test } from "bun:test";
import { type CodeSpan, type CodeTokenKind, codeLanguage, codeSpans } from "../src/codeHighlighter";

// CodeHighlighter.spans(code, language:): nil when the fence names no known language.
function spansFor(code: string, fence: string | null): CodeSpan[] | null {
  const language = codeLanguage(fence);
  return language ? codeSpans(code, language) : null;
}

function mustSpans(code: string, fence: string): CodeSpan[] {
  const spans = spansFor(code, fence);
  expect(spans).not.toBeNull();
  expect(spans!.map((span) => span.text).join("")).toBe(code);
  return spans!;
}

const trim = (text: string) => text.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");

/** The kind of each run whose text is exactly `text` (trimmed), in order. */
function kinds(spans: CodeSpan[], text: string): (CodeTokenKind | null)[] {
  return spans.filter((span) => trim(span.text) === text).map((span) => span.kind);
}

function kind(spans: CodeSpan[], text: string): CodeTokenKind | null {
  const found = kinds(spans, text);
  expect(found.length, `no run is exactly ${text}: ${JSON.stringify(spans)}`).toBeGreaterThan(0);
  return found[0] ?? null;
}

describe("CodeHighlighter", () => {
  test("testSwiftKeywordsStringsCommentsAndCalls", () => {
    const code = [
      "// Keep the visible row anchored",
      "let anchor = rows.first { $0.visible }",
      "func resort(_ rows: [Row]) -> [Row] {",
      "    return rows.sorted(by: rank) /* stable */",
      "}",
      'let label = "Agents \\(count)"',
      "let limit = 42",
    ].join("\n");
    const spans = mustSpans(code, "swift");
    expect(kind(spans, "// Keep the visible row anchored")).toBe("comment");
    expect(kind(spans, "/* stable */")).toBe("comment");
    expect(kinds(spans, "let")).toEqual(["keyword", "keyword", "keyword"]);
    expect(kind(spans, "func")).toBe("keyword");
    expect(kind(spans, "return")).toBe("keyword");
    expect(kind(spans, '"Agents \\(count)"')).toBe("string");
    expect(kind(spans, "42")).toBe("number");
    expect(kind(spans, "sorted")).toBe("function");
    expect(kind(spans, "first")).toBe("function");
    expect(kinds(spans, "Row")).toEqual(["type", "type"]);
    expect(kind(spans, "->")).toBe("op");
    expect(kind(spans, "anchor")).toBeNull();
    expect(kind(spans, "limit")).toBeNull();
  });

  test("testSwiftKeywordsInsideStringsAndCommentsStayThere", () => {
    const spans = mustSpans('let s = "let x = 1 // not a comment" // let y', "swift");
    expect(kinds(spans, "let")).toEqual(["keyword"]);
    expect(kind(spans, '"let x = 1 // not a comment"')).toBe("string");
    expect(kind(spans, "// let y")).toBe("comment");
  });

  test("testRustKeywordsStringsCommentsLifetimesAndMacros", () => {
    const code = [
      "// Count the rows",
      "pub fn count<'a>(rows: &'a [Row]) -> usize {",
      '    let name = "herdr";',
      "    let sep = ',';",
      '    println!("{name}");',
      "    rows.len() + 0x1F",
      "}",
    ].join("\n");
    const spans = mustSpans(code, "rs");
    expect(kind(spans, "// Count the rows")).toBe("comment");
    expect(kind(spans, "pub")).toBe("keyword");
    expect(kind(spans, "fn")).toBe("keyword");
    expect(kinds(spans, "let")).toEqual(["keyword", "keyword"]);
    expect(kind(spans, '"herdr"')).toBe("string");
    expect(kind(spans, "','")).toBe("string");
    expect(kind(spans, "count")).toBe("function");
    expect(kind(spans, "println")).toBe("function");
    expect(kind(spans, "len")).toBe("function");
    expect(kind(spans, "usize")).toBe("type");
    expect(kind(spans, "Row")).toBe("type");
    expect(kind(spans, "0x1F")).toBe("number");
    expect(spans.some((span) => span.kind === "string" && span.text.includes("rows"))).toBe(false);
  });

  test("testBashCommandsKeywordsStringsCommentsAndVariables", () => {
    const code = [
      "# Run the checks",
      'if [ -n "$HOME" ]; then',
      "  git status --short | wc -l",
      "  echo 'done' $USER 3",
      "fi",
    ].join("\n");
    const spans = mustSpans(code, "sh");
    expect(kind(spans, "# Run the checks")).toBe("comment");
    expect(kind(spans, "if")).toBe("keyword");
    expect(kind(spans, "then")).toBe("keyword");
    expect(kind(spans, "fi")).toBe("keyword");
    expect(kind(spans, '"$HOME"')).toBe("string");
    expect(kind(spans, "'done'")).toBe("string");
    expect(kind(spans, "git")).toBe("function");
    expect(kind(spans, "wc")).toBe("function");
    expect(kind(spans, "echo")).toBe("function");
    expect(kind(spans, "$USER")).toBe("type");
    expect(kind(spans, "3")).toBe("number");
    expect(spans.some((span) => span.kind !== null && span.text.includes("status"))).toBe(false);
    expect(kind(spans, "|")).toBe("op");
  });

  test("testBashHashInsideAWordIsNotAComment", () => {
    const spans = mustSpans("echo a#b", "bash");
    expect(spans.some((span) => span.kind === "comment")).toBe(false);
  });

  test("testUnknownOrMissingLanguagesStayPlain", () => {
    expect(spansFor("let x = 1", null)).toBeNull();
    expect(spansFor("let x = 1", "")).toBeNull();
    expect(spansFor("let x = 1", "text")).toBeNull();
    expect(spansFor("graph TD\n  A --> B", "mermaid")).toBeNull();
    expect(spansFor("SELECT 1", "brainfudge")).toBeNull();
  });

  test("testFenceAliasesNameTheirLanguage", () => {
    expect(codeLanguage("TS")).toBe("javascript");
    expect(codeLanguage("tsx")).toBe("javascript");
    expect(codeLanguage("py")).toBe("python");
    expect(codeLanguage("zsh")).toBe("bash");
    expect(codeLanguage("yml")).toBe("yaml");
    expect(codeLanguage("golang")).toBe("go");
    expect(codeLanguage("patch")).toBe("diff");
    // Object prototype names are not fences.
    expect(codeLanguage("constructor")).toBeNull();
    expect(codeLanguage(" swift\t")).toBe("swift");
  });

  test("testTypeScriptPythonGoJsonYamlAndDiff", () => {
    const tsSpans = mustSpans("const n: number = await load(`a ${b}`) // done", "ts");
    expect(kind(tsSpans, "const")).toBe("keyword");
    expect(kind(tsSpans, "number")).toBe("type");
    expect(kind(tsSpans, "load")).toBe("function");
    expect(kind(tsSpans, "`a ${b}`")).toBe("string");
    expect(kind(tsSpans, "// done")).toBe("comment");

    const pySpans = mustSpans('def f(x):\n    """Doc"""\n    return None  # nothing', "python");
    expect(kind(pySpans, "def")).toBe("keyword");
    expect(kind(pySpans, '"""Doc"""')).toBe("string");
    expect(kind(pySpans, "None")).toBe("keyword");
    expect(kind(pySpans, "# nothing")).toBe("comment");

    const goSpans = mustSpans('func main() { fmt.Println("hi", 3.5) }', "go");
    expect(kind(goSpans, "func")).toBe("keyword");
    expect(kind(goSpans, "Println")).toBe("function");
    expect(kind(goSpans, "3.5")).toBe("number");

    const jsonSpans = mustSpans('{"name": "herdr", "n": 2, "ok": true}', "json");
    expect(kind(jsonSpans, '"name"')).toBe("function");
    expect(kind(jsonSpans, '"herdr"')).toBe("string");
    expect(kind(jsonSpans, "2")).toBe("number");
    expect(kind(jsonSpans, "true")).toBe("keyword");

    const yamlSpans = mustSpans("theme:\n  dark: dark-tokyo-night # owner's\n  on: true", "yaml");
    expect(kind(yamlSpans, "theme")).toBe("function");
    expect(kind(yamlSpans, "dark")).toBe("function");
    expect(kind(yamlSpans, "# owner's")).toBe("comment");
    expect(yamlSpans.some((span) => span.kind !== null && span.text.includes("tokyo"))).toBe(false);

    const diffSpans = mustSpans("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same", "diff");
    expect(kind(diffSpans, "-old")).toBe("deleted");
    expect(kind(diffSpans, "+new")).toBe("inserted");
    expect(kind(diffSpans, "@@ -1 +1 @@")).toBe("function");
  });

  test("testUnterminatedStringsAndCommentsEndCleanly", () => {
    for (const [code, fence] of [
      ['let s = "open', "swift"],
      ["/* open", "rust"],
      ['echo "open', "bash"],
      ["x = '''open", "python"],
      ["", "swift"],
    ] as const) {
      mustSpans(code, fence);
    }
  });

  test("non-ASCII code round-trips without splitting surrogate pairs", () => {
    const cases: [string, string][] = [
      ['let 名前 = "😀 é" // 🚀 done\nlet Ωmega = 1', "swift"],
      ["x = '😀\\\n' # 🎉", "python"],
      ["echo 😀$HOME 'é' # 👍", "bash"],
      ["let c = '😀'; // ü", "rust"],
      ["+😀\n-🚀\n é", "diff"],
      ["k😀: v🚀 # ü\n- ~", "yaml"],
      ['{"😀": "\\', "json"],
    ];
    for (const [code, fence] of cases) {
      const spans = mustSpans(code, fence);
      for (const span of spans) expect(span.text.isWellFormed()).toBe(true);
    }
    const swift = mustSpans('let s = "😀" // 🚀', "swift");
    expect(kind(swift, '"😀"')).toBe("string");
    expect(kind(swift, "// 🚀")).toBe("comment");
    // A scalar char literal in Rust is one emoji, not two UTF-16 units.
    expect(kind(mustSpans("let c = '😀';", "rust"), "'😀'")).toBe("string");
  });

  test("a 2,000-line block tokenizes without quadratic blowup", () => {
    const line = 'func f(_ x: Int) -> String { return "v\\(x)" /* c */ } // 😀 note 0x1F';
    const code = Array.from({ length: 2000 }, () => line).join("\n");
    for (const language of ["swift", "rust", "javascript", "python", "bash", "json", "yaml", "go", "diff"] as const) {
      const started = performance.now();
      const spans = codeSpans(code, language);
      const elapsed = performance.now() - started;
      expect(spans.map((span) => span.text).join("")).toBe(code);
      expect(elapsed).toBeLessThan(500);
    }
  });
});
