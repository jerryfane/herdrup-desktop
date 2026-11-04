// The browser Gram's pure logic against the Go it ports: upload pieces and resume, download offset
// checks, the save-size decision, the agent prompt, list merging and the composer's send rules.
import { expect, test } from "bun:test";
import { HerdrAPIError, rateLimited } from "../src/webguest/errors";
import { type Attachment, Composer, fromBase64, gramAttachment, paneAttachmentPrompt, SendError, skipNote, toBase64, Uploader, uploadBlob, uploadPieces, UPLOAD_CHUNK_BYTES } from "../src/web/gramCompose";
import { BLOB_SAVE_MAX_BYTES, DOWNLOAD_CHUNK_BYTES, FILE_DATA_ERROR, type FileChunk, openPlan, readChunks, savePlan } from "../src/web/gramFiles";
import { type GramInfo, guestGramPage, Inbox, projectGuestPage } from "../src/web/gramInbox";

const data = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);

test("uploads are 48 KiB pieces, an empty file one empty piece", () => {
 expect(UPLOAD_CHUNK_BYTES).toBe(49152);
 expect(uploadPieces(0)).toEqual([[0, 0]]);
 expect(uploadPieces(10, 4)).toEqual([[0, 4], [4, 4], [8, 2]]);
 expect(uploadPieces(8, 4)).toEqual([[0, 4], [4, 4]]);
});

test("uploadBlob sends every piece at its offset and resends only a piece the relay refused", async () => {
 const bytes = data(10);
 const got: { offset: number; data: number[] }[] = [];
 let refuse = 1;
 const progress: number[] = [];
 const id = await uploadBlob(async (method, params) => {
  expect(method).toBe("gram.upload_chunk");
  const p = params as { upload_id: string; offset: number; data_base64: string };
  expect(p.upload_id).toStartWith("web-");
  if (p.offset === 4 && refuse-- > 0) throw rateLimited();
  got.push({ offset: p.offset, data: [...fromBase64(p.data_base64)!] });
  return { type: "ok" };
 }, new Blob([bytes]), new AbortController().signal, sent => progress.push(sent), { chunk: 4, backoffMs: () => 1 });
 expect(id).toStartWith("web-");
 expect(got.map(g => g.offset)).toEqual([0, 4, 8]);
 expect(got.flatMap(g => g.data)).toEqual([...bytes]);
 expect(progress).toEqual([4, 8, 10]);
 // Any other failure ends the upload at once.
 let calls = 0;
 const failed = await uploadBlob(async () => { calls++; throw new HerdrAPIError("invalid_params", "bad", {}); }, new Blob([bytes]), new AbortController().signal, () => {}, { chunk: 4 }).catch(e => e);
 expect(failed).toBeInstanceOf(HerdrAPIError);
 expect(calls).toBe(1);
});

function chunks(bytes: Uint8Array, piece = DOWNLOAD_CHUNK_BYTES, tamper?: (c: FileChunk) => FileChunk) {
 const asked: number[] = [];
 return { asked, fetch: async (offset: number) => {
  asked.push(offset);
  const c = { data_base64: toBase64(bytes.subarray(offset, offset + piece)), mime: "image/png", name: "a.png", offset, sha256: "", size: bytes.length };
  return tamper ? tamper(c) : c;
 } };
}

test("readChunks asks each next offset and rejects a chunk at another offset, size or past the end", async () => {
 const bytes = data(DOWNLOAD_CHUNK_BYTES * 2 + 5);
 const src = chunks(bytes);
 const parts: Uint8Array[] = [];
 const meta = await readChunks(src.fetch, 0, p => { parts.push(p); }, () => {});
 expect(meta).toEqual({ name: "a.png", mime: "image/png" });
 expect(src.asked).toEqual([0, DOWNLOAD_CHUNK_BYTES, DOWNLOAD_CHUNK_BYTES * 2]);
 expect(new Uint8Array(await new Blob(parts).arrayBuffer())).toEqual(bytes);
 const bad = (tamper: (c: FileChunk) => FileChunk, expected = bytes.length) => readChunks(chunks(bytes, DOWNLOAD_CHUNK_BYTES, tamper).fetch, expected, () => {}, () => {}).then(() => "ok", (e: Error) => e.message);
 expect(await bad(c => ({ ...c, offset: c.offset + 1 }))).toBe(FILE_DATA_ERROR);
 expect(await bad(c => c, bytes.length + 1)).toBe(FILE_DATA_ERROR);
 expect(await bad(c => (c.offset > 0 ? { ...c, size: c.size + 1 } : c))).toBe(FILE_DATA_ERROR);
 expect(await bad(c => ({ ...c, data_base64: "" }))).toBe(FILE_DATA_ERROR);
 expect(await bad(c => ({ ...c, data_base64: "not base64!" }))).toBe(FILE_DATA_ERROR);
 // A last piece longer than what remains overruns the file.
 const short = data(10);
 expect(await readChunks(async () => ({ data_base64: toBase64(data(11)), mime: "", name: "", offset: 0, sha256: "", size: 10 }), 0, () => {}, () => {}).then(() => "ok", (e: Error) => e.message)).toBe(FILE_DATA_ERROR);
 expect(short.length).toBe(10);
});

