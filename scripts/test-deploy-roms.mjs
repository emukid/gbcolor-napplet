import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BLOSSOM_AUTH_KIND,
  ROM_EVENT_KIND,
  createRomEvent,
  createUploadAuthorization,
  encodeRomTransport,
  findGbcFiles,
  formatError,
  inferRomDetails,
  latestAddressableRomEvents,
  createMigratedRomEvent,
  readLegacyRomEvent,
  queryAllRomEvents,
  uploadRom,
} from "./deploy-roms.mjs";

const root = await mkdtemp(join(tmpdir(), "gbcolor-deploy-test-"));
await mkdir(join(root, "collection", "nested"), { recursive: true });
await writeFile(join(root, "collection", "Pokemon_Crystal (USA) (En,Fr) [Rev 1].GBC"), "rom-one");
await writeFile(join(root, "collection", "nested", "demo.gbc"), "rom-two");
await writeFile(join(root, "collection", "ignore.gb"), "not-gbc");

const files = await findGbcFiles(root);
assert.equal(files.length, 2);
const pokemonFile = files.find((file) => file.endsWith("Pokemon_Crystal (USA) (En,Fr) [Rev 1].GBC"));
assert.ok(pokemonFile);
assert.ok(files.some((file) => file.endsWith("demo.gbc")));

const details = inferRomDetails(pokemonFile, root);
assert.equal(details.name, "Pokemon Crystal");
assert.equal(details.slug, "pokemon-crystal-usa-en-fr-rev-1");
assert.deepEqual(details.regions, ["USA"]);
assert.deepEqual(details.languages, ["En", "Fr"]);
assert.equal(details.revision, "Rev 1");
assert.equal(details.relativePath, "collection/Pokemon_Crystal (USA) (En,Fr) [Rev 1].GBC");

const rom = {
  ...details,
  bytes: Buffer.from("rom-one"),
  size: 7,
  sha256: createHash('sha256').update('rom-one').digest('hex'),
};
const transport = encodeRomTransport(rom);
assert.equal(transport.encoding, 'base64');
assert.equal(transport.bytes.toString('utf8'), Buffer.from('rom-one').toString('base64'));
assert.equal(transport.decodedBytes, rom.size);
assert.equal(transport.decodedSha256, rom.sha256);
const event = createRomEvent(rom);
const content = JSON.parse(event.content);
assert.equal(event.kind, ROM_EVENT_KIND);
assert.deepEqual(event.tags[0], ["d", `gbcolor-rom-pokemon-crystal-usa-en-fr-rev-1-${rom.sha256.slice(0, 12)}`]);
assert.deepEqual(event.tags[5], ["resource", `blossom:sha256:${transport.sha256}`, "blossom"]);
assert.equal(content.sources[0].uri, `blossom:sha256:${transport.sha256}`);
assert.equal(content.sources[0].sha256, transport.sha256);
assert.equal(content.sources[0].bytes, transport.size);
assert.equal(content.sources[0].encoding, 'base64');
assert.equal(content.sources[0].decodedSha256, rom.sha256);
assert.equal(content.sources[0].decodedBytes, rom.size);

const hintedEvent = createRomEvent(rom, ['https://blossom.example']);
assert.deepEqual(JSON.parse(hintedEvent.content).sources[0].servers, ['https://blossom.example']);
assert.equal(content.metadata.inferred.regions, "USA");

const auth = createUploadAuthorization(rom, "https://blossom.example/path", 1000);
assert.equal(auth.kind, BLOSSOM_AUTH_KIND);
assert.equal(auth.created_at, 999);
assert.ok(auth.tags.some((tag) => tag[0] === "server" && tag[1] === "blossom.example"));
assert.ok(auth.tags.some((tag) => tag[0] === "x" && tag[1] === transport.sha256));
assert.ok(auth.tags.some((tag) => tag[0] === "expiration" && tag[1] === "1300"));

const signedAuth = { ...auth, id: "id", pubkey: "pubkey", sig: "sig" };
const signer = { signEvent: async () => signedAuth };
const requests = [];
const result = await uploadRom(rom, signer, ["https://blossom.example"], async (url, options) => {
  requests.push({ url: String(url), options });
  return new Response(JSON.stringify({ sha256: transport.sha256 }), { status: 201 });
});
assert.equal(result.server, "https://blossom.example");
assert.equal(requests[0].url, "https://blossom.example/upload");
assert.equal(requests[0].options.headers["X-SHA-256"], transport.sha256);
assert.equal(requests[0].options.headers["Content-Type"], 'text/plain; charset=utf-8');
assert.equal(Buffer.from(requests[0].options.body).toString('utf8'), transport.bytes.toString('utf8'));
assert.match(requests[0].options.headers.Authorization, /^Nostr [A-Za-z0-9_-]+$/);

