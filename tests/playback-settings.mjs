import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server/index.js';

// Instrument the native audio setter without replacing audio playback or its clock.
// The fixture and server are isolated; no Kontakt input or production state is used.
const runtime = path.resolve('.runtime');
await fs.mkdir(runtime, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(runtime, 'playback-settings-data-'));
const id = randomUUID(),
  duration = 16,
  sampleRate = 48000;
const wave = Buffer.alloc(44 + duration * sampleRate * 4);
wave.write('RIFF', 0);
wave.writeUInt32LE(wave.length - 8, 4);
wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(2, 22);
wave.writeUInt32LE(sampleRate, 24);
wave.writeUInt32LE(sampleRate * 4, 28);
wave.writeUInt16LE(4, 32);
wave.writeUInt16LE(16, 34);
wave.write('data', 36);
wave.writeUInt32LE(wave.length - 44, 40);
for (let frame = 0; frame < duration * sampleRate; frame++) {
  const sample = Math.round(Math.sin((frame * 2 * Math.PI * 440) / sampleRate) * 0.02 * 32767);
  wave.writeInt16LE(sample, 44 + frame * 4);
  wave.writeInt16LE(sample, 46 + frame * 4);
}
const report = { errors: [] };
let server, browser;
try {
  await fs.writeFile(path.join(dataDir, id + '.wav'), wave);
  await fs.writeFile(
    path.join(dataDir, id + '.session.json'),
    JSON.stringify({
      version: 1,
      id,
      name: 'Generated playback seek regression',
      createdAt: new Date().toISOString(),
      duration,
      hasAudio: true,
      events: [
        { t: 0.2, data: [144, 69, 90] },
        { t: 15, data: [128, 69, 0] },
      ],
    }),
  );
  server = await startServer({ port: 3224, dataDir });
  browser = await chromium.launch({
    executablePath:
      process.env.LUMA_TEST_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.addInitScript((fixtureId) => {
    window.seekRegression = { calls: [], audio: [], phase: 'initial' };
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      ...descriptor,
      set(value) {
        if (this.src.includes(fixtureId)) {
          const before = descriptor.get.call(this);
          window.seekRegression.calls.push({
            before,
            value,
            delta: Math.abs(value - before),
            phase: window.seekRegression.phase,
          });
        }
        return descriptor.set.call(this, value);
      },
    });
    const Audio = window.Audio;
    window.Audio = function (...args) {
      const audio = new Audio(...args);
      window.seekRegression.audio.push(audio);
      return audio;
    };
    window.Audio.prototype = Audio.prototype;
  }, id);
  await page.goto('http://127.0.0.1:3224');
  await page.waitForFunction(() => window.lumaDiagnostics()?.mode === 'live');
  await page.locator(`[data-play="${id}"]`).click();
  await page.waitForFunction(
    () =>
      window.seekRegression.audio[0]?.currentTime > 0.1 && !window.seekRegression.audio[0].paused,
  );
  await page.locator('#playButton').click();
  await page.waitForFunction(() => window.seekRegression.audio[0].paused);

  const seek = async (value) => {
    await page.locator('#seek').evaluate((element, value) => {
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await page.waitForFunction(
      (value) =>
        Math.abs(window.seekRegression.audio[0].currentTime - value) < 0.001 &&
        !window.seekRegression.audio[0].seeking,
      value,
    );
  };
  const setting = async (key, value) => {
    await page.locator('#' + key).evaluate((element, value) => {
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await page.waitForFunction(
      ({ key, value }) => window.lumaDiagnostics().settings[key] === value,
      { key, value },
    );
  };
  const theme = async (value) => {
    await page.locator(`[data-theme="${value}"]`).click();
    await page.waitForFunction((value) => window.lumaDiagnostics().settings.theme === value, value);
  };
  await seek(2);
  await page.evaluate(() => {
    window.seekRegression.calls = [];
    window.seekRegression.phase = 'paused-settings';
  });
  await theme('amber');
  await theme('violet');
  await setting('overlayNoteOpacity', 0.47);
  await setting('overlayKeyboardOpacity', 0.12);
  await setting('glow', 0.35);
  report.pausedSettingsSeeks = await page.evaluate(() => window.seekRegression.calls);
  assert.deepEqual(
    report.pausedSettingsSeeks,
    [],
    'Visual settings must never force a seek on already aligned audio.',
  );

  // A 50ms transport seek is below drift-correction tolerance, so this proves
  // transport changes still force an intentional seek independently of drift.
  await page.evaluate(() => {
    window.seekRegression.calls = [];
    window.seekRegression.phase = 'transport-seek';
  });
  await seek(2.05);
  report.transportSeek = await page.evaluate(() => window.seekRegression.calls);
  assert.ok(
    report.transportSeek.some((call) => Math.abs(call.value - 2.05) < 0.001 && call.delta < 0.18),
  );

  await page.locator('#playButton').click();
  await page.waitForFunction(
    () =>
      !window.seekRegression.audio[0].paused && window.seekRegression.audio[0].currentTime > 2.15,
  );
  const before = await page.evaluate(() => {
    window.seekRegression.calls = [];
    window.seekRegression.phase = 'playing-settings';
    return window.seekRegression.audio[0].currentTime;
  });
  await theme('aurora');
  await setting('overlayNoteOpacity', 0.61);
  for (const value of [0.4, 0.45, 0.5, 0.55, 0.6]) await setting('glow', value);
  report.playingSettingsSeeks = await page.evaluate(() => window.seekRegression.calls);
  report.audioAdvanced =
    (await page.evaluate(() => window.seekRegression.audio[0].currentTime)) - before;
  assert.ok(
    report.audioAdvanced > 0,
    'The playing-settings check must run while real audio is advancing.',
  );
  assert.ok(
    report.playingSettingsSeeks.every((call) => call.delta > 0.18),
    'Settings updates must not trigger unnecessary audio seeks; genuine drift correction remains allowed.',
  );
  assert.equal(server.state().midiStatus.connected, false);
  assert.deepEqual(report.errors, []);
  console.log('Playback settings regression: ' + JSON.stringify(report, null, 2));
} finally {
  await fs.writeFile(
    path.join(runtime, 'playback-settings-report.json'),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  await server?.close();
  if (!dataDir.startsWith(runtime + path.sep + 'playback-settings-data-'))
    throw new Error('Unsafe test data path');
  await fs.rm(dataDir, { recursive: true, force: true });
}
