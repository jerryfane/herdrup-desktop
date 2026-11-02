// Port of HerdrKit/PredictiveEcho.swift (mosh-style confidence epochs).
// Predictions never change the emulator: the caller paints the overlay separately.
export type PredictionMode = "auto" | "always" | "off";
export interface PredictionScreen {
  columns: number;
  rows: number;
  cursor: { col: number; row: number };
  text(col: number, row: number): string;
}
export interface PredictionOverlay {
  cells: { col: number; row: number; text: string | null; underlined: boolean }[];
  cursor: { col: number; row: number } | null;
}
export interface FirstPaint { pressedAt: number; shownAt: number }
type Validity = "pending" | "correct" | "noCredit" | "incorrect" | "inactive";
type ParseState = "ground" | "escape" | "escapeIntermediate" | "csi" | "csiExtended";
interface CursorMove { col: number; row: number; tentativeUntil: number; expiration: number }
interface Probe { batch: number; sentAt: number; ackedAt: number | null }
const emptyOverlay = (): PredictionOverlay => ({ cells: [], cursor: null });
const blank = (text: string) => text === "" || text === " ";
const cellText = (screen: PredictionScreen, col: number, row: number) => screen.text(col, row) || " ";

class Cell {
  active = false;
  tentativeUntil = Infinity;
  expiration = Infinity;
  predictionTime = 0;
  replacement = " ";
  unknown = false;
  originals: string[] = [];
  // Value fields preserve Swift Key's copy semantics when a character shifts.
  pressedAt: number | null = null;
  shown = false;
  expire(batch: number, now: number) { this.expiration = batch; this.predictionTime = now; }
  private resetBase() {
    this.active = false; this.tentativeUntil = Infinity; this.expiration = Infinity;
    this.pressedAt = null; this.shown = false;
  }
  reset() { this.unknown = false; this.originals.length = 0; this.resetBase(); }
  resetWithOriginal() {
    if (!this.active || this.unknown) { this.reset(); return; }
    this.originals.push(this.replacement); this.resetBase();
  }
}

export class PredictionEngine {
  static readonly srttTriggerHigh = .030;
  static readonly srttTriggerLow = .020;
  static readonly flagTriggerHigh = .080;
  static readonly flagTriggerLow = .050;
  static readonly glitchThreshold = .250;
  static readonly glitchRepairCount = 10;
  static readonly glitchRepairMinInterval = .150;
  static readonly glitchFlagThreshold = 5;
  static readonly echoTimeout = .050;
  static readonly ackExpiry = 1;
  overlay = emptyOverlay();
  shown = 0;
  confirmed = 0;
  wrong = 0;
  srtt: number | null = null;
  private firstPaints: FirstPaint[] = [];
  private rowCells = new Map<number, Cell[]>();
  private cursors: CursorMove[] = [];
  private predictionEpoch = 1;
  private confirmedEpoch = 0;
  private srttTrigger = false;
  private flagging = false;
  private glitchTrigger = 0;
  private lastQuickConfirmation = -Infinity;
  private lastColumns = -1;
  private lastRows = -1;
  private lastBatch = 0;
  private ackedThrough = 0;
  private lateAckedThrough = 0;
  private acks: { through: number; at: number }[] = [];
  private probes: Probe[] = [];
  private lastOutputAt = -Infinity;
  private parseState: ParseState = "ground";
  private utf8Value = 0;
  private utf8Needed = 0;
  private utf8Minimum = 0;

