import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server/index.js';

const runtime = path.resolve('.runtime');
await fs.mkdir(runtime, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(runtime, 'playback-clock-data-'));
const id = randomUUID(),
  duration = 3,
  rate = 48000;
const wave = Buffer.alloc(44 + duration * rate * 4);
wave.write('RIFF', 0);
wave.writeUInt32LE(wave.length - 8, 4);
wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(2, 22);
wave.writeUInt32LE(rate, 24);
wave.writeUInt32LE(rate * 4, 28);
wave.writeUInt16LE(4, 32);
wave.writeUInt16LE(16, 34);
wave.write('data', 36);
wave.writeUInt32LE(wave.length - 44, 40);
for (let frame = 0; frame < rate * duration; frame++) {
  // Keep an audible tone in the last 800ms: truncating the tail loses real sound.
  const t = frame / rate,
    amplitude = t > 2.2 ? 0.2 : 0.03;
  const sample = Math.round(Math.sin((frame * 2 * Math.PI * 440) / rate) * amplitude * 32767);
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
      name: 'Delayed audio with audible tail',
      createdAt: new Date().toISOString(),
      duration,
      hasAudio: true,
      events: [
        { t: 0, data: [144, 69, 90] },
        { t: 2.99, data: [128, 69, 0] },
      ],
    }),
  );
  server = await startServer({ port: 3227, dataDir });
  browser = await chromium.launch({
    executablePath:
      process.env.ECLONE_TEST_BROWSER ||
      process.env.LUMA_TEST_BROWSER ||
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.addInitScript((fixtureId) => {
    window.clockProbe = {
      audio: [],
      seeks: [],
      events: [],
      heldPauseMessages: [],
      holdPauseAck: false,
      phase: 'delayed-start',
    };
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (event) => {
          const message = JSON.parse(event.data);
          if (
            window.clockProbe.holdPauseAck &&
            message.type === 'state' &&
            !message.transport.playing &&
            message.transport.reason !== 'ended'
          ) {
            event.stopImmediatePropagation();
            window.clockProbe.heldPauseMessages.push({ socket: this, data: event.data });
          }
        });
      }
    };
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      ...descriptor,
      set(value) {
        if (this.src.includes(fixtureId))
          window.clockProbe.seeks.push({
            before: descriptor.get.call(this),
            target: value,
            phase: window.clockProbe.phase,
          });
        return descriptor.set.call(this, value);
      },
    });
    const Audio = window.Audio;
    window.Audio = function (...args) {
      const audio = new Audio(...args);
      window.clockProbe.audio.push(audio);
      for (const type of ['playing', 'pause', 'ended'])
        audio.addEventListener(type, () =>
          window.clockProbe.events.push({
            type,
            t: audio.currentTime,
            phase: window.clockProbe.phase,
          }),
        );
      return audio;
    };
    window.Audio.prototype = Audio.prototype;
  }, id);
  await page.route('**/media/' + id + '.wav', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 650));
    await route.continue();
  });
  const stage = await browser.newPage({ viewport: { width: 800, height: 450 } });
  await stage.goto('http://127.0.0.1:3227/stage');
  await page.goto('http://127.0.0.1:3227');
  await page.locator(`[data-play="${id}"]`).click();
  await page.bringToFront();
  await page.waitForFunction(() => window.clockProbe.audio[0]?.currentTime > 0.2);
  const inspect = () =>
    page.evaluate(() => ({
      audio: window.clockProbe.audio[0].currentTime,
      visual: window.ecloneDiagnostics().position,
      paused: window.clockProbe.audio[0].paused,
      ended: window.clockProbe.audio[0].ended,
      button: document.getElementById('playButton').textContent,
    }));
  report.started = await inspect();
  const state = server.state();
  report.startDelay =
    state.transport.position + state.serverTime - state.transport.startedAt - report.started.audio;
  assert.ok(
    report.startDelay > 0.4,
    'The test must actually delay source audio relative to server transport.',
  );
  assert.ok(
    Math.abs(report.started.visual - report.started.audio) < 0.01,
    'Local notes must follow the audible media clock.',
  );
  const deadline = Date.now() + 6000;
  while (server.state().transport.reason !== 'ended' && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(server.state().transport.reason, 'ended');
  await page.waitForFunction(() => window.ecloneDiagnostics().position > 2);
  report.tail = await inspect();
  assert.equal(
    report.tail.paused,
    false,
    'Natural server completion must let buffered media finish.',
  );
  assert.equal(report.tail.ended, false);
  assert.ok(report.tail.audio < duration - 0.25, 'A meaningful audible tail must still remain.');
  assert.equal(report.tail.button, 'Ⅱ');
  assert.ok(Math.abs(report.tail.visual - report.tail.audio) < 0.01);
  report.remoteStagePosition = await stage.evaluate(() => window.ecloneDiagnostics().position);
  assert.ok(
    Math.abs(report.remoteStagePosition - duration) < 0.01,
    'Silent remote viewers retain server-clock behavior.',
  );
  report.uninterruptedSeeks = await page.evaluate(() => window.clockProbe.seeks);
  assert.ok(
    report.uninterruptedSeeks.every((seek) => seek.before < 0.01 && seek.target < 0.01),
    'Buffering and natural completion must not cause hard correction seeks.',
  );

  await page.evaluate(() => {
    window.clockProbe.phase = 'manual-tail-pause';
    window.clockProbe.holdPauseAck = true;
  });
  await page.locator('#playButton').click();
  await page.waitForFunction(() => window.clockProbe.audio[0].paused);
  // Hold the server acknowledgement: local audio and its button must agree immediately.
  await page.waitForFunction(() => window.clockProbe.heldPauseMessages.length > 0);
  report.manualPause = await inspect();
  report.pausedServerPosition = server.state().transport.position;
  assert.equal(server.state().transport.reason, undefined);
  assert.ok(
    Math.abs(report.manualPause.audio - report.pausedServerPosition) < 0.02,
    'Manual pause must save the actual audible position.',
  );
  assert.equal(report.manualPause.button, '▶');
  report.pauseButtonUpdatedBeforeServerAck = true;

  await page.evaluate(() => {
    window.clockProbe.holdPauseAck = false;
    for (const message of window.clockProbe.heldPauseMessages.splice(0))
      message.socket.dispatchEvent(new MessageEvent('message', { data: message.data }));
    window.clockProbe.phase = 'resume-tail';
  });
  await page.locator('#playButton').click();
  await page.waitForFunction(
    () =>
      window.clockProbe.audio[0].ended &&
      window.clockProbe.events.some((event) => event.type === 'ended'),
    null,
    { timeout: 6000 },
  );
  report.finished = await inspect();
  report.events = await page.evaluate(() => window.clockProbe.events);
  report.seeks = await page.evaluate(() => window.clockProbe.seeks);
  assert.ok(
    report.events.some((event) => event.type === 'ended' && Math.abs(event.t - duration) < 0.001),
    'Native media playback must reach its real end, including the audible tail.',
  );
  assert.ok(Math.abs(report.finished.visual - duration) < 0.001);
  assert.equal(report.finished.button, '▶');
  assert.equal(server.state().midiStatus.connected, false);
  assert.deepEqual(report.errors, []);
  console.log('Playback clock regression: ' + JSON.stringify(report, null, 2));
} finally {
  await fs.writeFile(
    path.join(runtime, 'playback-clock-report.json'),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  await server?.close();
  if (!dataDir.startsWith(runtime + path.sep + 'playback-clock-data-'))
    throw new Error('Unsafe test directory');
  await fs.rm(dataDir, { recursive: true, force: true });
}
