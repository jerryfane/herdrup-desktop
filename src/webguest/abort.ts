// Waiting that an abort ends: on work that may outlive the caller (untilAborted: p, or the abort's
// reason as soon as signal aborts; p itself goes on, a request another caller shares or one already
// sent), or on a timer (sleep).

export function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
 // Already aborted: p's outcome is still observed, so a rejection nobody waits for isn't unhandled.
 if (signal.aborted) { p.catch(() => {}); return Promise.reject(signal.reason); }
 return new Promise<T>((resolve, reject) => {
  const stop = () => reject(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  p.then(v => { signal.removeEventListener("abort", stop); resolve(v); }, e => { signal.removeEventListener("abort", stop); reject(e); });
 });
}

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
