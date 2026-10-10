#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { opendir, readFile } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import qrcode from "qrcode-terminal";
import { BunkerSigner, createNostrConnectURI } from "nostr-tools/nip46";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";

export const ROM_EVENT_KIND = 32560;
export const BLOSSOM_AUTH_KIND = 24242;
export const ROM_MIME = "application/vnd.nintendo.gb-rom";
export const ROM_TRANSPORT_MIME = "text/plain; charset=utf-8";
export const DEFAULT_CONNECTION_RELAY = "wss://bucket.coracle.social";
export const DEFAULT_EVENT_RELAYS = [
  "wss://relay.nappley.soy",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostrue.com",
  "wss://schnorr.me",
  "wss://nostr.kosmos.org"
];
export const DEFAULT_BLOSSOM_SERVERS = [
  "https://blossom.napplet.soy",
  "https://cdn.hzrd149.com",
  "https://nostr.download",
  "https://blossom.primal.net",
  "https://24242.io"
];

const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);
const REGION_NAMES = new Map([
  ["australia", "Australia"],
  ["brazil", "Brazil"],
  ["canada", "Canada"],
  ["china", "China"],
  ["europe", "Europe"],
  ["france", "France"],
  ["germany", "Germany"],
  ["italy", "Italy"],
  ["japan", "Japan"],
  ["korea", "Korea"],
  ["netherlands", "Netherlands"],
  ["spain", "Spain"],
  ["sweden", "Sweden"],
  ["taiwan", "Taiwan"],
  ["usa", "USA"],
  ["world", "World"],
]);
const LANGUAGE_CODES = new Set([
  "En", "Ja", "Fr", "De", "Es", "It", "Nl", "Pt", "Sv", "No", "Da",
  "Fi", "Ko", "Zh", "Ru", "Pl",
]);
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const KNOWN_ROM_MIRRORS = new Map([
  [
    "0a0e8018dbbc8d7f8cd99f05e7cdc7b4cc9e358ecfe9377ebfb2291a84c6e310",
    "https://raw.githubusercontent.com/pixel-clover/ocelot/main/web/games/tobudx.gb",
  ],
]);

export async function findGbcFiles(root) {
  const files = [];
  await walk(resolve(root), files);
  return files.sort((left, right) => left.localeCompare(right));
}

async function walk(directory, files) {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(path, files);
      continue;
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".gbc") {
      files.push(path);
    }
  }
}

export function inferRomDetails(filePath, root = process.cwd()) {
  const fileName = basename(filePath);
  const stem = fileName.slice(0, -extname(fileName).length);
  const qualifiers = [...stem.matchAll(/\(([^)]+)\)|\[([^\]]+)\]/g)]
    .map((match) => (match[1] ?? match[2]).trim())
    .filter(Boolean);
  const unqualified = stem.replace(/\s*(?:\([^)]*\)|\[[^\]]*\])/g, " ");
  const name = humanize(unqualified) || humanize(stem) || "Untitled ROM";
  const regions = qualifiers
    .flatMap((item) => item.split(/\s*,\s*/))
    .map((item) => REGION_NAMES.get(item.toLowerCase()))
    .filter(Boolean);
  const languages = qualifiers
    .flatMap((item) => item.split(/\s*,\s*/))
    .map(normalizeLanguageCode)
    .filter(Boolean);
  const revision = qualifiers.find((item) => /^(?:rev(?:ision)?|v(?:ersion)?)\s*[\w.-]+$/i.test(item));
  const relativePath = relative(resolve(root), resolve(filePath)).split(sep).join("/");

  return {
    fileName,
    relativePath,
    name,
    slug: slugify(stem),
    qualifiers,
    regions: unique(regions),
    languages: unique(languages),
    revision,
  };
}

export async function inspectRom(filePath, root = process.cwd()) {
  const bytes = await readFile(filePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    ...inferRomDetails(filePath, root),
    filePath,
    bytes,
    size: bytes.length,
    sha256,
  };
}

