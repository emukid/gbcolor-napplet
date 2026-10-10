import {
  identity,
  keys,
  outbox,
  relay,
  resource,
  themeGet,
  themeOnChanged,
  type NostrEvent,
  type NostrFilter,
  type RelayEventResult,
  type ResourceSidecarEntry,
  type Subscription,
} from '@napplet/sdk';
import * as core from 'wasmboy/dist/core/core.esm.js';
import './styles.css';
import { collectRomByteSources, decodeRomTransport, type RomByteSource } from './rom-sources';

const GB_WIDTH = 160;
const GB_HEIGHT = 144;
const ROM_KIND = 32560;
const SAVE_KIND = 30078;
const AUDIO_CHUNK_SIZE = 2048;
const SAVE_FORMAT = 'wasmboy-core-cartridge-ram-v1';
const ROM_QUERY_LIMIT = 80;
const NETWORK_AUTHOR_LIMIT = 96;
const RELAY_QUERY_TIMEOUT_MS = 4200;

const REQUIRED_DOMAINS = ['identity', 'outbox', 'resource', 'keys', 'relay'] as const;
const BUTTONS = ['up', 'right', 'down', 'left', 'a', 'b', 'select', 'start'] as const;
const KEY_TO_BUTTON = new Map<string, ButtonName>([
  ['ArrowUp', 'up'],
  ['ArrowRight', 'right'],
  ['ArrowDown', 'down'],
  ['ArrowLeft', 'left'],
  ['KeyX', 'a'],
  ['KeyZ', 'b'],
  ['Enter', 'start'],
  ['ShiftLeft', 'select'],
  ['ShiftRight', 'select'],
]);

const BLOSSOM_SERVERS = [
  'https://cdn.hzrd149.com',
  'https://blssm.us',
  'https://nostr.download',
  'https://blossom.primal.net',
] as const;

type StatusKind = 'idle' | 'ok' | 'warn' | 'error';
type ButtonName = (typeof BUTTONS)[number];
type ButtonInputSource = 'keyboard' | 'pointer' | 'action';
type AppView = 'game' | 'games';
type RomScope = 'mine' | 'network' | 'global';

type RomSource = RomByteSource & {
  sidecarBlob?: Blob;
};

type RomEntry = {
  id: string;
  name: string;
  slug: string;
  url: string;
  sources: RomSource[];
  sha256?: string;
  bytes?: number;
  source: 'memory' | 'nostr';
  event?: NostrEvent;
};

type RomGroup = {
  id: string;
  title: string;
  entries: RomEntry[];
};

type SavePayload = {
  schema: 'gbcolor.save.v1';
  emulator: 'wasmboy-core';
  rom: {
    name: string;
    slug: string;
    sha256?: string;
  };
  payload: {
    format: 'cartridge-ram';
    encoding: 'base64';
    bytes: number;
    data: string;
    sha256: string;
  };
};

type EncodedBytes = {
  encoding: 'base64';
  bytes: number;
  data: string;
  sha256: string;
};

const elements = {
  deviceFace: requireElement<HTMLElement>('[data-gbc-measure="device-face"]'),
  gameView: requireElement<HTMLElement>('#gameView'),
  gamesView: requireElement<HTMLElement>('#gamesView'),
  screen: requireElement<HTMLCanvasElement>('#screen'),
  status: requireElement<HTMLOutputElement>('#status'),
  statusMirror: requireElement<HTMLOutputElement>('#statusMirror'),
  bootOverlay: requireElement<HTMLDivElement>('#bootOverlay'),
  domainIndicator: requireElement<HTMLButtonElement>('#domainIndicator'),
  pauseButton: requireElement<HTMLButtonElement>('#pauseButton'),
  soundButton: requireElement<HTMLButtonElement>('#soundButton'),
  gamesButton: requireElement<HTMLButtonElement>('#gamesButton'),
  saveFileButton: requireElement<HTMLButtonElement>('#saveFileButton'),
  saveButton: requireElement<HTMLButtonElement>('#saveButton'),
  loadSaveButton: requireElement<HTMLButtonElement>('#loadSaveButton'),
  saveCloseButton: requireElement<HTMLButtonElement>('#saveCloseButton'),
  openFileButton: requireElement<HTMLButtonElement>('#openFileButton'),
  romFileInput: requireElement<HTMLInputElement>('#romFileInput'),
  romSelect: requireElement<HTMLSelectElement>('#romSelect'),
  gamesStatus: requireElement<HTMLOutputElement>('#gamesStatus'),
  gameGrid: requireElement<HTMLDivElement>('#gameGrid'),
  saveDialog: requireElement<HTMLDialogElement>('#saveDialog'),
  domainGrid: requireElement<HTMLDivElement>('#domainGrid'),
  saveList: requireElement<HTMLOListElement>('#saveList'),
  scopeButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('[data-rom-scope]')),
};

const canvasContext = getCanvasContext(elements.screen);
const imageData = canvasContext.createImageData(GB_WIDTH, GB_HEIGHT);
const buttonState = Object.fromEntries(BUTTONS.map((button) => [button, false])) as Record<
  ButtonName,
  boolean
>;
const buttonInputState: Record<ButtonInputSource, Record<ButtonName, boolean>> = {
  keyboard: createButtonState(),
  pointer: createButtonState(),
  action: createButtonState(),
};
const actionPulseTimers: Partial<Record<ButtonName, number>> = {};
const roms = new Map<string, RomEntry>();
let activeRom: RomEntry | null = null;
let activeRomBytes: Uint8Array | null = null;
let activeCartRamSize = 0;
let isCoreLoaded = false;
let isPaused = false;
let animationFrame = 0;
let saveEvents: NostrEvent[] = [];
let keyHandles: Array<{ close(): void }> = [];
let themeSubscription: Subscription | null = null;
let currentUserPubkey = '';

class GbAudio {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  enabled = false;

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    elements.soundButton.ariaPressed = String(enabled);
    elements.soundButton.classList.toggle('is-active', enabled);

