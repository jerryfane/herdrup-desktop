// The browser's guest Desk: the guest paths of the Go Desk the guest screens call (desk_guest.go,
// desk_guest_invite.go, desk_guest_answers.go, desk_interaction.go, desk_interaction_compose.go),
// on webguest's GuestTransport. One browser holds one grant (storage.ts). Method names, arguments,
// results and error texts are Go's; events go out through events.ts as Go broadcasts them.

import topicsRetrySeconds from "../../app/topics_retry.json";
import { sha256 } from "@noble/hashes/sha2.js";
import type {
 Access as PageAccess, AgentTarget, AgentView, AskFormValue, AvatarPhoto, BoardUpdate, ChatAnswerFormReply, ChatAnswerReply, ChatDismissReply, ConnState, Desk as GoDesk, Features, GuestChat, GuestConnection, GuestInvitation, GuestMenuKeyReply,
 GuestShareDetails, PaneMenuOptions, PaneStreamFrame, TerminalHistoryPage, TopicSendReply, TopicsUpdate,
} from "../mygo";
import { GuestError, HerdrAPIError, NotSentError, notSent, timedOut } from "../webguest/errors";
import { existingIdentity, IndexedDBIdentityStore, loadIdentity, type IdentityStore } from "../webguest/identity";
import { resolveInvite, shareLabel, type SealedInviteFetch } from "../webguest/invite";
import type { StaticKey } from "../webguest/noise";
import { acceptInvite, type Access, type Features as TransportFeatures, guestLink, GuestTransport, type WebSocketFactory } from "../webguest/transport";
import { fromB64url } from "../webguest/b64url";
import { ownerLink } from "../webguest/owner";
import type { StatementSource } from "../webguest/accountStatement";
import type { EnvelopeMachine } from "../webguest/approve";
import { buildBoard, displayName, isArchived, liveGroup, pathBase, senderFace, type AgentInfo } from "./board";
import { checkTag, ErrUnsupported, GuestClient, ResultTagError, untagged } from "./engine";
import { emit, type PanePlainAction, type PaneSheetAction } from "./events";
import { closeSettings, openSettings, setLink, transportLink, type WebLink } from "./link";
import { showMenu, type MenuEntry } from "./menu";
import { IndexedDBGrantStore, localOwnerHint, machineLists, type GrantStore, type MachineLists, type OwnerHint } from "./storage";
import { OwnerGroups } from "./groups";
import { currentOwnerLink, linkClosing, onBoard, OwnerRefusedError, SESSION_CHANGED, settingsLink, settingsPing, settingsScope, type OwnerLink } from "./ownerLink";
import { closeAgent, selectSheet } from "./agentActionsDesk";
import { findTerminal } from "./terminalsDesk";
import { StartedAgents } from "./startedAgents";
import { boundShareStatements } from "./statements";
import { panePromptAttachments } from "./gram";
import { messageTooLong, ompHarness, orderedTopics, topicSendDelivery, topicsNotOffered, topicsProblem } from "../topicsModel";
import { agentView, PEER_NOT_SHARED, setSharedAgents, setView, type GuestView } from "./view";

type DeskFns = typeof GoDesk;

/** desk_guest.go guestStatusPoll. */
export const GUEST_STATUS_POLL_MS = 15_000;
/** What the owner sees the browser as, where Go sends os.Hostname (AcceptGuestInvitation). */
export const BROWSER_DEVICE = "Web browser";
const ERR_SENDING = "a send is running"; // gramstore.ErrSending
const GUEST_FORBIDDEN = "guest_forbidden"; // desk_guest_answers.go guestForbidden
/** herdr owner_gate.rs: a chat-scope stream's agent isn't running (opening it, or while it runs). */
const OWNER_PAUSED = "owner_paused";
/** herdr owner_gate.rs: a method the owner browser's scope doesn't take; the session stays open. */
const OWNER_FORBIDDEN = "owner_forbidden";
/** herdr's ping capability: its owner gate records an owner browser's writes as the owner's
 *  (input_source app, turn origin mine), so the chat's up arrow finds them (#575). */
const OWNER_BROWSER_ORIGIN = "owner_browser_origin";
const refusedHere = (code: string) => code === GUEST_FORBIDDEN || code === OWNER_FORBIDDEN;
// desk_guest_answers.go guestMenuKeys
const GUEST_MENU_KEYS = ["Escape", "Space", "Left", "Up", "Down", "Right", "Tab", "Enter"];
// desk_interaction_compose.go promptWait
/** A guest's Topics poll while it shows (TopicsModel.pollSeconds): the gate has no event stream. */
export const TOPICS_GUEST_POLL_MS = 15_000;
/** desk_topics.go topicsRetry (iOS TopicsDiscoveryBackoff): the waits before the open Inbox asks
 *  again after a list that failed for a passing reason, the last one repeating. Both desks read
 *  app/topics_retry.json (seconds). */
export const TOPICS_RETRY_MS: readonly number[] = topicsRetrySeconds.map((s) => s * 1000);
const TOPIC_TOO_LONG = "Messages are limited to 32 KB. Send it in parts.";
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

/** engine.GuestAgentList through the link's client: agent.list's result checked for its
 *  agent_list tag (anything else, e.g. a pong, is a protocol failure, never an empty list). The
 *  Desk's lists and the machine probe (ownerProbe.ts) both read agents this way. */
export async function listAgents(client: GuestClient, signal?: AbortSignal): Promise<GuestList> {
 return guestList(await client.call("agent.list", {}, "agent_list", "", signal));
}

/** An owner link's availability for its open agent (herdr owner_gate.rs owner_paused): "paused"
 *  once a list no longer has that pane, or has it archived; "" with no agent open. */
export function ownerAvailability(agents: readonly AgentInfo[], paneID: string | null): string {
 if (paneID === null) return "";
 const agent = agents.find((a) => a.pane_id === paneID);
 return agent && !isArchived(agent) ? "" : "paused";
}

/** An owner link to an approved machine (ownerConnection): the grant as an Access, its
 *  transport, the link over it and the client the agent list goes through. */
export interface OwnerConnection { access: Access; transport: GuestTransport; link: WebLink; client: GuestClient }

/** An owner link to an approved machine, as the Desk (connectOwner) and the machine probe
 *  (ownerProbe.ts) both open it: the machine's relay endpoint and the hello with this browser's
 *  account statement (ownerLink). */
export function ownerConnection(m: EnvelopeMachine, identity: StaticKey, statements: StatementSource, device: string, options: { now?: () => number; webSocket?: WebSocketFactory } = {}): OwnerConnection {
 const hostPublicKey = fromB64url(m.nodePub, 32);
 if (hostPublicKey === null) throw new Error("The approved machine's key is damaged.");
 const endpoint = { relay: m.relay, hostID: m.hostID, hostPublicKey };
 const access: Access = { guestID: m.grantID, guestName: "", machineLabel: m.label, ownerName: "", agentName: "", agentTarget: "", endpoint, acceptedAt: new Date(0) };
 const transport = new GuestTransport(ownerLink(endpoint, device, statements), identity, options);
 const link = transportLink(pageAccess(access), transport);
 return { access, transport, link, client: new GuestClient(link) };
}

/** Whether a failed send definitely didn't deliver (desk_interaction_compose.go's kept draft):
 *  herdr refused it (not with an unconfirmed code), the host has no such method (ErrUnsupported),
 *  or the request never left this page (NotSentError). Anything else may have reached the host:
 *  "unconfirmed", never resent. Agent prompts and terminal writes alike. */
function sendFailed(error: unknown): boolean {
 return error instanceof NotSentError || error instanceof ErrUnsupported || (error instanceof HerdrAPIError && !UNCONFIRMED_CODES.includes(error.code));
}

/** submitPanePrompt's receipt (desk_interaction_compose.go:200) for a write, agent prompt or
 *  terminal text alike, whose outcome a resend could duplicate. */
const UNCONFIRMED_RECEIPT = JSON.stringify({ delivery: "unconfirmed", note: "Couldn't confirm delivery — check the terminal before sending again." });