export function encodeRomTransport(rom) {
  const encoded = Buffer.from(rom.bytes).toString("base64");
  const bytes = Buffer.from(encoded, "utf8");
  return {
    encoding: "base64",
    bytes,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    decodedBytes: rom.size,
    decodedSha256: rom.sha256,
  };
}

export function createRomEvent(rom, servers = [], transport = encodeRomTransport(rom)) {
  const blossomUri = `blossom:sha256:${transport.sha256}`;
  const inferred = {};
  if (rom.qualifiers.length > 0) inferred.qualifiers = rom.qualifiers.join(", ");
  if (rom.regions.length > 0) inferred.regions = rom.regions.join(", ");
  if (rom.languages.length > 0) inferred.languages = rom.languages.join(", ");
  if (rom.revision) inferred.revision = rom.revision;

  const content = {
    schema: "rom.v1",
    name: rom.name,
    platform: "gbc",
    mime: ROM_MIME,
    bytes: rom.size,
    sha256: rom.sha256,
    sources: [{
      type: "blossom",
      uri: blossomUri,
      mime: ROM_TRANSPORT_MIME,
      bytes: transport.size,
      sha256: transport.sha256,
      encoding: transport.encoding,
      decodedBytes: transport.decodedBytes,
      decodedSha256: transport.decodedSha256,
      ...(servers.length > 0 ? { servers } : {}),
    }],
    description: `Game Boy Color ROM deployed from ${rom.relativePath}.`,
    metadata: {
      file: { name: rom.fileName, path: rom.relativePath },
      ...(Object.keys(inferred).length > 0 ? { inferred } : {}),
    },
  };

  const tags = [
    ["d", `gbcolor-rom-${rom.slug}-${rom.sha256.slice(0, 12)}`],
    ["name", rom.name],
    ["platform", "gbc"],
    ["mime", ROM_MIME],
    ["sha256", rom.sha256],
    ["resource", blossomUri, "blossom"],
  ];
  for (const region of rom.regions) tags.push(["meta", "gb", "region", region]);
  for (const language of rom.languages) tags.push(["meta", "gb", "language", language]);
  if (rom.revision) tags.push(["meta", "gb", "revision", rom.revision]);

  return {
    kind: ROM_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify(content),
  };
}

export function createUploadAuthorization(
  rom,
  server,
  now = Math.floor(Date.now() / 1000),
  transport = encodeRomTransport(rom),
) {
  return {
    kind: BLOSSOM_AUTH_KIND,
    created_at: now - 1,
    tags: [
      ["t", "upload"],
      ["x", transport.sha256],
      ["server", new URL(server).hostname.toLowerCase()],
      ["expiration", String(now + 5 * 60)],
    ],
    content: `Upload ${rom.fileName}`,
  };
}

