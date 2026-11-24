// An owner link's agents an agent.start acknowledged (desk_create.go's `created`, kept past the
// sheet): they open and run before the roster lists them, never shown on the board before.
//
// One started agent is provisional from its acknowledgement (unless the roster had its pane during
// the attempt's watch: then the roster's listing, or its later absence, decides) until the first
// list that has its pane, or herdr says its pane or agent is gone (refused). Either ends it: from
// then the roster decides, as for any agent. Anything else (a roster lagging the start, a timeout,
// server_unavailable, a transport error) leaves it provisional.
//
// A creation watches the roster from before its split (watch) until its attempt settles: started
// with the agent herdr acknowledged, or end without one. The panes a watch saw go with it.

import type { AgentInfo } from "./board";

/** One creation's watch of the roster, from before its split until its attempt settles. */
export interface StartWatch {
 /** herdr acknowledged agent: provisional, unless the roster had its pane during the watch. */
 started(agent: AgentInfo): void;
 /** The attempt settled without an acknowledged start. */
 end(): void;
}

/** One owner link's provisional started agents. */
export class StartedAgents {
 /** Provisional agents by pane. */
 readonly #agents = new Map<string, AgentInfo>();
 /** The panes each open watch saw listed. */
 readonly #watches = new Set<Set<string>>();

 watch(): StartWatch {
  const seen = new Set<string>();
  this.#watches.add(seen);
  return {
   started: (agent) => {
    this.#watches.delete(seen);
    const pane = agent.pane_id ?? "";
    if (!seen.has(pane)) this.#agents.set(pane, agent);
   },
   end: () => { this.#watches.delete(seen); },
  };
 }

 /** A list that answered: a pane it has is the roster's from now. */
 listed(agents: readonly AgentInfo[]): void {
  for (const agent of agents) {
   const pane = agent.pane_id ?? "";
   for (const seen of this.#watches) seen.add(pane);
   this.#agents.delete(pane);
  }
 }

 /** herdr refused something on pane with code; true when that ended a provisional agent: the code
  *  says the pane or the agent is gone. */
 refused(pane: string, code: string): boolean {
  return (code === "pane_not_found" || code === "agent_not_found") && this.#agents.delete(pane);
 }

 /** The agent while provisional: it opens and runs before the roster has it. */
 get(pane: string): AgentInfo | undefined { return this.#agents.get(pane); }
}
