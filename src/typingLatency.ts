// Same attribution as HerdrKit/TypingLatency.swift: the first output after a
// send is its echo, not proof that the output contains that particular key.
export interface TypingSample { queue: number; ack: number; echo: number; render: number }
interface Pending { host: string; pressed: number; sent?: number; ack?: number; echo?: number; render?: number }
export interface TypingReport {
  host: string; samples: TypingSample[]; predictions: number[];
  confirmed: number; wrong: number; dropped: number; lost: number;
}
export class TypingLatency {
  private pending = new Map<number, Pending>();
  private reports = new Map<string, TypingReport>();
  private serial = 0;
  constructor(private clock = () => performance.now()) {}
  private report(host: string) {
    let report = this.reports.get(host);
    if (!report) { report = { host, samples: [], predictions: [], confirmed: 0, wrong: 0, dropped: 0, lost: 0 }; this.reports.set(host, report); }
    return report;
  }
  pressed(host: string) {
    this.prune();
    if (this.pending.size >= 256) {
      const oldest = this.pending.keys().next().value!;
      this.report(this.pending.get(oldest)!.host).dropped++; this.pending.delete(oldest);
    }
    const id = ++this.serial;
    this.pending.set(id, { host, pressed: this.clock() }); return id;
  }
  sent(id: number) { const key = this.pending.get(id); if (key) key.sent = this.clock(); }
  acked(id: number, failed = false) {
    const key = this.pending.get(id); if (!key) return;
    if (failed) { this.report(key.host).lost++; this.pending.delete(id); return; }
    key.ack = this.clock(); this.finish();
  }
  output(ids: ReadonlySet<number>) {
    this.prune(); const now = this.clock();
    for (const id of ids) { const key = this.pending.get(id); if (key?.sent !== undefined && key.echo === undefined) key.echo = now; }
  }
  rendered(ids: ReadonlySet<number>) {
    const now = this.clock();
    for (const id of ids) { const key = this.pending.get(id); if (key?.echo !== undefined && key.render === undefined) key.render = now; }
    this.finish();
  }
  abandon(ids: ReadonlySet<number>) {
    for (const id of ids) { const key = this.pending.get(id); if (key) { this.report(key.host).dropped++; this.pending.delete(id); } }
  }
  has(id: number) { return this.pending.has(id); }
  prediction(host: string, milliseconds: number) { const values = this.report(host).predictions; values.push(milliseconds); if (values.length > 1000) values.shift(); }
  verdict(host: string, confirmed: number, wrong: number) {
    if (!confirmed && !wrong) return;
    const report = this.report(host); report.confirmed += confirmed; report.wrong += wrong;
  }
  reset() { this.pending.clear(); this.reports.clear(); }
  snapshot() { this.prune(); return Array.from(this.reports.values()).sort((a, b) => a.host.localeCompare(b.host)); }
  private prune() {
    const now = this.clock();
    for (const [id, key] of this.pending) {
      if (now - key.pressed > 90000 || (key.sent !== undefined && key.echo === undefined && now - key.sent > 2000)) {
        this.report(key.host).dropped++; this.pending.delete(id);
      }
    }
  }
  private finish() {
    for (const [id, key] of this.pending) {
      if (key.sent === undefined || key.ack === undefined || key.echo === undefined || key.render === undefined) continue;
      const values = this.report(key.host).samples;
      values.push({ queue: key.sent - key.pressed, ack: key.ack - key.pressed, echo: key.echo - key.pressed, render: key.render - key.pressed });
      if (values.length > 1000) values.shift(); this.pending.delete(id);
    }
  }
}
export const typingLatency = new TypingLatency();
export function latencyLines(report: TypingReport): string[] {
  const stats = (label: string, values: number[]) => {
    if (!values.length) return `${label}: not measured`;
    const sorted = values.slice().sort((a, b) => a - b);
    const percentile = (p: number) => Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!);
    return `${label}: median ${percentile(.5)} ms · p95 ${percentile(.95)} ms`;
  };
  return [stats("Key to screen", report.samples.map(s => s.render)), stats("Key to prediction", report.predictions),
    stats("Queue wait", report.samples.map(s => s.queue)), stats("Key to ACK", report.samples.map(s => s.ack)), stats("Key to echo", report.samples.map(s => s.echo)),
    `${report.samples.length} measured · ${report.dropped} unattributed · ${report.lost} failed`,
    `Predictions: ${report.predictions.length} measured · ${report.confirmed} confirmed · ${report.wrong} withdrawn`];
}
