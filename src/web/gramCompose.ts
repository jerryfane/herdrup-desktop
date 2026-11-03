// The Gram and pane composers in the browser, ported from internal/gramstore (composer.go,
// uploader.go, chips.go) and desk_gram_compose.go / desk_interaction_compose.go. A staged file is a
// browser File behind a page-local path (gramFiles.ts registerFiles); its bytes go to herdr as
// gram.upload_chunk pieces, one relay connect each.

import type { GramAttachment } from "../mygo";
import { GuestError, HerdrAPIError } from "../webguest/errors";

/** gramstore.MaxFileBytes and MaxAttachments (composer.go:17-20). */
export const MAX_FILE_BYTES = 100 << 20;
export const MAX_ATTACHMENTS = 10;
/** engine.UploadChunkBytes (internal/engine/streams.go:81): one gram.upload_chunk's bytes. */
export const UPLOAD_CHUNK_BYTES = 48 << 10;
/** PostAttempts and DefaultRetryDelay (composer.go:25-28). */
export const POST_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 1000;
/** Refused relay connects a chunk waits out before its upload fails (transport.go relayBackoff:
 *  15 s, 30 s, 60 s, 60 s: about 2.75 minutes of a full connect budget). */
export const UPLOAD_RATE_LIMIT_RETRIES = 4;

export interface Attachment {
 path: string;
 name: string;
 mime: string;
 isImage: boolean;
 size: number;
 blob: Blob;
 uploadID?: string;
 messageID?: string;
}

/** herdr's error code (link errors are HerdrAPIError, webguest/errors.ts). */
export function apiCode(error: unknown): string | undefined {
 return error instanceof HerdrAPIError ? error.code : undefined;
}
function apiMessage(error: unknown): string | undefined {
 return error instanceof HerdrAPIError ? error.apiMessage : undefined;
}
/** gramstore.IsStaleUpload: herdr has lost the staged upload. */
export function isStaleUpload(error: unknown): boolean {
 return apiCode(error) === "invalid_params" && (apiMessage(error) ?? "").includes("no staged upload");
}
const isUploadInProgress = (error: unknown) => apiCode(error) === "upload_in_progress";
export const isRateLimited = (error: unknown) => error instanceof GuestError && error.kind === "rate_limited";

