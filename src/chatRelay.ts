// A message the Inbox handed to a topic, a topic to the Inbox, or one topic to another (herdr
// agent.transcript kind "relay", herdr #521 { kind, id, ts_ms, from, topic_id?, direction, text },
// asked for with relay_entries where ping advertises transcript_relay_entries; iOS ChatRelayView):
// drawn as the agent's text, on the left with no card or colour, under a small muted "From Inbox" /
// "From topic <title>" line, its body folded after about six lines with Show all. The Inbox's chat
// and a topic's draw it alike (interaction.ts renderEntry, lent to topics as TopicsHost.renderRow).
// An older herdr sends the same message as a "user" or "note" entry, drawn as before.
import type { Entry } from "./interactionModel";

/** "From Inbox", "From topic Trip": who handed the message over. herdr names the sender in `from`
 *  ("Inbox", or the sending topic's title) and gives `topic_id` only when a topic sent it, whichever
 *  way it went (`direction` "to_topic" also covers one topic handing to another). */
export function relayLabel(entry: Pick<Entry, "from" | "topic_id">): string {
 const from = typeof entry.from === "string" ? entry.from.trim() : "";
 const topic = typeof entry.topic_id === "string" && entry.topic_id !== "";
 return topic ? `From topic ${from || "a topic"}` : `From ${from || "Inbox"}`;
}

/** The relay's row: its label, then body (the caller's markdown of entry.text) folded to about six
 *  lines (interaction.css .chat-relay-body[data-folded]). Show all appears once the folded body
 *  is seen to hold more (measured as it lays out); Show less folds it again. unfolded is the
 *  conversation's: the ids of the relays its reader opened, kept as its rows are redrawn. */
export function relayRow(entry: Entry, body: HTMLElement, unfolded: Set<string>): HTMLElement {
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
