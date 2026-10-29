// `@name` tagging in the Gram composer, ported from herdrup 9876878:
// - Sources/HerdrKit/GramMention.swift (grammar, completion, resolve, addressing, unaddressed).
// - App/GramView.swift `gramAgents`, `mentionNames`, `sharedNames`, `draftAddress`,
//   `hint(for:)`, `canSend` and the pick-holding `.onChange(of: draft)` (≈L809, 1443, 1507-1660).
//
// Indexes are UTF-16 offsets into the string, the unit of a textarea's selectionStart/End.
//
// The rules:
// - A mention starts with `@` at the start of the text or after whitespace, so
//   `me@vetrina.dev` is never one.
// - A known mention matches a bare agent name case-insensitively and ends at the end of the
//   text or at a character that cannot continue a name (letter, digit, `-`, `_`); a `.` ends a
//   name only when no letter or digit follows it.
// - Only the first known mention addresses the post. A leading one leaves the body with the
//   whitespace and at most one separator after it on its line; a later one stays.

export type TextRange = { start: number; end: number };

const WHITESPACE = /^[\s\u0085]$/u;
const NEWLINE = /^[\n\r\u000B\u000C\u0085\u2028\u2029]$/u;
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;

/** The code point starting at `index` (one or two UTF-16 units), or "" past the end. */
function charAt(text: string, index: number): string {
  const cp = text.codePointAt(index);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

function isWhitespace(ch: string): boolean {
  return WHITESPACE.test(ch);
}

function continuesName(ch: string): boolean {
  return LETTER_OR_DIGIT.test(ch) || ch === "-" || ch === "_";
}

/** Whether a name may end at `index`: the end, or a character that cannot continue one. */
function endsName(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const next = charAt(text, index);
  // Past the end `charAt` is "", which cannot continue a name: a trailing "." ends it.
  if (next === ".") return !continuesName(charAt(text, index + 1));
  return !continuesName(next);
}

/**
 * The `@token` being typed: the run before `cursor` (the end when omitted) back to an `@` at
 * the start of the text or after whitespace. `query` is the token without the `@`.
 * Null when the run holds no such `@` (`me@host`, `a b`).
 */
export function activeQuery(text: string, cursor: number = text.length): (TextRange & { query: string }) | null {
  for (let index = cursor; index > 0; index--) {
    const ch = text.charAt(index - 1);
    if (isWhitespace(ch)) return null;
    if (ch === "@") {
      const at = index - 1;
      if (at !== 0 && !isWhitespace(text.charAt(at - 1))) return null;
      return { start: at, end: cursor, query: text.slice(at + 1, cursor) };
    }
  }
  return null;
}

/** `text` with `range` (an `activeQuery` range) replaced by `@name `. */
export function complete(text: string, range: TextRange, name: string): string {
  return text.slice(0, range.start) + "@" + name + " " + text.slice(range.end);
}

function mentions(text: string, knownNames: readonly string[]): { range: TextRange; name: string }[] {
  const names = knownNames.filter((name) => name !== "");
  if (names.length === 0) return [];
  const found: { range: TextRange; name: string }[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "@" || (index !== 0 && !isWhitespace(text.charAt(index - 1)))) {
      index += 1;
      continue;
    }
    const mentionStart = index;
    const nameStart = mentionStart + 1;
    index = nameStart;
    for (const name of names) {
      const nameEnd = nameStart + name.length;
      if (nameEnd > text.length) continue;
      if (text.slice(nameStart, nameEnd).toLowerCase() !== name.toLowerCase()) continue;
      if (!endsName(text, nameEnd)) continue;
      found.push({ range: { start: mentionStart, end: nameEnd }, name });
      index = nameEnd;
      break;
    }
  }
  return found;
}

/** The ranges of every known mention, in order (the addressing one draws in brand colour). */
export function ranges(text: string, knownNames: readonly string[]): TextRange[] {
  return mentions(text, knownNames).map((m) => m.range);
}

/** What may sit between a leading mention and the message: `, ` `: ` `;x` ` - `. */
function isSeparator(text: string, index: number): boolean {
  const next = index + 1 < text.length ? charAt(text, index + 1) : null;
  switch (text[index]) {
    case "-":
    case "–":
    case "—":
      return next === null || isWhitespace(next);
    case ",":
    case ":":
    case ";":
      return next === null || isWhitespace(next) || LETTER_OR_DIGIT.test(next);
    default:
      return false;
  }
}

