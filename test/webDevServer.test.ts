// `bun run dev:guest-web` serves a page that loads: its entry module (outside the Vite root) and
// the files the screens name at run time (composer glyphs, mascots, the lazy Mermaid), each as
// itself rather than the dev server's index.html fallback (PR #118 review, findings 4 and 5).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let base = "";

beforeAll(async () => {
 server = await createServer({ configFile: join(import.meta.dir, "../vite.web.config.ts"), logLevel: "silent", server: { port: 0, strictPort: false, host: "127.0.0.1" } });
 await server.listen();
 const address = server.httpServer!.address();
 if (address === null || typeof address === "string") throw new Error("dev server has no port");
 base = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => { await server?.close(); });

async function fetched(path: string) {
 const response = await fetch(base + path);
 return { status: response.status, type: response.headers.get("content-type") ?? "", body: await response.text() };
}

test("the dev page's entry module and runtime files load as themselves", async () => {
 const page = await fetched("/web/");
 const entry = [...page.body.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map(m => m[1]!).find(src => !src.includes("@vite/client"));
 expect(entry?.startsWith("/web/")).toBe(true);
 const module = await fetched(entry!);
 expect([module.status, module.type]).toEqual([200, "text/javascript"]);
 expect(module.body).toContain("takeFragment");
 for (const [path, type] of [["/web/herdrup/composer/send.svg", "image/svg+xml"], ["/web/herdrup/mascots/herdy.svg", "image/svg+xml"], ["/web/mermaid/mermaid.min.js", "text/javascript"]]) {
  const file = await fetched(path!);
  expect([path, file.status, file.type]).toEqual([path, 200, type]);
  expect(file.body.startsWith("<!doctype html>")).toBe(false);
 }
}, 60_000);
