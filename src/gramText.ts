// Gram message text, ported from herdrup 9876878:
// - `segments`: Sources/HerdrKit/GramText.swift (prose vs fenced ``` code blocks).
// - `summary` / `rowPreview`: App/HerdrApp.swift `GramSidebarConversations.summary` and
//   `preview(of:)` (the sidebar's one-line form).
// - `GRAM_FOLDED_LINE_LIMIT` / `gramTextFolds`: App/GramCards.swift `GramFoldingText`.

/** One piece of a gram's text: prose, or a fenced code block (`language` null when none). */
export type GramTextSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; code: string; language: string | null };

/**
 * Splits a gram's text into prose and fenced ``` code blocks.
 *
 * - A fence is a line that starts (after optional spaces/tabs) with three or more backticks.
 *   What follows is the info string; its first word is the language. An info string holding
 *   a backtick is not a fence (CommonMark).
 * - The block closes on a line of only backticks, at least as many as the opening run.
 * - An opening fence that never closes is prose: it and everything after it read as text.
 * - The newline next to a fence belongs to the fence. Whitespace-only prose is dropped.
 * - CRLF line endings read as LF.
 */
export function segments(text: string): GramTextSegment[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const out: GramTextSegment[] = [];
  let prose: string[] = [];

  const flushProse = () => {
    const joined = prose.join("\n");
    prose = [];
    if (/[^\s\u0085]/u.test(joined)) out.push({ kind: "text", text: joined });
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = openingFence(line);
    if (!fence) {
      prose.push(line);
      index += 1;
      continue;
    }
    let close = -1;
    for (let i = index + 1; i < lines.length; i++) {
      if (closesFence(lines[i]!, fence.ticks)) {
        close = i;
        break;
      }
    }
    if (close < 0) {
      // Unclosed: the rest of the message is prose, fence line included.
      prose.push(...lines.slice(index));
      break;
    }
    flushProse();
    out.push({ kind: "code", code: lines.slice(index + 1, close).join("\n"), language: fence.language });
    index = close + 1;
  }
  flushProse();
  return out;
}

function openingFence(line: string): { ticks: number; language: string | null } | null {
  const body = line.replace(/^[ \t]+/, "");
  const ticks = /^`*/.exec(body)![0].length;
  if (ticks < 3) return null;
  const info = body.slice(ticks);
  if (info.includes("`")) return null;
  const language = info.split(/[\s\u0085]+/u).find((word) => word !== "") ?? null;
  return { ticks, language };
}

function closesFence(line: string, ticks: number): boolean {
  // Swift's `.whitespaces`: horizontal whitespace only (lines hold no newlines anyway).
  const body = line.replace(/^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu, "");
  return body.length >= ticks && /^`+$/.test(body);
}

/**
 * The message as one line of prose (the sidebar preview body): fences dropped with their code
 * kept, runs of whitespace and newlines collapsed to one space. Empty text reads as
 * `fileName` (the attachment preview: its name, or "<name> (expired)"), else "".
 */
export function summary(text: string, fileName: string | null = null): string {
  const pieces = segments(text).map((s) => (s.kind === "text" ? s.text : s.code));
  const flat = pieces
    .join(" ")
    .split(/[\s\u0085]+/u)
    .filter((word) => word !== "")
    .join(" ");
  return flat === "" ? (fileName ?? "") : flat;
}

/** herdrup `GramFile.expiredPreview`: how an expired attachment reads in a preview. */
export function expiredFilePreview(name: string): string {
  return `${name} (expired)`;
}

/** herdrup `GramMessage.agentName(from:)`: the part after the last "/", unless that is empty. */
export function agentName(raw: string): string {
  const slash = raw.lastIndexOf("/");
  if (slash < 0) return raw;
  const name = raw.slice(slash + 1);
  return name === "" ? raw : name;
}

/**
 * The sidebar "Gram" row's preview of a message, as runs so the UI can bold the addressee:
 * "<agent>: <body>" for an agent's message, "You: **<to>** <body>" for the owner's direct post,
 * "You: <body>" for a queue post. `senderName` is the bare agent name; `to` the raw routing name.
 */
export type PreviewRun = { text: string; strong: boolean };

export function rowPreview(message: {
  fromAgent: boolean;
  senderName: string;
  to: string | null;
  text: string;
  fileName: string | null;
}): PreviewRun[] {
  const body = summary(message.text, message.fileName);
  if (message.fromAgent) return [{ text: `${message.senderName}: ${body}`, strong: false }];
  const runs: PreviewRun[] = [{ text: "You: ", strong: false }];
  if (message.to !== null) {
    runs.push({ text: agentName(message.to), strong: true });
    runs.push({ text: " ", strong: false });
  }
  runs.push({ text: body, strong: false });
  return runs;
}

/** A saved copy's preview: the sender (bare name, or "You") then the one-line body. */
export function savedPreview(saved: { fromAgent: boolean; from: string; text: string; fileName: string | null }): string {
  const sender = saved.fromAgent ? agentName(saved.from) : "You";
  return `${sender}: ${summary(saved.text, saved.fileName)}`;
}

/** Prose is shown whole up to this many lines; past it, it folds behind "Read more". */
export const GRAM_FOLDED_LINE_LIMIT = 8;

/**
 * herdrup measures the text twice at the shown width (whole, and clamped to eight lines) and
 * folds when the whole is taller by more than half a point. The UI passes the two measured
 * heights (e.g. the element's scrollHeight unclamped and clamped with `line-clamp: 8`).
 */
export function gramTextFolds(fullHeight: number, foldedHeight: number): boolean {
  return fullHeight > foldedHeight + 0.5;
}

/** The fold toggle's label: "Read more" while folded, "Show less" once open. */
export function foldToggleLabel(expanded: boolean): string {
  return expanded ? "Show less" : "Read more";
}
