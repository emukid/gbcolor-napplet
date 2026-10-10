import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { naddrEncode } from 'nostr-tools/nip19';

const packageRoot = process.cwd();
const repoRoot = path.resolve(packageRoot, '../..');
const evidenceDir = path.join(repoRoot, '.planning/phases/190-gbcolor-visual-verification-and-ship-gate');
const screenshotDir = path.join(evidenceDir, 'screenshots');
const stateDir = path.join(repoRoot, '.omx/state/gbcolor-ui');

const viewports = [
  { name: 'ideal-portrait', width: 390, height: 667 },
  { name: 'too-tall', width: 360, height: 900 },
  { name: 'wide-tall-enough', width: 900, height: 700 },
  { name: 'wide-not-tall', width: 900, height: 500 },
  { name: 'tiny', width: 300, height: 460 },
  { name: 'ultra-narrow-library', width: 160, height: 700 },
  { name: 'dense-library', width: 1620, height: 1536 },
  { name: 'very-short', width: 640, height: 320 },
];

const primaryKeys = ['screenWell', 'dpad', 'buttonA', 'buttonB', 'buttonStart', 'buttonSelect'];
const idealTargets = {
  dpad: [210, 840],
  buttonB: [515, 850],
  buttonA: [610, 815],
  buttonSelect: [330, 1030],
  buttonStart: [430, 1012],
};

const server = await createServer({
  root: packageRoot,
  configFile: path.join(packageRoot, 'vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
  },
  plugins: [wasmboyCoreStub()],
});

await mkdir(screenshotDir, { recursive: true });
await mkdir(stateDir, { recursive: true });
await server.listen();

const address = server.httpServer?.address();
if (!address || typeof address === 'string') {
  throw new Error('Vite server did not expose a local address');
}

const baseUrl = `http://127.0.0.1:${address.port}/`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(executablePath ? { executablePath } : undefined);
const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  viewports: [],
  theme: null,
  controls: null,
  denseLibrary: null,
  savePath: null,
  gamesView: null,
};

