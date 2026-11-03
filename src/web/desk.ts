// The browser's guest Desk: the guest paths of the Go Desk the guest screens call (desk_guest.go,
// desk_guest_invite.go, desk_guest_answers.go, desk_interaction.go, desk_interaction_compose.go),
// on webguest's GuestTransport. One browser holds one grant (storage.ts). Method names, arguments,
// results and error texts are Go's; events go out through events.ts as Go broadcasts them.

import { sha256 } from "@noble/hashes/sha2.js";
import type {
 Access as PageAccess, AgentTarget, AgentView, BoardUpdate, ChatAnswerReply, ConnState, Desk as GoDesk, Features, GuestInvitation,
 GuestShareDetails, PaneMenuOptions, PaneStreamFrame, TerminalHistoryPage,
} from "../mygo";
import { GuestError, HerdrAPIError, timedOut } from "../webguest/errors";
import { existingIdentity, IndexedDBIdentityStore, loadIdentity, type IdentityStore } from "../webguest/identity";
import { resolveInvite, type SealedInviteFetch } from "../webguest/invite";
import type { StaticKey } from "../webguest/noise";
import { acceptInvite, GuestTransport, type Access, type Features as TransportFeatures, type WebSocketFactory } from "../webguest/transport";
import { buildBoard, displayName, liveGroup, pathBase, senderFace, type AgentInfo } from "./board";
import { checkTag, ErrUnsupported, GuestClient, untagged } from "./engine";
import { emit } from "./events";
import { setLink, transportLink, type WebLink } from "./link";
import { showMenu, type MenuEntry } from "./menu";
import { IndexedDBGrantStore, localOwnerHint, type GrantStore, type OwnerHint } from "./storage";
import { panePromptAttachments } from "./gram";
import { agentView, setSharedAgents, setView, type GuestView } from "./view";

type DeskFns = typeof GoDesk;

/** desk_guest.go guestStatusPoll. */
export const GUEST_STATUS_POLL_MS = 15_000;
/** What the owner sees the browser as, where Go sends os.Hostname (AcceptGuestInvitation). */
export const BROWSER_DEVICE = "Web browser";
const ERR_SENDING = "a send is running"; // gramstore.ErrSending
const GUEST_FORBIDDEN = "guest_forbidden"; // desk_guest_answers.go guestForbidden
// desk_guest_answers.go guestMenuKeys
const GUEST_MENU_KEYS = ["Escape", "Space", "Left", "Up", "Down", "Right", "Tab", "Enter"];
// desk_interaction_compose.go promptWait
export const PROMPT_WAIT = { timeout_ms: 6000, until: ["working", "idle", "blocked", "done", "unknown"] };
const UNCONFIRMED_CODES = ["timeout", "agent_prompt_unverifiable", "agent_prompt_stalled", "agent_status_unobserved_after_submit", "agent_prompt_unsubmitted"];

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The transport's features as ConnState carries them (Go guest.Features' JSON names). */
export const pageFeatures = (f: TransportFeatures): Features => ({ gram: f.gram, push: f.push, multi_request: f.multiRequest });

// ---- Pure mappings, each Go's ----

/** desk_guest.go guestAvailability. */
export function guestAvailability(error: unknown): string {
 if (!(error instanceof GuestError)) return "";
 return error.kind === "revoked" ? "lost" : error.kind === "host_offline" ? "offline" : error.kind === "rate_limited" ? "reconnecting" : "";
}

/** runGuest's note while the relay refuses: the wait rounded up to whole seconds. */
export function rateLimitedMessage(waitMs: number): string {
 return `The relay is receiving too many connections from this network. Trying again in ${Math.ceil(waitMs / 1000)} s.`;
}

/** engine.GuestAgentList's running flags (methods.go:58-80): guest_running, true when absent. */
export interface GuestList { agents: AgentInfo[]; running: boolean[] }
export function guestList(result: unknown): GuestList {
 const agents = typeof result === "object" && result !== null && "agents" in result && Array.isArray(result.agents) ? result.agents as (AgentInfo & { guest_running?: boolean | null })[] : [];
 return { agents, running: agents.map((a) => a.guest_running == null || a.guest_running) };
}

