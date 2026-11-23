/** The owner approval runs of this page: one at a time, each bound to the account it began for.
 *  A run holds the tab lock until it has settled, so the next one starts only after the one it
 *  replaces has stopped. */
export class OwnerRuns {
 private run: AbortController | null = null;
 private account: string | undefined;
 private done: Promise<void> = Promise.resolve();

 /** Aborts the current run and queues one for account: start runs once the run before has
  *  settled, unless this one was stopped first. failed hears start's error while the run is
  *  still the current one. Returns the run's signal. */
 begin(account: string | undefined, start: (signal: AbortSignal) => Promise<void>, failed: (error: unknown) => void): AbortSignal {
  this.run?.abort();
  const run = new AbortController();
  this.run = run;
  this.account = account;
  this.done = this.done
   .then(() => run.signal.aborted ? undefined : start(run.signal))
   .catch(error => { if (this.run === run) failed(error); });
  return run.signal;
 }

 /** True while signal's run is the current one. */
 isCurrent(signal: AbortSignal): boolean { return this.run?.signal === signal; }

 /** True when a run is current and began for another account than account (or for one, and
  *  now there is none). */
 staleFor(account: string | undefined): boolean { return this.run !== null && this.account !== account; }

 /** Stops the current run; none is current after. */
 stop() { this.run?.abort(); this.run = null; this.account = undefined; }
}
