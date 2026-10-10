# ROM Build and Publish Runbook

This runbook builds the Tobu Tobu Girl Deluxe ROM input used by the GBColor
napplet and deploys Game Boy Color ROM collections as Blossom blobs plus Nostr
ROM metadata events.

The napplet itself does not publish ROM events. Publishing is an operator action
using a Nostr signing key and relays.

## Event Contract

- Kind: `32560`
- Stable `d` tag: `gbcolor-rom-tobu-tobu-girl-deluxe`
- Resource loading: ordered `content.sources` plus repeated `resource`,
  `blossom`, or `torrent` tags, loaded by consumers through NAP-RESOURCE
- Spec: [../nips/NIP-ROM.md](../nips/NIP-ROM.md)

## Prerequisites

- `git`
- Node.js and npm
- A NIP-46 remote signer capable of scanning a `nostrconnect:` QR code
- [`nak`](https://github.com/fiatjaf/nak), only for the legacy manual workflow

Install project dependencies:

```sh
npm install
```

## Build the ROM Module

Generate `src/generated/tobu-rom.ts` from the pinned Tobu Webxdc checkout:

```sh
node scripts/build-rom.mjs
```

The script clones `https://gitlab.com/soapbox-pub/tobu-xdc.git` into
`.rom-cache/tobu-xdc`, checks out commit
`89b7ffa5d9b3945be5ed625ece031a1e373466f6`, and reads
`public/tobudx.gb`.

Expected ROM proof:

```text
bytes: 262144
sha256: 0a0e8018dbbc8d7f8cd99f05e7cdc7b4cc9e358ecfe9377ebfb2291a84c6e310
```

To build from an existing checkout instead:

```sh
TOBU_XDC_DIR=/path/to/tobu-xdc node scripts/build-rom.mjs
```

## Deploy ROMs from a Directory

Run the deployer with the ROM collection as its current working directory. It
recursively finds files whose extension is `.gbc` (case-insensitive):

```sh
cd /path/to/rom-collection
node /path/to/gbcolor-napplet/scripts/deploy-roms.mjs
```

The script starts by printing a NIP-46 QR code and waiting for a remote signer
through `wss://bucket.coracle.social`. Once connected, it:

1. Recursively discovers `.gbc` files, ignoring `.git` and `node_modules`.
2. Infers the title, region, language, revision, and event slug from the
   filename. No-Intro-style qualifiers such as `(USA) (En,Fr) [Rev 1]` are
   recognized.
3. Hashes each exact file, base64-encodes it as a portable text transport,
   uploads that transport through Blossom `PUT /upload`, and checks the
   server's returned transport SHA-256 when present.
4. Publishes an addressable kind `32560` event whose source is the canonical
   `blossom:sha256:<transport-sha256>` NAP-RESOURCE URL. The event records both
   transport and decoded ROM hashes/sizes, so the runtime verifies the fetched
   Blossom object and the napplet independently verifies the decoded ROM.

By default, upload servers are tried in this order until one accepts the blob:

- `https://cdn.hzrd149.com`
- `https://blssm.us`
- `https://nostr.download`
- `https://blossom.primal.net`

Events are published to `wss://nos.lol`, `wss://relay.primal.net`, and
`wss://relay.damus.io`. Override or repeat either destination with flags:

```sh
node /path/to/gbcolor-napplet/scripts/deploy-roms.mjs \
  --blossom https://my-blossom.example \
  --relay wss://my-relay.example \
  --relay wss://nos.lol
```

Run `node /path/to/gbcolor-napplet/scripts/deploy-roms.mjs --help` for all
options. The `pnpm deploy:roms` alias is convenient when the repository itself
is the intended scan root.

Each Blossom authorization is short-lived and scoped to the destination server
and exact transport hash. The local ephemeral NIP-46 client key is held only for
the life of the process; the user's secret key never enters this script.

The text transport is required for runtime portability. Some NAP-RESOURCE
implementations reject unknown binary MIME types even after a Blossom hash
check, while all current runtimes accept UTF-8 text. The decoded ROM is never
trusted implicitly: its original SHA-256 and byte count are verified before the
emulator starts.

## Migrate Already-Published ROM Events

Legacy events point Blossom directly at raw ROM binaries. Paja rejects those
bytes by MIME policy, so changing the napplet alone cannot repair those existing
records. Migrate them in place with the same signer that published them:

```sh
pnpm deploy:roms -- --migrate-existing
```

After the NIP-46 signer connects, the command queries its current kind `32560`
events, downloads each legacy Blossom object, verifies it against the event's
ROM SHA-256 and byte count, uploads the encoded transport, and publishes a newer
replacement event with the same `d` tag. Events already using the encoded
transport are skipped, so the migration is safe to rerun.

## Legacy Manual Source Selection

The ROM event needs at least one source for the ROM bytes. Consumers pass source
URLs to NAP-RESOURCE in order until one succeeds, then verify the canonical ROM
`sha256` and byte count.

Use one or more of these forms:

- Inline event bytes: omit all publish source environment variables. The script
  writes a `data:application/vnd.nintendo.gb-rom;base64,...` source.
- Blossom: set `PUBLISH_BLOSSOM_URI` to the canonical NAP-RESOURCE form
  `blossom:sha256:<sha256>`.
- Torrent / NIP-35: set `PUBLISH_MAGNET_URI` to a magnet URI or set
  `PUBLISH_TORRENT_INFOHASH` plus optional `PUBLISH_TORRENT_TRACKERS`, a
  comma-separated tracker list.
- Generic NAP-RESOURCE URL: set `PUBLISH_RESOURCE_URLS` to one or more
  comma-separated URLs such as `https://...`, `nostr:<bech32>`, or `data:...`.

Inline `data:` is easiest, but it creates a large event. Some relays may reject
it. If that happens, publish the ROM bytes to Blossom or another resource host
first and regenerate the event with external sources.

## Legacy Manual Event Generation

This writes an unsigned partial event to `/tmp/gbcolor-rom-event.partial.json`.
If no source environment variable is set, the command embeds the ROM bytes as a
`data:` source.

```sh
PUBLISH_RESOURCE_URLS="${PUBLISH_RESOURCE_URLS:-}" \
PUBLISH_BLOSSOM_URI="${PUBLISH_BLOSSOM_URI:-}" \
PUBLISH_MAGNET_URI="${PUBLISH_MAGNET_URI:-}" \
PUBLISH_TORRENT_INFOHASH="${PUBLISH_TORRENT_INFOHASH:-}" \
PUBLISH_TORRENT_TRACKERS="${PUBLISH_TORRENT_TRACKERS:-}" \
node <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const romPath = ".rom-cache/tobu-xdc/public/tobudx.gb";
const rom = readFileSync(romPath);
const sha256 = createHash("sha256").update(rom).digest("hex");
const mime = "application/vnd.nintendo.gb-rom";
const sources = [];
const sourceTags = [];

const addResource = (url, hint = sourceHint(url)) => {
  sources.push({ type: "resource", url, bytes: rom.length, sha256 });
  sourceTags.push(["resource", url, hint]);
};

const addBlossom = (uri) => {
  sources.push({ type: "blossom", uri, bytes: rom.length, sha256 });
  sourceTags.push(["resource", uri, "blossom"]);
};

const addTorrent = (uriOrInfohash) => {
  if (uriOrInfohash.startsWith("magnet:")) {
    sources.push({ type: "torrent", uri: uriOrInfohash, bytes: rom.length, sha256 });
    sourceTags.push(["resource", uriOrInfohash, "torrent"]);
    return;
  }
  const trackers = commaList(process.env.PUBLISH_TORRENT_TRACKERS);
  sources.push({
    type: "torrent",
    infohash: uriOrInfohash,
    path: "tobudx.gb",
    trackers,
    bytes: rom.length,
    sha256,
  });
  sourceTags.push(["torrent", uriOrInfohash, "tobudx.gb", String(rom.length)]);
  for (const tracker of trackers) sourceTags.push(["tracker", tracker]);
};

for (const url of commaList(process.env.PUBLISH_RESOURCE_URLS)) addResource(url);
if (process.env.PUBLISH_BLOSSOM_URI) addBlossom(process.env.PUBLISH_BLOSSOM_URI);
if (process.env.PUBLISH_MAGNET_URI) addTorrent(process.env.PUBLISH_MAGNET_URI);
if (process.env.PUBLISH_TORRENT_INFOHASH) addTorrent(process.env.PUBLISH_TORRENT_INFOHASH);

if (sources.length === 0) {
  const inline = `data:${mime};base64,${rom.toString("base64")}`;
  sources.push({ type: "inline", encoding: "base64", data: rom.toString("base64"), mime, bytes: rom.length, sha256 });
  sourceTags.push(["resource", inline, "inline"]);
}

const content = {
  schema: "rom.v1",
  name: "Tobu Tobu Girl Deluxe",
  platform: "gbc",
  mime,
  bytes: rom.length,
  sha256,
  sources,
  description: "Game Boy Color ROM packaged from soapbox-pub/tobu-xdc for GBColor.",
  license: "See upstream Tobu Webxdc and Tobu Tobu Girl Deluxe credits.",
};

const event = {
  kind: 32560,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ["d", "gbcolor-rom-tobu-tobu-girl-deluxe"],
    ["name", "Tobu Tobu Girl Deluxe"],
    ["platform", "gbc"],
    ["mime", mime],
    ["sha256", sha256],
    ...sourceTags,
    ["emulator", "wasmboy", "core", "0.7.1"],
    [
      "source",
      "https://gitlab.com/soapbox-pub/tobu-xdc",
      "git",
      "89b7ffa5d9b3945be5ed625ece031a1e373466f6",
    ],
  ],
  content: JSON.stringify(content),
};

writeFileSync("/tmp/gbcolor-rom-event.partial.json", JSON.stringify(event, null, 2));
console.log(`wrote /tmp/gbcolor-rom-event.partial.json`);
console.log(`bytes=${rom.length}`);
console.log(`sha256=${sha256}`);
console.log(`sources=${sources.length}`);

function commaList(value) {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function sourceHint(url) {
  if (url.startsWith("data:")) return "inline";
  if (url.startsWith("blossom:")) return "blossom";
  if (url.startsWith("magnet:")) return "torrent";
  return "resource";
}
NODE
```

Check the event before signing:

```sh
jq '{kind, created_at, tags, content: (.content | fromjson)}' \
  /tmp/gbcolor-rom-event.partial.json
```

## Legacy Manual Relay Publishing

Set the signing key. Use an `nsec`, hex secret key, `ncryptsec`, or bunker URL
accepted by `nak --sec`.

```sh
export NOSTR_SECRET_KEY='nsec...'
```

Publish:

```sh
cat /tmp/gbcolor-rom-event.partial.json | nak event \
  --sec "$NOSTR_SECRET_KEY" \
  wss://relay.primal.net \
  wss://relay.damus.io \
  wss://nos.lol
```

If a relay rejects the event as too large, publish with a smaller
external source such as `PUBLISH_BLOSSOM_URI` or `PUBLISH_RESOURCE_URLS`
instead of an inline `data:` URL.

## Verify Publication

Fetch the addressable ROM event by kind and `d` tag:

```sh
nak req \
  -k 32560 \
  -d gbcolor-rom-tobu-tobu-girl-deluxe \
  -l 1 \
  wss://relay.primal.net \
  wss://relay.damus.io \
  wss://nos.lol | jq '{id, pubkey, kind, tags, content: (.content | fromjson)}'
```

Confirm:

- `kind` is `32560`.
- The `d` tag is `gbcolor-rom-tobu-tobu-girl-deluxe`.
- The `sha256` tag and content value are
  `0a0e8018dbbc8d7f8cd99f05e7cdc7b4cc9e358ecfe9377ebfb2291a84c6e310`.
- The event contains at least one source in `content.sources`, `resource`,
  `blossom`, or `torrent`.
- Every source resolves to the same ROM `sha256` and byte count.
- Source URL schemes are supported by the target shell's NAP-RESOURCE
  implementation, or redundant alternatives are present.

## Rebuild the Napplet After ROM Changes

After publishing or changing the ROM source, rebuild and verify the napplet:

```sh
npm run typecheck
npm run build
npm run check:bundle
npm run test:conformance
```
