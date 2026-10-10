import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { decode, naddrEncode, npubEncode } from 'nostr-tools/nip19';
const source = await readFile('src/rom-intent.ts', 'utf8');
const compiled = ts.transpileModule(source.replace(/^import .*;\n/m, '').replace(/export /g, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const scope = { decode }; vm.createContext(scope); vm.runInContext(compiled, scope);
const pointer = { kind: 32560, pubkey: 'f'.repeat(64), identifier: 'rom-one', relays: ['wss://example.com'] };
assert.deepEqual(JSON.parse(JSON.stringify(scope.parseRomIntent({ naddr: naddrEncode(pointer) }))), pointer);
for (const payload of [undefined, {}, { naddr: 1 }, { naddr: 'naddr1bad' }, { naddr: npubEncode(pointer.pubkey) }, { naddr: naddrEncode({ ...pointer, kind: 30078 }) }, { naddr: naddrEncode({ ...pointer, identifier: '' }) }]) {
  assert.throws(() => scope.parseRomIntent(payload));
}
const config = JSON.parse(await readFile('.napplet/config.json', 'utf8'));
assert.ok(config.metadata.archetypes.includes('napplet:gameboy/load'));
assert.ok(!config.metadata.archetypes.some(value => value.includes('?')));
console.log('ROM intent validation passed: naddr decoding, ROM kind, malformed payloads, queryless manifest registration.');

for (const enabled of [true, false, 'true', 'false']) {
  assert.equal(scope.parseGameboyCommand('sound', { enabled }).enabled, enabled === true || enabled === 'true');
}
assert.equal(scope.parseGameboyCommand('maximize', {}).enabled, true);
for (const library of ['mine', 'network', 'global']) assert.equal(scope.parseGameboyCommand('browse', { scope: library }).scope, library);
for (const [action, payload] of [['sound', {}], ['sound', { enabled: 1 }], ['maximize', { enabled: 'yes' }], ['browse', { scope: 'bad' }], ['pause', { naddr: 'ignored' }], ['open', []]]) {
  assert.throws(() => scope.parseGameboyCommand(action, payload));
}
for (const action of ['open', 'settings', 'pause', 'resume']) assert.equal(scope.parseGameboyCommand(action, undefined).action, action);
console.log('Gameboy command payloads passed: query-string booleans, library scope, strict options, command defaults.');
