// Chat's up arrow above jump-to-latest (turn-origin contract, owner 2026-11-06): it jumps to the
// owner's previous message, one further up per tap, never to a guest's prompt or one herdr marks
// as not the owner's own request (origin "other": gitmoot, a script, another agent). A host
// without turn origins marks nothing, so the arrow then stops at every owner-authored prompt.
import type { Entry } from "./interactionModel";

/** A prompt the owner sent: a user turn that is neither a guest's nor marked `origin: "other"`. */
export function isMine(entry: Entry): boolean {
  return entry.kind === "user" && entry.author !== "guest" && entry.origin !== "other";
}

/** The owner's prompt closest above the view's top edge: the last of `rows` (in transcript
 *  order, each with its top in scroll coordinates) that starts above `viewTop`. A prompt the
 *  previous tap left at the top of the view, or below it, is not above it. */
export function previousMine(rows: { id: string; top: number }[], viewTop: number): string | null {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.top < viewTop - 1) return rows[i]!.id;
  return null;
}
