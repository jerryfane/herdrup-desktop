// The herdr update card on Settings → Machines (desk_updates.go) for the owner link's machine:
// server.update_check / update_apply / update_status, which herdr serves to an owner's browser
// under a terminal-scope grant only (herdr#510; its ping then says server_update). An update
// belongs to the machine, not to Settings: it is followed until it finishes, through the link's
// reconnects across herdr's handoff, and Settings opened again shows where it is. Every step goes
// to the link the operation began on (ownerCall's link), and a queued one checks its Settings
// scope again when it starts and before it applies: one machine's confirmation never reaches
// another. When the policy changes, it changes in serverUpdatePolicy.ts, for the card too.

import type { Desk as GoDesk } from "../mygo";
import { errorText } from "../errors";
import { updateMissing, updateOffer, type UpdateAttempt, type UpdateCheck, type UpdateState } from "../serverUpdatePolicy";
import { sleep } from "../webguest/abort";
import { HerdrAPIError } from "../webguest/errors";
import { ErrUnsupported } from "./engine";
import { currentOwnerLink, LINK_CHANGED, OWNER_REFUSED, ownerCall, OwnerRefusedError, settingsCall, settingsLink, settingsPing, settingsScope, type OwnerLink, type SettingsScope } from "./ownerLink";

type DeskFns = typeof GoDesk;

/** desk_updates.go serverUpdate: one machine's update, by host id. op serializes refresh and apply. */
interface ServerUpdate { hostID: string; state: UpdateState; targetID: string; targetBuild: string; previousID: string; following: boolean; op: Promise<unknown> }

function serial<T>(u: ServerUpdate, f: () => Promise<T>): Promise<T> {
 const run = u.op.then(f);
 u.op = run.catch(() => undefined);
 return run;
}

/** A queued operation's check, when it starts and before it sends: token's Settings scope is still
 *  open, on link. */
function stillOn(token: string, link: OwnerLink) {
 if (settingsLink(token) !== link) throw new Error(LINK_CHANGED);
}

/** herdr refusing the update methods to this browser (owner_forbidden), at any step: the state's one
 *  refusal (forbidden, code, message). The card hides and Settings says why (settingsUpdates.ts, as
 *  guest_forbidden on the desktop), rather than offering a retry that only an update failure
 *  deserves. */
function refusedToBrowser(s: UpdateState, error: unknown): error is OwnerRefusedError {
 if (!(error instanceof OwnerRefusedError)) return false;
 s.forbidden = true; s.code = "owner_forbidden"; s.message = OWNER_REFUSED;
 return true;
}

/** A status read that herdr answered: the browser is let in again, so that refusal is retired. */
function letIn(s: UpdateState) {
 if (s.code !== "owner_forbidden") return;
 s.forbidden = false; s.code = ""; s.message = "";
}

export interface ServerUpdateDeskOptions {
 /** followUpdate's pause between status reads (1 s), a test's own otherwise. */
 pause?: () => Promise<void>;
}

