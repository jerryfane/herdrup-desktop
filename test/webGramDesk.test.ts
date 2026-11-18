// gramDesk over a scripted WebLink: the review's regressions on the browser Gram (PR #118 L3 review).
import { afterEach, expect, jest, test } from "bun:test";
import { events } from "../src/web/events";
import { fileForPath, registerFiles } from "../src/web/files";
import { GRAM_POLL_BADGE_MS, gramDesk, guestGramDesk, panePromptAttachments } from "../src/web/gram";
import { Composer } from "../src/web/gramCompose";
import { toBase64 } from "../src/web/gramCompose";
import { HerdrAPIError } from "../src/webguest/errors";
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

// Reviews of #201 and #203: a Chat attachment names its file by Gram message id only, so it must
// open whether or not Gram has loaded that message; herdr's first chunk gives its name and size.
// This host refuses gram.list, so Gram never holds the message. That chunk can outlast the click's
// user activation, so a save never waits on a picker (Chromium refuses it then): the file
// downloads in memory, reusing the chunk already read. A failure stays out of Gram's banner.
test("a Chat attachment saves a file whose message Gram never loaded, without a picker", async () => {
 const pdf = new Uint8Array(DOWNLOAD_CHUNK_BYTES + 10).map((_, i) => i % 251);
 const offsets: number[] = [];
 let refuse = false;
 setLink(fakeLink((method, params) => {
  if (method !== "gram.get_file_chunk" || params.id !== "gram-doc") throw new Error("unexpected " + method);
  if (refuse) throw new HerdrAPIError("guest_forbidden", "attachment no longer shared", null);
  const offset = params.offset as number;
  offsets.push(offset);
  return { data_base64: toBase64(pdf.slice(offset, offset + DOWNLOAD_CHUNK_BYTES)), mime: "application/pdf", name: "report.pdf", offset, sha256: "", size: pdf.length };
 }));
 // A picker now would be refused, as Chromium refuses one after activation has expired.
 Reflect.set(globalThis, "showSaveFilePicker", async () => { throw new DOMException("Must be handling a user gesture to show a file picker.", "SecurityError"); });
 const saved: { name: string; blob: Blob }[] = [];
 const blobs = new Map<string, Blob>();
 const createObjectURL = URL.createObjectURL, revokeObjectURL = URL.revokeObjectURL;
 URL.createObjectURL = (blob: Blob) => { const url = "blob:test/" + blobs.size; blobs.set(url, blob); return url; };
 URL.revokeObjectURL = () => {};
 Reflect.set(globalThis, "document", { body: { append() {} }, createElement: () => {
  const a = { href: "", download: "", rel: "", remove() {}, click() { saved.push({ name: a.download, blob: blobs.get(a.href)! }); } };
  return a;
 } });
 try {
  await gramDesk.gramOpenAttachment!("gram-doc");
  expect(saved.map(s => s.name)).toEqual(["report.pdf"]);
  expect(new Uint8Array(await saved[0]!.blob.arrayBuffer())).toEqual(pdf);
  expect(offsets).toEqual([0, DOWNLOAD_CHUNK_BYTES]);
  refuse = true;
  await expect(gramDesk.gramOpenAttachment!("gram-doc")).rejects.toThrow("attachment no longer shared");
  expect((await gramDesk.gramState!()).status ?? "").toBe("");
 } finally {
  Reflect.deleteProperty(globalThis, "showSaveFilePicker"); Reflect.deleteProperty(globalThis, "document");
  URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL;
 }
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

// #230: the guest Gram's availability is published when the link's sharing changes, not only with
// the unread count: before admission the page saw Gram unshared, and a hidden badge read of an
// empty inbox publishes nothing, so the Gram tab would never appear.
test("Gram sharing that arrives after the page rendered is published while hidden, with nothing unread", async () => {
 jest.useFakeTimers();
 try {
  let gram = false;
  const link = fakeLink(method => {
   if (method === "gram.list") return { messages: [], has_more: false };
   throw new Error("unexpected " + method);
  });
  link.features = () => ({ gram, push: false });
  const seen: boolean[] = [];
  const off = events.guestGramChanged.on(s => seen.push(s.grants[0]?.grant.gram ?? false));
  setLink(link);
  expect((await guestGramDesk.guestGramState!()).grants[0]?.grant.gram).toBe(false);
  gram = true; // the admission's hello
  for (let i = 0; i < 3; i++) {
   jest.advanceTimersByTime(GRAM_POLL_BADGE_MS + 1);
   for (let j = 0; j < 20; j++) await Promise.resolve();
  }
  off();
  expect(seen).toContain(true);
 } finally {
  jest.useRealTimers();
 }
});

// herdrup #723: the page keys a file's transfer state by the id its downloads report
// ("<grant>\x1f<id>"). A Saved row must carry that same id, or the Saved file shows no progress
// and a second click while the first download runs starts another one.
test("a saved file's row carries the id its downloads report, and opens by it", async () => {
 const store = new Map<string, string>();
 (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
 try {
  const text = new TextEncoder().encode("report");
  setLink(fakeLink((method, params) => {
   if (method === "gram.list") return { messages: [{ id: "gram-file", direction: "agent_to_owner", from: "docs", text: "", created_unix_ms: 1, read: true, file: { name: "report.txt", mime: "text/plain", size: text.length, sha256: "" } }], has_more: false };
   if (method === "gram.get_file_chunk") return { data_base64: toBase64(text), mime: "text/plain", name: "report.txt", offset: params.offset as number, sha256: "", size: text.length };
   throw new Error("unexpected " + method);
  }));
  await gramDesk.gramSetVisible!(true);
  await gramDesk.gramRefresh!();
  const shown = (await guestGramDesk.guestGramState!()).grants[0]!.gram.messages[0]!.id;
  await gramDesk.gramSetSaved!(shown, true);
  const saved = (await guestGramDesk.guestGramState!()).saved;
  expect(saved.map(s => s.id)).toEqual([shown]);
  expect((await gramDesk.gramSaved!()).map(s => s.id)).toEqual([shown]);
  const reported: string[] = [];
  const off = events.gramDownload.on(ev => reported.push(ev.id));
  await gramDesk.gramOpenFile!(saved[0]!.id).catch(() => {});
  off();
  expect(reported.length).toBeGreaterThan(0);
  expect(new Set(reported)).toEqual(new Set([saved[0]!.id]));
  await gramDesk.gramSetSaved!(saved[0]!.id, false);
  expect((await guestGramDesk.guestGramState!()).saved).toEqual([]);
  await gramDesk.gramSetVisible!(false);
 } finally {
  delete (globalThis as { localStorage?: unknown }).localStorage;
 }
});