    if (!enabled) {
      return;
    }

    await this.ensureContext();
  }

  async ensureContext(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: 44100 });
    }
    if (this.context.state !== 'running') {
      await this.context.resume();
    }
    this.nextStartTime = Math.max(this.nextStartTime, this.context.currentTime + 0.02);
  }

  pushFromCore(): void {
    if (!this.enabled || !this.context) {
      core.clearAudioBuffer();
      return;
    }

    const sampleCount = Math.min(core.getNumberOfSamplesInAudioBuffer(), AUDIO_CHUNK_SIZE * 2);
    if (sampleCount <= 0) {
      return;
    }

    const buffer = this.context.createBuffer(2, sampleCount, 44100);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const memory = core.memory.wasmByteMemory;
    for (let index = 0; index < sampleCount; index += 1) {
      const sourceOffset = core.AUDIO_BUFFER_LOCATION + index * 2;
      left[index] = normalizeAudioByte(memory[sourceOffset] ?? 129);
      right[index] = normalizeAudioByte(memory[sourceOffset + 1] ?? 129);
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const currentTime = this.context.currentTime;
    if (this.nextStartTime < currentTime) {
      this.nextStartTime = currentTime + 0.02;
    }
    source.start(this.nextStartTime);
    this.nextStartTime += sampleCount / 44100;
    if (this.nextStartTime - currentTime > 0.3) {
      this.nextStartTime = currentTime + 0.05;
    }
    core.clearAudioBuffer();
  }

  close(): void {
    void this.context?.close();
    this.context = null;
  }
}

const audio = new GbAudio();
let romScope: RomScope = 'mine';
let localRom: RomEntry | null = null;
let discoveryGeneration = 0;
let isDiscoveringRoms = true;

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function getCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('Canvas 2D context unavailable');
  }
  return context;
}

function setStatus(kind: StatusKind, message: string): void {
  elements.status.className = `status status-${kind}`;
  elements.status.textContent = message;
  elements.statusMirror.className = `status-mirror status-mirror-${kind}`;
  elements.statusMirror.textContent = message;
}

function maybeNapplet(): Record<string, unknown> | undefined {
  return (window as Window & { napplet?: Record<string, unknown> }).napplet;
}

function hasDomain(domain: string): boolean {
  return Boolean(maybeNapplet()?.[domain]);
}

function hasRequiredDomains(): boolean {
  return REQUIRED_DOMAINS.every(hasDomain);
}

function renderDomains(): void {
  const ready = hasRequiredDomains();
  elements.domainIndicator.textContent = ready ? '✓' : '×';
  elements.domainIndicator.dataset.state = ready ? 'on' : 'off';
  elements.domainIndicator.ariaLabel = ready ? 'Required NAP domains available' : 'Required NAP domains missing';

  elements.domainGrid.replaceChildren(
    ...REQUIRED_DOMAINS.map((domain) => {
      const item = document.createElement('span');
      const available = hasDomain(domain);
      item.textContent = `${available ? 'ok' : 'missing'} ${domain}`;
      item.dataset.state = available ? 'on' : 'off';
      return item;
    }),
  );
}

function renderRoms(): void {
  const selected = elements.romSelect.value || activeRom?.id;
  const entries = orderedRomEntries();
  const groups = groupRomEntries(entries);
  const groupLabel = `${groups.length} title${groups.length === 1 ? '' : 's'}`;
  const eventLabel = `${entries.length} option${entries.length === 1 ? '' : 's'}`;
  elements.gamesStatus.textContent = isDiscoveringRoms
    ? `Loading ${scopeLabel(romScope)} games...`
    : activeRom
    ? `${activeRom.name} · ${scopeLabel(romScope)}`
    : `${scopeLabel(romScope)} · ${groupLabel} · ${eventLabel}`;
  renderScopeButtons();

  if (isDiscoveringRoms) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Loading games...';
    elements.romSelect.replaceChildren(option);
    elements.romSelect.disabled = true;
    elements.gameGrid.setAttribute('aria-busy', 'true');
    elements.gameGrid.replaceChildren(
      ...Array.from({ length: 8 }, () => {
        const placeholder = document.createElement('article');
        placeholder.className = 'game-card game-placeholder';
        placeholder.ariaHidden = 'true';
        return placeholder;
      }),
    );
    return;
  }

  elements.gameGrid.removeAttribute('aria-busy');
  if (!entries.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No ROMs found';
    elements.romSelect.replaceChildren(option);
    elements.romSelect.disabled = true;
    const empty = document.createElement('p');
    empty.className = 'empty-games';
    empty.textContent = emptyGamesMessage();
    elements.gameGrid.replaceChildren(empty);
    return;
  }

  elements.romSelect.disabled = false;
  elements.romSelect.replaceChildren(
    ...entries.map((rom) => {
      const option = document.createElement('option');
      option.value = rom.id;
      option.textContent = rom.name;
      return option;
    }),
  );
  elements.romSelect.value = selected && hasRomEntry(selected) ? selected : entries[0]!.id;
  elements.gameGrid.replaceChildren(
    ...groups.map((group) => {
      const primary = group.entries[0]!;
      const card = document.createElement('article');
      card.className = 'game-card';
      card.dataset.groupId = group.id;
      card.classList.toggle('is-active', group.entries.some((entry) => entry.id === activeRom?.id));
      card.classList.toggle('is-memory', primary.source === 'memory');

      const primaryButton = document.createElement('button');
      primaryButton.type = 'button';
      primaryButton.className = 'game-primary';
      primaryButton.dataset.romId = primary.id;
      primaryButton.ariaLabel = `Load ${group.title}`;

      const label = document.createElement('span');
      label.className = 'game-title';
      label.textContent = group.title;

      const meta = document.createElement('span');
      meta.className = 'game-meta';
      meta.textContent = romMeta(primary, group.entries.length);

      primaryButton.append(label, meta);
      primaryButton.addEventListener('click', () => {
        void handleAction(() => loadRomFromEntry(primary));
      });
      card.append(primaryButton);

      if (group.entries.length > 1) {
        const options = document.createElement('div');
        options.className = 'game-options';
        options.ariaLabel = `${group.title} variants`;
        for (const entry of group.entries) {
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'game-option';
          option.dataset.romId = entry.id;
          option.classList.toggle('is-active', entry.id === activeRom?.id);
          option.textContent = romOptionLabel(entry);
          option.ariaLabel = `Load ${entry.name} option`;
          option.addEventListener('click', () => {
            void handleAction(() => loadRomFromEntry(entry));
          });
          options.append(option);
        }
        card.append(options);
      }

      return card;
    }),
  );
}

