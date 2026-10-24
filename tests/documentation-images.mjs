// Reproducible documentation images. This never opens a real MIDI/audio device
// and never reads recordings/: the native helpers below are synthetic fixtures.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.runtime');
const output = path.join(root, 'docs', 'images');
await fs.mkdir(runtime, { recursive: true });
await fs.mkdir(output, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(runtime, 'documentation-data-'));
const originalSpawn = childProcess.spawn;
const originalExists = fsSync.existsSync;
function fixtureChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.message = (message) => child.stdout.write(JSON.stringify(message) + '\n');
  child.finish = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  };
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
    final(done) {
      done();
      child.finish();
    },
  });
  child.kill = () => {
    child.finish();
    return true;
  };
  return child;
}
childProcess.spawn = (command, args, options) => {
  if (command === 'powershell.exe') {
    const child = fixtureChild();
    setImmediate(() => {
      child.message({
        type: 'ports',
        inputs: [{ id: 0, name: 'EClone Demo Keyboard' }],
        outputs: [],
      });
      child.message({ type: 'status', connected: true, inputId: 0 });
    });
    return child;
  }
  if (command === 'dotnet') {
    assert.ok(args.includes('--list'), 'Documentation must never start an audio capture');
    const child = fixtureChild();
    setImmediate(() => {
      child.message({
        type: 'processes',
        supported: true,
        processes: [{ pid: 1000, name: 'Kontakt 7 · Demo' }],
      });
      child.finish();
    });
    return child;
  }
  // Playwright's headless browser is the only real process used by this script.
  return originalSpawn(command, args, options);
};
fsSync.existsSync = (file) => String(file).endsWith('ProcessAudio.dll') || originalExists(file);
syncBuiltinESMExports();

let app, browser;
const errors = [];
try {
  const { startServer } = await import('../server/index.js');
  const port = 3367;
  app = await startServer({ port, dataDir });
  const base = `http://127.0.0.1:${port}`;
  const demo = await fetch(base + '/api/session/demo').then((r) => r.json());
  for (const [id, name, createdAt] of [
    ['d9c548b5-ff84-4401-88a7-094941f492a1', 'First light · 합성 데모', '2026-01-02T09:00:00.000Z'],
    [
      'b80b921b-2d95-4ea0-b653-f81939ba1d11',
      'Evening study · 합성 데모',
      '2026-01-01T09:00:00.000Z',
    ],
  ])
    await fs.writeFile(
      path.join(dataDir, id + '.session.json'),
      JSON.stringify({ ...demo, id, name, createdAt, version: 1 }),
    );
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.ECLONE_DOC_BROWSER ||
      (process.platform === 'win32'
        ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
        : undefined),
  });
  const studio = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
  });
  studio.on('pageerror', (error) => errors.push(error.message));
  await studio.goto(base);
  await studio.waitForFunction(() => window.ecloneDiagnostics()?.settings);
  await studio.locator('#audioProcess option[value="1000"]').waitFor({ state: 'attached' });
  await studio.locator('#demoButton').click();
  await studio.waitForFunction(() => window.ecloneDiagnostics()?.session === 'demo');
  await studio.locator('#playButton').click();
  async function setting(key, value, action) {
    await action();
    await studio.waitForFunction(
      ({ key, value }) => window.ecloneDiagnostics().settings[key] === value,
      { key, value },
    );
  }
  async function seek(time) {
    await studio.locator('#seek').evaluate((el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(time));
    await studio.waitForFunction(
      (time) => Math.abs(window.ecloneDiagnostics().position - time) < 0.01,
      time,
    );
  }
  async function settle(page) {
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  await setting('minNote', 36, () => studio.locator('#noteRange').selectOption('49'));
  await setting('secondsVisible', 7, () =>
    studio.locator('#secondsVisible').evaluate((el) => {
      el.value = '7';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }),
  );
  await seek(10.25);
  await settle(studio);
  assert.equal(
    await studio.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await studio.screenshot({ path: path.join(output, 'studio-aurora.png'), fullPage: true });

  await setting('theme', 'amber', () => studio.locator('[data-theme="amber"]').click());
  await setting('direction', 'down', () => studio.locator('[data-direction="down"]').click());
  await seek(10.25);
  const stage = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
  });
  stage.on('pageerror', (error) => errors.push(error.message));
  await stage.goto(base + '/stage');
  await stage.waitForFunction(() => window.ecloneDiagnostics()?.session === 'demo');
  await settle(stage);
  await stage.screenshot({ path: path.join(output, 'stage-golden.png') });

  await setting('theme', 'violet', () => studio.locator('[data-theme="violet"]').click());
  await setting('direction', 'up', () => studio.locator('[data-direction="up"]').click());
  await seek(10.25);
  await stage.goto(base + '/stage?transparent=1&overlay=1');
  await stage.waitForFunction(() => window.ecloneDiagnostics()?.session === 'demo');
  await settle(stage);
  // The upper-left C2 trail is visible at this demo position; sample empty space.
  assert.equal(
    await stage
      .locator('canvas')
      .evaluate(
        (canvas) => canvas.getContext('2d').getImageData(canvas.width - 5, 5, 1, 1).data[3],
      ),
    0,
  );
  assert.equal(
    await stage
      .locator('canvas')
      .evaluate(
        (canvas) =>
          canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height - 10, 1, 1).data[3],
      ),
    46,
  );
  await stage.screenshot({
    path: path.join(output, 'stage-transparent.png'),
    omitBackground: true,
  });
  assert.deepEqual(errors, []);
  const report = await Promise.all(
    ['studio-aurora.png', 'stage-golden.png', 'stage-transparent.png'].map(async (name) => ({
      name,
      bytes: (await fs.stat(path.join(output, name))).size,
    })),
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        images: report,
        totalBytes: report.reduce((sum, file) => sum + file.bytes, 0),
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await app?.close();
  childProcess.spawn = originalSpawn;
  fsSync.existsSync = originalExists;
  syncBuiltinESMExports();
  // Only this mkdtemp directory may be removed; production recordings are never read.
  assert.equal(path.dirname(dataDir), runtime);
  assert.ok(path.basename(dataDir).startsWith('documentation-data-'));
  await fs.rm(dataDir, { recursive: true, force: true });
}
