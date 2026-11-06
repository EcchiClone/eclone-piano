import { runtimePaths, prepareRuntime } from '../../scripts/lib/runtime.mjs';
import { pcm16Stereo } from '../helpers/audio.mjs';
import { browserExecutablePath } from '../../scripts/lib/browser.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../../server/index.js';

const runtime = runtimePaths.tmp;
await prepareRuntime();
const dataDir = await fs.mkdtemp(path.join(runtime, 'playback-owner-data-'));
const id = randomUUID(),
  duration = 45,
  rate = 44100;
const wave = pcm16Stereo({
  duration,
  sampleRate: rate,
  sample: (t) => Math.sin(2 * Math.PI * 440 * t) * (1000 / 32767),
});

const report = { checks: [], errors: [] };
const originalReadFile = fs.readFile;
let server, browser, releaseRead;
function delayNextSessionRead() {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  fs.readFile = async (...args) => {
    if (String(args[0]) === path.join(dataDir, id + '.session.json')) {
      fs.readFile = originalReadFile;
      entered();
      await gate;
    }
    return originalReadFile(...args);
  };
  return started;
}
async function finishDelayedRead() {
  releaseRead();
  // Allow the deliberately old disk read and WAV header validation to finish.
  await new Promise((resolve) => setTimeout(resolve, 300));
}
const command = (page, message) =>
  page.evaluate(
    (message) => window.ownerProbe.sockets.at(-1).send(JSON.stringify(message)),
    message,
  );
function installProbe() {
  window.ownerProbe = { audio: [], sockets: [], hellos: [], notices: [] };
  const NativeAudio = window.Audio,
    NativeSocket = window.WebSocket;
  window.Audio = function (...args) {
    const element = new NativeAudio(...args);
    window.ownerProbe.audio.push(element);
    return element;
  };
  window.Audio.prototype = NativeAudio.prototype;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      window.ownerProbe.sockets.push(this);
      this.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'hello') window.ownerProbe.hellos.push(message.clientId);
        if (message.type === 'notice') window.ownerProbe.notices.push(message);
      });
    }
  };
}
const snapshot = (page) =>
  page.evaluate(() => ({
    ...window.ecloneDiagnostics(),
    hellos: window.ownerProbe.hellos,
    audio: window.ownerProbe.audio.map((element) => ({
      src: element.getAttribute('src'),
      paused: element.paused,
      time: element.currentTime,
      muted: element.muted,
      volume: element.volume,
      readyState: element.readyState,
    })),
  }));
const sounding = (state) =>
  state.audio.filter(
    (element) => element.src && !element.paused && !element.muted && element.volume > 0,
  );
const waitPlaying = (page) =>
  page.waitForFunction(() =>
    window.ownerProbe.audio.some(
      (element) =>
        element.getAttribute('src') &&
        !element.paused &&
        element.readyState === 4 &&
        element.currentTime > 0.1,
    ),
  );
const waitSilent = (page) =>
  page.waitForFunction(() =>
    window.ownerProbe.audio.every((element) => element.paused || !element.getAttribute('src')),
  );
