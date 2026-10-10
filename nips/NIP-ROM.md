# NIP-ROM

`draft` `optional`

This project-local draft defines a Nostr event for publishing emulator-loadable
ROM metadata for napplets and other clients that load bytes through
NAP-RESOURCE.

A ROM event defines one canonical ROM byte identity and one or more redundant
ways to retrieve those same bytes. The ROM can belong to any emulator community
or platform. Sources can be inline event data, Blossom blob references, NIP-35
torrent references, or any other NAP-RESOURCE URL a shell supports.

## Event Kind

Use kind `32560`.

Kind selection evidence on 2026-07-06: a `REQ` for `{ "kinds": [32560], "limit": 1 }`
returned `EOSE` with zero events from:

- `wss://relay.primal.net`
- `wss://relay.damus.io`
- `wss://nos.lol`

## Event Shape

The ROM event is addressable and uses the `d` tag as its stable ROM identifier.

```json
{
  "kind": 32560,
  "content": "{\"schema\":\"rom.v1\",\"name\":\"Example ROM\",\"platform\":\"gbc\",\"mime\":\"application/octet-stream\",\"bytes\":262144,\"sha256\":\"...\",\"sources\":[{\"type\":\"inline\",\"encoding\":\"base64\",\"data\":\"...\"},{\"type\":\"blossom\",\"sha256\":\"...\"},{\"type\":\"torrent\",\"infohash\":\"<btih>\",\"path\":\"example.gb\",\"trackers\":[\"udp://tracker.example:1337\"]}]}",
  "tags": [
    ["d", "rom-example"],
    ["name", "Example ROM"],
    ["platform", "gbc"],
    ["mime", "application/octet-stream"],
    ["sha256", "<lowercase-hex-sha256>"],
    ["resource", "data:application/octet-stream;base64,...", "inline"],
    ["resource", "blossom:sha256:<transport-sha256>", "blossom"],
    ["torrent", "<btih>", "example.gb", "262144"],
    ["tracker", "udp://tracker.example:1337"],
    ["emulator", "libretro", "gambatte", "compatible"],
    ["meta", "gb", "mapper", "<mapper-name>"],
    ["source", "https://example.com/upstream", "git", "<revision>"]
  ]
}
```

## Tags

- `d`: required. Stable identifier for this ROM record. Producers SHOULD use a
  durable, collision-resistant slug such as `rom-<name>` or a catalog-derived
  identifier.
- `name`: required. Human-readable ROM title.
- `platform`: optional and repeatable. Free-form platform or emulator community
  identifier. Examples: `gb`, `gbc`, `gba`, `nes`, `snes`, `genesis`, `psx`,
  `arcade`, `mame`, `dos`. The first `platform` tag SHOULD be treated as the
  primary platform.
- `mime`: required. Expected byte MIME. Use a registered ROM MIME where one is
  known, otherwise use `application/octet-stream`.
- `sha256`: required. Lowercase hex digest of the exact ROM bytes.
- `resource`: optional and repeatable. A NAP-RESOURCE URL for the ROM bytes.
  The optional third item is a source type hint: `inline`, `blossom`, `torrent`,
  or `resource`. Existing single-resource events remain valid.
- `blossom`: optional and repeatable. Either the canonical NAP-RESOURCE URI
  `blossom:sha256:<hex>` or the 64-character blob SHA-256. The runtime chooses
  Blossom servers according to shell policy.
- `torrent`: optional and repeatable. A NIP-35 BitTorrent info hash or magnet
  URI. Additional tag fields SHOULD be `file path` and `file size in bytes`.
- `tracker`: optional and repeatable. Torrent tracker URL used with `torrent`
  tags or content torrent sources.
- `meta`: optional and repeatable. Namespaced community metadata amendment,
  shaped as `["meta", "<namespace>", "<key>", "<value>", "<type?>"]`.
- `emulator`: optional and repeatable. Emulator or core compatibility hint,
  shaped as `["emulator", "<namespace>", "<name-or-core>", "<version-or-compat?>"]`.
- `i`: optional and repeatable. External catalog identifier using existing
  Nostr identity tag conventions, for example `no-intro:<id>`, `redump:<id>`,
  `mame:<shortname>`, or another community namespace.
- `source`: optional. Upstream project URL and optional source kind/revision.

Unknown `platform`, `meta`, `emulator`, and `i` values MUST be ignored by
consumers that do not understand that community namespace.

## Content

`content` is a JSON object:

