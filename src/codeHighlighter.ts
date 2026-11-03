// A port of native herdrup's HerdrKit/CodeHighlighter.swift: a small one-pass tokenizer for
// chat code blocks. It works on Unicode scalars (code points), like the Swift original, so
// astral characters are never split; the spans of a block, joined, are its code unchanged.

/** What a piece of code is; `inserted` and `deleted` are a diff's added and removed lines. */
export type CodeTokenKind =
  | "keyword"
  | "string"
  | "comment"
  | "function"
  | "number"
  | "type"
  | "op"
  | "inserted"
  | "deleted";

export type CodeLanguage = "swift" | "rust" | "javascript" | "python" | "bash" | "json" | "yaml" | "go" | "diff";

/** A run of code with one kind; `kind` is null for plain text. */
export interface CodeSpan {
  text: string;
  kind: CodeTokenKind | null;
}

const FENCES: Record<string, CodeLanguage> = {
  swift: "swift",
  rust: "rust",
  rs: "rust",
  javascript: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  typescript: "javascript",
  ts: "javascript",
  tsx: "javascript",
  python: "python",
  py: "python",
  python3: "python",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  go: "go",
  golang: "go",
  diff: "diff",
  patch: "diff",
};

/** Swift's `.whitespaces`: spaces and tabs, not newlines. */
const EDGE_WHITESPACE = /^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu;