function orderedRomEntries(): RomEntry[] {
  return [
    ...(localRom ? [localRom] : []),
    ...Array.from(roms.values()).sort((left, right) => {
      const leftTime = left.event?.created_at ?? 0;
      const rightTime = right.event?.created_at ?? 0;
      return rightTime - leftTime || left.name.localeCompare(right.name);
    }),
  ];
}

function groupRomEntries(entries: RomEntry[]): RomGroup[] {
  const groups = new Map<string, RomGroup>();
  for (const entry of entries) {
    const key = entry.source === 'memory' ? `memory:${entry.id}` : normalizeTitle(entry.name);
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      groups.set(key, { id: key, title: entry.name, entries: [entry] });
    }
  }
  return [...groups.values()];
}

function renderScopeButtons(): void {
  for (const button of elements.scopeButtons) {
    const scope = button.dataset.romScope;
    const pressed = scope === romScope;
    button.ariaPressed = String(pressed);
    button.classList.toggle('is-active', pressed);
  }
}

function scopeLabel(scope: RomScope): string {
  switch (scope) {
    case 'mine':
      return 'Mine';
    case 'network':
      return 'Network';
    case 'global':
      return 'Global';
  }
}

function emptyGamesMessage(): string {
  switch (romScope) {
    case 'mine':
      return 'No games here yet';
    case 'network':
      return 'No network games found';
    case 'global':
      return 'No global games found';
  }
}

function romMeta(rom: RomEntry, variants: number): string {
  if (rom.source === 'memory') {
    return `${formatBytes(rom.bytes)} · loaded in memory`;
  }
  const optionLabel = variants > 1 ? `${variants} options · ` : '';
  return `${optionLabel}${formatBytes(rom.bytes)} · ${romSourceSummary(rom)} · ${shortPubkey(rom.event?.pubkey)}`;
}

function romOptionLabel(rom: RomEntry): string {
  return rom.source === 'memory'
    ? 'Memory'
    : `${shortPubkey(rom.event?.pubkey)} ${formatBytes(rom.bytes)} ${romSourceSummary(rom)}`;
}

function romSourceSummary(rom: RomEntry): string {
  const labels = Array.from(new Set(rom.sources.map((source) => source.label)));
  if (labels.length === 0) {
    return 'resource';
  }
  if (labels.length === 1) {
    return labels[0]!;
  }
  return `${labels[0]} +${labels.length - 1}`;
}

function renderSaveList(): void {
  if (!saveEvents.length) {
    const item = document.createElement('li');
    item.className = 'empty-save';
    item.textContent = 'No saves';
    elements.saveList.replaceChildren(item);
    return;
  }

  elements.saveList.replaceChildren(
    ...saveEvents.map((event) => {
      const item = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'save-row';

      const payload = parseSavePayload(event.content);
      const details = document.createElement('div');
      details.className = 'save-details';

      const name = document.createElement('span');
      name.className = 'save-name';
      name.textContent = payload?.rom.name ?? activeRom?.name ?? 'GBColor save';

      const time = document.createElement('time');
      time.className = 'save-time';
      const date = new Date(event.created_at * 1000);
      time.dateTime = date.toISOString();
      time.textContent = formatSaveTimestamp(date);
      details.append(name, time);

      const loadButton = document.createElement('button');
      loadButton.type = 'button';
      loadButton.className = 'save-load';
      loadButton.textContent = 'Load';
      loadButton.addEventListener('click', () => handleAction(() => applySaveEvent(event, { resetCore: true })));

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'save-delete';
      deleteButton.textContent = 'Delete';
      deleteButton.ariaLabel = `Delete save from ${time.textContent}`;
      deleteButton.addEventListener('click', () => handleAction(() => deleteSaveEvent(event)));

      row.append(details, loadButton, deleteButton);
      item.append(row);
      return item;
    }),
  );
}

function formatSaveTimestamp(date: Date): string {
  const ageMs = Math.max(0, Date.now() - date.getTime());
  const monthMs = 30 * 24 * 60 * 60 * 1000;
  if (ageMs >= monthMs) {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (ageMs >= size) {
      return formatter.format(-Math.floor(ageMs / size), unit);
    }
  }
  return 'just now';
}

function setView(view: AppView): void {
  elements.deviceFace.dataset.view = view;
  elements.gameView.setAttribute('aria-hidden', String(view !== 'game'));
  elements.gamesView.setAttribute('aria-hidden', String(view !== 'games'));
  elements.gamesButton.textContent = view === 'games' ? 'Console' : 'Games';
  if (view === 'games') {
    renderRoms();
  }
}

function openSaveDialog(): void {
  if (!elements.saveDialog.open) {
    elements.saveDialog.showModal();
  }
  void handleAction(refreshSaves);
}

function closeSaveDialog(): void {
  if (elements.saveDialog.open) {
    elements.saveDialog.close();
  }
}

async function bootstrap(): Promise<void> {
  renderDomains();
  renderRoms();
  renderSaveList();
  await configureTheme();

  if (!hasRequiredDomains()) {
    isDiscoveringRoms = false;
    renderRoms();
    setStatus('error', 'Required shell domains unavailable');
    return;
  }

  await registerKeyActions();
  currentUserPubkey = await withTimeout(identity.getPublicKey(), 'identity.getPublicKey', 4000);
  const romCount = await discoverRomEvents('mine');
  if (romCount === 0) {
    setStatus('idle', 'No games here yet');
    return;
  }
  await loadSelectedRom();
}

