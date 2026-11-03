// Writes dist-web/manifest.json for the guest relay's copy of the browser build (contract
// "Hosting"): the source commit, the build command, and every file's SHA-256, sorted by path.
// The relay's CI checks its copied files against these hashes.
//   bun run scripts/guestWebManifest.ts [dist-web]

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const BUILD_COMMAND = "bun install --frozen-lockfile && bun run build:guest-web";

export interface Manifest {
 sourceCommit: string;
 /** Whether the tree had uncommitted changes to tracked files: the commit alone does not name it. */
 sourceDirty: boolean;
 buildCommand: string;
 files: Record<string, string>;
}

function walk(dir: string): string[] {
 return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
}

function git(...args: string[]): string {
 const run = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
 if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString().trim()}`);
 return run.stdout.toString().trim();
}

/** The manifest of dir's files, manifest.json itself excluded. */
export function manifest(dir: string, sourceCommit: string, sourceDirty: boolean): Manifest {
 const files: Record<string, string> = {};
 const paths = walk(dir).map(path => relative(dir, path).split(sep).join("/")).filter(path => path !== "manifest.json").sort();
 for (const path of paths) files[path] = createHash("sha256").update(readFileSync(join(dir, path))).digest("hex");
 return { sourceCommit, sourceDirty, buildCommand: BUILD_COMMAND, files };
}

if (import.meta.main) {
 const dir = process.argv[2] ?? "dist-web";
 const m = manifest(dir, git("rev-parse", "HEAD"), git("status", "--porcelain", "--untracked-files=no") !== "");
 writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 1) + "\n");
 console.log(`${dir}/manifest.json: ${Object.keys(m.files).length} files at ${m.sourceCommit}${m.sourceDirty ? " (dirty)" : ""}`);
}