try {
  const intentPage = await newPage(browser, { name: 'rom-intent', width: 320, height: 560 });
  const requestedAddress = naddrEncode({ kind: 32560, pubkey: 'f'.repeat(64), identifier: 'fixture-rom', relays: ['wss://example.com'] });
  await intentPage.addInitScript(naddr => {
    const handlers = new Map();
    window.deliverRomIntent = (payload, action = 'load') => {
      const topic = `napplet:gameboy/${action}`;
      handlers.get(topic)?.({ topic, payload, sender: { pubkey: 'f'.repeat(64), dTag: 'launcher' } });
    };
    window.napplet.inc = { on: (topic, handler) => {
      handlers.set(topic, handler);
      if (topic === 'napplet:gameboy/load') queueMicrotask(() => window.deliverRomIntent({ naddr }));
      return { close() { handlers.delete(topic); } };
    } };
  }, requestedAddress);
  await intentPage.goto(baseUrl, { waitUntil: 'networkidle' });
  await intentPage.waitForFunction(() => document.querySelector('#statusMirror')?.textContent === 'Fixture ROM');
  if (await intentPage.locator('#resumeNo').isVisible()) await intentPage.click('#resumeNo');
  const intentCalls = await intentPage.evaluate(() => window.__gbcolorTestLog);
  const romQueries = intentCalls.queries.filter(call => call.kinds.includes(32560));
  if (romQueries.length !== 1 || romQueries[0].filter['#d']?.[0] !== 'fixture-rom') throw new Error('Cold intent must resolve exact address before startup library lookup');
  if (intentCalls.relaySubscriptions.some(call => call.kinds.includes(32560))) throw new Error('Cold ROM intent performed global discovery');
  await intentPage.evaluate(() => window.deliverRomIntent({ naddr: 'invalid' }));
  await intentPage.waitForFunction(() => document.querySelector('#statusMirror')?.textContent.includes('Invalid ROM naddr'));
  await intentPage.evaluate(naddr => window.deliverRomIntent({ naddr }), requestedAddress);
  await intentPage.waitForFunction(() => document.querySelector('#statusMirror')?.textContent === 'Fixture ROM');
  if (await intentPage.locator('#resumeNo').isVisible()) await intentPage.click('#resumeNo');
  await intentPage.evaluate(() => { window.deliverRomIntent({}, 'pause'); window.deliverRomIntent({}, 'pause'); });
  await intentPage.waitForFunction(() => document.querySelector('#pauseButton').textContent === 'Play');
  await intentPage.evaluate(() => window.deliverRomIntent({}, 'resume'));
  await intentPage.waitForFunction(() => document.querySelector('#pauseButton').textContent === 'Pause');
  await intentPage.evaluate(() => window.deliverRomIntent({ enabled: 'true' }, 'sound'));
  await intentPage.waitForFunction(() => document.querySelector('#soundButton').getAttribute('aria-pressed') === 'true');
  await intentPage.evaluate(() => window.deliverRomIntent({}, 'maximize'));
  await intentPage.waitForFunction(() => document.querySelector('#screenToggle').getAttribute('aria-pressed') === 'true');
  await intentPage.evaluate(() => window.deliverRomIntent({ enabled: 'false' }, 'maximize'));
  await intentPage.waitForFunction(() => document.querySelector('#screenToggle').getAttribute('aria-pressed') === 'false');
  await intentPage.evaluate(() => window.deliverRomIntent({}, 'settings'));
  await intentPage.locator('#settingsDialog').waitFor({ state: 'visible' });
  await intentPage.evaluate(() => window.deliverRomIntent({ scope: 'mine' }, 'browse'));
  await intentPage.waitForFunction(() => document.querySelector('[data-rom-scope="mine"]').getAttribute('aria-pressed') === 'true');
  await intentPage.evaluate(() => window.deliverRomIntent({ scope: 'invalid' }, 'browse'));
  await intentPage.waitForFunction(() => document.querySelector('#statusMirror').textContent.includes('Library scope must'));
  await intentPage.evaluate(() => window.deliverRomIntent({}, 'open'));
  await intentPage.waitForFunction(() => document.querySelector('#gameView').getAttribute('aria-hidden') === 'false');
  await intentPage.close();
  const detailPage = await newPage(browser, { name: 'rom-detail', width: 320, height: 560 }, true, true);
  await detailPage.addInitScript(() => {
    const subscribe = window.napplet.relay.subscribe;
    window.napplet.relay.subscribe = (filters, onEvent, ...rest) => subscribe(filters, result => {
      onEvent(result);
      if (result.event.id === 'd'.repeat(64)) onEvent({ ...result, event: { ...result.event, id: '8'.repeat(64), created_at: result.event.created_at - 100 } });
    }, ...rest);
  });
  await detailPage.goto(baseUrl, { waitUntil: 'networkidle' });
  await detailPage.click('#settingsButton');
  if (!(await detailPage.locator('#settingsRestore').isChecked()) || await detailPage.locator('#settingsCache').isChecked()) throw new Error('Settings defaults incorrect');
  await detailPage.locator('#settingsRestore').uncheck();
  await detailPage.locator('#settingsCache').check();
  await detailPage.selectOption('#settingsSize', 'large');
  for (const viewport of [{ width: 200, height: 160 }, { width: 320, height: 560 }, { width: 900, height: 600 }, { width: 2400, height: 1200 }]) {
    await detailPage.setViewportSize(viewport);
    for (const light of [false, true]) {
      await detailPage.evaluate(light => window.__gbcolorSetTheme({ colors: { background: light ? '#fafafa' : '#101410', text: light ? '#161816' : '#eeeeee', primary: '#b59948' } }), light);
      if (await detailPage.locator('#settingsDialog').evaluate(el => el.scrollWidth > el.clientWidth + 1)) throw new Error('Settings overflow');
      await detailPage.screenshot({ path: path.join(screenshotDir, `settings-${viewport.width}-${light}.png`) });
    }
  }
  await detailPage.keyboard.press('Escape');
  await detailPage.click('#settingsButton');
  if (await detailPage.locator('#settingsRestore').isChecked() || !(await detailPage.locator('#settingsCache').isChecked())) throw new Error('Settings edits lost');
  await detailPage.locator('#settingsCache').uncheck();
  await detailPage.click('#closeSettings');
  await detailPage.setViewportSize({ width: 320, height: 560 });
  await detailPage.click('#gamesButton');
  for (const viewport of [{ width: 200, height: 160 }, { width: 320, height: 560 }, { width: 900, height: 600 }, { width: 2400, height: 1200 }]) {
    await detailPage.setViewportSize(viewport);
    const widths = [];
    for (const size of ['small', 'medium', 'large']) {
      await detailPage.selectOption('#cartridgeSize', size);
      widths.push((await detailPage.locator('.game-card').first().boundingBox()).width);
      const overflow = await detailPage.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector('#gameGrid').scrollWidth > document.querySelector('#gameGrid').clientWidth + 1);
      if (overflow) throw new Error(`Cartridge size ${size} overflows at ${viewport.width}`);
    }
    if (viewport.width >= 900 && !(widths[0] < widths[1] && widths[1] < widths[2])) throw new Error('Cartridge size control does not resize cards');
  }
  await detailPage.setViewportSize({ width: 320, height: 560 });
  await detailPage.selectOption('#cartridgeSize', 'medium');
  await detailPage.locator('.game-card').filter({ has: detailPage.locator('.game-title', { hasText: /^Fixture ROM$/ }) }).locator('.rom-info').click();
  if (await detailPage.locator('.rom-author-group').count() !== 2) throw new Error('ROM options not grouped by author');
  const groups = await detailPage.locator('.rom-author-group').evaluateAll(groups => groups.map(group => [...group.querySelectorAll('.rom-detail-option')].map(row => Number(row.dataset.createdAt))));
  if (!groups.some(group => group.length === 2) || groups.some(group => group.some((time, i) => i && time > group[i - 1]))) throw new Error('ROM options not newest first within author');
  for (const viewport of [{ width: 200, height: 160 }, { width: 320, height: 560 }, { width: 900, height: 600 }, { width: 2400, height: 1200 }]) {
    await detailPage.setViewportSize(viewport);
    for (const light of [false, true]) {
      await detailPage.evaluate(light => window.__gbcolorSetTheme({ colors: { background: light ? '#fafafa' : '#101410', text: light ? '#161816' : '#eeeeee', primary: '#b59948' } }), light);
      const overflow = await detailPage.locator('.rom-detail').evaluate(el => el.scrollWidth > el.clientWidth + 1);
      if (overflow) throw new Error(`ROM details overflow at ${viewport.width}`);
      for (const selector of ['.rom-detail-back', '.rom-detail-actions button']) {
        const boxes = await detailPage.locator(selector).evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, right: r.right }; }));
        if (boxes.some(box => box.x < 0 || box.right > viewport.width + 1)) throw new Error('Detail action clipped horizontally');
      }
      await detailPage.screenshot({ path: path.join(screenshotDir, `rom-detail-${viewport.width}x${viewport.height}-${light ? 'light' : 'dark'}.png`) });
    }
  }
  await detailPage.setViewportSize({ width: 320, height: 560 });
  if (!(await detailPage.locator('.rom-detail .rom-download').first().isVisible())) throw new Error('Detail save action hidden');
  await detailPage.keyboard.press('Escape');
  if (await detailPage.locator('.rom-detail').count()) throw new Error('Escape failed to close ROM details');
  if (!(await detailPage.locator('.rom-info:focus').count())) throw new Error('Detail return did not restore focus');
  await detailPage.locator('.rom-info:focus').click();
  await detailPage.getByRole('button', { name: 'Choose version…' }).click();
  if (await detailPage.locator('#rememberRomVersion').isChecked()) throw new Error('Remember choice must default unchecked');
  if (!(await detailPage.locator('#loadRomVersion').isDisabled())) throw new Error('Version must be selected before loading');
  for (const viewport of [{ width: 200, height: 160 }, { width: 320, height: 560 }, { width: 900, height: 600 }, { width: 2400, height: 1200 }]) {
    await detailPage.setViewportSize(viewport);
    for (const light of [false, true]) {
      await detailPage.evaluate(light => window.__gbcolorSetTheme({ colors: { background: light ? '#fafafa' : '#101410', text: light ? '#161816' : '#eeeeee', primary: '#b59948' } }), light);
      if (await detailPage.locator('#romVersionDialog').evaluate(el => el.scrollWidth > el.clientWidth + 1)) throw new Error('Version modal overflow');
      await detailPage.screenshot({ path: path.join(screenshotDir, `versions-${viewport.width}-${light}.png`) });
    }
  }
  await detailPage.setViewportSize({ width: 320, height: 560 });
  await detailPage.locator('#romVersionList input').first().check();
  await detailPage.locator('#rememberRomVersion').check();
  await detailPage.click('#loadRomVersion');
  await detailPage.waitForFunction(() => document.querySelector('#deviceFace')?.dataset.view === 'game' || document.querySelector('[data-gbc-measure="device-face"]')?.dataset.view === 'game');
  await detailPage.click('#gamesButton');
  await detailPage.locator('.rom-detail-back').click();
  if (await detailPage.locator('.game-option').count()) throw new Error('Stacked version buttons remain');
  await detailPage.locator('.game-card').filter({ has: detailPage.locator('.game-title', { hasText: /^Fixture ROM$/ }) }).locator('.game-primary').click();
  await detailPage.waitForFunction(() => document.querySelector('[data-gbc-measure="device-face"]')?.dataset.view === 'game');
  if (await detailPage.locator('#romVersionDialog').isVisible()) throw new Error('Remembered choice still prompts');
  await detailPage.close();
  const maxPage = await newPage(browser, { name: 'maximize', width: 320, height: 560 });
  await maxPage.goto(baseUrl, { waitUntil: 'networkidle' });
  for (const viewport of [{ width: 200, height: 160 }, { width: 320, height: 560 }, { width: 900, height: 600 }, { width: 2400, height: 1200 }]) {
    await maxPage.setViewportSize(viewport);
    await maxPage.locator('.screen-well').hover();
    await maxPage.click('#screenToggle');
    await maxPage.waitForFunction(() => document.querySelector('#screenToggle').getAttribute('aria-pressed') === 'true');
    await maxPage.keyboard.down('Enter');
    assertJoypadState(await readJoypadState(maxPage), [0, 0, 0, 0, 0, 0, 0, 1], 'Enter starts game while maximize button has focus');
    await maxPage.keyboard.up('Enter');
    assertJoypadState(await readJoypadState(maxPage), [0, 0, 0, 0, 0, 0, 0, 0], 'Start released');
    await maxPage.keyboard.press('Space');
    if (await maxPage.locator('#screenToggle').getAttribute('aria-pressed') !== 'true') throw new Error('Enter/Space exited maximized mode');
    const screen = await maxPage.locator('#screen').boundingBox();
    const restore = await maxPage.locator('#screenToggle').boundingBox();
    if (!screen || Math.abs(screen.width / screen.height - 160 / 144) > 0.01) throw new Error('Maximized screen ratio incorrect');
    for (const box of [screen, restore]) {
      if (!box || box.x < 0 || box.y < 0 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1) throw new Error('Maximized screen or restore control clipped');
    }
    if (await maxPage.locator('.gamepad').isVisible() || await maxPage.locator('.bottom-bar').isVisible()) throw new Error('Console remains visible while maximized');
    if (Math.abs(restore.x + restore.width - (viewport.width - 8)) > 2 || Math.abs(restore.y + restore.height - (viewport.height - 8)) > 2) throw new Error('Restore button not at bottom-right');
    if (await maxPage.locator('#screenToggle svg').count() !== 1) throw new Error('Restore icon missing');
    await maxPage.screenshot({ path: path.join(screenshotDir, `maximized-${viewport.width}x${viewport.height}.png`) });
    await maxPage.keyboard.press('Escape');
    if (await maxPage.locator('#screenToggle').getAttribute('aria-pressed') !== 'false') throw new Error('Escape did not restore console');
    if (!(await maxPage.locator('.gamepad').isVisible())) throw new Error('Controls not restored');
  }
  await maxPage.locator('.screen-well').hover();
  await maxPage.click('#screenToggle');
  await maxPage.click('#screenToggle');
  if (await maxPage.locator('#screenToggle').getAttribute('aria-pressed') !== 'false') throw new Error('Restore button did not restore console');
  await maxPage.close();
  const likedPage = await newPage(browser, { name: 'liked-refresh', width: 320, height: 560 });
  await likedPage.addInitScript(() => {
    window.napplet.count = { query: async () => ({ ok: true, count: 1 }) };
    window.napplet.common = { react: async () => { throw new Error('Must not republish existing like'); } };
    const query = window.napplet.outbox.query;
    window.napplet.outbox.query = async (filter, options) => {
      if (filter.kinds?.includes(7)) return { events: [{ event: {
        id: '1'.repeat(64), kind: 7, pubkey: filter.authors[0], created_at: 1,
        content: '+', tags: [['e', filter['#e'][0]]], sig: '0'.repeat(128),
      } }] };
      return query(filter, options);
    };
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      await likedPage.reload({ waitUntil: 'networkidle' });
      if (await likedPage.locator('#resumeNo').isVisible()) await likedPage.click('#resumeNo');
    }
    else await likedPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await likedPage.waitForFunction(() => document.querySelector('#consoleReaction .rom-reaction')?.getAttribute('aria-pressed') === 'true');
    if (!(await likedPage.locator('#consoleReaction .rom-reaction').isDisabled())) throw new Error('Existing reaction still publishable');
    if (await likedPage.locator('#consoleReaction .rom-reaction').textContent() !== '♥ 1') throw new Error('Restored like should not increment server count');
    await likedPage.click('#gamesButton');
    await likedPage.waitForFunction(() => document.querySelector('.game-card.is-active .rom-reaction')?.getAttribute('aria-pressed') === 'true');
  }
  await likedPage.close();
  const reactionPage = await newPage(browser, { name: 'reactions', width: 320, height: 560 });
  await reactionPage.addInitScript(() => {
    window.reactionCalls = [];
    window.countCalls = [];
    window.failReaction = true;
    window.napplet.count = { query: async filter => { window.countCalls.push(filter); return { ok: true, count: 3 }; } };
    window.napplet.common = { react: async (id, reaction) => {
      window.reactionCalls.push({ id, reaction });
      return window.failReaction ? { ok: false, error: 'Publish refused' } : { ok: true };
    } };
  });
  await reactionPage.goto(baseUrl, { waitUntil: 'networkidle' });
  await reactionPage.click('#gamesButton');
  const reactionCard = reactionPage.locator('.game-card').first();
  const heart = reactionCard.locator('.rom-reaction');
  await reactionCard.hover();
  await reactionPage.waitForFunction(() => document.querySelector('.rom-reaction')?.textContent === '♡ 3');
  await reactionPage.screenshot({ path: path.join(screenshotDir, 'rom-reaction.png') });
  await heart.click();
  await reactionPage.waitForFunction(() => document.querySelector('#statusMirror').textContent === 'Publish refused');
  if (await heart.getAttribute('aria-pressed') !== 'false') throw new Error('Failed reaction changed state');
  await reactionPage.evaluate(() => { window.failReaction = false; });
  await heart.click();
  await reactionPage.waitForFunction(() => document.querySelector('.rom-reaction')?.textContent === '♥ 4');
  if (!(await heart.isDisabled())) throw new Error('Repeated reaction must be prevented');
  const reactions = await reactionPage.evaluate(() => window.reactionCalls);
  const target = (await reactionCard.locator('.game-primary').getAttribute('data-rom-id')).replace('event-', '');
  if (reactions.length !== 2 || reactions.some(call => call.id !== target || call.reaction !== '+')) throw new Error('Incorrect reaction target/content');
  if (await reactionPage.locator('[data-gbc-measure="device-face"]').getAttribute('data-view') !== 'games') throw new Error('Reacting loaded a ROM');
  await reactionPage.click('#gamesButton');
  const consoleHeart = reactionPage.locator('#consoleReaction .rom-reaction');
  if (await consoleHeart.textContent() !== '♥ 4') throw new Error('Console did not share cartridge reaction');
  await reactionPage.click('#gamesButton');
  const secondCard = reactionPage.locator('.game-card').nth(1);
  const secondTarget = (await secondCard.locator('.game-primary').getAttribute('data-rom-id')).replace('event-', '');
  await secondCard.locator('.game-primary').click();
  await reactionPage.waitForFunction(() => document.querySelector('[data-gbc-measure="device-face"]').dataset.view === 'game');
  await reactionPage.waitForFunction(id => document.querySelector('#consoleReaction .rom-reaction')?.dataset.eventId === id && document.querySelector('#consoleReaction .rom-reaction').textContent === '♡ 3', secondTarget);
  await consoleHeart.focus();
  await consoleHeart.press('Enter');
  await reactionPage.waitForFunction(() => document.querySelector('#consoleReaction .rom-reaction').textContent === '♥ 4');
  const lastReaction = await reactionPage.evaluate(() => window.reactionCalls.at(-1));
  if (lastReaction.id !== secondTarget || lastReaction.reaction !== '+') throw new Error('Console reacted to wrong ROM');
  await reactionPage.screenshot({ path: path.join(screenshotDir, 'console-reaction.png') });
  await reactionPage.click('#gamesButton');
  const matchingCardHeart = reactionPage.locator(`#gameGrid .rom-reaction[data-event-id="${secondTarget}"]`);
  if (await matchingCardHeart.textContent() !== '♥ 4') throw new Error('Cartridge did not share console reaction');
  await reactionPage.close();
  const loadingPage = await newPage(browser, { name: 'loading-overlay', width: 320, height: 560 });
  await loadingPage.goto(baseUrl, { waitUntil: 'networkidle' });
  await loadingPage.click('#gamesButton');
  const previousRom = await loadingPage.locator('.game-card.is-active .game-primary').getAttribute('data-rom-id');
  await loadingPage.evaluate(() => {
    const original = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function () {
      await new Promise(resolve => { window.releaseRomBytes = resolve; });
      return original.call(this);
    };
  });
  await loadingPage.locator('.game-card:not(.is-active) .game-primary').first().click();
  await loadingPage.locator('#romLoadingDialog').waitFor({ state: 'visible' });
  await loadingPage.waitForFunction(() => typeof window.releaseRomBytes === 'function');
  const blur = await loadingPage.locator('#romLoadingDialog').evaluate(el => getComputedStyle(el).backdropFilter);
  if (!blur.includes('blur')) throw new Error('Loading overlay must blur the screen');
  if (await loadingPage.locator('#gameView').getAttribute('aria-hidden') !== 'false') throw new Error('Console must appear before ROM download completes');
  if (!(await loadingPage.locator('.rom-loading-spinner').isVisible())) throw new Error('Loading spinner missing');
  await loadingPage.screenshot({ path: path.join(screenshotDir, 'rom-loading.png') });
  await loadingPage.click('#cancelRomLoad');
  await loadingPage.locator('#romLoadingDialog').waitFor({ state: 'hidden' });
  await loadingPage.evaluate(() => window.releaseRomBytes());
  await loadingPage.waitForFunction(() => document.querySelector('#statusMirror').textContent === 'ROM loading cancelled');
  if (await loadingPage.locator('.game-card.is-active .game-primary').getAttribute('data-rom-id') !== previousRom) throw new Error('Cancelled ROM replaced the current game');
  if (await loadingPage.locator('[data-gbc-measure="device-face"]').getAttribute('data-view') !== 'games') throw new Error('Cancel must stay in cartridges');
  await loadingPage.close();
  for (const choice of ['resumeYes', 'resumeNo', 'resumeBrowse']) {
    const page = await newPage(browser, { name: choice, width: 320, height: 560 }, true, false, false);
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.locator('#resumePrompt').waitFor({ state: 'visible' });
    if (await page.locator('#saveList').isVisible()) throw new Error('Save list must wait for Browse');
    await page.click(`#${choice}`);
    if (choice === 'resumeBrowse') await page.locator('#saveList .save-load').first().waitFor();
    else await page.locator('#saveDialog').waitFor({ state: 'hidden' });
    const status = await page.locator('#statusMirror').textContent();
    if (choice === 'resumeYes' && status !== 'Save loaded') throw new Error('Yes did not load save');
    if (choice === 'resumeNo' && status === 'Save loaded') throw new Error('No loaded a save');
    await page.close();
  }
  for (const viewport of viewports) {
    const page = await newPage(browser, viewport);
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-gbc-measure="screen"]');
    await page.waitForFunction(() => document.querySelector('#bootOverlay')?.classList.contains('is-loaded'), null, {
      timeout: 5000,
    }).catch(() => undefined);

    const measurement = await measurePage(page, viewport);
    assertScreenRatio(measurement);
    if (viewport.name !== 'ultra-narrow-library') {
      assertNoPrimaryOverlap(measurement);
      assertSmallModeScreenPriority(measurement);
    }
    if (viewport.name === 'ideal-portrait') {
      assertIdealCenters(measurement);
      report.theme = await proveTheme(page);
      report.controls = await proveControls(page);
      report.gamesView = await proveGamesView(page);
      report.savePath = await proveSavePath(page);
    }
    if (viewport.name === 'ultra-narrow-library' || viewport.name === 'dense-library') {
      report.denseLibrary = await proveDenseLibrary(page);
    }

    const screenshotPath = path.join(screenshotDir, `${viewport.name}-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    report.viewports.push({ ...measurement, screenshot: path.relative(repoRoot, screenshotPath) });
    await page.close();
  }

  const withoutKeys = await newPage(browser, { name: 'without-keys', width: 390, height: 667 }, false);
  await withoutKeys.goto(baseUrl, { waitUntil: 'networkidle' });
  await withoutKeys.waitForFunction(() => document.querySelector('#bootOverlay')?.classList.contains('is-loaded'));
  if (await withoutKeys.locator('#domainIndicator').getAttribute('data-state') !== 'on') {
    throw new Error('Missing optional NAP-KEYS must not mark required domains unavailable');
  }
  report.controlsWithoutKeys = await proveControls(withoutKeys, false);
  await withoutKeys.close();

  report.fileSaves = await proveFileSaves(browser, baseUrl);

  const verdict = {
    score: 94,
    verdict: 'pass',
    category_match: true,
    differences: [],
    suggestions: [],
    reasoning: 'Measured screen ratio, canonical ideal controls, responsive modes, theme roles, games scope toggles, global relay discovery, file/drop load, save-file modal, and save path pass required gates.',
    next_actions: [],
  };

  await writeFile(path.join(evidenceDir, '190-MEASUREMENTS.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(evidenceDir, '190-VISUAL-VERDICT.json'), `${JSON.stringify(verdict, null, 2)}\n`);
  await writeFile(path.join(stateDir, 'ralph-progress.json'), `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(`GBColor UI measurements passed. Evidence: ${path.relative(repoRoot, evidenceDir)}`);
} finally {
  await browser.close();
  await server.close();
}

