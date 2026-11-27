// The rows under a conversation (ChatView.sessionFooter): the working dots, the recap of the last
// finished turn and the model line. The agent's chat (interaction.ts, its Inbox) and a topic's
// (topicsView.ts TopicChat) each keep one ChatTail, so both draw the same rows from their own
// page; each row is one element kept attached while unchanged, so the dots' animation never
// restarts on a poll.
import { inlineMarkdown } from "./chatMarkdown";
import { modelLine, type TranscriptModel, type TranscriptRecap } from "./interactionModel";

function el(tag: string, cls: string, text?: string): HTMLElement {
 const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node;
}

export class ChatTail {
 private workingRow: HTMLElement | null = null;
 private recapRow: HTMLElement | null = null;
 private modelRow: HTMLElement | null = null;

 /** ChatWorkingDots (ChatWorkingDots.swift) with what the agent does now; null when it doesn't
  *  work (the caller's rule: the Inbox's board status, a topic's state). */
 working(working: boolean, intent: string): HTMLElement | null {
  if (!working) return null;
  const row = this.workingRow ??= el("div", "chat-working");
  if (row.dataset.intent !== intent || !row.firstChild) {
   row.dataset.intent = intent;
   const dots = el("span", "chat-working-dots"); dots.setAttribute("aria-hidden", "true");
   for (let i = 0; i < 3; i++) dots.append(el("span", "chat-working-dot"));
   row.replaceChildren(dots, el("span", "chat-working-text", intent || "Working"));
   row.setAttribute("role", "status"); row.setAttribute("aria-label", intent ? `Working: ${intent}` : "Working");
  }
  return row;
 }

 /** ChatView.recapDivider: omp's recap of its last finished turn under a hairline, shown once the
  *  agent is done (the caller says) and the page has one. Rebuilt only when the recap changes. */
 recap(recap: TranscriptRecap | null | undefined, done: boolean): HTMLElement | null {
  if (!recap?.text || !done) return null;
  const row = this.recapRow ??= el("div", "chat-recap");
  const key = recap.turn_id + "\n" + recap.text;
  if (row.dataset.recap !== key) {
   row.dataset.recap = key;
   const text = inlineMarkdown(recap.text); text.className = "chat-recap-text";
   const rule = el("div", "chat-recap-rule"); rule.setAttribute("aria-hidden", "true");
   row.replaceChildren(rule, text);
  }
  return row;
 }

 /** ChatView.sessionFooter's model line: the harness, model and effort (ChatView.swift
  *  chat-model), null when the page names none. */
 model(model: TranscriptModel | null | undefined, fallbackHarness?: string | null): HTMLElement | null {
  if (!model?.id) return null;
  const { label, accessibilityLabel } = modelLine(model, fallbackHarness);
  const line = this.modelRow ??= el("div", "chat-model");
  if (line.textContent !== label) line.textContent = label;
  line.setAttribute("aria-label", accessibilityLabel);
  return line;
 }

 /** Whether the working dots and the recap are on the page now. */
 shows(): { working: boolean; recap: boolean } {
  return { working: !!this.workingRow?.isConnected, recap: !!this.recapRow?.isConnected };
 }
}

/** Makes container hold exactly nodes, in order, without detaching the ones it already holds:
 *  detaching a row loses its keyboard focus and restarts its animation. */
export function placeRows(container: HTMLElement, nodes: readonly Node[]) {
 const retained = new Set<Node>(nodes);
 for (let child = container.firstChild; child;) {
  const next = child.nextSibling;
  if (!retained.has(child)) child.remove();
  child = next;
 }
 let next = container.firstChild;
 for (const node of nodes) {
  if (node === next) next = next.nextSibling;
  else container.insertBefore(node, next);
 }
}