/** runGuest's listing: the shared agent, by terminal id or pane id, and whether it runs
 *  (availability "paused" otherwise). */
export function sharedListing(list: GuestList, target: string): { agents: AgentInfo[]; availability: string } {
 const i = list.agents.findIndex((a) => a.terminal_id === target || a.pane_id === target);
 if (i < 0) return { agents: [], availability: "paused" };
 return { agents: [list.agents[i]!], availability: list.running[i] ? "" : "paused" };
}

/** submitPanePrompt's receipt (desk_interaction_compose.go:117-159) for an agent prompt: the
 *  delivery herdr reports, or "unconfirmed" for an outcome a resend could duplicate. */
export function promptReceipt(result: { delivery?: string | null } | null, error: unknown): string {
 let delivery = "submitted", note = "";
 if (result?.delivery != null) delivery = result.delivery;
 if (delivery === "written_to_pty") note = "Sent to terminal; agent submission not verified";
 if (error !== null) {
  if (error instanceof HerdrAPIError && !UNCONFIRMED_CODES.includes(error.code)) throw error;
  delivery = "unconfirmed"; note = "Couldn't confirm delivery — check the terminal before sending again.";
 }
 return JSON.stringify(note === "" ? { delivery } : { delivery, note });
}

/** herdrapi.DecodePaneStreamLine and the frame Go re-encodes for TerminalChanged: the frame, or
 *  the error that ends the stream. */
export function paneStreamFrame(line: unknown): PaneStreamFrame {
 if (typeof line !== "object" || line === null || Array.isArray(line)) throw new Error("pane.stream: line is not an object");
 const raw = line as Record<string, unknown>;
 if ("error" in raw) {
  const e = typeof raw.error === "object" && raw.error !== null ? raw.error as Record<string, unknown> : {};
  throw new Error(`pane.stream ended: herdr: ${typeof e.code === "string" ? e.code : ""}: ${typeof e.message === "string" ? e.message : ""}`);
 }
 if (raw.stream !== "pane.bytes") throw new Error(`pane.stream: pane.stream line has stream ${JSON.stringify(typeof raw.stream === "string" ? raw.stream : "")}, want "pane.bytes"`);
 const frame: PaneStreamFrame = { stream: "pane.bytes", frame: String(raw.frame ?? "") as PaneStreamFrame["frame"], seq: Number(raw.seq ?? 0), epoch: Number(raw.epoch ?? 0) };
 if (raw.cols != null) frame.cols = Number(raw.cols);
 if (raw.rows != null) frame.rows = Number(raw.rows);
 if (typeof raw.data_b64 === "string") frame.data_b64 = raw.data_b64;
 if (raw.lagged === true) frame.lagged = true;
 if (typeof raw.history_b64 === "string") frame.history_b64 = raw.history_b64;
 if (typeof raw.history_cursor === "string") frame.history_cursor = raw.history_cursor;
 return frame;
}