async function configureTheme(): Promise<void> {
  if (!hasDomain('theme')) {
    return;
  }

  try {
    applyTheme(await themeGet());
    themeSubscription = themeOnChanged(applyTheme);
  } catch {
    setStatus('warn', 'Theme unavailable');
  }
}

function applyTheme(theme: unknown): void {
  if (!isRecord(theme)) {
    return;
  }

  const colors = isRecord(theme.colors) ? theme.colors : undefined;
  const background = readString(colors, 'background') ?? readString(colors, 'surface');
  const primary = readString(colors, 'primary') ?? readString(colors, 'accent');
  const text = readString(colors, 'text');
  const danger = readString(colors, 'danger');
  setCssVar('--accent', primary);
  setCssVar('--text', text);
  setCssVar('--surface', background);
  setCssVar('--gbc-shell', background);
  setCssVar('--gbc-control', primary);
  setCssVar('--gbc-control-shadow', background);
  setCssVar('--gbc-accent', primary);
  setCssVar('--gbc-text', text);
  setCssVar('--gbc-danger', danger);
}

function setCssVar(name: string, value: string | undefined): void {
  if (value) {
    document.documentElement.style.setProperty(name, value);
  }
}

async function registerKeyActions(): Promise<void> {
  if (!hasDomain('keys')) {
    return;
  }

  const actions: Array<{ button: ButtonName; label: string; defaultKey: string }> = [
    { button: 'up', label: 'Up', defaultKey: 'ArrowUp' },
    { button: 'right', label: 'Right', defaultKey: 'ArrowRight' },
    { button: 'down', label: 'Down', defaultKey: 'ArrowDown' },
    { button: 'left', label: 'Left', defaultKey: 'ArrowLeft' },
    { button: 'a', label: 'A', defaultKey: 'x' },
    { button: 'b', label: 'B', defaultKey: 'z' },
    { button: 'start', label: 'Start', defaultKey: 'Enter' },
    { button: 'select', label: 'Select', defaultKey: 'Shift' },
  ];

  for (const action of actions) {
    try {
      const handle = await keys.register(
        {
          id: `gbcolor.${action.button}`,
          label: action.label,
          defaultKey: action.defaultKey,
        },
        () => pulseButton(action.button),
      );
      keyHandles.push(handle);
    } catch {
      setStatus('warn', 'Key registration incomplete');
    }
  }
}

async function discoverRomEvents(scope: RomScope = romScope): Promise<number> {
  const generation = ++discoveryGeneration;
  romScope = scope;
  isDiscoveringRoms = true;
  renderRoms();
  setStatus('idle', `Searching ${scopeLabel(scope)}`);
  try {
    const results = await collectRomResults(scope);
    if (generation !== discoveryGeneration) {
      return orderedRomEntries().length;
    }
    replaceRomEvents(results);
    setStatus(
      results.length > 0 ? 'ok' : 'idle',
      results.length > 0 ? `${scopeLabel(scope)} games updated` : emptyGamesMessage(),
    );
  } catch {
    setStatus('warn', 'ROM discovery unavailable');
  } finally {
    if (generation === discoveryGeneration) {
      isDiscoveringRoms = false;
      renderRoms();
    }
  }
  return orderedRomEntries().length;
}

async function collectRomResults(scope: RomScope): Promise<RelayEventResult[]> {
  const results = new Map<string, RelayEventResult>();
  const authors = await authorsForScope(scope);
  if (authors.length > 0) {
    const outboxResults = await queryOutboxRomEvents(authors);
    for (const result of outboxResults) {
      if (result.event?.id) results.set(result.event.id, result);
    }
  }

  if (scope === 'global') {
    const relayResults = await queryGlobalRelayRomEvents();
    for (const result of relayResults) {
      if (result.event?.id) results.set(result.event.id, result);
    }
  }

  return [...results.values()];
}

async function authorsForScope(scope: RomScope): Promise<string[]> {
  const authors = new Set<string>();
  if (currentUserPubkey) authors.add(currentUserPubkey);
  if (scope === 'network' || scope === 'global') {
    const follows = await identity.getFollows().catch(() => []);
    for (const pubkey of follows) {
      if (typeof pubkey === 'string' && pubkey.length > 0) authors.add(pubkey);
      if (authors.size >= NETWORK_AUTHOR_LIMIT) break;
    }
  }
  return [...authors];
}

async function queryOutboxRomEvents(authors: string[]): Promise<RelayEventResult[]> {
  const results = await withTimeout(
    outbox.query(
      { kinds: [ROM_KIND], authors, limit: ROM_QUERY_LIMIT },
      { authors, limit: ROM_QUERY_LIMIT, timeoutMs: 5200 },
    ),
    'outbox.query',
    6500,
  );
  return results.events;
}

async function queryGlobalRelayRomEvents(): Promise<RelayEventResult[]> {
  if (!hasDomain('relay')) {
    return [];
  }
  return queryRelayRomEvents();
}

function queryRelayRomEvents(relayUrl?: string): Promise<RelayEventResult[]> {
  const filter: NostrFilter = { kinds: [ROM_KIND], limit: ROM_QUERY_LIMIT };
  return new Promise((resolve) => {
    const results: RelayEventResult[] = [];
    let settled = false;
    let closeWhenReady = false;
    let subscription: Subscription | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (subscription) {
        subscription.close();
      } else {
        closeWhenReady = true;
      }
      resolve(results);
    };
    const timer = window.setTimeout(finish, RELAY_QUERY_TIMEOUT_MS);
    try {
      subscription = relay.subscribe(
        filter,
        (result) => results.push(result),
        finish,
        relayUrl ? { relay: relayUrl } : undefined,
      );
      if (closeWhenReady) {
        subscription.close();
      }
    } catch {
      finish();
    }
  });
}