const rawContent = {
  ...content,
  sources: [{
    type: 'blossom',
    uri: `blossom:sha256:${rom.sha256}`,
    bytes: rom.size,
    sha256: rom.sha256,
  }],
};
const rawEvent = {
  ...event,
  id: 'raw-event',
  created_at: 100,
  tags: event.tags.map((tag) => tag[0] === 'resource'
    ? ['resource', `blossom:sha256:${rom.sha256}`, 'blossom']
    : tag),
  content: JSON.stringify(rawContent),
};
const read = await readLegacyRomEvent(rawEvent, ['https://cdn.example'], async (url) => {
  assert.equal(url, `https://cdn.example/${rom.sha256}`);
  return new Response(Buffer.from('rom-one'), { status: 200 });
});
assert.equal(read.status, 'legacy');
assert.equal(read.rom.sha256, rom.sha256);
assert.equal(read.rom.bytes.toString('utf8'), 'rom-one');

const tobuBytes = Buffer.alloc(262144);
// Mirror fallback is accepted only when its bytes match the pinned public ROM hash.
await assert.rejects(
  readLegacyRomEvent({
    id: 'tobu-event',
    created_at: 1,
    tags: [['d', 'rom-tobudx'], ['name', 'tobudx']],
    content: JSON.stringify({
      name: 'tobudx',
      bytes: 262144,
      sha256: '0a0e8018dbbc8d7f8cd99f05e7cdc7b4cc9e358ecfe9377ebfb2291a84c6e310',
      sources: [{ type: 'resource', url: 'kehto-dev://gone' }],
    }),
  }, [], async (url) => {
    assert.equal(url, 'https://raw.githubusercontent.com/pixel-clover/ocelot/main/web/games/tobudx.gb');
    return new Response(tobuBytes, { status: 200 });
  }),
  /mirror hash mismatch/,
);

const current = await readLegacyRomEvent(
  { ...event, id: 'current-event' },
  ['https://cdn.example'],
  async () => { throw new Error('encoded events must not fetch legacy bytes'); },
);
assert.equal(current.status, 'current');

const migrated = createMigratedRomEvent(rawEvent, transport, ['https://cdn.example']);
const migratedContent = JSON.parse(migrated.content);
assert.equal(migratedContent.sources[0].encoding, 'base64');
assert.equal(migratedContent.sources[0].sha256, transport.sha256);
assert.equal(migratedContent.sources[0].decodedSha256, rom.sha256);
assert.ok(migrated.tags.some((tag) => tag[0] === 'resource' && tag[1] === `blossom:sha256:${transport.sha256}`));
assert.ok(!migrated.tags.some((tag) => tag[0] === 'resource' && tag[1] === `blossom:sha256:${rom.sha256}`));

assert.deepEqual(
  latestAddressableRomEvents([
    rawEvent,
    { ...rawEvent, id: 'newer-event', created_at: 101 },
    { ...rawEvent, id: 'other-event', created_at: 50, tags: [['d', 'other'], ['name', 'A ROM']] },
  ]).map((item) => item.id),
  ['other-event', 'newer-event'],
);

const queryCalls = [];
const pagedEvents = await queryAllRomEvents({
  querySync: async (_relays, filter) => {
    queryCalls.push(filter);
    if (filter.until === undefined) return [
      { ...rawEvent, id: 'page-3', created_at: 300 },
      { ...rawEvent, id: 'page-2', created_at: 200 },
    ];
    if (filter.until === 199) return [{ ...rawEvent, id: 'page-1', created_at: 100 }];
    if (filter.until === 99) return [];
    throw new Error(`unexpected cursor ${filter.until}`);
  },
}, ['wss://relay.example'], 'f'.repeat(64), 2);
assert.deepEqual(pagedEvents.map((item) => item.id), ['page-3', 'page-2', 'page-1']);
assert.deepEqual(queryCalls.map((filter) => filter.until), [undefined, 199, 99]);

assert.equal(
  formatError(new AggregateError(
    [new Error("relay one closed"), new Error("relay two denied")],
    "All promises were rejected",
  )),
  "All promises were rejected: relay one closed; relay two denied",
);

console.log("ROM deploy script tests passed.");
