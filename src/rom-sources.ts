export type RomSourceKind = 'resource' | 'inline' | 'blossom' | 'torrent';
export type RomTransportEncoding = 'base64';

export type RomByteSource = {
  kind: RomSourceKind;
  url: string;
  label: string;
  sha256?: string;
  bytes?: number;
  servers?: string[];
  encoding?: RomTransportEncoding;
  decodedSha256?: string;
  decodedBytes?: number;
};

type SourceDefaults = {
  sha256?: string;
  bytes?: number;
  mime?: string;
  trackers: string[];
  servers: string[];
  encoding?: RomTransportEncoding;
  decodedSha256?: string;
  decodedBytes?: number;
};

const HEX_64 = /^[0-9a-f]{64}$/i;

export function collectRomByteSources(
  content: Record<string, unknown>,
  tags: readonly string[][],
): RomByteSource[] {
  const defaults: SourceDefaults = {
    sha256: readString(content, 'sha256') ?? readTag(tags, 'sha256') ?? readLegacySha256Tag(tags),
    bytes: readInteger(content, 'bytes'),
    mime: readString(content, 'mime') ?? readTag(tags, 'mime'),
    trackers: readTags(tags, 'tracker'),
    servers: uniqueStrings([
      ...readStringList(content, 'servers'),
      ...readTags(tags, 'server'),
    ]),
  };
  const sources: RomByteSource[] = [];

  pushRecordArray(sources, content.sources, defaults);
  pushRecordArray(sources, content.resources, defaults);

  for (const tag of tags) {
    const [name, value, kindHint, bytes] = tag;
    if ((name === 'resource' || name === 'r') && value) {
      pushSource(sources, sourceFromUrl(value, kindHint, {
        ...defaults,
        bytes: parseInteger(bytes) ?? defaults.bytes,
      }));
    }
  }

  for (const tag of tags) {
    const [, value, extensionOrBytes, bytes] = tag;
    if (tag[0] === 'blossom' && value) {
      const source = HEX_64.test(value)
        ? sourceFromBlossomRecord(
            {
              sha256: value,
              bytes: parseInteger(bytes ?? extensionOrBytes),
            },
            defaults,
          )
        : sourceFromUrl(value, 'blossom', defaults);
      pushSource(sources, source);
    }
  }

  for (const tag of tags) {
    if (tag[0] === 'magnet' && tag[1]) {
      pushSource(sources, sourceFromUrl(tag[1], 'torrent', defaults));
    }
    if (tag[0] === 'torrent' && tag[1]) {
      pushSource(
        sources,
        sourceFromTorrentRecord(
          {
            infohash: tag[1],
            path: tag[2],
            bytes: parseInteger(tag[3]),
          },
          defaults,
        ),
      );
    }
  }

  pushRecordArray(sources, content.torrents, defaults);
  if (isRecord(content.torrent)) {
    pushSource(sources, sourceFromTorrentRecord(content.torrent, defaults));
  }

  return sources;
}

/** ROM identity must describe decoded cartridge bytes, not an encoded download. */
export function romContentHash(content: Record<string, unknown>, tags: readonly string[][], sources: readonly RomByteSource[]): string | undefined {
  const candidates = [
    readString(content, 'sha256'), readTag(tags, 'sha256'), readLegacySha256Tag(tags),
    ...sources.map(source => source.encoding ? source.decodedSha256 : source.sha256),
  ];
  return candidates.find(value => typeof value === 'string' && HEX_64.test(value))?.toLowerCase();
}

export function decodeRomTransport(
  bytes: Uint8Array,
  source: Pick<RomByteSource, 'encoding' | 'label'>,
): Uint8Array {
  if (source.encoding !== 'base64') {
    return bytes;
  }
  let encoded: string;
  try {
    encoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  } catch {
    throw new Error(`${source.label} transport is not valid UTF-8`);
  }
  try {
    const binary = atob(encoded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error(`${source.label} transport is not valid base64`);
  }
}

function pushRecordArray(
  sources: RomByteSource[],
  value: unknown,
  defaults: SourceDefaults,
): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (isRecord(item)) {
      pushSource(sources, sourceFromRecord(item, defaults));
    }
  }
}

