import { defineConfig } from "mygo-cli";
import pkg from "./package.json" with { type: "json" };
import { join } from "node:path";
import { existsSync } from "node:fs";

const speech = process.env.HERDRUP_SPEECH_RESOURCES;
const speechFiles = speech ? [
  join(speech, existsSync(join(speech, "herdrup-speech.exe")) ? "herdrup-speech.exe" : "herdrup-speech"),
  join(speech, "ggml-tiny.bin"),
  join(speech, "whisper-LICENSE"),
  join(speech, "speech-LICENSES"),
] : [];

// The public key that app updates are signed with: mygo-update.pub of
// `mygo keygen` (README.md, "Signing app updates"). Until it is committed
// here builds have no updates, and Settings says the app can't update
// itself; the release workflow's MYGO_UPDATER_PRIVATE_KEY signs them once
// it is.
const updatePublicKey = process.env.HERDRUP_UPDATE_PUBLIC_KEY ?? "";

export default defineConfig({
  // The name users see, lower case as herdrup's (project.yml CFBundleDisplayName); slug keeps
  // the files, identifier the preferences and keychain.
  name: "herdrup",
  slug: "herdrup",
  // Fixed after the first release: the OS ties preferences and keychain
  // items to it.
  identifier: "com.jerryfane.herdrup-desktop",
  version: pkg.version,
  urlSchemes: ["herdrup"],
  copyright: "© 2026 Jerry Fane",
  // `mygo dev` runs devCommand and loads devUrl; `mygo build` runs
  // buildCommand and embeds frontendDist into the app.
  devUrl: "http://localhost:5173",
  devCommand: "bun run dev:web",
  buildCommand: "bun run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",
  resources: speechFiles,
  // Signed updates from this repository's releases, which the app checks,
  // previews included (desk_updates_app.go). mygo build rejects updates
  // without a public key, so there are none until it is known.
  updates: updatePublicKey
    ? { publicKey: updatePublicKey, github: "jerryfane/herdrup-desktop" }
    : undefined,
  linux: {
    maintainer: "Jerry Fane <jerryfane@users.noreply.github.com>",
    comment: "Answer your herdr coding agents from the desktop",
    categories: ["Development"],
  },
  // Developer ID signing and notarization, off until the owner sets them up
  // (see "Signing macOS builds" in README.md): the release workflow sets
  // these variables only when the repository variable
  // MACOS_SIGNING_IDENTITY exists. Without them the app is signed ad hoc.
  macos: {
    infoPlist: { NSCameraUsageDescription: "Scan the one-time pairing code shown by herdr on your computer." },
    entitlements: "camera.entitlements.plist",
    signingIdentity: process.env.HERDRUP_SIGNING_IDENTITY,
    notarize: process.env.HERDRUP_NOTARY_KEYCHAIN
      ? { keychainProfile: "notary", keychain: process.env.HERDRUP_NOTARY_KEYCHAIN }
      : undefined,
  },
});