export async function uploadRom(rom, signer, servers, fetchImpl = fetch) {
  const failures = [];
  const transport = encodeRomTransport(rom);
  for (const server of servers) {
    try {
      const authorization = await signer.signEvent(createUploadAuthorization(rom, server, undefined, transport));
      const response = await fetchImpl(new URL("/upload", server), {
        method: "PUT",
        headers: {
          Authorization: `Nostr ${base64Url(JSON.stringify(authorization))}`,
          "Content-Type": ROM_TRANSPORT_MIME,
          "Content-Length": String(transport.size),
          "X-SHA-256": transport.sha256,
        },
        body: transport.bytes,
        signal: AbortSignal.timeout(60_000),
      });
      const responseBody = await response.text();
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}${responseBody ? `: ${responseBody.slice(0, 240)}` : ""}`);
      }
      const descriptor = parseJson(responseBody);
      if (descriptor?.sha256 && descriptor.sha256.toLowerCase() !== transport.sha256) {
        throw new Error(`server returned the wrong sha256 (${descriptor.sha256})`);
      }
      return { server, descriptor, transport };
    } catch (error) {
      failures.push(`${server}: ${formatError(error)}`);
    }
  }
  throw new Error(`all Blossom uploads failed\n  ${failures.join("\n  ")}`);
}

export async function readLegacyRomEvent(event, fallbackServers, fetchImpl = fetch) {
  const content = parseJson(event.content);
  if (!content || typeof content !== "object") {
    throw new Error(`event ${event.id ?? "(unsigned)"} content is not JSON`);
  }
  const sha256 = typeof content.sha256 === "string" ? content.sha256.toLowerCase() : "";
  const size = Number.isSafeInteger(content.bytes) && content.bytes > 0 ? content.bytes : undefined;
  if (!SHA256_HEX.test(sha256)) throw new Error("ROM event has no valid top-level sha256");
  if (!size) throw new Error("ROM event has no valid top-level byte count");

  const sourceRecords = Array.isArray(content.sources)
    ? content.sources.filter((source) => source && typeof source === "object")
    : [];
  if (sourceRecords.some((source) => source.encoding === "base64")) {
    return { status: "current", content };
  }

  const locations = [];
  for (const source of sourceRecords) {
    const type = source.type ?? source.kind;
    if (type !== "blossom") continue;
    const uri = source.uri ?? source.url ?? source.resource;
    const hash = blossomHash(typeof uri === "string" ? uri : source.sha256);
    if (!hash) continue;
    const servers = unique([
      ...(Array.isArray(source.servers) ? source.servers.filter((server) => typeof server === "string") : []),
      ...fallbackServers,
    ]).map(normalizeHttpUrl);
    locations.push({ hash, servers });
  }
  for (const tag of event.tags ?? []) {
    if ((tag[0] !== "resource" && tag[0] !== "blossom") || typeof tag[1] !== "string") continue;
    const hash = blossomHash(tag[1]);
    if (hash) locations.push({ hash, servers: fallbackServers });
  }
  if (locations.length === 0) {
    const mirror = KNOWN_ROM_MIRRORS.get(sha256);
    if (!mirror) throw new Error("ROM event has no legacy Blossom source or verified public mirror");
    const response = await fetchImpl(mirror, { method: "GET", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`verified ROM mirror returned ${response.status} ${response.statusText}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const mirrorHash = createHash("sha256").update(bytes).digest("hex");
    if (mirrorHash !== sha256) throw new Error("verified ROM mirror hash mismatch");
    if (bytes.length !== size) throw new Error("verified ROM mirror byte count mismatch");
    return {
      status: "legacy",
      content,
      rom: {
        bytes,
        size,
        sha256,
        name: typeof content.name === "string" ? content.name : eventName(event),
        fileName: existingFileName(content, event),
      },
    };
  }

  const failures = [];
  for (const location of locations) {
    for (const server of location.servers) {
      try {
        const response = await fetchImpl(`${server}/${location.hash}`, {
          method: "GET",
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const sourceHash = createHash("sha256").update(bytes).digest("hex");
        if (sourceHash !== location.hash) throw new Error("Blossom transport hash mismatch");
        if (sourceHash !== sha256) throw new Error("legacy source does not contain the declared ROM bytes");
        if (bytes.length !== size) throw new Error("legacy source byte count mismatch");
        return {
          status: "legacy",
          content,
          rom: {
            bytes,
            size,
            sha256,
            name: typeof content.name === "string" ? content.name : eventName(event),
            fileName: existingFileName(content, event),
          },
        };
      } catch (error) {
        failures.push(`${server}/${location.hash}: ${formatError(error)}`);
      }
    }
  }
  throw new Error(`no legacy Blossom source returned the declared ROM\n  ${failures.join("\n  ")}`);
}

export function createMigratedRomEvent(event, transport, servers) {
  const content = parseJson(event.content);
  if (!content || typeof content !== "object") throw new Error("ROM event content is not JSON");
  const blossomUri = `blossom:sha256:${transport.sha256}`;
  const existingSources = Array.isArray(content.sources)
    ? content.sources.filter((source) => source && typeof source === "object" && (source.type ?? source.kind) !== "blossom")
    : [];
  const source = {
    type: "blossom",
    uri: blossomUri,
    mime: ROM_TRANSPORT_MIME,
    bytes: transport.size,
    sha256: transport.sha256,
    encoding: transport.encoding,
    decodedBytes: transport.decodedBytes,
    decodedSha256: transport.decodedSha256,
    ...(servers.length > 0 ? { servers } : {}),
  };
  const tags = (event.tags ?? [])
    .filter((tag) => !isLegacyBlossomTag(tag))
    .map((tag) => [...tag]);
  tags.push(["resource", blossomUri, "blossom"]);
  return {
    kind: event.kind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify({ ...content, sources: [source, ...existingSources] }),
  };
}

export function latestAddressableRomEvents(events) {
  const latest = new Map();
  for (const event of events) {
    const dTag = event.tags?.find((tag) => tag[0] === "d")?.[1];
    if (!dTag) continue;
    const current = latest.get(dTag);
    if (!current || event.created_at > current.created_at
      || (event.created_at === current.created_at && event.id > current.id)) {
      latest.set(dTag, event);
    }
  }
  return [...latest.values()].sort((left, right) => eventName(left).localeCompare(eventName(right)));
}

export async function queryAllRomEvents(pool, relays, pubkey, pageSize = 500) {
  const events = new Map();
  let until;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await pool.querySync(
      relays,
      {
        kinds: [ROM_EVENT_KIND],
        authors: [pubkey],
        limit: pageSize,
        ...(until === undefined ? {} : { until }),
      },
      { maxWait: 15_000 },
    );
    if (page.length === 0) break;
    for (const event of page) events.set(event.id, event);
    const oldest = Math.min(...page.map((event) => event.created_at));
    if (!Number.isSafeInteger(oldest) || oldest <= 0) break;
    const nextUntil = oldest - 1;
    if (until !== undefined && nextUntil >= until) break;
    until = nextUntil;
  }
  return [...events.values()];
}

export async function publishEvent(event, signer, pool, relays) {
  const signed = await signer.signEvent(event);
  const results = await Promise.allSettled(
    pool.publish(relays, signed, {
      maxWait: 15_000,
      onauth: (template) => signer.signEvent(template),
    }),
  );
  const accepted = [];
  const rejected = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") accepted.push(relays[index]);
    else rejected.push(`${relays[index]}: ${formatError(result.reason)}`);
  });
  if (accepted.length === 0) {
    throw new Error(`all relays rejected event ${signed.id}\n  ${rejected.join("\n  ")}`);
  }
  return { signed, accepted, rejected };
}

