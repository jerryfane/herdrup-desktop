// internal/engine's Client for one guest link: the herdr call, its capability gate (one ping,
// cached) and its result tag, with Go's error texts (engine.go).

import { HerdrAPIError, notSent } from "../webguest/errors";
import type { WebLink } from "./link";

export interface Pong { version?: string; protocol?: number; capabilities?: Record<string, unknown> | null }

/** engine.go ErrUnsupported. */
export class ErrUnsupported extends Error {
 constructor(readonly method: string, readonly capability: string, serverVersion: string) {
  const server = serverVersion !== "" ? "herdr " + serverVersion : "this herdr";
  super(capability !== "" ? `${server} does not support ${method} (no ${capability} capability)` : `${server} does not know ${method}`);
  this.name = "ErrUnsupported";
 }
}

/** engine.go isUnknownMethod. */
function unknownMethod(error: HerdrAPIError, method: string): boolean {
 if (error.code === "unknown_method") return true;
 return error.code === "invalid_request" && error.apiMessage.toLowerCase().includes("unknown variant") && error.apiMessage.includes(method);
}

/** A herdr result's "type" tag (herdrapi ResponseResult), or "". */
function tagOf(result: unknown): string {
 return typeof result === "object" && result !== null && "type" in result && typeof result.type === "string" ? result.type : "";
}

/** engine.go ResultTagError: a reply whose result "type" is not the method's. */
export class ResultTagError extends Error {
 constructor(readonly method: string, readonly got: string, readonly want: string) {
  super(`${method}: herdr answered ${JSON.stringify(got)}, want ${want}`);
  this.name = "ResultTagError";
 }
}

/** engine.go checkTag. */
export function checkTag(method: string, result: unknown, want: string): void {
 const got = tagOf(result);
 if (got !== want) throw new ResultTagError(method, got, want);
}

/** The result without its tag, as Go re-encodes the decoded variant. */
export function untagged<T>(result: unknown): T {
 const { type: _type, ...rest } = result as Record<string, unknown>;
 return rest as T;
}

/** A call cancelled before it is sent ends as NotSentError (errors.ts), with unsent's reason. */
function presendCheck(unsent?: AbortSignal): void {
 if (unsent?.aborted) throw notSent(unsent.reason);
}

export class GuestClient {
 #probed: Pong | null = null;
 constructor(private readonly link: WebLink) {}

 /** engine.go mapError. */
 mapError(method: string, error: unknown): unknown {
  return error instanceof HerdrAPIError && unknownMethod(error, method) ? new ErrUnsupported(method, "", this.#probed?.version ?? "") : error;
 }

 /** methods.go Ping: the pong, kept for the gate. */
 async ping(signal?: AbortSignal): Promise<Pong> {
  const pong = await this.call<Pong>("ping", {}, "pong", "", signal);
  this.#probed = pong;
  return pong;
 }

 /** engine.go gate: refuses a call the host's pong says it lacks; an unanswered ping lets it through.
  *  The ping is the call's pre-send work, so unsent (the call's pre-send signal) ends it too, and
  *  every check reads unsent: a call cancelled before it is sent is a NotSentError with the reason
  *  that ended it first, its pong cached or probed. */
 async gate(method: string, capability: string, unsent?: AbortSignal): Promise<void> {
  if (capability === "") return;
  presendCheck(unsent);
  let pong = this.#probed;
  if (pong === null) {
   try { pong = await this.ping(unsent); } catch { presendCheck(unsent); return; }
   presendCheck(unsent);
  }
  if (pong.capabilities?.[capability] !== true) throw new ErrUnsupported(method, capability, pong.version ?? "");
 }

 /** engine.go Supports: whether the host's pong advertises capability, from the cached pong (one
  *  ping when none answered yet); false when that ping fails. For an optional param, not a gate. */
 async supports(capability: string, unsent?: AbortSignal): Promise<boolean> {
  let pong = this.#probed;
  if (pong === null) {
   try { pong = await this.ping(unsent); } catch { presendCheck(unsent); return false; }
  }
  return pong.capabilities?.[capability] === true;
 }

 /** engine.go doRaw: gate, call, map the error, check the result's tag; the result keeps its tag.
  *  sendSignal ends the call only while it is unsent (WebLink.call). One pre-send signal (signal
  *  and sendSignal), made before the gate, is the gate's and goes to the link as the call's
  *  sendSignal: the gate and the hand-off read the same first reason, and the link detaches it at
  *  the hand-off, so sendSignal never ends the call past it. */
 async call<T>(method: string, params: unknown, tag: string, capability = "", signal?: AbortSignal, sendSignal?: AbortSignal): Promise<T> {
  const unsent = sendSignal === undefined ? undefined : signal === undefined ? sendSignal : AbortSignal.any([signal, sendSignal]);
  await this.gate(method, capability, unsent ?? signal);
  let result: unknown;
  try { result = await this.link.call(method, params, signal, unsent); } catch (error) { throw this.mapError(method, error); }
  checkTag(method, result, tag);
  return result as T;
 }
}
