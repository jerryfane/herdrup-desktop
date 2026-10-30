import { mkdir, copyFile, appendFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve, join } from "node:path";

const revision = "927cfce34f31707e17f2bff35c349632fb9e2c3a";
const modelHash = "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21";
const platform = process.argv[2];
if (!["linux/amd64", "windows/amd64", "darwin/universal"].includes(platform ?? "")) throw new Error("Usage: bun speech/build.ts linux/amd64|windows/amd64|darwin/universal");
const windows = platform === "windows/amd64";
if (windows && process.platform !== "win32") throw new Error("Build Windows speech on Windows with Visual Studio and a current Windows SDK. Ubuntu MinGW headers lack required thread power-throttling APIs.");
if (!process.env.WHISPER_SOURCE || !process.env.HERDRUP_SPEECH_RESOURCES) throw new Error("Set WHISPER_SOURCE to the pinned checkout and HERDRUP_SPEECH_RESOURCES to an owned build-scratch directory.");
const source = resolve(process.env.WHISPER_SOURCE);
const output = resolve(process.env.HERDRUP_SPEECH_RESOURCES);
async function run(args: string[]) {
  const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Command failed: ${args.join(" ")}`);
}
const head = Bun.spawn(["git", "-C", source, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "inherit" });
const actual = (await new Response(head.stdout).text()).trim();
if (await head.exited !== 0 || actual !== revision) throw new Error(`whisper.cpp must be at ${revision}, got ${actual}`);
await mkdir(output, { recursive: true });
const model = join(output, "ggml-tiny.bin");
if (!(await Bun.file(model).exists())) {
  if (process.env.HERDRUP_SPEECH_MODEL) await copyFile(process.env.HERDRUP_SPEECH_MODEL, model);
  else {
    const response = await fetch("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin");
    if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
    // Bun 1.3.14 on Linux stalls when its Response-to-file fast path consumes
    // this redirected download. Stream it with backpressure instead.
    await pipeline(response.body!, createWriteStream(model));
  }
}
const hash = new Bun.CryptoHasher("sha256");
for await (const chunk of Bun.file(model).stream()) hash.update(chunk);
if (hash.digest("hex") !== modelHash) throw new Error("Speech model checksum mismatch; remove the invalid model before retrying.");
const executable = `herdrup-speech${windows ? ".exe" : ""}`;
const arches = platform === "darwin/universal" ? ["arm64", "x86_64"] : ["amd64"];
const binaries: string[] = [];
for (const arch of arches) {
  const build = join(output, `build-${platform!.replace("/", "-")}-${arch}`);
  const flags: string[] = [];
  if (windows) flags.push("-A", "x64");
  if (platform === "darwin/universal") flags.push(`-DCMAKE_OSX_ARCHITECTURES=${arch}`, `-DCMAKE_SYSTEM_PROCESSOR=${arch}`);
  await run(["cmake", "-S", resolve("speech"), "-B", build, `-DWHISPER_SOURCE=${source}`, "-DCMAKE_BUILD_TYPE=Release", ...flags]);
  await run(["cmake", "--build", build, "--config", "Release", "--target", "herdrup-speech", "-j", "4"]);
  const binary = join(build, executable);
  binaries.push(await Bun.file(binary).exists() ? binary : join(build, "Release", executable));
}
if (binaries.length === 2) await run(["lipo", "-create", ...binaries, "-output", join(output, executable)]);
else await copyFile(binaries[0]!, join(output, executable));
// Preserve the upstream engine license in every installer.
await copyFile(join(source, "LICENSE"), join(output, "whisper-LICENSE"));
const audioHeader = await Bun.file(join(source, "examples/miniaudio.h")).text();
const licenseStart = audioHeader.lastIndexOf("\nALTERNATIVE 1 - Public Domain");
if (licenseStart < 0) throw new Error("Pinned miniaudio license notice is missing");
await Bun.write(join(output, "speech-LICENSES"), await Bun.file("speech/THIRD-PARTY-LICENSES").text() + "\n" + audioHeader.slice(licenseStart));
if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `HERDRUP_SPEECH_RESOURCES=${output}\n`);
console.log(`Offline speech resources ready: ${output}`);
