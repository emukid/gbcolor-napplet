import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the production declarations, replacing only browser/core boundaries.
const source = await readFile('src/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
function declarations(names) {
  const selected = ast.statements.filter((node) => names.includes(node.name?.text)
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => names.includes(d.name.getText(ast)))));
  assert.equal(selected.length, names.length, 'All production declarations must be found');
  return ts.transpileModule(selected.map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}
function listener(target, event) {
  const node = ast.statements.find((node) => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === `${target}.addEventListener`
    && node.expression.arguments[0]?.text === event);
  assert.ok(node, `${target} ${event} listener exists`);
  return ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
function loopHarness() {
  let nextId = 0, frames = 0, renders = 0, resets = 0;
  const callbacks = new Map();
  const handlers = {};
  const scope = {
    isPaused: false, isCoreLoaded: true, activeRom: {}, animationFrame: 0,
    runCoreFrame() { frames++; }, renderFrame() { renders++; },
    audio: { reset() { resets++; } },
    releaseButtonInputs() {},
    elements: { saveFileButton: {}, pauseButton: { addEventListener(event, fn) { handlers.pause = fn; } } },
    document: { hidden: false, addEventListener(event, fn) { handlers.visibility = fn; } },
    window: {
      requestAnimationFrame(fn) { callbacks.set(++nextId, fn); return nextId; },
      cancelAnimationFrame(id) { callbacks.delete(id); },
    },
  };
  vm.createContext(scope);
  vm.runInContext(declarations(['FRAME_DURATION_MS', 'MAX_CATCH_UP_FRAMES', 'startLoop', 'stopLoop', 'updateSaveAvailability'])
    + listener('elements.pauseButton', 'click') + listener('document', 'visibilitychange'), scope);
  return {
    scope, handlers, get frames() { return frames; }, get renders() { return renders; }, get resets() { return resets; },
    tick(time) { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach((fn) => fn(time)); },
  };
}
for (const hz of [30, 60, 90, 120, 144, 240]) {
  const h = loopHarness();
  h.scope.startLoop();
  for (let i = 0; i <= hz * 10; i++) h.tick(i * 1000 / hz);
  assert.equal(h.frames, 597, `${hz} Hz must emulate 597 frames in ten seconds`);
  assert.ok(h.renders <= hz * 10, 'Render at most once per display callback');
}
{
  const h = loopHarness();
  h.scope.startLoop(); h.tick(0); h.tick(20);
  assert.equal(h.frames, 1);
  h.handlers.pause();
  const resets = h.resets;
  h.tick(5000); assert.equal(h.frames, 1);
  h.handlers.pause(); h.tick(5010); h.tick(5030);
  assert.equal(h.frames, 2, 'Resume must not catch up paused time');
  assert.ok(h.resets > resets);
  h.scope.document.hidden = true; h.handlers.visibility();
  h.tick(10000); assert.equal(h.frames, 2);
  h.scope.document.hidden = false; h.handlers.visibility();
  h.tick(10010); h.tick(10030); assert.equal(h.frames, 3);
  h.tick(20000); assert.equal(h.frames, 3, 'Long stalls must not cause a catch-up burst');
  h.tick(20100); assert.equal(h.frames, 8, 'Catch-up is capped at five frames');
  h.scope.startLoop(); h.scope.startLoop();
  h.tick(30000); h.tick(30020); assert.equal(h.frames, 9, 'Restart leaves only one loop');
}
function audioHarness() {
  const sources = [];
  let cleared = 0;
  class Context {
    currentTime = 0;
    state = 'running';
    destination = {};
    createBuffer(channels, count, rate) {
      const data = [new Float32Array(count), new Float32Array(count)];
      return { duration: count / rate, getChannelData: (channel) => data[channel] };
    }
    createBufferSource() {
      const source = {
        stopped: false, disconnected: false,
        connect() {}, disconnect() { this.disconnected = true; },
        start(time) { this.startTime = time; }, stop() { this.stopped = true; },
      };
      sources.push(source); return source;
    }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  const scope = {
    AudioContext: Context,
    core: {
      AUDIO_BUFFER_LOCATION: 0,
      memory: { wasmByteMemory: new Uint8Array(1476).fill(129) },
      getNumberOfSamplesInAudioBuffer: () => 738,
      clearAudioBuffer() { cleared++; },
    },
    elements: { soundButton: { classList: { toggle() {} } } },
  };
  vm.createContext(scope);
  vm.runInContext(declarations(['AUDIO_CHUNK_SIZE', 'GbAudio', 'normalizeAudioByte'])
    + '\nglobalThis.audio = new GbAudio();', scope);
  return { audio: scope.audio, sources, scope, get cleared() { return cleared; } };
}
{
  const h = audioHarness(); await h.audio.setEnabled(true);
  for (let i = 0; i < 60; i++) {
    h.audio.context.currentTime = i * 70224 / 4194304;
    await h.audio.ensureContext(); // Button presses must not insert audio gaps.
    h.audio.pushFromCore();
  }
  assert.equal(h.sources.length, 60);
  for (let i = 1; i < h.sources.length; i++) {
    const previous = h.sources[i - 1];
    assert.ok(Math.abs(h.sources[i].startTime - previous.startTime - previous.buffer.duration) < 1e-9,
      'Normal audio buffers must be contiguous');
  }
  const ended = h.sources[0]; ended.onended();
  assert.ok(ended.disconnected, 'Ended buffers release their connection');
  assert.equal(h.audio.sources.size, 59);
  await h.audio.setEnabled(false);
  assert.ok(h.sources.slice(1).every((s) => s.stopped && s.disconnected), 'Mute cancels queued audio');
  assert.equal(h.audio.sources.size, 0);
  h.audio.pushFromCore(); assert.equal(h.sources.length, 60);
  await h.audio.setEnabled(true);
  h.audio.context.currentTime = 10; h.audio.pushFromCore();
  assert.equal(h.sources.at(-1).startTime, 10.05, 'Re-enable starts near the current clock');
  h.audio.reset(); assert.ok(h.sources.at(-1).stopped, 'Reset cancels the old ROM/pause queue');
  h.audio.context.state = 'suspended'; h.audio.pushFromCore();
  assert.equal(h.sources.length, 61, 'Suspended audio must not accumulate scheduled buffers');
  h.audio.close(); assert.equal(h.audio.context, null);
}
{
  const h = audioHarness(); await h.audio.setEnabled(true);
  // Deliberately overfeed to exercise queue recovery even after pacing is fixed.
  for (let i = 0; i < 120; i++) {
    h.audio.context.currentTime = i / 120;
    h.audio.pushFromCore();
    const active = h.sources.filter((s) => !s.stopped);
    for (let j = 1; j < active.length; j++) {
      assert.ok(active[j].startTime >= active[j - 1].startTime + active[j - 1].buffer.duration - 1e-9,
        'Queue recovery must never overlap uncancelled buffers');
    }
  }
  assert.ok(h.sources.some((s) => s.stopped), 'Overflow recovery was exercised');
  assert.ok(h.audio.nextStartTime - h.audio.context.currentTime < 0.32, 'Latency stays bounded');
}
// Run tiny, self-contained GBC programs through the actual installed emulator.
// The second switches KEY1 into GBC double-speed CPU mode; audio must stay 1x.
const coreSource = await readFile('node_modules/wasmboy/dist/core/core.esm.js', 'utf8');
const realCore = await import(`data:text/javascript;base64,${Buffer.from(coreSource).toString('base64')}`);
for (const doubleSpeed of [false, true]) {
  const sampleTotals = [];
  for (const hz of [60, 120, 144]) {
    realCore.memory.wasmByteMemory.fill(0);
    const rom = new Uint8Array(32768);
    rom.set([0xc3, 0x50, 0x01], 0x100); // JP $0150
    rom[0x143] = 0xc0; // GBC cartridge
    rom.set(doubleSpeed
      ? [0x3e, 0x01, 0xe0, 0x4d, 0x10, 0x00, 0xc3, 0x56, 0x01]
      : [0xc3, 0x50, 0x01], 0x150);
    realCore.memory.wasmByteMemory.set(rom, realCore.CARTRIDGE_ROM_LOCATION);
    realCore.config(0, 1, 0, 0, 0, 0, 0, 0, 0, 0);
    let samples = 0;
    const h = loopHarness();
    h.scope.core = realCore;
    h.scope.audio.pushFromCore = () => {
      samples += realCore.getNumberOfSamplesInAudioBuffer();
      realCore.clearAudioBuffer();
    };
    h.scope.setStatus = (kind, message) => { throw new Error(message); };
    vm.runInContext(declarations(['AUDIO_CHUNK_SIZE', 'runCoreFrame']), h.scope);
    h.scope.startLoop();
    for (let i = 0; i <= hz; i++) h.tick(i * 1000 / hz);
    assert.equal(h.scope.isPaused, false);
    assert.ok(samples > 43000 && samples < 44500, 'One second produces about 44.1k audio samples');
    assert.equal(realCore.getProgramCounter(), doubleSpeed ? 0x156 : 0x150);
    sampleTotals.push(samples);
  }
  assert.ok(sampleTotals.every((samples) => samples === sampleTotals[0]),
    'Actual GBC audio output is identical at 60, 120 and 144 Hz');
}
console.log('Playback regression tests passed: refresh rates, catch-up, pause/visibility/restart, audio continuity, mute/reset, overflow, actual GBC core at normal and double CPU speed.');
