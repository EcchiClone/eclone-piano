import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { startServer } from '../../server/index.js';
import { browserExecutablePath } from '../../scripts/lib/browser.mjs';
import { prepareRuntime, runtimePaths } from '../../scripts/lib/runtime.mjs';
import { pcm16Stereo } from '../helpers/audio.mjs';

await prepareRuntime();
const dataDir = await fs.mkdtemp(path.join(runtimePaths.tmp, 'usability-'));
const ids = [randomUUID(), randomUUID()];
for (const [index, name] of ['잔잔한 밤', '연습 스케치'].entries()) {
  await fs.writeFile(
    path.join(dataDir, ids[index] + '.session.json'),
    JSON.stringify({
      version: 1,
      id: ids[index],
      name,
      createdAt: '2026-11-07T00:00:00Z',
      hasAudio: index === 0,
      duration: 6,
      events: [
        { t: 0, data: [144, 60, 90] },
        { t: 5, data: [128, 60, 0] },
      ],
    }),
  );
}
await fs.writeFile(
  path.join(dataDir, ids[0] + '.wav'),
  pcm16Stereo({
    duration: 6,
    sampleRate: 44100,
    sample: (t) => Math.sin(t * 2 * Math.PI * 440) * 0.1,
  }),
);
const report = { checks: [], errors: [], layouts: [] };
let server, browser;
try {
  server = await startServer({ port: 0, dataDir });
  browser = await chromium.launch({
    executablePath: browserExecutablePath(),
    headless: true,
    args: [
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.addInitScript(() => {
    window.usabilityAudio = [];
    const NativeAudio = window.Audio;
    window.Audio = function (...args) {
      const element = new NativeAudio(...args);
      window.usabilityAudio.push(element);
      return element;
    };
    window.Audio.prototype = NativeAudio.prototype;
  });
  const base = 'http://127.0.0.1:' + server.port;
  await page.goto(base);
  await page.waitForFunction(() => window.ecloneDiagnostics?.().settings);
  await page.locator(`[data-play="${ids[0]}"]`).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  const first = await page.locator('#recordButton').boundingBox();
  assert.ok(
    first.y >= 0 && first.y + first.height < 768,
    'Record must be visible without scrolling.',
  );
  report.checks.push('Record and MIDI controls appear before the preview at1366x768');
  await page.locator(`[data-play="${ids[0]}"]`).click();
  await page.waitForFunction(
    () => window.usabilityAudio.length && window.usabilityAudio[0].readyState >= 2,
  );
  await page.locator('#playbackVolume').evaluate((el) => {
    el.value = '.32';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await page.evaluate(() => window.usabilityAudio.at(-1).volume), 0.32);
  await page.locator('#muteAudio').click();
  assert.equal(await page.evaluate(() => window.usabilityAudio.at(-1).volume), 0);
  await page.locator('#muteAudio').click();
  assert.equal(await page.evaluate(() => window.usabilityAudio.at(-1).volume), 0.32);
  report.checks.push('Replay volume and mute affect only the local Audio element');
  await page.locator('#librarySearch').fill('스케치');
  assert.equal(await page.locator('.session-card').count(), 1);
  await page.locator('#librarySearch').fill('없음');
  assert.equal(await page.locator('.session-card').count(), 0);
  await page.locator('#librarySearch').fill('');
  await page.locator('#libraryFilter').selectOption('audio');
  assert.equal(await page.locator('.session-card').count(), 1);
  await page.locator('#libraryFilter').selectOption('all');
  await page.locator('#librarySort').selectOption('name');
  assert.equal(await page.locator('.session-info strong').first().textContent(), '연습 스케치');
  await page.locator('#liveTab').click();
  assert.equal((await page.evaluate(() => window.ecloneDiagnostics())).mode, 'replay');
  report.checks.push('Search, audio filter, sorting and navigation preserve replay state');
  await page.locator('#noteRange').selectOption('custom');
  await page.locator('#minNote').selectOption('43');
  await page.locator('#maxNote').selectOption('80');
  await page.waitForFunction(
    () =>
      window.ecloneDiagnostics().settings.minNote === 43 &&
      window.ecloneDiagnostics().settings.maxNote === 80,
  );
  await page.locator('#useCustomColor').check();
  await page.locator('#customColor').fill('#ff8866');
  await page.waitForFunction(() => window.ecloneDiagnostics().settings.customColor === '#ff8866');
  await page.locator('#hitStrength').evaluate((el) => {
    el.value = '.8';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => window.ecloneDiagnostics().settings.hitStrength === 0.8);
  await page.locator('#saveScene').click();
  await page.locator('#sceneName').fill('내 장면 <script>');
  await page.locator('#confirmSceneSave').click();
  assert.equal(await page.locator('#sceneSelect').inputValue(), '내 장면 <script>');
  await page.locator('[data-theme="amber"]').click();
  await page.locator('#sceneSelect').selectOption('내 장면 <script>');
  await page.waitForFunction(
    () =>
      window.ecloneDiagnostics().settings.customColor === '#ff8866' &&
      window.ecloneDiagnostics().settings.useCustomColor,
  );
  assert.equal(await page.locator('#sceneSelect script').count(), 0);
  const snapshot = await page.evaluate(() => window.ecloneDiagnostics().settings);
  await page.reload();
  await page.waitForFunction(() => window.ecloneDiagnostics()?.settings.customColor === '#ff8866');
  assert.ok(
    await page
      .locator('#sceneSelect')
      .textContent()
      .then((text) => text.includes('내 장면 <script>')),
  );
  await page.locator('.scene-tools > summary').click();
  const downloaded = page.waitForEvent('download');
  await page.locator('#exportScene').click();
  const file = await downloaded;
  const exported = JSON.parse(await fs.readFile(await file.path(), 'utf8'));
  assert.equal(exported.type, 'eclone-scene');
  assert.equal(exported.settings.audioSampleRate, undefined);
  exported.name = '내 장면 <script>';
  await page.locator('#sceneFile').setInputFiles({
    name: 'scene.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await page.waitForFunction(() => document.getElementById('sceneSelect').value.endsWith('(2)'));
  report.checks.push(
    'Custom range/color/impact and named scenes survive reload; import preserves an existing name',
  );
  await page.locator('#sceneTab').press('ArrowRight');
  await page.locator('#overlayPanel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#overlayTab').getAttribute('tabindex'), '0');
  assert.match(await page.locator('#panelScope').textContent(), /오버레이에만/);
  await page.locator('#overlayTab').press('ArrowLeft');
  await page.locator('#appearancePanel').waitFor({ state: 'visible' });
  await page.locator('#fullscreenButton').click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  const fullscreen = await page.evaluate(() => ({
    viewport: innerHeight,
    canvas: document.querySelector('.preview-frame').getBoundingClientRect().height,
  }));
  assert.equal(fullscreen.canvas, fullscreen.viewport);
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement);
  report.checks.push(
    'Fullscreen fills the viewport; settings tabs expose their target and keyboard focus',
  );
  const impact = await page.evaluate(async () => {
    const { PianoRenderer } = await import('/engine.js');
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const renderer = new PianoRenderer(canvas, () => ({
      notes: [{ note: 60, velocity: 110, start: 0, end: 2 }],
      particles: false,
      minNote: 48,
      maxNote: 72,
    }));
    renderer.renderAt(0.1, { hitStrength: 0 });
    const before = canvas.toDataURL();
    renderer.renderAt(0.1, { hitStrength: 1 });
    const after = canvas.toDataURL();
    renderer.renderAt(0.1, { hitStrength: 1 });
    const repeated = canvas.toDataURL();
    renderer.renderAt(1, { hitStrength: 0 });
    const settled = canvas.toDataURL();
    renderer.renderAt(1, { hitStrength: 1 });
    const ended = canvas.toDataURL();
    renderer.destroy();
    return {
      changed: before !== after,
      repeatable: after === repeated,
      settles: settled === ended,
    };
  });
  assert.deepEqual(impact, { changed: true, repeatable: true, settles: true });
  report.checks.push('Impact is visible on attack, deterministic for export and absent after420ms');
  for (const [width, height] of [
    [1480, 960],
    [1366, 768],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.locator('#liveTab').evaluate((el) => el.click());
    await page.evaluate(() => window.scrollTo(0, 0));
    const layout = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      recordBottom: document.getElementById('recordButton').getBoundingClientRect().bottom,
    }));
    assert.ok(layout.scroll <= width);
    if (width > 950) assert.ok(layout.recordBottom < height);
    report.layouts.push(layout);
  }
  assert.equal(snapshot.audioSampleRate, 44100);
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
  await fs.writeFile(
    path.join(runtimePaths.reports, 'usability-report.json'),
    JSON.stringify(report, null, 2),
  );
  assert.equal(path.dirname(dataDir), runtimePaths.tmp);
  assert.ok(path.basename(dataDir).startsWith('usability-'));
  await fs.rm(dataDir, { recursive: true, force: true });
}