/** submitPanePrompt's receipt (desk_interaction_compose.go:117-159) for an agent prompt: the
 *  delivery herdr reports, the error of a prompt that definitely didn't deliver (sendFailed), else
 *  unconfirmed (UNCONFIRMED_RECEIPT). */
export function promptReceipt(result: { delivery?: string | null } | null, error: unknown): string {
 if (error !== null) {
  if (sendFailed(error)) throw error;
  return UNCONFIRMED_RECEIPT;
 }
 const delivery = result?.delivery ?? "submitted";
 return JSON.stringify(delivery === "written_to_pty" ? { delivery, note: "Sent to terminal; agent submission not verified" } : { delivery });
}

/** submitPanePrompt's receipt for a plain terminal (pane.send_text, no Enter): written, the error of
 *  a write that definitely didn't deliver (sendFailed), else unconfirmed as for a prompt
 *  (UNCONFIRMED_RECEIPT). */
export function terminalWriteReceipt(error: unknown): string {
 if (error === null) return JSON.stringify({ delivery: "written", note: "Written to terminal; press Enter to run it." });
 if (sendFailed(error)) throw error;
 return UNCONFIRMED_RECEIPT;
}

// The composer's reasons a plain terminal's text was written nothing (app desk_interaction_compose.go
// unwritten): each is a definite failure, so the draft is kept. TERMINAL_TEXT_REFUSED is the page's
// own, before any send (a NotSentError); the other two are herdr's refusals in the user's words.
const TERMINAL_TEXT_REFUSED = "Write plain text on one line: line breaks and control characters would act on the terminal before Enter.";
const TERMINAL_LINE_BREAK = "Write one line at a time: a line break would run the text before it.";
const TERMINAL_PASTE_REFUSED = "This program can't take a pasted block. Write one line at a time.";

/** A draft with a line break goes as one bracketed paste (herdr #517 pane.send_bracketed_text).
 *  The reason it was written nothing, when herdr's answer says so, else null (a write that may
 *  have arrived, or one that never left the page, with its own reason). A herdr without the
 *  method refuses it before any pane: as an unlisted method (invalid_request), or as an unknown
 *  one, which GuestClient maps to ErrUnsupported (unknown_method, or invalid_request naming the
 *  method as an unknown variant). A chat-scope grant may not write to a terminal
 *  (owner_forbidden), and a program with bracketed paste off takes none
 *  (bracketed_paste_unavailable). */
function bracketedRefusal(error: unknown): string | null {
 if (error instanceof ErrUnsupported) return TERMINAL_LINE_BREAK;
 if (!(error instanceof HerdrAPIError)) return null;
 switch (error.code) {
  case "invalid_request": case "owner_forbidden": return TERMINAL_LINE_BREAK;
  case "bracketed_paste_unavailable": return TERMINAL_PASTE_REFUSED;
  default: return null;
 }
}

/** Why this page won't write text to a plain terminal as it stands, or null. herdr writes a
 *  terminal's text to its PTY byte for byte (pane.send_text): a control character (C0, DEL, C1:
 *  Ctrl-O, ESC sequences) acts on the shell at once, before the Enter the page promises, and one
 *  inside a bracketed paste could end it early. Line breaks are writeToTerminal's to decide. */
function terminalTextProblem(text: string): string | null {
 return /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text) ? TERMINAL_TEXT_REFUSED : null;
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
  acceptedAt: goTime(a.acceptedAt), accountBound: a.accountBound === true,
 };
}

/** paneMenu (desk_agent_actions.go:267-303) in the browser: a guest's has no share, avatar, mute or
 *  close; an owner's agent (muted not null) has Share with someone when the page offers it, then
 *  Avatar… and Close agent when the link may write them (owner.avatar, owner.close), with Mute or
 *  Unmute notifications (this browser's) between them. */
export function webPaneMenu(o: PaneMenuOptions, muted: boolean | null, owner = { avatar: false, close: false }): (MenuEntry & { action?: PaneSheetAction | PanePlainAction })[] {
 const entries: (MenuEntry & { action?: PaneSheetAction | PanePlainAction })[] = [
  { label: "Copy screen", action: "copy-screen" },
  { label: "Copy recent output", action: "copy-recent" },
  { label: "Copy selection", action: "copy-selection", disabled: !o.hasSelection },
  { label: "", separator: true },
  { label: "Text size", disabled: true },
  { label: "Increase", action: "text-increase" },
  { label: "Decrease", action: "text-decrease" },
  { label: "Reset", action: "text-reset" },
 ];
 if (muted === null || o.plain) return entries;
 return [...entries, { label: "", separator: true },
  ...o.canShare ? [{ label: "Share with someone", action: "share" } as const] : [],
  ...owner.avatar ? [{ label: "Avatar…", action: "avatar" } as const] : [],
  muted ? { label: "Unmute notifications", action: "unmute" } : { label: "Mute notifications", action: "mute" },
  ...owner.close ? [{ label: "Close agent", action: "close" } as const] : []];
}

/** The muted panes of every machine, by host id (Go's notifications.json muted). */
export const MUTED_PANES_KEY = "herdrup.web.mutedPanes";

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
 /** TOPICS_RETRY_MS unless a test passes its own. */
 topicsRetryMs?: readonly number[];
 /** An owner's per-machine state on this browser; localStorage unless a test passes its own. */
 openFolders?: MachineLists;
 mutedPanes?: MachineLists;
 /** This page's account statements (statements.ts statementCache, the owner links' cache): a
  *  share bound to the account connects with them. None: a bound share is account_required. */
 statements?: StatementSource;
}

interface Active {
 id: string;
 /** A guest grant's, or for an owner link (D2c) one made from the approved machine. */
 access: Access;
 /** The approved machine of an owner link: every agent there is listed, none filtered. */
 owner?: EnvelopeMachine;
 transport: GuestTransport;
 link: WebLink;
 client: GuestClient;
 life: AbortController;
 /** link.guestPoll: one pending kick. */
 kick: () => void;
 agents: AgentInfo[];
 /** This link's connection as it last published it (runGuest), the one snapshot of it: made with
  *  the link ("connecting", its machine), before anyone hears of the link, so Desk.state() and
  *  ownerLinkUsable never describe different machines. */
 conn: ConnState;
 /** link.guestKeyTaken: the panes where the host took one of this link's menu keys
  *  (guestMenuKey). A guest's link has one pane; an owner's has the machine's, each its own. */
 keyTaken?: Set<string>;
 /** An owner link's folders and stars (groups.ts); a guest's link has none. */
 groups?: OwnerGroups;
 /** An owner link's agents a start acknowledged (OwnerLink.started, startedAgents.ts): a
  *  provisional one opens and runs before a list has it, never shown on the board until listed. */
 started?: StartedAgents;
 /** When the last list answered, as the board says (BoardUpdate.listedAt); "" before it. */
 listedAt: string;
 /** An owner link as its groups know it (ownerLink.ts). */
 ownerLink?: OwnerLink;
 /** shutdown's one run: the groups' cleanup, then the transport's close. */
 ended?: Promise<void>;
}

interface MountedView extends GuestView {
 /** The agent's Topics (desk_topics.go topicsState): the last list and the next read while shown. */
 topics: {
  last: TopicsUpdate; reading: Promise<void> | null; again: boolean; shown: boolean; inbox: boolean;
  /** desk_topics.go settled: the newest read is the agent's word (a list with a known suggestions
   *  capability, or a refusal for good); until then Topics on screen or the open Inbox asks again
   *  after retryMs's wait for the retries-th read that didn't settle. */
  settled: boolean; retries: number;
  /** desk_topics.go next/nextAt: the one next list read (watchTopics) and when it fires. */
  next: ReturnType<typeof setTimeout> | null; nextAt: number;
  /** desk_topics.go asOf: when the agent last answered the list shown (a cached list's
   *  as_of_unix_ms; 0 when unsaid). */
  asOf: number;
 };
 active: Active;
 view: AgentView;
 life: AbortController;
 sending: boolean;
 terminal: { id: string; life: AbortController; input: Promise<void>; failed: string | null } | null;
}

