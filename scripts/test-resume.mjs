import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile('src/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const names = ['lastGameStorageKey', 'rememberLastGame', 'restoreLastGame', 'isRecord'];
const code = ts.transpileModule(ast.statements.filter(n => names.includes(n.name?.text)).map(n => n.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const stored = new Map();
const rom = { id: 'event-first', sha256: 'a'.repeat(64), event: { id: 'first', pubkey: 'author' } };
let available = [rom];
let loaded;
let storageEnabled = true;
let lookup = [];
const scope = {
  romIntentVersion: 0, setStatus() {}, findCachedRom: async () => {}, isDiscoveringRoms: true,
  DOMException, currentUserPubkey: 'user-one', ROM_KIND: 32560, roms: new Map(), filesystemRoms: new Map(),
  hasDomain: () => storageEnabled,
  withTimeout: promise => promise,
  storage: { getItem: async key => stored.get(key) ?? null, setItem: async (key, value) => stored.set(key, value) },
  outbox: { query: async () => ({ events: lookup }) },
  parseRomResult: value => value,
  orderedRomEntries: () => available,
  loadRomFromEntry: async value => { loaded = value; },
};
vm.createContext(scope); vm.runInContext(code, scope);
await scope.rememberLastGame(rom);
assert.equal(await scope.restoreLastGame(), true);
assert.equal(loaded.event.id, 'first');
scope.currentUserPubkey = 'user-two';
assert.equal(await scope.restoreLastGame(), false, 'Users must have separate remembered games');
scope.currentUserPubkey = 'user-one';
available = [{ ...rom, sha256: undefined }];
assert.equal(await scope.restoreLastGame(), true, 'An event without hash metadata can be reopened');
assert.equal(loaded.sha256, rom.sha256, 'Remembered hash must verify bytes during loading');
available = []; lookup = [rom];
assert.equal(await scope.restoreLastGame(), true, 'Remembered author can be outside initial Mine results');
lookup = [];
assert.equal(await scope.restoreLastGame(), false, 'Missing ROM falls back');
stored.set(scope.lastGameStorageKey(), '{invalid');
assert.equal(await scope.restoreLastGame(), false);
storageEnabled = false;
assert.equal(await scope.restoreLastGame(), false);
storageEnabled = true;
scope.storage.getItem = async () => { throw new Error('unavailable'); };
scope.storage.setItem = async () => { throw new Error('unavailable'); };
assert.equal(await scope.restoreLastGame(), false);
await scope.rememberLastGame(rom);
console.log('Resume storage tests passed: per-user keys, rediscovery, missing hash metadata, unavailable ROM, malformed/missing/unavailable storage.');

const bootstrapCode = ts.transpileModule(ast.statements.find(n => n.name?.text === 'bootstrap').getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const order = [];
const startup = {
  romIntentReady: false, pendingRomIntent: null, romIntentVersion: 0,
  elements: { saveDestination: {} }, preferences: { romScope: 'global', loadLastRom: true },
  hasDomain: () => true, hasRequiredDomains: () => true, renderSaveDestination() {}, renderDomains() {}, renderRoms() {}, renderSaveList() {},
  configureTheme: async () => {}, registerKeyActions: async () => {}, identity: { getPublicKey: async () => 'user' }, withTimeout: value => value,
  loadPreferences: async () => {}, restoreLastGame: async () => { order.push('restore'); return true; },
  discoverRomEvents: async () => { order.push('discover'); return 1; }, offerLatestSave: async () => { order.push('offer-save'); },
  loadSelectedRom: async () => { order.push('load-default'); }, setView: view => order.push(view), setStatus() {},
};
vm.createContext(startup); vm.runInContext(bootstrapCode, startup);
await startup.bootstrap();
assert.deepEqual(order, ['restore', 'offer-save'], 'Restored game must not wait for library discovery');
order.length = 0;
startup.restoreLastGame = async () => { order.push('restore'); return false; };
await startup.bootstrap();
assert.deepEqual(order, ['restore', 'discover', 'load-default', 'offer-save']);
order.length = 0; startup.preferences.loadLastRom = false;
await startup.bootstrap();
assert.deepEqual(order, ['discover', 'games'], 'Disabled restore should go straight to the library');
console.log('Startup order passed: remembered game first, deferred library discovery, unavailable-game fallback, disabled restore.');