export function abortError(signal?: AbortSignal): unknown {
 return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
/** ms, or less when signal aborts (then rejecting with its reason). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
 const { promise, resolve, reject } = Promise.withResolvers<void>();
 if (signal?.aborted) { reject(abortError(signal)); return promise; }
 const stop = () => { clearTimeout(timer); reject(abortError(signal)); };
 const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
 signal?.addEventListener("abort", stop, { once: true });
 return promise;
}

/** gramstore.DisplaySize: "N B", "N KB" or "N.N MB". */
export function displaySize(size: number): string {
 if (size < 1024) return `${size} B`;
 if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
 return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** gramstore.SafeFileName: the last path element, backslashes replaced, never "", "." or "..". */
export function safeFileName(name: string): string {
 let base = name.replace(/\/+$/, "");
 base = base.slice(base.lastIndexOf("/") + 1).replaceAll("\\", "_").trim();
 return base === "" || base === "." || base === ".." ? "file" : base;
}

/** gramstore.SkipNote. */
export function skipNote(bad: string[], capped: number): string {
 const parts: string[] = [];
 if (bad.length) parts.push("too large or unreadable: " + bad.join(", "));
 if (capped > 0) parts.push(`${capped} over the ${MAX_ATTACHMENTS}-file limit`);
 return parts.length ? "Skipped: " + parts.join("; ") + "." : "";
}

/** gramstore.ProgressNote. */
export function progressNote(reason: string, delivered: number, total: number): string {
 return total <= 1 || delivered <= 0 ? reason : `Sent ${delivered} of ${total}. ${reason}`;
}

/** paneAttachmentPrompt (desk_interaction_compose.go:168-205): the prompt naming the posted files'
 *  Gram ids and where `herdr gram get-file` puts them. */
export function paneAttachmentPrompt(text: string, files: Pick<Attachment, "name" | "isImage" | "messageID">[]): string {
 const paths = files.map(file => {
  const dot = file.name.lastIndexOf(".");
  const ext = (dot >= 0 ? file.name.slice(dot + 1) : "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const path = "/tmp/herdr-" + (file.isImage ? "photo" : "file") + "-" + file.messageID;
  return ext ? path + "." + ext : path;
 });
 let reference: string;
 const file = files[0];
 if (files.length === 1 && file) {
  const noun = file.isImage ? "Photo" : "File " + file.name;
  reference = `[${noun} attached via Herdr Gram message ${file.messageID}. Download it with \`herdr gram get-file ${file.messageID} -o ${paths[0]}\`, then inspect ${paths[0]}.]`;
 } else {
  const lines = files.map((file, i) => `\`herdr gram get-file ${file.messageID} -o ${paths[i]}\`  (${file.name})`);
  reference = `[${files.length} files attached via Herdr Gram. Download them with:\n${lines.join("\n")}\nthen inspect ${paths.join(", ")}.]`;
 }
 return text.trim() === "" ? reference : text + "\n\n" + reference;
}

// ---- Base64 (Go's StdEncoding: padded, strict) ----

export function toBase64(bytes: Uint8Array): string {
 let binary = "";
 for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
 return btoa(binary);
}
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
 if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
 let binary: string;
 try { binary = atob(text); } catch { return null; }
 const out = new Uint8Array(binary.length);
 for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
 return out;
}

// ---- Upload ----

export type Call = (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;

/** A fresh upload_id (streams.go newUploadID): one safe path component. */
export function newUploadID(): string {
 const b = crypto.getRandomValues(new Uint8Array(16));
 return "web-" + Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

/** The pieces of a size-byte upload as [offset, length]: an empty file is one empty piece, as herdr
 *  needs one chunk to create the upload (streams.go eachPiece). */
export function uploadPieces(size: number, chunk = UPLOAD_CHUNK_BYTES): [number, number][] {
 const out: [number, number][] = [];
 for (let off = 0; off === 0 || off < size; off += chunk) {
  out.push([off, Math.min(chunk, size - off)]);
  if (off + chunk >= size) break;
 }
 return out;
}

/** engine.GramUploadFrom's per-chunk path (streams.go:110-142) for a Blob: one gram.upload_chunk per
 *  piece, progress after each. A piece the relay refused to connect for (rate_limited, so herdr never
 *  saw it) is sent again at the same offset after the transport's backoff; past
 *  UPLOAD_RATE_LIMIT_RETRIES refusals in a row the upload fails. */
export async function uploadBlob(call: Call, blob: Blob, signal: AbortSignal, progress: (sent: number) => void,
 options: { chunk?: number; backoffMs?: (refusal: number) => number } = {}): Promise<string> {
 const chunk = options.chunk ?? UPLOAD_CHUNK_BYTES;
 const backoff = options.backoffMs ?? (refusal => Math.min(15_000 * 2 ** refusal, 60_000));
 const uploadID = newUploadID();
 for (const [off, n] of uploadPieces(blob.size, chunk)) {
  const piece = new Uint8Array(await blob.slice(off, off + n).arrayBuffer());
  if (piece.length !== n) throw new Error(`read upload at ${off}: the file changed`);
  const params = { upload_id: uploadID, offset: off, data_base64: toBase64(piece) };
  for (let refusals = 0; ; refusals++) {
   if (signal.aborted) throw abortError(signal);
   try { await call("gram.upload_chunk", params, signal); break; }
   catch (error) {
    if (!isRateLimited(error) || refusals >= UPLOAD_RATE_LIMIT_RETRIES) throw error;
    await sleep(backoff(refusals), signal);
   }
  }
  progress(off + n);
 }
 return uploadID;
}

// ---- Uploader (gramstore/uploader.go) ----

export type PhaseKind = "queued" | "uploading" | "uploaded" | "paused" | "failed";
export interface Phase { kind: PhaseKind; sent: number; total: number; uploadID?: string }
export type UploadFunc = (a: Attachment, progress: (sent: number, total: number) => void, signal: AbortSignal) => Promise<string>;

interface Waiter { resolve(id: string): void; reject(error: unknown): void }
interface Job { file: Attachment; phase: Phase; waiters: Waiter[] }
interface Running { path: string; job: Job; attempt: number; abort: AbortController; discardOnLanding: boolean }

const canceled = () => new DOMException("The upload was cancelled.", "AbortError");

/** Uploads staged files one at a time in staging order, as herdrup's GramUploadQueue. */
export class Uploader {
 #jobs = new Map<string, Job>();
 #order: string[] = [];
 #running: Running | null = null;
 #pumping = false;
 #attempts = 0;
 #closed = false;
 constructor(private readonly upload: UploadFunc, private readonly discard: (uploadID: string) => void, private readonly changed: (path: string) => void) {}

 phase(path: string): Phase | undefined { return this.#jobs.get(path)?.phase; }

 start(a: Attachment) {
  if (this.#closed || this.#jobs.has(a.path)) return;
  this.#jobs.set(a.path, { file: a, phase: { kind: "queued", sent: 0, total: 0 }, waiters: [] });
  this.#order.push(a.path);
  this.#pump();
  this.changed(a.path);
 }

 /** Uploads a failed or paused file again. */
 retry(path: string) {
  const j = this.#jobs.get(path);
  if (!j || (j.phase.kind !== "failed" && j.phase.kind !== "paused")) return;
  j.phase = { kind: "queued", sent: 0, total: 0 };
  this.#pump();
  this.changed(path);
 }

 /** The pre-upload's upload_id once it finishes; ok false when there is none to wait for. */
 async wait(path: string, signal?: AbortSignal): Promise<{ id: string; ok: boolean }> {
  const j = this.#jobs.get(path);
  if (!j) return { id: "", ok: false };
  if (j.phase.kind === "uploaded") return { id: j.phase.uploadID ?? "", ok: true };
  if (j.phase.kind === "queued" || j.phase.kind === "uploading") return { id: await this.#await(j, signal), ok: true };
  return { id: "", ok: false };
 }

 /** Uploads now (again, when a finished upload went stale) and returns its upload_id. */
 uploadNow(a: Attachment, signal?: AbortSignal): Promise<string> {
  if (this.#closed) return Promise.reject(canceled());
  let j = this.#jobs.get(a.path);
  if (!j) {
   j = { file: a, phase: { kind: "queued", sent: 0, total: 0 }, waiters: [] };
   this.#jobs.set(a.path, j);
   this.#order.push(a.path);
  }
  if (j.phase.kind !== "queued" && j.phase.kind !== "uploading") {
   j.file = { ...j.file, uploadID: undefined };
   j.phase = { kind: "queued", sent: 0, total: 0 };
  }
  this.#pump();
  const done = this.#await(j, signal);
  this.changed(a.path);
  return done;
 }

 #await(j: Job, signal?: AbortSignal): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  if (signal?.aborted) { reject(abortError(signal)); return promise; }
  const stop = () => reject(abortError(signal));
  signal?.addEventListener("abort", stop, { once: true });
  j.waiters.push({
   resolve: id => { signal?.removeEventListener("abort", stop); resolve(id); },
   reject: error => { signal?.removeEventListener("abort", stop); reject(error); },
  });
  return promise;
 }

 /** Drops a's job, cancelling its upload; a finished one never posted is discarded on herdr. */
 remove(a: Attachment) {
  const phase = this.#jobs.get(a.path)?.phase;
  this.#drop(a.path, !a.messageID);
  if (!a.messageID && phase?.kind === "uploaded" && phase.uploadID) this.discard(phase.uploadID);
  this.changed(a.path);
 }

 /** Drops the jobs of posted files. */
 forget(paths: string[]) { for (const p of paths) this.#drop(p, false); }

 /** Pause and Resume follow Gram going off and on screen: uploads nothing waits on stop. */
 pause() {
  const paused: string[] = [];
  for (const p of this.#order) {
   const j = this.#jobs.get(p)!;
   if (j.waiters.length > 0 || (j.phase.kind !== "queued" && j.phase.kind !== "uploading")) continue;
   j.phase = { kind: "paused", sent: 0, total: 0 };
   paused.push(p);
   if (this.#running?.job === j) this.#running.abort.abort(canceled());
  }
  for (const p of paused) this.changed(p);
 }
 resume() {
  const resumed: string[] = [];
  for (const p of this.#order) {
   const j = this.#jobs.get(p)!;
   if (j.phase.kind === "paused") { j.phase = { kind: "queued", sent: 0, total: 0 }; resumed.push(p); }
  }
  if (resumed.length) this.#pump();
  for (const p of resumed) this.changed(p);
 }

 close() {
  this.#closed = true;
  for (const p of [...this.#order]) this.#drop(p, false);
 }

 /** Byte progress over the uploads paths still wait on; null when none is pending. */
 pendingProgress(paths: string[]): number | null {
  let sent = 0, total = 0, ok = false;
  for (const p of paths) {
   const j = this.#jobs.get(p);
   if (!j) continue;
   if (j.phase.kind === "queued") { ok = true; total += j.file.size; }
   else if (j.phase.kind === "uploading") { ok = true; sent += j.phase.sent; total += Math.max(j.phase.total, j.phase.sent); }
  }
  if (!ok) return null;
  return total <= 0 ? 0 : Math.min(1, sent / total);
 }

 #drop(path: string, discardIfItLands: boolean) {
  const j = this.#jobs.get(path);
  if (!j) return;
  this.#jobs.delete(path);
  this.#order = this.#order.filter(p => p !== path);
  if (this.#running?.job === j) { this.#running.discardOnLanding = discardIfItLands; this.#running.abort.abort(canceled()); }
  for (const w of j.waiters) w.reject(canceled());
  j.waiters = [];
 }

 #pump() {
  if (this.#pumping || this.#closed) return;
  this.#pumping = true;
  void this.#work();
 }

 async #work() {
  for (;;) {
   const path = this.#order.find(p => this.#jobs.get(p)!.phase.kind === "queued");
   if (path === undefined) { this.#pumping = false; return; }
   const job = this.#jobs.get(path)!;
   job.phase = { kind: "uploading", sent: 0, total: job.file.size };
   const running: Running = { path, job, attempt: ++this.#attempts, abort: new AbortController(), discardOnLanding: false };
   this.#running = running;
   this.changed(path);
   let id = "", error: unknown = null, failed = false;
   try {
    id = await this.upload(job.file, (sent, total) => {
     if (this.#running !== running || this.#jobs.get(path) !== job || job.phase.kind !== "uploading") return;
     job.phase = { kind: "uploading", sent, total };
     this.changed(path);
    }, running.abort.signal);
   } catch (e) { error = e; failed = true; }
   this.#complete(running, id, failed, error);
  }
 }

 #complete(started: Running, id: string, failed: boolean, error: unknown) {
  this.#running = null;
  const j = this.#jobs.get(started.path);
  if (j !== started.job) {
   if (!failed && started.discardOnLanding) this.discard(id);
   return;
  }
  const waiters = j.waiters;
  if (!failed) {
   j.waiters = [];
   j.file = { ...j.file, uploadID: id };
   j.phase = { kind: "uploaded", sent: j.file.size, total: j.file.size, uploadID: id };
   for (const w of waiters) w.resolve(id);
   this.changed(started.path);
   return;
  }
  if (j.phase.kind !== "uploading") return; // paused: its waiters wait for the resume
  j.waiters = [];
  j.phase = { kind: "failed", sent: 0, total: 0 };
  for (const w of waiters) w.reject(error);
  this.changed(started.path);
 }
}

// ---- Chips (gramstore/chips.go) ----

export type ChipKind = "ready" | "waiting" | "uploading" | "uploaded" | "uploadFailed" | "sending" | "sent" | "failed";
export interface ChipState { kind: ChipKind; sent: number; total: number }

export function chipStateFor(a: Attachment, phase: Phase | undefined, sending: boolean, sendingPath: string, failedPath: string): ChipState {
 const chip = (kind: ChipKind, sent = 0, total = 0): ChipState => ({ kind, sent, total });
 if (a.path === failedPath) return chip("failed");
 if (a.messageID) return chip("sent");
 if (!phase) return !sending ? chip("ready") : a.path === sendingPath ? chip("sending") : chip("waiting");
 switch (phase.kind) {
  case "uploading": return chip("uploading", phase.sent, phase.total);
  case "queued": case "paused": return chip("waiting");
  case "failed": return chip("uploadFailed");
 }
 return sending && a.path === sendingPath ? chip("sending") : chip("uploaded");
}

/** gramChip (desk_gram.go:480-487): a chip as the page draws it. */
export function gramAttachment(a: Attachment, s: ChipState): GramAttachment {
 const determinate = s.kind === "uploading" && s.total > 0;
 const fraction = determinate ? Math.min(1, Math.max(0, s.sent / s.total)) : 0;
 const size = displaySize(Math.max(0, a.size));
 const label = {
  ready: size + " · Ready", uploaded: size + " · Ready", waiting: size + " · Waiting",
  uploading: determinate ? `${Math.round(fraction * 100)}% · ${size}` : "Uploading…",
  uploadFailed: "Upload failed · tap to retry", sending: "Sending…", sent: "Sent · " + size, failed: "Failed · tap send to retry",
 }[s.kind];
 return {
  path: a.path, name: a.name, mime: a.mime, isImage: a.isImage, size: a.size, state: s.kind, label, fraction, determinate,
  indeterminate: s.kind === "sending" || (s.kind === "uploading" && s.total <= 0), failed: s.kind === "failed" || s.kind === "uploadFailed",
 };
}

// ---- Composer (gramstore/composer.go) ----

export class SendError extends Error {
 constructor(readonly note: string, readonly cause: unknown) { super(note); this.name = "SendError"; }
}
export const ERR_SENDING = "a send is running";

/** One post: text alone (a null attachment) or one uploaded file; returns the message id. */
export type PostFunc = (text: string, a: Attachment | null, signal?: AbortSignal) => Promise<string>;

export interface ComposerState { chips: GramAttachment[]; sending: boolean; draftPosted: number; progress: number | null }

export class Composer {
 retryDelayMs = DEFAULT_RETRY_DELAY_MS;
 #files: Attachment[] = [];
 #sending = false;
 #closed = false;
 #sendingPath = "";
 #failedPath = "";
 #draftPosted = 0;
 readonly up: Uploader;
 constructor(upload: UploadFunc, discard: (uploadID: string) => void, private readonly changed: (path: string) => void) {
  this.up = new Uploader(upload, discard, changed);
 }

 room(): number { return MAX_ATTACHMENTS - this.#files.length; }
 has(path: string): boolean { return this.#files.some(a => a.path === path); }

 add(files: Attachment[]) {
  const added: Attachment[] = [];
  for (const a of files) {
   if (this.has(a.path) || this.#closed || this.#files.length >= MAX_ATTACHMENTS) continue;
   this.#files.push(a);
   added.push(a);
  }
  for (const a of added) this.up.start(a);
  this.changed("");
 }

 /** Unstages path, cancelling its upload and discarding a finished one. */
 remove(path: string) {
  if (this.#sending) throw new Error(ERR_SENDING);
  const i = this.#files.findIndex(a => a.path === path);
  if (i < 0) return;
  const [a] = this.#files.splice(i, 1);
  if (this.#failedPath === path) this.#failedPath = "";
  if (a) this.up.remove(a);
  this.changed("");
 }

 retry(path: string) { this.up.retry(path); }
 pause() { this.up.pause(); }
 resume() { this.up.resume(); }
 close() { this.#closed = true; this.#files = []; this.up.close(); }

 snapshot(): ComposerState {
  const chips = this.#files.map(a => gramAttachment(a, chipStateFor(a, this.up.phase(a.path), this.#sending, this.#sendingPath, this.#failedPath)));
  return { chips, sending: this.#sending, draftPosted: this.#draftPosted, progress: this.up.pendingProgress(this.#files.map(a => a.path)) };
 }
 chip(path: string): GramAttachment | undefined { return this.snapshot().chips.find(c => c.path === path); }
 paths(): string[] { return this.#files.map(a => a.path); }

 /** Composer.Send: text and the staged files of paths; each file its own Gram, the text on the first. */
 send(text: string, paths: string[], post: PostFunc, signal?: AbortSignal): Promise<void> {
  return this.#send(text, paths, post, null, signal);
 }
 /** Composer.SendPrompt: posts the files, then finish (the agent prompt) decides whether they leave. */
 sendPrompt(paths: string[], post: PostFunc, finish: (files: Attachment[]) => Promise<boolean>, signal?: AbortSignal): Promise<void> {
  return this.#send("", paths, post, finish, signal);
 }

 async #send(text: string, paths: string[], post: PostFunc, finish: ((files: Attachment[]) => Promise<boolean>) | null, signal?: AbortSignal) {
  if (this.#closed) throw canceled();
  if (this.#sending) throw new Error(ERR_SENDING);
  const batch = paths.map(p => this.#files.find(a => a.path === p)).filter((a): a is Attachment => !!a);
  if (text === "" && batch.length === 0) return;
  this.#sending = true; this.#failedPath = "";
  this.changed("");
  try {
   if (batch.length === 0) {
    try { await post(text, null, signal); }
    catch (error) { throw new SendError(apiMessage(error) ?? "Couldn't send. Try again.", error); }
    this.#draftPosted++;
    return;
   }
   const caption = batch[0]?.path;
   const update = (a: Attachment) => {
    const held = this.#files.find(f => f.path === a.path);
    if (held) { held.uploadID = a.uploadID; held.messageID = a.messageID; }
    this.changed(a.path);
   };
   // The caption rides on the first file; once that posts the draft counts as posted (composer.go
   // send: draftPosted++ for the caption's file), so the page clears it and a retry of the rest
   // never sends it again.
   const failure = await this.#deliverAll(batch, async a => {
    const id = await post(a.path === caption ? text : "", a, signal);
    if (a.path === caption) this.#draftPosted++;
    return id;
   }, update, signal);
   let consume = finish === null, finishError: unknown = null;
   if (finish && !failure) {
    const posted = batch.map(a => this.#files.find(f => f.path === a.path) ?? a);
    try { consume = await finish(posted); } catch (error) { finishError = error; consume = false; }
   }
   const left: string[] = [];
   this.#files = this.#files.filter(a => {
    if (consume && a.messageID && paths.includes(a.path)) { left.push(a.path); return false; }
    return true;
   });
   if (failure) this.#failedPath = failure.attachment.path;
   this.up.forget(left);
   if (!failure) { if (finishError) throw finishError; return; }
   const reason = isUploadInProgress(failure.error) ? "Still finishing the last upload. Tap Send again." : apiMessage(failure.error) ?? "Couldn't send. Try again.";
   throw new SendError(progressNote(reason, failure.delivered, failure.total), failure.error);
  } finally {
   this.#sending = false; this.#sendingPath = "";
   this.changed("");
  }
 }

 /** sender.send (composer.go:417-441): files already uploaded or posted first, each posted once. */
 async #deliverAll(batch: Attachment[], post: (a: Attachment) => Promise<string>, update: (a: Attachment) => void, signal?: AbortSignal) {
  const order = [...batch.filter(a => a.uploadID || a.messageID), ...batch.filter(a => !a.uploadID && !a.messageID)];
  let delivered = 0;
  for (const held of order) {
   const a = { ...held };
   if (!a.messageID) {
    this.#sendingPath = a.path;
    this.changed(a.path);
    try { await this.#deliver(a, post, update, signal); }
    catch (error) { return { attachment: a, delivered, total: batch.length, error }; }
   }
   delivered++;
  }
  return null;
 }

 /** sender.deliver: wait on the pre-upload (or upload now), post, and upload once more when herdr
  *  lost the upload. */
 async #deliver(a: Attachment, post: (a: Attachment) => Promise<string>, update: (a: Attachment) => void, signal?: AbortSignal) {
  if (!a.uploadID) {
   const pre = await this.up.wait(a.path, signal);
   a.uploadID = pre.ok ? pre.id : await this.up.uploadNow(a, signal);
   update(a);
  }
  let id: string;
  try { id = await this.#postRetrying(a, post, signal); }
  catch (error) {
   if (!isStaleUpload(error)) throw error;
   a.uploadID = undefined;
   update(a);
   a.uploadID = await this.up.uploadNow(a, signal);
   update(a);
   id = await this.#postRetrying(a, post, signal);
  }
  a.messageID = id;
  update(a);
 }

 /** postRetrying: asks again (never uploading again) while herdr still owns the upload_id. */
 async #postRetrying(a: Attachment, post: (a: Attachment) => Promise<string>, signal?: AbortSignal): Promise<string> {
  for (let attempt = 1; ; attempt++) {
   try { return await post(a); }
   catch (error) {
    if (!isUploadInProgress(error) || attempt >= POST_ATTEMPTS) throw error;
    await sleep(this.retryDelayMs > 0 ? this.retryDelayMs : DEFAULT_RETRY_DELAY_MS, signal);
   }
  }
 }
}