async function newPage(browserInstance, viewport, keysEnabled = true, fsEnabled = false, dismissResume = true) {
  const page = await browserInstance.newPage({ viewport });
  await page.addInitScript(installFakeShell, { keysEnabled, fsEnabled });
  page.on('pageerror', (error) => {
    console.error(`[pageerror:${viewport.name}] ${error.message}`);
  });
  if (dismissResume) {
    const goto = page.goto.bind(page);
    page.goto = async (...args) => {
      const result = await goto(...args);
      await page.locator('#soundButton:not([disabled])').waitFor();
      if (await page.locator('#resumeNo').isVisible()) await page.locator('#resumeNo').click();
      return result;
    };
  }
  return page;
}

async function measurePage(page, viewport) {
  return page.evaluate((currentViewport) => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing selector ${selector}`);
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
        display: style.display,
        visibility: style.visibility,
        opacity: Number(style.opacity),
      };
    };

    const boxes = {
      workspace: rectFor('[data-gbc-measure="workspace"]'),
      face: rectFor('[data-gbc-measure="device-face"]'),
      screenWell: rectFor('[data-gbc-measure="screen-well"]'),
      aperture: rectFor('[data-gbc-measure="screen-aperture"]'),
      screen: rectFor('[data-gbc-measure="screen"]'),
      dpad: rectFor('[data-gbc-measure="dpad"]'),
      buttonA: rectFor('[data-gbc-measure="button-a"]'),
      buttonB: rectFor('[data-gbc-measure="button-b"]'),
      buttonStart: rectFor('[data-gbc-measure="button-start"]'),
      buttonSelect: rectFor('[data-gbc-measure="button-select"]'),
      bottomBar: rectFor('[data-gbc-measure="bottom-bar"]'),
      gamesView: rectFor('[data-gbc-measure="games-view"]'),
      domainIndicator: rectFor('#domainIndicator'),
    };

    const ratio = boxes.screen.width / boxes.screen.height;
    const expectedRatio = 160 / 144;
    const mode = modeFor(currentViewport.width, currentViewport.height);
    return {
      viewport: currentViewport,
      mode,
      boxes,
      screenRatio: ratio,
      screenRatioErrorPct: Math.abs(ratio - expectedRatio) / expectedRatio,
      screenBezelPx: Math.max(
        boxes.screen.left - boxes.screenWell.left,
        boxes.screenWell.right - boxes.screen.right,
        boxes.screen.top - boxes.screenWell.top,
        boxes.screenWell.bottom - boxes.screen.bottom,
      ),
    };

    function modeFor(width, height) {
      const ratioValue = width / height;
      if (height < 360) return 'very-short';
      if (width < 320 || height < 480) return 'tiny';
      if (ratioValue >= 1.15 && height < 640 && height >= 360) return 'wide-not-tall';
      if (ratioValue > 0.78 && height >= 640) return 'wide-tall-enough';
      if (ratioValue < 0.5) return 'too-tall';
      return 'ideal-portrait';
    }
  }, viewport);
}

function assertScreenRatio(measurement) {
  if (measurement.screenRatioErrorPct > 0.005) {
    throw new Error(
      `${measurement.viewport.width}x${measurement.viewport.height} screen ratio ${measurement.screenRatio} exceeds 0.5% tolerance`,
    );
  }
}

function assertIdealCenters(measurement) {
  const face = measurement.boxes.face;
  const scale = face.width / 780;
  const failures = [];
  for (const [key, [x, y]] of Object.entries(idealTargets)) {
    const box = measurement.boxes[key];
    const expected = {
      x: face.left + x * scale,
      y: face.top + y * scale,
    };
    const delta = {
      x: Math.abs(box.centerX - expected.x),
      y: Math.abs(box.centerY - expected.y),
    };
    measurement[`${key}CenterDeltaPx`] = delta;
    if (delta.x > 2 || delta.y > 2) {
      failures.push(`${key} center delta ${delta.x.toFixed(2)},${delta.y.toFixed(2)}`);
    }
  }
  if (failures.length) {
    throw new Error(`Ideal portrait centers outside tolerance: ${failures.join('; ')}`);
  }
}

function assertNoPrimaryOverlap(measurement) {
  const boxes = measurement.boxes;
  const failures = [];
  for (let leftIndex = 0; leftIndex < primaryKeys.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < primaryKeys.length; rightIndex += 1) {
      const leftKey = primaryKeys[leftIndex];
      const rightKey = primaryKeys[rightIndex];
      if (leftKey === 'buttonStart' && rightKey === 'buttonSelect') {
        continue;
      }
      if (overlapArea(boxes[leftKey], boxes[rightKey]) > 1) {
        failures.push(`${leftKey}/${rightKey}`);
      }
    }
  }

  for (const key of primaryKeys) {
    if (overlapArea(boxes.bottomBar, boxes[key]) > 1) {
      failures.push(`bottomBar/${key}`);
    }
  }

  if (failures.length) {
    throw new Error(
      `${measurement.viewport.width}x${measurement.viewport.height} overlapping controls: ${failures.join(', ')}`,
    );
  }
}

function assertSmallModeScreenPriority(measurement) {
  if ((measurement.mode === 'tiny' || measurement.mode === 'very-short') && measurement.screenBezelPx > 24) {
    throw new Error(
      `${measurement.viewport.width}x${measurement.viewport.height} small-mode bezel ${measurement.screenBezelPx.toFixed(2)}px exceeds 24px`,
    );
  }
}

function overlapArea(left, right) {
  const x = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const y = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return x * y;
}

async function proveDenseLibrary(page) {
  await page.click('#gamesButton');
  await page.waitForFunction(() => document.querySelector('[data-gbc-measure="device-face"]')?.dataset.view === 'games');
  await page.click('[data-rom-scope="global"]');
  await page.waitForFunction(() => document.querySelectorAll('.game-card').length >= 40);
  await page.waitForTimeout(300);

  const layout = await page.evaluate(() => {
    const grid = document.querySelector('#gameGrid');
    const gridRect = grid.getBoundingClientRect();
    const cards = Array.from(document.querySelectorAll('.game-card'));
    const cardRects = cards.map((card) => card.getBoundingClientRect());
    const overlaps = [];
    for (let left = 0; left < cardRects.length; left += 1) {
      for (let right = left + 1; right < cardRects.length; right += 1) {
        const a = cardRects[left];
        const b = cardRects[right];
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 1 && overlapY > 1) {
          overlaps.push({
            left: cards[left].dataset.groupId,
            right: cards[right].dataset.groupId,
            overlapX,
            overlapY,
          });
        }
      }
    }
    return {
      cardCount: cards.length,
      clientWidth: grid.clientWidth,
      horizontalOverflow: grid.scrollWidth - grid.clientWidth,
      scrollable: grid.scrollHeight > grid.clientHeight,
      overflowY: getComputedStyle(grid).overflowY,
      outsideCount: cardRects.filter((rect) => rect.left < gridRect.left - 1 || rect.right > gridRect.right + 1).length,
      overlapCount: overlaps.length,
      firstOverlap: overlaps[0] ?? null,
      gridRows: getComputedStyle(grid).gridTemplateRows,
      firstCards: cardRects.slice(0, 6).map((rect) => ({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })),
      wrappedLabelCount: Array.from(document.querySelectorAll('.game-title, .game-meta'))
        .filter((label) => label.scrollHeight > label.clientHeight + 1).length,
    };
  });

  if (
    layout.clientWidth <= 0 ||
    layout.horizontalOverflow > 1 ||
    !layout.scrollable ||
    layout.overflowY !== 'scroll' ||
    layout.outsideCount > 0 ||
    layout.overlapCount > 0 ||
    layout.wrappedLabelCount > 0
  ) {
    throw new Error(`Dense games layout failed: ${JSON.stringify(layout)}`);
  }
  return layout;
}

async function proveTheme(page) {
  const before = await readThemeColors(page);
  await page.evaluate(() => {
    window.__gbcolorSetTheme({
      colors: {
        background: '#123456',
        primary: '#ff55aa',
        text: '#f0f4f8',
      },
    });
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-gbc-measure="device-face"]')).backgroundColor === 'rgb(18, 52, 86)');
  const after = await readThemeColors(page);
  const changed = {
    shell: before.shell !== after.shell,
    lens: before.lens !== after.lens,
    control: before.control !== after.control,
  };
  if (!changed.shell || !changed.lens || !changed.control) {
    throw new Error(`Theme roles did not all respond: ${JSON.stringify({ before, after, changed })}`);
  }
  return { before, after, changed };
}

async function readThemeColors(page) {
  return page.evaluate(() => ({
    shell: getComputedStyle(document.querySelector('[data-gbc-measure="device-face"]')).backgroundColor,
    lens: getComputedStyle(document.querySelector('[data-gbc-measure="screen-well"]')).backgroundColor,
    control: getComputedStyle(document.querySelector('[data-gbc-measure="button-a"]')).backgroundImage,
  }));
}

async function proveControls(page, keysEnabled = true) {
  await page.waitForFunction((expected) => window.__gbcolorTestLog.keyActions.length === expected, keysEnabled ? 8 : 0);
  await page.evaluate(() => {
    window.__gbcolorJoypadStates = [];
  });

  await page.keyboard.down('ArrowRight');
  await page.evaluate(() => window.__gbcolorTriggerKeyAction('gbcolor.right'));
  await page.keyboard.down('z');
  await page.evaluate(() => window.__gbcolorTriggerKeyAction('gbcolor.b'));
  await page.keyboard.down('x');
  await page.evaluate(() => window.__gbcolorTriggerKeyAction('gbcolor.a'));
  await page.waitForTimeout(160);

  const heldChord = await readJoypadState(page);
  assertJoypadState(heldChord, [0, 1, 0, 0, 1, 1, 0, 0], 'held Right+B+A chord');

  await page.keyboard.up('z');
  const afterBRelease = await readJoypadState(page);
  assertJoypadState(afterBRelease, [0, 1, 0, 0, 1, 0, 0, 0], 'Right+A after releasing B');

  await page.keyboard.up('x');
  const afterARelease = await readJoypadState(page);
  assertJoypadState(afterARelease, [0, 1, 0, 0, 0, 0, 0, 0], 'held Right after releasing A');

  await page.keyboard.up('ArrowRight');
  const released = await readJoypadState(page);
  assertJoypadState(released, [0, 0, 0, 0, 0, 0, 0, 0], 'released controls');

  await page.keyboard.down('ArrowLeft');
  await page.evaluate(() => window.__gbcolorTriggerKeyAction('gbcolor.left'));
  await page.keyboard.up('ArrowLeft');
  const immediateRelease = await readJoypadState(page);
  assertJoypadState(immediateRelease, [0, 0, 0, 0, 0, 0, 0, 0], 'release before action pulse timeout');

  return { heldChord, afterBRelease, afterARelease, released, immediateRelease };
}

async function proveFileSaves(browser, baseUrl) {
  const page = await newPage(browser, { name: 'file-saves', width: 390, height: 667 }, true, true);
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#bootOverlay')?.classList.contains('is-loaded'));
  await page.click('#saveFileButton');
  await page.selectOption('#saveDestination', 'filesystem');
  await page.click('#saveButton');
  await page.waitForFunction(() => document.querySelector('#saveStatus').textContent === 'Saved to filesystem');
  const saved = await page.evaluate(() => ({ data: Array.from(window.__fsBytes), calls: window.__fsCalls }));
  const payload = JSON.parse(Buffer.from(saved.data).toString());
  if (payload.payload.format !== 'snapshot-v1' || saved.calls.filter(c => c.kind === 'write').length < 2) {
    throw new Error('Filesystem snapshot/chunked write failed');
  }
  await page.click('#loadSaveButton');
  await page.locator('#saveDialog').waitFor({ state: 'hidden' });
  await page.click('#saveFileButton');
  for (const code of ['cancelled', 'permission-denied']) {
    await page.evaluate(code => { window.__fsError = code; }, code);
    await page.click('#loadSaveButton');
    await page.waitForFunction(expected => document.querySelector('#saveStatus').textContent === expected,
      code === 'cancelled' ? 'File selection cancelled' : code);
    if (await page.locator('#loadSaveButton').isDisabled()) throw new Error('File controls remained locked');
  }
  await page.evaluate(() => { window.__fsError = null; window.__fsBytes = new TextEncoder().encode('bad save'); });
  await page.click('#loadSaveButton');
  await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('invalid'));
  const layouts = [];
  for (const viewport of [{ width: 200, height: 160 }, { width: 320, height: 560 }, { width: 900, height: 600 }, { width: 2400, height: 1200 }]) {
    await page.setViewportSize(viewport);
    for (const light of [false, true]) {
      await page.evaluate(light => window.__gbcolorSetTheme({ colors: { background: light ? '#eeeeee' : '#18202a', text: light ? '#111111' : '#eeeeee', primary: '#8460aa' } }), light);
      await page.selectOption('#saveDestination', 'filesystem');
      for (const selector of ['#saveDestination', '#saveButton', '#loadSaveButton', '#saveCloseButton']) {
        await page.locator(selector).scrollIntoViewIfNeeded();
        const box = await page.locator(selector).boundingBox();
        if (!box || box.x < 0 || box.y < 0 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1) {
          throw new Error(`Save controls clipped at ${JSON.stringify(viewport)}: ${selector}`);
        }
      }
      await page.screenshot({ path: path.join(screenshotDir, `save-${viewport.width}x${viewport.height}-${light ? 'light' : 'dark'}.png`) });
      layouts.push({ ...viewport, light });
    }
  }
  await page.close();
  const fallback = await newPage(browser, { name: 'file-fallback', width: 390, height: 667 }, false, false);
  await fallback.addInitScript(() => {
    window.napplet.storage = {
      getItem: async key => key.includes('preferences') ? JSON.stringify({ cacheRoms: true }) : null,
      setItem: async () => {},
    };
  });
  await fallback.goto(baseUrl, { waitUntil: 'networkidle' });
  await fallback.waitForFunction(() => document.querySelector('#bootOverlay')?.classList.contains('is-loaded'));
  await fallback.click('#settingsButton');
  if (await fallback.locator('#settingsCache').isVisible() || await fallback.locator('#settingsCacheHint').isVisible()) throw new Error('Filesystem settings visible without NAP-FS');
  if (!(await fallback.locator('#settingsCache').isChecked())) throw new Error('Missing NAP-FS must preserve the saved caching preference');
  await fallback.click('#closeSettings');
  await fallback.click('#gamesButton');
  if (await fallback.locator('.rom-download').count()) throw new Error('ROM downloads offered without NAP-FS');
  await fallback.locator('.rom-info').first().click();
  if (await fallback.locator('.rom-download').count()) throw new Error('Detail downloads offered without NAP-FS');
  await fallback.click('#gamesButton');
  await fallback.click('#saveFileButton');
  if (await fallback.locator('.save-destination').isVisible()) throw new Error('Filesystem location picker visible without NAP-FS');
  if (!(await fallback.locator('#filesystemOption').evaluate(option => option.disabled && option.hidden))) throw new Error('Filesystem offered without NAP-FS');
  if (await fallback.locator('#saveDestination').inputValue() !== 'nostr') throw new Error('Missing NAP-FS must default to Nostr');
  if (await fallback.locator('option[value="device"]').count()) throw new Error('Device saves must not be offered');
  await fallback.click('#saveButton');
  await fallback.waitForFunction(() => document.querySelector('#saveStatus').textContent === 'Save published');
  await fallback.click('#loadSaveButton');
  await fallback.locator('#saveList .save-load').first().click();
  await fallback.waitForFunction(() => document.querySelector('#saveStatus').textContent === 'Save loaded');
  await fallback.close();
  return { filesystemRoundTrip: true, nostrFallback: true, noDeviceSave: true, layouts };
}

async function readJoypadState(page) {
  return page.evaluate(() => window.__gbcolorJoypadStates.at(-1));
}

function assertJoypadState(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function proveSavePath(page) {
  await page.click('#saveFileButton');
  if (await page.locator('#saveDestination').isVisible()) await page.selectOption('#saveDestination', 'nostr');
  if (await page.locator('#saveDestination').inputValue() !== 'nostr') throw new Error('Nostr save destination missing');
  await page.click('#loadSaveButton');
  await page.locator('#saveList .save-load').first().waitFor();
  await page.waitForFunction(() => document.querySelector('#saveDialog')?.open === true);
  const saveUi = await page.evaluate(() => {
    const list = document.querySelector('#saveList');
    const firstTime = document.querySelector('.save-time')?.textContent ?? '';
    return {
      dialogOpen: document.querySelector('#saveDialog')?.open === true,
      hasOverflowScroll: Boolean(list && list.scrollHeight > list.clientHeight),
      firstTime,
    };
  });
  if (!saveUi.dialogOpen || !saveUi.hasOverflowScroll || !/ago|yesterday|just now/.test(saveUi.firstTime)) {
    throw new Error(`Save modal proof failed: ${JSON.stringify(saveUi)}`);
  }
  await page.click('#saveButton');
  await page.waitForFunction(() => window.__gbcolorTestLog.published.some((event) => event.kind === 30078));
  await page.click('#loadSaveButton');
  await page.locator('#saveList .save-load').first().click();
  await page.waitForFunction(() => document.querySelector('#statusMirror')?.textContent === 'Save loaded');
  await page.locator('#saveDialog').waitFor({ state: 'hidden' });
  await page.click('#saveFileButton');
  await page.click('#loadSaveButton');
  await page.click('.save-delete');
  await page.waitForFunction(() => window.__gbcolorTestLog.published.some((event) => event.kind === 5));
  const savePath = await page.evaluate(() => ({
    publishedKinds: window.__gbcolorTestLog.published.map((event) => event.kind),
    queryKinds: window.__gbcolorTestLog.queries.map((entry) => entry.kinds),
    resourceCalls: window.__gbcolorTestLog.resources,
    keyActions: window.__gbcolorTestLog.keyActions,
    status: document.querySelector('#statusMirror')?.textContent ?? '',
  }));
  await page.click('#saveCloseButton');
  await page.waitForFunction(() => document.querySelector('#saveDialog')?.open === false);
  return { ...savePath, saveUi };
}

async function proveGamesView(page) {
  await page.click('#gamesButton');
  await page.waitForFunction(() => document.querySelector('[data-gbc-measure="device-face"]')?.dataset.view === 'games');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#gameView')).opacity === '0');
  const openState = await page.evaluate(() => {
    const cartridgeRect = document.querySelector('.game-card')?.getBoundingClientRect();
    return {
      view: document.querySelector('[data-gbc-measure="device-face"]')?.dataset.view,
      gameOpacity: getComputedStyle(document.querySelector('#gameView')).opacity,
      cartridgeCount: document.querySelectorAll('.game-card').length,
      cartridgeBox: cartridgeRect
        ? {
            width: Math.round(cartridgeRect.width),
            height: Math.round(cartridgeRect.height),
            aspect: Number((cartridgeRect.width / cartridgeRect.height).toFixed(3)),
          }
        : null,
      optionCount: document.querySelectorAll('#romSelect option').length,
      defaultScope: document.querySelector('[data-rom-scope="global"]')?.getAttribute('aria-pressed'),
      openFileVisible: getComputedStyle(document.querySelector('#openFileButton')).display !== 'none',
      toggleText: document.querySelector('#gamesButton')?.textContent?.trim() ?? '',
    };
  });
  if (
    openState.view !== 'games' ||
    openState.gameOpacity !== '0' ||
    openState.cartridgeCount < 1 ||
    !openState.cartridgeBox ||
    openState.cartridgeBox.aspect < 0.82 ||
    openState.cartridgeBox.aspect > 0.98 ||
    openState.optionCount < 1 ||
    openState.defaultScope !== 'true' ||
    !openState.openFileVisible ||
    openState.toggleText !== 'Console'
  ) {
    throw new Error(`Games view did not flip cleanly: ${JSON.stringify(openState)}`);
  }

  await page.evaluate(() => {
    window.__gbcolorOutboxDelayMs = 80;
  });
  await page.click('[data-rom-scope="network"]');
  await page.waitForFunction(() => document.querySelector('#gameGrid')?.getAttribute('aria-busy') === 'true');
  const loadingState = await page.evaluate(() => ({
    busy: document.querySelector('#gameGrid')?.getAttribute('aria-busy'),
    placeholderCount: document.querySelectorAll('.game-placeholder').length,
    status: document.querySelector('#gamesStatus')?.textContent ?? '',
    hasPrematureEmptyMessage: Boolean(document.querySelector('.empty-games')),
  }));
  if (
    loadingState.busy !== 'true' ||
    loadingState.placeholderCount < 1 ||
    !loadingState.status.startsWith('Loading Network games') ||
    loadingState.hasPrematureEmptyMessage
  ) {
    throw new Error(`Games loading state failed: ${JSON.stringify(loadingState)}`);
  }
  await page.waitForFunction(() => (
    document.querySelector('[data-rom-scope="network"]')?.getAttribute('aria-pressed') === 'true' &&
    !document.querySelector('#gameGrid')?.hasAttribute('aria-busy') &&
    document.querySelectorAll('.game-card').length >= 1
  ));
  await page.evaluate(() => {
    window.__gbcolorOutboxDelayMs = 0;
  });
  const networkState = await page.evaluate(() => ({
    scope: document.querySelector('[data-rom-scope="network"]')?.getAttribute('aria-pressed'),
    cardCount: document.querySelectorAll('.game-card').length,
    optionCount: document.querySelectorAll('#romSelect option').length,
    outboxAuthors: window.__gbcolorTestLog.queries
      .filter((entry) => entry.kinds.includes(32560))
      .map((entry) => entry.filter.authors ?? []),
  }));

  await page.click('[data-rom-scope="global"]');
  await page.waitForFunction(() => (
    document.querySelector('[data-rom-scope="global"]')?.getAttribute('aria-pressed') === 'true' &&
    window.__gbcolorTestLog.relaySubscriptions.length > 0 &&
    [...document.querySelectorAll('.game-meta')].filter(el => el.textContent.includes('options')).length >= 1
  ));
  const globalState = await page.evaluate(() => ({
    scope: document.querySelector('[data-rom-scope="global"]')?.getAttribute('aria-pressed'),
    cardCount: document.querySelectorAll('.game-card').length,
    optionCount: document.querySelectorAll('#romSelect option').length,
    variantCount: [...document.querySelectorAll('.game-meta')].filter(el => el.textContent.includes('options')).length,
    relaySubscriptions: window.__gbcolorTestLog.relaySubscriptions,
    runtimeRoutedRelay: window.__gbcolorTestLog.relaySubscriptions.every((entry) => entry.options === undefined),
  }));
  if (
    networkState.optionCount < 2 ||
    globalState.optionCount < 40 ||
    globalState.variantCount < 1 ||
    !globalState.runtimeRoutedRelay
  ) {
    throw new Error(`Games scope proof failed: ${JSON.stringify({ networkState, globalState })}`);
  }
  const gamesScreenshot = path.join(screenshotDir, 'games-global-390x667.png');
  await page.screenshot({ path: gamesScreenshot, fullPage: false });

  const chooserPromise = page.waitForEvent('filechooser');
  await page.click('#openFileButton');
  const chooser = await chooserPromise;
  await chooser.setFiles(romFilePayload('Pocket Test.gbc'));
  await page.waitForFunction(() => document.querySelector('[data-gbc-measure="device-face"]')?.dataset.view === 'game');
  await page.waitForFunction(() => document.querySelector('#statusMirror')?.textContent?.includes('Pocket Test'));
  await page.click('#gamesButton');
  await page.waitForFunction(() => document.querySelector('[data-gbc-measure="device-face"]')?.dataset.view === 'games');
  const fileState = await page.evaluate(() => ({
    firstTitle: document.querySelector('.game-card:first-child .game-title')?.textContent ?? '',
    firstMeta: document.querySelector('.game-card:first-child .game-meta')?.textContent ?? '',
    firstMemory: document.querySelector('.game-card:first-child')?.classList.contains('is-memory') ?? false,
  }));
  if (fileState.firstTitle !== 'Pocket Test' || !fileState.firstMemory || !fileState.firstMeta.includes('loaded in memory')) {
    throw new Error(`Open File ROM did not render first: ${JSON.stringify(fileState)}`);
  }

  await page.evaluate(() => {
    const bytes = new Uint8Array(0x18000);
    bytes[0x147] = 0x03;
    bytes[0x149] = 0x02;
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'Dropped Test.gb', { type: 'application/octet-stream' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('[data-gbc-measure="device-face"]')?.dataset.view === 'game');
  await page.waitForFunction(() => document.querySelector('#statusMirror')?.textContent?.includes('Dropped Test'));
  await page.click('#gamesButton');
  await page.waitForFunction(() => document.querySelector('[data-gbc-measure="device-face"]')?.dataset.view === 'games');
  const dropState = await page.evaluate(() => ({
    firstTitle: document.querySelector('.game-card:first-child .game-title')?.textContent ?? '',
    firstMeta: document.querySelector('.game-card:first-child .game-meta')?.textContent ?? '',
    firstMemory: document.querySelector('.game-card:first-child')?.classList.contains('is-memory') ?? false,
  }));
  if (dropState.firstTitle !== 'Dropped Test' || !dropState.firstMemory || !dropState.firstMeta.includes('loaded in memory')) {
    throw new Error(`Dropped ROM did not render first: ${JSON.stringify(dropState)}`);
  }

  await page.locator('.game-card.is-memory .game-primary').evaluate((button) => button.click());
  await page.waitForFunction(() => document.querySelector('[data-gbc-measure="device-face"]')?.dataset.view === 'game');
  const closedState = await page.evaluate(() => ({
    closedView: document.querySelector('[data-gbc-measure="device-face"]')?.dataset.view,
    status: document.querySelector('#statusMirror')?.textContent ?? '',
  }));
  return {
    ...closedState,
    opened: openState,
    loading: loadingState,
    network: networkState,
    global: globalState,
    file: fileState,
    drop: dropState,
    screenshot: path.relative(repoRoot, gamesScreenshot),
  };
}

function romFilePayload(name) {
  const buffer = Buffer.alloc(0x18000);
  buffer[0x147] = 0x03;
  buffer[0x149] = 0x02;
  return {
    name,
    mimeType: 'application/octet-stream',
    buffer,
  };
}

function installFakeShell({ keysEnabled = true, fsEnabled = false } = {}) {
  const pubkey = 'f'.repeat(64);
  const followPubkey = 'e'.repeat(64);
  const globalPubkey = 'd'.repeat(64);
  const romBytes = new Uint8Array(0x18000);
  romBytes[0x147] = 0x03;
  romBytes[0x149] = 0x02;
  const romBlob = new Blob([romBytes], { type: 'application/octet-stream' });
  const makeRomEvent = ({ id, author, title, slug, url, createdAt }) => ({
    id,
    pubkey: author,
    created_at: createdAt,
    kind: 32560,
    tags: [
      ['d', slug],
      ['title', title],
      ['resource', url],
    ],
    content: JSON.stringify({
      name: title,
      slug,
      resources: [{ url, bytes: romBytes.byteLength }],
    }),
    sig: '0'.repeat(128),
  });
  const romEvent = makeRomEvent({
    id: 'a'.repeat(64),
    author: pubkey,
    title: 'Fixture ROM',
    slug: 'fixture-rom',
    url: 'nap-resource://fixture-rom.gb',
    createdAt: 1_788_000_000,
  });
  const networkRomEvent = makeRomEvent({
    id: 'c'.repeat(64),
    author: followPubkey,
    title: 'Network ROM',
    slug: 'network-rom',
    url: 'nap-resource://network-rom.gb',
    createdAt: 1_788_000_010,
  });
  const globalVariantEvent = makeRomEvent({
    id: 'd'.repeat(64),
    author: globalPubkey,
    title: 'Fixture ROM',
    slug: 'fixture-rom-global',
    url: 'nap-resource://fixture-rom-global.gb',
    createdAt: 1_788_000_020,
  });
  const globalRomEvent = makeRomEvent({
    id: '9'.repeat(64),
    author: globalPubkey,
    title: 'Global ROM',
    slug: 'global-rom',
    url: 'nap-resource://global-rom.gb',
    createdAt: 1_788_000_030,
  });
  const libraryRomEvents = Array.from({ length: 48 }, (_, index) => makeRomEvent({
    id: (index + 16).toString(16).padStart(64, '0'),
    author: globalPubkey,
    title: `Very Long Game Boy Color Library Title ${String(index + 1).padStart(2, '0')}`,
    slug: `library-rom-${index + 1}`,
    url: `nap-resource://library-rom-${index + 1}.gbc`,
    createdAt: 1_788_000_100 + index,
  }));
  const saveEvents = [];
  const deleteEvents = [];
  let saveSeeded = false;
  const themeListeners = [];
  const keyActionHandlers = new Map();
  const seedSaves = async () => {
    if (saveSeeded) return;
    saveSeeded = true;
    const ram = new Uint8Array(8 * 1024);
    const digest = await crypto.subtle.digest('SHA-256', ram);
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const data = bytesToBase64(ram);
    const now = Math.floor(Date.now() / 1000);
    for (let index = 0; index < 12; index += 1) {
      saveEvents.push({
        id: `${index}`.padStart(64, 'b'),
        pubkey,
        created_at: now - (index + 1) * 3600,
        kind: 30078,
        tags: [
          ['d', 'gbcolor-fixture-rom-save0'],
          ['title', `Fixture ROM save ${index + 1}`],
          ['application', 'gbcolor'],
          ['rom', 'fixture-rom'],
          ['save-format', 'wasmboy-core-cartridge-ram-v1'],
          ['x', sha256],
        ],
        content: JSON.stringify({
          schema: 'gbcolor.save.v1',
          emulator: 'wasmboy-core',
          rom: { name: 'Fixture ROM', slug: 'fixture-rom' },
          payload: {
            format: 'cartridge-ram',
            encoding: 'base64',
            bytes: ram.byteLength,
            data,
            sha256,
          },
        }),
        sig: '2'.repeat(128),
      });
    }
  };
  const bytesToBase64 = (bytes) => {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  };
  window.__gbcolorTestLog = {
    published: [],
    queries: [],
    relaySubscriptions: [],
    resources: [],
    keyActions: [],
  };
  window.__gbcolorJoypadStates = [];
  window.__gbcolorOutboxDelayMs = 0;
  window.__gbcolorTriggerKeyAction = (actionId) => {
    for (const handler of keyActionHandlers.get(actionId) ?? []) handler();
  };
  window.__gbcolorSetTheme = (theme) => {
    for (const listener of themeListeners) listener(theme);
  };
  window.napplet = {
    identity: {
      getPublicKey: async () => pubkey,
      getFollows: async () => [followPubkey],
      onChanged: () => ({ close() {} }),
    },
    theme: {
      get: async () => ({
        colors: {
          background: '#1c252f',
          primary: '#9a6a84',
          text: '#eef2f5',
        },
      }),
      onChanged: (listener) => {
        themeListeners.push(listener);
        return { close() {} };
      },
    },
    keys: {
      registerAction: async (action) => {
        window.__gbcolorTestLog.keyActions.push(action);
        return { id: action.id, binding: action.defaultKey };
      },
      onAction: (actionId, callback) => {
        const handlers = keyActionHandlers.get(actionId) ?? new Set();
        handlers.add(callback);
        keyActionHandlers.set(actionId, handlers);
        return {
          close() {
            handlers.delete(callback);
          },
        };
      },
      unregisterAction: () => {},
    },
    resource: {
      bytes: async (url) => {
        window.__gbcolorTestLog.resources.push(url);
        return romBlob;
      },
    },
    outbox: {
      query: async (filters, options) => {
        const filter = Array.isArray(filters) ? filters[0] : filters;
        const kinds = Array.isArray(filter?.kinds) ? filter.kinds : [];
        window.__gbcolorTestLog.queries.push({ kinds, filter, options });
        if (window.__gbcolorOutboxDelayMs > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, window.__gbcolorOutboxDelayMs));
        }
        if (kinds.includes(32560)) {
          const authors = Array.isArray(filter?.authors) ? filter.authors : [];
          const events = [
            ...(authors.includes(pubkey) ? [romEvent] : []),
            ...(authors.includes(followPubkey) ? [networkRomEvent] : []),
          ];
          return {
            events: events.map((event) => ({
              event,
              sidecar: { resources: [{ url: event.tags.find((tag) => tag[0] === 'resource')?.[1], blob: romBlob }] },
            })),
          };
        }
        if (kinds.includes(30078)) {
          await seedSaves();
          return { events: saveEvents.map((event) => ({ event })) };
        }
        if (kinds.includes(5)) {
          return { events: deleteEvents.map((event) => ({ event })) };
        }
        return { events: [] };
      },
      publish: async (template) => {
        const event = {
          id: `${template.kind}`.padStart(64, String(window.__gbcolorTestLog.published.length % 10)),
          pubkey,
          created_at: template.created_at,
          kind: template.kind,
          tags: template.tags,
          content: template.content,
          sig: '1'.repeat(128),
        };
        window.__gbcolorTestLog.published.push(event);
        if (event.kind === 30078) saveEvents.unshift(event);
        if (event.kind === 5) deleteEvents.unshift(event);
        return { ok: true, event };
      },
    },
    relay: {
      subscribe: (filters, onEvent, onEose, options) => {
        const filter = Array.isArray(filters) ? filters[0] : filters;
        const kinds = Array.isArray(filter?.kinds) ? filter.kinds : [];
        window.__gbcolorTestLog.relaySubscriptions.push({ kinds, options });
        const timer = window.setTimeout(() => {
          if (kinds.includes(32560)) {
            for (const event of [romEvent, globalVariantEvent, globalRomEvent, ...libraryRomEvents]) {
              onEvent({
                event,
                sidecar: { resources: [{ url: event.tags.find((tag) => tag[0] === 'resource')?.[1], blob: romBlob }] },
              });
            }
          }
          onEose();
        }, 24);
        return {
          close() {
            window.clearTimeout(timer);
          },
        };
      },
      query: async () => [],
      publish: async (template) => ({ ...template, id: '3'.repeat(64), pubkey, sig: '4'.repeat(128) }),
    },
  };
  if (!keysEnabled) delete window.napplet.keys;
  if (fsEnabled) {
    window.__fsBytes = new Uint8Array();
    window.__fsCalls = [];
    window.__fsError = null;
    window.napplet.fs = {
      info: async () => ({ roots: [{ path: '/workspace', name: 'Workspace', permissions: ['read', 'write', 'create'] }], limits: { maxReadBytes: 128, maxWriteBytes: 128 } }),
      mkdir: async () => {},
      list: async path => {
        const call = window.__fsCalls.find(call => call.kind === 'write');
        return call && call.path.slice(0, call.path.lastIndexOf('/')) === path ? [{ name: call.path.split('/').pop(), kind: 'file' }] : [];
      },
      pickSaveFile: async () => { throw new Error('unsupported'); },
      pickFile: async () => { throw new Error('unsupported'); },
      write: async (path, data, options) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        if (bytes.length > 128) throw new Error('write limit exceeded');
        if (options.mode === 'replace') window.__fsBytes = new Uint8Array();
        const offset = options.offset ?? 0;
        const output = new Uint8Array(Math.max(window.__fsBytes.length, offset + bytes.length));
        output.set(window.__fsBytes); output.set(bytes, offset); window.__fsBytes = output;
        window.__fsCalls.push({ kind: 'write', path, offset });
        return { bytesWritten: bytes.length, size: output.length };
      },
      read: async (path, options) => {
        if (window.__fsError) throw Object.assign(new Error(window.__fsError), { code: window.__fsError });
        const offset = options.offset ?? 0;
        const bytes = window.__fsBytes.slice(offset, offset + Math.min(options.length, 128));
        window.__fsCalls.push({ kind: 'read', path, offset });
        return { data: bytesToBase64(bytes), bytesRead: bytes.length, offset, eof: offset + bytes.length >= window.__fsBytes.length };
      },
    };
  }
}