/** Whose conversation an agent.transcript page is: the Inbox's, one of its topics' or one of its
 *  subagents' (createGuestDesk transcript). */
type Conversation = { kind: "inbox" } | { kind: "topic"; topic: string } | { kind: "subagent"; subagent: string };

export function createGuestDesk(env: DeskEnv) {
 const now = env.now ?? Date.now;
 const retryMs = env.topicsRetryMs?.length ? env.topicsRetryMs : TOPICS_RETRY_MS;
 /** Desk.state() with no link open. */
 const idle = (): ConnState => ({ phase: "idle", message: "", machine: "", herdr: "", live: false });
 let board: BoardUpdate | null = null;
 let active: Active | null = null;
 let mounted: MountedView | null = null;
 let accepting = Promise.resolve();
 /** connectOwner while it reads the key: cancelled by a newer one, a disconnect or its session's end. */
 let ownerPending: AbortController | null = null;
 const mutedPanes = env.mutedPanes ?? machineLists(MUTED_PANES_KEY);

 /** The board of l's last list, laid out with an owner link's folders (BuildBoard's view). */
 function publishBoard(l: Active) {
  if (active !== l || l.listedAt === "") return;
  board = { board: buildBoard(l.agents, l.groups?.view()), listedAt: l.listedAt, session: "", machineID: l.id };
  emit("boardChanged", board);
 }

 /** The connection Desk.state() says: the open link's snapshot, else idle. */
 const state = (): ConnState => active?.conn ?? idle();
 /** A link's connection, as runGuest publishes it (the guest part: its access, features, this
  *  browser's fingerprint, the availability, an owner link's admitted scope). */
 const connection = (l: Pick<Active, "access" | "owner" | "transport">, print: string, phase: string, message: string, availability: string): ConnState => ({
  phase, message, machine: l.access.machineLabel, herdr: "", live: false,
  guest: { access: pageAccess(l.access), features: pageFeatures(l.transport.features), fingerprint: print, ...(availability !== "" ? { availability } : {}),
   ...(l.owner && l.transport.scope !== "" ? { ownerScope: l.transport.scope } : {}) },
 });
 /** l's connection is s from now (not once l has ended), told to the page while l is the open link. */
 const setState = (l: Active, s: ConnState) => {
  if (l.life.signal.aborted) return;
  l.conn = s;
  if (active === l) emit("stateChanged", s);
 };
 /** No link open (it was just closed): the page hears idle. */
 const publishIdle = () => { emit("stateChanged", idle()); };

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

 /** desk_interaction.go transcript: one agent.transcript page of the conversation (the Inbox's, a
  *  topic's or a subagent's) and its cursors; held_from goes with after (herdr #430). The
  *  handovers between the Inbox and its topics come as `relay` entries (herdr #521, chatRelay.ts)
  *  where the host's cached pong serves them; an older herdr keeps today's user/note shape, and a
  *  subagent's page has none. */
 async function transcript(token: string, conversation: Conversation, after: string, before: string, heldFrom: string): Promise<string> {
  const v = viewOf(token);
  const params: Record<string, string | boolean> = { target: v.paneID };
  if (conversation.kind === "topic") {
   // The cached pong (engine gate), not a ping per read: each guest read is a relay connect.
   try { await v.active.client.gate("agent.transcript", "agent_transcript_topic", within(v)); }
   catch (error) { throw error instanceof ErrUnsupported ? new Error("This server can't show a topic's conversation.") : error; }
   params.topic = conversation.topic;
  }
  if (conversation.kind === "subagent") params.subagent = conversation.subagent;
  if (after !== "") { params.after = after; params.held_from = heldFrom; }
  if (before !== "") params.before = before;
  if (conversation.kind !== "subagent" && await v.active.client.supports("transcript_relay_entries", within(v))) params.relay_entries = true;
  let page: unknown;
  try { page = await v.active.client.call("agent.transcript", params, "agent_transcript", "agent_transcript", within(v)); }
  catch (error) { throw conversation.kind === "topic" && error instanceof HerdrAPIError && error.code === "topic_not_found" ? new Error("This topic's conversation can't be found.") : error; }
  viewOf(token);
  return JSON.stringify(untagged(page));
 }

 /** One agent.topics.* call; a refusal comes back in the app's words (topicsProblem). */
 async function topicsCall<R>(v: MountedView, method: string, params: Record<string, string>, tag: string): Promise<R> {
  try {
   return untagged(await v.active.client.call(method, params, tag, "", within(v))) as R;
  } catch (error) {
   if (error instanceof HerdrAPIError) throw new Error(topicsProblem(error.code, error.apiMessage));
   if (error instanceof ErrUnsupported) throw new Error(topicsProblem("topics_unsupported"));
   throw error;
  }
 }

 /** desk_topics.go topicsWatch and topicsScheduleLocked: one next list read, at the poll's pace
  *  while Topics shows or the Inbox is open on an agent whose suggestions are served, and, while
  *  Topics shows or the Inbox is open and the newest read didn't settle (topics_unreachable or
  *  topics_timeout, both retryable in herdr #520), after retryMs's backoff, whichever comes first.
  *  A read that lands meanwhile keeps an earlier deadline, and the list shown stays. */
 function watchTopics(v: MountedView) {
  const t = v.topics;
  const alive = !v.life.signal.aborted;
  const poll = alive && (t.shown || (t.inbox && t.last.suggestionsServed)) ? TOPICS_GUEST_POLL_MS : 0;
  const retry = alive && (t.shown || t.inbox) && !t.settled ? retryMs[Math.min(Math.max(t.retries - 1, 0), retryMs.length - 1)]! : 0;
  const wait = poll && retry ? Math.min(poll, retry) : poll || retry;
  const at = Date.now() + wait;
  if (wait !== 0 && t.next !== null && at >= t.nextAt) return;
  if (t.next !== null) { clearTimeout(t.next); t.next = null; }
  if (wait === 0) return;
  t.nextAt = at;
  t.next = setTimeout(() => { t.next = null; if (!v.life.signal.aborted) readTopics(v); }, wait);
 }

 /** desk_topics.go topicsRead: one list read at a time, one more after it when asked meanwhile. */
 function readTopics(v: MountedView) {
  const t = v.topics;
  if (t.reading) { t.again = true; return; }
  t.reading = (async () => {
   do {
    t.again = false;
    const u: TopicsUpdate = { ...t.last, token: v.token, loaded: true };
    delete u.changed;
    const requested = Date.now();
    // stale and as_of_unix_ms: a herdr serving the list from its cache (herdr #520, desk_topics.go topicsReadOnce).
    type Listed = { topics?: TopicsUpdate["topics"]; suggestions?: TopicsUpdate["suggestions"]; stale?: boolean; as_of_unix_ms?: number };
    let list: Listed | null = null;
    try {
     list = untagged(await v.active.client.call("agent.topics.list", { target: v.paneID }, "agent_topics", "", within(v))) as Listed;
    } catch (error) {
     if (v.life.signal.aborted) return;
     const code = error instanceof HerdrAPIError ? error.code : error instanceof ErrUnsupported ? "unsupported" : "";
     t.settled = topicsNotOffered(code);
     if (t.settled) { u.topics = []; u.offered = false; delete u.problem; delete u.stale; u.suggestions = []; u.suggestionsServed = false; t.asOf = 0; }
     else u.problem = topicsProblem(code, error instanceof HerdrAPIError ? error.apiMessage : "");
    }
    const asOf = typeof list?.as_of_unix_ms === "number" ? list.as_of_unix_ms : 0;
    // An answer older than the list shown (a cache behind the refresh that brought it): the newer stays.
    if (list && asOf !== 0 && asOf < t.asOf) list = null;
    if (list) {
     u.topics = orderedTopics(list.topics ?? []); u.offered = true; delete u.problem;
     if (list.stale === true) u.stale = true; else delete u.stale;
     if (asOf !== 0) t.asOf = asOf;
     // desk_topics.go: Organise shows where the list carries suggestions on a host advertising them.
     u.suggestions = (list.suggestions ?? []).filter(x => x.suggestion_id !== ""); u.requestedMs = requested;
     // The capability is read apart from the list: a ping that fails keeps the last answer and
     // leaves the read unsettled, never a problem on a list that came back.
     t.settled = true;
     if (list.suggestions === undefined) u.suggestionsServed = false;
     else {
      try { u.suggestionsServed = (await v.active.client.ping(within(v))).capabilities?.agent_topic_suggestions === true; }
      catch { t.settled = false; }
     }
    }
    if (v.life.signal.aborted) return;
    if (t.settled) t.retries = 0; else t.retries++;
    t.last = u;
    emit("topicsChanged", u);
    watchTopics(v);
   } while (t.again);
  })().finally(() => { t.reading = null; });
 }

 function unmount() {
  const v = mounted;
  if (!v) return;
  mounted = null;
  if (v.topics.next !== null) clearTimeout(v.topics.next);
  v.life.abort(new Error("agent view changed; request was not sent"));
  setView(null);
 }

 /** The one end of l's connection, whoever asks first (disconnect, or runGuest returning): an owner
  *  link's groups clean up (linkClosing, while the connection still carries requests), then the
  *  transport closes, once. */
 function shutdown(l: Active): Promise<void> {
  return l.ended ??= (l.ownerLink ? linkClosing(l.ownerLink) : Promise.resolve()).then(() => l.transport.close());
 }

 /** Mounts view as the one open view on l (desk_interaction.go mountInteractionLocked). An owner
  *  link's availability is its open view's, at once: an agent's from the last list, a plain
  *  terminal's "". */
 function mountView(l: Active, view: AgentView, shareDetails: GuestShareDetails | null, availability: string) {
  unmount();
  const life = new AbortController();
  const token = view.token;
  const v: MountedView = { token, paneID: view.paneID, signal: life.signal, active: l, view, shareDetails, life, sending: false, terminal: null,
   topics: { last: { token, topics: [], offered: false, loaded: false, suggestions: [], suggestionsServed: false, requestedMs: 0 }, reading: null, again: false, shown: false, inbox: false, settled: false, retries: 0, next: null, nextAt: 0, asOf: 0 } };
  l.life.signal.addEventListener("abort", () => life.abort(), { once: true });
  mounted = v;
  setView(v);
  republish(l, { availability });
 }

 function disconnect() {
  unmount();
  if (active) {
   void shutdown(active);
   active.life.abort();
  }
  active = null;
  board = null;
  setSharedAgents([]);
  setLink(null);
 }

 /** An owner link's connection published again between lists: the open agent's availability as
  *  its stream says (owner_paused) or the last list does, or the scope a newer session of the
  *  link was admitted under. Not while the relay holds connects back ("reconnecting") or the
  *  link is down: those say more than the agent's state. */
 function republish(l: Active, change: Pick<GuestConnection, "availability" | "ownerScope">) {
  const guest = l.conn.guest;
  if (!l.owner || active !== l || l.conn.phase !== "connected" || !guest || guest.availability === "reconnecting") return;
  const next: GuestConnection = { ...guest, ...change };
  if (!next.availability) delete next.availability;
  if (!next.ownerScope) delete next.ownerScope;
  if (next.availability === guest.availability && next.ownerScope === guest.ownerScope) return;
  setState(l, { ...l.conn, guest: next });
 }

 /** desk_guest.go runGuest. */
 async function runGuest(l: Active, print: string) {
  const signal = l.life.signal;
  // An owner link also says the scope its grant was admitted under (ownerScope). A snapshot is
  // made, and told, only when the connection changed: its phase, message, availability, admitted
  // scope, features, the shared agent's name (a guest's access, renamed on the host), or the
  // machine's (renamed by its owner, connectGuest's relabeled).
  const publish = (phase: string, msg: string, availability: string) => {
   const now = l.conn, guest = now.guest, features = l.transport.features;
   const same = now.phase === phase && now.message === msg && (guest?.availability ?? "") === availability
    && (guest?.ownerScope ?? "") === (l.owner ? l.transport.scope : "") && guest?.access.agentName === l.access.agentName
    && guest.access.machineLabel === l.access.machineLabel
    && guest.features.gram === features.gram && guest.features.push === features.push && guest.features.multi_request === features.multiRequest;
   if (!same) setState(l, connection(l, print, phase, msg, availability));
  };
  // The snapshot made with the link ("connecting") is the first one told.
  setState(l, l.conn);
  let listed = false;
  let kicked = false;
  let wake: (() => void) | null = null;
  l.kick = () => { if (wake) wake(); else kicked = true; };
  while (!signal.aborted) {
   let wait = GUEST_STATUS_POLL_MS;
   let result: GuestList | null = null, failure: unknown = null;
   try { result = await listAgents(l.client, signal); } catch (error) { failure = error; }
   if (signal.aborted) return;
   if (failure instanceof GuestError && failure.kind === "rate_limited") {
    wait = Math.max(wait, (l.transport.rateLimitedUntil() ?? 0) - now());
    publish(listed ? "connected" : "connecting", rateLimitedMessage(wait), "reconnecting");
   } else if (failure !== null) {
    publish("error", message(failure), guestAvailability(failure));
    if (failure instanceof GuestError && failure.kind === "revoked") return;
   } else {
    listed = true;
    // An owner's machine: every agent, and the open one's availability (owner_paused).
    // A plain terminal's pane isn't an agent: its availability is the link's. A provisional
    // started agent runs until the roster decides (startedAgents.ts).
    if (l.owner) l.started?.listed(result!.agents);
    const open = mounted?.active === l && !mounted.view.plainTerminal ? mounted.paneID : null;
    const { agents, availability } = l.owner ? { agents: result!.agents, availability: open !== null && l.started?.get(open) ? "" : ownerAvailability(result!.agents, open) } : sharedListing(result!, l.access.agentTarget);
    // A guest's shared agent as the host names it now: in the access before publication, so a
    // rename is a change of the connection (the roster and share Settings read it from there).
    if (!l.owner && agents.length > 0) l.access = { ...l.access, agentName: displayName(agents[0]!) };
    publish("connected", "", availability);
    if (signal.aborted || active !== l) return;
    l.agents = agents;
    setSharedAgents(agents.map((a) => ({ pane_id: a.pane_id ?? "", name: a.name ?? null })));
    l.listedAt = goTime(new Date(now())).replace(/\.\d+Z$/, "Z");
    publishBoard(l);
    // desk_groups.go: a list reads the folder document again, at most once a minute.
    void l.groups?.refresh();
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

  async state(): Promise<ConnState> { return state(); },
  async board(): Promise<BoardUpdate | null> { return board; },

  async inspectGuestInvitation(text: string): Promise<GuestInvitation> {
   const invite = await resolveInvite(text, { now: now(), fetchSealed: env.fetchSealed });
   await guestIdentity();
   // The browser's redemption is plain: it never offers to keep a share on the account.
   return { machineLabel: invite.machineLabel, ownerName: invite.ownerName, agentName: invite.agentName, guestName: invite.guestName, expires: goTime(invite.expires), fingerprint: await identityFingerprint(), account: false };
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
   // The machine as a hello names it now (its owner renamed it, herdr #519): on the grant still
   // saved (SHARED WITH YOU; one forgotten or replaced meanwhile, in this tab or another, stays
   // so) and in the access, so the next publication names it (the header). Unsaved, the next
   // connect hears it again.
   const relabeled = (machineLabel: string) => {
    if (l.life.signal.aborted) return;
    l.access = { ...l.access, machineLabel };
    void env.grants.relabel(grant.endpoint.hostID, grant.guestID, machineLabel).catch(() => undefined);
   };
   const transport = new GuestTransport(guestLink(grant, env.statements && boundShareStatements(env.statements), relabeled), identity, { now, webSocket: env.webSocket });
   const link = transportLink(pageAccess(grant), transport);
   const l: Active = { id: "guest:" + id, access: grant, transport, link, client: new GuestClient(link), life: new AbortController(), kick: () => {}, agents: [], conn: connection({ access: grant, transport }, print, "connecting", "", ""), listedAt: "" };
   active = l;
   setLink(link);
   void runGuest(l, print).finally(() => shutdown(l));
  },

  async forgetGuestConnection(id: string): Promise<void> {
   const grant = await env.grants.get();
   if (grant !== undefined && `${grant.endpoint.hostID}/${grant.guestID}` === id) {
    env.owner.set(grant.ownerName);
    await env.grants.remove();
   }
   if (active?.id === "guest:" + id) {
    disconnect();
    publishIdle();
   }
  },

  async takeGuestInvitation(): Promise<string> { return ""; },
  async hasGuestInvitationClipboardText(): Promise<boolean> { return false; },
  async machine() { return null; },
  async machines() { return []; },
  async pendingAgent() { return null; },
  // desk_notifications.go PaneMuted / SetPaneMuted: an owner's, per machine on this browser.
  async paneMuted(paneID: string): Promise<boolean> {
   const hostID = active?.owner?.hostID;
   return hostID !== undefined && mutedPanes.get(hostID).includes(paneID);
  },
  async setPaneMuted(paneID: string, muted: boolean): Promise<void> {
   const hostID = active?.owner?.hostID;
   if (hostID === undefined || paneID === "") return;
   await mutedPanes.set(hostID, paneID, muted);
  },

  // ---- Folders (desk_groups.go), an owner link's ----

  /** The board for a sidebar search: the matching agents, every folder open, no empty folder. */
  async searchBoard(query: string) {
   const l = active;
   if (!l?.groups || l.listedAt === "") return null;
   return buildBoard(l.agents, { ...l.groups.view(), query });
  },
  async setFolderOpen(id: string, open: boolean): Promise<void> { active?.groups?.setOpen(id, open); },

  // ---- Settings scope (desk_settings.go), an owner link's ----

  async openSettings(machineID: string, session: string, token: string): Promise<void> {
   if (token === "" || token.length > 128) throw new Error("invalid Settings token");
   if (!active?.owner || active.id !== machineID || (session !== "" && session !== "default")) throw new Error("the session changed; try again");
   openSettings(token);
  },
  async closeSettings(token: string): Promise<void> {
   closeSettings(token);
  },
  /** desk_settings.go SettingsMachineVersion: "herdr <version>" from the link's ping ("" when it
   *  says none). */
  async settingsMachineVersion(token: string): Promise<string> {
   // A Settings call: never sent once Settings closes while it waits for the relay.
   const version = (await settingsPing(settingsScope(token))).version ?? "";
   settingsLink(token);
   return version === "" ? "" : `herdr ${version}`;
  },

  // ---- Agent view (desk_interaction.go) ----

  async openAgentView(target: AgentTarget, token: string): Promise<AgentView> {
   if (token === "" || token.length > 128) throw new Error("invalid view token");
   const l = active;
   if (!l || l.id !== target.machineID || (target.session !== "" && target.session !== "default")) throw new Error("agent belongs to another connection or session");
   // An agent a start acknowledged opens before a list has it (OwnerLink.started).
   const agent = l.agents.find((a) => a.pane_id === target.paneID) ?? l.started?.get(target.paneID);
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
    guest: true, guestGram: l.transport.features.gram, ...(l.access.ownerName !== "" ? { guestOwner: l.access.ownerName } : {}),
    // desk_interaction.go AskForm: a guest's gate advertises no capabilities; form_answerable decides.
    askForm: true,
    // desk_interaction.go topicSessions: the topics its session file holds, one without an id left out.
    topicSessions: (agent.topic_sessions ?? []).filter(t => !!t.topic_id).map(t => ({ topicID: t.topic_id!, title: t.title ?? "", createdMs: t.created_unix_ms ?? 0 })),
    ...(l.access.guestName !== "" ? { guestSelf: l.access.guestName } : {}), plainTerminal: false,
   };
   mountView(l, view, shareDetails(agent, name, linkShareLabel(l)), ownerAvailability([agent], view.paneID));
   return view;
  },

  /** desk_terminals.go OpenTerminalView: an owner's saved terminal (terminalsDesk.ts) as a plain
   *  terminal; its pane is no agent, so the link's availability is its own. */
  async openTerminalView(target: AgentTarget, token: string): Promise<AgentView> {
   if (token === "" || token.length > 128) throw new Error("invalid view token");
   const l = active;
   if (!l?.owner) throw new Error("not connected");
   if (!onBoard(l.id, target.machineID, target.session)) throw new Error(SESSION_CHANGED);
   // herdr's owner gate streams and writes a plain shell under a terminal-scope grant only; the
   // page offers the shell there only (terminals.ts), Forget everywhere.
   if (l.transport.scope !== "terminal") throw new OwnerRefusedError("pane.stream");
   const saved = findTerminal(l.owner.hostID, target.paneID);
   const view: AgentView = { token, paneID: saved.paneID, name: saved.label, harness: "", heading: saved.label, group: "terminal", status: "Terminal",
    guest: true, guestGram: false, askForm: false, topicSessions: [], plainTerminal: true };
   mountView(l, view, { agentName: saved.label, machineLabel: linkShareLabel(l) }, "");
   return view;
  },

  async closeAgentView(token: string): Promise<void> {
   if (mounted?.token === token) unmount();
  },

  async guestShareDetails(token: string): Promise<GuestShareDetails> {
   const details = viewOf(token).shareDetails;
   if (details === null) throw new Error(PEER_NOT_SHARED);
   return details;
  },

  /** Chat and the owner's up arrow from the one fresh pong the page opens Chat with: the arrow
   *  only on an owner link to a host that records the browser's prompts as the owner's; an older
   *  owner gate marks them other, and the arrow would skip them for an older prompt sent from the
   *  app (#575). A failed ping throws: no pong says Chat is unsupported, and the page's Refresh
   *  asks again (#584). */
  async guestChatAvailable(token: string): Promise<GuestChat> {
   const v = viewOf(token);
   const pong = await v.active.client.ping(within(v));
   return { available: pong.capabilities?.agent_transcript === true, ownerOrigin: !!v.active.owner && pong.capabilities?.[OWNER_BROWSER_ORIGIN] === true };
  },

  // ---- Chat (desk_interaction.go, desk_guest_answers.go) ----

  async chatTranscript(token: string, after: string, before: string, subagent: string, heldFrom: string): Promise<string> {
   return transcript(token, subagent === "" ? { kind: "inbox" } : { kind: "subagent", subagent }, after, before, heldFrom);
  },

  // ---- Topics (desk_topics.go, herdr #475): a guest polls; the gate has no event stream ----

  async topicsAvailable(token: string): Promise<boolean> {
   const v = viewOf(token);
   if (!ompHarness(v.view.harness)) return false;
   const pong = await v.active.client.ping(within(v));
   return pong.capabilities?.agent_topics === true;
  },

  async topicsRefresh(token: string): Promise<void> {
   readTopics(viewOf(token));
  },

  async topicsFollow(token: string, shown: boolean): Promise<void> {
   const v = viewOf(token);
   v.topics.shown = shown;
   if (shown) readTopics(v);
   watchTopics(v);
  },

  async topicsFollowInbox(token: string, open: boolean): Promise<void> {
   const v = viewOf(token);
   v.topics.inbox = open;
   if (open && !v.topics.settled) readTopics(v);
   watchTopics(v);
  },

  async topicTranscript(token: string, topic: string, after: string, before: string, heldFrom: string): Promise<string> {
   if (topic === "") throw new Error("no topic");
   return transcript(token, { kind: "topic", topic }, after, before, heldFrom);
  },

  async topicsNew(token: string, title: string, message: string): Promise<string> {
   const v = viewOf(token);
   title = title.trim(); message = message.trim();
   if (title === "" || message === "") throw new Error("A topic needs a title and a first message.");
   if (messageTooLong(message)) throw new Error(TOPIC_TOO_LONG);
   const created = await topicsCall<{ topic_id: string }>(v, "agent.topics.new", { target: v.paneID, title, message }, "agent_topic_created");
   readTopics(v);
   return created.topic_id;
  },

  /** desk_topics.go TopicsSend: a message to one topic from the page's composer, its files going
   *  as the Inbox's do (panePromptAttachments: posted as Grams, named in the message); a refusal
   *  keeps them for a retry. */
  async topicsSend(token: string, topicID: string, text: string): Promise<TopicSendReply> {
   const v = viewOf(token);
   text = text.trim();
   const send = async (message: string): Promise<TopicSendReply> => {
    if (messageTooLong(message)) return { mode: "", delivery: "refused", problem: TOPIC_TOO_LONG };
    try {
     const sent = untagged(await v.active.client.call("agent.topics.send", { target: v.paneID, topic_id: topicID, message }, "agent_topic_sent", "", within(v))) as { mode: string };
     return { mode: sent.mode, delivery: "sent" };
    } catch (error) {
     if (v.life.signal.aborted) throw error;
     const code = error instanceof HerdrAPIError ? error.code : error instanceof ErrUnsupported ? "unsupported" : "";
     const delivery = topicSendDelivery(code);
     // The agent's words when it answered; a broken link only says it may have arrived (iOS).
     const problem = code === "" ? "Couldn't confirm delivery. Check the topic before sending again." : topicsProblem(code, error instanceof HerdrAPIError ? error.apiMessage : "");
     return { mode: "", delivery, problem };
    } finally { readTopics(v); }
   };
   if (v.sending) throw new Error(ERR_SENDING);
   // A caption already over the cap can't go with any file: refused before one is posted (#534);
   // send checks the composed message too.
   if (messageTooLong(text)) return { mode: "", delivery: "refused", problem: TOPIC_TOO_LONG };
   v.sending = true;
   try {
    let reply: TopicSendReply | null = null;
    const withFiles = panePromptAttachments(token, text, async prompt => {
     reply = await send(prompt);
     if (reply.delivery === "refused") throw new Error(reply.problem ?? "The agent refused.");
     return "";
    });
    if (withFiles === null) {
     if (text === "") throw new Error("prompt is empty");
     return await send(text);
    }
    try { await withFiles; } catch (error) { if ((reply as TopicSendReply | null)?.delivery !== "refused") throw error; }
    return reply!;
   } finally { v.sending = false; }
  },

  async topicsClose(token: string, topicID: string): Promise<void> {
   const v = viewOf(token);
   await topicsCall(v, "agent.topics.close", { target: v.paneID, topic_id: topicID }, "agent_topic_updated");
   readTopics(v);
  },

  async topicsReopen(token: string, topicID: string): Promise<void> {
   const v = viewOf(token);
   await topicsCall(v, "agent.topics.reopen", { target: v.paneID, topic_id: topicID }, "agent_topic_updated");
   readTopics(v);
  },

  async topicsRename(token: string, topicID: string, title: string): Promise<void> {
   const v = viewOf(token);
   title = title.trim();
   if (title === "") throw new Error("A topic needs a title.");
   await topicsCall(v, "agent.topics.rename", { target: v.paneID, topic_id: topicID, title }, "agent_topic_updated");
   readTopics(v);
  },

  // Suggestions and Organise (desk_topics.go, herdr #490): a guest may Start, Not now and Organise.
  async topicsAcceptSuggestion(token: string, suggestionID: string): Promise<string> {
   const v = viewOf(token);
   const accepted = await topicsCall<{ topic_id: string }>(v, "agent.topics.accept_suggestion", { target: v.paneID, suggestion_id: suggestionID }, "agent_topic_suggestion_accepted");
   readTopics(v);
   return accepted.topic_id;
  },

  async topicsDismissSuggestion(token: string, suggestionID: string): Promise<void> {
   const v = viewOf(token);
   await topicsCall(v, "agent.topics.dismiss_suggestion", { target: v.paneID, suggestion_id: suggestionID }, "agent_topic_suggestion_dismissed");
   readTopics(v);
  },

  async topicsOrganise(token: string): Promise<boolean> {
   const v = viewOf(token);
   const started = await topicsCall<{ queued: boolean }>(v, "agent.topics.organise", { target: v.paneID }, "agent_topics_organise_started");
   readTopics(v);
   return started.queued;
  },

  async topicsSettleSuggestions(token: string, accept: string[], dismiss: string[]): Promise<string> {
   const v = viewOf(token);
   let problem = "";
   const settle = async (id: string, start: boolean) => {
    try {
     await v.active.client.call(start ? "agent.topics.accept_suggestion" : "agent.topics.dismiss_suggestion", { target: v.paneID, suggestion_id: id },
      start ? "agent_topic_suggestion_accepted" : "agent_topic_suggestion_dismissed", "", within(v));
    } catch (error) {
     const code = error instanceof HerdrAPIError ? error.code : error instanceof ErrUnsupported ? "topics_unsupported" : "";
     if (!problem && code !== "already_accepted" && code !== "suggestion_not_found") problem = topicsProblem(code, error instanceof HerdrAPIError ? error.apiMessage : "");
    }
   };
   for (const id of accept) await settle(id, true);
   for (const id of dismiss) await settle(id, false);
   readTopics(v);
   return problem;
  },

  async chatPrompt(token: string, text: string): Promise<string> {
   const v = viewOf(token);
   if (v.sending) throw new Error(ERR_SENDING);
   v.sending = true;
   try {
    const submit = async (prompt: string) => {
     let result: { delivery?: string | null } | null = null, failure: unknown = null;
     // A plain terminal is no agent: its text is written to the pane without Enter.
     if (v.view.plainTerminal) {
      // Refused here, never sent, the composer puts it back (a definite not-sent).
      const problem = terminalTextProblem(prompt);
      if (problem !== null) throw notSent(new Error(problem));
      // As opening it (openTerminalView): a link renewed to another scope writes no shell.
      if (v.active.transport.scope !== "terminal") throw new OwnerRefusedError("pane.send_text");
      // app writeToTerminal: one line goes as it is; a draft with a line break goes as one
      // bracketed paste, so the break doesn't run the text before it. That is one call of its own
      // method, which every herdr that can't write one refuses, nothing written: no pong is relied
      // on, so a restart or a rollback between a pong and the write can't write it raw (#489).
      const params = { pane_id: v.paneID, text: prompt };
      const multiline = /[\r\n]/.test(prompt);
      try {
       await v.active.client.call(multiline ? "pane.send_bracketed_text" : "pane.send_text", params, "ok", "", within(v));
      } catch (error) {
       // herdr refused it, writing nothing: the user's reason, herdr's answer as its cause. The
       // composer keeps the draft on any rejection; NotSentError stays for a write that never
       // reached the socket.
       const refusal = multiline ? bracketedRefusal(error) : null;
       if (refusal !== null) throw new Error(refusal, { cause: error });
       failure = error;
      }
      return terminalWriteReceipt(failure);
     }
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
     if (refusedHere(error.code)) reply.ownerAnswers = true;
     return reply;
    }
    throw error;
   } finally {
    v.active.kick();
   }
  },

  async chatAnswerForm(token: string, askID: string, values: Record<string, AskFormValue>): Promise<ChatAnswerFormReply> {
   const v = viewOf(token);
   try {
    // guest.Transport.AgentAnswerForm: straight to the relay, as agent.answer (answers.go).
    const result = await v.active.link.call<Pick<ChatAnswerFormReply, "status" | "answers"> | null>("agent.answer_form", { target: v.paneID, ask_id: askID, values }, within(v));
    return { ...(result?.status ? { status: result.status } : {}), answers: result?.answers ?? [] };
   } catch (error) {
    if (error instanceof HerdrAPIError) {
     const reply: ChatAnswerFormReply = {};
     if (error.code !== "") reply.code = error.code;
     if (error.apiMessage !== "") reply.message = error.apiMessage;
     if (refusedHere(error.code)) reply.ownerAnswers = true;
     return reply;
    }
    throw error;
   } finally {
    v.active.kick();
   }
  },

  async chatDismissAsk(token: string, askID: string): Promise<ChatDismissReply> {
   const v = viewOf(token);
   try {
    // guest.Transport.AgentDismissAsk: straight to the relay, as agent.answer_form (answers.go).
    const result = await v.active.link.call<{ dismissed?: boolean } | null>("agent.dismiss_ask", { target: v.paneID, ask_id: askID }, within(v));
    return result?.dismissed ? { dismissed: true } : {};
   } catch (error) {
    if (error instanceof HerdrAPIError) {
     const reply: ChatDismissReply = {};
     if (error.code !== "") reply.code = error.code;
     if (error.apiMessage !== "") reply.message = error.apiMessage;
     return reply;
    }
    throw error;
   } finally {
    v.active.kick();
   }
  },

  // desk_guest_answers.go GuestMenuKey: a refused key reads the agent again, and one still
  // blocked means a host that keeps answers for the owner (GuestPaneView.sendMenuKey), unless
  // this host has taken one of this guest's keys before.
  async guestMenuKey(token: string, key: string): Promise<GuestMenuKeyReply> {
   const v = viewOf(token);
   if (!GUEST_MENU_KEYS.includes(key)) throw new Error(`${JSON.stringify(key)} is not a menu key`);
   try {
    await v.active.link.call("pane.send_keys", { pane_id: v.paneID, keys: [key] }, within(v));
    (v.active.keyTaken ??= new Set()).add(v.paneID);
    return {};
   } catch (error) {
    if (!(error instanceof HerdrAPIError && refusedHere(error.code))) throw error;
    if (v.active.keyTaken?.has(v.paneID)) return {};
    let list: GuestList;
    try { list = await listAgents(v.active.client, within(v)); } catch { return {}; }
    // The mounted pane: an owner link's access names no agent (agentTarget is "").
    const { agents, availability } = sharedListing(list, v.paneID);
    return agents[0] && availability === "" && liveGroup(agents[0]).key === "needsYou" ? { ownerAnswers: true } : {};
   } finally {
    v.active.kick();
   }
  },

  async chatMenu(id: string, offersMarkdown: boolean): Promise<void> {
   const labels = ["Copy", ...(offersMarkdown ? ["Copy as Markdown"] : []), "Select Text"];
   const item = await showMenu(labels.map((label) => ({ label })));
   if (item !== null) emit("chatMenu", { id, item: item.label });
  },

  async paneMenu(o: PaneMenuOptions): Promise<boolean> {
   const l = active, view = mounted, link = currentOwnerLink();
   if (!l || o.paneID === "") return false;
   // The menu and its choice belong to the link and the agent page it was asked on: another
   // machine or page since (a slow ping, a choice made later) drops it, or its pane id would name
   // a pane there.
   const still = () => active === l && mounted === view;
   // Share, Avatar… (a host that stores avatars) and Close agent write (herdr#510): a link under
   // terminal scope. The menu offers them as the link is once its answers are in (a renewal may
   // have admitted it under chat meanwhile), and drops them if that changes before the choice.
   const writes = () => !!l.owner && l.transport.scope === "terminal";
   const pong = writes() && !o.plain ? await l.client.ping(l.life.signal).catch(() => null) : null;
   const muted = l.owner ? await desk.paneMuted(o.paneID) : null;
   if (!still()) return false;
   // A federated peer's agent is not this link's to share (PEER_NOT_SHARED): no Share, as on a
   // guest's page.
   const shares = o.canShare && writes() && view?.paneID === o.paneID && view.shareDetails !== null;
   const entries = webPaneMenu({ ...o, canShare: shares }, muted, { avatar: writes() && pong?.capabilities?.agent_avatar === true, close: writes() });
   void showMenu(entries).then(async (item) => {
    const action = item?.action;
    if (!action || !still()) return;
    if ((action === "share" || action === "avatar" || action === "close") && !writes()) return;
    // Go flips the stored mute before the page hears the choice.
    if (action === "mute" || action === "unmute") await desk.setPaneMuted(o.paneID, action === "mute");
    // Close agent is sent once the pane closed (choosePaneAction), on the menu's own link.
    if (action === "close" && !await closeAgent(link, o.paneID)) return;
    // The page acts on the pane id: once the page was mounted again meanwhile, this isn't its choice.
    if (!still()) return;
    // The avatar sheet it opens belongs to this link: the selection it carries (no link, no sheet).
    if (action === "avatar") { if (link) emit("paneActionChosen", { paneID: o.paneID, action, sheet: selectSheet(link, "avatar", o.paneID) }); }
    else emit("paneActionChosen", { paneID: o.paneID, action, sheet: null });
   });
   return true;
  },

  async gramMenu(id: string, items: string[]): Promise<boolean> {
   if (items.length === 0) return false;
   void showMenu(items.map((label) => ({ label }))).then((item) => { if (item !== null) emit("gramMenu", { id, item: item.label }); });
   return true;
  },

  async gramSenderAvatar(name: string) { return senderFace(name, active?.agents ?? []); },
  // desk_avatars.go AvatarImage: the agent's photo, fetched over the open link by its sha256
  // (agent.avatar.get, which herdr's owner gate allows), or unavailable when herdr's answer is
  // that there is none to draw for that agent (avatarAnswered, or bytes that are not the photo).
  // A failure on the way to herdr is an error, which avatars.ts asks again for on its next render.
  async avatarImage(target: string, sha256: string): Promise<AvatarPhoto> {
   const l = active;
   if (!l) throw new Error("not connected");
   if (!/^[0-9a-f]{64}$/.test(sha256)) return { unavailable: true };
   let image: { data_base64?: unknown };
   try {
    image = await l.client.call<{ data_base64?: unknown }>("agent.avatar.get", { target, sha256 }, "agent_avatar_image", "agent_avatar", l.life.signal);
   } catch (error) {
    if (avatarAnswered(error)) return { unavailable: true };
    throw error;
   }
   // Bytes that are not the photo are herdr's answer; anything else failed here (the page's own
   // Web Crypto, say), and is asked again.
   return avatarDataURL(typeof image.data_base64 === "string" ? image.data_base64 : "", sha256).then((url) => ({ url }), (error: unknown) => {
    if (error instanceof AvatarBytesError) return { unavailable: true };
    throw error;
   });
  },

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
     // Structured, so the refusal below is told by its code, not by words in its message.
     throw v.active.client.mapError("pane.stream", new HerdrAPIError(e.code ?? "", e.message ?? "", value.error));
    }
    checkTag("pane.stream", typeof value === "object" && value !== null && "result" in value ? value.result : null, "stream_started");
   } catch (error) {
    if (v.terminal === terminal) v.terminal = null;
    life.abort();
    // herdr #497: a chat stream's agent isn't running (owner_paused): the open agent is paused
    // until a list has it again (republish, runGuest). An owner's pane.stream on a local agent's
    // pane is refused before it opens with owner_forbidden for the same reason, and only for it
    // (owner_gate.rs: under the grant's current scope, which a renewal may have narrowed since the
    // hello, a chat scope's pane methods need the agent running; pane.stream on a local pane is
    // otherwise allowed in both scopes), so it reads as paused too. A remote agent's pane is
    // refused for good: that stays an error.
    // A refusal can come from a session admitted under a narrowed scope: the page hears the
    // scope now, not at the next list (a mounted shell closes under chat scope).
    republish(v.active, { ownerScope: v.active.transport.scope });
    const agent = v.active.agents.find(a => a.pane_id === v.paneID);
    const code = error instanceof HerdrAPIError ? error.code : "";
    // Only pane_not_found / agent_not_found retire a started agent (startedAgents.ts); the open
    // view hears it now, not at the next list.
    if (code !== "" && v.active.started?.refused(v.paneID, code)) republish(v.active, { availability: ownerAvailability(v.active.agents, v.paneID) });
    // A plain terminal is never paused: its pane runs no agent, and a refusal stays an error.
    const pausedAtOpen = !v.view.plainTerminal && (code === OWNER_PAUSED || (!!v.active.owner && !agent?.machine_id && code === OWNER_FORBIDDEN));
    if (pausedAtOpen) {
     republish(v.active, { availability: "paused" });
     if (code !== OWNER_PAUSED) throw new Error(`pane.stream: herdr: ${OWNER_PAUSED}: the agent this stream watches is no longer running`);
    }
    throw error;
   }
   // A session admitted under another scope than the one published (a renewal changed it and
   // the page opened the stream again): the page hears the new one now, not at the next list.
   republish(v.active, { ownerScope: v.active.transport.scope });
   void (async () => {
    for (;;) {
     let event: { frame?: PaneStreamFrame; error?: string; reconnect?: boolean };
     try {
      const next = await lines.next();
      if (life.signal.aborted) return;
      event = next.done ? { error: "EOF" } : { frame: paneStreamFrame(next.value) };
     } catch (error) {
      if (life.signal.aborted) return;
      event = { error: message(error) };
     }
     // herdr #497: a renewal changed the grant's scope and ended the stream; it opens again
     // under the new one (interaction.ts reconnects on reconnect, once per STREAM_RECONNECT_MS).
     if (event.error?.includes("owner_scope_changed")) event = { ...event, reconnect: true };
     if (event.error?.includes(OWNER_PAUSED)) republish(v.active, { availability: "paused" });
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
   *  transport has no duplex input stream. herdr's guest gate and a chat-scope owner's refuse it
   *  (the page sends only under a terminal-scope owner's grant); the first failure ends input for
   *  the surface, as PaneInput.failed does. */
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
   // herdr's owner and guest gates both take recent or visible only (owner_gate.rs,
   // guest_gate.rs): recent text keeps the terminal's line wraps on the web.
   const source = recent ? "recent" : "visible";
   // desk_interaction.go ReadAgentText: a plain terminal's screen is the pane's (pane.read).
   const [method, target] = v.view.plainTerminal ? ["pane.read", { pane_id: v.paneID }] : ["agent.read", { target: v.paneID }];
   const result = await v.active.client.call<{ read?: { text?: string } }>(method, { ...target, source, format: "text" }, "pane_read", "", within(v));
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

 /** Owner access (web owner access D2c): this browser's link to one of the machines it was
  *  approved for, through ownerLink (its account statement in the hello), listing every agent
  *  there. The agent page, chat and Topics then work as for a guest's link. */
 async function connectOwner(m: EnvelopeMachine, statements: StatementSource, device: string, session: AbortSignal): Promise<void> {
  // One owner connect at a time: a newer one or a disconnect cancels this one while it reads
  // the key, and so does the end of the account session it was asked in (a sign-out or another
  // sign-in): it never links nor publishes a board.
  ownerPending?.abort();
  const pending = new AbortController();
  ownerPending = pending;
  const cancelled = AbortSignal.any([session, pending.signal]);
  try {
   const identity = await requireIdentity();
   const print = await identityFingerprint();
   cancelled.throwIfAborted();
   const { access, transport, link, client } = ownerConnection(m, identity, statements, device, { now, webSocket: env.webSocket });
   disconnect();
   const started = new StartedAgents();
   const l: Active = { id: "owner:" + m.hostID, access, owner: m, transport, link, client, life: new AbortController(), kick: () => {}, agents: [], conn: connection({ access, owner: m, transport }, print, "connecting", "", ""), listedAt: "", started };
   l.groups = new OwnerGroups(client, m.hostID, l.life.signal, () => publishBoard(l), now, env.openFolders);
   active = l;
   l.ownerLink = { machine: m, board: l.id, client, signal: l.life.signal, scope: () => transport.scope, agents: () => l.agents, relist: () => l.kick(), groups: l.groups,
    watchStart: () => { const watch = started.watch(); return { started: (agent) => { watch.started(agent); l.kick(); }, end: watch.end }; } };
   // One publication: the link with its owner context (link.ts; ownerLink.ts is its owner view),
   // so Gram and every owner group start once, on the same link.
   setLink(link, l.ownerLink);
   // The session ending ends the link too: its board and agent view go, the page goes idle.
   session.addEventListener("abort", () => { if (active === l) disconnectOwner(); }, { once: true, signal: l.life.signal });
   void runGuest(l, print).finally(() => shutdown(l));
  } finally {
   if (ownerPending === pending) ownerPending = null;
  }
 }

 /** Leaves the owner link, back to the machine list; an owner connect still reading the key ends too. */
 function disconnectOwner() {
  ownerPending?.abort();
  ownerPending = null;
  if (!active?.owner) return;
  disconnect();
  publishIdle();
 }

 /** Whether this desk's owner link to hostID is open and usable: the active link is that
  *  machine's, and its connection snapshot (made with the link, before any watcher hears of it,
  *  then as it publishes; Desk.state() says the same one) is connecting or connected, not failed.
  *  The chooser's Open goes straight back to it then. */
 function ownerLinkUsable(hostID: string): boolean {
  const phase = active?.owner?.hostID === hostID ? state().phase : "";
  return phase === "connecting" || phase === "connected";
 }

 return Object.assign(desk, { connectOwner, disconnectOwner, ownerLinkUsable });
}

/** desk_avatars.go definitiveAvatarFailure: whether a failed agent.avatar.get is herdr's answer
 *  for that agent and photo (its error reply such as not_found, a herdr without agent_avatar, a
 *  result of another type), remembered for the connection. Anything else, a GuestError of any
 *  kind among them, failed on the way to herdr and is asked again. */
export function avatarAnswered(error: unknown): boolean {
 return error instanceof HerdrAPIError || error instanceof ErrUnsupported || error instanceof ResultTagError;
}

/** desk_avatars.go avatarBytesError: agent.avatar.get's bytes are not the photo asked for. */
export class AvatarBytesError extends Error {
 constructor(message: string) {
  super(message);
  this.name = "AvatarBytesError";
 }
}

/** desk_avatars.go loadAvatar + dataURL: agent.avatar.get's bytes as the data: URL the page
 *  draws, only when they are the photo asked for (their sha256) and an image (sniffed as PNG or
 *  JPEG, the two herdr takes): AvatarBytesError otherwise. Hashing them can fail too, as any Web
 *  Crypto call can; that error is thrown as it is. */
export async function avatarDataURL(base64: string, sha256: string): Promise<string> {
 // Only atob's refusal of malformed base64 is the reply's fault; building the bytes is not.
 let binary: string;
 try { binary = atob(base64); } catch (error) {
  if (error instanceof DOMException && error.name === "InvalidCharacterError") throw new AvatarBytesError("avatar is not base64");
  throw error;
 }
 const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
 const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
 if (Array.from(digest, b => b.toString(16).padStart(2, "0")).join("") !== sha256) throw new AvatarBytesError("avatar doesn't match its sha256");
 // The whole 8-byte PNG signature, as herdr checks it (persist/agent_avatars.rs).
 const png = bytes.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b);
 const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
 if (!png && !jpeg) throw new AvatarBytesError("avatar is not an image");
 return `data:${png ? "image/png" : "image/jpeg"};base64,${base64}`;
}

/** desk_guest_invite.go shareRoute's details for the link's own agents, on its machine label; null
 *  for a federated peer's agent, which an owner browser can't invite to (PEER_NOT_SHARED). */
function shareDetails(agent: AgentInfo, name: string, hostLabel: string): GuestShareDetails | null {
 const machine = agent.machine_id ?? "";
 if (machine !== "" && (agent.pane_id ?? "").startsWith(machine + "/")) return null;
 return { agentName: name, machineLabel: hostLabel };
}

/** The link's machine as its guests see it (desk_web_access.go machineLabel): the label sealed in
 *  the browser's approval as herdr takes it (shareLabel; an approval sealed before the desktop
 *  bounded it may carry more than herdr's 64 characters), else the machine's herdr host id. */
function linkShareLabel(l: Active): string {
 return shareLabel(l.access.machineLabel) || (l.owner?.hostID ?? "");
}


/** The page's Desk storage: IndexedDB for the key and the grant. */
export function browserEnv(): DeskEnv {
 return {
  identities: new IndexedDBIdentityStore(),
  grants: new IndexedDBGrantStore(),
  owner: localOwnerHint,
 };
}
