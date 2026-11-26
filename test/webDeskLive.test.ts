// The browser Desk end to end against cmd/fakeherdr -interactions -guest-relay -guest-gram: redeem
// the logged invitation, list the shared agent (state and board events as desk_guest.go publishes
// them), open it, send a prompt, read the transcript, send to a topic (a file too), watch the
// terminal, press a menu key, and pause.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { MemoryIdentityStore } from "../src/webguest/identity";
import { createGuestDesk } from "../src/web/desk";
import { gramDesk, panePromptAttachments } from "../src/web/gram";
import { registerFiles } from "../src/web/files";
import { currentLink } from "../src/web/link";
import { readChunks, type FileChunk } from "../src/web/gramFiles";
import type { TranscriptPage } from "../src/interactionModel";
import { events } from "../src/web/events";
import { MemoryGrantStore, MemoryOwnerHint } from "../src/web/storage";
import type { BoardUpdate, ConnState, TerminalEvent, TopicsUpdate } from "../src/mygo";

const go = Bun.which("go");
const repo = join(import.meta.dir, "..");
let dir = "";
let fakeherdr: Subprocess<"ignore", "ignore", "pipe"> | undefined;
let invite = "";

beforeAll(async () => {
 if (go === null) return;
 dir = mkdtempSync(join(tmpdir(), "webdesk-live-"));
 const binary = join(dir, "fakeherdr");
 const build = Bun.spawnSync([go, "build", "-o", binary, "./cmd/fakeherdr"], { cwd: repo, env: { ...process.env, CGO_ENABLED: "0" }, stderr: "pipe" });
 if (build.exitCode !== 0) throw new Error("go build ./cmd/fakeherdr: " + build.stderr.toString());
 // A topic's turn runs past the test (-topics-turn): a message to the topic it just started is
 // queued however long the machine takes to get there (#540: at 2 s, a loaded run found it idle).
 fakeherdr = Bun.spawn([binary, "-listen", "127.0.0.1:0", "-client-key", join(dir, "client.key"), "-interactions", "-topics", "-topics-turn", "10m", "-guest-relay", "127.0.0.1:0", "-guest-gram", "-guest-pause-file", join(dir, "paused"), "-topics-list-fail-file", join(dir, "topics-fail")], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
 const found = Promise.withResolvers<string>();
 void (async () => {
  let log = "";
  for await (const chunk of fakeherdr!.stderr) {
   log += new TextDecoder().decode(chunk);
   const match = /herdrup:\/\/guest-invite#[A-Za-z0-9_-]+/.exec(log);
   if (match !== null) found.resolve(match[0]);
  }
  found.reject(new Error("fakeherdr exited without an invitation:\n" + log));
 })();
 invite = await found.promise;
}, 180_000);

afterAll(() => {
 fakeherdr?.kill();
 if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

/** The first payload of name's events that passes ok. */
function next<T>(on: (f: (v: T) => void) => () => void, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
 const { promise, resolve, reject } = Promise.withResolvers<T>();
 const timer = setTimeout(() => { off(); reject(new Error("no matching event")); }, ms);
 const off = on((v) => { if (ok(v)) { clearTimeout(timer); off(); resolve(v); } });
 return promise;
}

test.skipIf(go === null)("a browser guest redeems, lists, chats, watches and pauses through the relay", async () => {
 const grants = new MemoryGrantStore(), owner = new MemoryOwnerHint();
 const desk = createGuestDesk({ identities: new MemoryIdentityStore(), grants, owner, webSocket: (url) => new WebSocket(url), topicsRetryMs: [100] });
 const reviewed = await desk.inspectGuestInvitation(invite);
 expect(reviewed).toMatchObject({ ownerName: "Fixture Owner", agentName: "docs", guestName: "visitor" });
 const access = await desk.acceptGuestInvitation(invite);
 expect(grants.access?.guestID).toBe(access.guestID);
 expect(owner.owner).toBe("Fixture Owner");
 expect(await desk.sharedConnections()).toEqual([access]);

 const id = `${access.endpoint.hostID}/${access.guestID}`;
 const connected = next<ConnState>((f) => events.stateChanged.on(f), (s) => s.phase === "connected");
 const listed = next<BoardUpdate>((f) => events.boardChanged.on(f), () => true);
 await desk.connectGuest(id);
 const state = await connected, board = await listed;
 expect(state.guest?.fingerprint).toBe(reviewed.fingerprint);
 expect(state.guest?.availability).toBeUndefined();
 expect(board.machineID).toBe("guest:" + id);
 const row = board.board.sections.flatMap((s) => s.rows)[0]!;
 expect(row.title).toBe("docs");

 const view = await desk.openAgentView({ machineID: board.machineID, session: "", paneID: row.id }, "view-1");
 expect(view).toMatchObject({ guest: true, guestOwner: "Fixture Owner", name: "docs" });
 expect(await desk.guestChatAvailable("view-1")).toBe(true);
 const before = JSON.parse(await desk.chatTranscript("view-1", "", "", "", ""));
 expect(Array.isArray(before.entries)).toBe(true);
 expect(before.type).toBeUndefined();
 const receipt = JSON.parse(await desk.chatPrompt("view-1", "hello from the browser"));
 expect(["submitted", "written_to_pty", "delivered"]).toContain(receipt.delivery);
 const after = await desk.chatTranscript("view-1", "", "", "", "");
 expect(after).toContain("hello from the browser");
 // A tail read carries held_from through the guest gate (herdr #430).
 const tail = JSON.parse(await desk.chatTranscript("view-1", JSON.parse(after).after, "", "", ""));
 expect(Array.isArray(tail.entries)).toBe(true);

 // Topics through the gate (herdr #475): the list a guest polls, a start and a send labelled with
 // the guest's name, and the topic's own conversation.
 expect(await desk.topicsAvailable("view-1")).toBe(true);
 const listed1 = next<TopicsUpdate>((f) => events.topicsChanged.on(f), (u) => u.token === "view-1" && u.loaded);
 await desk.topicsFollow("view-1", true);
 const first = await listed1;
 expect(first).toMatchObject({ offered: true });
 expect(first.problem).toBeUndefined();
 expect(first.topics.map((t) => t.topic_id)).toEqual(["t1", "t2", "t3"]);
 const started = next<TopicsUpdate>((f) => events.topicsChanged.on(f), (u) => u.topics[0]?.title === "Guest topic");
 const topic = await desk.topicsNew("view-1", "Guest topic", "From the browser");
 expect((await started).topics[0]!.topic_id).toBe(topic);
 expect(await desk.topicsSend("view-1", topic, "And one more")).toEqual({ mode: "queued", delivery: "sent" });
 const conversation = await desk.topicTranscript("view-1", topic, "", "", "");
 expect(conversation).toContain("visitor (via HerdrUp): From the browser");
 expect(conversation).not.toContain("September minutes");
 // A send with a file from the page's composer, to an idle topic (its message starts a turn at
 // once): the file goes as the Inbox's do (posted to the agent as a Gram, panePromptAttachments),
 // and the topic's message is the Inbox's composed text naming it.
 const deck = Uint8Array.from({ length: 70_000 }, (_, i) => i % 251);
 const [deckPath] = registerFiles([new File([deck], "deck.bin", { type: "application/octet-stream" })]);
 await gramDesk.paneAttachFiles!("view-1", [deckPath!]);
 // #534: a caption already over the topic's cap is refused before the file is posted (no Gram for
 // a message that can't go), and the file stays for the next send.
 const grams = async () => (await currentLink()!.call<{ messages?: unknown[] }>("gram.list", { limit: 500 })).messages?.length ?? 0;
 const gramsBefore = await grams();
 expect(await desk.topicsSend("view-1", "t2", "x".repeat(32 * 1024 + 1))).toEqual({ mode: "", delivery: "refused", problem: "Messages are limited to 32 KB. Send it in parts." });
 expect(await grams()).toBe(gramsBefore);
 expect(await desk.topicsSend("view-1", "t2", "With the deck")).toEqual({ mode: "turn", delivery: "sent" });
 const withFile: TranscriptPage = JSON.parse(await desk.topicTranscript("view-1", "t2", "", "", ""));
 const sent = withFile.entries.map((e) => e.text ?? "").find((t) => t.includes("With the deck"));
 const gram = /With the deck\n\n\[File deck\.bin attached via Herdr Gram message (\S+)\./.exec(sent ?? "")?.[1];
 expect(gram).toBeDefined();
 const parts: Uint8Array[] = [];
 const meta = await readChunks((offset) => currentLink()!.call<FileChunk>("gram.get_file_chunk", { id: gram, offset }), deck.length, (p) => { parts.push(p); }, () => undefined);
 expect(meta.name).toBe("deck.bin");
 expect(new Uint8Array(await new Blob(parts).arrayBuffer())).toEqual(deck);
 // The file left the composer with the send.
 expect(panePromptAttachments("view-1", "again", async () => "x")).toBeNull();
 expect(await desk.topicsSend("view-1", "t3", "hi")).toEqual({ mode: "", delivery: "refused", problem: "The agent refused: the topic is closed" });
 await expect(desk.topicTranscript("view-1", "t99", "", "", "")).rejects.toThrow("This topic's conversation can't be found.");
 await desk.topicsFollow("view-1", false);

 // The open Inbox asks again after a list that failed for a passing reason (herdrup #796): here
 // topics_unreachable, as an omp agent answers while its topics are not reachable yet.
 writeFileSync(join(dir, "topics-fail"), "");
 await desk.topicsFollowInbox("view-1", true);
 const failed = next<TopicsUpdate>((f) => events.topicsChanged.on(f), (u) => u.token === "view-1" && !!u.problem);
 await desk.topicsRefresh("view-1");
 await failed;
 const recovered = next<TopicsUpdate>((f) => events.topicsChanged.on(f), (u) => u.token === "view-1" && !u.problem, 10_000);
 rmSync(join(dir, "topics-fail"));
 expect((await recovered).topics.length).toBeGreaterThan(0);
 await desk.topicsFollowInbox("view-1", false);

 const frame = next<TerminalEvent>((f) => events.terminalChanged.on(f), (e) => e.frame?.frame === "reset");
 await desk.startTerminal("view-1", "s1");
 expect((await frame).frame?.stream).toBe("pane.bytes");
 await expect(desk.terminalInput("view-1", "s1", "ls\r")).rejects.toThrow("input delivery uncertain; not resent");
 await desk.guestMenuKey("view-1", "Enter");
 await expect(desk.guestMenuKey("view-1", "x")).rejects.toThrow(`"x" is not a menu key`);
 await desk.stopTerminal("view-1", "s1");

 // The status poll lists again at once after a send (pollGuestStatus): paused while the file is there.
 writeFileSync(join(dir, "paused"), "");
 const paused = next<ConnState>((f) => events.stateChanged.on(f), (s) => s.guest?.availability === "paused", 30_000);
 await new Promise((r) => setTimeout(r, 1200));
 await desk.guestMenuKey("view-1", "Escape").catch(() => undefined);
 expect((await paused).phase).toBe("connected");
 rmSync(join(dir, "paused"));
 expect(existsSync(join(dir, "paused"))).toBe(false);

 const idle = next<ConnState>((f) => events.stateChanged.on(f), (s) => s.phase === "idle");
 await desk.forgetGuestConnection(id);
 await idle;
 expect(grants.access).toBeUndefined();
 await expect(desk.chatTranscript("view-1", "", "", "", "")).rejects.toThrow("agent view changed; request was not sent");
}, 120_000);