function sourceFromRecord(record: Record<string, unknown>, defaults: SourceDefaults): RomByteSource | undefined {
  const type = readString(record, 'type') ?? readString(record, 'kind');
  const uri = readString(record, 'uri') ?? readString(record, 'url') ?? readString(record, 'resource');
  const encoding = readTransportEncoding(record, 'encoding');
  if (uri) {
    return sourceFromUrl(uri, type, {
      ...defaults,
      sha256: readString(record, 'sha256') ?? defaults.sha256,
      bytes: readInteger(record, 'bytes') ?? readInteger(record, 'size') ?? defaults.bytes,
      mime: readString(record, 'mime') ?? readString(record, 'type') ?? defaults.mime,
      servers: uniqueStrings([...readStringList(record, 'servers'), ...defaults.servers]),
      ...(encoding ? {
        encoding,
        decodedSha256: readString(record, 'decodedSha256') ?? defaults.sha256,
        decodedBytes: readInteger(record, 'decodedBytes') ?? defaults.bytes,
      } : {}),
    });
  }

  if (type === 'inline' || type === 'data') {
    return sourceFromInlineRecord(record, defaults);
  }
  if (type === 'blossom') {
    return sourceFromBlossomRecord(record, defaults);
  }
  if (type === 'torrent' || type === 'nip35') {
    return sourceFromTorrentRecord(record, defaults);
  }
  return undefined;
}

function sourceFromUrl(
  url: string,
  kindHint: string | undefined,
  defaults: SourceDefaults,
): RomByteSource | undefined {
  const kind = sourceKind(url, kindHint);
  const bytes = defaults.bytes;
  const servers = kind === 'blossom'
    ? uniqueStrings([...blossomServerHints(url), ...defaults.servers])
    : [];
  const canonicalUrl = kind === 'blossom' ? canonicalBlossomUrl(url, defaults.sha256) : url;
  if (!canonicalUrl) {
    return undefined;
  }
  return {
    kind,
    url: canonicalUrl,
    label: sourceLabel(kind),
    sha256: defaults.sha256,
    ...(typeof bytes === 'number' ? { bytes } : {}),
    ...(servers.length > 0 ? { servers } : {}),
    ...(defaults.encoding ? { encoding: defaults.encoding } : {}),
    ...(defaults.decodedSha256 ? { decodedSha256: defaults.decodedSha256 } : {}),
    ...(typeof defaults.decodedBytes === 'number' ? { decodedBytes: defaults.decodedBytes } : {}),
  };
}

function sourceFromInlineRecord(
  record: Record<string, unknown>,
  defaults: SourceDefaults,
): RomByteSource | undefined {
  const data = readString(record, 'data');
  const encoding = readString(record, 'encoding') ?? 'base64';
  if (!data || encoding !== 'base64') {
    return undefined;
  }
  const mime = readString(record, 'mime') ?? defaults.mime ?? 'application/octet-stream';
  return {
    kind: 'inline',
    url: `data:${mime};base64,${data}`,
    label: sourceLabel('inline'),
    sha256: readString(record, 'sha256') ?? defaults.sha256,
    bytes: readInteger(record, 'bytes') ?? defaults.bytes,
  };
}

function sourceFromBlossomRecord(
  record: Record<string, unknown>,
  defaults: SourceDefaults,
): RomByteSource | undefined {
  const sha256 = readString(record, 'sha256') ?? defaults.sha256;
  if (!sha256 || !HEX_64.test(sha256)) {
    return undefined;
  }
  const bytes = readInteger(record, 'bytes') ?? readInteger(record, 'size') ?? defaults.bytes;
  const servers = uniqueStrings([...readStringList(record, 'servers'), ...defaults.servers]);
  const encoding = readTransportEncoding(record, 'encoding') ?? defaults.encoding;
  return {
    kind: 'blossom',
    url: `blossom:sha256:${sha256.toLowerCase()}`,
    label: sourceLabel('blossom'),
    sha256: sha256.toLowerCase(),
    ...(typeof bytes === 'number' ? { bytes } : {}),
    ...(servers.length > 0 ? { servers } : {}),
    ...(encoding ? { encoding } : {}),
    ...(encoding && (readString(record, 'decodedSha256') ?? defaults.decodedSha256 ?? defaults.sha256)
      ? { decodedSha256: readString(record, 'decodedSha256') ?? defaults.decodedSha256 ?? defaults.sha256 }
      : {}),
    ...(encoding && typeof (readInteger(record, 'decodedBytes') ?? defaults.decodedBytes ?? defaults.bytes) === 'number'
      ? { decodedBytes: readInteger(record, 'decodedBytes') ?? defaults.decodedBytes ?? defaults.bytes }
      : {}),
  };
}