/** The language a code fence names (` ```ts `, ` ```sh `), or null for one the highlighter does not know. */
export function codeLanguage(fence: string | null): CodeLanguage | null {
  if (fence == null) return null;
  const key = fence.replace(EDGE_WHITESPACE, "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(FENCES, key) ? FENCES[key]! : null;
}

/** The spans of `code` in `language`. */
export function codeSpans(code: string, language: CodeLanguage): CodeSpan[] {
  const s = Array.from(code);
  switch (language) {
    case "diff":
      return diffSpans(s);
    case "bash":
      return new BashScanner(s).run();
    default:
      return new CodeScanner(s, language, rulesOf(language)).run();
  }
}

// MARK: - Spans

/** Collects spans, joining neighbours of the same kind so a block has few runs. */
class SpanBuilder {
  private spans: CodeSpan[] = [];
  private runStart = 0;
  private runEnd = 0;
  private runKind: CodeTokenKind | null = null;

  constructor(private readonly s: string[]) {}

  add(start: number, end: number, kind: CodeTokenKind | null): void {
    end = Math.min(end, this.s.length);
    if (end <= start) return;
    if (kind === this.runKind && start === this.runEnd) {
      this.runEnd = end;
      return;
    }
    this.flush();
    this.runStart = start;
    this.runEnd = end;
    this.runKind = kind;
  }

  finish(): CodeSpan[] {
    this.flush();
    return this.spans;
  }

  private flush(): void {
    if (this.runEnd <= this.runStart) return;
    this.spans.push({ text: this.s.slice(this.runStart, this.runEnd).join(""), kind: this.runKind });
    this.runStart = this.runEnd;
  }
}

const ALPHABETIC = /\p{Alphabetic}/u;
const UPPERCASE = /\p{Uppercase}/u;

const isAsciiLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isDigit = (c: string) => c >= "0" && c <= "9";
const isNonAscii = (c: string) => c.codePointAt(0)! > 0x7f;
const isIdentifierStart = (c: string) => isAsciiLetter(c) || c === "_" || (isNonAscii(c) && ALPHABETIC.test(c));
const isIdentifierPart = (c: string) => isIdentifierStart(c) || isDigit(c);
const isSpace = (c: string) => c === " " || c === "\t";
const isUppercaseLetter = (c: string) => (c >= "A" && c <= "Z") || (isNonAscii(c) && UPPERCASE.test(c));

const OPERATORS = new Set(["+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~", "?", ":"]);

/** `literal` must be ASCII (all callers' are), so its UTF-16 units are its scalars. */
function matches(s: string[], literal: string, at: number): boolean {
  if (at + literal.length > s.length) return false;
  for (let k = 0; k < literal.length; k++) if (s[at + k] !== literal[k]) return false;
  return true;
}

/** The end of the line `index` is on (the newline's index, or the end). */
function lineEnd(s: string[], index: number): number {
  let i = index;
  while (i < s.length && s[i] !== "\n") i++;
  return i;
}

/** The end of a quoted string that opens at `index`. */
function quotedEnd(s: string[], index: number, quote: string, escapes: boolean, multiline: boolean): number {
  let i = index + 1;
  while (i < s.length) {
    const c = s[i];
    if (escapes && c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === "\n" && !multiline) return i;
    i++;
  }
  return s.length;
}

const RADIX_MARKS = new Set(["x", "X", "o", "O", "b", "B"]);

/** The end of a number that starts at `index`: `_` separators, fraction, exponent, radix forms, suffixes. */
function numberEnd(s: string[], index: number): number {
  let i = index;
  if (s[i] === "0" && i + 1 < s.length && RADIX_MARKS.has(s[i + 1]!)) {
    i += 2;
    while (i < s.length && isIdentifierPart(s[i]!)) i++;
    return i;
  }
  while (i < s.length && (isDigit(s[i]!) || s[i] === "_")) i++;
  if (i + 1 < s.length && s[i] === "." && isDigit(s[i + 1]!)) {
    i++;
    while (i < s.length && (isDigit(s[i]!) || s[i] === "_")) i++;
  }
  if (i < s.length && (s[i] === "e" || s[i] === "E")) {
    let j = i + 1;
    if (j < s.length && (s[j] === "+" || s[j] === "-")) j++;
    if (j < s.length && isDigit(s[j]!)) {
      i = j;
      while (i < s.length && isDigit(s[i]!)) i++;
    }
  }
  while (i < s.length && isIdentifierPart(s[i]!)) i++;
  return i;
}

// MARK: - C-like, Python, JSON, YAML

interface Rules {
  lineComments: string[];
  blockComment: { open: string; close: string } | null;
  quotes: Set<string>;
  /** Quotes whose strings may run over several lines (js template strings, Go raw strings). */
  multilineQuotes: Set<string>;
  tripleQuotes: string[];
  keywords: Set<string>;
  types: Set<string>;
  /** A capitalised name is a type. */
  capitalisedTypes: boolean;
  /** `$` starts an identifier (Swift's `$0`, JavaScript's `$el`). */
  dollarIdentifiers: boolean;
  /** `@name` (Swift attributes, Python decorators) is a keyword. */
  atAttributes: boolean;
  /** `#if`, `#available`: Swift's compiler directives are keywords. */
  hashDirectives: boolean;
  /** Rust: `'a` is a lifetime, only `'x'` and `'\n'` are character literals. */
  rustChars: boolean;
}

function rulesOf(language: CodeLanguage): Rules {
  const r: Rules = {
    lineComments: [],
    blockComment: null,
    quotes: new Set(),
    multilineQuotes: new Set(),
    tripleQuotes: [],
    keywords: new Set(),
    types: new Set(),
    capitalisedTypes: false,
    dollarIdentifiers: false,
    atAttributes: false,
    hashDirectives: false,
    rustChars: false,
  };
  const cBlock = { open: "/*", close: "*/" };
  switch (language) {
    case "swift":
      r.lineComments = ["//"];
      r.blockComment = cBlock;
      r.quotes = new Set(['"']);
      r.tripleQuotes = ['"""'];
      r.keywords = new Set([
        "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import",
        "init", "inout", "internal", "let", "open", "operator", "private", "precedencegroup",
        "protocol", "public", "rethrows", "static", "struct", "subscript", "typealias", "var",
        "break", "case", "catch", "continue", "default", "defer", "do", "else", "fallthrough",
        "for", "guard", "if", "in", "repeat", "return", "throw", "switch", "where", "while", "as",
        "false", "is", "nil", "self", "Self", "super", "throws", "true", "try", "await", "async",
        "actor", "some", "any", "weak", "unowned", "lazy", "mutating", "nonmutating", "override",
        "final", "required", "convenience", "dynamic", "indirect", "willSet", "didSet",
        "nonisolated", "isolated", "consuming", "borrowing", "package", "macro",
      ]);
      r.capitalisedTypes = true;
      r.dollarIdentifiers = true;
      r.atAttributes = true;
      r.hashDirectives = true;
      break;
    case "rust":
      r.lineComments = ["//"];
      r.blockComment = cBlock;
      r.quotes = new Set(['"']);
      r.multilineQuotes = new Set(['"']);
      r.keywords = new Set([
        "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
        "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move",
        "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true",
        "type", "unsafe", "use", "where", "while", "yield",
      ]);
      r.types = new Set([
        "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize",
        "f32", "f64", "bool", "char", "str",
      ]);
      r.capitalisedTypes = true;
      r.rustChars = true;
      break;
    case "javascript":
      r.lineComments = ["//"];
      r.blockComment = cBlock;
      r.quotes = new Set(['"', "'", "`"]);
      r.multilineQuotes = new Set(["`"]);
      r.keywords = new Set([
        "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
        "do", "else", "export", "extends", "false", "finally", "for", "function", "if", "import",
        "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true",
        "try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "async",
        "await", "of", "undefined", "interface", "type", "enum", "implements", "private",
        "protected", "public", "readonly", "abstract", "declare", "namespace", "as", "from",
        "keyof", "satisfies",
      ]);
      r.types = new Set(["string", "number", "boolean", "any", "unknown", "never", "object", "bigint", "symbol"]);
      r.capitalisedTypes = true;
      r.dollarIdentifiers = true;
      break;
    case "python":
      r.lineComments = ["#"];
      r.quotes = new Set(['"', "'"]);
      r.tripleQuotes = ['"""', "'''"];
      r.keywords = new Set([
        "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
        "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
        "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
        "try", "while", "with", "yield", "self", "match", "case",
      ]);
      r.types = new Set(["int", "str", "float", "bool", "list", "dict", "set", "tuple", "bytes", "object"]);
      r.capitalisedTypes = true;
      r.atAttributes = true;
      break;
    case "go":
      r.lineComments = ["//"];
      r.blockComment = cBlock;
      r.quotes = new Set(['"', "'", "`"]);
      r.multilineQuotes = new Set(["`"]);
      r.keywords = new Set([
        "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
        "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range",
        "return", "select", "struct", "switch", "type", "var", "nil", "true", "false", "iota",
      ]);
      r.types = new Set([
        "bool", "byte", "complex64", "complex128", "error", "float32", "float64", "int", "int8",
        "int16", "int32", "int64", "rune", "string", "uint", "uint8", "uint16", "uint32",
        "uint64", "uintptr", "any",
      ]);
      r.capitalisedTypes = true;
      break;
    case "json":
      r.lineComments = ["//"];
      r.quotes = new Set(['"']);
      r.keywords = new Set(["true", "false", "null"]);
      break;
    case "yaml":
      r.lineComments = ["#"];
      r.quotes = new Set(['"', "'"]);
      r.keywords = new Set(["true", "false", "null", "yes", "no", "on", "off", "True", "False", "Null", "~"]);
      break;
    case "bash":
    case "diff":
      break;
  }
  return r;
}

const DEFINERS = new Set(["fn", "func", "def", "function"]);

class CodeScanner {
  private readonly out: SpanBuilder;
  private i = 0;
  /** The identifier before this token, past whitespace: a definer makes the next name a function's. */
  private previousWord = "";

  constructor(
    private readonly s: string[],
    private readonly language: CodeLanguage,
    private readonly rules: Rules,
  ) {
    this.out = new SpanBuilder(s);
  }

  run(): CodeSpan[] {
    const { s, rules, language, out } = this;
    while (this.i < s.length) {
      const start = this.i;
      const c = s[start]!;
      let word: string | null = null;
      let end: number | null;
      if (language === "yaml" && (end = this.yamlKeyEnd()) !== null) {
        out.add(start, end, "function");
        this.i = end;
      } else if ((end = this.commentEnd()) !== null) {
        out.add(start, end, "comment");
        this.i = end;
      } else if ((end = this.stringEnd()) !== null) {
        // A JSON key (a string before its colon) in the function colour, as omp draws it.
        out.add(start, end, language === "json" && this.nextNonSpace(end) === ":" ? "function" : "string");
        this.i = end;
      } else if (isDigit(c) && !(start > 0 && (isIdentifierPart(s[start - 1]!) || s[start - 1] === "$"))) {
        this.i = numberEnd(s, start);
        out.add(start, this.i, "number");
      } else if (isIdentifierStart(c) || (rules.dollarIdentifiers && c === "$")) {
        this.i++;
        while (this.i < s.length && (isIdentifierPart(s[this.i]!) || (rules.dollarIdentifiers && s[this.i] === "$"))) {
          this.i++;
        }
        const name = s.slice(start, this.i).join("");
        out.add(start, this.i, this.identifierKind(name, start, this.i));
        word = name;
      } else if (rules.atAttributes && c === "@" && start + 1 < s.length && isIdentifierStart(s[start + 1]!)) {
        this.i++;
        while (this.i < s.length && (isIdentifierPart(s[this.i]!) || s[this.i] === ".")) this.i++;
        out.add(start, this.i, "keyword");
      } else if (rules.hashDirectives && c === "#" && start + 1 < s.length && isAsciiLetter(s[start + 1]!)) {
        this.i++;
        while (this.i < s.length && isIdentifierPart(s[this.i]!)) this.i++;
        out.add(start, this.i, "keyword");
      } else if (language === "yaml" && c === "~" && this.isStandaloneYamlNull(start)) {
        this.i++;
        out.add(start, this.i, "keyword");
      } else {
        this.i++;
        // JSON and YAML punctuation stays plain: `-` in `dark-tokyo-night` is text.
        const plainPunctuation = language === "json" || language === "yaml";
        out.add(start, this.i, !plainPunctuation && OPERATORS.has(c) ? "op" : null);
      }
      if (word !== null) {
        this.previousWord = word;
      } else if (!isSpace(c) && c !== "\n") {
        this.previousWord = "";
      }
    }
    return out.finish();
  }

  private commentEnd(): number | null {
    const { s, i, rules } = this;
    for (const prefix of rules.lineComments) {
      if (!matches(s, prefix, i)) continue;
      // YAML's `#` starts a comment only at a word's start (`a#b` is a value).
      if (this.language === "yaml" && i > 0 && !isSpace(s[i - 1]!) && s[i - 1] !== "\n") continue;
      return lineEnd(s, i);
    }
    const block = rules.blockComment;
    if (block && matches(s, block.open, i)) {
      for (let j = i + block.open.length; j < s.length; j++) {
        if (matches(s, block.close, j)) return j + block.close.length;
      }
      return s.length;
    }
    return null;
  }

  private stringEnd(): number | null {
    const { s, i, rules } = this;
    for (const triple of rules.tripleQuotes) {
      if (!matches(s, triple, i)) continue;
      const width = triple.length;
      let j = i + width;
      while (j < s.length) {
        if (s[j] === "\\") {
          j += 2;
          continue;
        }
        if (matches(s, triple, j)) return j + width;
        j++;
      }
      return s.length;
    }
    const c = s[i]!;
    if (!(rules.quotes.has(c) || (rules.rustChars && c === "'"))) return null;
    if (rules.rustChars && c === "'") {
      // `'x'` and `'\n'` are characters; `'a` (a lifetime) is not a string.
      if (i + 2 < s.length && s[i + 1] !== "\\" && s[i + 2] === "'") return i + 3;
      if (i + 1 < s.length && s[i + 1] === "\\") {
        let j = i + 2;
        while (j < s.length && j < i + 12 && s[j] !== "'" && s[j] !== "\n") j++;
        if (j < s.length && s[j] === "'") return j + 1;
      }
      return null;
    }
    // An apostrophe inside a word (`don't` in YAML prose) does not open a string.
    if (this.language === "yaml" && c === "'" && i > 0 && isIdentifierPart(s[i - 1]!)) return null;
    return quotedEnd(s, i, c, true, rules.multilineQuotes.has(c));
  }

  private identifierKind(word: string, start: number, end: number): CodeTokenKind | null {
    const { s, rules, language } = this;
    if (rules.keywords.has(word)) return "keyword";
    if (language === "json" || language === "yaml") return null;
    if (DEFINERS.has(this.previousWord)) return "function";
    const next = this.nextNonSpace(end);
    if (next === "(") return "function";
    // Rust macros: `println!(`, `vec![`.
    if (language === "rust" && next === "!") {
      const after = this.nextNonSpace(this.indexOfNextNonSpace(end) + 1);
      if (after === "(" || after === "[" || after === "{") return "function";
    }
    // Swift trailing closures on a method: `rows.first { … }`.
    if (language === "swift" && next === "{" && start > 0 && s[start - 1] === ".") return "function";
    if (rules.types.has(word)) return "type";
    if (rules.capitalisedTypes && isUppercaseLetter(s[start]!)) return "type";
    return null;
  }

  private indexOfNextNonSpace(index: number): number {
    let j = index;
    while (j < this.s.length && isSpace(this.s[j]!)) j++;
    return j;
  }

  private nextNonSpace(index: number): string | null {
    const j = this.indexOfNextNonSpace(index);
    return j < this.s.length ? this.s[j]! : null;
  }

  /** A YAML key: at a line's start (after indentation and list dashes), text up to a colon that ends the line or precedes a space. */
  private yamlKeyEnd(): number | null {
    const { s, i } = this;
    const c = s[i]!;
    if (c === "#" || c === "-" || isSpace(c) || c === "\n") return null;
    let j = i - 1;
    while (j >= 0 && (isSpace(s[j]!) || s[j] === "-")) j--;
    if (!(j < 0 || s[j] === "\n")) return null;
    for (let k = i; k < s.length && s[k] !== "\n" && s[k] !== "#"; k++) {
      if (s[k] === ":" && (k + 1 === s.length || isSpace(s[k + 1]!) || s[k + 1] === "\n")) {
        return k > i ? k : null;
      }
      if (s[k] === '"' || s[k] === "'" || s[k] === "{" || s[k] === "[") return null;
    }
    return null;
  }

  private isStandaloneYamlNull(index: number): boolean {
    const { s } = this;
    const before = index === 0 || isSpace(s[index - 1]!) || s[index - 1] === "\n";
    const after = index + 1 === s.length || isSpace(s[index + 1]!) || s[index + 1] === "\n";
    return before && after;
  }
}

// MARK: - Bash

const BASH_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "case", "esac", "for", "while", "until", "do", "done", "in",
  "function", "select", "time", "return", "local", "export", "declare", "readonly", "unset",
  "break", "continue", "exit",
]);
/** Ends a word. */
const BASH_BREAKS = new Set([" ", "\t", "\n", ";", "|", "&", "(", ")", "<", ">", '"', "'", "`", "$", "{", "}"]);
/** `$@`, `$?`, `$$`: the shell's one-character parameters. */
const BASH_SPECIAL_PARAMETERS = new Set(["@", "*", "#", "?", "$", "!", "-"]);
const BASH_BLOCK_ENDS = new Set(["fi", "done", "esac", "in"]);