test("a save streams where it can, else is held in memory only up to the cap, decided before it starts", () => {
 expect(BLOB_SAVE_MAX_BYTES).toBe(200_000_000);
 expect(savePlan(BLOB_SAVE_MAX_BYTES + 1, true)).toEqual({ kind: "stream" });
 expect(savePlan(BLOB_SAVE_MAX_BYTES, false)).toEqual({ kind: "blob" });
 expect(savePlan(BLOB_SAVE_MAX_BYTES + 1, false).kind).toBe("too-large");
 expect(savePlan(11, false, 10).kind).toBe("too-large");
 expect(openPlan("a.png", "image/png", 100)).toBe("image");
 expect(openPlan("a.svg", "image/svg+xml", 100)).toBe("save");
 expect(openPlan("run.sh", "text/x-sh", 100)).toBe("save");
 expect(openPlan("notes.txt", "text/plain", 100)).toBe("text");
 expect(openPlan("a.html", "text/html", 100)).toBe("save");
});

test("paneAttachmentPrompt names each posted Gram and where get-file puts it", () => {
 expect(paneAttachmentPrompt("look", [{ name: "Shot.PNG", isImage: true, messageID: "m1" }])).toBe(
  "look\n\n[Photo attached via Herdr Gram message m1. Download it with `herdr gram get-file m1 -o /tmp/herdr-photo-m1.png`, then inspect /tmp/herdr-photo-m1.png.]");
 expect(paneAttachmentPrompt("  ", [{ name: "noext", isImage: false, messageID: "m2" }])).toBe(
  "[File noext attached via Herdr Gram message m2. Download it with `herdr gram get-file m2 -o /tmp/herdr-file-m2`, then inspect /tmp/herdr-file-m2.]");
 expect(paneAttachmentPrompt("", [{ name: "a.t-x.t", isImage: false, messageID: "a" }, { name: "b.c", isImage: true, messageID: "b" }])).toBe(
  "[2 files attached via Herdr Gram. Download them with:\n`herdr gram get-file a -o /tmp/herdr-file-a.t`  (a.t-x.t)\n`herdr gram get-file b -o /tmp/herdr-photo-b.c`  (b.c)\nthen inspect /tmp/herdr-file-a.t, /tmp/herdr-photo-b.c.]");
 expect(skipNote(["big.iso"], 2)).toBe("Skipped: too large or unreadable: big.iso; 2 over the 10-file limit.");
});

const msg = (id: string, read = false): GramInfo => ({ id, direction: "agent_to_owner", from: "docs", text: id, createdUnixMs: 1, readByOwner: read });

test("the unread walk stops on a cursor that does not advance and keeps pages read before a failure", async () => {
 const page = (ids: string[], more: boolean) => ({ messages: ids.map(id => ({ id, direction: "agent_to_owner", from: "d", text: "", created_unix_ms: 1, read: false })), has_more: more });
 const limits: number[] = [];
 const stuck = await guestGramPage(async (limit, before) => { limits.push(limit); return before ? page(["b", "a"], true) : page(["c", "a"], true); }, 0, true);
 expect(stuck.page.messages.map(m => m.id)).toEqual(["c", "a"]);
 expect(limits).toEqual([100, 100]);
 const failed = await guestGramPage(async (_l, before) => { if (before === "b") throw new Error("down"); return before ? page(["b"], true) : page(["a"], true); }, 900, true);
 expect(failed.page.messages.map(m => m.id)).toEqual(["a", "b"]);
 expect(failed.page.has_more).toBe(true);
 expect(failed.error).toBeInstanceOf(Error);
 const projected = projectGuestPage({ messages: [{ id: "x", direction: "owner_to_agent", from: "visitor", text: "", created_unix_ms: 1, read: true }, page(["y"], false).messages[0]!], has_more: false }, "docs", true);
 expect(projected.messages.map(m => m.id)).toEqual(["y"]);
});

