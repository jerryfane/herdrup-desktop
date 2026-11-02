import { expect, test } from "bun:test";
import { PredictionEngine, type PredictionScreen, type PredictionMode } from "../src/predictiveEcho";
import { TypingLatency } from "../src/typingLatency";

function terminal(mode: PredictionMode = "always") {
  let now = 10, batch = 0;
  const cells = new Map<string, string>();
  const screen: PredictionScreen = { columns: 80, rows: 24, cursor: { col: 0, row: 0 }, text: (col, row) => cells.get(`${col},${row}`) || " " };
  const engine = new PredictionEngine(mode, () => now);
  const key = (text: string) => { engine.userBytes(new TextEncoder().encode(text), screen, ++batch); return batch; };
  const advance = (ms: number) => { now += ms / 1000; };
  const echo = (text: string) => { for (const char of text) cells.set(`${screen.cursor.col++},${screen.cursor.row}`, char); engine.outputArrived(screen); };
  const ack = (id: number) => engine.batchAcked(id, false, screen);
  const prime = (ms = 40) => { const id = key("l"); advance(ms); ack(id); echo("l"); };
  return { engine, screen, key, advance, echo, ack, prime };
}

test("a password-like silent input never establishes a visible prediction epoch", () => {
  const t = terminal();
  const batch = t.key("secret");
  expect(t.engine.overlay.cells).toEqual([]);
  expect(t.engine.overlay.cursor).toBeNull();
  t.advance(40); t.ack(batch); t.advance(1100); t.engine.tick(t.screen);
  expect(t.engine.overlay.cells).toEqual([]);
  expect(t.engine.shown).toBe(0);
  expect(t.engine.confirmed).toBe(0);
});

test("confirmed echo permits the next key without changing the server screen", () => {
  const t = terminal(); t.prime();
  const batch = t.key("s");
  expect(t.engine.overlay.cells.find(c => c.col === 1)?.text).toBe("s");
  expect(t.engine.overlay.cursor).toEqual({ col: 2, row: 0 });
  expect(t.screen.text(1, 0)).toBe(" ");
  expect(t.screen.cursor.col).toBe(1);
  const paints = t.engine.takeFirstPaints(); expect(paints).toHaveLength(1);
  expect(t.engine.takeFirstPaints()).toEqual([]);
  t.advance(20); t.ack(batch); t.echo("s");
  expect(t.engine.confirmed).toBe(1); expect(t.engine.wrong).toBe(0);
  expect(t.engine.overlay.cells).toEqual([]);
});

test("Enter starts a tentative epoch so the following password cannot leak", () => {
  const t = terminal(); t.prime(); t.key("\r");
  t.key("private");
  expect(t.engine.overlay.cells).toEqual([]); expect(t.engine.overlay.cursor).toBeNull();
});

test("wrong echoed characters retract predictions and require new confidence", () => {
  const t = terminal(); t.prime(); const batch = t.key("s");
  t.advance(20); t.ack(batch); t.advance(60); t.echo("X");
  expect(t.engine.wrong).toBe(1); expect(t.engine.overlay.cells).toEqual([]);
  t.key("z"); expect(t.engine.overlay.cells).toEqual([]);
});

test("Auto requires measured round-trip delay while Off immediately clears guesses", () => {
  const fast = terminal("auto"); fast.prime(10); fast.key("s"); expect(fast.engine.overlay.cells).toEqual([]);
  const slow = terminal("auto"); slow.prime(100); slow.key("s");
  expect(slow.engine.overlay.cells.find(c => c.col === 1)).toMatchObject({ text: "s", underlined: true });
  slow.engine.setMode("off"); slow.key("x");
  expect(slow.engine.overlay.cells).toEqual([]); expect(slow.engine.overlay.cursor).toBeNull();
});

test("resize and failed sends clear old-screen predictions", () => {
  const t = terminal(); t.prime(); t.key("s"); t.screen.columns = 40; t.engine.tick(t.screen);
  expect(t.engine.overlay.cells).toEqual([]);
  t.prime(); const batch = t.key("x"); t.engine.batchAcked(batch, true, t.screen);
  expect(t.engine.overlay.cells).toEqual([]); expect(t.engine.overlay.cursor).toBeNull();
});

test("typing latency waits for sent output render and ACK in either order", () => {
  let now = 0; const recorder = new TypingLatency(() => now);
  const id = recorder.pressed("host"), ids = new Set([id]);
  now = 100; recorder.output(ids); recorder.rendered(ids); // not sent: unrelated output
  now = 200; recorder.sent(id);
  now = 250; recorder.output(ids);
  now = 266; recorder.rendered(ids);
  expect(recorder.snapshot()).toEqual([]); // ACK is not a proxy for paint
  now = 300; recorder.acked(id);
  expect(recorder.snapshot()[0]?.samples).toEqual([{ queue: 200, ack: 300, echo: 250, render: 266 }]);
});

test("typing latency excludes unechoed and failed keys without dropping slow queues", () => {
  let now = 0; const recorder = new TypingLatency(() => now);
  const queued = recorder.pressed("host"); now = 10000; recorder.sent(queued); recorder.acked(queued);
  now = 11000; recorder.output(new Set([queued])); recorder.rendered(new Set([queued]));
  const silent = recorder.pressed("host"); recorder.sent(silent); recorder.acked(silent);
  now += 2001;
  expect(recorder.snapshot()[0]?.dropped).toBe(1);
  const failed = recorder.pressed("host"); recorder.sent(failed); recorder.acked(failed, true);
  expect(recorder.snapshot()[0]?.lost).toBe(1);
  expect(recorder.snapshot()[0]?.samples).toEqual([{ queue: 10000, ack: 10000, echo: 11000, render: 11000 }]);
});
