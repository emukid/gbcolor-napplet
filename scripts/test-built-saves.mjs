import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

// Test the built artifact in the actual allow-scripts sandbox using the reference
// NAP shim and protocol messages. Native picker operations deliberately fail.
const html = await readFile('dist/index.html', 'utf8');
const prelude = await readFile('node_modules/@napplet/shim/dist/prelude.global.js', 'utf8');
const injection = `${prelude}\nNappletShimPrelude.install({domains:['fs']});`.replace(/<\/script/gi, '<\\/script');
const srcdoc = html.replace('<head>', `<head><script>${injection}</script>`);
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><body></body>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : undefined);
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 667 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('download', () => { throw new Error('Sandbox save must not download'); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(srcdoc => {
    window.calls = []; window.files = new Map(); window.directories = new Set(['/runtime-saves']);
    const frame = document.createElement('iframe');
    frame.sandbox = 'allow-scripts'; frame.style = 'width:100vw;height:100vh;border:0';
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow) return;
      const m = event.data;
      if (!m?.type?.startsWith('fs.')) return;
      window.calls.push(m);
      let result = { type: `${m.type}.result`, id: m.id };
      if (m.type === 'fs.info') result.info = {
        roots: [{ path: '/runtime-saves', name: 'Saves', permissions: ['read', 'write', 'create'] }],
        limits: { maxReadBytes: 65536, maxWriteBytes: 65536 },
      };
      else if (m.type === 'fs.list') {
        result.entries = [...window.files.keys(), ...window.directories].filter(path => path.slice(0, path.lastIndexOf('/')) === m.path)
          .map(path => ({ path, name: path.split('/').pop(), kind: window.directories.has(path) ? 'directory' : 'file' }));
      } else if (m.type === 'fs.mkdir') {
        if (window.directories.has(m.path)) result.error = 'already-exists';
        const parts = m.path.split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i++) window.directories.add('/' + parts.slice(0, i).join('/'));
      } else if (m.type === 'fs.stat') {
        const file = window.files.get(m.path);
        if (window.directories.has(m.path)) result.metadata = { path: m.path, kind: 'directory' };
        else if (!file) result.error = 'not-found';
        else result.metadata = { path: m.path, kind: 'file', size: file.length };
      }
      else if (m.type === 'fs.move') {
        if (!window.files.has(m.fromPath)) result.error = 'not-found';
        else { window.files.set(m.toPath, window.files.get(m.fromPath)); window.files.delete(m.fromPath); }
      }
      else if (m.type === 'fs.write') {
        const bytes = Uint8Array.from(atob(m.data), c => c.charCodeAt(0));
        if (bytes.length > 65536) throw new Error('Write exceeds advertised limit');
        const previous = m.options?.mode === 'replace' ? new Uint8Array() : window.files.get(m.path);
        const offset = m.options?.offset ?? 0;
        const output = new Uint8Array(Math.max(previous?.length ?? 0, offset + bytes.length));
        if (previous) output.set(previous);
        output.set(bytes, offset); window.files.set(m.path, output);
        result.result = { bytesWritten: bytes.length, size: output.length };
      } else if (m.type === 'fs.read') {
        const file = window.files.get(m.path);
        if (window.directories.has(m.path)) result.metadata = { path: m.path, kind: 'directory' };
        else if (!file) result.error = 'not-found';
        else {
          const offset = m.options?.offset ?? 0;
          const bytes = file.slice(offset, offset + Math.min(m.options?.length ?? 65536, 65536));
          result.result = { data: btoa(String.fromCharCode(...bytes)), offset, bytesRead: bytes.length, eof: offset + bytes.length >= file.length };
        }
      } else result.error = 'unsupported';
      event.source.postMessage(result, '*');
    });
    frame.srcdoc = srcdoc; document.body.style.margin = '0'; document.body.append(frame);
  }, srcdoc);
  const frame = page.frameLocator('iframe');
  await frame.locator('#saveFileButton').waitFor();
  assert.equal(await frame.locator('#saveFileButton').isDisabled(), true);
  const rom = new Uint8Array(32768);
  rom.set([0xc3, 0x50, 0x01], 0x100); rom[0x143] = 0xc0;
  rom.set([0x21, 0x00, 0xc0, 0x34, 0xc3, 0x53, 0x01], 0x150);
  await frame.locator('#romFileInput').setInputFiles({ name: 'no-ram.gbc', mimeType: 'application/octet-stream', buffer: Buffer.from(rom) });
  await frame.locator('#bootOverlay.is-loaded').waitFor({ state: 'attached' });
  assert.equal(await frame.locator('#saveFileButton').isDisabled(), false);
  await frame.locator('#pauseButton').click();
  assert.equal(await frame.locator('#saveFileButton').isDisabled(), true);
  await frame.locator('#pauseButton').click();
  await frame.locator('#saveFileButton').click();
  assert.equal(await frame.locator('#saveDestination').inputValue(), 'filesystem');
  assert.equal(await frame.locator('#filesystemSaves').isVisible(), false);
  await frame.locator('#loadSaveButton').click();
  await frame.locator('#filesystemSaves').filter({ hasText: 'No saves for this game yet' }).waitFor();
  await frame.locator('#saveButton').click();
  await frame.locator('#saveStatus').filter({ hasText: 'Saved to filesystem' }).waitFor();
  const firstPath = await frame.locator('#filesystemSaves li[data-path]').first().getAttribute('data-path');
  await frame.locator('#saveCloseButton').click();
  await frame.locator('#saveFileButton').click();
  await frame.locator('#loadSaveButton').click();
  await frame.locator('#saveDialog').waitFor({ state: 'hidden' });
  await frame.locator('#saveFileButton').click();
  await frame.locator('#saveButton').click();
  await frame.locator('#saveStatus').filter({ hasText: 'Saved to filesystem' }).waitFor();
  await frame.locator('#loadSaveButton').click();
  await frame.locator('#filesystemSaves li[data-path]').nth(1).waitFor();
  assert.equal(await frame.locator('#filesystemSaves li[data-path]').count(), 2);
  const first = frame.locator('#filesystemSaves li[data-path]').first();
  assert.equal(await first.locator('input').isVisible(), false);
  await first.locator('.save-rename').click();
  await first.locator('input').fill('Cancelled name');
  await first.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await first.locator('input').isVisible(), false);
  const beforeRename = await page.evaluate(path => Array.from(window.files.get(path)), firstPath);
  await first.locator('.save-rename').click();
  await first.locator('input').fill('Boss / checkpoint ✓');
  await first.locator('.save-rename-editor').getByRole('button', { name: 'Rename', exact: true }).click();
  await frame.locator('#saveStatus').filter({ hasText: 'Save renamed' }).waitFor();
  const renamed = frame.locator('#filesystemSaves li[data-path]').filter({ hasText: 'Boss / checkpoint ✓' });
  const renamedPath = await renamed.getAttribute('data-path');
  assert.notEqual(renamedPath, firstPath);
  assert.deepEqual(await page.evaluate(path => Array.from(window.files.get(path)), renamedPath), beforeRename);
  await renamed.locator('.save-load').click();
  await frame.locator('#saveDialog').waitFor({ state: 'hidden' });
  await frame.locator('#saveFileButton').click();
  assert.equal(await frame.locator('#filesystemSaves').isVisible(), false);
  await frame.locator('#loadSaveButton').click();
  await frame.locator('#saveButton:not([disabled])').waitFor();
  assert.equal(await frame.locator('#filesystemSaves li[data-path]').count(), 2);
  const evidence = await page.evaluate(() => ({ types: window.calls.map(m => m.type), paths: [...window.files.keys()] }));
  assert.equal(evidence.paths.length, 2);
  assert.ok(evidence.paths[0].startsWith('/runtime-saves/gbcolor/roms/'));
  assert.ok(evidence.types.includes('fs.info') && evidence.types.includes('fs.write') && evidence.types.includes('fs.read'));
  assert.ok(evidence.types.every(type => ['fs.info', 'fs.write', 'fs.read', 'fs.list', 'fs.move', 'fs.mkdir', 'fs.stat'].includes(type)));
  // Discover previous-version saves without including another game's files.
  const legacyPath = '/runtime-saves/' + renamedPath.split('/').pop().slice(0, 8 + 64) + '.gbcsave';
  await page.evaluate(({ legacyPath, renamedPath }) => {
    window.files.set(legacyPath, window.files.get(renamedPath));
    window.files.set('/runtime-saves/gbcolor-other-game.gbcsave', new Uint8Array());
  }, { legacyPath, renamedPath });
  await frame.locator('#saveCloseButton').click();
  await frame.locator('#saveFileButton').click();
  await frame.locator('#loadSaveButton').click();
  await frame.locator('#saveButton:not([disabled])').waitFor();
  assert.equal(await frame.locator('#filesystemSaves li[data-path]').count(), 3);
  await frame.locator('#filesystemSaves li').filter({ hasText: 'Original save' }).locator('.save-load').click();
  await frame.locator('#saveDialog').waitFor({ state: 'hidden' });
  await frame.locator('#gamesButton').click();
  await frame.locator('.game-card').first().hover();
  await frame.locator('.rom-download').first().click();
  await frame.locator('#statusMirror').filter({ hasText: 'saved — available in Mine' }).waitFor();
  const stored = await page.evaluate(() => [...window.files].filter(([path]) => path.endsWith('/rom.gbc')).map(([path, bytes]) => ({ path, bytes: Array.from(bytes) })));
  assert.equal(stored.length, 1);
  assert.match(stored[0].path, /^\/runtime-saves\/gbcolor\/roms\/[a-f0-9]{64}\/rom\.gbc$/);
  assert.deepEqual(stored[0].bytes, Array.from(rom));
  await frame.locator('[data-rom-scope="mine"]').click();
  await frame.locator('.game-primary[data-rom-id^="filesystem-"]').waitFor();
  assert.equal(await frame.locator('.game-card').count(), 1, 'Saved local ROM should appear once');
  await frame.locator('.game-primary[data-rom-id^="filesystem-"]').click();
  await frame.locator('#statusMirror').filter({ hasText: 'no ram' }).waitFor();
  // Recreate the iframe: filesystem catalog discovery must work without in-memory state.
  await page.evaluate(srcdoc => { document.querySelector('iframe').srcdoc = srcdoc; }, srcdoc);
  await frame.locator('#gamesButton').click();
  await frame.locator('[data-rom-scope="mine"]').click();
  await frame.locator('.game-primary[data-rom-id^="filesystem-"]').waitFor();
  assert.equal(await frame.locator('.game-card').count(), 1);
  await frame.locator('.game-primary[data-rom-id^="filesystem-"]').click();
  await frame.locator('#bootOverlay.is-loaded').waitFor({ state: 'attached' });
  assert.ok((await page.evaluate(() => window.calls)).some(call => call.type === 'fs.read' && call.path.endsWith('/rom.gbc')));
  await frame.locator('#settingsButton').click();
  await frame.locator('#settingsCache').check();
  await frame.locator('#closeSettings').click();
  const cachedRom = new Uint8Array(rom);
  cachedRom[0x134] = 65;
  await frame.locator('#romFileInput').setInputFiles({ name: 'cached.gbc', mimeType: 'application/octet-stream', buffer: Buffer.from(cachedRom) });
  await page.waitForFunction(() => [...window.files.keys()].filter(path => path.endsWith('/metadata.json')).length === 2);
  const cachedCopies = await page.evaluate(() => [...window.files].filter(([path]) => path.endsWith('/rom.gbc')).map(([, bytes]) => Array.from(bytes)));
  assert.ok(cachedCopies.some(bytes => bytes[0x134] === 65), 'Automatic cache must contain the newly loaded ROM bytes');
  assert.deepEqual(errors, []);
  console.log('Built sandbox NAP-FS round trip passed: reference shim, protocol envelopes, no native pickers/downloads, scoped save folders, legacy saves, ROM copy bytes, Mine discovery after reload, filesystem playback, rename, pause gating.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