export function createServerUpdateDesk(options: ServerUpdateDeskOptions = {}) {
 const pause = options.pause ?? (() => sleep(1000));
 const updates = new Map<string, ServerUpdate>();

 function settingsUpdate(token: string): { scope: SettingsScope; link: OwnerLink; u: ServerUpdate } {
  const scope = settingsScope(token), link = scope.link;
  const hostID = link.machine.hostID;
  let u = updates.get(hostID);
  if (u === undefined) {
   u = { hostID, state: { known: false, version: "", flow: "idle", code: "", message: "", restartLater: false, missing: [], forbidden: false }, targetID: "", targetBuild: "", previousID: "", following: false, op: Promise.resolve() };
   updates.set(hostID, u);
  }
  return { scope, link, u };
 }

 /** updateClient: the open link while it is to the update's machine. */
 function linkFor(u: ServerUpdate): OwnerLink | null {
  const link = currentOwnerLink();
  return link !== null && link.machine.hostID === u.hostID && !link.signal.aborted ? link : null;
 }

 const status = (link: OwnerLink, signal?: AbortSignal) =>
  ownerCall<{ attempt?: UpdateAttempt | null }>("server.update_status", {}, "update_status", { capability: "server_update", signal, link });

 /** refreshUpdate (under op), in scope (a Settings page's, or the follower's own: its link and a
  *  deadline): never erases a running attempt; a finished one stays until a newer build than it
  *  installed is offered. */
 async function refreshUpdate(u: ServerUpdate, scope: SettingsScope): Promise<void> {
  const link = scope.link;
  if (currentOwnerLink() !== link) throw new Error(LINK_CHANGED);
  const pong = await settingsPing(scope);
  const s = u.state;
  s.known = true; s.version = pong.version ?? "";
  if (pong.capabilities) s.capabilities = pong.capabilities; else delete s.capabilities;
  if (pong.capabilities?.server_update !== true) return;
  let check: UpdateCheck, a: UpdateAttempt | undefined;
  try {
   check = await settingsCall<UpdateCheck>(scope, "server.update_check", {}, "update_check", { capability: "server_update" });
   a = (await settingsCall<{ attempt?: UpdateAttempt | null }>(scope, "server.update_status", {}, "update_status", { capability: "server_update" })).attempt ?? undefined;
  } catch (error) {
   if (!refusedToBrowser(s, error) && error instanceof HerdrAPIError) { s.forbidden = error.code === "guest_forbidden"; s.code = error.code; s.message = error.apiMessage; }
   throw error;
  }
  letIn(s);
  s.check = check; s.forbidden = false;
  delete s.pending;
  if (a?.outcome === "downloaded_restart_required") s.pending = a;
  // The finished card would otherwise hold the flow, and Apply refuses anything but idle, so the
  // newer offer could never be confirmed.
  const done = s.attempt;
  if (s.flow === "finished" && done && updateOffer(s) && check.latest!.build_id !== done.build_id) {
   s.flow = "idle"; delete s.attempt; s.code = ""; s.message = "";
  }
  if (a && a.outcome == null && s.flow === "idle" && !u.following) {
   s.flow = "running"; s.attempt = a; s.restartLater = !!a.restart_later;
   s.missing = updateMissing(s.capabilities);
   u.targetID = a.attempt_id; u.targetBuild = ""; u.previousID = "";
   u.following = true;
   void follow(u);
  }
 }

 /** followUpdate: reads the status each second on the machine's link until the attempt it follows
  *  finishes, loses track after 120 unanswered reads, and gives up on an apply that never showed
  *  after 10 other answers. */
 async function follow(u: ServerUpdate): Promise<void> {
  let silent = 0, foreign = 0;
  for (;;) {
   let answered = false, other = false, attempt: UpdateAttempt | null = null;
   const on = linkFor(u);
   if (on !== null) {
    try {
     attempt = (await status(on, AbortSignal.timeout(5000))).attempt ?? null;
     other = true;
     letIn(u.state);
    } catch (error) {
     // A refusal is herdr's answer, not silence: the card hides and Settings says why. The
     // accepted update may still finish on the host; with the browser let in again, Look again
     // follows it (lostTrack).
     if (refusedToBrowser(u.state, error)) { u.state.flow = "lostTrack"; u.following = false; return; }
    }
   }
   if (attempt && ((u.targetID !== "" && attempt.attempt_id === u.targetID) || (u.targetID === "" && attempt.build_id === u.targetBuild && attempt.attempt_id !== u.previousID))) {
    answered = true; other = false;
    u.state.attempt = attempt;
    if (attempt.outcome != null) {
     u.state.flow = "finished"; u.following = false;
     // The running build and its capabilities after the handoff, from the machine's link only.
     const link = linkFor(u);
     if (link !== null) await serial(u, () => refreshUpdate(u, { link, signal: AbortSignal.timeout(10_000) })).catch(() => undefined);
     return;
    }
   }
   silent = answered ? 0 : silent + 1;
   if (u.targetID === "" && !u.state.attempt) {
    foreign = other ? foreign + 1 : 0;
    if (foreign >= 10) { u.state.flow = "idle"; u.following = false; return; }
   }
   if (silent >= 120) { u.state.flow = "lostTrack"; u.following = false; return; }
   await pause();
  }
 }

 return {
  async settingsServerUpdate(token: string, refresh: boolean): Promise<string> {
   const { scope, link, u } = settingsUpdate(token);
   if (refresh) await serial(u, async () => { stillOn(token, link); await refreshUpdate(u, scope); });
   settingsLink(token);
   return JSON.stringify(u.state);
  },

  /** ApplySettingsServerUpdate: the exact build and mode the page confirmed, never "the latest",
   *  on the machine it was confirmed for. An apply whose answer is unknown is followed, never sent
   *  again. */
  async applySettingsServerUpdate(token: string, buildID: string, restartLater: boolean): Promise<void> {
   const { scope, link, u } = settingsUpdate(token);
   await serial(u, async () => {
    stillOn(token, link);
    const s = u.state;
    if (s.flow !== "idle" || !updateOffer(s) || s.check!.latest!.build_id !== buildID || (s.check!.mode === "restart_required") !== restartLater) {
     throw new Error("the offered update changed; check it again before confirming");
    }
    let previous: { attempt?: UpdateAttempt | null };
    try { previous = await settingsCall(scope, "server.update_status", {}, "update_status", { capability: "server_update" }); } catch (error) { refusedToBrowser(s, error); throw error; } // no apply was sent
    letIn(s);
    stillOn(token, link);
    s.flow = "running"; delete s.attempt; s.restartLater = restartLater;
    s.code = ""; s.message = "";
    s.missing = updateMissing(s.capabilities);
    u.targetID = ""; u.targetBuild = buildID; u.previousID = previous.attempt?.attempt_id ?? "";
    try {
     // Settings' cancellation reaches the transport: an apply still waiting for the relay to
     // admit it when Settings closes is never sent.
     u.targetID = (await settingsCall<{ attempt_id: string }>(scope, "server.update_apply", { build_id: buildID, restart_later: restartLater }, "update_apply", { capability: "server_update" })).attempt_id;
    } catch (error) {
     if (refusedToBrowser(s, error)) { s.flow = "idle"; throw error; }
     if (error instanceof HerdrAPIError || error instanceof ErrUnsupported) {
      s.flow = "refused"; s.message = errorText(error);
      if (error instanceof HerdrAPIError) { s.code = error.code; s.message = error.apiMessage; }
      else s.code = "update_unsupported_install";
      return;
     }
     // No answer (the transport, or Settings closed while it waited): herdr may have it, so it is
     // followed, never sent again; Settings closing is still the caller's answer.
     u.following = true;
     void follow(u);
     if (scope.signal.aborted) throw error;
     return;
    }
    u.following = true;
    void follow(u);
   });
  },

  /** RecheckSettingsServerUpdate: after a definite failure, check afresh before a new
   *  confirmation; after silence (lookAgain), only follow the same target again. */
  async recheckSettingsServerUpdate(token: string, lookAgain: boolean): Promise<void> {
   const { scope, link, u } = settingsUpdate(token);
   await serial(u, async () => {
    stillOn(token, link);
    const s = u.state;
    if (u.following || s.flow === "running") throw new Error("an update is already being followed");
    if (lookAgain) {
     if (s.flow !== "lostTrack") throw new Error("there is no lost update to follow");
     s.flow = "running"; u.following = true;
     void follow(u);
     return;
    }
    if (s.flow === "lostTrack") throw new Error("look again before starting another update");
    const old = { flow: s.flow, attempt: s.attempt };
    s.flow = "idle"; delete s.attempt;
    try {
     await refreshUpdate(u, scope);
    } catch (error) {
     s.flow = old.flow; if (old.attempt) s.attempt = old.attempt;
     throw error;
    }
    // A refresh may have found an attempt already running.
    if (!u.following) {
     s.flow = "idle"; delete s.attempt; s.code = ""; s.message = "";
     const outcome = old.attempt?.outcome;
     if (old.flow === "finished" && (outcome === "rolled_back" || outcome === "needs_attention")) { s.flow = old.flow; s.attempt = old.attempt; }
    }
   });
  },
 } satisfies Partial<DeskFns>;
}
