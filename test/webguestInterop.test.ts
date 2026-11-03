// The web guest against the Go side over a real WebSocket: cmd/fakeherdr -guest-relay serves the
// relay socket and herdr's guest gate with flynn/noise (internal/fakeherdr/guestrelay.go), and logs
// a one-use herdrup://guest-invite# link. The TS client redeems it and makes calls as a guest.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, staticKey } from "../src/webguest/identity";
import { parseInvite } from "../src/webguest/invite";
import { acceptInvite, GuestTransport } from "../src/webguest/transport";
import type { Subprocess } from "bun";

const go = Bun.which("go");
const repo = join(import.meta.dir, "..");
let dir = "";
let fakeherdr: Subprocess<"ignore", "ignore", "pipe"> | undefined;
let inviteLink = "";

beforeAll(async () => {
 if (go === null) return;
 dir = mkdtempSync(join(tmpdir(), "webguest-interop-"));
 const binary = join(dir, "fakeherdr");
 const build = Bun.spawnSync([go, "build", "-o", binary, "./cmd/fakeherdr"], { cwd: repo, env: { ...process.env, CGO_ENABLED: "0" }, stderr: "pipe" });
 if (build.exitCode !== 0) throw new Error("go build ./cmd/fakeherdr: " + build.stderr.toString());
 fakeherdr = Bun.spawn([binary, "-listen", "127.0.0.1:0", "-client-key", join(dir, "client.key"), "-interactions", "-guest-relay", "127.0.0.1:0"], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
 // The relay logs its invitation once it listens. Its stderr is read for as long as it runs:
 // closing the pipe would end it with SIGPIPE at its next log line.
 const found = Promise.withResolvers<string>();
 void (async () => {
  let log = "";
  const decoder = new TextDecoder();
  for await (const chunk of fakeherdr!.stderr) {
   log += decoder.decode(chunk, { stream: true });
   const match = /herdrup:\/\/guest-invite#[A-Za-z0-9_-]+/.exec(log);
   if (match !== null) found.resolve(match[0]);
  }
  found.reject(new Error("fakeherdr exited without an invitation:\n" + log));
 })();
 inviteLink = await found.promise;
}, 180_000);

afterAll(() => {
 fakeherdr?.kill();
 if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

test.skipIf(go === null)("the web guest redeems a Go relay's invitation and calls ping, agent.list and pane.stream", async () => {
 const invite = parseInvite(inviteLink, Date.now());
 expect(invite.endpoint.relay).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
 const identity = staticKey(await generateIdentity());
 const access = await acceptInvite(invite, identity, "Browser", { webSocket: (url) => new WebSocket(url) });
 expect([access.guestID, access.agentTarget, access.agentName, access.ownerName, access.machineLabel, access.guestName]).toEqual(["fake-guest-1", "t2", "docs", "Fixture Owner", "fakeherdr", "visitor"]);

 // The invitation is one-use, and only this browser's key is the guest.
 const reuse = await acceptInvite(invite, staticKey(await generateIdentity()), "Browser").catch((error: Error) => error.message);
 expect(reuse).toBe("This invitation was already used. Ask the owner for a new one.");
 const stranger = new GuestTransport(access, staticKey(await generateIdentity()));
 expect(await stranger.call("ping").catch((error: Error) => error.message)).toBe("This shared access is no longer available. Ask the owner for a new invitation.");

 const transport = new GuestTransport(access, identity);
 const pong = await transport.call("ping");
 expect(pong).toMatchObject({ type: "pong", version: "fake" });
 const list = await transport.call("agent.list") as { type: string; agents: { terminal_id: string }[] };
 expect(list.type).toBe("agent_list");
 expect(list.agents.map((agent) => agent.terminal_id)).toContain("t2");
 // A streaming call keeps its socket: the start, then the terminal's frames as they come.
 const stream = await transport.openStream("pane.stream", { pane_id: "t2" });
 const started = JSON.parse((await stream.next())!) as { id: string; result: { type: string } };
 expect(started.id).toMatch(/^herdrup:guest:\d+$/);
 expect(started.result.type).toBe("stream_started");
 expect(JSON.parse((await stream.next())!)).toMatchObject({ stream: "pane.bytes", frame: "reset" });
 stream.close();
 transport.close();
}, 60_000);