  constructor(public mode: PredictionMode = "auto", private clock = () => performance.now() / 1000) {}
  setMode(mode: PredictionMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "off") this.reset();
  }
  userBytes(bytes: Uint8Array, screen: PredictionScreen, batch: number) {
    if (this.mode === "off" || !bytes.length) return;
    const now = this.clock();
    this.cull(screen, now);
    this.lastBatch = Math.max(this.lastBatch, batch);
    if (!this.probes.some(p => p.batch === batch)) {
      this.probes.push({ batch, sentAt: now, ackedAt: null });
      if (this.probes.length > 64) this.probes.shift();
    }
    for (const byte of bytes) this.consume(byte, screen, batch, now);
    this.refreshOverlay(screen, now);
  }
  batchAcked(batch: number, failed = false, screen?: PredictionScreen) {
    if (this.mode === "off") return;
    const now = this.clock();
    if (batch > this.ackedThrough) {
      this.ackedThrough = batch; this.acks.push({ through: batch, at: now });
    }
    if (failed) { this.reset(); return; }
    this.probes = this.probes.filter(probe => {
      if (probe.batch > batch || probe.ackedAt !== null || this.lastOutputAt < probe.sentAt) return true;
      this.sample(now - probe.sentAt); return false;
    });
    for (const probe of this.probes) if (probe.batch <= batch && probe.ackedAt === null) probe.ackedAt = now;
    if (screen) { this.cull(screen, now); this.refreshOverlay(screen, now); }
  }
  outputArrived(screen: PredictionScreen) {
    if (this.mode === "off") return;
    const now = this.clock(); this.lastOutputAt = now;
    this.settleProbes(now, true); this.promoteAcks(PredictionEngine.echoTimeout, now);
    this.cull(screen, now); this.refreshOverlay(screen, now);
  }
  tick(screen: PredictionScreen) {
    if (this.mode === "off") return;
    const now = this.clock();
    this.settleProbes(now, false); this.promoteAcks(PredictionEngine.ackExpiry, now);
    this.cull(screen, now); this.refreshOverlay(screen, now);
  }
  get needsTick() {
    if (this.mode === "off") return false;
    if (this.probes.some(p => p.ackedAt !== null) || this.cursors.some(c => c.expiration <= this.lastBatch)) return true;
    for (const cells of this.rowCells.values()) if (cells.some(c => c.active && c.expiration <= this.lastBatch)) return true;
    return false;
  }
  get hasPredictions() {
    if (this.cursors.length) return true;
    for (const cells of this.rowCells.values()) if (cells.some(c => c.active)) return true;
    return false;
  }
  reset() {
    this.discardPredictions(); this.probes.length = 0;
    this.parseState = "ground"; this.utf8Needed = 0; this.utf8Value = 0;
    this.overlay = emptyOverlay();
  }
  takeFirstPaints() { const paints = this.firstPaints; this.firstPaints = []; return paints; }
  private sample(measured: number) {
    if (measured < 0) return;
    const interval = Math.min(measured, PredictionEngine.glitchThreshold);
    this.srtt = this.srtt === null ? interval : this.srtt + (interval - this.srtt) / 8;
  }
  private settleProbes(now: number, output: boolean) {
    this.probes = this.probes.filter(probe => {
      if (probe.ackedAt === null) return true;
      if (output && now - probe.ackedAt <= PredictionEngine.echoTimeout) { this.sample(now - probe.sentAt); return false; }
      if (!output && now - probe.ackedAt <= PredictionEngine.echoTimeout) return true;
      this.sample(probe.ackedAt - probe.sentAt); return false;
    });
  }
  private promoteAcks(age: number, now: number) {
    let through = this.lateAckedThrough;
    for (const ack of this.acks) if (now - ack.at >= age) through = Math.max(through, ack.through);
    this.setLateAcked(through);
  }
  private setLateAcked(through: number) {
    if (through <= this.lateAckedThrough) return;
    this.lateAckedThrough = through; this.acks = this.acks.filter(a => a.through > through);
  }
  private promoteVisiblyEchoed(screen: PredictionScreen) {
    if (this.ackedThrough <= this.lateAckedThrough) return;
    let through = this.lateAckedThrough;
    for (const [row, cells] of this.rowCells) {
      if (row < 0 || row >= screen.rows) continue;
      for (let col = 0; col < Math.min(cells.length, screen.columns); col++) {
        const cell = cells[col]!;
        if (!cell.active || cell.unknown || blank(cell.replacement) || cell.expiration <= through || cell.expiration > this.ackedThrough) continue;
        const current = cellText(screen, col, row);
        if (current === cell.replacement && !cell.originals.includes(current)) through = cell.expiration;
      }
    }
    this.setLateAcked(through);
  }
  private awaitingEvidence(batch: number, now: number) {
    if (batch > this.ackedThrough) return false;
    const ack = this.acks.find(a => a.through >= batch);
    return !!ack && now - ack.at >= PredictionEngine.echoTimeout;
  }
  private cellValidity(cell: Cell, col: number, row: number, screen: PredictionScreen): Validity {
    if (!cell.active) return "inactive";
    if (row >= screen.rows || col >= screen.columns) return "incorrect";
    if (this.lateAckedThrough < cell.expiration) return "pending";
    if (cell.unknown || blank(cell.replacement)) return "noCredit";
    const current = cellText(screen, col, row);
    if (current !== cell.replacement) return "incorrect";
    return cell.originals.includes(current) ? "noCredit" : "correct";
  }
  private cursorValidity(cursor: CursorMove, screen: PredictionScreen): Validity {
    if (cursor.row < 0 || cursor.col < 0 || cursor.row >= screen.rows || cursor.col >= screen.columns) return "incorrect";
    if (this.lateAckedThrough < cursor.expiration) return "pending";
    return screen.cursor.col === cursor.col && screen.cursor.row === cursor.row ? "correct" : "incorrect";
  }
  private cull(screen: PredictionScreen, now: number) {
    if (screen.columns !== this.lastColumns || screen.rows !== this.lastRows) {
      const first = this.lastColumns < 0;
      this.lastColumns = screen.columns; this.lastRows = screen.rows;
      if (!first) this.discardPredictions();
    }
    if (this.srtt !== null) {
      if (this.srtt > PredictionEngine.srttTriggerHigh) this.srttTrigger = true;
      else if (this.srttTrigger && this.srtt <= PredictionEngine.srttTriggerLow && !this.hasPredictions) this.srttTrigger = false;
      if (this.srtt > PredictionEngine.flagTriggerHigh) this.flagging = true;
      else if (this.srtt <= PredictionEngine.flagTriggerLow) this.flagging = false;
    }
    if (this.glitchTrigger > PredictionEngine.glitchRepairCount) this.flagging = true;
    this.promoteVisiblyEchoed(screen);
    for (const row of [...this.rowCells.keys()].sort((a, b) => a - b)) {
      if (row < 0 || row >= screen.rows) { this.rowCells.delete(row); continue; }
      for (let col = 0; col < (this.rowCells.get(row)?.length ?? 0); col++) {
        const cell = this.rowCells.get(row)![col]!;
        switch (this.cellValidity(cell, col, row, screen)) {
          case "incorrect":
            if (cell.tentativeUntil > this.confirmedEpoch) this.killEpoch(cell.tentativeUntil, screen);
            else { this.withdrawShown(); return; }
            break;
          case "correct":
            if (cell.pressedAt !== null && cell.shown) this.confirmed++;
            this.confirmedEpoch = Math.max(this.confirmedEpoch, cell.tentativeUntil);
            if (now - cell.predictionTime < PredictionEngine.glitchThreshold && this.glitchTrigger > 0
                && now - PredictionEngine.glitchRepairMinInterval >= this.lastQuickConfirmation) {
              this.glitchTrigger--; this.lastQuickConfirmation = now;
            }
            cell.reset(); break;
          case "noCredit":
            if (cell.pressedAt !== null && cell.shown && cellText(screen, col, row) === cell.replacement) this.confirmed++;
            cell.reset(); break;
          case "pending":
            if (!this.awaitingEvidence(cell.expiration, now)) {
              const age = now - cell.predictionTime;
              if (age >= PredictionEngine.glitchFlagThreshold) this.glitchTrigger = PredictionEngine.glitchRepairCount * 2;
              else if (age >= PredictionEngine.glitchThreshold && this.glitchTrigger < PredictionEngine.glitchRepairCount) this.glitchTrigger = PredictionEngine.glitchRepairCount;
            }
            break;
        }
      }
    }
    const last = this.cursors.at(-1);
    if (last && this.cursorValidity(last, screen) === "incorrect") { this.withdrawShown(); return; }
    this.cursors = this.cursors.filter(c => this.cursorValidity(c, screen) === "pending");
    if (this.glitchTrigger > PredictionEngine.glitchRepairCount) this.flagging = true;
  }
  private withdrawShown() {
    for (const cells of this.rowCells.values()) for (const cell of cells) if (cell.active && cell.pressedAt !== null && cell.shown) this.wrong++;
    this.discardPredictions(); this.overlay = emptyOverlay();
  }
  private discardPredictions() { this.cursors.length = 0; this.rowCells.clear(); this.predictionEpoch++; }
  private killEpoch(epoch: number, screen: PredictionScreen) {
    this.cursors = this.cursors.filter(c => c.tentativeUntil <= epoch - 1);
    this.cursors.push({ ...screen.cursor, tentativeUntil: this.predictionEpoch, expiration: this.lastBatch + 1 });
    for (const cells of this.rowCells.values()) for (const cell of cells) if (cell.tentativeUntil > epoch - 1) cell.reset();
    this.predictionEpoch++;
  }
  private refreshOverlay(screen: PredictionScreen, now: number) {
    if (!(this.mode === "always" || this.mode === "auto" && (this.srttTrigger || this.glitchTrigger > 0))) {
      this.overlay = emptyOverlay(); return;
    }
    const cells: PredictionOverlay["cells"] = [];
    for (const row of [...this.rowCells.keys()].sort((a, b) => a - b)) {
      if (row < 0 || row >= screen.rows) continue;
      const rowCells = this.rowCells.get(row)!;
      for (let col = 0; col < Math.min(rowCells.length, screen.columns); col++) {
        const cell = rowCells[col]!;
        if (!cell.active || cell.tentativeUntil > this.confirmedEpoch) continue;
        if (cell.unknown) {
          if (this.flagging && col !== screen.columns - 1) cells.push({ col, row, text: null, underlined: true });
          continue;
        }
        if (cellText(screen, col, row) === cell.replacement) continue;
        cells.push({ col, row, text: cell.replacement, underlined: this.flagging });
        if (cell.pressedAt !== null && !cell.shown) {
          cell.shown = true; this.shown++;
          this.firstPaints.push({ pressedAt: cell.pressedAt, shownAt: now });
        }
      }
    }
    const move = this.cursors.findLast(c => c.tentativeUntil <= this.confirmedEpoch);
    const cursor = move && move.row >= 0 && move.col >= 0 && move.row < screen.rows && move.col < screen.columns
      ? { col: move.col, row: move.row } : null;
    this.overlay = { cells, cursor };
  }
  private consume(byte: number, screen: PredictionScreen, batch: number, now: number) {
    if (this.parseState === "ground") { this.ground(byte, screen, batch, now); return; }
    if (this.parseState === "escape") {
      if (byte === 0x5b || byte === 0x4f) this.parseState = "csi";
      else if (byte === 0x1b || byte === 0x7f) return;
      else if (byte >= 0x20 && byte <= 0x2f) this.parseState = "escapeIntermediate";
      else if (byte >= 0x30 && byte <= 0x7e) { this.predictionEpoch++; this.parseState = "ground"; }
      else if (byte < 0x20) this.control(byte, screen, batch, now);
      else { this.predictionEpoch++; this.parseState = "ground"; this.ground(byte, screen, batch, now); }
    } else if (this.parseState === "escapeIntermediate") {
      if (byte >= 0x20 && byte <= 0x2f || byte === 0x7f) return;
      if (byte >= 0x30 && byte <= 0x7e) { this.predictionEpoch++; this.parseState = "ground"; }
      else if (byte === 0x1b) { this.predictionEpoch++; this.parseState = "escape"; }
      else if (byte < 0x20) this.control(byte, screen, batch, now);
      else { this.predictionEpoch++; this.parseState = "ground"; this.ground(byte, screen, batch, now); }
    } else {
      if (byte >= 0x20 && byte <= 0x3f) this.parseState = "csiExtended";
      else if (byte >= 0x40 && byte <= 0x7e) {
        const plain = this.parseState === "csi"; this.parseState = "ground";
        if (plain && (byte === 0x43 || byte === 0x44)) this.arrow(byte === 0x43 ? 1 : -1, screen, batch);
        else this.predictionEpoch++;
      } else if (byte === 0x7f) return;
      else if (byte === 0x1b) { this.predictionEpoch++; this.parseState = "escape"; }
      else if (byte < 0x20) this.control(byte, screen, batch, now);
      else { this.predictionEpoch++; this.parseState = "ground"; this.ground(byte, screen, batch, now); }
    }
  }
  private control(byte: number, screen: PredictionScreen, batch: number, now: number) {
    if (byte === 0x18 || byte === 0x1a) this.parseState = "ground";
    this.predictionEpoch++;
    if (byte === 0x0d) this.newline(screen, batch, now);
  }
  private ground(byte: number, screen: PredictionScreen, batch: number, now: number) {
    if (this.utf8Needed > 0) {
      if ((byte & 0xc0) === 0x80) {
        this.utf8Value = (this.utf8Value << 6) | (byte & 0x3f);
        if (--this.utf8Needed === 0) {
          const value = this.utf8Value;
          if (value < this.utf8Minimum || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff || value < 0xa0) this.predictionEpoch++;
          else this.printable(value, screen, batch, now);
        }
        return;
      }
      this.utf8Needed = 0; this.utf8Value = 0; this.predictionEpoch++;
    }
    if (byte === 0x1b) this.parseState = "escape";
    else if (byte === 0x7f) this.backspace(screen, batch, now);
    else if (byte < 0x20) this.control(byte, screen, batch, now);
    else if (byte < 0x7f) this.printable(byte, screen, batch, now);
    else if (byte >= 0xc2 && byte <= 0xdf) { this.utf8Value = byte & 0x1f; this.utf8Needed = 1; this.utf8Minimum = 0x80; }
    else if (byte >= 0xe0 && byte <= 0xef) { this.utf8Value = byte & 0x0f; this.utf8Needed = 2; this.utf8Minimum = 0x800; }
    else if (byte >= 0xf0 && byte <= 0xf4) { this.utf8Value = byte & 7; this.utf8Needed = 3; this.utf8Minimum = 0x10000; }
    else this.predictionEpoch++;
  }
  private printable(value: number, screen: PredictionScreen, batch: number, now: number) {
    if (!PredictionEngine.isSingleWidth(value)) { this.predictionEpoch++; return; }
    this.insert(String.fromCodePoint(value), screen, batch, now);
  }
  private initCursor(screen: PredictionScreen, batch: number) {
    const last = this.cursors.at(-1);
    if (last?.tentativeUntil === this.predictionEpoch) return;
    const cursor = last ?? screen.cursor;
    this.cursors.push({ col: cursor.col, row: cursor.row, tentativeUntil: this.predictionEpoch, expiration: batch });
  }
  private cellsOfRow(row: number, width: number) {
    const cells = this.rowCells.get(row);
    return cells?.length === width ? cells : Array.from({ length: width }, () => new Cell());
  }
  private insert(character: string, screen: PredictionScreen, batch: number, now: number) {
    this.initCursor(screen, batch);
    const width = screen.columns, cursor = this.cursors.at(-1)!, row = cursor.row, col = cursor.col;
    if (row < 0 || row >= screen.rows || col < 0 || col >= width) { this.predictionEpoch++; return; }
    if (col + 1 >= width) this.predictionEpoch++;
    const cells = this.cellsOfRow(row, width);
    for (let i = width - 1; i > col; i--) {
      const cell = cells[i]!, previous = cells[i - 1]!;
      cell.resetWithOriginal(); cell.active = true; cell.tentativeUntil = this.predictionEpoch;
      cell.expire(batch, now); cell.originals.push(cellText(screen, i, row));
      if (i === width - 1 || previous.active && previous.unknown) cell.unknown = true;
      else if (previous.active) {
        cell.unknown = false; cell.replacement = previous.replacement;
        cell.pressedAt = previous.pressedAt; cell.shown = previous.shown;
      } else { cell.unknown = false; cell.replacement = cellText(screen, i - 1, row); }
    }
    const cell = cells[col]!;
    cell.resetWithOriginal(); cell.active = true; cell.tentativeUntil = this.predictionEpoch;
    cell.expire(batch, now); cell.replacement = character; cell.pressedAt = now; cell.shown = false;
    cell.originals.push(cellText(screen, col, row)); this.rowCells.set(row, cells);
    if (col < width - 1) { cursor.col++; cursor.expiration = batch; }
    else { this.predictionEpoch++; this.newline(screen, batch, now); }
  }
  private backspace(screen: PredictionScreen, batch: number, now: number) {
    this.initCursor(screen, batch);
    const width = screen.columns, cursor = this.cursors.at(-1)!, row = cursor.row, col = cursor.col;
    if (col <= 0) return;
    if (row < 0 || row >= screen.rows || col > width) { this.predictionEpoch++; return; }
    const start = col - 1; cursor.col = start; cursor.expiration = batch;
    const cells = this.cellsOfRow(row, width);
    for (let i = start; i < width; i++) {
      const cell = cells[i]!;
      cell.resetWithOriginal(); cell.active = true; cell.tentativeUntil = this.predictionEpoch;
      cell.expire(batch, now); cell.originals.push(cellText(screen, i, row));
      if (i + 2 >= width) cell.unknown = true;
      else {
        const next = cells[i + 1]!;
        if (next.active && next.unknown) cell.unknown = true;
        else if (next.active) {
          cell.unknown = false; cell.replacement = next.replacement; cell.pressedAt = next.pressedAt; cell.shown = next.shown;
        } else { cell.unknown = false; cell.replacement = cellText(screen, i + 1, row); }
      }
    }
    this.rowCells.set(row, cells);
  }
  private newline(screen: PredictionScreen, batch: number, now: number) {
    this.initCursor(screen, batch);
    const cursor = this.cursors.at(-1)!; cursor.col = 0;
    if (cursor.row === screen.rows - 1) {
      const cells = this.cellsOfRow(cursor.row, screen.columns);
      for (const cell of cells) {
        cell.active = true; cell.tentativeUntil = this.predictionEpoch; cell.expire(batch, now);
        cell.replacement = " "; cell.pressedAt = null; cell.shown = false;
      }
      this.rowCells.set(cursor.row, cells);
    } else cursor.row++;
    cursor.expiration = batch;
  }
  private arrow(delta: number, screen: PredictionScreen, batch: number) {
    this.initCursor(screen, batch);
    const cursor = this.cursors.at(-1)!;
    if (delta > 0 ? cursor.col < screen.columns - 1 : cursor.col > 0) { cursor.col += delta; cursor.expiration = batch; }
  }
  static isSingleWidth(value: number) {
    return value >= 0x20 && value <= 0x7e || value >= 0xa0 && value <= 0xff && value !== 0xad
      || value >= 0x100 && value <= 0x2ff || value >= 0x370 && value <= 0x52f && !(value >= 0x483 && value <= 0x489);
  }
}
