import {
  fs,
  common,
  count,
  identity,
  inc,
  keys,
  outbox,
  relay,
  resource,
  storage,
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
import { parseRomIntent, ROM_LOAD_CONVENTION, GAMEBOY_COMMANDS, parseGameboyCommand, type GameboyCommand } from './rom-intent';
import { collectRomByteSources, decodeRomTransport, romContentHash, type RomByteSource } from './rom-sources';

const GB_WIDTH = 160;
const GB_HEIGHT = 144;
const ROM_KIND = 32560;
const SAVE_KIND = 30078;
const AUDIO_CHUNK_SIZE = 2048;
const FRAME_DURATION_MS = (70224 / 4194304) * 1000;
const MAX_CATCH_UP_FRAMES = 5;
const SAVE_FORMAT = 'wasmboy-js-snapshot-v1';
const MAX_SAVE_FILE_BYTES = 4 * 1024 * 1024;
const ROM_QUERY_LIMIT = 80;
const NETWORK_AUTHOR_LIMIT = 96;
const RELAY_QUERY_TIMEOUT_MS = 4200;

const REQUIRED_DOMAINS = ['identity', 'outbox', 'resource', 'relay'] as const;
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
  filesystemPath?: string;
};

type RomEntry = {
  id: string;
  name: string;
  fileName?: string;
  slug: string;
  url: string;
  sources: RomSource[];
  sha256?: string;
  bytes?: number;
  source: 'memory' | 'nostr' | 'filesystem';
  event?: Pick<NostrEvent, 'id' | 'pubkey' | 'created_at'>;
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
    format: 'cartridge-ram' | 'snapshot-v1';
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
  screenToggle: requireElement<HTMLButtonElement>('#screenToggle'),
  consoleReaction: requireElement<HTMLDivElement>('#consoleReaction'),
  gameGrid: requireElement<HTMLDivElement>('#gameGrid'),
  cartridgeSize: requireElement<HTMLSelectElement>('#cartridgeSize'),
  romLoadingDialog: requireElement<HTMLDivElement>('#romLoadingDialog'),
  romLoadingName: requireElement<HTMLParagraphElement>('#romLoadingName'),
  cancelRomLoad: requireElement<HTMLButtonElement>('#cancelRomLoad'),
  saveDialog: requireElement<HTMLDialogElement>('#saveDialog'),
  domainGrid: requireElement<HTMLDivElement>('#domainGrid'),
  saveList: requireElement<HTMLOListElement>('#saveList'),
  filesystemSaves: requireElement<HTMLOListElement>('#filesystemSaves'),
  saveDestination: requireElement<HTMLSelectElement>('#saveDestination'),
  filesystemOption: requireElement<HTMLOptionElement>('#filesystemOption'),
  saveHint: requireElement<HTMLParagraphElement>('#saveHint'),
  resumePrompt: requireElement<HTMLDivElement>('#resumePrompt'),
  resumeYes: requireElement<HTMLButtonElement>('#resumeYes'),
  resumeNo: requireElement<HTMLButtonElement>('#resumeNo'),
  resumeBrowse: requireElement<HTMLButtonElement>('#resumeBrowse'),
  saveStatus: requireElement<HTMLOutputElement>('#saveStatus'),
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
let saveBusy = false;

class GbAudio {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  enabled = false;

  async setEnabled(enabled: boolean, activateContext = true): Promise<void> {
    this.enabled = enabled;
    elements.soundButton.ariaPressed = String(enabled);
    elements.soundButton.classList.toggle('is-active', enabled);

    if (!enabled) {
      this.reset();
      return;
    }

    if (activateContext) await this.ensureContext();
  }

  async ensureContext(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: 44100 });
    }
    if (this.context.state !== 'running') {
      await this.context.resume();
    }
  }

  pushFromCore(): void {
    if (!this.enabled || !this.context || this.context.state !== 'running') {
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

    const currentTime = this.context.currentTime;
    // Cancel the old queue before rebasing; moving the cursor alone overlaps sound.
    if (this.nextStartTime - currentTime > 0.3) {
      this.reset();
    }
    if (this.nextStartTime <= currentTime) {
      this.nextStartTime = currentTime + 0.05;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    source.start(this.nextStartTime);
    this.nextStartTime += sampleCount / 44100;
    core.clearAudioBuffer();
  }

  reset(): void {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.nextStartTime = 0;
    core.clearAudioBuffer();
  }

  close(): void {
    this.reset();
    void this.context?.close();
    this.context = null;
  }
}

const audio = new GbAudio();
let romScope: RomScope = 'global';
let localRom: RomEntry | null = null;
let discoveryGeneration = 0;
let isDiscoveringRoms = true;
let libraryDiscoveryStarted = false;

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
  elements.saveStatus.textContent = message;
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

let detailGroupId: string | null = null;

function renderRoms(): void {
  for (const observer of reactionObservers) observer.disconnect();
  reactionObservers.clear();
  const selected = elements.romSelect.value || activeRom?.id;
  const entries = orderedRomEntries();
  const groups = groupRomEntries(entries);
  elements.gameGrid.classList.remove('is-detail');
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
  const detail = groups.find(group => group.id === detailGroupId);
  if (detail) {
    renderRomDetail(detail);
    return;
  }
  detailGroupId = null;
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
        chooseRomVersion(group);
      });
      card.append(primaryButton);
      const info = document.createElement('button');
      info.type = 'button';
      info.className = 'rom-info';
      info.textContent = 'ⓘ';
      info.title = `Details and options for ${group.title}`;
      info.ariaLabel = info.title;
      info.addEventListener('click', () => {
        detailGroupId = group.id;
        renderRoms();
        elements.gameGrid.querySelector<HTMLButtonElement>('.rom-detail-back')?.focus();
      });
      card.append(info);
      if (primary.event) attachRomReaction(card, primary);
      if (hasDomain('fs')) attachRomDownload(card, primary);

      return card;
    }),
  );
}

function romChoiceKey(rom: RomEntry): string {
  return rom.sha256 ? `${rom.event?.pubkey ?? 'local'}:${rom.sha256.toLowerCase()}` : rom.id;
}

function chooseRomVersion(group: RomGroup, force = false): void {
  const choices = isRecord(preferences.romChoices) ? preferences.romChoices : {};
  const remembered = group.entries.find(rom => romChoiceKey(rom) === choices[group.id]);
  if (!force && (remembered || group.entries.length === 1)) {
    void handleAction(() => loadRomFromEntry(remembered ?? group.entries[0]!));
    return;
  }
  const dialog = requireElement<HTMLDialogElement>('#romVersionDialog');
  const list = requireElement('#romVersionList');
  const remember = requireElement<HTMLInputElement>('#rememberRomVersion');
  const load = requireElement<HTMLButtonElement>('#loadRomVersion');
  requireElement('#romVersionTitle').textContent = `Choose version: ${group.title}`;
  remember.checked = false;
  list.replaceChildren();
  let selected: RomEntry | undefined;
  load.disabled = true;
  const authors = new Map<string, RomEntry[]>();
  for (const rom of group.entries) {
    const author = rom.event?.pubkey ?? 'Local ROM';
    authors.set(author, [...(authors.get(author) ?? []), rom]);
  }
  for (const [author, entries] of authors) {
    const heading = document.createElement('h3');
    heading.textContent = author === 'Local ROM' ? author : `Author: ${author}`;
    list.append(heading);
    entries.sort((a, b) => (b.event?.created_at ?? 0) - (a.event?.created_at ?? 0));
    for (const rom of entries) {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'rom-version';
      radio.value = rom.id;
      const text = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = rom.fileName ?? rom.name;
      const meta = document.createElement('small');
      meta.textContent = `${formatBytes(rom.bytes)} · ${romSourceSummary(rom)} · ${rom.event ? new Date(rom.event.created_at * 1000).toLocaleString() : 'Local file'} · ${rom.sha256 ?? rom.id}`;
      text.append(name, meta);
      label.append(radio, text);
      radio.addEventListener('change', () => { selected = rom; load.disabled = false; });
      list.append(label);
    }
  }
  load.onclick = () => {
    if (!selected) return;
    const rom = selected;
    const shouldRemember = remember.checked;
    dialog.close();
    void handleAction(async () => {
      await loadRomFromEntry(rom);
      if (shouldRemember) {
        preferences.romChoices = { ...(isRecord(preferences.romChoices) ? preferences.romChoices : {}), [group.id]: romChoiceKey(rom) };
        await persistPreferences();
      } else if (isRecord(preferences.romChoices) && Object.hasOwn(preferences.romChoices, group.id)) {
        const choices = { ...preferences.romChoices };
        delete choices[group.id];
        preferences.romChoices = choices;
        await persistPreferences();
      }
    });
  };
  dialog.showModal();
}

function closeRomDetail(): void {
  const previous = detailGroupId;
  detailGroupId = null;
  renderRoms();
  const card = [...elements.gameGrid.querySelectorAll<HTMLElement>('.game-card')]
    .find(card => card.dataset.groupId === previous);
  card?.querySelector<HTMLButtonElement>('.rom-info')?.focus();
}

