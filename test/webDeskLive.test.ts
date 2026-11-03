// The browser Desk end to end against cmd/fakeherdr -interactions -guest-relay: redeem the logged
// invitation, list the shared agent (state and board events as desk_guest.go publishes them),
// open it, send a prompt, read the transcript, watch the terminal, press a menu key, and pause.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { MemoryIdentityStore } from "../src/webguest/identity";
import { createGuestDesk } from "../src/web/desk";
import { events } from "../src/web/events";
import { MemoryGrantStore, MemoryOwnerHint } from "../src/web/storage";
import type { BoardUpdate, ConnState, TerminalEvent } from "../src/mygo";

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
 fakeherdr = Bun.spawn([binary, "-listen", "127.0.0.1:0", "-client-key", join(dir, "client.key"), "-interactions", "-guest-relay", "127.0.0.1:0", "-guest-pause-file", join(dir, "paused")], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
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
 const desk = createGuestDesk({ identities: new MemoryIdentityStore(), grants, owner, webSocket: (url) => new WebSocket(url) });
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
 const before = JSON.parse(await desk.chatTranscript("view-1", "", "", ""));
 expect(Array.isArray(before.entries)).toBe(true);
 expect(before.type).toBeUndefined();
 const receipt = JSON.parse(await desk.chatPrompt("view-1", "hello from the browser"));
 expect(["submitted", "written_to_pty", "delivered"]).toContain(receipt.delivery);
 const after = await desk.chatTranscript("view-1", "", "", "");
 expect(after).toContain("hello from the browser");

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
 await expect(desk.chatTranscript("view-1", "", "", "")).rejects.toThrow("agent view changed; request was not sent");
}, 120_000);
