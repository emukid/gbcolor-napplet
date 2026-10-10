import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const html = await readFile("dist/index.html", "utf8");
const outputForbidden = [
  /<script[^>]+src=/i,
  /<link[^>]+href=/i,
  /\bwindow\.nostr\b/,
  /\blocalStorage\b/,
  /\bindexedDB\b/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
];
const sourceForbidden = [
  /\bwindow\.nostr\b/,
  /\blocalStorage\b/,
  /\bindexedDB\b/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bfetch\b/,
];

const hits = outputForbidden.filter((pattern) => pattern.test(html));
if (hits.length > 0) {
  console.error("Bundle contains forbidden napplet surface:");
  for (const hit of hits) {
    console.error(`- ${hit}`);
  }
  process.exit(1);
}

for (const file of await sourceFiles("src")) {
  const source = await readFile(file, "utf8");
  const sourceHits = sourceForbidden.filter((pattern) => pattern.test(source));
  if (sourceHits.length > 0) {
    console.error(`Source contains forbidden napplet surface in ${file}:`);
    for (const hit of sourceHits) {
      console.error(`- ${hit}`);
    }
    process.exit(1);
  }
}

console.log("Bundle boundary scan passed");

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path));
    } else if (/\.(ts|tsx|js|jsx|svelte)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}