async function connectSigner(connectionRelay, timeoutMs) {
  useWebSocketImplementation(WebSocket);
  const pool = new SimplePool({ enableReconnect: true });
  const clientSecretKey = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecretKey);
  const uri = createNostrConnectURI({
    clientPubkey,
    relays: [connectionRelay],
    secret: randomBytes(16).toString("hex"),
    perms: [`sign_event:${BLOSSOM_AUTH_KIND}`, `sign_event:${ROM_EVENT_KIND}`],
    name: "GBColor ROM Deployer",
  });

  console.log("Scan this NIP-46 QR code with your remote signer:\n");
  qrcode.generate(uri, { small: true });
  console.log(`\n${uri}\n`);
  console.log(`Waiting for the signer on ${connectionRelay} ...`);

  try {
    const signer = await BunkerSigner.fromURI(
      clientSecretKey,
      uri,
      {
        pool,
        // Keep every NIP-46 RPC on the relay encoded in the QR. Without this,
        // nostr-tools asks the signer for a replacement relay list immediately
        // after connecting, and a failed replacement can strand the session.
        skipSwitchRelays: true,
        onauth: (url) => console.log(`Signer authorization required: ${url}`),
      },
      timeoutMs,
    );
    let pubkey;
    try {
      pubkey = await signer.getPublicKey();
    } catch (error) {
      throw new Error(
        `connected, but the NIP-46 get_public_key request failed on ${connectionRelay}: ${formatError(error)}`,
        { cause: error },
      );
    }
    console.log(`Connected as ${pubkey}.\n`);
    return { signer, pool, pubkey };
  } catch (error) {
    pool.destroy();
    throw error;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  // Authentication deliberately happens before filesystem discovery.
  const { signer, pool, pubkey } = await connectSigner(options.connectionRelay, options.connectionTimeoutMs);
  try {
    if (options.migrateExisting) {
      await migrateExistingEvents({ signer, pool, pubkey, options });
      return;
    }
    const files = await findGbcFiles(process.cwd());
    if (files.length === 0) throw new Error(`no .gbc files found beneath ${process.cwd()}`);
    console.log(`Found ${files.length} .gbc file${files.length === 1 ? "" : "s"}.`);

    const failures = [];
    for (const [index, file] of files.entries()) {
      const label = relative(process.cwd(), file) || basename(file);
      console.log(`\n[${index + 1}/${files.length}] ${label}`);
      try {
        const rom = await inspectRom(file, process.cwd());
        console.log(`  ${rom.name} · ${rom.size} bytes · ${rom.sha256}`);
        const upload = await uploadRom(rom, signer, options.blossomServers);
        console.log(`  Blob uploaded to ${upload.server}`);
        const published = await publishEvent(
          createRomEvent(rom, [upload.server], upload.transport),
          signer,
          pool,
          options.eventRelays,
        );
        console.log(`  Event ${published.signed.id} published to ${published.accepted.length}/${options.eventRelays.length} relays`);
        for (const rejection of published.rejected) console.warn(`  Relay warning: ${rejection}`);
      } catch (error) {
        failures.push(`${label}: ${formatError(error)}`);
        console.error(`  Failed: ${formatError(error)}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`${failures.length}/${files.length} ROM deployments failed\n  ${failures.join("\n  ")}`);
    }
    console.log(`\nDeployed ${files.length} ROM${files.length === 1 ? "" : "s"}.`);
  } finally {
    await signer.close();
    pool.destroy();
  }
}

async function migrateExistingEvents({ signer, pool, pubkey, options }) {
  console.log(`Querying kind ${ROM_EVENT_KIND} events for ${pubkey} ...`);
  const queried = await queryAllRomEvents(pool, options.eventRelays, pubkey);
  const events = latestAddressableRomEvents(queried);
  if (events.length === 0) throw new Error("no published ROM events found for the connected signer");
  console.log(`Found ${events.length} current ROM event${events.length === 1 ? "" : "s"}.`);

  const failures = [];
  let migrated = 0;
  let current = 0;
  for (const [index, event] of events.entries()) {
    const label = eventName(event);
    console.log(`\n[${index + 1}/${events.length}] ${label}`);
    try {
      const legacy = await readLegacyRomEvent(event, options.blossomServers);
      if (legacy.status === "current") {
        current += 1;
        console.log("  Already uses the portable encoded transport");
        continue;
      }
      const upload = await uploadRom(legacy.rom, signer, options.blossomServers);
      console.log(`  Encoded transport uploaded to ${upload.server}`);
      const published = await publishEvent(
        createMigratedRomEvent(event, upload.transport, [upload.server]),
        signer,
        pool,
        options.eventRelays,
      );
      migrated += 1;
      console.log(`  Replacement event ${published.signed.id} published to ${published.accepted.length}/${options.eventRelays.length} relays`);
      for (const rejection of published.rejected) console.warn(`  Relay warning: ${rejection}`);
    } catch (error) {
      failures.push(`${label}: ${formatError(error)}`);
      console.error(`  Failed: ${formatError(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length}/${events.length} ROM migrations failed\n  ${failures.join("\n  ")}`);
  }
  console.log(`\nMigration complete: ${migrated} migrated, ${current} already current.`);
}

function parseArguments(args) {
  const options = {
    blossomServers: [],
    eventRelays: [],
    connectionRelay: DEFAULT_CONNECTION_RELAY,
    connectionTimeoutMs: 5 * 60_000,
    migrateExisting: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--migrate-existing") options.migrateExisting = true;
    else if (arg === "--blossom") options.blossomServers.push(requireValue(args, ++index, arg));
    else if (arg === "--relay") options.eventRelays.push(requireValue(args, ++index, arg));
    else if (arg === "--connection-relay") options.connectionRelay = requireValue(args, ++index, arg);
    else if (arg === "--connection-timeout") {
      const seconds = Number(requireValue(args, ++index, arg));
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`${arg} must be a positive number of seconds`);
      options.connectionTimeoutMs = seconds * 1000;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.blossomServers.length === 0) options.blossomServers = [...DEFAULT_BLOSSOM_SERVERS];
  if (options.eventRelays.length === 0) options.eventRelays = [...DEFAULT_EVENT_RELAYS];
  options.blossomServers = options.blossomServers.map(normalizeHttpUrl);
  options.eventRelays = options.eventRelays.map(normalizeRelayUrl);
  options.connectionRelay = normalizeRelayUrl(options.connectionRelay);
  return options;
}

function printHelp() {
  console.log(`Usage: pnpm deploy:roms [options]

Recursively finds .gbc files below the current working directory, uploads each
file to Blossom, and publishes a kind ${ROM_EVENT_KIND} ROM event through a
NIP-46 remote signer.

With --migrate-existing, queries the connected signer's published kind
${ROM_EVENT_KIND} events, downloads and verifies their legacy raw Blossom ROMs,
then republishes them using the portable encoded transport. No local ROM files
are required.

Options:
  --blossom <https-url>       Blossom upload server; repeat for fallback
  --relay <wss-url>           Event relay; repeat to publish to several
  --connection-relay <url>    NIP-46 relay (default: ${DEFAULT_CONNECTION_RELAY})
  --connection-timeout <sec>  QR connection timeout (default: 300)
  --migrate-existing          Repair published legacy raw-ROM events in place
  -h, --help                  Show this help
`);
}

function humanize(value) {
  const clean = value.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  return clean
    .split(" ")
    .map((word) => (/^[a-z\d]+$/.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return createHash("sha256").update(value).digest("hex").slice(0, 16);
  return slug.slice(0, 180).replace(/-+$/g, "");
}

function normalizeLanguageCode(value) {
  const normalized = value.length === 2
    ? value.charAt(0).toUpperCase() + value.charAt(1).toLowerCase()
    : value;
  return LANGUAGE_CODES.has(normalized) ? normalized : undefined;
}

function unique(values) {
  return [...new Set(values)];
}

function blossomHash(value) {
  if (typeof value !== "string") return undefined;
  const match = /^blossom:(?:sha256:)?([0-9a-f]{64})(?:\.[0-9a-z]+)?(?:\?.*)?$/i.exec(value.trim());
  if (match) return match[1].toLowerCase();
  return SHA256_HEX.test(value) ? value.toLowerCase() : undefined;
}

function isLegacyBlossomTag(tag) {
  if (!Array.isArray(tag)) return false;
  if (tag[0] === "blossom") return true;
  return tag[0] === "resource" && typeof tag[1] === "string" && Boolean(blossomHash(tag[1]));
}

function eventName(event) {
  const tagged = event.tags?.find((tag) => tag[0] === "name")?.[1];
  if (tagged) return tagged;
  const content = parseJson(event.content ?? "");
  if (content && typeof content.name === "string") return content.name;
  return event.tags?.find((tag) => tag[0] === "d")?.[1] ?? event.id ?? "Unnamed ROM";
}

function existingFileName(content, event) {
  const metadataFile = content.metadata?.file;
  if (metadataFile && typeof metadataFile === "object" && typeof metadataFile.name === "string") {
    return metadataFile.name;
  }
  return `${eventName(event).replace(/[^a-z0-9._-]+/gi, "-") || "rom"}.gbc`;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function parseJson(value) {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function normalizeHttpUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Blossom server must use http(s): ${value}`);
  }
  url.pathname = url.pathname.replace(/\/+$/g, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeRelayUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error(`relay must use ws(s): ${value}`);
  }
  return url.toString().replace(/\/$/, "");
}

export function formatError(error) {
  const aggregateErrors = error && typeof error === "object" && "errors" in error
    ? [...error.errors]
    : [];
  if (aggregateErrors.length > 0) {
    const details = aggregateErrors.map(formatError).filter(Boolean);
    const message = error instanceof Error && error.message ? error.message : "multiple errors";
    return `${message}: ${details.join("; ")}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`\nROM deployment failed: ${formatError(error)}`);
    process.exitCode = 1;
  });
}