```ts
interface RomContent {
  schema: "rom.v1";
  name: string;
  platform?: string;
  platforms?: string[];
  mime: string;
  bytes: number;
  sha256: string;
  sources?: RomSource[];
  description?: string;
  license?: string;
  metadata?: Record<string, Record<string, string | number | boolean>>;
}

type RomSource =
  | {
      type: "inline" | "data";
      encoding: "base64";
      data: string;
      mime?: string;
      bytes?: number;
      sha256?: string;
    }
  | {
      type: "blossom";
      uri?: string;        // canonical blossom:sha256:<hex>
      sha256?: string;     // required when uri is not supplied
      bytes?: number;
      servers?: string[];
      encoding?: "base64";
      decodedSha256?: string;
      decodedBytes?: number;
    }
  | {
      type: "torrent" | "nip35";
      uri?: string;       // magnet:... or nostr:... reference to a NIP-35 event
      infohash?: string;  // NIP-35 x tag / magnet btih value
      path?: string;      // NIP-35 file path to select
      trackers?: string[];
      bytes?: number;
      sha256?: string;
    }
  | {
      type: "resource";
      url: string;
      bytes?: number;
      sha256?: string;
    };
```

`content.platform` and `content.platforms` are advisory mirrors of `platform`
tags. Tags remain the preferred search and filtering surface.

At least one source MUST be present either in `content.sources`, a repeated
`resource` tag, a `blossom` tag, a `torrent` tag, or a NAP-RESOURCE sidecar.

Unencoded sources in one ROM event MUST resolve to the exact byte sequence
identified by the top-level `sha256` and `bytes` fields. Per-source `sha256` and
`bytes` fields identify the exact bytes returned by NAP-RESOURCE.

An encoded source MUST declare `encoding`, `decodedSha256`, and `decodedBytes`.
For `encoding: "base64"`, NAP-RESOURCE returns a UTF-8 base64 transport whose
hash and size are the source-level `sha256` and `bytes`; decoding it MUST produce
the ROM identified by `decodedSha256` and `decodedBytes`. Those decoded values
MUST equal the event's top-level ROM `sha256` and `bytes`.

## Community Metadata

The core event only standardizes byte identity, retrieval, and broad discovery
fields. Emulator and preservation communities can append optional namespaced
metadata without revising this draft.

Use `meta` tags for community-specific ROM facts:

```json
["meta", "no-intro", "serial", "<serial>"]
["meta", "redump", "disc-id", "<disc-id>"]
["meta", "mame", "driver", "<driver-shortname>"]
["meta", "gb", "mapper", "<mapper-name>"]
```

Use `emulator` tags for compatibility hints:

```json
["emulator", "libretro", "gambatte", "compatible"]
["emulator", "mame", "<driver-shortname>", "requires-bios"]
```

These tags MUST NOT override `sha256`, `bytes`, or source resolution. They are
advisory metadata for search, display, compatibility, and community tooling.
If two community metadata tags conflict, consumers SHOULD prefer the namespace
they understand best or display both values.

## Loading

Consumers MUST load ROM bytes through NAP-RESOURCE using the ordered source list.
Consumers SHOULD try sources in event order until one succeeds. Consumers MUST
verify each source's transport `sha256` and SHOULD verify its transport `bytes`.
When `encoding` is present, consumers MUST decode the transport, verify
`decodedSha256` and `decodedBytes`, and then verify the top-level ROM `sha256`
and `bytes` before executing the ROM. If a source fails, clients SHOULD try the
next source instead of treating the whole ROM event as failed.

Consumers MUST NOT use direct `fetch`, WebSocket relay clients, ambient
filesystem APIs, or app-owned relay pools to retrieve ROM bytes.

For Blossom sources, clients MUST pass the canonical
`blossom:sha256:<lowercase-hex>` URL to NAP-RESOURCE. Consumers MAY normalize
legacy BUD-10-shaped references before making the request. Consumers SHOULD pass
source `servers` as advisory NAP-RESOURCE Blossom server hints when the runtime
API supports them. The runtime validates and selects among those servers
according to shell policy.

For torrent sources, clients SHOULD treat NIP-35 as the torrent metadata shape:
`x` is the BitTorrent info hash, `file` selects the ROM file, and `tracker`
provides tracker hints. Napplets MUST delegate torrent retrieval to NAP-RESOURCE
or fail over to another source; they MUST NOT implement their own torrent client.

## Save Files

Save files, emulator states, BIOS files, and patch files are out of scope for
this ROM event kind. Applications MAY define separate event kinds or
application-specific records for those artifacts.