/** identity.go Fingerprint: SHA256: and the digest's first 8 bytes in hex, four groups. */
export function fingerprint(publicKey: Uint8Array): string {
 const hex = [...sha256(publicKey).subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
 return "SHA256:" + [0, 4, 8, 12].map((n) => hex.slice(n, n + 4)).join("·");
}

/** A time as Go's encoding/json writes a UTC time.Time (RFC 3339, trailing zero digits dropped). */
export function goTime(date: Date): string {
 return date.toISOString().replace(/\.(\d*?)0*Z$/, (_, digits: string) => digits === "" ? "Z" : `.${digits}Z`);
}

/** The grant as src/mygo.ts's Access, i.e. guest.Access as Go's JSON has it. */
export function pageAccess(a: Access): PageAccess {
 return {
  guestID: a.guestID, guestName: a.guestName, machineLabel: a.machineLabel, ownerName: a.ownerName, agentName: a.agentName, agentTarget: a.agentTarget,
  endpoint: { relay: a.endpoint.relay, hostID: a.endpoint.hostID, hostPublicKey: btoa(String.fromCharCode(...a.endpoint.hostPublicKey)) },
  acceptedAt: goTime(a.acceptedAt),
 };
}

/** paneMenu (desk_agent_actions.go:267-303) for a guest: no share, avatar, mute or close. */
function guestPaneMenu(o: PaneMenuOptions): (MenuEntry & { action?: string })[] {
 return [
  { label: "Copy screen", action: "copy-screen" },
  { label: "Copy recent output", action: "copy-recent" },
  { label: "Copy selection", action: "copy-selection", disabled: !o.hasSelection },
  { label: "", separator: true },
  { label: "Text size", disabled: true },
  { label: "Increase", action: "text-increase" },
  { label: "Decrease", action: "text-decrease" },
  { label: "Reset", action: "text-reset" },
 ];
}

// ---- The Desk ----

export interface DeskEnv {
 identities: IdentityStore;
 grants: GrantStore;
 owner: OwnerHint;
 webSocket?: WebSocketFactory;
 fetchSealed?: SealedInviteFetch;
 now?: () => number;
 /** Opens a link in a new browsing context; window.open outside tests. */
 openWindow?: (url: string) => void;
}

interface Active {
 id: string;
 access: Access;
 transport: GuestTransport;
 link: WebLink;
 client: GuestClient;
 life: AbortController;
 /** link.guestPoll: one pending kick. */
 kick: () => void;
 agents: AgentInfo[];
}

interface MountedView extends GuestView {
 active: Active;
 view: AgentView;
 share: { details: GuestShareDetails };
 life: AbortController;
 sending: boolean;
 terminal: { id: string; life: AbortController; input: Promise<void>; failed: string | null } | null;
}

export function createGuestDesk(env: DeskEnv) {
 const now = env.now ?? Date.now;
 let state: ConnState = { phase: "idle", message: "", machine: "", herdr: "", live: false };
 let board: BoardUpdate | null = null;
 let active: Active | null = null;
 let mounted: MountedView | null = null;
 let accepting = Promise.resolve();

 const setState = (life: AbortSignal | null, s: ConnState) => {
  if (life?.aborted) return;
  state = s;
  emit("stateChanged", s);
 };

 /** desk_guest.go guestIdentity: the saved key once a grant exists, else one made now. */
 async function guestIdentity(): Promise<StaticKey> {
  if (await env.grants.get() !== undefined) return requireIdentity();
  return loadIdentity(env.identities);
 }
 async function requireIdentity(): Promise<StaticKey> {
  const identity = await existingIdentity(env.identities);
  if (identity === null) throw new Error("read the existing guest identity (not replaced): the guest identity is missing from this browser");
  return identity;
 }
 async function identityFingerprint(): Promise<string> {
  const record = await env.identities.get();
  return record === undefined ? "" : fingerprint(record.publicKey);
 }

 function viewOf(token: string): MountedView {
  agentView(token);
  return mounted!;
 }

 /** A request bound to the view's life and the caller's. */
 function within(v: MountedView, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([v.life.signal, signal]) : v.life.signal;
 }

 function unmount() {
  const v = mounted;
  if (!v) return;
  mounted = null;
  v.life.abort(new Error("agent view changed; request was not sent"));
  setView(null);
 }

 function disconnect() {
  unmount();
  if (active) { active.life.abort(); active.transport.close(); }
  active = null;
  board = null;
  setSharedAgents([]);
  setLink(null);
 }

 /** desk_guest.go runGuest. */
 async function runGuest(l: Active, print: string) {
  const signal = l.life.signal;
  const publish = (phase: string, msg: string, availability: string) =>
   setState(signal, { phase, message: msg, machine: l.access.machineLabel, herdr: "", live: false, guest: { access: pageAccess(l.access), features: pageFeatures(l.transport.features), fingerprint: print, ...(availability !== "" ? { availability } : {}) } });
  publish("connecting", "", "");
  let listed = false;
  let kicked = false;
  let wake: (() => void) | null = null;
  l.kick = () => { if (wake) wake(); else kicked = true; };
  while (!signal.aborted) {
   let wait = GUEST_STATUS_POLL_MS;
   let result: GuestList | null = null, failure: unknown = null;
   try { result = guestList(await l.client.call("agent.list", {}, "agent_list", "", signal)); } catch (error) { failure = error; }
   if (signal.aborted) return;
   if (failure instanceof GuestError && failure.kind === "rate_limited") {
    wait = Math.max(wait, (l.transport.rateLimitedUntil() ?? 0) - now());
    publish(listed ? "connected" : "connecting", rateLimitedMessage(wait), "reconnecting");
   } else if (failure !== null) {
    publish("error", message(failure), guestAvailability(failure));
    if (failure instanceof GuestError && failure.kind === "revoked") return;
   } else {
    listed = true;
    const { agents, availability } = sharedListing(result!, l.access.agentTarget);
    publish("connected", "", availability);
    if (signal.aborted || active !== l) return;
    l.agents = agents;
    setSharedAgents(agents.map((a) => ({ pane_id: a.pane_id ?? "", name: a.name ?? null })));
    if (agents.length > 0) l.access = { ...l.access, agentName: displayName(agents[0]!) };
    board = { board: buildBoard(agents), listedAt: goTime(new Date(now())).replace(/\.\d+Z$/, "Z"), session: "", machineID: l.id };
    emit("boardChanged", board);
   }
   if (kicked) { kicked = false; continue; }
   await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); wake = null; resolve(); };
    const timer = setTimeout(done, wait);
    wake = done;
    signal.addEventListener("abort", done, { once: true });
   });
  }
 }

 const desk = {
  // ---- Invite and session (desk_guest.go) ----

  async state(): Promise<ConnState> { return state; },
  async board(): Promise<BoardUpdate | null> { return board; },

  async inspectGuestInvitation(text: string): Promise<GuestInvitation> {
   const invite = await resolveInvite(text, { now: now(), fetchSealed: env.fetchSealed });
   await guestIdentity();
   return { machineLabel: invite.machineLabel, ownerName: invite.ownerName, agentName: invite.agentName, guestName: invite.guestName, expires: goTime(invite.expires), fingerprint: await identityFingerprint() };
  },

  async sharedConnections(): Promise<PageAccess[]> {
   const grant = await env.grants.get();
   return grant === undefined ? [] : [pageAccess(grant)];
  },

  acceptGuestInvitation(text: string): Promise<PageAccess> {
   // guestAcceptMu: one redemption at a time.
   const run = accepting.then(async () => {
    const invite = await resolveInvite(text, { now: now(), fetchSealed: env.fetchSealed });
    const identity = await guestIdentity();
    const access = await acceptInvite(invite, identity, BROWSER_DEVICE, { now: now(), webSocket: env.webSocket });
    // A successful redemption is irrevocable: saved even if the page moved on meanwhile.
    try {
     await env.grants.put(access);
    } catch (error) {
     throw new Error(`Access was accepted but could not be saved: ${message(error)}. Keep this device's guest identity and ask the owner for a new invitation`);
    }
    env.owner.set(access.ownerName);
    return pageAccess(access);
   });
   accepting = run.then(() => undefined, () => undefined);
   return run;
  },

  async connectGuest(id: string): Promise<void> {
   const grant = await env.grants.get();
   if (grant === undefined || `${grant.endpoint.hostID}/${grant.guestID}` !== id) throw new Error("This shared connection is no longer saved");
   const identity = await requireIdentity();
   const print = await identityFingerprint();
   disconnect();
   const transport = new GuestTransport(grant, identity, { now, webSocket: env.webSocket });
   const link = transportLink(pageAccess(grant), transport);
   const l: Active = { id: "guest:" + id, access: grant, transport, link, client: new GuestClient(link), life: new AbortController(), kick: () => {}, agents: [] };
   active = l;
   setLink(link);
   void runGuest(l, print).finally(() => transport.close());
  },

  async forgetGuestConnection(id: string): Promise<void> {
   const grant = await env.grants.get();
   if (grant !== undefined && `${grant.endpoint.hostID}/${grant.guestID}` === id) {
    env.owner.set(grant.ownerName);
    await env.grants.remove();
   }
   if (active?.id === "guest:" + id) {
    disconnect();
    setState(null, { phase: "idle", message: "", machine: "", herdr: "", live: false });
   }
  },

  async takeGuestInvitation(): Promise<string> { return ""; },
  async hasGuestInvitationClipboardText(): Promise<boolean> { return false; },
  async machine() { return null; },
  async machines() { return []; },
  async pendingAgent() { return null; },
  async paneMuted(): Promise<boolean> { return false; },

  // ---- Agent view (desk_interaction.go) ----

  async openAgentView(target: AgentTarget, token: string): Promise<AgentView> {
   if (token === "" || token.length > 128) throw new Error("invalid view token");
   const l = active;
   if (!l || l.id !== target.machineID || (target.session !== "" && target.session !== "default")) throw new Error("agent belongs to another connection or session");
   const agent = l.agents.find((a) => a.pane_id === target.paneID);
   if (!agent) throw new Error("agent is no longer on this board");
   const name = displayName(agent), harness = agent.agent ?? "";
   const parts = [name];
   if (harness !== "" && harness !== name) parts.push(harness);
   if (agent.cwd != null) {
    const folder = pathBase(agent.cwd);
    if (folder !== "" && folder !== "/" && folder !== "." && !parts.includes(folder)) parts.push(folder);
   }
   const group = liveGroup(agent);
   const view: AgentView = {
    token, paneID: agent.pane_id ?? "", name, harness, heading: parts.join(" · "), group: group.key, status: group.label,
    ...(agent.status_since_unix_ms != null ? { statusSinceUnixMs: agent.status_since_unix_ms } : {}),
    guest: true, guestGram: l.transport.features.gram, ...(l.access.ownerName !== "" ? { guestOwner: l.access.ownerName } : {}), plainTerminal: false,
   };
   unmount();
   const life = new AbortController();
   const v: MountedView = { token, paneID: view.paneID, signal: life.signal, active: l, view, share: { details: shareDetails(agent, name, state.machine) }, life, sending: false, terminal: null };
   l.life.signal.addEventListener("abort", () => life.abort(), { once: true });
   mounted = v;
   setView(v);
   return view;
  },

  async closeAgentView(token: string): Promise<void> {
   if (mounted?.token === token) unmount();
  },

  async guestShareDetails(token: string): Promise<GuestShareDetails> { return viewOf(token).share.details; },

  async guestChatAvailable(token: string): Promise<boolean> {
   const v = viewOf(token);
   const pong = await v.active.client.ping(within(v));
   return pong.capabilities?.agent_transcript === true;
  },

  // ---- Chat (desk_interaction.go, desk_guest_answers.go) ----

  async chatTranscript(token: string, after: string, before: string, subagent: string): Promise<string> {
   const v = viewOf(token);
   const params: Record<string, string> = { target: v.paneID };
   if (after !== "") params.after = after;
   if (before !== "") params.before = before;
   if (subagent !== "") params.subagent = subagent;
   const page = await v.active.client.call("agent.transcript", params, "agent_transcript", "agent_transcript", within(v));
   viewOf(token);
   return JSON.stringify(untagged(page));
  },

  async chatPrompt(token: string, text: string): Promise<string> {
   const v = viewOf(token);
   if (v.sending) throw new Error(ERR_SENDING);
   v.sending = true;
   try {
    const submit = async (prompt: string) => {
     let result: { delivery?: string | null } | null = null, failure: unknown = null;
     try { result = await v.active.client.call("agent.prompt", { target: v.paneID, text: prompt, wait: PROMPT_WAIT }, "agent_prompted", "", within(v)); } catch (error) { failure = error; }
     return promptReceipt(result, failure);
    };
    const withFiles = panePromptAttachments(token, text, submit);
    if (withFiles !== null) return await withFiles;
    if (text.trim() === "") throw new Error("prompt is empty");
    return await submit(text);
   } finally {
    v.sending = false;
    v.active.kick();
   }
  },

  async chatAnswer(token: string, askID: string, option: string): Promise<ChatAnswerReply> {
   const v = viewOf(token);
   try {
    // guest.Transport.AgentAnswer: straight to the relay, past the capability gate (answers.go).
    const result = await v.active.link.call<{ status?: ChatAnswerReply["status"] } | null>("agent.answer", { target: v.paneID, ask_id: askID, option }, within(v));
    return result?.status ? { status: result.status } : {};
   } catch (error) {
    if (error instanceof HerdrAPIError) {
     const reply: ChatAnswerReply = {};
     if (error.code !== "") reply.code = error.code;
     if (error.apiMessage !== "") reply.message = error.apiMessage;
     if (error.code === GUEST_FORBIDDEN) reply.ownerAnswers = true;
     return reply;
    }
    throw error;
   } finally {
    v.active.kick();
   }
  },

  async guestMenuKey(token: string, key: string): Promise<void> {
   const v = viewOf(token);
   if (!GUEST_MENU_KEYS.includes(key)) throw new Error(`${JSON.stringify(key)} is not a menu key`);
   try {
    await v.active.link.call("pane.send_keys", { pane_id: v.paneID, keys: [key] }, within(v));
   } catch (error) {
    if (!(error instanceof HerdrAPIError && error.code === GUEST_FORBIDDEN)) throw error;
   } finally {
    v.active.kick();
   }
  },

  async chatMenu(id: string, offersMarkdown: boolean): Promise<void> {
   const labels = ["Copy", ...(offersMarkdown ? ["Copy as Markdown"] : []), "Select Text"];
   const item = await showMenu(labels.map((label) => ({ label })));
   if (item !== null) emit("chatMenu", { id, item });
  },

  async paneMenu(o: PaneMenuOptions): Promise<boolean> {
   if (!active || o.paneID === "") return false;
   const entries = guestPaneMenu(o);
   void showMenu(entries).then((label) => {
    const action = entries.find((e) => e.label === label)?.action;
    if (action) emit("paneActionChosen", { paneID: o.paneID, action });
   });
   return true;
  },

  async gramMenu(id: string, items: string[]): Promise<boolean> {
   if (items.length === 0) return false;
   void showMenu(items.map((label) => ({ label }))).then((item) => { if (item !== null) emit("gramMenu", { id, item }); });
   return true;
  },

  async gramSenderAvatar(name: string) { return senderFace(name, active?.agents ?? []); },
  async avatarImage(): Promise<string> { throw new Error("not connected"); },

  // ---- Terminal, read-only (desk_interaction.go) ----

  async startTerminal(token: string, streamID: string): Promise<void> {
   if (streamID === "" || streamID.length > 128) throw new Error("invalid terminal identity");
   const v = viewOf(token);
   if (v.terminal) {
    if (v.terminal.id === streamID) return;
    throw new Error("another terminal surface is already open");
   }
   const life = new AbortController();
   v.life.signal.addEventListener("abort", () => life.abort(), { once: true });
   const terminal = { id: streamID, life, input: Promise.resolve(), failed: null };
   v.terminal = terminal;
   let lines: AsyncIterator<unknown>;
   try {
    lines = v.active.link.stream("pane.stream", { pane_id: v.paneID, scrollback_lines: 1000, viewer_id: streamID }, life.signal)[Symbol.asyncIterator]();
    const ack = await lines.next();
    if (ack.done) throw new Error("pane.stream: ended before its acknowledgement");
    const value = ack.value;
    if (typeof value === "object" && value !== null && "error" in value && value.error != null) {
     const e = value.error as { code?: string; message?: string };
     throw v.active.client.mapError("pane.stream", new Error(`pane.stream: herdr: ${e.code ?? ""}: ${e.message ?? ""}`));
    }
    checkTag("pane.stream", typeof value === "object" && value !== null && "result" in value ? value.result : null, "stream_started");
   } catch (error) {
    if (v.terminal === terminal) v.terminal = null;
    life.abort();
    throw error;
   }
   void (async () => {
    for (;;) {
     let event: { frame?: PaneStreamFrame; error?: string };
     try {
      const next = await lines.next();
      if (life.signal.aborted) return;
      event = next.done ? { error: "EOF" } : { frame: paneStreamFrame(next.value) };
     } catch (error) {
      if (life.signal.aborted) return;
      event = { error: message(error) };
     }
     emit("terminalChanged", { token, streamID, ...event });
     if (event.error !== undefined) { life.abort(); void lines.return?.(); return; }
    }
   })();
  },

  async stopTerminal(token: string, streamID: string): Promise<void> {
   const v = mounted;
   if (!v || v.token !== token || v.terminal?.id !== streamID) return;
   v.terminal.life.abort();
   v.terminal = null;
  },

  /** TerminalInput through engine.PaneInput's fallback, pane.send_text in 8 KiB pieces: a guest
   *  transport has no duplex input stream. herdr's guest gate refuses it; the first failure ends
   *  input for the surface, as PaneInput.failed does. */
  async terminalInput(token: string, streamID: string, text: string): Promise<void> {
   const v = viewOf(token);
   if (new TextEncoder().encode(text).length > 256 * 1024) throw new Error("paste exceeds 256 KiB; paste smaller sections");
   const terminal = v.terminal?.id === streamID ? v.terminal : null;
   if (!terminal) throw new Error("terminal input is not connected");
   const send = terminal.input.then(async () => {
    if (terminal.failed !== null) throw new Error(terminal.failed);
    const timeout = AbortSignal.timeout(30_000);
    for (let rest = text; rest.length > 0;) {
     let n = Math.min(rest.length, 8 * 1024);
     if (n < rest.length && rest.charCodeAt(n) >= 0xdc00 && rest.charCodeAt(n) <= 0xdfff) n--;
     const part = rest.slice(0, n);
     rest = rest.slice(n);
     try {
      await v.active.link.call("pane.send_text", { pane_id: v.paneID, text: part }, AbortSignal.any([terminal.life.signal, timeout]));
     } catch (error) {
      terminal.failed = `input delivery uncertain; not resent: ${message(timeout.aborted ? timedOut() : error)}`;
      throw new Error(terminal.failed);
     }
    }
   });
   terminal.input = send.catch(() => undefined);
   return send;
  },

  async terminalSize(token: string, streamID: string, cols: number, rows: number): Promise<void> {
   const v = viewOf(token);
   if (cols < 2 || cols > 1000 || rows < 1 || rows > 500) throw new Error("invalid terminal size");
   const terminal = v.terminal?.id === streamID ? v.terminal : null;
   if (!terminal) throw new Error("terminal surface changed");
   await v.active.client.call("pane.set_pty_size", { pane_id: v.paneID, cols, rows, lock: true, viewer_id: streamID }, "pane_pty_size", "", terminal.life.signal);
  },

  async terminalHistory(token: string, cursor: string): Promise<TerminalHistoryPage> {
   const v = viewOf(token);
   try {
    const page = await v.active.client.call("pane.history", { pane_id: v.paneID, cursor }, "pane_history", "pane_history", within(v));
    return { page: untagged(page) };
   } catch (error) {
    if (error instanceof HerdrAPIError || error instanceof ErrUnsupported) return { unavailable: error.message };
    throw error;
   }
  },

  async readAgentText(token: string, recent: boolean): Promise<string> {
   const v = viewOf(token);
   const result = await v.active.client.call<{ read?: { text?: string } }>("agent.read", { target: v.paneID, source: recent ? "recent_unwrapped" : "visible", format: "text" }, "pane_read", "", within(v));
   viewOf(token);
   return result.read?.text ?? "";
  },

  // ---- Local only ----

  /** desk_interaction.go OpenExternalURL: http, https and mailto, in a new browsing context
   *  that cannot reach back into this page. */
  async openExternalURL(raw: string): Promise<void> {
   let scheme = "";
   try { scheme = new URL(raw).protocol; } catch { /* not a URL */ }
   if (scheme !== "https:" && scheme !== "http:" && scheme !== "mailto:") throw new Error("unsupported link scheme");
   (env.openWindow ?? ((url) => { window.open(url, "_blank", "noopener,noreferrer"); }))(raw);
  },
 } satisfies Partial<DeskFns>;

 return desk;
}

/** desk_guest_invite.go shareRoute's details. */
function shareDetails(agent: AgentInfo, name: string, hostLabel: string): GuestShareDetails {
 const details = { agentName: name, machineLabel: hostLabel };
 const machine = agent.machine_id ?? "";
 if (machine !== "" && (agent.pane_id ?? "").startsWith(machine + "/")) {
  details.agentName = name.startsWith(machine + "/") ? name.slice(machine.length + 1) : name;
  details.machineLabel = agent.machine_label || machine;
 }
 return details;
}


/** The page's Desk storage: IndexedDB for the key and the grant. */
export function browserEnv(): DeskEnv {
 return {
  identities: new IndexedDBIdentityStore(),
  grants: new IndexedDBGrantStore(),
  owner: localOwnerHint,
 };
}
