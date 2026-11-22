// Waiting on work that may outlive the caller: p, or the abort's reason as soon as signal aborts.
// p itself goes on (a request another caller shares, or one already sent); only this wait ends.

export function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
 // Already aborted: p's outcome is still observed, so a rejection nobody waits for isn't unhandled.
 if (signal.aborted) { p.catch(() => {}); return Promise.reject(signal.reason); }
 return new Promise<T>((resolve, reject) => {
  const stop = () => reject(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  p.then(v => { signal.removeEventListener("abort", stop); resolve(v); }, e => { signal.removeEventListener("abort", stop); reject(e); });
 });
}