function renderRomDetail(group: RomGroup): void {
  elements.gameGrid.classList.add('is-detail');
  const panel = document.createElement('section');
  panel.className = 'rom-detail';
  panel.ariaLabel = `${group.title} details`;
  for (const type of ['keydown', 'keyup']) panel.addEventListener(type, event => {
    if ((event as KeyboardEvent).key !== 'Escape') event.stopPropagation();
  });
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'rom-detail-back';
  back.textContent = '← Cartridges';
  back.addEventListener('click', closeRomDetail);
  const heading = document.createElement('h2');
  heading.textContent = group.title;
  panel.append(back, heading);
  if (group.entries.length > 1) {
    const versions = document.createElement('button');
    versions.type = 'button';
    versions.textContent = 'Choose version…';
    versions.addEventListener('click', () => chooseRomVersion(group, true));
    panel.append(versions);
  }
  const authors = new Map<string, RomEntry[]>();
  for (const entry of group.entries) {
    const author = entry.event?.pubkey.toLowerCase() ?? 'Local ROM';
    const entries = authors.get(author) ?? [];
    entries.push(entry);
    authors.set(author, entries);
  }
  for (const [author, entries] of authors) {
    entries.sort((a, b) => (b.event?.created_at ?? 0) - (a.event?.created_at ?? 0) || a.id.localeCompare(b.id));
    const section = document.createElement('section');
    section.className = 'rom-author-group';
    const title = document.createElement('h3');
    title.textContent = author === 'Local ROM' ? author : `Author: ${author}`;
    title.dataset.nappletSelect = 'text';
    const summary = document.createElement('p');
    summary.textContent = `${entries.length} option${entries.length === 1 ? '' : 's'} · newest first`;
    section.append(title, summary);
    for (const rom of entries) {
      const option = document.createElement('article');
      option.className = 'rom-detail-option';
      option.dataset.romId = rom.id;
      option.dataset.createdAt = String(rom.event?.created_at ?? 0);
      const name = document.createElement('h4');
      name.textContent = rom.fileName ?? rom.name;
      const data = document.createElement('dl');
      data.dataset.nappletSelect = 'text';
      const fields: [string, string][] = [
        ['Size', rom.bytes === undefined ? 'Unknown' : `${formatBytes(rom.bytes)} (${rom.bytes.toLocaleString()} bytes)`],
        ['Uploaded', rom.event ? new Date(rom.event.created_at * 1000).toISOString() : 'Local file'],
        ['SHA-256', rom.sha256 ?? 'Unknown'],
        ['Event ID', rom.event?.id ?? 'Not published'],
        ['Storage', rom.source === 'filesystem' ? 'Saved to filesystem' : rom.source === 'memory' ? 'In memory' : 'Published ROM'],
        ['Sources', rom.sources.map(source => `${source.label}: ${source.filesystemPath ?? source.url ?? 'In memory'}`).join('\n') || 'In memory'],
      ];
      for (const [label, value] of fields) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        data.append(dt, dd);
      }
      const actions = document.createElement('div');
      actions.className = 'rom-detail-actions';
      const play = document.createElement('button');
      play.type = 'button';
      play.textContent = 'Load ROM';
      play.addEventListener('click', () => { void handleAction(() => loadRomFromEntry(rom)); });
      actions.append(play);
      if (rom.event) attachRomReaction(actions, rom, true);
      if (hasDomain('fs')) attachRomDownload(actions, rom, true);
      else {
        const unavailable = document.createElement('button');
        unavailable.type = 'button';
        unavailable.textContent = 'Save ROM';
        unavailable.disabled = true;
        unavailable.title = 'Filesystem unavailable in this runtime';
        actions.append(unavailable);
      }
      option.append(name, actions, data);
      section.append(option);
    }
    panel.append(section);
  }
  elements.gameGrid.replaceChildren(panel);
}

type RomReactionState = { checked?: boolean; checking?: Promise<void>; count?: number; liked: boolean; busy: boolean; loading: boolean; error?: string };
const romReactions = new Map<string, RomReactionState>();
const reactionPublications = new Map<string, number>();
const reactionObservers = new Set<IntersectionObserver>();

function reactionStorageKey(eventId: string): string {
  return `gbcolor:reaction:${currentUserPubkey}:${eventId}`;
}

async function hasLikedRom(eventId: string): Promise<boolean> {
  if (!currentUserPubkey) return false;
  if (hasDomain('storage')) {
    try {
      if (await withTimeout(storage.getItem(reactionStorageKey(eventId)), 'reaction storage', 3000) === '+') return true;
    } catch { /* Check published reactions when storage is unavailable. */ }
  }
  const result = await withTimeout(outbox.query(
    { kinds: [7], authors: [currentUserPubkey], '#e': [eventId], limit: 100 },
    { authors: [currentUserPubkey], limit: 100, timeoutMs: 4000 },
  ), 'own ROM reactions', 5000);
  return result.events.some(({ event }) => event.kind === 7 && event.pubkey === currentUserPubkey &&
    (event.content === '+' || event.content === '') && event.tags.some(tag => tag[0] === 'e' && tag[1] === eventId));
}

async function rememberRomReaction(eventId: string): Promise<void> {
  if (!currentUserPubkey || !hasDomain('storage')) return;
  try { await withTimeout(storage.setItem(reactionStorageKey(eventId), '+'), 'reaction storage', 3000); }
  catch { /* The published reaction can still be rediscovered. */ }
}

function attachRomReaction(card: HTMLElement, rom: RomEntry, alwaysVisible = false): void {
  const eventId = rom.event!.id;
  let state = romReactions.get(eventId);
  if (!state) {
    state = { liked: false, busy: false, loading: false };
    romReactions.set(eventId, state);
  }
  const reaction = state;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rom-reaction';
  button.dataset.eventId = eventId;
  for (const type of ['keydown', 'keyup']) {
    button.addEventListener(type, event => { event.stopPropagation(); });
  }
  const draw = () => {
    const targets = [button, ...document.querySelectorAll<HTMLButtonElement>('.rom-reaction')];
    for (const target of targets) {
      if (target.dataset.eventId !== eventId) continue;
      target.textContent = `${reaction.liked ? '♥' : '♡'} ${reaction.count ?? '–'}`;
      target.ariaPressed = String(reaction.liked);
      target.disabled = reaction.busy || reaction.liked || !hasDomain('common') || !currentUserPubkey;
      target.ariaLabel = `${reaction.liked ? 'Reacted to' : 'Like'} ${rom.name}, ${reaction.count ?? 'unknown'} reactions`;
      target.title = reaction.error ?? (!hasDomain('common') ? 'Reactions unavailable in this runtime'
      : !currentUserPubkey ? 'Sign in to react' : reaction.liked ? 'Reaction published' : `Like ${rom.name}`);
    }
  };
  const readLiked = (): Promise<void> => {
    if (reaction.checked || reaction.liked || !currentUserPubkey) return Promise.resolve();
    if (reaction.checking) return reaction.checking;
    reaction.checking = (async () => {
      try {
        if (await hasLikedRom(eventId)) reaction.liked = true;
        reaction.checked = true;
      } catch { /* A failed lookup can be retried on the next interaction. */ }
      finally { reaction.checking = undefined; draw(); }
    })();
    return reaction.checking;
  };
  const readCount = async () => {
    void readLiked();
    if (reaction.count !== undefined || reaction.loading || !hasDomain('count')) return;
    reaction.loading = true;
    const publicationsBefore = reactionPublications.get(eventId) ?? 0;
    try {
      const result = await withTimeout(count.query({ kinds: [7], '#e': [eventId] }), 'reaction count', 5000);
      if (result.ok && typeof result.count === 'number' && Number.isSafeInteger(result.count) && result.count >= 0) {
        reaction.count = result.count + (reactionPublications.get(eventId) ?? 0) - publicationsBefore;
      }
    } catch { /* An unavailable count must not prevent reacting. */ }
    finally { reaction.loading = false; draw(); }
  };
  card.addEventListener('pointerenter', () => { void readCount(); });
  card.addEventListener('focusin', () => { void readCount(); });
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (reaction.busy || reaction.liked) return;
    reaction.busy = true;
    reaction.error = undefined;
    draw();
    void (async () => {
      try {
        await readLiked();
        if (reaction.liked) return;
        const result = await common.react(eventId, '+');
        if (!result.ok) throw new Error(result.error || 'Reaction could not be published');
        reaction.liked = true;
        reactionPublications.set(eventId, (reactionPublications.get(eventId) ?? 0) + 1);
        void rememberRomReaction(eventId);
        if (reaction.count !== undefined) reaction.count += 1;
        setStatus('ok', 'Reaction published');
      } catch (error) {
        reaction.error = error instanceof Error ? error.message : 'Reaction failed';
        setStatus('error', reaction.error);
      } finally { reaction.busy = false; draw(); }
    })();
  });
  draw();
  card.append(button);
  if (alwaysVisible) { void readCount(); return; }
  // Touch has no hover: query when this cartridge enters the visible list.
  if (window.matchMedia('(hover: none)').matches) {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); reactionObservers.delete(observer); void readCount(); }
    }, { root: elements.gameGrid });
    reactionObservers.add(observer);
    observer.observe(card);
  }
}