function replaceRomEvents(results: RelayEventResult[]): void {
  roms.clear();
  for (const result of results) {
    const rom = parseRomResult(result);
    if (rom && !roms.has(rom.id)) {
      roms.set(rom.id, rom);
    }
  }
}

async function loadSelectedRom(): Promise<void> {
  const rom = getRomEntry(elements.romSelect.value) ?? orderedRomEntries()[0];
  if (!rom) {
    setStatus('error', 'No ROM selected');
    return;
  }
  await loadRom(rom);
}

async function loadRomFromEntry(rom: RomEntry): Promise<void> {
  elements.romSelect.value = rom.id;
  await loadRom(rom);
  setView('game');
}

function getRomEntry(id: string): RomEntry | undefined {
  return localRom?.id === id ? localRom : roms.get(id);
}

function hasRomEntry(id: string): boolean {
  return localRom?.id === id || roms.has(id);
}

async function loadLocalRomFile(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256Hex(bytes);
  const name = romNameFromFile(file);
  const rom: RomEntry = {
    id: `memory-${hash}`,
    name,
    slug: slugify(name) || `memory-${hash.slice(0, 8)}`,
    url: `memory:${hash}`,
    sources: [
      {
        kind: 'resource',
        url: `memory:${hash}`,
        label: 'memory',
        sha256: hash,
        bytes: bytes.byteLength,
        sidecarBlob: file,
      },
    ],
    sha256: hash,
    bytes: bytes.byteLength,
    source: 'memory',
  };
  localRom = rom;
  renderRoms();
  await loadRomFromEntry(rom);
}

