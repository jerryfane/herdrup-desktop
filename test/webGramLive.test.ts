// The browser Gram over the real guest transport: cmd/fakeherdr -guest-relay -guest-gram serves the
// relay and herdr's guest gate with Gram shared. A multi-chunk file goes up through gramDesk's
// composer (48 KiB gram.upload_chunk pieces) and the pane composer, and comes back byte-identical
// through 512 KiB gram.get_file_chunk pieces.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { generateIdentity, staticKey } from "../src/webguest/identity";
import { parseInvite } from "../src/webguest/invite";
import { acceptInvite, GuestTransport } from "../src/webguest/transport";
import { setLink, transportLink } from "../src/web/link";
import { setSharedAgents, setView } from "../src/web/view";
import { registerFiles } from "../src/web/files";
import { events } from "../src/web/events";
import { gramDesk, panePromptAttachments } from "../src/web/gram";
import { fromBase64 } from "../src/web/gramCompose";
import { readChunks, type FileChunk } from "../src/web/gramFiles";
import type { GramSnapshot } from "../src/mygo";

const go = Bun.which("go");
const repo = join(import.meta.dir, "..");
let dir = "";
let fakeherdr: Subprocess<"ignore", "ignore", "pipe"> | undefined;
let inviteLink = "";

beforeAll(async () => {
 if (go === null) return;
 dir = mkdtempSync(join(tmpdir(), "webgram-live-"));
 const binary = join(dir, "fakeherdr");
 const build = Bun.spawnSync([go, "build", "-o", binary, "./cmd/fakeherdr"], { cwd: repo, env: { ...process.env, CGO_ENABLED: "0" }, stderr: "pipe" });
 if (build.exitCode !== 0) throw new Error("go build ./cmd/fakeherdr: " + build.stderr.toString());
 fakeherdr = Bun.spawn([binary, "-listen", "127.0.0.1:0", "-client-key", join(dir, "client.key"), "-interactions", "-guest-relay", "127.0.0.1:0", "-guest-gram"], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
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
 setLink(null);
 fakeherdr?.kill();
 if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

function bytes(n: number, seed: number): Uint8Array<ArrayBuffer> {
 const out = new Uint8Array(n);
 let x = seed;
 for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = x >>> 24; }
 return out;
}

test.skipIf(go === null)("a multi-chunk file uploads through the Gram and pane composers and downloads back identical", async () => {
 const identity = staticKey(await generateIdentity());
 const access = await acceptInvite(parseInvite(inviteLink, Date.now()), identity, "Browser", { webSocket: url => new WebSocket(url) });
 const transport = new GuestTransport(access, identity);
 const link = transportLink({ ...access, acceptedAt: access.acceptedAt.toISOString() }, transport);
 await link.call("ping");
 expect(link.features().gram).toBe(true);
 const agents = await link.call<{ agents: { pane_id: string; name?: string }[] }>("agent.list");
 setSharedAgents(agents.agents);
 const snaps: GramSnapshot[] = [];
 const stop = events.gramChanged.on(s => { snaps.push(s); });
 setLink(link);

 // Gram: 1.2 MB is 25 upload chunks and 3 download chunks.
 const data = bytes(1_200_000, 7);
 const [path] = registerFiles([new File([data], "photo.png", { type: "image/png" })]);
 expect(await gramDesk.gramAttachFiles!([path!])).toEqual([path!]);
 await gramDesk.gramPost!("here it is", [], [path!]);
 const state = await gramDesk.gramState!();
 const posted = state.messages.find(m => m.file?.name === "photo.png");
 expect(posted?.text).toBe("here it is");
 expect(posted?.file?.size).toBe(data.length);
 expect(posted?.to).toBe("docs");
 expect(state.attachments).toEqual([]);
 expect(snaps.some(s => s.sending)).toBe(true);
 const url = await gramDesk.gramImage!(posted!.id);
 expect(url.startsWith("data:image/png;base64,")).toBe(true);
 expect(fromBase64(url.slice("data:image/png;base64,".length))).toEqual(data);

 // The pane composer: posted as the guest's attachment, then the prompt names its message.
 const pane = agents.agents.find(a => a.name)!;
 const life = new AbortController();
 setView({ token: "view-1", paneID: pane.pane_id, signal: life.signal });
 const doc = bytes(150_000, 11);
 const [docPath] = registerFiles([new File([doc], "notes.bin", { type: "application/octet-stream" })]);
 await gramDesk.paneAttachFiles!("view-1", [docPath!]);
 let prompt = "";
 const receipt = await panePromptAttachments("view-1", "look", async p => { prompt = p; return "sent"; });
 expect(receipt).toBe("sent");
 const id = /Herdr Gram message (\S+)\./.exec(prompt)?.[1];
 expect(prompt).toStartWith("look\n\n[File notes.bin attached via Herdr Gram message ");
 const parts: Uint8Array[] = [];
 const meta = await readChunks(offset => link.call<FileChunk>("gram.get_file_chunk", { id, offset }), doc.length, p => { parts.push(p); }, () => undefined);
 expect(meta.name).toBe("notes.bin");
 expect(new Uint8Array(await new Blob(parts).arrayBuffer())).toEqual(doc);
 expect(panePromptAttachments("view-1", "again", async () => "x")).toBeNull();
 life.abort();
 stop();
}, 120_000);