async function waitState(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate(server.state())) {
    if (Date.now() > deadline)
      throw new Error(
        'Timed out waiting for ownership state: ' +
          JSON.stringify({
            transport: server.state().transport,
            owner: server.state().studioAudioOwnerId,
          }),
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
try {
  await fs.writeFile(path.join(dataDir, id + '.wav'), wave);
  await fs.writeFile(
    path.join(dataDir, id + '.session.json'),
    JSON.stringify({
      version: 1,
      id,
      name: 'Isolated audio ownership fixture',
      createdAt: new Date().toISOString(),
      duration,
      hasAudio: true,
      events: [
        { t: 0, data: [144, 69, 90] },
        { t: 44, data: [128, 69, 0] },
      ],
    }),
  );
  server = await startServer({ port: 0, dataDir });
  const url = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({
    executablePath: browserExecutablePath(),
    headless: true,
    // Reconnection is tested in background pages. Keep their timers running as
    // they do in Electron; machine load must not turn this into a timer-throttling test.
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  // Separate contexts cannot share BroadcastChannel/localStorage, like Electron and Chrome.
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  for (const context of contexts) {
    await context.addInitScript(installProbe);
    context.on('page', (page) =>
      page.on('pageerror', (error) => report.errors.push(error.message)),
    );
  }
  const a = await contexts[0].newPage();
  let b = await contexts[1].newPage();
  await Promise.all([a.goto(url), b.goto(url)]);
  await Promise.all(
    [a, b].map((page) => page.waitForFunction(() => window.ownerProbe.hellos.length === 1)),
  );
  await a.locator(`[data-play="${id}"]`).click();
  await waitPlaying(a);
  await b.waitForFunction(() => window.ecloneDiagnostics().mode === 'replay');
  assert.equal(sounding(await snapshot(a)).length, 1);
  assert.equal((await snapshot(b)).audio.length, 0);
  assert.match(await b.locator('#takeSubtitle').textContent(), /다른 스튜디오 창/);
  report.checks.push('Only the initiating studio emits audio across independent browser contexts');

  const oldPlayRead = delayNextSessionRead();
  await command(a, { type: 'play', sessionId: id, position: 7 });
  await oldPlayRead;
  await b.locator(`[data-play="${id}"]`).click();
  await waitPlaying(b);
  const latestOwner = server.state().studioAudioOwnerId;
  await finishDelayedRead();
  assert.equal(server.state().studioAudioOwnerId, latestOwner);
  assert.equal(server.state().transport.position, 0);
  await waitSilent(a);
  assert.equal((await snapshot(b)).ownsStudioAudio, true);
  assert.equal((await snapshot(a)).ownsStudioAudio, false);
  report.checks.push('Explicit Play transfers ownership and stops the previous audio element');
  report.checks.push('An older delayed Play cannot steal ownership back from the latest Play');

  const bOwner = server.state().studioAudioOwnerId;
  await a.locator('#playButton').click();
  await waitState((state) => !state.transport.playing);
  await waitSilent(b);
  assert.equal(server.state().studioAudioOwnerId, bOwner);
  await a.locator('#playButton').click();
  await waitPlaying(a);
  await waitSilent(b);
  assert.notEqual(server.state().studioAudioOwnerId, bOwner);
  report.checks.push('Any studio can pause; explicit resume claims audio for its own window');

  const cancelledRead = delayNextSessionRead();
  await command(b, { type: 'play', sessionId: id, position: 5 });
  await cancelledRead;
  await command(a, { type: 'live' });
  await waitState((state) => state.transport.mode === 'live');
  await finishDelayedRead();
  assert.equal(server.state().transport.mode, 'live');
  assert.equal(server.state().studioAudioOwnerId, null);
  await Promise.all([waitSilent(a), waitSilent(b)]);
  report.checks.push('A delayed Play cannot restart sound after switching to Live');
  await a.locator(`[data-play="${id}"]`).click();
  await waitPlaying(a);

  const silentStage = await contexts[0].newPage(),
    audioStage = await contexts[1].newPage();
  await silentStage.goto(url + '/stage?transparent=1');
  await silentStage.waitForFunction(() => window.ecloneDiagnostics().mode === 'replay');
  assert.equal((await snapshot(silentStage)).audio.length, 0);
  await audioStage.goto(url + '/stage?transparent=1&audio=1');
  await waitPlaying(audioStage);
  assert.equal(sounding(await snapshot(a)).length, 1);
  assert.equal(sounding(await snapshot(audioStage)).length, 1);
  report.checks.push('Default OBS remains silent; explicit audio=1 remains independently audible');
  const studioOwner = server.state().studioAudioOwnerId;
  await command(audioStage, { type: 'play', sessionId: id });
  await audioStage.waitForFunction(() =>
    window.ownerProbe.notices.some((message) => /보기 전용/.test(message.message)),
  );
  assert.equal(server.state().studioAudioOwnerId, studioOwner);
  report.checks.push('Even an audio-enabled OBS viewer cannot claim studio ownership');

  const ownerBeforeClose = server.state().studioAudioOwnerId;
  await b.close();
  assert.equal(server.state().studioAudioOwnerId, ownerBeforeClose);
  assert.equal(server.state().transport.playing, true);
  b = await contexts[1].newPage();
  await b.goto(url);
  await b.waitForFunction(() => window.ecloneDiagnostics().mode === 'replay');
  assert.equal((await snapshot(b)).audio.length, 0);
  report.checks.push(
    'Closing or opening an unrelated studio cannot interrupt or duplicate playback',
  );

  await a.evaluate(() => window.ownerProbe.sockets.at(-1).close());
  await waitState((state) => !state.transport.playing && state.studioAudioOwnerId === null);
  await Promise.all([waitSilent(a), waitSilent(audioStage)]);
  assert.equal(server.state().transport.reason, 'ownerDisconnected');
  await a.waitForFunction(() => window.ownerProbe.hellos.length === 2, null, { timeout: 6000 });
  const afterReconnect = await snapshot(a);
  assert.notEqual(afterReconnect.hellos[0], afterReconnect.hellos[1]);
  assert.equal(afterReconnect.ownsStudioAudio, false);
  assert.equal(sounding(afterReconnect).length, 0);
  assert.equal(sounding(await snapshot(b)).length, 0);
  report.checks.push(
    'Owner disconnect pauses transport; reconnection gets a new identity and remains silent',
  );

  await b.locator('#playButton').click();
  await waitPlaying(b);
  await waitPlaying(audioStage);
  assert.equal(sounding(await snapshot(a)).length, 0);
  await b.close();
  await waitState((state) => !state.transport.playing && state.studioAudioOwnerId === null);
  await waitSilent(audioStage);
  await a.locator('#playButton').click();
  await waitPlaying(a);
  assert.equal((await snapshot(a)).ownsStudioAudio, true);
  await audioStage.close();
  assert.equal(server.state().transport.playing, true);
  report.checks.push(
    'Closing the owning page pauses playback; a remaining studio can explicitly restart',
  );

  b = await contexts[1].newPage();
  await b.goto(url);
  await b.waitForFunction(() => window.ownerProbe.hellos.length === 1);
  await b.evaluate(() => {
    const nativePlay = HTMLMediaElement.prototype.play;
    window.ownerProbe.blockPlayback = true;
    window.ownerProbe.playCalls = 0;
    HTMLMediaElement.prototype.play = function () {
      window.ownerProbe.playCalls++;
      if (window.ownerProbe.blockPlayback)
        return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
      return nativePlay.call(this);
    };
  });
  await b.locator(`[data-play="${id}"]`).click();
  await b.waitForFunction(
    () =>
      window.ownerProbe.playCalls === 1 &&
      document.getElementById('playButton').textContent === '▶',
  );
  await waitSilent(a);
  await waitSilent(b);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(await b.evaluate(() => window.ownerProbe.playCalls), 1);
  await b.evaluate(() => {
    window.ownerProbe.blockPlayback = false;
  });
  await b.locator('#playButton').click();
  await waitPlaying(b);
  assert.equal(sounding(await snapshot(a)).length, 0);
  report.checks.push('Autoplay rejection stays silent without retries until an explicit user Play');

  assert.equal(server.state().midiStatus.connected, false);
  assert.equal(server.state().recording, null);
  assert.deepEqual(report.errors, []);
  console.log('Studio audio ownership: ' + JSON.stringify(report, null, 2));
} finally {
  fs.readFile = originalReadFile;
  releaseRead?.();
  await fs.writeFile(
    path.join(runtimePaths.reports, 'playback-owner-report.json'),
    JSON.stringify(
      {
        ...report,
        lastTransport: server?.state().transport,
        lastOwner: server?.state().studioAudioOwnerId,
      },
      null,
      2,
    ),
  );
  await browser?.close();
  await server?.close();
  if (!dataDir.startsWith(runtime + path.sep + 'playback-owner-data-'))
    throw new Error('Unsafe test path');
  await fs.rm(dataDir, { recursive: true, force: true });
}
