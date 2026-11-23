import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { uiTypography } from "./scripts/uiTypography.ts";

// The browser guest build (`bun run build:guest-web`): web/index.html and src/web/main.ts, the
// guest screens of src/ with the Go bridge replaced by src/web (mygo.ts, runtime.ts). Served by
// the guest relay under /web/ with a CSP of script-src 'self': no inline script, no eval.
// Output: dist-web/, hashed names for everything the bundle imports, and the few files the
// screens name at run time (BASE_URL + path: mascots, composer glyphs, the lazy Mermaid) copied
// from public/ under their own names.

const root = dirname(fileURLToPath(import.meta.url));
const src = resolve(root, "src");

/** src/*.ts import ./mygo, src/web/*.ts ../mygo, and composer.ts mygo-runtime: all to src/web. The
 *  desktop-only host home goes the same way: main.ts's ./hosts (saved SSH hosts, pairing) is
 *  src/web/hosts.ts here, the owner's approved machines (shellModel.ts has the other parts). */
function browserBridge(): Plugin {
  const swapped = new Map([[resolve(src, "mygo.ts"), resolve(src, "web/mygo.ts")], [resolve(src, "hosts.ts"), resolve(src, "web/hosts.ts")]]);
  return {
    name: "herdrup-guest-web-bridge",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer) return null;
      if (source === "mygo-runtime") return resolve(src, "web/runtime.ts");
      if (!/^\.\.?\/(mygo|hosts)(\.ts)?$/.test(source)) return null;
      return swapped.get(resolve(dirname(importer), source).replace(/\.ts$/, "") + ".ts") ?? null;
    },
  };
}

/** The public/ files the screens reach by URL, in a fixed order. */
const runtimeAssets = [
  ...readdirSync(resolve(root, "public/herdrup/mascots")).sort().map(f => `herdrup/mascots/${f}`),
  ...readdirSync(resolve(root, "public/herdrup/composer")).sort().map(f => `herdrup/composer/${f}`),
  "mermaid/mermaid.min.js", "mermaid/Mermaid-LICENSE.txt",
  "fonts/Geist-OFL.txt", "fonts/IBMPlexMono-OFL.txt", "herdrup/fonts/NerdFonts-LICENSE.txt",
  // Settings' Join the Discord row (settings.ts discordGlyph), with its brand notice.
  "herdrup/discord-mark.png", "herdrup/NOTICE-Discord-Brand.txt",
];
function runtimeFiles(): Plugin {
  return {
    name: "herdrup-guest-web-files",
    generateBundle() {
      for (const fileName of runtimeAssets) this.emitFile({ type: "asset", fileName, source: readFileSync(resolve(root, "public", fileName)) });
    },
  };
}

/** The page's connect-src names the relays of internal/webrelay/relays.json, the list the desktop
 *  checks a machine's relay against before it grants a browser access (app/desk_web_access.go).
 *  The build also ships the list as relays.json, so the guest relay can write its /web/* CSP
 *  header from the artifact it serves rather than from its own copy. */
function relayOrigins(): Plugin {
  const origins: unknown = JSON.parse(readFileSync(resolve(root, "internal/webrelay/relays.json"), "utf8"));
  if (!Array.isArray(origins) || !origins.length || !origins.every(o => typeof o === "string" && /^https:\/\/[a-z0-9.-]+$/.test(o)))
    throw new Error("internal/webrelay/relays.json: expected a list of https origins");
  const sources = origins.map(o => o.replace(/^https:/, "wss:")).join(" ");
  return {
    name: "herdrup-guest-web-relays",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "relays.json", source: JSON.stringify(origins) + "\n" });
    },
    transformIndexHtml: {
      order: "pre",
      handler: html => {
        if (!html.includes("%HERDRUP_RELAYS%")) throw new Error("web/index.html: connect-src has no %HERDRUP_RELAYS%");
        return html.replace("%HERDRUP_RELAYS%", sources);
      },
    },
  };
}

/** `bun run dev:guest-web` only (the build is unchanged by it). The entry sits outside root
 *  (web/), which the dev server would load from /src/…, outside the base: it is named by its file
 *  instead (/web/@fs/…). The runtime files are served from public/ as they are, where the dev
 *  server's page fallback would answer them with index.html. */
const types: Record<string, string> = { ".svg": "image/svg+xml", ".js": "text/javascript", ".txt": "text/plain; charset=utf-8" };
function devServer(): Plugin {
  return {
    name: "herdrup-guest-web-dev",
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      handler: html => html.replace(`src="../src/web/boot.ts"`, `src="/@fs${resolve(src, "web/boot.ts")}"`),
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?", 1)[0]!.replace(/^\/web\//, "");
        if (!runtimeAssets.includes(path)) { next(); return; }
        res.setHeader("Content-Type", types[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream");
        res.end(readFileSync(resolve(root, "public", path)));
      });
    },
  };
}

export default defineConfig({
  root: resolve(root, "web"),
  base: "/web/",
  mode: "guest-web",
  publicDir: false,
  css: { postcss: { plugins: [uiTypography()] } },
  // tokens.css names the fonts as public/ files; here they are bundled with hashed names.
  resolve: { alias: [
    { find: /^\/fonts\/(.+)$/, replacement: join(root, "public/fonts/$1") },
    // interaction.css names the terminal symbols font (public/herdrup/fonts) the same way.
    { find: /^\/herdrup\/fonts\/(.+)$/, replacement: join(root, "public/herdrup/fonts/$1") },
  ] },
  plugins: [browserBridge(), runtimeFiles(), relayOrigins(), devServer()],
  server: { port: 24750, strictPort: true },
  build: {
    outDir: resolve(root, "dist-web"),
    emptyOutDir: true,
    // No inline <script>: the module preload polyfill is not injected.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
