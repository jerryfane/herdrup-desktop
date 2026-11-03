// The mounted agent view (desk_interaction.go interaction) and the shared agent as the last list
// gave it (link.agents), for the Desk methods outside desk.ts (gram.ts's composer attachments).

/** The fields of herdr's agent.list agent these readers use (herdrapi.AgentInfo). */
export interface ListedAgent { pane_id: string; name?: string | null }

export interface GuestView {
 token: string;
 paneID: string;
 /** Aborted when the view closes or the connection changes (interaction.ctx). */
 signal: AbortSignal;
}

let view: GuestView | null = null;
let agents: readonly ListedAgent[] = [];
const viewWatchers = new Set<(view: GuestView | null) => void>();

export function currentView(): GuestView | null { return view; }

/** desk_interaction.go agentView: the view token names, while it is current. */
export function agentView(token: string): GuestView {
 if (view === null || view.token !== token || view.signal.aborted) throw new Error("agent view changed; request was not sent");
 return view;
}

/** The shared agent as listed last (none, or just the shared one: desk_guest.go runGuest). */
export function sharedAgents(): readonly ListedAgent[] { return agents; }

export function onViewChanged(f: (view: GuestView | null) => void): () => void {
 viewWatchers.add(f);
 return () => { viewWatchers.delete(f); };
}

/** For desk.ts only. */
export function setView(next: GuestView | null): void {
 if (next === view) return;
 view = next;
 for (const f of [...viewWatchers]) f(next);
}

/** For desk.ts only. */
export function setSharedAgents(next: readonly ListedAgent[]): void { agents = next; }