/** Shell: a command's first word is a function, shell words are keywords, `$NAME`/`${…}` are types. */
class BashScanner {
  private readonly out: SpanBuilder;
  private i = 0;
  /** The next word starts a command. */
  private commandStart = true;

  constructor(private readonly s: string[]) {
    this.out = new SpanBuilder(s);
  }

  run(): CodeSpan[] {
    const { s, out } = this;
    while (this.i < s.length) {
      const start = this.i;
      const c = s[start]!;
      switch (c) {
        case " ":
        case "\t":
          this.i++;
          out.add(start, this.i, null);
          break;
        case "\n":
        case ";":
        case "|":
        case "&":
        case "(":
        case "{":
        case "`":
          this.i++;
          out.add(start, this.i, c === ";" || c === "|" || c === "&" ? "op" : null);
          this.commandStart = true;
          break;
        case ")":
        case "}":
        case "<":
        case ">":
          this.i++;
          out.add(start, this.i, c === "<" || c === ">" ? "op" : null);
          break;
        case '"':
          this.i = quotedEnd(s, start, '"', true, true);
          out.add(start, this.i, "string");
          this.commandStart = false;
          break;
        case "'":
          this.i = quotedEnd(s, start, "'", false, true);
          out.add(start, this.i, "string");
          this.commandStart = false;
          break;
        case "$":
          this.variable();
          break;
        default:
          if (c === "#" && (start === 0 || BASH_BREAKS.has(s[start - 1]!))) {
            this.i = lineEnd(s, start);
            out.add(start, this.i, "comment");
          } else {
            this.word();
          }
      }
    }
    return out.finish();
  }

