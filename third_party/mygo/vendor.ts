import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import upstream from "./upstream.json";

// Explicit maintenance command: recreates vendor/ from go.mod, then applies
// this repository's one dependency correction. Normal builds use committed files.
const root = resolve(import.meta.dir, "../..");
const moduleRoot = join(root, "vendor", upstream.module);
if (Bun.version !== upstream.bun) {
  throw new Error(`Use Bun ${upstream.bun} to reproduce the committed bridge (running ${Bun.version})`);
}
function run(command: string[], cwd = root): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed (${result.exitCode})`);
  return new TextDecoder().decode(result.stdout);
}
const selected = JSON.parse(run(["go", "list", "-mod=mod", "-m", "-json", upstream.module]));
if (selected.Version !== upstream.version || selected.Replace) {
  throw new Error("Review the MyGo patch before changing its pinned dependency version or replacement");
}
const source = JSON.parse(run(["go", "mod", "download", "-json", `${upstream.module}@${upstream.version}`]));
if (source.Sum !== upstream.sum || !source.Dir || (source.Origin?.Hash && source.Origin.Hash !== upstream.commit)) {
  throw new Error("Downloaded MyGo source does not match the reviewed upstream base");
}
run(["go", "mod", "vendor"]);
// Go vendoring retains the embedded bundle but omits its TypeScript inputs.
for (const file of [
  "packages/bridge/build.ts",
  "packages/bridge/src/bridge.ts",
  "packages/bridge/src/find.ts",
  "packages/bridge/src/fit-content.ts",
  "packages/bridge/src/runtime.ts",
  "packages/bridge/src/theme-color.ts",
  "packages/bridge/src/types.ts",
  "packages/runtime/src/types.ts",
]) {
  const destination = join(moduleRoot, file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(source.Dir, file), destination);
  await chmod(destination, 0o644);
}
run(["patch", "--batch", "--forward", "--fuzz=0", "-p1", "-i", join(import.meta.dir, "native-drop.patch")], moduleRoot);
console.log(run([process.execPath, "run", join(moduleRoot, "packages/bridge/build.ts")]));
console.log(`Vendored ${upstream.module}@${upstream.version} (${upstream.commit}) with ${upstream.issue}`);
