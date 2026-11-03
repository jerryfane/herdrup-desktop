// gramDesk over a scripted WebLink: the review's regressions on the browser Gram (PR #118 L3 review).
import { afterEach, expect, test } from "bun:test";
import { fileForPath, registerFiles } from "../src/web/files";
import { gramDesk, panePromptAttachments } from "../src/web/gram";
import { Composer } from "../src/web/gramCompose";
import { toBase64 } from "../src/web/gramCompose";
import { DOWNLOAD_CHUNK_BYTES } from "../src/web/gramFiles";
import { setLink, type WebLink } from "../src/web/link";
import { setSharedAgents, setView } from "../src/web/view";
import type { GuestAccess } from "../src/web/link";

const access: GuestAccess = {
 guestID: "g1", guestName: "visitor", machineLabel: "box", ownerName: "Owner", agentName: "docs", agentTarget: "t1",
 endpoint: { relay: "wss://relay.invalid", hostID: "h", hostPublicKey: new Uint8Array(32) }, acceptedAt: "2026-11-03T00:00:00Z",
} as GuestAccess;

function fakeLink(handle: (method: string, params: Record<string, unknown>) => unknown): WebLink {
 return {
  access,
  features: () => ({ gram: true, push: false }),
  call: async <T>(method: string, params?: unknown) => handle(method, (params ?? {}) as Record<string, unknown>) as T,
  stream: () => { throw new Error("no streams"); },
 };
}

afterEach(() => { setView(null); setLink(null); setSharedAgents([]); });

test("a sent caption counts as posted, so the page clears it and a retry never sends it again", async () => {
 const c = new Composer(async a => "u-" + a.path, () => {}, () => {});
 const file = (path: string) => ({ path, name: path, mime: "text/plain", isImage: false, size: 1, blob: new Blob(["x"]) });
 c.add([file("a"), file("b")]);
 const posts: string[] = [];
 await c.send("caption", ["a", "b"], async (text, a) => {
  posts.push(a!.path + ":" + text);
  if (a!.path === "b") throw new Error("down");
  return "m-" + a!.path;
 }).catch(() => {});
 expect(c.snapshot().draftPosted).toBe(1);
 // The page cleared its draft (draftPosted moved) and sends again with what it now holds.
 await c.send("", ["b"], async (text, a) => { posts.push(a!.path + ":" + text); return "m-b"; });
 expect(posts).toEqual(["a:caption", "b:", "b:"]);
 expect(c.paths()).toEqual([]);
});

test("a preview of a file listed with an unknown size stops at the first chunk past the preview cap", async () => {
 const big = 16 << 20;
 let chunks = 0;
 setLink(fakeLink((method, params) => {
  if (method === "gram.list") return { messages: [{ id: "m1", direction: "agent_to_owner", from: "docs", text: "", created_unix_ms: 1, read: true, file: { name: "a.png", mime: "image/png", size: 0, sha256: "" } }], has_more: false };
  if (method === "gram.get_file_chunk") {
   chunks++;
   const offset = params.offset as number;
   return { data_base64: toBase64(new Uint8Array(Math.min(DOWNLOAD_CHUNK_BYTES, big - offset))), mime: "image/png", name: "a.png", offset, sha256: "", size: big };
  }
  throw new Error("unexpected " + method);
 }));
 await gramDesk.gramSetVisible!(true);
 await gramDesk.gramRefresh!();
 expect((await gramDesk.gramState!()).messages[0]?.file?.preview).toBe(true);
 const result = await gramDesk.gramImage!("m1").then(() => "previewed", (e: Error) => e.message);
 expect(result).toBe("a.png has no preview");
 expect(chunks).toBe(1);
 await gramDesk.gramSetVisible!(false);
});

test("pane attachments release their browser Files once sent", async () => {
 setSharedAgents([{ pane_id: "p1", name: "docs" }]);
 setLink(fakeLink(method => {
  if (method === "gram.upload_chunk") return { type: "ok" };
  if (method === "gram.post") return { message: { id: "posted-1" } };
  if (method === "gram.list") return { messages: [], has_more: false };
  throw new Error("unexpected " + method);
 }));
 const life = new AbortController();
 setView({ token: "v1", paneID: "p1", signal: life.signal });
 const [sent] = registerFiles([new File(["hello"], "a.txt", { type: "text/plain" })]);
 await gramDesk.paneAttachFiles!("v1", [sent!]);
 expect(await panePromptAttachments("v1", "look", async () => "ok")).toBe("ok");
 expect(fileForPath(sent!)).toBeUndefined();
 // A file staged and then left when the view closes is released too, and so is one never staged.
 const [left, empty] = registerFiles([new File(["x"], "b.txt"), new File([], "empty.txt")]);
 await gramDesk.paneAttachFiles!("v1", [left!, empty!]);
 expect(fileForPath(empty!)).toBeUndefined();
 life.abort();
 expect(fileForPath(left!)).toBeUndefined();
});