/**
 * Who a composed message goes to and what it says. The first known mention gives the
 * recipient, spelled as in `knownNames`; a leading one leaves the body with the space and at
 * most ONE separator after it on its line. No known mention: recipient null (the shared queue)
 * and the text unchanged.
 */
export function resolve(text: string, knownNames: readonly string[]): { recipient: string | null; body: string } {
  const first = mentions(text, knownNames)[0];
  if (!first) return { recipient: null, body: text };
  if (/[^\s\u0085]/u.test(text.slice(0, first.range.start))) return { recipient: first.name, body: text };
  let bodyStart = first.range.end;
  while (bodyStart < text.length && isWhitespace(text.charAt(bodyStart)) && !NEWLINE.test(text.charAt(bodyStart))) {
    bodyStart++;
  }
  // Only a separator on the mention's own line goes: the run above stopped at any newline,
  // and a newline is no separator, so "@vetrina\n- item one" keeps its bullet.
  if (bodyStart < text.length && isSeparator(text, bodyStart)) bodyStart++;
  while (bodyStart < text.length && isWhitespace(text.charAt(bodyStart))) bodyStart++;
  return { recipient: first.name, body: text.slice(bodyStart) };
}

/**
 * The token after a LEADING `@` (only whitespace before it), up to where a name may end:
 * "vetrna" for "@vetrna hi", "" for "@ hi" or "@". Null when the text does not start with `@`.
 */
export function leadingToken(text: string): string | null {
  const at = text.search(/[^\s\u0085]/u);
  if (at < 0 || text[at] !== "@") return null;
  let index = at + 1;
  while (index < text.length && !endsName(text, index)) index += charAt(text, index).length;
  return text.slice(at + 1, index);
}

/** `text` without its leading `@token` and the whitespace around it. */
function droppingLeadingToken(token: string, text: string): string {
  const trimmed = text.replace(/^[\s\u0085]+/u, "");
  return trimmed.slice(1 + token.length).replace(/^[\s\u0085]+/u, "");
}

/** `text` without the mention at `range` and one space next to it. */
function removing(range: TextRange, text: string): string {
  let { start, end } = range;
  if (start > 0 && text[start - 1] === " ") start -= 1;
  else if (end < text.length && text[end] === " ") end += 1;
  return text.slice(0, start) + text.slice(end);
}

/**
 * The draft re-addressed to `name` (the pill sheet's "Write to"): `@name ` at the start, in
 * place of a leading addressing mention and its separator, or of a leading `@token` naming no
 * one. A later mention stays.
 */
export function addressing(text: string, name: string, knownNames: readonly string[]): string {
  const resolved = resolve(text, knownNames);
  let rest = text;
  const token = leadingToken(text);
  if (resolved.recipient !== null && resolved.body !== text) rest = resolved.body;
  else if (token !== null) rest = droppingLeadingToken(token, text);
  return "@" + name + " " + rest;
}

/**
 * The draft sent to the shared queue instead (the pill sheet's "Shared queue"): every mention
 * that would address it goes, with one space next to it, and so does a leading `@token`.
 */
export function unaddressed(text: string, knownNames: readonly string[]): string {
  const rounds = ranges(text, knownNames).length;
  for (let i = 0; i <= rounds; i++) {
    const resolved = resolve(text, knownNames);
    if (resolved.recipient === null) break;
    if (resolved.body !== text) {
      text = resolved.body;
    } else {
      const range = ranges(text, knownNames)[0];
      if (range) text = removing(range, text);
    }
  }
  const token = leadingToken(text);
  if (token !== null) text = droppingLeadingToken(token, text);
  return text;
}

// MARK: - Composer routing (GramView)

/** An agent seen in Gram: `from` is the raw routing name and the reply address. */
export type GramAgent = { from: string; name: string; machine: string | null };

/**
 * The agents that have written in Gram, most recent first, once per `from`. `messages` is the
 * loaded window newest-first; `name` is the bare sender name, `machine` its machine label
 * (herdrup falls back to the local machine's label for a local sender).
 */
