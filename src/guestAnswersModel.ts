// Guest answers (herdrup f2df68b, App/ChatView.swift and App/GuestPaneView.swift; herdr #352
// d78b91c src/api/server/guest_gate.rs): a guest answers the shared agent's questions as the owner
// does — the chat's answer buttons and, while the agent waits on a menu, the owner's menu keys —
// unless a host older than guest answers keeps them for the owner.
import type { TranscriptPage } from "./interactionModel";

type PendingAsk = NonNullable<TranscriptPage["pending_ask"]>;

/** Who reads the page (ChatView.swift ChatViewer): the owner, or a guest of `owner`'s agent. */
export type Viewer = { guest: false } | { guest: true; owner: string };

/** The host withheld `answerable` from a question the buttons could answer: a host that keeps
 *  answers for the owner (TranscriptPendingAsk.isWithheldFromCaller, AgentTranscript.swift:322-331).
 *  A multi-part, multi-select or free-text question is never answerable, so it says nothing. */
export function withheldFromCaller(ask: PendingAsk | undefined): boolean {
 if (!ask || ask.answerable || ask.questions.length !== 1) return false;
 const only = ask.questions[0]!;
 return !only.multi && only.options.length > 0;
}

/** The owner a guest who cannot answer waits for, or null (ChatAskCard.waitingForOwner,
 *  ChatView.swift:1755-1758). */
export function waitingForOwner(viewer: Viewer, answersRefused: boolean): string | null {
 return answersRefused && viewer.guest ? viewer.owner : null;
}

/** The options are buttons, for a guest as for the owner (ChatAskCard.canAnswer, ChatView.swift:1810-1812),
 *  for the one single-select question herdr marks answerable. */
export function canAnswer(ask: PendingAsk, waiting: string | null): boolean {
 return waiting === null && ask.answerable && ask.questions.length === 1 && !ask.questions[0]!.multi;
}

/** Who an answer is credited to (ChatAskCard.chooser, ChatView.swift:1801-1808). A guest who may
 *  answer cannot tell whether they, the owner or another device chose, so the answer stands alone. */
export function chooser(viewer: Viewer, waiting: string | null): string {
 if (!viewer.guest) return "You chose ";
 return waiting === null ? "Chosen: " : `${waiting} chose `;
}

/** What a guest's page shows for the agent's question. */
export interface GuestQuestion {
 /** The line above the composer (GuestPaneView.noteRow, GuestPaneView.swift:557-581). */
 banner: string | null;
 /** The owner's menu keys show under the terminal (GuestPaneView.showsMenuKeys, :432). */
 menuKeys: boolean;
 /** The status label in place of the group's (GuestPaneView.statusPill, :411-413). */
 label: string | null;
}

/** A guest's question state. `group` is the agent's board group: a live agent is needsYou exactly
 *  when it is blocked or reports input_pending (herdr.GroupOf), which is herdrup's
 *  AgentInfo.isAwaitingMenuInput (Wire.swift:407) and GuestPaneView.isBlocked (:424-427). */
export function guestQuestion(agent: string, owner: string, group: string, answersRefused: boolean, terminal: boolean): GuestQuestion {
 if (group !== "needsYou") return { banner: null, menuKeys: false, label: null };
 if (answersRefused) return { banner: `${agent} is asking a question only ${owner} can answer`, menuKeys: false, label: `needs ${owner}` };
 return { banner: terminal ? `${agent} is asking a question · answer with the keys below` : `${agent} is asking a question`, menuKeys: terminal, label: null };
}