  private variable(): void {
    const { s, out } = this;
    const start = this.i;
    this.i++;
    if (this.i >= s.length) return out.add(start, this.i, null);
    if (s[this.i] === "(") {
      // `$(…)`: a command inside.
      this.i++;
      out.add(start, this.i, "op");
      this.commandStart = true;
      return;
    }
    const c = s[this.i]!;
    if (c === "{") {
      while (this.i < s.length && s[this.i] !== "}" && s[this.i] !== "\n") this.i++;
      if (this.i < s.length && s[this.i] === "}") this.i++;
    } else if (isIdentifierStart(c)) {
      while (this.i < s.length && isIdentifierPart(s[this.i]!)) this.i++;
    } else if (isDigit(c) || BASH_SPECIAL_PARAMETERS.has(c)) {
      this.i++;
    }
    out.add(start, this.i, this.i > start + 1 ? "type" : null);
    this.commandStart = false;
  }

  private word(): void {
    const { s, out } = this;
    const start = this.i;
    while (this.i < s.length && !BASH_BREAKS.has(s[this.i]!)) this.i++;
    if (this.i === start) this.i++;
    const word = s.slice(start, this.i).join("");
    if (BASH_KEYWORDS.has(word) && (this.commandStart || word === "in")) {
      out.add(start, this.i, "keyword");
      this.commandStart = !BASH_BLOCK_ENDS.has(word);
      return;
    }
    if (this.commandStart) {
      if (word.indexOf("=") > 0) {
        // `NAME=value cmd`: an assignment, the command comes after it.
        out.add(start, this.i, null);
        return;
      }
      this.commandStart = false;
      out.add(start, this.i, /^[[\]]+$/.test(word) ? "op" : "function");
      return;
    }
    out.add(start, this.i, /^[0-9]+$/.test(word) ? "number" : null);
  }
}

// MARK: - Diff

/** A unified diff, line by line: added and removed lines, hunk headers, file headers. */
function diffSpans(s: string[]): CodeSpan[] {
  const out = new SpanBuilder(s);
  let i = 0;
  while (i < s.length) {
    const end = lineEnd(s, i);
    let kind: CodeTokenKind | null;
    if (matches(s, "+++", i) || matches(s, "---", i)) kind = "keyword";
    else if (matches(s, "@@", i)) kind = "function";
    else if (matches(s, "diff ", i) || matches(s, "index ", i)) kind = "comment";
    else if (i < end && s[i] === "+") kind = "inserted";
    else if (i < end && s[i] === "-") kind = "deleted";
    else kind = null;
    out.add(i, end, kind);
    if (end < s.length) out.add(end, end + 1, null);
    i = end + 1;
  }
  return out.finish();
}
