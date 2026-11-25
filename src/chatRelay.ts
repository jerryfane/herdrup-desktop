// A message the Inbox handed to a topic, or a topic to the Inbox (herdr agent.transcript kind
// "relay": topics-gaps-20261125 HANDOVER-FORMAT.md; iOS ChatRelayView): drawn as the agent's text,
// on the left with no card or colour, under a small muted "From Inbox" / "From topic <title>"
// line, its body folded after about six lines with Show all. The Inbox's chat and a topic's draw
// it alike (interaction.ts renderEntry, lent to topics as TopicsHost.renderRow). An older herdr
// sends the same message as a "user" entry, drawn as the owner's bubble as before.
import type { Entry } from "./interactionModel";

/** "From Inbox", "From topic Trip": who handed the message over (iOS TranscriptRelay.label).
 *  `direction` is "to_topic" (the Inbox sent it, `from` "Inbox") or "to_inbox" (a topic sent it,
 *  `from` its title). */
export function relayLabel(entry: Pick<Entry, "from" | "direction">): string {
 const from = typeof entry.from === "string" ? entry.from.trim() : "";
 const name = from || (entry.direction === "to_topic" ? "Inbox" : "a topic");
 return entry.direction === "to_inbox" ? `From topic ${name}` : `From ${name}`;
}

/** The relays the reader unfolded, by entry id: a chat redraws its rows on each read, and an
 *  unfolded one stays so. */
const unfolded = new Set<string>();

/** The relay's row: its label, then body (the caller's markdown of entry.text) folded to about six
 *  lines (interaction.css .chat-relay-body[data-folded]). Show all appears once the folded body
 *  is seen to hold more (measured as it lays out); Show less folds it again. */
export function relayRow(entry: Entry, body: HTMLElement): HTMLElement {
 const row = document.createElement("article"); row.className = "chat-message relay";
 const label = document.createElement("span"); label.className = "chat-relay-from"; label.textContent = relayLabel(entry);
 const text = document.createElement("div"); text.className = "chat-relay-body"; text.append(body);
 const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "chat-relay-toggle button-plain button-compact";
 const draw = () => {
  const open = unfolded.has(entry.id);
  text.dataset.folded = String(!open);
  toggle.textContent = open ? "Show less" : "Show all";
  toggle.setAttribute("aria-expanded", String(open));
 };
 // Only a relay that folds offers the toggle: one the reader opened did, and a folded one does
 // when its body runs past the fold.
 toggle.hidden = !unfolded.has(entry.id);
 toggle.onclick = () => {
  if (unfolded.has(entry.id)) unfolded.delete(entry.id); else unfolded.add(entry.id);
  draw();
 };
 draw();
 const measure = new ResizeObserver(() => {
  if (!text.isConnected) { measure.disconnect(); return; }
  if (text.dataset.folded === "true") toggle.hidden = text.scrollHeight <= text.clientHeight + 1;
 });
 measure.observe(text);
 row.append(label, text, toggle);
 return row;
}