test("a read this device made outlives an older answer; a stale older page is dropped", () => {
 const inbox = new Inbox();
 expect(inbox.apply({ messages: [msg("b"), msg("a")], hasMore: true }, 0)).toBe(true);
 const asked = inbox.readStamp;
 inbox.markRead("b");
 inbox.apply({ messages: [msg("b"), msg("a")], hasMore: true }, asked);
 expect(inbox.messages.map(m => m.readByOwner)).toEqual([true, false]);
 expect(inbox.unreadCount()).toBe(1);
 expect(inbox.nextCursor()).toBe("a");
 const generation = inbox.generation;
 expect(inbox.appendPage({ messages: [msg("a"), msg("z")], hasMore: false }, generation, inbox.readStamp)).toBe(true);
 expect(inbox.messages.map(m => m.id)).toEqual(["b", "a", "z"]);
 expect(inbox.nextCursor()).toBe("");
 inbox.apply({ messages: [msg("c"), msg("b", true)], hasMore: true }, inbox.readStamp);
 expect(inbox.appendPage({ messages: [msg("q")], hasMore: false }, generation, inbox.readStamp)).toBe(false);
});

const file = (path: string, n = 10): Attachment => ({ path, name: path, mime: "application/octet-stream", isImage: false, size: n, blob: new Blob([data(n)]) });

test("a post refused for a lost upload uploads once more; upload_in_progress posts again without uploading", async () => {
 let uploads = 0;
 const c = new Composer(async () => "up" + ++uploads, () => {}, () => {});
 c.retryDelayMs = 1;
 c.add([file("a"), file("b")]);
 const posts: string[] = [];
 let lost = true, busy = 1;
 await c.send("hi", ["a", "b"], async (text, a) => {
  posts.push(`${a!.path}:${a!.uploadID}:${text}`);
  if (a!.path === "a" && lost) { lost = false; throw new HerdrAPIError("invalid_params", "no staged upload for id", {}); }
  if (a!.path === "b" && busy-- > 0) throw new HerdrAPIError("upload_in_progress", "busy", {});
  return "m-" + a!.path;
 });
 expect(posts).toEqual(["a:up1:hi", "a:up3:hi", "b:up2:", "b:up2:"]);
 expect(uploads).toBe(3);
 expect(c.paths()).toEqual([]);
});

test("a failed file stays for a retry and the note counts what was sent", async () => {
 const c = new Composer(async a => "u-" + a.path, () => {}, () => {});
 c.add([file("a"), file("b")]);
 const error = await c.send("", ["a", "b"], async (_t, a) => { if (a!.path === "b") throw new HerdrAPIError("gram_full", "Gram is full", {}); return "m"; }).catch(e => e);
 expect(error).toBeInstanceOf(SendError);
 expect((error as SendError).note).toBe("Sent 1 of 2. Gram is full");
 expect(c.paths()).toEqual(["b"]);
 expect(c.chip("b")?.label).toBe("Failed · tap send to retry");
 // Sending again posts only b, on its finished upload.
 const again: string[] = [];
 await c.send("", ["b"], async (_t, a) => { again.push(a!.uploadID!); return "m2"; });
 expect(again).toEqual(["u-b"]);
});

test("removing a file cancels its upload, and one that finished is discarded on herdr", async () => {
 const discarded: string[] = [];
 const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
 let aborted = false;
 const u = new Uploader(async (a, _p, signal) => {
  if (a.path === "slow") { signal.addEventListener("abort", () => { aborted = true; gate.resolve(); }); started.resolve(); await gate.promise; throw signal.reason; }
  return "id-" + a.path;
 }, id => discarded.push(id), () => {});
 u.start(file("done"));
 expect(await u.wait("done")).toEqual({ id: "id-done", ok: true });
 u.start(file("slow"));
 await started.promise;
 expect(u.phase("slow")?.kind).toBe("uploading");
 u.remove(file("slow"));
 await gate.promise;
 expect(aborted).toBe(true);
 u.remove(file("done"));
 expect(discarded).toEqual(["id-done"]);
});

test("a chip shows percent while uploading and failure as tap to retry", () => {
 const a = file("x", 2048);
 expect(gramAttachment(a, { kind: "uploading", sent: 512, total: 2048 })).toMatchObject({ label: "25% · 2 KB", fraction: 0.25, determinate: true });
 expect(gramAttachment(a, { kind: "uploadFailed", sent: 0, total: 0 })).toMatchObject({ label: "Upload failed · tap to retry", failed: true });
});

// #610 security review (herdr-app 392335): a guest's file may come without mime (HerdrKit
// GuestGram.swift); one such file must not stop the feed from projecting.
test("a guest file without mime projects as application/octet-stream", () => {
 const file = { name: "log.txt", size: 10, sha256: "" };
 const { messages } = projectGuestPage({ messages: [
  { id: "a", direction: "agent_to_owner", from: "docs", text: "", created_unix_ms: 1, read: false, file },
  { id: "b", direction: "agent_to_owner", from: "docs", text: "", created_unix_ms: 2, read: false, expired_file: file },
 ], has_more: false }, "docs", false);
 expect(messages.map(m => (m.file ?? m.expiredFile)!.mime)).toEqual(["application/octet-stream", "application/octet-stream"]);
 expect(messages[0]!.file!.name).toBe("log.txt");
});
