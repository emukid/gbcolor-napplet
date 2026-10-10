import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { coreSnapshot } from '../build/core-snapshot.js';

const coreSource = await readFile('node_modules/wasmboy/dist/core/core.esm.js', 'utf8');
const transformed = coreSnapshot().transform(coreSource, '/node_modules/wasmboy/dist/core/core.esm.js');
const core = await import(`data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`);
const source = await readFile('src/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const names = ['MAX_SAVE_FILE_BYTES', 'createSavePayload', 'applySaveContent', 'decodeSnapshot',
  'parseSavePayload', 'encodeBytes', 'readCoreMemory', 'sha256Hex', 'bytesToBase64', 'base64ToBytes',
  'isRecord', 'readString', 'readNumber', 'getCartridgeRamSize'];
const selected = ast.statements.filter(n => names.includes(n.name?.text)
  || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast)))));
assert.equal(selected.length, names.length);
const code = ts.transpileModule(selected.map(n => n.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const scope = {
  core, crypto, Blob, Response, CompressionStream, DecompressionStream, TextEncoder, TextDecoder,
  Uint8Array, ArrayBuffer, btoa, atob, isCoreLoaded: true, isPaused: false, activeCartRamSize: 0,
  audio: { reset() { core.clearAudioBuffer(); } }, stopLoop() {}, startLoop() {},
  updateJoypadState() {}, renderFrame() {}, setStatus() {}, elements: { pauseButton: {} },
};
vm.createContext(scope); vm.runInContext(code, scope);
function runFrames(count) {
  for (let i = 0; i < count; i++) {
    assert.equal(core.executeFrameAndCheckAudio(2048), 0);
    core.clearAudioBuffer();
  }
}
for (const mode of ['dmg', 'gbc', 'gbc-double']) {
  const gbc = mode !== 'dmg';
  const rom = new Uint8Array(32768);
  rom.set([0xc3, 0x50, 0x01], 0x100);
  rom[0x143] = gbc ? 0xc0 : 0;
  const program = [];
  const ldh = (address, value) => program.push(0x3e, value, 0xe0, address);
  if (mode === 'gbc-double') { ldh(0x4d, 1); program.push(0x10, 0); }
  ldh(0x26, 0x80); ldh(0x24, 0x77); ldh(0x25, 0xff);
  ldh(0x11, 0x80); ldh(0x12, 0xf3); ldh(0x13, 0); ldh(0x14, 0x87);
  ldh(0x47, 0xe4); ldh(0x40, 0x91);
  if (gbc) { ldh(0x68, 0x80); for (const value of [0xff, 0x7f, 0, 0, 0, 0, 0, 0]) ldh(0x69, value); }
  program.push(0x21, 0x00, 0xc0);
  const loop = 0x150 + program.length;
  program.push(0x34, 0xc3, loop & 255, loop >> 8);
  rom.set(program, 0x150);
  scope.activeRomBytes = rom;
  scope.activeRom = { name: 'No-RAM test', slug: 'test', sha256: await scope.sha256Hex(rom) };
  scope.initializeCore = () => {
    core.memory.wasmByteMemory.fill(0);
    core.memory.wasmByteMemory.set(rom, core.CARTRIDGE_ROM_LOCATION);
    core.config(0, 1, 0, 0, 0, 0, 0, 0, 0, 0);
  };
  scope.initializeCore();
  // Tile 0 has a visible alternating pattern, exercising frame restoration too.
  core.memory.wasmByteMemory.fill(0xaa, core.VIDEO_RAM_LOCATION, core.VIDEO_RAM_LOCATION + 16);
  runFrames(7);
  assert.ok(new Set(core.memory.wasmByteMemory.slice(core.FRAME_LOCATION, core.FRAME_LOCATION + core.FRAME_SIZE)).size > 1,
    'The test must produce nonblank graphics: ' + mode);
  assert.ok(new Set(core.memory.wasmByteMemory.slice(core.AUDIO_BUFFER_LOCATION, core.AUDIO_BUFFER_LOCATION + 1400)).size > 1,
    'The test must produce nonsilent audio');
  const savedPC = core.getProgramCounter();
  const payload = await scope.createSavePayload();
  assert.equal(payload.payload.format, 'snapshot-v1');
  assert.ok(payload.payload.bytes > 0);
  runFrames(11);
  const expected = core.memory.wasmByteMemory.slice(0, core.CARTRIDGE_ROM_LOCATION);
  const expectedRegisters = JSON.stringify(core.captureSnapshotRegisters());
  scope.initializeCore(); runFrames(3);
  await scope.applySaveContent(JSON.stringify(payload));
  assert.equal(core.getProgramCounter(), savedPC, 'Restore full 16-bit PC');
  runFrames(11);
  assert.deepEqual(core.memory.wasmByteMemory.slice(0, core.CARTRIDGE_ROM_LOCATION), expected,
    'Restored execution must produce identical memory, video and audio output');
  assert.equal(JSON.stringify(core.captureSnapshotRegisters()), expectedRegisters,
    'Restored execution must produce identical registers and timers');
  const before = core.memory.wasmByteMemory.slice();
  await assert.rejects(scope.applySaveContent(JSON.stringify({ ...payload, rom: { ...payload.rom, sha256: 'wrong' } })), /ROM/);
  await assert.rejects(scope.applySaveContent(JSON.stringify({ ...payload, payload: { ...payload.payload, sha256: 'wrong' } })), /hash/);
  await assert.rejects(scope.applySaveContent('not json'), /invalid/);
  assert.deepEqual(core.memory.wasmByteMemory, before, 'Rejected saves cannot alter the running game');
  const invalid = core.captureSnapshotRegisters();
  invalid.Cpu.programCounter = 'bad';
  assert.throws(() => core.validateSnapshotRegisters(invalid), /register/);
  // Old cartridge RAM saves remain loadable.
  scope.activeCartRamSize = 8192;
  const old = { ...payload, payload: { format: 'cartridge-ram', ...await scope.encodeBytes(new Uint8Array(8192).fill(42)) } };
  await scope.applySaveContent(JSON.stringify(old));
  assert.equal(core.memory.wasmByteMemory[core.CARTRIDGE_RAM_LOCATION], 42);
}
const mbc2 = new Uint8Array(32768); mbc2[0x147] = 6;
assert.equal(scope.getCartridgeRamSize(mbc2), 512);
console.log('Save state tests passed: no-RAM GB/GBC, exact continuation, corruption/ROM rejection, legacy RAM saves, MBC2.');