function renderConsoleReaction(): void {
  elements.consoleReaction.replaceChildren();
  if (activeRom?.event) {
    const container = document.createElement('div');
    elements.consoleReaction.append(container);
    attachRomReaction(container, activeRom, true);
  }
}

function orderedRomEntries(): RomEntry[] {
  const seen = new Set<string>();
  const published = [...(romScope === 'mine' ? filesystemRoms.values() : []), ...roms.values()].sort((left, right) => {
    const leftTime = left.event?.created_at ?? 0;
    const rightTime = right.event?.created_at ?? 0;
    return Number(right.source === 'filesystem') - Number(left.source === 'filesystem') || rightTime - leftTime || left.id.localeCompare(right.id);
  }).filter((rom) => {
    // Keep the newest upload for each author's ROM bytes. Missing hashes must
    // remain separate: matching titles do not establish identical cartridges.
    if (!rom.event?.pubkey || !rom.sha256 || !/^[a-f0-9]{64}$/i.test(rom.sha256)) return true;
    const key = `${rom.event.pubkey.toLowerCase()}:${rom.sha256.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...(localRom && !(romScope === 'mine' && [...filesystemRoms.values()].some(rom => rom.sha256 === localRom?.sha256)) ? [localRom] : []), ...published];
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
  if (rom.source === 'memory') return 'Memory';
  if (rom.source === 'filesystem') return 'Saved to filesystem';
  const filename = rom.fileName?.replace(/\.(gb|gbc|bin)$/i, '');
  const variant = filename?.startsWith(rom.name) ? filename.slice(rom.name.length).trim() : filename;
  return `${variant || `ROM ${rom.sha256?.slice(0, 8) ?? rom.event?.id.slice(0, 8)}`} · ${shortPubkey(rom.event?.pubkey)}`;
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
      loadButton.addEventListener('click', () => saveAction(() => loadSaveAndClose(() => applySaveEvent(event, { resetCore: true }))));

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'save-delete';
      deleteButton.textContent = 'Delete';
      deleteButton.ariaLabel = `Delete save from ${time.textContent}`;
      deleteButton.addEventListener('click', () => saveAction(() => deleteSaveEvent(event)));

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

function setScreenMaximized(maximized: boolean): void {
  releaseButtonInputs('keyboard');
  releaseButtonInputs('pointer');
  clearActionPulses();
  elements.deviceFace.dataset.maximized = String(maximized);
  const corners = maximized
    ? 'M4 9h5V4 M15 4v5h5 M20 15h-5v5 M9 20v-5H4'
    : 'M9 4H4v5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5';
  elements.screenToggle.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="${corners}" /></svg>`;
  elements.screenToggle.ariaLabel = maximized ? 'Restore console' : 'Maximize game screen';
  elements.screenToggle.title = maximized ? 'Restore console (Escape)' : 'Maximize game screen';
  elements.screenToggle.ariaPressed = String(maximized);
}

function setView(view: AppView): void {
  if (view === 'games') setScreenMaximized(false);
  elements.deviceFace.dataset.view = view;
  elements.gameView.setAttribute('aria-hidden', String(view !== 'game'));
  elements.gamesView.setAttribute('aria-hidden', String(view !== 'games'));
  elements.gamesButton.textContent = view === 'games' ? 'Console' : 'Games';
  if (view === 'games') {
    renderRoms();
  }
}

let browsingSaves = false;

function openSaveDialog(): void {
  browsingSaves = false;
  updateSaveAvailability();
  if (elements.saveFileButton.disabled) return;
  releaseButtonInputs('keyboard');
  releaseButtonInputs('pointer');
  clearActionPulses();
  renderSaveDestination();
  if (!elements.saveDialog.open) {
    elements.saveDialog.showModal();
  }
}


function renderSaveDestination(): void {
  elements.filesystemOption.hidden = !hasDomain('fs');
  elements.filesystemOption.disabled = !hasDomain('fs');
  if (elements.saveDestination.value === 'filesystem' && !hasDomain('fs')) {
    elements.saveDestination.value = 'nostr';
  }
  const destination = elements.saveDestination.value;
  const prompting = !elements.resumePrompt.hidden;
  elements.saveDestination.closest('label')!.toggleAttribute('hidden', prompting || !hasDomain('fs'));
  elements.saveButton.parentElement!.toggleAttribute('hidden', prompting);
  elements.saveHint.hidden = prompting;
  for (const button of [elements.resumeYes, elements.resumeNo, elements.resumeBrowse]) button.disabled = saveBusy;
  elements.saveList.hidden = !browsingSaves || destination !== 'nostr';
  elements.filesystemSaves.hidden = !browsingSaves || destination !== 'filesystem';
  elements.saveHint.textContent = destination === 'filesystem'
    ? 'Save captures this moment. Load opens your saved games.'
    : 'Save to your Nostr account. New saves resume this exact moment; older saves restore in-game progress.';
  elements.saveButton.textContent = destination === 'filesystem' ? 'New save' : 'Save';
  elements.loadSaveButton.textContent = 'Load';
  elements.saveButton.disabled = saveBusy || !isCoreLoaded;
  elements.loadSaveButton.disabled = saveBusy || !isCoreLoaded;
  elements.saveDestination.disabled = saveBusy;
  for (const list of [elements.saveList, elements.filesystemSaves]) {
    list.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach(control => { control.disabled = saveBusy; });
  }
}

async function saveAction(action: () => Promise<void>): Promise<void> {
  if (saveBusy) return;
  saveBusy = true;
  renderSaveDestination();
  try {
    await action();
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === 'cancelled' || (error instanceof Error && (error.name === 'AbortError' || error.message === 'cancelled'))) {
      setStatus('idle', 'File selection cancelled');
    } else {
      setStatus('error', error instanceof Error ? error.message : 'Save operation failed');
    }
  } finally {
    saveBusy = false;
    renderSaveDestination();
  }
}

function closeSaveDialog(): void {
  if (resumeSave) dismissResumePrompt();
  if (elements.saveDialog.open) {
    elements.saveDialog.close();
  }
}

let pendingRomIntent: ReturnType<typeof parseRomIntent> | null = null;
let romIntentReady = false;
let romIntentVersion = 0;
let romIntentWork: Promise<void> | null = null;
const intentSubscriptions: Subscription[] = [];
let finishIntentStartup: () => void = () => {};
const intentStartup = new Promise<void>(resolve => { finishIntentStartup = resolve; });
let commandWork = Promise.resolve();
let intentsClosed = false;

async function applyGameboyCommand(command: GameboyCommand): Promise<void> {
  if (command.action === 'sound') {
    preferences.sound = command.enabled!;
    const applying = audio.setEnabled(preferences.sound, false);
    settingsSound.checked = preferences.sound;
    await persistPreferences();
    await applying;
    return;
  }
  closeSaveDialog();
  settingsDialog.close();
  requireElement<HTMLDialogElement>('#romVersionDialog').close();
  switch (command.action) {
    case 'open': setView('game'); break;
    case 'browse': {
      detailGroupId = null;
      const scope = command.scope ?? preferences.romScope;
      preferences.romScope = scope;
      void persistPreferences();
      setView('games');
      if (!libraryDiscoveryStarted || romScope !== scope) await discoverRomEvents(scope);
      break;
    }
    case 'settings': requireElement<HTMLButtonElement>('#settingsButton').click(); break;
    case 'pause':
    case 'resume': {
      if (!isCoreLoaded) throw new Error('Load a ROM before changing playback');
      const paused = command.action === 'pause';
      if (isPaused !== paused) elements.pauseButton.click();
      break;
    }
    case 'maximize':
      setView('game');
      setScreenMaximized(command.enabled!);
      break;
  }
}

function registerRomIntent(): void {
  const capability = maybeNapplet()?.inc;
  if (!isRecord(capability) || typeof capability.on !== 'function') return;
  intentSubscriptions.push(inc.on(ROM_LOAD_CONVENTION, event => {
    try {
      pendingRomIntent = parseRomIntent(event.payload);
      romIntentVersion += 1;
      if (romIntentReady) {
        romLoadController?.abort();
        void drainRomIntents();
      }
    } catch (error) { setStatus('error', error instanceof Error ? error.message : 'Invalid ROM intent'); }
  }));
  for (const action of GAMEBOY_COMMANDS) {
    intentSubscriptions.push(inc.on(`napplet:gameboy/${action}`, event => {
      try {
        const command = parseGameboyCommand(action, event.payload);
        commandWork = commandWork.then(async () => {
          await intentStartup;
          await romIntentWork;
          if (!intentsClosed) await handleAction(() => applyGameboyCommand(command));
        });
      } catch (error) { setStatus('error', error instanceof Error ? error.message : 'Invalid gameboy intent'); }
    }));
  }
}

async function drainRomIntents(): Promise<void> {
  if (romIntentWork) return romIntentWork;
  romIntentWork = (async () => {
    while (pendingRomIntent) {
      const address = pendingRomIntent;
      const version = romIntentVersion;
      pendingRomIntent = null;
      await handleAction(async () => {
        closeSaveDialog();
        settingsDialog.close();
        requireElement<HTMLDialogElement>('#romVersionDialog').close();
        setStatus('idle', 'Finding requested ROM');
        const result = await withTimeout(outbox.query(
          { kinds: [address.kind], authors: [address.pubkey], '#d': [address.identifier], limit: 10 },
          { authors: [address.pubkey], relays: address.relays, timeoutMs: 5000 },
        ), 'ROM intent lookup', 6500);
        if (version !== romIntentVersion) return;
        const matches = result.events.filter(({ event }) => event.kind === address.kind && event.pubkey === address.pubkey &&
          event.tags.some(tag => tag[0] === 'd' && tag[1] === address.identifier))
          .sort((a, b) => b.event.created_at - a.event.created_at || a.event.id.localeCompare(b.event.id));
        const rom = matches[0] ? parseRomResult(matches[0]) : null;
        if (!rom) throw new Error('Requested ROM not found or has no playable resource');
        if (rom.sha256) await findCachedRom(rom.sha256);
        if (version !== romIntentVersion) return;
        roms.set(rom.id, rom);
        isDiscoveringRoms = false;
        await loadRomFromEntry(rom);
        if (version === romIntentVersion) await offerLatestSave();
      });
    }
  })();
  try { await romIntentWork; }
  finally { romIntentWork = null; }
}

async function bootstrap(): Promise<void> {
  elements.saveDestination.value = hasDomain('fs') ? 'filesystem' : 'nostr';
  renderSaveDestination();
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

  currentUserPubkey = await withTimeout(identity.getPublicKey(), 'identity.getPublicKey', 4000);
  await loadPreferences();
  romScope = preferences.romScope;
  romIntentReady = true;
  if (pendingRomIntent) { await drainRomIntents(); return; }
  if (preferences.loadLastRom && await restoreLastGame()) {
    if (romIntentVersion > 0) return;
    await offerLatestSave();
    return;
  }
  if (romIntentVersion > 0) return;
  const romCount = await discoverRomEvents(preferences.romScope);
  if (romIntentVersion > 0) return;
  if (!preferences.loadLastRom) { setView('games'); return; }
  if (romCount === 0) {
    setStatus('idle', 'No games here yet');
    return;
  }
  await loadSelectedRom();
  await offerLatestSave();
}

type CartridgeSize = 'small' | 'medium' | 'large';

function isCartridgeSize(value: unknown): value is CartridgeSize {
  return value === 'small' || value === 'medium' || value === 'large';
}

function applyCartridgeSize(): void {
  elements.cartridgeSize.value = preferences.cartridgeSize;
  elements.gameGrid.dataset.cartridgeSize = preferences.cartridgeSize;
}

type UserPreferences = { sound: boolean; romScope: RomScope; cartridgeSize: CartridgeSize; loadLastRom: boolean; cacheRoms: boolean; [key: string]: unknown };
let preferences: UserPreferences = { sound: false, romScope: 'global', cartridgeSize: 'medium', loadLastRom: true, cacheRoms: false };
let preferenceWrites: Promise<void> = Promise.resolve();

function preferencesStorageKey(): string {
  return `gbcolor:preferences:${currentUserPubkey || 'anonymous'}`;
}

async function loadPreferences(): Promise<void> {
  preferences = { sound: false, romScope: 'global', cartridgeSize: 'medium', loadLastRom: true, cacheRoms: false };
  if (hasDomain('storage')) {
    try {
      const raw = await withTimeout(storage.getItem(preferencesStorageKey()), 'storage.getItem', 3000);
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (isRecord(saved)) preferences = {
        ...saved,
        loadLastRom: typeof saved.loadLastRom === 'boolean' ? saved.loadLastRom : true,
        cacheRoms: typeof saved.cacheRoms === 'boolean' ? saved.cacheRoms : false,
        cartridgeSize: isCartridgeSize(saved.cartridgeSize) ? saved.cartridgeSize : 'medium',
        sound: typeof saved.sound === 'boolean' ? saved.sound : false,
        romScope: typeof saved.romScope === 'string' && isRomScope(saved.romScope) ? saved.romScope : 'global',
      };
    } catch { /* Defaults keep sound usable without storage. */ }
  }
  applyCartridgeSize();
  // Restore the setting without waiting for browser audio permission. A game
  // control press will activate audio under a user gesture.
  await audio.setEnabled(preferences.sound, false);
}

function persistPreferences(): Promise<void> {
  if (!hasDomain('storage')) return Promise.resolve();
  const key = preferencesStorageKey();
  const value = JSON.stringify(preferences);
  // Serialize writes so a rapid on/off sequence keeps the last choice.
  preferenceWrites = preferenceWrites.then(async () => {
    try { await withTimeout(storage.setItem(key, value), 'storage.setItem', 3000); }
    catch { setStatus('warn', 'Preference could not be saved'); }
  });
  return preferenceWrites;
}

function lastGameStorageKey(): string {
  return `gbcolor:last-game:${currentUserPubkey || 'anonymous'}`;
}

async function rememberLastGame(rom: RomEntry): Promise<void> {
  if (!hasDomain('storage')) return;
  try {
    await withTimeout(storage.setItem(lastGameStorageKey(), JSON.stringify({
      id: rom.event?.id, author: rom.event?.pubkey, sha256: rom.sha256,
    })), 'storage.setItem', 3000);
  } catch { /* Remembering a game must not prevent playing it. */ }
}

async function restoreLastGame(): Promise<boolean> {
  if (!hasDomain('storage')) return false;
  try {
    const raw = await withTimeout(storage.getItem(lastGameStorageKey()), 'storage.getItem', 3000);
    if (!raw) return false;
    const saved: unknown = JSON.parse(raw);
    if (!isRecord(saved) || typeof saved.sha256 !== 'string') return false;
    setStatus('idle', 'Restoring last game');
    await findCachedRom(saved.sha256);
    let rom = [...filesystemRoms.values(), ...orderedRomEntries()].find(entry => (entry.sha256 === saved.sha256 || entry.event?.id === saved.id) && entry.event?.pubkey === saved.author);
    if (!rom && typeof saved.author === 'string' && typeof saved.id === 'string') {
      const result = await withTimeout(outbox.query(
        { kinds: [ROM_KIND], ids: [saved.id], authors: [saved.author], limit: 1 },
        { authors: [saved.author], timeoutMs: 4000 },
      ), 'last game lookup', 5000);
      const candidate = result.events[0] && parseRomResult(result.events[0]);
      if (candidate && (!candidate.sha256 || candidate.sha256 === saved.sha256) && candidate.event?.pubkey === saved.author) {
        rom = candidate;
        roms.set(rom.id, rom);
      }
    }
    if (!rom || romIntentVersion > 0) return false;
    isDiscoveringRoms = false;
    await loadRomFromEntry({ ...rom, sha256: saved.sha256 });
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return false;
  }
}

let resumeSave: (() => Promise<void>) | null = null;

async function offerLatestSave(): Promise<void> {
  const rom = activeRom;
  if (!rom) return;
  let latestTime = saveEvents[0]?.created_at ? saveEvents[0].created_at * 1000 : -1;
  const event = saveEvents[0];
  let latest: (() => Promise<void>) | null = event ? () => applySaveEvent(event) : null;
  let destination = 'nostr';
  if (hasDomain('fs')) {
    try {
      const files = await listFilesystemSaves(rom);
      files.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) || b.name.localeCompare(a.name));
      const file = files[0];
      if (file && (file.modifiedAt ?? 0) >= latestTime) {
        const path = file.path;
        latest = () => loadFromFilesystem(path);
        destination = 'filesystem';
      }
    } catch { /* Nostr saves can still be offered if filesystem discovery fails. */ }
  }
  if (!latest || activeRom !== rom || settingsDialog.open || elements.deviceFace.dataset.view !== 'game') return;
  resumeSave = latest;
  elements.saveDestination.value = destination;
  elements.resumePrompt.hidden = false;
  browsingSaves = false;
  releaseButtonInputs('keyboard');
  clearActionPulses();
  stopLoop();
  renderSaveDestination();
  elements.saveDialog.showModal();
}

