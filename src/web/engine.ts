// internal/engine's Client for one guest link: the herdr call, its capability gate (one ping,
// cached) and its result tag, with Go's error texts (engine.go).

import { HerdrAPIError } from "../webguest/errors";
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

/** engine.go checkTag's ResultTagError. */
export function checkTag(method: string, result: unknown, want: string): void {
 const got = tagOf(result);
 if (got !== want) throw new Error(`${method}: herdr answered ${JSON.stringify(got)}, want ${want}`);
}

/** The result without its tag, as Go re-encodes the decoded variant. */
export function untagged<T>(result: unknown): T {
 const { type: _type, ...rest } = result as Record<string, unknown>;
 return rest as T;
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

 /** engine.go gate: refuses a call the host's pong says it lacks; an unanswered ping lets it through. */
 async gate(method: string, capability: string, signal?: AbortSignal): Promise<void> {
  if (capability === "") return;
  let pong = this.#probed;
  if (pong === null) {
   try { pong = await this.ping(signal); } catch { return; }
  }
  if (pong.capabilities?.[capability] !== true) throw new ErrUnsupported(method, capability, pong.version ?? "");
 }

 /** engine.go doRaw: gate, call, map the error, check the result's tag; the result keeps its tag. */
 async call<T>(method: string, params: unknown, tag: string, capability = "", signal?: AbortSignal): Promise<T> {
  await this.gate(method, capability, signal);
  let result: unknown;
  try { result = await this.link.call(method, params, signal); } catch (error) { throw this.mapError(method, error); }
  checkTag(method, result, tag);
  return result as T;
 }
}
