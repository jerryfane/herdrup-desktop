// The window's first render must come whatever startup does (RoverOS preview.22: a startup
// step failed or never settled after the bars were drawn, and the page stayed blank with no
// message). A startup that fails or is still running after limitMs before its first render
// gets the fallback render, and the app's log says why; one that fails after it is reported.

export interface StartupHooks {
 /** The render startup didn't reach: the screen it can show (main.ts). */
 firstRender(): void;
 report(message: string): void;
}

export const STARTUP_LIMIT_MS = 15_000;

/** Runs init, which calls rendered() once its first render is up. Before that, a failure or
 *  limitMs passing brings the fallback render; after it, a failure is only reported. */
export function startWithFallback(init: (rendered: () => void) => Promise<void>, hooks: StartupHooks, limitMs = STARTUP_LIMIT_MS): Promise<void> {
 let rendered = false;
 const watch = setTimeout(() => fallback(hooks, () => `startup: no first render after ${Math.round(limitMs / 1000)} s; rendering anyway`), limitMs);
 const done = () => { rendered = true; clearTimeout(watch); };
 return new Promise<void>(resolve => resolve(init(done))).then(() => { clearTimeout(watch); }, error => {
  clearTimeout(watch);
  if (rendered) report(hooks, () => `after the first render: ${errorDetail(error)}`);
  else fallback(hooks, () => `startup failed: ${errorDetail(error)}`);
 });
}

/** The render first, whatever reporting does; then the report. */
function fallback(hooks: StartupHooks, message: () => string) {
 try { hooks.firstRender(); }
 finally { report(hooks, message); }
}

/** Reporting never throws: nothing that comes after it waits on it. */
function report(hooks: StartupHooks, message: () => string) {
 try { hooks.report(message()); } catch { /* the log is best effort */ }
}

/** The error as text, never throwing (a rejection can be any value, even one with no
 *  toString). */
export function errorDetail(error: unknown): string {
 try {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  return String(error);
 } catch {
  return "(an error that can't be shown as text)";
 }
}