function romNameFromFile(file: File): string {
  return file.name
    .replace(/\.(gbc|gb)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim() || 'Local ROM';
}

function fileFromDragEvent(event: DragEvent): File | null {
  const files = event.dataTransfer?.files;
  return files && files.length > 0 ? files[0]! : null;
}

async function loadRom(rom: RomEntry): Promise<void> {
  stopLoop();
  setStatus('idle', `Loading ${rom.name}`);

  const { bytes: romBytes, hash, source } = await loadRomBytes(rom);

  activeRom = { ...rom, url: source.url, sha256: rom.sha256 ?? hash, bytes: romBytes.byteLength };
  activeRomBytes = romBytes;
  activeCartRamSize = getCartridgeRamSize(romBytes);
  initializeCore(romBytes);
  await refreshSaves();
  await loadLatestSave(false, { resetCore: false });
  isPaused = false;
  elements.pauseButton.textContent = 'Pause';
  startLoop();
  elements.bootOverlay.classList.add('is-loaded');
  setStatus('ok', activeRom.name);
  renderRoms();
}

async function loadRomBytes(rom: RomEntry): Promise<{ bytes: Uint8Array; hash: string; source: RomSource }> {
  const errors: string[] = [];
  for (const source of rom.sources) {
    try {
      const blob = source.sidecarBlob ?? await withTimeout(
        resource.bytes(source.url, {
          ...(source.kind === 'blossom'
            ? { servers: [...new Set([...(source.servers ?? []), ...BLOSSOM_SERVERS])] }
            : {}),
        }),
        `resource.bytes ${source.label}`,
        15000,
      );
      const transportBytes = new Uint8Array(await blob.arrayBuffer());
      verifyRomByteCount(transportBytes, source.bytes, `${source.label} transport`);
      const transportHash = await sha256Hex(transportBytes);
      verifyRomHash(transportHash, source.sha256, `${source.label} transport`);
      const bytes = decodeRomTransport(transportBytes, source);
      verifyRomByteCount(bytes, source.decodedBytes, `${source.label} decoded source`);
      verifyRomHash(await sha256Hex(bytes), source.decodedSha256, `${source.label} decoded source`);
      verifyRomByteCount(bytes, rom.bytes, 'ROM record');
      const hash = await sha256Hex(bytes);
      verifyRomHash(hash, rom.sha256, 'ROM record');
      return { bytes, hash, source };
    } catch (error) {
      errors.push(`${source.label}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }
  throw new Error(`ROM bytes unavailable (${errors.join('; ') || 'no sources'})`);
}

function verifyRomByteCount(bytes: Uint8Array, expected: number | undefined, label: string): void {
  if (typeof expected === 'number' && bytes.byteLength !== expected) {
    throw new Error(`${label} byte count mismatch`);
  }
}

function verifyRomHash(actual: string, expected: string | undefined, label: string): void {
  if (expected && actual !== expected) {
    throw new Error(`${label} hash mismatch`);
  }
}

function initializeCore(romBytes: Uint8Array): void {
  const memory = core.memory.wasmByteMemory;
  memory.fill(0);
  memory.set(romBytes, core.CARTRIDGE_ROM_LOCATION);
  core.config(0, 1, 0, 0, 0, 0, 0, 0, 0, 0);
  isCoreLoaded = true;
  updateJoypadState();
  renderFrame();
}

function startLoop(): void {
  stopLoop();

  const tick = () => {
    if (!isPaused && isCoreLoaded) {
      runCoreFrame();
      renderFrame();
    }
    animationFrame = window.requestAnimationFrame(tick);
  };

  animationFrame = window.requestAnimationFrame(tick);
}

function stopLoop(): void {
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  }
}

function runCoreFrame(): void {
  let guard = 0;
  while (guard < 8) {
    guard += 1;
    const result = core.executeFrameAndCheckAudio(AUDIO_CHUNK_SIZE);
    if (result === 1) {
      audio.pushFromCore();
      continue;
    }
    audio.pushFromCore();
    if (result < 0) {
      isPaused = true;
      setStatus('error', 'Emulator stopped');
    }
    return;
  }
}

function renderFrame(): void {
  const source = core.memory.wasmByteMemory;
  const target = imageData.data;
  let sourceIndex = core.FRAME_LOCATION;
  let targetIndex = 0;

  for (let pixel = 0; pixel < GB_WIDTH * GB_HEIGHT; pixel += 1) {
    target[targetIndex] = source[sourceIndex] ?? 0;
    target[targetIndex + 1] = source[sourceIndex + 1] ?? 0;
    target[targetIndex + 2] = source[sourceIndex + 2] ?? 0;
    target[targetIndex + 3] = 255;
    sourceIndex += 3;
    targetIndex += 4;
  }

  canvasContext.putImageData(imageData, 0, 0);
}

async function refreshSaves(): Promise<void> {
  if (!activeRom || !currentUserPubkey) {
    saveEvents = [];
    renderSaveList();
    return;
  }

  const dTag = saveDTag(activeRom);
  const address = saveAddress(currentUserPubkey, dTag);
  try {
    const [saveResult, deleteResult] = await withTimeout(
      Promise.all([
        outbox.query(
          { kinds: [SAVE_KIND], authors: [currentUserPubkey], '#d': [dTag], limit: 10 },
          { authors: [currentUserPubkey], limit: 10, timeoutMs: 5000 },
        ),
        outbox.query(
          { kinds: [5], authors: [currentUserPubkey], limit: 100 },
          { authors: [currentUserPubkey], limit: 100, timeoutMs: 5000 },
        ),
      ]),
      'outbox.query',
      6500,
    );
    const deletionEvents = deleteResult.events.map((wrapped) => wrapped.event);
    saveEvents = saveResult.events
      .map((wrapped) => wrapped.event)
      .filter((event) => !isDeletedSaveEvent(event, deletionEvents, address))
      .sort((left, right) => right.created_at - left.created_at);
  } catch {
    saveEvents = [];
    setStatus('warn', 'Save lookup unavailable');
  }
  renderSaveList();
}

async function publishSave(): Promise<void> {
  if (!activeRom || !isCoreLoaded || activeCartRamSize <= 0) {
    setStatus('warn', 'No cartridge save RAM');
    return;
  }

  setStatus('idle', 'Publishing save');
  const ramSegment = await encodeBytes(
    readCoreMemory(core.CARTRIDGE_RAM_LOCATION, activeCartRamSize),
  );
  const payload: SavePayload = {
    schema: 'gbcolor.save.v1',
    emulator: 'wasmboy-core',
    rom: {
      name: activeRom.name,
      slug: activeRom.slug,
      sha256: activeRom.sha256,
    },
    payload: {
      format: 'cartridge-ram',
      ...ramSegment,
    },
  };

  const dTag = saveDTag(activeRom);
  const result = await withTimeout(
    outbox.publish({
      kind: SAVE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', dTag],
        ['title', `${activeRom.name} save`],
        ['application', 'gbcolor'],
        ['rom', activeRom.slug],
        ['rom-sha256', activeRom.sha256 ?? ''],
        ['save-format', SAVE_FORMAT],
        ['x', ramSegment.sha256],
      ].filter((tag) => tag[1] !== ''),
      content: JSON.stringify(payload),
    }),
    'outbox.publish',
    10000,
  );

  if (!result.ok) {
    throw new Error(result.error ?? 'Save publish failed');
  }

  if (result.event) {
    saveEvents = [result.event, ...saveEvents.filter((event) => event.id !== result.event?.id)];
    renderSaveList();
  } else {
    await refreshSaves();
  }
  setStatus('ok', 'Save published');
}

async function deleteSaveEvent(event: NostrEvent): Promise<void> {
  if (!activeRom || !currentUserPubkey) {
    setStatus('warn', 'No save selected');
    return;
  }

  const dTag = saveDTag(activeRom);
  if (event.pubkey !== currentUserPubkey) {
    throw new Error('Cannot delete another user save');
  }
  const address = saveAddress(event.pubkey, dTag);
  setStatus('idle', 'Deleting save');

  const result = await withTimeout(
    outbox.publish({
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', event.id],
        ['a', address],
      ],
      content: `Delete GBColor save ${dTag}`,
    }),
    'outbox.publish',
    10000,
  );

  if (!result.ok) {
    throw new Error(result.error ?? 'Save delete failed');
  }

  saveEvents = saveEvents.filter((saveEvent) => saveEvent.id !== event.id);
  renderSaveList();
  setStatus('ok', 'Save deleted');
}

async function loadLatestSave(
  showEmpty = true,
  options: { resetCore?: boolean } = { resetCore: true },
): Promise<void> {
  await refreshSaves();
  if (!saveEvents.length) {
    if (showEmpty) {
      setStatus('warn', 'No saves found');
    }
    return;
  }

  await applySaveEvent(saveEvents[0]!, options);
}

async function applySaveEvent(
  event: NostrEvent,
  options: { resetCore?: boolean } = { resetCore: true },
): Promise<void> {
  if (!activeRom || !isCoreLoaded) {
    return;
  }

  const payload = parseSavePayload(event.content);
  if (!payload) {
    throw new Error('Save payload is invalid');
  }
  if (payload.rom.sha256 && activeRom.sha256 && payload.rom.sha256 !== activeRom.sha256) {
    throw new Error('Save ROM does not match');
  }

  const bytes = base64ToBytes(payload.payload.data);
  if (bytes.byteLength !== payload.payload.bytes) {
    throw new Error('Save byte count mismatch');
  }
  if (bytes.byteLength !== activeCartRamSize) {
    throw new Error('Save does not match cartridge RAM size');
  }
  const hash = await sha256Hex(bytes);
  if (hash !== payload.payload.sha256) {
    throw new Error('Save hash mismatch');
  }

  if (options.resetCore) {
    if (!activeRomBytes) {
      throw new Error('ROM bytes unavailable');
    }
    stopLoop();
    initializeCore(activeRomBytes);
  }

  core.memory.wasmByteMemory.set(bytes, core.CARTRIDGE_RAM_LOCATION);
  if (options.resetCore) {
    isPaused = false;
    elements.pauseButton.textContent = 'Pause';
    startLoop();
  }
  setStatus('ok', 'Save loaded');
}

function readCoreMemory(location: number, size: number): Uint8Array {
  return new Uint8Array(core.memory.wasmByteMemory.slice(location, location + size));
}

async function encodeBytes(bytes: Uint8Array): Promise<EncodedBytes> {
  return {
    encoding: 'base64',
    bytes: bytes.byteLength,
    data: bytesToBase64(bytes),
    sha256: await sha256Hex(bytes),
  };
}

function parseRomResult(result: RelayEventResult): RomEntry | null {
  const event = result.event;
  let content: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (isRecord(parsed)) {
      content = parsed;
    }
  } catch {
    // Tags and resource sidecars are sufficient for ROM records.
  }

  const sources = attachSidecarSources(
    collectRomByteSources(content, event.tags),
    result.sidecar?.resources,
  );
  if (!sources.length) {
    sources.push(...sidecarOnlySources(result.sidecar?.resources));
  }
  const primarySource = sources[0];
  const sha256 =
    readString(content, 'sha256') ??
    readTag(event.tags, 'sha256') ??
    readLegacySha256Tag(event.tags) ??
    primarySource?.sha256;
  if (!primarySource) {
    return null;
  }

  const dTag = readTag(event.tags, 'd') ?? event.id.slice(0, 12);
  const name = readString(content, 'name') ?? readTag(event.tags, 'title') ?? readTag(event.tags, 'name') ?? dTag;
  return {
    id: `event-${event.id}`,
    name,
    slug: readString(content, 'slug') ?? slugify(name),
    url: primarySource.url,
    sources,
    sha256,
    bytes: readNumber(content, 'bytes') ?? primarySource.bytes,
    source: 'nostr',
    event,
  };
}

function attachSidecarSources(
  sources: RomByteSource[],
  entries: readonly ResourceSidecarEntry[] | undefined,
): RomSource[] {
  return sources.map((source) => {
    const sidecarResource = selectSidecarResource(entries, source.url);
    return sidecarResource
      ? { ...source, bytes: source.bytes ?? sidecarResource.blob.size, sidecarBlob: sidecarResource.blob }
      : source;
  });
}

function sidecarOnlySources(entries: readonly ResourceSidecarEntry[] | undefined): RomSource[] {
  return entries?.map((entry) => ({
    kind: 'resource',
    url: entry.url,
    label: 'resource',
    bytes: entry.blob.size,
    sidecarBlob: entry.blob,
  })) ?? [];
}

function selectSidecarResource(
  entries: readonly ResourceSidecarEntry[] | undefined,
  url: string | undefined,
): ResourceSidecarEntry | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }
  return url ? entries.find((entry) => entry.url === url) : entries[0];
}

function parseSavePayload(content: string): SavePayload | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.schema !== 'gbcolor.save.v1' || value.emulator !== 'wasmboy-core') {
    return null;
  }
  if (!isRecord(value.rom) || !isRecord(value.payload)) {
    return null;
  }
  if (value.payload.format !== 'cartridge-ram' || value.payload.encoding !== 'base64') {
    return null;
  }
  const name = readString(value.rom, 'name');
  const slug = readString(value.rom, 'slug');
  const data = readString(value.payload, 'data');
  const sha256 = readString(value.payload, 'sha256');
  const bytes = readNumber(value.payload, 'bytes');
  if (!name || !slug || !data || !sha256 || typeof bytes !== 'number') {
    return null;
  }
  return {
    schema: 'gbcolor.save.v1',
    emulator: 'wasmboy-core',
    rom: {
      name,
      slug,
      sha256: readString(value.rom, 'sha256'),
    },
    payload: {
      format: 'cartridge-ram',
      encoding: 'base64',
      bytes,
      data,
      sha256,
    },
  };
}

function saveDTag(rom: RomEntry): string {
  return `gbcolor-${rom.slug}-save0`;
}

function saveAddress(pubkey: string, dTag: string): string {
  return `${SAVE_KIND}:${pubkey}:${dTag}`;
}

function isDeletedSaveEvent(save: NostrEvent, deletionEvents: NostrEvent[], address: string): boolean {
  return deletionEvents.some((event) => {
    if (event.created_at < save.created_at) {
      return false;
    }
    return event.tags.some((tag) => (
      (tag[0] === 'e' && tag[1] === save.id) ||
      (tag[0] === 'a' && tag[1] === address)
    ));
  });
}

function getCartridgeRamSize(rom: Uint8Array): number {
  switch (rom[0x149]) {
    case 0x01:
      return 2 * 1024;
    case 0x02:
      return 8 * 1024;
    case 0x03:
      return 32 * 1024;
    case 0x04:
      return 128 * 1024;
    case 0x05:
      return 64 * 1024;
    default:
      return 0;
  }
}

function createButtonState(): Record<ButtonName, boolean> {
  return Object.fromEntries(BUTTONS.map((button) => [button, false])) as Record<ButtonName, boolean>;
}

function setButtonInput(button: ButtonName, source: ButtonInputSource, pressed: boolean): void {
  const sourceState = buttonInputState[source];
  if (sourceState[button] === pressed) {
    return;
  }
  sourceState[button] = pressed;

  const combinedPressed = Object.values(buttonInputState).some((state) => state[button]);
  if (buttonState[button] === combinedPressed) {
    return;
  }
  buttonState[button] = combinedPressed;
  document.querySelectorAll<HTMLElement>(`[data-button="${button}"]`).forEach((element) => {
    element.classList.toggle('is-pressed', combinedPressed);
    element.ariaPressed = String(combinedPressed);
  });
  updateJoypadState();
  if (combinedPressed) {
    void audio.ensureContext().catch(() => undefined);
  }
}

function releaseButtonInputs(source: ButtonInputSource): void {
  for (const button of BUTTONS) {
    setButtonInput(button, source, false);
  }
}

function pulseButton(button: ButtonName): void {
  const previousTimer = actionPulseTimers[button];
  if (previousTimer !== undefined) {
    window.clearTimeout(previousTimer);
  }
  setButtonInput(button, 'action', true);
  actionPulseTimers[button] = window.setTimeout(() => releaseActionPulse(button), 120);
}

function releaseActionPulse(button: ButtonName): void {
  const timer = actionPulseTimers[button];
  if (timer !== undefined) {
    window.clearTimeout(timer);
    delete actionPulseTimers[button];
  }
  setButtonInput(button, 'action', false);
}

function clearActionPulses(): void {
  for (const timer of Object.values(actionPulseTimers)) {
    window.clearTimeout(timer);
  }
  for (const button of BUTTONS) {
    delete actionPulseTimers[button];
  }
  releaseButtonInputs('action');
}

function updateJoypadState(): void {
  if (!isCoreLoaded) {
    return;
  }
  core.setJoypadState(
    boolInt(buttonState.up),
    boolInt(buttonState.right),
    boolInt(buttonState.down),
    boolInt(buttonState.left),
    boolInt(buttonState.a),
    boolInt(buttonState.b),
    boolInt(buttonState.select),
    boolInt(buttonState.start),
  );
}

function boolInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function normalizeAudioByte(value: number): number {
  return Math.max(-1, Math.min(1, (value - 129) / 127));
}

async function sha256Hex(bytes: Uint8Array | Uint8ClampedArray): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer = 0;
  const timeout = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

function readTag(tags: string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === name)?.[1];
}

function readLegacySha256Tag(tags: string[][]): string | undefined {
  const value = readTag(tags, 'x');
  return value && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) {
    return 'unknown size';
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

function shortPubkey(pubkey: string | undefined): string {
  return pubkey && pubkey.length >= 12 ? pubkey.slice(0, 8) : 'OUTBOX';
}

function normalizeTitle(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() || 'untitled';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isButtonName(value: string | undefined): value is ButtonName {
  return BUTTONS.some((button) => button === value);
}

function isRomScope(value: string | undefined): value is RomScope {
  return value === 'mine' || value === 'network' || value === 'global';
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function handleAction(action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    setStatus('error', error instanceof Error ? error.message : 'Action failed');
  }
}

elements.pauseButton.addEventListener('click', () => {
  isPaused = !isPaused;
  elements.pauseButton.textContent = isPaused ? 'Play' : 'Pause';
});

elements.soundButton.addEventListener('click', () => {
  void handleAction(async () => {
    await audio.setEnabled(!audio.enabled);
  });
});

elements.gamesButton.addEventListener('click', () => {
  setView(elements.deviceFace.dataset.view === 'games' ? 'game' : 'games');
});

for (const button of elements.scopeButtons) {
  button.addEventListener('click', () => {
    const scope = button.dataset.romScope;
    if (!isRomScope(scope)) return;
    void handleAction(async () => {
      await discoverRomEvents(scope);
    });
  });
}

elements.openFileButton.addEventListener('click', () => {
  elements.romFileInput.click();
});

elements.romFileInput.addEventListener('change', () => {
  const file = elements.romFileInput.files?.[0];
  elements.romFileInput.value = '';
  if (!file) return;
  void handleAction(() => loadLocalRomFile(file));
});

elements.saveFileButton.addEventListener('click', openSaveDialog);

elements.saveButton.addEventListener('click', () => {
  void handleAction(publishSave);
});

elements.loadSaveButton.addEventListener('click', () => {
  void handleAction(() => loadLatestSave(true));
});

elements.saveCloseButton.addEventListener('click', closeSaveDialog);

elements.romSelect.addEventListener('change', () => {
  void handleAction(loadSelectedRom);
});

document.querySelectorAll<HTMLElement>('[data-button]').forEach((element) => {
  const button = element.dataset.button;
  if (!isButtonName(button)) {
    return;
  }

  element.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    setButtonInput(button, 'pointer', true);
  });
  element.addEventListener('pointerup', (event) => {
    event.preventDefault();
    setButtonInput(button, 'pointer', false);
  });
  element.addEventListener('pointercancel', () => setButtonInput(button, 'pointer', false));
  element.addEventListener('lostpointercapture', () => setButtonInput(button, 'pointer', false));
});

window.addEventListener(
  'keydown',
  (event) => {
    const button = KEY_TO_BUTTON.get(event.code);
    if (!button || event.repeat) {
      return;
    }
    event.preventDefault();
    setButtonInput(button, 'keyboard', true);
  },
  { passive: false },
);

window.addEventListener(
  'keyup',
  (event) => {
    const button = KEY_TO_BUTTON.get(event.code);
    if (!button) {
      return;
    }
    event.preventDefault();
    releaseActionPulse(button);
    setButtonInput(button, 'keyboard', false);
  },
  { passive: false },
);

window.addEventListener('blur', () => {
  releaseButtonInputs('keyboard');
  releaseButtonInputs('pointer');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    releaseButtonInputs('keyboard');
    releaseButtonInputs('pointer');
  }
});

window.addEventListener('dragover', (event) => {
  if (!fileFromDragEvent(event)) return;
  event.preventDefault();
  elements.deviceFace.classList.add('is-drop-target');
});

window.addEventListener('dragleave', (event) => {
  if (event.relatedTarget) return;
  elements.deviceFace.classList.remove('is-drop-target');
});

window.addEventListener('drop', (event) => {
  const file = fileFromDragEvent(event);
  if (!file) return;
  event.preventDefault();
  elements.deviceFace.classList.remove('is-drop-target');
  void handleAction(() => loadLocalRomFile(file));
});

window.addEventListener('pagehide', () => {
  stopLoop();
  releaseButtonInputs('keyboard');
  releaseButtonInputs('pointer');
  clearActionPulses();
  keyHandles.forEach((handle) => handle.close());
  keyHandles = [];
  themeSubscription?.close();
  audio.close();
});

void handleAction(bootstrap);
