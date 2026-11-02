import { Terminal, type IMarker } from "@xterm/xterm";

export const HISTORY_ROWS = 20_000;

// xterm 6.0.0 has no public prepend API. Keep the version pinned and this buffer
// boundary isolated: replaying the live terminal would lose its partial parser
// state, saved cursor and application modes. CircularList.splice emits the insert
// event that moves markers; scrollToLine updates the viewport through public APIs.
interface LinkAttributes { urlId: number }
interface HistoryLine {
  isWrapped: boolean;
  getBg(index: number): number;
  _extendedAttrs: { [index: number]: LinkAttributes | undefined };
}
interface HistoryBuffer {
  lines: { length: number; maxLength: number; get(index: number): HistoryLine; splice(start: number, count: number, ...lines: HistoryLine[]): void };
  ybase: number;
  savedY: number;
  markers: IMarker[];
}
interface LinkData { id?: string; uri: string }
interface LinkRegistry {
  registerLink(data: LinkData): number;
  addLineToLink(id: number, row: number): void;
  getLinkData(id: number): LinkData | undefined;
}
interface XtermInternals { _core: { _bufferService: { buffer: HistoryBuffer }; _oscLinkService: LinkRegistry } }
function coreFor(terminal: Terminal): XtermInternals["_core"] {
  // The pinned implementation exposes these services; public typings omit them.
  const internals = terminal as unknown as XtermInternals;
  return internals._core;
}
function bufferFor(terminal: Terminal): HistoryBuffer {
  const buffer = coreFor(terminal)._bufferService.buffer;
  if (typeof buffer.lines.splice !== "function" || !Number.isInteger(buffer.savedY)) throw new Error("The terminal version does not support in-place history.");
  return buffer;
}

function transferLinks(source: Terminal, target: Terminal, lines: HistoryLine[], destination: HistoryBuffer) {
  const from = coreFor(source)._oscLinkService, to = coreFor(target)._oscLinkService;
  const ids = new Map<number, number>(), attributes = new Map<LinkAttributes, number>(), lastRow = new Map<number, number>();
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]!;
    for (const column in line._extendedAttrs) {
      const index = Number(column);
      // BufferLine may retain stale attributes after overwriting a plain cell.
      if (!(line.getBg(index) & 0x10000000)) continue; // BgFlags.HAS_EXTENDED in xterm 6.0.0
      const attr = line._extendedAttrs[index];
      if (!attr || !attr.urlId) continue;
      let id = attributes.get(attr);
      if (id === undefined) {
        const oldID = attr.urlId;
        id = ids.get(oldID);
        if (id === undefined) {
          const data = from.getLinkData(oldID);
          if (data) {
            // registerLink attaches a marker at the live cursor. Replace only
            // that newly-created marker with the actual historical row.
            const before = destination.markers.length;
            id = to.registerLink(data);
            const temporaryMarker = destination.markers[before];
            to.addLineToLink(id, row);
            temporaryMarker?.dispose();
            lastRow.set(id, row);
          } else id = 0;
          ids.set(oldID, id);
        }
        // Extended attributes can be shared by many cells and rows.
        attributes.set(attr, id);
        attr.urlId = id;
      }
      if (id && lastRow.get(id) !== row) {
        to.addLineToLink(id, row);
        lastRow.set(id, row);
      }
    }
  }
}

// null means the page became stale while parsing; keep its cursor for a later
// request. Zero means no rows fit (or the page is empty), never clear live output.
export async function prependTerminalHistory(terminal: Terminal, data: Uint8Array, isCurrent: () => boolean): Promise<number | null> {
  if (!isCurrent() || terminal.buffer.active.type !== "normal") return null;
  if (!data.length) return 0;
  const destination = bufferFor(terminal), cols = terminal.cols;
  const parser = new Terminal({ cols, rows: 1, scrollback: HISTORY_ROWS, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => parser.write(data, resolve));
    // Insert synchronously between event-loop batches. Pending live writes still
    // target the same screen and parser; there is no reset or replay of live data.
    if (!isCurrent() || terminal.cols !== cols || terminal.buffer.active.type !== "normal" || bufferFor(terminal) !== destination) return null;
    const source = parser.buffer.active;
    const last = source.baseY + source.cursorY;
    const count = last + (source.cursorX > 0 || source.getLine(last)?.translateToString(true) ? 1 : 0);
    const inserted = Math.min(count, destination.lines.maxLength - destination.lines.length);
    if (inserted <= 0) return 0;
    const lines: HistoryLine[] = [];
    const parsed = bufferFor(parser);
    for (let index = count - inserted; index < count; index++) lines.push(parsed.lines.get(index));
    // The first retained row cannot wrap from a row we did not insert.
    lines[0]!.isWrapped = false;
    const viewport = terminal.buffer.active.viewportY;
    const selection = terminal.getSelectionPosition();
    destination.lines.splice(0, 0, ...lines);
    destination.ybase += inserted;
    destination.savedY += inserted;
    transferLinks(parser, terminal, lines, destination);
    terminal.scrollToLine(viewport + inserted);
    if (selection) {
      const length = (selection.end.y - selection.start.y) * cols + selection.end.x - selection.start.x;
      terminal.select(selection.start.x, selection.start.y + inserted, length);
    }
    terminal.refresh(0, terminal.rows - 1);
    // Notify search/decoration addons through the normal write-complete event.
    // An empty write does not alter the live parser or cursor.
    terminal.write("");
    return inserted;
  } finally { parser.dispose(); }
}
