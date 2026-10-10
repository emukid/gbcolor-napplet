import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("src/rom-sources.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`;
const { collectRomByteSources, decodeRomTransport, romContentHash } = await import(moduleUrl);

const sha256 = "0a0e8018dbbc8d7f8cd99f05e7cdc7b4cc9e358ecfe9377ebfb2291a84c6e310";
const infohash = "0123456789abcdef0123456789abcdef01234567";

assert.deepEqual(
  decodeRomTransport(new TextEncoder().encode('AQID'), { encoding: 'base64', label: 'test' }),
  new Uint8Array([1, 2, 3]),
);
assert.throws(
  () => decodeRomTransport(new Uint8Array([0xff]), { encoding: 'base64', label: 'test' }),
  /not valid UTF-8/,
);
assert.throws(
  () => decodeRomTransport(new TextEncoder().encode('%%%'), { encoding: 'base64', label: 'test' }),
  /not valid base64/,
);

{
  const sources = collectRomByteSources(
    {
      sha256,
      bytes: 3,
      mime: "application/vnd.nintendo.gb-rom",
      sources: [
        {
          type: "inline",
          encoding: "base64",
          data: "AQID",
        },
        {
          type: "blossom",
          sha256,
          extension: "gbc",
          servers: ["https://cdn.example"],
          authors: ["a".repeat(64)],
        },
        {
          type: "torrent",
          infohash,
          path: "tobudx.gb",
          trackers: ["udp://tracker.example:1337"],
        },
      ],
    },
    [],
  );

  assert.equal(sources.length, 3);
  assert.equal(sources[0].kind, "inline");
  assert.equal(sources[0].url, "data:application/vnd.nintendo.gb-rom;base64,AQID");
  assert.equal(sources[1].kind, "blossom");
  assert.equal(sources[1].url, `blossom:sha256:${sha256}`);
  assert.deepEqual(sources[1].servers, ['https://cdn.example']);
  assert.equal(sources[2].kind, "torrent");
  assert.equal(
    sources[2].url,
    `magnet:?xt=urn:btih:${infohash}&dn=tobudx.gb&tr=udp%3A%2F%2Ftracker.example%3A1337`,
  );
}

{
  const transportSha256 = '12'.repeat(32);
  const sources = collectRomByteSources(
    {
      sha256,
      bytes: 3,
      sources: [{
        type: 'blossom',
        uri: `blossom:sha256:${transportSha256}`,
        sha256: transportSha256,
        bytes: 4,
        encoding: 'base64',
        decodedSha256: sha256,
        decodedBytes: 3,
        servers: ['https://cdn.example'],
      }],
    },
    [],
  );

  assert.equal(sources[0].url, `blossom:sha256:${transportSha256}`);
  assert.equal(sources[0].sha256, transportSha256);
  assert.equal(sources[0].bytes, 4);
  assert.equal(sources[0].encoding, 'base64');
  assert.equal(sources[0].decodedSha256, sha256);
  assert.equal(sources[0].decodedBytes, 3);
}

{
  const sources = collectRomByteSources(
    { bytes: 262144, mime: "application/vnd.nintendo.gb-rom" },
    [
      ["resource", "data:application/vnd.nintendo.gb-rom;base64,AQID"],
      ["resource", `blossom:${sha256}.gb?xs=cdn.example`, "blossom"],
      ["x", infohash],
      ["torrent", infohash, "tobudx.gb", "262144"],
      ["tracker", "udp://tracker.example:1337"],
    ],
  );

  assert.equal(sources.length, 3);
  assert.deepEqual(sources.map((item) => item.kind), ["inline", "blossom", "torrent"]);
  assert.equal(sources[1].url, `blossom:sha256:${sha256}`);
  assert.deepEqual(sources[1].servers, ['cdn.example']);
  assert.equal(sources[0].sha256, undefined);
  assert.match(sources[2].url, /^magnet:\?/);
  assert.match(sources[2].url, /xt=urn:btih:/);
  assert.match(sources[2].url, /tr=udp%3A%2F%2Ftracker.example%3A1337/);
}

{
  const sources = collectRomByteSources(
    {
      sha256,
      servers: ['https://content.example'],
      sources: [{ type: 'blossom', sha256, servers: ['https://source.example'] }],
    },
    [['server', 'https://tag.example']],
  );

  assert.deepEqual(sources[0].servers, [
    'https://source.example',
    'https://content.example',
    'https://tag.example',
  ]);
}

{
  const sources = collectRomByteSources(
    { sha256 },
    [["resource", `blossom:sha256:${sha256}.gbc`, "blossom"]],
  );

  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, `blossom:sha256:${sha256}`);
}

{
  const sources = collectRomByteSources(
    {
      sha256,
      resources: [{ url: "data:application/octet-stream;base64,AQID", bytes: 3 }],
    },
    [["resource", "data:application/octet-stream;base64,AQID"]],
  );

  assert.equal(sources.length, 1);
  assert.equal(sources[0].bytes, 3);
  assert.equal(sources[0].sha256, sha256);
}

console.log("ROM source parsing tests passed");

const rawHash = 'a'.repeat(64);
const transportHash = 'b'.repeat(64);
const encoded = { kind: 'blossom', label: 'Blossom', url: 'blossom:sha256:' + transportHash, encoding: 'base64', sha256: transportHash, decodedSha256: rawHash };
assert.equal(romContentHash({}, [], [encoded]), rawHash);
assert.equal(romContentHash({ sha256: 'invalid' }, [], [encoded]), rawHash);
assert.equal(romContentHash({ sha256: rawHash.toUpperCase() }, [], [encoded]), rawHash);
assert.equal(romContentHash({}, [], [{ ...encoded, decodedSha256: undefined }]), undefined);
assert.equal(romContentHash({}, [], [{ ...encoded, decodedSha256: undefined }, { ...encoded, encoding: undefined, sha256: rawHash }]), rawHash);
console.log('ROM identity tests passed: decoded versus transport hash, valid fallback, case normalization.');
