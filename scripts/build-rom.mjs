import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoUrl = "https://gitlab.com/soapbox-pub/tobu-xdc.git";
const repoCommit = "89b7ffa5d9b3945be5ed625ece031a1e373466f6";
const root = resolve(new URL("..", import.meta.url).pathname);
const cacheRoot = join(root, ".rom-cache");
const checkout = process.env.TOBU_XDC_DIR
  ? resolve(process.env.TOBU_XDC_DIR)
  : join(cacheRoot, "tobu-xdc");
const generatedDir = join(root, "src", "generated");
const sourceRom = join(checkout, "public", "tobudx.gb");
const outFile = join(generatedDir, "tobu-rom.ts");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

if (!existsSync(sourceRom)) {
  if (process.env.TOBU_XDC_DIR) {
    throw new Error(`TOBU_XDC_DIR does not contain public/tobudx.gb: ${checkout}`);
  }
  await rm(checkout, { recursive: true, force: true });
  await mkdir(cacheRoot, { recursive: true });
  run("git", ["clone", "--depth", "1", repoUrl, checkout]);
  run("git", ["fetch", "--depth", "1", "origin", repoCommit], checkout);
  run("git", ["checkout", repoCommit], checkout);
}

const rom = await readFile(sourceRom);
const sha256 = createHash("sha256").update(rom).digest("hex");
await mkdir(generatedDir, { recursive: true });
await writeFile(
  outFile,
  [
    "export const TOBU_ROM = {",
    '  slug: "tobu-tobu-girl-deluxe",',
    '  name: "Tobu Tobu Girl Deluxe",',
    '  fileName: "tobudx.gb",',
    `  source: ${JSON.stringify(repoUrl)},`,
    `  sourceCommit: ${JSON.stringify(repoCommit)},`,
    `  sha256: ${JSON.stringify(sha256)},`,
    `  bytes: ${rom.length},`,
    `  dataUrl: ${JSON.stringify(`data:application/vnd.nintendo.gb-rom;base64,${rom.toString("base64")}`)},`,
    "} as const;",
    "",
  ].join("\n"),
);

console.log(`Generated ${outFile} (${rom.length} bytes, sha256 ${sha256})`);
