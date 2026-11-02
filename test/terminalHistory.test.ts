import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { prependTerminalHistory } from "../src/terminalHistory";

const encode = (text: string) => new TextEncoder().encode(text);
const write = (term: Terminal, data: string | Uint8Array) => new Promise<void>(resolve => term.write(data, resolve));
const lines = (term: Terminal) => Array.from({ length: term.buffer.active.length }, (_, index) => term.buffer.active.getLine(index)!.translateToString(true));

test("history preserves the live screen with partial UTF8 saved cursor and markers", async () => {
  const term = new Terminal({ cols: 20, rows: 3, scrollback: 20, allowProposedApi: true });
  try {
    await write(term, "LIVE\r\nsecond\x1b7");
    const marker = term.registerMarker(0)!;
    await write(term, new Uint8Array([0xe2, 0x82]));
    expect(await prependTerminalHistory(term, encode("\x1b[31mold red\x1b[0m\r\nolder two\r\n"), () => true)).toBe(2);
    expect(lines(term)).toEqual(["old red", "older two", "LIVE", "second", ""]);
    expect(term.buffer.active.getLine(0)!.getCell(0)!.getFgColor()).toBe(1);
    expect(marker.line).toBe(3);
    expect(term.buffer.active.viewportY).toBe(2);
    await write(term, new Uint8Array([0xac]));
    expect(lines(term)[3]).toBe("second€");
    await write(term, "\x1b8!");
    expect(lines(term)[3]).toBe("second!");
  } finally { term.dispose(); }
});

test("history leaves an incomplete live control sequence intact", async () => {
  const term = new Terminal({ cols: 20, rows: 2, scrollback: 20 });
  try {
    await write(term, "\x1b[3");
    await prependTerminalHistory(term, encode("history\r\n"), () => true);
    await write(term, "1mred");
    expect(lines(term)).toEqual(["history", "red", ""]);
    expect(term.buffer.active.getLine(1)!.getCell(0)!.getFgColor()).toBe(1);
  } finally { term.dispose(); }
});

test("history retains the newest page rows at the cap without dropping live rows", async () => {
  const term = new Terminal({ cols: 20, rows: 2, scrollback: 2 });
  try {
    await write(term, "live0\r\nlive1");
    expect(await prependTerminalHistory(term, encode("old0\r\nold1\r\nold2\r\nold3\r\nold4\r\n"), () => true)).toBe(2);
    expect(lines(term)).toEqual(["old3", "old4", "live0", "live1"]);
    expect(await prependTerminalHistory(term, encode("even older\r\n"), () => true)).toBe(0);
    expect(lines(term)).toEqual(["old3", "old4", "live0", "live1"]);
    await write(term, "\r\nlive2");
    expect(lines(term)).toEqual(["old4", "live0", "live1", "live2"]);
  } finally { term.dispose(); }
});

test("history rejects cancelled resized and alternate-screen destinations", async () => {
  const term = new Terminal({ cols: 20, rows: 2, scrollback: 20 });
  try {
    await write(term, "live");
    let current = true;
    const cancelled = prependTerminalHistory(term, encode("stale\r\n"), () => current);
    current = false;
    expect(await cancelled).toBeNull();
    expect(lines(term)).toEqual(["live", ""]);
    const resized = prependTerminalHistory(term, encode("wrong width\r\n"), () => true);
    term.resize(30, 2);
    expect(await resized).toBeNull();
    await write(term, "\x1b[?1049h\x1b[HALT");
    expect(await prependTerminalHistory(term, encode("not alternate history\r\n"), () => true)).toBeNull();
    expect(lines(term)).toEqual(["ALT", ""]);
    await write(term, "\x1b[?1049l");
    expect(lines(term)).toEqual(["live", ""]);
  } finally { term.dispose(); }
});

test("history retains blank rows and wide-character wraps through resize", async () => {
  const term = new Terminal({ cols: 6, rows: 2, scrollback: 20 });
  try {
    await write(term, "live");
    expect(await prependTerminalHistory(term, new Uint8Array(), () => true)).toBe(0);
    expect(lines(term)).toEqual(["live", ""]);
    expect(await prependTerminalHistory(term, encode("ab中文x\r\n\r\n"), () => true)).toBe(3);
    expect(lines(term)).toEqual(["ab中文", "x", "", "live", ""]);
    expect(term.buffer.active.getLine(1)!.isWrapped).toBe(true);
    term.resize(12, 2);
    expect(lines(term)).toEqual(["ab中文x", "", "live", ""]);
  } finally { term.dispose(); }
});
