// One opening of an agent sheet (Rename, Restart, Swap, Avatar…, the Topics switch, Switch harness):
// the page opens one when the menu's request arrives, runs that sheet's Desk calls through it,
// starts it when its action actually begins (confirmed), and releases it when the sheet closes or
// is cancelled. The desktop's Desk needs none of it (its sheets act on the one machine Go has open),
// so its opening only runs the call. The browser Desk (web/agentActionsDesk.ts) puts its own in
// place: every call made through an opening goes to the machine that sheet was chosen on.

export interface SheetOpening {
  /** Runs one of this sheet's Desk calls; start it here, synchronously. */
  run<T>(call: () => Promise<T>): Promise<T>;
  /** The sheet's action begins (confirmed): this opening now speaks for its agent's sheet of this
   * kind, and an older one's results no longer count. */
  start(): void;
  /** The sheet closed or was cancelled: nothing more comes from it. */
  release(): void;
}

export interface SheetOpenings {
  open(kind: string, paneID: string): SheetOpening;
}

const desktop: SheetOpenings = {
  open: () => ({ run: call => call(), start() {}, release() {} }),
};
let openings = desktop;

/** For the browser Desk only: its openings, in place of the desktop's. */
export function setSheetOpenings(o: SheetOpenings): void { openings = o; }

/** The opening of a sheet of kind for paneID, as its request arrives (before anything awaits). */
export function openSheet(kind: string, paneID: string): SheetOpening { return openings.open(kind, paneID); }
