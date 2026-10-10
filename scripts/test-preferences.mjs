import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile('src/main.ts', 'utf8');
const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const names = ['preferencesStorageKey', 'loadPreferences', 'persistPreferences', 'isRecord', 'isRomScope', 'isCartridgeSize', 'applyCartridgeSize'];
const code = ts.transpileModule(tree.statements.filter(n => names.includes(n.name?.text)).map(n => n.getText(tree)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const saved = new Map();
const applied = [];
let available = true;
const scope = {
  elements: { cartridgeSize: { value: '' }, gameGrid: { dataset: {} } },
  preferences: { sound: false }, preferenceWrites: Promise.resolve(), currentUserPubkey: 'alice',
  hasDomain: () => available, withTimeout: promise => promise, setStatus() {},
  storage: { getItem: async key => saved.get(key), setItem: async (key, value) => saved.set(key, value) },
  audio: { setEnabled: async (...args) => applied.push(args) },
};
vm.createContext(scope); vm.runInContext(code, scope);
await scope.loadPreferences();
assert.deepEqual(applied.at(-1), [false, false]);
assert.equal(scope.preferences.romScope, 'global');
assert.equal(scope.preferences.loadLastRom, true);
assert.equal(scope.preferences.cacheRoms, false);
scope.preferences.loadLastRom = false;
scope.preferences.cacheRoms = true;
scope.preferences.cartridgeSize = 'large';
scope.preferences.sound = true;
scope.preferences.romScope = 'network';
await scope.persistPreferences();
await scope.loadPreferences();
assert.equal(scope.preferences.romScope, 'network');
assert.equal(scope.elements.gameGrid.dataset.cartridgeSize, 'large');
assert.equal(scope.preferences.loadLastRom, false);
assert.equal(scope.preferences.cacheRoms, true);
assert.deepEqual(applied.at(-1), [true, false], 'Startup must not wait for audio activation');
scope.currentUserPubkey = 'bob';
await scope.loadPreferences();
assert.equal(scope.preferences.sound, false);
assert.equal(scope.preferences.cartridgeSize, 'medium');
scope.currentUserPubkey = 'alice';
saved.set(scope.preferencesStorageKey(), JSON.stringify({ sound: true, futureSetting: 42 }));
await scope.loadPreferences();
scope.preferences.sound = false;
await scope.persistPreferences();
assert.equal(JSON.parse(saved.get(scope.preferencesStorageKey())).futureSetting, 42);
scope.preferences.sound = true;
const first = scope.persistPreferences();
scope.preferences.sound = false;
await scope.persistPreferences();
await first;
assert.equal(JSON.parse(saved.get(scope.preferencesStorageKey())).sound, false);
for (const raw of ['{bad', '{"sound":"true"}', 'null']) {
  saved.set(scope.preferencesStorageKey(), raw);
  await scope.loadPreferences();
  assert.equal(scope.preferences.sound, false);
  assert.equal(scope.preferences.romScope, 'global');
}
for (const romScope of ['mine', 'network', 'global', 'invalid']) {
  saved.set(scope.preferencesStorageKey(), JSON.stringify({ sound: true, romScope }));
  await scope.loadPreferences();
  assert.equal(scope.preferences.romScope, romScope === 'invalid' ? 'global' : romScope);
}
for (const cartridgeSize of ['small', 'medium', 'large', 'invalid', 5, null]) {
  saved.set(scope.preferencesStorageKey(), JSON.stringify({ cartridgeSize }));
  await scope.loadPreferences();
  assert.equal(scope.elements.cartridgeSize.value, ['small', 'medium', 'large'].includes(cartridgeSize) ? cartridgeSize : 'medium');
}
available = false;
await scope.loadPreferences();
await scope.persistPreferences();
available = true;
scope.storage.getItem = scope.storage.setItem = async () => { throw new Error('unavailable'); };
await scope.loadPreferences();
await scope.persistPreferences();
console.log('Preferences passed: sound restore, per-user isolation, future settings, ordered writes, invalid/missing/unavailable storage, no startup audio permission wait.');