function canonicalBlossomUrl(url: string, fallbackSha256: string | undefined): string | undefined {
  const match = /^blossom:(?:sha256:)?([0-9a-f]{64})(?:\.[0-9a-z]+)?(?:\?.*)?$/i.exec(url.trim());
  const sha256 = match?.[1] ?? (fallbackSha256 && HEX_64.test(fallbackSha256) ? fallbackSha256 : undefined);
  return sha256 ? `blossom:sha256:${sha256.toLowerCase()}` : undefined;
}

function sourceFromTorrentRecord(
  record: Record<string, unknown>,
  defaults: SourceDefaults,
): RomByteSource | undefined {
  const uri = readString(record, 'uri') ?? readString(record, 'url') ?? readString(record, 'event');
  if (uri?.startsWith('magnet:') || uri?.startsWith('nostr:')) {
    return sourceFromUrl(uri, 'torrent', {
      ...defaults,
      sha256: readString(record, 'sha256') ?? defaults.sha256,
      bytes: readInteger(record, 'bytes') ?? readInteger(record, 'size') ?? defaults.bytes,
    });
  }

  const infohash = readString(record, 'infohash') ?? readString(record, 'btih') ?? readString(record, 'x');
  if (!infohash) {
    return undefined;
  }
  const params = [`xt=urn:btih:${encodeURIComponent(infohash)}`];
  const displayName = readString(record, 'name') ?? readString(record, 'path') ?? readString(record, 'file');
  if (displayName) {
    params.push(`dn=${encodeURIComponent(displayName)}`);
  }
  const trackers = [...defaults.trackers, ...readStringList(record, 'trackers')];
  for (const tracker of trackers) {
    params.push(`tr=${encodeURIComponent(tracker)}`);
  }
  const bytes = readInteger(record, 'bytes') ?? readInteger(record, 'size') ?? defaults.bytes;
  return {
    kind: 'torrent',
    url: `magnet:?${params.join('&')}`,
    label: sourceLabel('torrent'),
    sha256: readString(record, 'sha256') ?? defaults.sha256,
    ...(typeof bytes === 'number' ? { bytes } : {}),
  };
}

function pushSource(sources: RomByteSource[], source: RomByteSource | undefined): void {
  if (!source?.url) {
    return;
  }
  const existing = sources.find((candidate) => candidate.url === source.url);
  if (existing) {
    existing.sha256 ??= source.sha256;
    existing.bytes ??= source.bytes;
    existing.servers = uniqueStrings([...(existing.servers ?? []), ...(source.servers ?? [])]);
    existing.encoding ??= source.encoding;
    existing.decodedSha256 ??= source.decodedSha256;
    existing.decodedBytes ??= source.decodedBytes;
    return;
  }
  sources.push(source);
}

function blossomServerHints(url: string): string[] {
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) {
    return [];
  }
  const params = new URLSearchParams(url.slice(queryIndex + 1));
  return uniqueStrings(params.getAll('xs'));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function sourceKind(url: string, kindHint: string | undefined): RomSourceKind {
  if (kindHint === 'inline' || kindHint === 'data') return 'inline';
  if (kindHint === 'blossom') return 'blossom';
  if (kindHint === 'torrent' || kindHint === 'nip35') return 'torrent';
  if (url.startsWith('data:')) return 'inline';
  if (url.startsWith('blossom:')) return 'blossom';
  if (url.startsWith('magnet:')) return 'torrent';
  return 'resource';
}

function sourceLabel(kind: RomSourceKind): string {
  switch (kind) {
    case 'inline':
      return 'inline';
    case 'blossom':
      return 'Blossom';
    case 'torrent':
      return 'torrent';
    case 'resource':
      return 'resource';
  }
}

function readTags(tags: readonly string[][], name: string): string[] {
  return tags.flatMap((tag) => (tag[0] === name && tag[1] ? [tag[1]] : []));
}

function readTag(tags: readonly string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === name)?.[1];
}

function readLegacySha256Tag(tags: readonly string[][]): string | undefined {
  const value = readTag(tags, 'x');
  return value && HEX_64.test(value) ? value.toLowerCase() : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function readTransportEncoding(
  record: Record<string, unknown>,
  key: string,
): RomTransportEncoding | undefined {
  return record[key] === 'base64' ? 'base64' : undefined;
}

function readInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