export function gramAgents(
  messages: readonly { fromAgent: boolean; from: string; name: string; machine: string | null }[],
  localMachine: string | null = null,
): GramAgent[] {
  const seen = new Set<string>();
  const result: GramAgent[] = [];
  for (const m of messages) {
    if (!m.fromAgent || seen.has(m.from)) continue;
    seen.add(m.from);
    result.push({ from: m.from, name: m.name, machine: m.machine ?? (localMachine || null) });
  }
  return result;
}

/** The bare names an `@` can address: each agent's name once, ignoring case. */
export function mentionNames(agents: readonly GramAgent[]): string[] {
  const seen = new Set<string>();
  return agents
    .map((a) => a.name)
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Bare names (lowercased) that more than one agent in Gram carries. */
export function sharedNames(agents: readonly GramAgent[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const a of agents) {
    const key = a.name.toLowerCase();
    if (seen.has(key)) shared.add(key);
    seen.add(key);
  }
  return shared;
}

export type DraftRoute =
  | { kind: "queue" }
  | { kind: "agent"; agent: GramAgent }
  | { kind: "ambiguous"; name: string }
  | { kind: "unknown"; token: string };

export type DraftAddress = {
  route: DraftRoute;
  /** What is sent (before trimming). */
  body: string;
  /** Whether a leading known mention was taken off the body. */
  leading: boolean;
  /** The addressing mention to draw in brand colour, only when routed to one agent. */
  accent: TextRange | null;
};

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Where the draft goes and what it says. A leading `@token` that names no agent is never
 * quietly sent to the queue (it is held as unknown). The first known mention addresses it:
 * the picked agent if the pick still matches, else the one agent with that name, else
 * ambiguous. No mention at all: the queue.
 */
export function draftAddress(draft: string, agents: readonly GramAgent[], picked: GramAgent | null): DraftAddress {
  const names = mentionNames(agents);
  const resolved = resolve(draft, names);
  const leading = resolved.recipient !== null && resolved.body !== draft;
  const token = leadingToken(draft);
  if (token !== null && !leading) {
    return { route: { kind: "unknown", token }, body: resolved.body, leading: false, accent: null };
  }
  const name = resolved.recipient;
  if (name === null) return { route: { kind: "queue" }, body: resolved.body, leading: false, accent: null };
  let route: DraftRoute;
  if (picked && sameName(picked.name, name)) {
    route = { kind: "agent", agent: picked };
  } else {
    const named = agents.filter((a) => sameName(a.name, name));
    const only = named.length === 1 ? named[0] : undefined;
    route = only ? { kind: "agent", agent: only } : { kind: "ambiguous", name };
  }
  const accent = route.kind === "agent" ? (ranges(draft, names)[0] ?? null) : null;
  return { route, body: resolved.body, leading, accent };
}

/** Why the draft cannot be sent as it stands, or null when it can be routed. */
export function draftHint(route: DraftRoute): string | null {
  switch (route.kind) {
    case "queue":
    case "agent":
      return null;
    case "ambiguous":
      return `Several agents are called ${route.name}: pick one`;
    case "unknown":
      return route.token === "" ? "Pick an agent after @" : `No agent called @${route.token} in Gram`;
  }
}

/**
 * Whether Send may fire (the routing part of herdrup's `canSend`; the UI adds its own busy
 * states). Held while ambiguous or unknown; a bare "@vetrina" needs a file to say something.
 */
export function canSendDraft(address: DraftAddress, hasAttachments: boolean): boolean {
  if (address.route.kind === "ambiguous" || address.route.kind === "unknown") return false;
  return hasAttachments || address.body.trim() !== "";
}

/** The `gram.post` `to`: the agent's full routing name, or null for the shared queue. */
export function draftRecipient(address: DraftAddress): string | null {
  return address.route.kind === "agent" ? address.route.agent.from : null;
}

/** A pick holds only while the draft's addressing mention still names that agent. */
export function pickStillHolds(draft: string, agents: readonly GramAgent[], picked: GramAgent): boolean {
  const named = resolve(draft, mentionNames(agents)).recipient;
  return named !== null && sameName(named, picked.name);
}