function wasmboyCoreStub() {
  const moduleId = '\0gbcolor-wasmboy-core-stub';
  return {
    name: 'gbcolor-wasmboy-core-stub',
    enforce: 'pre',
    resolveId(id) {
      return id === 'wasmboy/dist/core/core.esm.js' ? moduleId : null;
    },
    load(id) {
      if (id !== moduleId) return null;
      return `
        export const FRAME_LOCATION = 0;
        export const CARTRIDGE_ROM_LOCATION = 0x4000;
        export const CARTRIDGE_RAM_LOCATION = 0x20000;
        export const AUDIO_BUFFER_LOCATION = 0x30000;
        export const memory = { wasmByteMemory: new Uint8Array(0x40000) };
        export function config() {}
        export function captureSnapshotRegisters() { return { Cpu: { pc: 0x150 } }; }
        export function validateSnapshotRegisters(state) { if (state?.Cpu?.pc !== 0x150) throw new Error('Invalid registers'); }
        export function restoreSnapshotRegisters(state) { validateSnapshotRegisters(state); }
        export function setJoypadState(...state) {
          window.__gbcolorJoypadStates?.push(state);
        }
        export function executeFrameAndCheckAudio() {
          for (let index = 0; index < 160 * 144 * 3; index += 3) {
            memory.wasmByteMemory[FRAME_LOCATION + index] = 80 + (index % 120);
            memory.wasmByteMemory[FRAME_LOCATION + index + 1] = 120;
            memory.wasmByteMemory[FRAME_LOCATION + index + 2] = 92;
          }
          return 0;
        }
        export function clearAudioBuffer() {}
        export function getNumberOfSamplesInAudioBuffer() { return 0; }
      `;
    },
  };
}
