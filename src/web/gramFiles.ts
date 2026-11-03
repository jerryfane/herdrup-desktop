// Gram file downloads in the browser, ported from desk_gram_files.go: gram.get_file_chunk pieces of
// 512 KiB with gramReadChunks' offset checks. Nothing downloaded is ever run: open is a save, or an
// in-page preview of a picture or plain text; every blob: URL is revoked once used.

import { MAX_FILE_BYTES, fromBase64 } from "./gramCompose";

/** gramPreviewMaxBytes and gramChunkBytes (desk_gram_files.go:30-33). */
export const PREVIEW_MAX_BYTES = 8 << 20;
export const DOWNLOAD_CHUNK_BYTES = 512 << 10;
/** The largest file saved without the File System Access API: the browser holds the whole file in
 *  memory first. Asked before the download starts. */
export const BLOB_SAVE_MAX_BYTES = 200 * 1000 * 1000;
/** The largest plain-text file opened as an in-page preview. */
export const TEXT_PREVIEW_MAX_BYTES = 2 << 20;

export const FILE_DATA_ERROR = "the server returned file data that could not be decoded";

/** herdrapi.ResponseResultGramFileChunk. */
export interface FileChunk { data_base64: string; mime: string; name: string; offset: number; sha256: string; size: number }

/** gramReadChunks (desk_gram_files.go:212-248): the file of size expected (0: unknown) piece by
 *  piece, each at the offset asked, of the file's one size, never past it; sink takes each piece. */
export async function readChunks(chunk: (offset: number) => Promise<FileChunk>, expected: number,
 sink: (piece: Uint8Array<ArrayBuffer>) => Promise<void> | void, progress: (done: number) => void, signal?: AbortSignal): Promise<{ name: string; mime: string }> {
 if (expected > MAX_FILE_BYTES) throw new Error(FILE_DATA_ERROR);
 const maxEncoded = Math.floor((DOWNLOAD_CHUNK_BYTES + 2) / 3) * 4;
 let size = expected, known = expected > 0, done = 0;
 for (;;) {
  signal?.throwIfAborted();
  const c = await chunk(done);
  if (c.size > MAX_FILE_BYTES || (known && c.size !== size) || c.offset !== done || c.data_base64.length > maxEncoded) throw new Error(FILE_DATA_ERROR);
  const b = fromBase64(c.data_base64);
  if (!b || (b.length === 0 && c.size !== done) || b.length > DOWNLOAD_CHUNK_BYTES || b.length > c.size - done) throw new Error(FILE_DATA_ERROR);
  if (!known) { size = c.size; known = true; }
  await sink(b);
  done += b.length;
  progress(done);
  if (done === size) return { name: c.name, mime: c.mime };
 }
}

/** How a save goes: through a file the person picked (File System Access), else assembled in memory
 *  for an <a download>, which a file over cap may not. */
export type SavePlan = { kind: "stream" } | { kind: "blob" } | { kind: "too-large"; note: string };
export function savePlan(size: number, canStream: boolean, cap = BLOB_SAVE_MAX_BYTES): SavePlan {
 if (canStream) return { kind: "stream" };
 if (size > cap) return { kind: "too-large", note: `This browser can't save files over ${Math.round(cap / 1e6)} MB. Use the herdrup app, or a browser that can save to a chosen file.` };
 return { kind: "blob" };
}

/** What open does in the browser: a preview in the page, else a save. */
export function openPlan(name: string, mime: string, size: number): "image" | "text" | "save" {
 const m = mime.toLowerCase();
 // SVG can carry script; it is saved, never drawn from a blob: in the page.
 if (m.startsWith("image/") && !m.includes("svg") && size <= PREVIEW_MAX_BYTES) return "image";
 if ((m.startsWith("text/plain") || /\.(txt|log|md|csv|json)$/i.test(name)) && size <= TEXT_PREVIEW_MAX_BYTES) return "text";
 return "save";
}

/** imageMime (desk_gram_files.go): mime as a data: URL may carry it. */
export function imageMime(mime: string): string {
 const base = (mime.split(";")[0] ?? "").trim().toLowerCase();
 return /^image\/[a-z0-9.+-]+$/.test(base) ? base : "application/octet-stream";
}