function dismissResumePrompt(): void {
  resumeSave = null;
  elements.resumePrompt.hidden = true;
  if (isCoreLoaded && !isPaused) startLoop();
  renderSaveDestination();
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
      const handle = await runtimeRequest(() => keys.register(
        {
          id: `gbcolor.${action.button}`,
          label: action.label,
          defaultKey: action.defaultKey,
        },
        () => pulseButton(action.button),
      ));
      keyHandles.push(handle);
    } catch {
      setStatus('warn', 'Key registration incomplete');
    }
  }
}

async function discoverRomEvents(scope: RomScope = romScope): Promise<number> {
  libraryDiscoveryStarted = true;
  const generation = ++discoveryGeneration;
  romScope = scope;
  isDiscoveringRoms = true;
  renderRoms();
  setStatus('idle', `Searching ${scopeLabel(scope)}`);
  if (scope === 'mine') await refreshFilesystemRoms();
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
  return localRom?.id === id ? localRom : filesystemRoms.get(id) ?? roms.get(id);
}

function hasRomEntry(id: string): boolean {
  return localRom?.id === id || filesystemRoms.has(id) || roms.has(id);
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

let romLoadController: AbortController | null = null;

async function loadRom(rom: RomEntry): Promise<void> {
  romLoadController?.abort();
  const controller = new AbortController();
  romLoadController = controller;
  const wasRunning = Boolean(animationFrame);
  const previousView: AppView = elements.deviceFace.dataset.view === 'games' ? 'games' : 'game';
  setView('game');
  stopLoop();
  releaseButtonInputs('keyboard');
  clearActionPulses();
  elements.romLoadingName.textContent = `Loading ${rom.name}`;
  elements.romLoadingDialog.hidden = false;
  for (const region of document.querySelectorAll<HTMLElement>('.gamepad, .bottom-bar, .console-reaction')) region.inert = true;
  elements.cancelRomLoad.focus();
  setStatus('idle', `Loading ${rom.name}`);
  try {
    const { bytes: romBytes, hash, source } = await abortableRomLoad(loadRomBytes(rom, controller.signal), controller.signal);
    controller.signal.throwIfAborted();
    initializeCore(romBytes);
    activeRom = { ...rom, url: source.url, sha256: rom.sha256 ?? hash, bytes: romBytes.byteLength };
    activeRomBytes = romBytes;
    if (preferences.cacheRoms && hasDomain('fs')) {
      void cacheRomBytes(activeRom, romBytes, hash).then(() => renderRoms()).catch(() => {
        setStatus('warn', 'ROM is playing, but its filesystem copy could not be saved');
      });
    }
    activeCartRamSize = getCartridgeRamSize(romBytes);
    renderConsoleReaction();
    isPaused = false;
    elements.pauseButton.textContent = 'Pause';
    startLoop();
    elements.bootOverlay.classList.add('is-loaded');
    setStatus('ok', activeRom.name);
    renderRoms();
  } catch (error) {
    if (romLoadController === controller) {
      setView(previousView);
      if (wasRunning && isCoreLoaded) startLoop();
    }
    throw error;
  } finally {
    if (romLoadController === controller) {
      romLoadController = null;
      elements.romLoadingDialog.hidden = true;
      for (const region of document.querySelectorAll<HTMLElement>('.gamepad, .bottom-bar, .console-reaction')) region.inert = false;
    }
  }
  await refreshSaves();
  if (activeRom) await rememberLastGame(activeRom);
}

function abortableRomLoad<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new DOMException('ROM loading cancelled', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

async function loadRomBytes(rom: RomEntry, signal?: AbortSignal): Promise<{ bytes: Uint8Array; hash: string; source: RomSource }> {
  const errors: string[] = [];
  const pending = pendingRomCaches.get(rom.id);
  if (pending) await abortableRomLoad(pending.catch(() => {}), signal ?? new AbortController().signal);
  signal?.throwIfAborted();
  if (rom.sha256 && ![...filesystemRoms.values()].some(entry => entry.sha256 === rom.sha256?.toLowerCase())) await findCachedRom(rom.sha256);
  signal?.throwIfAborted();
  const cached = hasDomain('fs') ? [...filesystemRoms.values()].find(entry =>
    rom.sha256 ? entry.sha256 === rom.sha256?.toLowerCase()
      : Boolean(rom.event && entry.event?.id === rom.event.id && entry.event.pubkey === rom.event.pubkey)) : undefined;
  const sources = cached ? [...cached.sources, ...rom.sources.filter(source => !cached.sources.some(local => local.filesystemPath === source.filesystemPath && source.filesystemPath))] : rom.sources;
  for (const source of sources) {
    signal?.throwIfAborted();
    try {
      const blob = source.filesystemPath
        ? new Blob([await readFilesystemBytes(source.filesystemPath, 16 * 1024 * 1024, signal)])
        : source.sidecarBlob ?? await withTimeout(
        resource.bytes(source.url, {
          signal,
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
      signal?.throwIfAborted();
      return { bytes, hash, source };
    } catch (error) {
      signal?.throwIfAborted();
      if (cached && cached.sources.includes(source)) filesystemRoms.delete(cached.id);
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
  let lastTime: number | null = null;
  let accumulatedTime = 0;

  const tick = (time: number) => {
    if (isPaused || !isCoreLoaded || document.hidden) {
      lastTime = null;
      accumulatedTime = 0;
    } else {
      const elapsed = lastTime === null ? 0 : Math.max(0, time - lastTime);
      lastTime = time;
      // A stalled/background tab must not replay seconds of missed emulation.
      if (elapsed > 250) {
        accumulatedTime = 0;
        audio.reset();
      } else {
        accumulatedTime = Math.min(accumulatedTime + elapsed, FRAME_DURATION_MS * MAX_CATCH_UP_FRAMES);
        let frames = 0;
        while (accumulatedTime >= FRAME_DURATION_MS && !isPaused) {
          accumulatedTime -= FRAME_DURATION_MS;
          runCoreFrame();
          frames += 1;
        }
        if (frames > 0) renderFrame();
      }
    }
    animationFrame = window.requestAnimationFrame(tick);
  };

  animationFrame = window.requestAnimationFrame(tick);
  updateSaveAvailability();
}

function updateSaveAvailability(): void {
  elements.saveFileButton.disabled = !activeRom || !isCoreLoaded || isPaused || !animationFrame;
  elements.saveFileButton.title = !activeRom || !isCoreLoaded
    ? 'Load a game to use save files'
    : elements.saveFileButton.disabled ? 'Resume the game to use save files' : 'Save or load game progress';
}

function stopLoop(): void {
  audio.reset();
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  }
  updateSaveAvailability();
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
      updateSaveAvailability();
      audio.reset();
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

async function createSavePayload(): Promise<SavePayload> {
  if (!activeRom || !isCoreLoaded) throw new Error('Load a game before saving');
  const rom = { name: activeRom.name, slug: activeRom.slug, sha256: activeRom.sha256 };
  // Copy registers and memory synchronously at one frame boundary before compression yields.
  const state = JSON.stringify({
    registers: core.captureSnapshotRegisters(),
    memory: bytesToBase64(readCoreMemory(0, core.CARTRIDGE_ROM_LOCATION)),
  });
  const compressed = new Uint8Array(await new Response(
    new Blob([state]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer());
  return {
    schema: 'gbcolor.save.v1', emulator: 'wasmboy-core', rom,
    payload: { format: 'snapshot-v1', ...await encodeBytes(compressed) },
  };
}

async function publishSave(): Promise<void> {
  const rom = activeRom;
  if (!rom || !isCoreLoaded) throw new Error('Load a game before saving');
  setStatus('idle', 'Publishing save');
  const payload = await createSavePayload();
  const dTag = saveDTag(rom);
  const result = await withTimeout(
    outbox.publish({
      kind: SAVE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', dTag],
        ['title', `${rom.name} save`],
        ['application', 'gbcolor'],
        ['rom', rom.slug],
        ['rom-sha256', rom.sha256 ?? ''],
        ['save-format', SAVE_FORMAT],
        ['x', payload.payload.sha256],
      ].filter((tag) => tag[1] !== ''),
      content: JSON.stringify(payload),
    }),
    'outbox.publish',
    10000,
  );

  if (!result.ok) {
    throw new Error(result.error ?? 'Save publish failed');
  }

  if (activeRom !== rom) return;
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
  await applySaveContent(event.content, options);
}

async function applySaveContent(
  content: string,
  options: { resetCore?: boolean } = { resetCore: true },
  expectedRom = activeRom,
): Promise<void> {
  if (!activeRom || !isCoreLoaded) {
    return;
  }

  const payload = parseSavePayload(content);
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
  const hash = await sha256Hex(bytes);
  if (hash !== payload.payload.sha256) throw new Error('Save hash mismatch');
  if (activeRom !== expectedRom) throw new Error('Game changed; open the save again');

  let snapshot: { registers: ReturnType<typeof core.captureSnapshotRegisters>; memory: Uint8Array } | null = null;
  if (payload.payload.format === 'snapshot-v1') {
    if (!payload.rom.sha256 || payload.rom.sha256 !== activeRom.sha256) throw new Error('Save ROM does not match');
    snapshot = await decodeSnapshot(bytes);
  } else if (bytes.byteLength !== activeCartRamSize) {
    throw new Error('Save does not match cartridge RAM size');
  }
  if (activeRom !== expectedRom) throw new Error('Game changed; open the save again');
  if (!activeRomBytes) throw new Error('ROM bytes unavailable');
  // Do not touch the running game until all hashes, shapes and sizes have been validated.
  stopLoop();
  if (snapshot) {
    core.memory.wasmByteMemory.set(snapshot.memory, 0);
    core.restoreSnapshotRegisters(snapshot.registers);
    audio.reset();
    updateJoypadState();
    renderFrame();
  } else {
    if (options.resetCore) initializeCore(activeRomBytes);
    core.memory.wasmByteMemory.set(bytes, core.CARTRIDGE_RAM_LOCATION);
  }
  if (options.resetCore) {
    isPaused = false;
    elements.pauseButton.textContent = 'Pause';
    startLoop();
  }
  setStatus('ok', 'Save loaded');
}

async function decodeSnapshot(bytes: Uint8Array): Promise<{
  registers: ReturnType<typeof core.captureSnapshotRegisters>; memory: Uint8Array;
}> {
  const reader = new Blob([new Uint8Array(bytes).buffer]).stream()
    .pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SAVE_FILE_BYTES) throw new Error('Save state is too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const decoded = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { decoded.set(chunk, offset); offset += chunk.byteLength; }
  const state: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
  if (!isRecord(state) || typeof state.memory !== 'string') throw new Error('Invalid save state');
  core.validateSnapshotRegisters(state.registers);
  const memory = base64ToBytes(state.memory);
  if (memory.byteLength !== core.CARTRIDGE_ROM_LOCATION) throw new Error('Incompatible save state memory');
  return { registers: state.registers as ReturnType<typeof core.captureSnapshotRegisters>, memory };
}

// Share one paced queue for filesystem work and key registration. Chunking must
// respect request-count limits as well as the runtime's byte limits.
let runtimeRequests = Promise.resolve();
let lastRuntimeRequest = 0;
function runtimeRequest<T>(operation: () => Promise<T>): Promise<T> {
  const task = runtimeRequests.then(async () => {
    const delay = Math.max(0, 300 - (Date.now() - lastRuntimeRequest));
    if (delay) await new Promise(resolve => window.setTimeout(resolve, delay));
    lastRuntimeRequest = Date.now();
    return operation();
  });
  runtimeRequests = task.then(() => {}, () => {});
  return task;
}

let filesystemInfo: ReturnType<typeof fs.info> | undefined;
function getFilesystemInfo(): ReturnType<typeof fs.info> {
  if (!filesystemInfo) {
    filesystemInfo = runtimeRequest(() => fs.info()).catch(error => { filesystemInfo = undefined; throw error; });
  }
  return filesystemInfo;
}

async function findCachedRom(hash: string): Promise<void> {
  if (!hasDomain('fs') || !/^[a-f0-9]{64}$/i.test(hash)) return;
  if ([...filesystemRoms.values()].some(entry => entry.sha256 === hash.toLowerCase())) return;
  try {
    const { directory } = await filesystemRoot();
    const folder = romFolder(directory, hash);
    const bytes = await readFilesystemBytes(`${folder}/metadata.json`, 16 * 1024);
    const rom = filesystemRomEntry(JSON.parse(new TextDecoder().decode(bytes)), folder);
    if (rom) filesystemRoms.set(rom.id, rom);
  } catch { /* A cache miss must not block the published source. */ }
}

async function filesystemRoot() {
  const info = await getFilesystemInfo();
  const root = info.roots.find(root => root.permissions.includes('read') && root.permissions.includes('write'));
  if (!root) throw new Error('No readable, writable filesystem location is available');
  return { directory: root.path.replace(/\/$/, ''), limits: info.limits };
}

function romFolder(root: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('ROM identity unavailable');
  return `${root}/gbcolor/roms/${hash.toLowerCase()}`;
}

async function filesystemSaveLocation(rom: RomEntry) {
  const { directory: root, limits } = await filesystemRoot();
  if (!rom.sha256) throw new Error('ROM identity unavailable');
  return { directory: `${romFolder(root, rom.sha256)}/saves`, legacyDirectory: root, prefix: `gbcolor-${rom.sha256}`, limits };
}

async function listFilesystemSaves(rom: RomEntry) {
  const { directory, legacyDirectory, prefix } = await filesystemSaveLocation(rom);
  const files = [];
  for (const parent of [directory, legacyDirectory]) {
    try {
      for (const entry of await runtimeRequest(() => fs.list(parent || '/'))) {
        if (entry.kind === 'file' && (entry.name === `${prefix}.gbcsave` ||
          (entry.name.startsWith(`${prefix}-`) && entry.name.endsWith('.gbcsave')))) {
          files.push({ ...entry, path: `${parent}/${entry.name}` });
        }
      }
    } catch (error) {
      if (!isFilesystemNotFound(error)) throw error;
    }
  }
  return files;
}

function isFilesystemNotFound(error: unknown): boolean {
  return (isRecord(error) && error.code === 'not-found') || (error instanceof Error && error.message === 'not-found');
}

async function readFilesystemBytes(path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const { limits } = await getFilesystemInfo();
  const length = Math.min(limits.maxReadBytes, 1024 * 1024);
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error('Filesystem reads unavailable');
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (true) {
    signal?.throwIfAborted();
    const result = await runtimeRequest(() => { signal?.throwIfAborted(); return fs.read(path, { offset, length }); });
    const bytes = base64ToBytes(result.data);
    if (result.offset !== offset || result.bytesRead !== bytes.length) throw new Error('Incomplete file read');
    offset += bytes.length;
    if (offset > maxBytes) throw new Error('File is too large');
    chunks.push(bytes);
    if (result.eof) break;
    if (!bytes.length) throw new Error('Incomplete file read');
  }
  const output = new Uint8Array(offset);
  let cursor = 0;
  for (const bytes of chunks) { output.set(bytes, cursor); cursor += bytes.length; }
  return output;
}

async function ensureFilesystemDirectory(path: string): Promise<void> {
  try {
    await runtimeRequest(() => fs.mkdir(path, { recursive: true }));
  } catch (error) {
    const alreadyExists = (isRecord(error) && error.code === 'already-exists') ||
      (error instanceof Error && error.message === 'already-exists');
    if (!alreadyExists) throw error;
    // Some NAP-FS runtimes report existing directories even with recursive mkdir.
    // Only accept an actual directory; files and permission failures must surface.
    const entry = await runtimeRequest(() => fs.stat(path));
    if (entry.kind !== 'directory') throw error;
  }
}

async function writeFilesystemBytes(path: string, bytes: Uint8Array): Promise<void> {
  const { limits } = await getFilesystemInfo();
  const length = Math.min(limits.maxWriteBytes, 1024 * 1024);
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error('Filesystem writes unavailable');
  for (let offset = 0; offset < bytes.length; offset += length) {
    const chunk = bytes.subarray(offset, offset + length);
    const result = await runtimeRequest(() => fs.write(path, bytesToBase64(chunk), offset === 0 ? { mode: 'replace' } : { mode: 'patch', offset }));
    if (result.bytesWritten !== chunk.length) throw new Error('Incomplete file write');
  }
}

const filesystemRoms = new Map<string, RomEntry>();
const downloadingRoms = new Set<string>();
const pendingRomCaches = new Map<string, Promise<void>>();

async function cacheRomBytes(rom: RomEntry, bytes: Uint8Array, hash: string): Promise<void> {
  const pending = pendingRomCaches.get(rom.id);
  if (pending) return pending;
  const writing = writeRomCache(rom, bytes, hash);
  pendingRomCaches.set(rom.id, writing);
  try { await writing; }
  finally { if (pendingRomCaches.get(rom.id) === writing) pendingRomCaches.delete(rom.id); }
}

async function writeRomCache(rom: RomEntry, bytes: Uint8Array, hash: string): Promise<void> {
  if ([...filesystemRoms.values()].some(entry => entry.sha256 === hash)) return;
        const { directory: root } = await filesystemRoot();
        const directory = romFolder(root, hash);
        await ensureFilesystemDirectory(`${directory}/saves`);
        const filename = bytes[0x143] === 0x80 || bytes[0x143] === 0xc0 ? 'rom.gbc' : 'rom.gb';
        await writeFilesystemBytes(`${directory}/${filename}`, bytes);
        const metadata = { schema: 'gbcolor.rom.v1', name: rom.name, slug: rom.slug, fileName: rom.fileName,
          sha256: hash, bytes: bytes.length, filename, event: rom.event ? { id: rom.event.id, pubkey: rom.event.pubkey, created_at: rom.event.created_at } : undefined };
        // Publish the catalog record last; interrupted downloads never appear in Mine.
        await writeFilesystemBytes(`${directory}/metadata.json`, new TextEncoder().encode(JSON.stringify(metadata)));
        const stored = filesystemRomEntry(metadata, directory);
        if (stored) filesystemRoms.set(stored.id, stored);
 }

function attachRomDownload(card: HTMLElement, rom: RomEntry, labelled = false): void {
  const saved = [...filesystemRoms.values()].some(entry => entry.sha256 === rom.sha256);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rom-download';
  button.textContent = saved ? (labelled ? '✓ Saved to filesystem' : '✓') : downloadingRoms.has(rom.id) ? (labelled ? 'Saving…' : '…') : (labelled ? '↓ Save ROM' : '↓');
  button.disabled = saved || downloadingRoms.has(rom.id);
  button.title = saved ? 'Saved to filesystem — available in Mine' : 'Save ROM to filesystem';
  button.ariaLabel = `${button.title}: ${rom.name}`;
  for (const type of ['keydown', 'keyup']) button.addEventListener(type, event => event.stopPropagation());
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (downloadingRoms.has(rom.id)) return;
    downloadingRoms.add(rom.id);
    button.disabled = true;
    button.textContent = '…';
    void handleAction(async () => {
      try {
        setStatus('idle', `Saving ${rom.name} to filesystem`);
        const { bytes, hash } = await loadRomBytes(rom);
        await cacheRomBytes(rom, bytes, hash);
        setStatus('ok', `${rom.name} saved — available in Mine`);
      } finally { downloadingRoms.delete(rom.id); renderRoms(); }
    });
  });
  card.append(button);
}

function filesystemRomEntry(value: unknown, directory: string): RomEntry | null {
  if (!isRecord(value) || value.schema !== 'gbcolor.rom.v1' || typeof value.name !== 'string' ||
    typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !directory.endsWith(`/${value.sha256}`) || (value.filename !== 'rom.gb' && value.filename !== 'rom.gbc') ||
    typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > 16 * 1024 * 1024) return null;
  const path = `${directory}/${value.filename}`;
  const event = isRecord(value.event) && typeof value.event.id === 'string' && /^[a-f0-9]{64}$/.test(value.event.id) &&
    typeof value.event.pubkey === 'string' && /^[a-f0-9]{64}$/.test(value.event.pubkey) &&
    typeof value.event.created_at === 'number' && Number.isSafeInteger(value.event.created_at)
    ? { id: value.event.id, pubkey: value.event.pubkey, created_at: value.event.created_at } : undefined;
  return { id: `filesystem-${value.sha256}`, name: value.name, fileName: readString(value, 'fileName'),
    slug: readString(value, 'slug') ?? slugify(value.name), sha256: value.sha256, bytes: value.bytes, source: 'filesystem', event,
    url: path, sources: [{ kind: 'resource', url: path, filesystemPath: path, label: 'Filesystem', sha256: value.sha256, bytes: value.bytes }] };
}

async function refreshFilesystemRoms(): Promise<void> {
  if (!hasDomain('fs')) return;
  try {
    const { directory: root } = await filesystemRoot();
    const directory = `${root}/gbcolor/roms`;
    const entries = await runtimeRequest(() => fs.list(directory));
    const found = new Map<string, RomEntry>();
    for (const entry of entries) {
      if (entry.kind !== 'directory' || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      try {
        const folder = `${directory}/${entry.name}`;
        const bytes = await readFilesystemBytes(`${folder}/metadata.json`, 16 * 1024);
        const rom = filesystemRomEntry(JSON.parse(new TextDecoder().decode(bytes)), folder);
        if (rom) found.set(rom.id, rom); // Verify ROM bytes only when the user loads it.
      } catch { /* Skip incomplete or invalid catalog records. */ }
    }
    filesystemRoms.clear();
    for (const [id, rom] of found) filesystemRoms.set(id, rom);
  } catch (error) {
    if (isFilesystemNotFound(error)) filesystemRoms.clear();
  }
}

function filesystemSaveName(path: string, prefix: string): string {
  const filename = path.slice(path.lastIndexOf('/') + 1);
  if (filename === `${prefix}.gbcsave`) return 'Original save';
  try { return decodeURIComponent(filename.slice(prefix.length + 38, -8)); }
  catch { return filename; }
}

function newFilesystemSavePath(directory: string, prefix: string, name: string): string {
  return `${directory}/${prefix}-${crypto.randomUUID()}-${encodeURIComponent(name)}.gbcsave`;
}

async function refreshFilesystemSaves(): Promise<void> {
  const rom = activeRom;
  if (!rom) return;
  elements.filesystemSaves.replaceChildren();
  const { directory, prefix } = await filesystemSaveLocation(rom);
  const saves = await listFilesystemSaves(rom);
  if (activeRom !== rom) return;
  for (const entry of saves) {
    const path = entry.path;
    const name = filesystemSaveName(path, prefix);
    const item = document.createElement('li');
    item.dataset.path = path;
    const row = document.createElement('div');
    row.className = 'save-row';
    const label = document.createElement('span');
    label.className = 'save-name';
    label.textContent = name;
    label.title = name;
    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'save-load';
    load.textContent = 'Load';
    load.addEventListener('click', () => { void saveAction(() => loadSaveAndClose(() => loadFromFilesystem(path))); });
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'save-rename';
    rename.textContent = 'Rename';
    const editor = document.createElement('div');
    editor.className = 'save-rename-editor';
    editor.hidden = true;
    const input = document.createElement('input');
    input.maxLength = 60;
    input.ariaLabel = `New name for ${name}`;
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = 'Rename';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    rename.addEventListener('click', () => {
      input.value = name;
      editor.hidden = false;
      rename.hidden = true;
      input.focus();
      input.select();
    });
    cancel.addEventListener('click', () => { editor.hidden = true; rename.hidden = false; rename.focus(); });
    const submit = () => saveAction(async () => {
      const newName = input.value.trim();
      if (!newName) throw new Error('Enter a save name');
      await ensureFilesystemDirectory(directory);
      await runtimeRequest(() => fs.move(path, newFilesystemSavePath(directory, prefix, newName)));
      await refreshFilesystemSaves();
      setStatus('ok', 'Save renamed');
    });
    confirm.addEventListener('click', () => { void submit(); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); void submit(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.click(); }
    });
    editor.append(input, confirm, cancel);
    row.append(label, load, rename);
    item.append(row, editor);
    elements.filesystemSaves.append(item);
  }
  if (!saves.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-save';
    empty.textContent = 'No saves for this game yet';
    elements.filesystemSaves.append(empty);
  }
  renderSaveDestination();
}

async function loadSaveAndClose(load: () => Promise<void>): Promise<void> {
  await load();
  closeSaveDialog();
}

async function loadOrBrowseSaves(): Promise<void> {
  const rom = activeRom;
  if (!rom) return;
  if (elements.saveDestination.value === 'filesystem') {
    const saves = await listFilesystemSaves(rom);
    if (activeRom !== rom) return;
    if (saves.length === 1) {
      await loadSaveAndClose(() => loadFromFilesystem(saves[0]!.path));
      return;
    }
  } else {
    await refreshSaves();
    if (activeRom !== rom) return;
    if (saveEvents.length === 1) {
      await loadSaveAndClose(() => applySaveEvent(saveEvents[0]!));
      return;
    }
  }
  await browseSaves();
}

async function browseSaves(): Promise<void> {
  browsingSaves = true;
  renderSaveDestination();
  await (elements.saveDestination.value === 'filesystem' ? refreshFilesystemSaves() : refreshSaves());
}

async function saveToFilesystem(): Promise<void> {
  const rom = activeRom;
  if (!rom || !isCoreLoaded) throw new Error('Load a game before saving');
  setStatus('idle', 'Saving to filesystem');
  const payload = await createSavePayload();
  const { directory, prefix, limits } = await filesystemSaveLocation(rom);
  await ensureFilesystemDirectory(directory);
  const name = `Save ${new Date().toLocaleString()}`;
  const path = newFilesystemSavePath(directory, prefix, name);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const chunkSize = Math.min(limits.maxWriteBytes, 1024 * 1024);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error('Filesystem writes unavailable');
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    const result = await runtimeRequest(() => fs.write(path, bytesToBase64(chunk), offset === 0
      ? { mode: 'replace' } : { mode: 'patch', offset }));
    if (result.bytesWritten !== chunk.length) throw new Error('Incomplete save write; save the file again');
  }
  if (browsingSaves) await refreshFilesystemSaves();
  setStatus('ok', 'Saved to filesystem');
}

async function loadFromFilesystem(path: string): Promise<void> {
  const rom = activeRom;
  if (!rom || !isCoreLoaded) throw new Error('Load a game before loading a save');
  setStatus('idle', 'Loading from filesystem');
  const { limits } = await filesystemSaveLocation(rom);
  const length = Math.min(limits.maxReadBytes, 1024 * 1024);
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error('Filesystem reads unavailable');
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (true) {
    let result;
    try {
      result = await runtimeRequest(() => fs.read(path, { offset, length }));
    } catch (error) {
      if ((isRecord(error) && error.code === 'not-found') || (error instanceof Error && error.message === 'not-found')) {
        throw new Error('No filesystem save for this game yet');
      }
      throw error;
    }
    const bytes = base64ToBytes(result.data);
    if (result.offset !== offset || result.bytesRead !== bytes.length) throw new Error('Incomplete save file read');
    offset += bytes.length;
    if (offset > MAX_SAVE_FILE_BYTES) throw new Error('Save file is too large');
    chunks.push(bytes);
    if (result.eof) break;
    if (!bytes.length) throw new Error('Incomplete save file read');
  }
  const bytes = new Uint8Array(offset);
  offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  await applySaveContent(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { resetCore: true }, rom);
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
  const sha256 = romContentHash(content, event.tags, sources);
  if (!primarySource) {
    return null;
  }

  const metadata = isRecord(content.metadata) ? content.metadata : undefined;
  const file = metadata && isRecord(metadata.file) ? metadata.file : undefined;
  const dTag = readTag(event.tags, 'd') ?? event.id.slice(0, 12);
  const name = readString(content, 'name') ?? readTag(event.tags, 'title') ?? readTag(event.tags, 'name') ?? dTag;
  return {
    id: `event-${event.id}`,
    name,
    fileName: readString(file, 'name') ?? readString(content, 'fileName'),
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
  if (content.length > MAX_SAVE_FILE_BYTES) return null;
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
  if (!['cartridge-ram', 'snapshot-v1'].includes(String(value.payload.format)) || value.payload.encoding !== 'base64') {
    return null;
  }
  const name = readString(value.rom, 'name');
  const slug = readString(value.rom, 'slug');
  const data = readString(value.payload, 'data');
  const sha256 = readString(value.payload, 'sha256');
  const bytes = readNumber(value.payload, 'bytes');
  if (!name || !slug || !data || !sha256 || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_SAVE_FILE_BYTES) {
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
      format: value.payload.format as SavePayload['payload']['format'],
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
  if (rom[0x147] === 0x05 || rom[0x147] === 0x06) return 512;
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
  if (button === 'start' && document.activeElement?.matches('.rom-reaction, .rom-download')) return;
  if (elements.saveDialog.open || !elements.romLoadingDialog.hidden || settingsDialog.open || requireElement<HTMLDialogElement>('#romVersionDialog').open) return;
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
    if (error instanceof DOMException && error.name === 'AbortError') {
      setStatus('idle', 'ROM loading cancelled');
      return;
    }
    setStatus('error', error instanceof Error ? error.message : 'Action failed');
  }
}

elements.screenToggle.addEventListener('click', () => {
  setScreenMaximized(elements.deviceFace.dataset.maximized !== 'true');
});
for (const type of ['keydown', 'keyup']) {
  elements.screenToggle.addEventListener(type, event => {
    const key = event as KeyboardEvent;
    if (KEY_TO_BUTTON.has(key.code)) {
      event.preventDefault();
      return; // Let the game keyboard handler receive Start and other controls.
    }
    if (key.code === 'Space' && elements.deviceFace.dataset.maximized === 'true') event.preventDefault();
    if (key.key !== 'Escape') event.stopPropagation();
  });
}

elements.pauseButton.addEventListener('click', () => {
  isPaused = !isPaused;
  if (isPaused) stopLoop();
  else if (isCoreLoaded) startLoop();
  elements.pauseButton.textContent = isPaused ? 'Play' : 'Pause';
});

elements.soundButton.addEventListener('click', () => {
  void handleAction(async () => {
    preferences.sound = !audio.enabled;
    const applying = audio.setEnabled(preferences.sound);
    void persistPreferences();
    await applying;
  });
});

elements.gamesButton.addEventListener('click', () => {
  setView(elements.deviceFace.dataset.view === 'games' ? 'game' : 'games');
  if (elements.deviceFace.dataset.view === 'games' && !libraryDiscoveryStarted) {
    void handleAction(async () => { await discoverRomEvents(preferences.romScope); });
  }
});

for (const button of elements.scopeButtons) {
  button.addEventListener('click', () => {
    const scope = button.dataset.romScope;
    if (!isRomScope(scope)) return;
    preferences.romScope = scope;
    void persistPreferences();
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

requireElement('#cancelRomVersion').addEventListener('click', () => requireElement<HTMLDialogElement>('#romVersionDialog').close());

const settingsDialog = requireElement<HTMLDialogElement>('#settingsDialog');
const settingsSound = requireElement<HTMLInputElement>('#settingsSound');
const settingsSize = requireElement<HTMLSelectElement>('#settingsSize');
const settingsScope = requireElement<HTMLSelectElement>('#settingsScope');
const settingsRestore = requireElement<HTMLInputElement>('#settingsRestore');
const settingsCache = requireElement<HTMLInputElement>('#settingsCache');
requireElement<HTMLButtonElement>('#settingsButton').addEventListener('click', () => {
  releaseButtonInputs('keyboard');
  settingsSound.checked = preferences.sound;
  settingsSize.value = preferences.cartridgeSize;
  settingsScope.value = preferences.romScope;
  settingsRestore.checked = preferences.loadLastRom;
  settingsCache.checked = preferences.cacheRoms;
  settingsCache.disabled = !hasDomain('fs');
  settingsCache.closest('label')!.hidden = !hasDomain('fs');
  requireElement('#settingsCacheHint').hidden = !hasDomain('fs');
  settingsDialog.showModal();
});
requireElement('#closeSettings').addEventListener('click', () => settingsDialog.close());
settingsSound.addEventListener('change', () => {
  preferences.sound = settingsSound.checked;
  void audio.setEnabled(preferences.sound);
  void persistPreferences();
});
settingsSize.addEventListener('change', () => {
  if (!isCartridgeSize(settingsSize.value)) return;
  preferences.cartridgeSize = settingsSize.value;
  applyCartridgeSize();
  void persistPreferences();
});
settingsScope.addEventListener('change', () => {
  if (!isRomScope(settingsScope.value)) return;
  preferences.romScope = settingsScope.value;
  void persistPreferences();
  void handleAction(async () => { await discoverRomEvents(preferences.romScope); });
});
settingsRestore.addEventListener('change', () => {
  preferences.loadLastRom = settingsRestore.checked;
  void persistPreferences();
});
settingsCache.addEventListener('change', () => {
  preferences.cacheRoms = settingsCache.checked;
  void persistPreferences();
});

elements.cartridgeSize.addEventListener('change', () => {
  if (!isCartridgeSize(elements.cartridgeSize.value)) return;
  preferences.cartridgeSize = elements.cartridgeSize.value;
  applyCartridgeSize();
  void persistPreferences();
});
for (const type of ['keydown', 'keyup']) elements.cartridgeSize.addEventListener(type, event => event.stopPropagation());

elements.cancelRomLoad.addEventListener('click', () => romLoadController?.abort());


elements.saveFileButton.addEventListener('click', openSaveDialog);

elements.saveButton.addEventListener('click', () => {
  void saveAction(elements.saveDestination.value === 'nostr' ? publishSave : saveToFilesystem);
});

elements.loadSaveButton.addEventListener('click', () => {
  void saveAction(loadOrBrowseSaves);
});

elements.saveDestination.addEventListener('change', () => {
  renderSaveDestination();
  if (browsingSaves) void saveAction(browseSaves);
});

elements.resumeNo.addEventListener('click', () => { dismissResumePrompt(); closeSaveDialog(); });
elements.resumeYes.addEventListener('click', () => {
  const load = resumeSave;
  if (!load) return;
  void saveAction(async () => {
    await load();
    dismissResumePrompt();
    closeSaveDialog();
  });
});
elements.resumeBrowse.addEventListener('click', () => {
  dismissResumePrompt();
  void saveAction(browseSaves);
});
elements.saveDialog.addEventListener('cancel', () => { if (resumeSave) dismissResumePrompt(); });

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
    if (!elements.romLoadingDialog.hidden && event.key === 'Escape') {
      event.preventDefault(); romLoadController?.abort(); return;
    }
    if (elements.saveDialog.open || !elements.romLoadingDialog.hidden || settingsDialog.open || requireElement<HTMLDialogElement>('#romVersionDialog').open) return;
    if (event.type === 'keydown' && event.key === 'Escape' && detailGroupId && elements.deviceFace.dataset.view === 'games' && !romLoadController) {
      event.preventDefault();
      closeRomDetail();
      return;
    }
    if (event.type === 'keydown' && event.key === 'Escape' && elements.deviceFace.dataset.maximized === 'true') {
      event.preventDefault();
      setScreenMaximized(false);
      elements.screenToggle.focus();
      return;
    }
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
    if (elements.saveDialog.open || !elements.romLoadingDialog.hidden || settingsDialog.open || requireElement<HTMLDialogElement>('#romVersionDialog').open) return;
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
    stopLoop();
    releaseButtonInputs('keyboard');
    releaseButtonInputs('pointer');
  } else if (isCoreLoaded && !isPaused) {
    startLoop();
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
  intentsClosed = true;
  intentSubscriptions.forEach(subscription => subscription.close());
  for (const observer of reactionObservers) observer.disconnect();
  reactionObservers.clear();
  stopLoop();
  releaseButtonInputs('keyboard');
  releaseButtonInputs('pointer');
  clearActionPulses();
  keyHandles.forEach((handle) => handle.close());
  keyHandles = [];
  themeSubscription?.close();
  audio.close();
});

registerRomIntent();
void handleAction(bootstrap).finally(() => { elements.soundButton.disabled = false; finishIntentStartup(); void registerKeyActions(); });
