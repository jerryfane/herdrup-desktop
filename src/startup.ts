// The window's first render must come whatever startup does (RoverOS preview.22: a startup
// step failed or never settled after the bars were drawn, and the page stayed blank with no
// message). A failed startup still renders and reports why; one still running after limitMs
// renders what it has (with no machine, the host screen) and reports that it is stuck.

export interface StartupHooks {
 firstRender(): void;
 report(message: string): void;
}

export const STARTUP_LIMIT_MS = 15_000;

/** Runs init; the first render comes on success, on failure, or after limitMs. */
export function startWithFallback(init: () => Promise<void>, hooks: StartupHooks, limitMs = STARTUP_LIMIT_MS): Promise<void> {
 const watch = setTimeout(() => {
  hooks.report(`startup: no first render after ${Math.round(limitMs / 1000)} s; rendering anyway`);
  hooks.firstRender();
 }, limitMs);
 return init().then(() => { clearTimeout(watch); }, error => {
  clearTimeout(watch);
  hooks.report(`startup failed: ${errorDetail(error)}`);
  hooks.firstRender();
 });
}

export function errorDetail(error: unknown): string {
 if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
 return String(error);
}
