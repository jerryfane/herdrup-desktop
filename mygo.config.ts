import { defineConfig } from "mygo-cli";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  name: "Herdrup",
  slug: "herdrup",
  // Fixed after the first release: the OS ties preferences and keychain
  // items to it.
  identifier: "com.jerryfane.herdrup-desktop",
  version: pkg.version,
  copyright: "© 2026 Jerry Fane",
  // `mygo dev` runs devCommand and loads devUrl; `mygo build` runs
  // buildCommand and embeds frontendDist into the app.
  devUrl: "http://localhost:5173",
  devCommand: "bun run dev:web",
  buildCommand: "bun run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",
  linux: {
    maintainer: "Jerry Fane <jerryfane@users.noreply.github.com>",
    comment: "Answer your herdr coding agents from the desktop",
    categories: ["Development"],
  },
});
