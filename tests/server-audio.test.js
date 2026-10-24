import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { WebSocket } from 'ws';

// Exercise the public HTTP/WebSocket API, with fake native processes only.
// This avoids touching Kontakt, MIDI devices, or recording real desktop audio.
const originalSpawn = childProcess.spawn;
const originalExists = fs.existsSync;
const recordings = new Set();
const children = new Set();
const testDirectory = await fsp.mkdtemp(path.join(tmpdir(), 'eclone-server-audio-'));
let behavior = {};
let recorder;
let midiBridge;
let recorderCount = 0;
let probeCount = 0;

function waveFile(file, finalized = true, sampleRate = 48000) {
  const data = Buffer.alloc(44 + (sampleRate / 10) * 4);
  data.write('RIFF', 0);
  data.writeUInt32LE(finalized ? data.length - 8 : 36, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(finalized ? data.length - 44 : 0, 40);
  fs.writeFileSync(file, data);
}

function fakeChild(onStop) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
    final(done) {
      done();
      onStop?.();
    },
  });
  child.message = (message) => child.stdout.write(JSON.stringify(message) + '\n');
  child.finish = (code = 0) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', code, null);
    child.emit('close', code, null);
    children.delete(child);
  };
  child.kill = () => {
    child.killed = true;
    child.finish(1);
    return true;
  };
  children.add(child);
  return child;
}

childProcess.spawn = (command, args) => {
  if (command === 'powershell.exe') {
    const child = fakeChild(() => setImmediate(() => child.finish()));
    midiBridge = child;
    setImmediate(() => child.message({ type: 'ports', inputs: [], outputs: [] }));
    return child;
  }
  if (command !== 'dotnet') throw new Error(`Unexpected subprocess in audio test: ${command}`);
  if (args.includes('--list')) {
    probeCount++;
    const current = { ...behavior };
    const child = fakeChild();
    const deliver = () => {
      if (child.exitCode !== null) return;
      child.message({
        type: 'processes',
        supported: true,
        processes: current.processes ?? [{ pid: 123, name: 'Kontakt Test' }],
      });
      child.finish();
    };
    current.onProbeCreated?.({ child, deliver });
    if (!current.manualProbe) setImmediate(deliver);
    return child;
  }
  const current = { ...behavior };
  recorderCount++;
  const output = args[args.indexOf('--output') + 1];
  const pid = Number(args[args.indexOf('--pid') + 1]);
  const sampleRate = Number(args[args.indexOf('--sample-rate') + 1]);
  assert.ok(
    [44100, 48000].includes(sampleRate),
    'Native helper receives a supported explicit rate',
  );
  recordings.add(output.slice(0, -4));
  const child = fakeChild(() => {
    if (child.exitCode !== null) return;
    setTimeout(() => {
      if (child.exitCode !== null) return;
      if (current.finalize !== false) {
        waveFile(output, true, sampleRate);
        child.message({
          type: 'stopped',
          path: output,
          durationMs: 100,
          frames: sampleRate / 10,
          peak: 0.3,
          silent: false,
          discontinuities: 0,
          insertedGapFrames: 480,
          clockResets: 2,
          timestampErrors: 1,
          maxClockDriftMs: 3.25,
          frameCounterMode: 'packet-count',
          unavailablePositionPackets: 14,
          rejectedClockAnchors: 0,
          clockMap: current.clockMap,
        });
      }
      child.finish(current.finalize === false ? 1 : 0);
    }, current.stopDelay ?? 5);
  });
  recorder = child;
  recorder.pid = pid;
  recorder.sampleRate = sampleRate;
  setImmediate(() => {
    waveFile(output, false, sampleRate);
    if (current.failBeforeReady) {
      child.message({ type: 'error', message: current.startupError ?? 'Test activation failure' });
      child.finish(1);
      return;
    }
    const startAgeMs = current.nativeStartAgeMs ?? 0;
    const startedUnixMs = Date.now() - startAgeMs,
      startedMonotonicMs = Number(process.hrtime.bigint()) / 1e6 - startAgeMs;
    const ready = () => {
      if (child.exitCode !== null) return;
      child.message({
        type: 'ready',
        pid,
        path: output,
        startedUnixMs,
        startedMonotonicMs,
        sampleRate,
        channels: 2,
        bitsPerSample: 16,
      });
    };
    current.onReadyPrepared?.({ startedMonotonicMs, releaseReady: ready });
    if (current.manualReady) return;
    if (current.readyDelay) setTimeout(ready, current.readyDelay);
    else ready();
  });
  return child;
};
fs.existsSync = (file) => String(file).endsWith('ProcessAudio.dll') || originalExists(file);
syncBuiltinESMExports();
const { startServer } = await import('../server/index.js');

async function connect() {
  behavior = {};
  const port = 39000 + Math.floor(Math.random() * 15000);
  const app = await startServer({ port, dataDir: testDirectory });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `http://127.0.0.1:${port}` });
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const wait = async (predicate, timeout = 1200) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`Timed out waiting for server message. Received ${JSON.stringify(messages)}`);
  };
  const send = (msg) => ws.send(JSON.stringify(msg));
  const clear = () => {
    messages.length = 0;
  };
  const close = async () => {
    if (app.state().recording) {
      const activeId = app.state().recording.id;
      send({ type: 'stopRecord' });
      await wait(
        (message) => message.type === 'saved' && message.session.id === activeId,
        6000,
      ).catch(() => {});
    }
    ws.close();
    await app.close();
    for (const child of children) child.finish(1);
  };
  return { app, ws, messages, wait, send, clear, close, port, dataDir: testDirectory };
}

test.after(async () => {
  childProcess.spawn = originalSpawn;
  fs.existsSync = originalExists;
  syncBuiltinESMExports();
  for (const base of recordings) {
    // Only delete UUID paths returned by this test's fake recording helper.
    assert.equal(path.dirname(base), testDirectory);
    assert.match(path.basename(base), /^[\da-f-]{36}$/i);
    for (const extension of ['.wav', '.session.json'])
      await fsp.unlink(base + extension).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
  await fsp.unlink(path.join(testDirectory, 'settings.json')).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await fsp.rmdir(testDirectory);
});

test('native level and finalized events retain the browser protocol event names', async () => {
  const client = await connect();
  try {
    client.send({ type: 'record', withAudio: true, pid: 123, name: 'Audio protocol test' });
    await client.wait((message) => message.type === 'state' && message.recording);
    recorder.message({ type: 'level', peak: 0.4, rms: 0.2, durationMs: 50 });
    const level = await client.wait((message) => message.type === 'audioLevel');
    assert.equal(level.peak, 0.4);
    client.send({ type: 'stopRecord' });
    await client.wait((message) => message.type === 'audioFinal');
    const saved = await client.wait((message) => message.type === 'saved');
    assert.equal(saved.session.hasAudio, true);
    assert.equal(recorder.sampleRate, 44100);
    assert.equal(saved.session.audio.sampleRate, 44100);
    const stored = JSON.parse(
      await fsp.readFile(path.join(client.dataDir, saved.session.id + '.session.json'), 'utf8'),
    );
    for (const [key, value] of Object.entries({
      insertedGapFrames: 480,
      clockResets: 2,
      timestampErrors: 1,
      maxClockDriftMs: 3.25,
      frameCounterMode: 'packet-count',
      unavailablePositionPackets: 14,
      rejectedClockAnchors: 0,
    })) {
      assert.equal(saved.session.audio[key], value);
      assert.equal(stored.audio[key], value);
    }
  } finally {
    await client.close();
  }
});

test('saved MIDI follows the WAV clock while retaining original capture timestamps', async () => {
  const client = await connect();
  try {
    behavior = {
      clockMap: {
        version: 1,
        sampleRate: 48000,
        anchors: [
          { wallTime: 0, frame: 0 },
          { wallTime: 0.1001, frame: 4800 },
        ],
      },
    };
    client.send({
      type: 'record',
      withAudio: true,
      pid: 123,
      sampleRate: 48000,
      name: 'Clock-mapped take',
    });
    await client.wait((message) => message.type === 'state' && message.recording);
    await new Promise((resolve) => setTimeout(resolve, 25));
    midiBridge.message({ type: 'midi', data: [144, 60, 100] });
    await new Promise((resolve) => setTimeout(resolve, 15));
    midiBridge.message({ type: 'midi', data: [128, 60, 0] });
    client.send({ type: 'stopRecord' });
    const { session } = await client.wait((message) => message.type === 'saved');
    assert.equal(session.eventTimebase, 'audio-pcm');
    assert.equal(session.midiClockMapping.target, 'audio-pcm');
    assert.equal(session.audio.clockMap.anchors.length, 2);
    const notes = session.events.filter((event) => event.data[1] === 60);
    assert.equal(notes.length, 2);
    for (const event of notes) {
      assert.ok(Number.isFinite(event.wallTime));
      assert.equal(event.t, Math.min(4800, Math.round((event.wallTime / 0.1001) * 4800)) / 48000);
    }
    assert.deepEqual(
      notes.map((event) => event.data),
      [
        [144, 60, 100],
        [128, 60, 0],
      ],
    );
    const stored = JSON.parse(
      await fsp.readFile(path.join(client.dataDir, session.id + '.session.json'), 'utf8'),
    );
    assert.deepEqual(stored.events, session.events);
    assert.deepEqual(stored.audio.clockMap, session.audio.clockMap);
  } finally {
    await client.close();
  }
});

test('both Kontakt sample rates save and restore as valid audio with matching duration', async () => {
  for (const sampleRate of [44100, 48000]) {
    const client = await connect();
    try {
      client.send({ type: 'record', withAudio: true, pid: 123, sampleRate });
      await client.wait((message) => message.type === 'state' && message.recording);
      client.send({ type: 'stopRecord' });
      const { session } = await client.wait((message) => message.type === 'saved');
      assert.equal(recorder.sampleRate, sampleRate);
      assert.equal(session.audio.sampleRate, sampleRate);
      assert.equal(session.audio.frames, sampleRate / 10);
      assert.equal(session.audio.duration, 0.1);
      const restored = await fetch(
        `http://127.0.0.1:${client.port}/api/session/${session.id}`,
      ).then((r) => r.json());
      assert.equal(restored.hasAudio, true);
      assert.equal(restored.audio.sampleRate, sampleRate);
    } finally {
      await client.close();
    }
  }
});

test('capture rate validates before starting a helper and its preference persists', async () => {
  let client = await connect();
  try {
    const before = recorderCount;
    const probesBefore = probeCount;
    client.send({ type: 'record', withAudio: true, pid: 123, sampleRate: 96000 });
    await client.wait((message) => message.type === 'notice' && /샘플레이트/.test(message.message));
    assert.equal(recorderCount, before);
    assert.equal(probeCount, probesBefore, 'Invalid rate is rejected before native enumeration');
    assert.equal(client.app.state().recording, null);
    client.send({ type: 'settings', settings: { audioSampleRate: 48000 } });
    await client.wait(
      (message) => message.type === 'state' && message.settings.audioSampleRate === 48000,
    );
    await client.close();
    client = await connect();
    assert.equal(client.app.state().settings.audioSampleRate, 48000);
    client.send({ type: 'settings', settings: { audioSampleRate: 96000 } });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(client.app.state().settings.audioSampleRate, 48000);
    client.send({ type: 'record', withAudio: true, pid: 123 });
    await client.wait((message) => message.type === 'state' && message.recording);
    assert.equal(recorder.sampleRate, 48000);
    client.send({ type: 'stopRecord' });
    await client.wait((message) => message.type === 'saved');
  } finally {
    client.clear();
    client.send({ type: 'settings', settings: { audioSampleRate: 44100 } });
    await client.wait(
      (message) => message.type === 'state' && message.settings.audioSampleRate === 44100,
    );
    await client.close();
  }
});

test('stale or non-Kontakt PIDs are rejected without capturing another process', async () => {
  for (const processes of [
    [],
    [{ pid: 456, name: 'Kontakt 7' }],
    [{ pid: 123, name: 'notepad' }],
  ]) {
    const client = await connect();
    try {
      behavior = { processes };
      const before = recorderCount,
        probesBefore = probeCount;
      client.send({ type: 'record', withAudio: true, pid: 123 });
      const notice = await client.wait(
        (message) => message.type === 'notice' && message.code === 'AUDIO_SOURCE_CHANGED',
      );
      assert.match(notice.message, /오디오 소스를 새로고침/);
      assert.equal(recorderCount, before);
      assert.equal(probeCount, probesBefore + 1);
      assert.equal(client.app.state().recording, null);
      assert.equal(client.app.state().starting, false);
    } finally {
      await client.close();
    }
  }
});

test('fresh enumeration captures only the explicitly selected current Kontakt PID', async () => {
  const client = await connect();
  try {
    behavior = {
      processes: [
        { pid: 123, name: 'Kontakt 7' },
        { pid: 456, name: 'Kontakt 8' },
      ],
    };
    client.send({ type: 'record', withAudio: true, pid: 456 });
    await client.wait((message) => message.type === 'state' && message.recording);
    assert.equal(recorder.pid, 456);
    client.send({ type: 'stopRecord' });
    await client.wait((message) => message.type === 'saved');
  } finally {
    await client.close();
  }
});

test('a process exiting between preflight and activation reports a refresh hint with its native detail', async () => {
  const client = await connect();
  try {
    behavior = { failBeforeReady: true, startupError: 'Process with an Id of 123 is not running.' };
    client.send({ type: 'record', withAudio: true, pid: 123 });
    const notice = await client.wait(
      (message) => message.type === 'notice' && message.code === 'AUDIO_SOURCE_CHANGED',
    );
    assert.match(notice.message, /새로고침/);
    assert.match(notice.message, /Process with an Id of 123 is not running/);
    assert.equal(client.app.state().recording, null);
  } finally {
    await client.close();
  }
});

test('closing during process enumeration cancels the probe and never launches a recorder', async () => {
  const client = await connect();
  let prepared;
  const probed = new Promise((resolve) => (prepared = resolve));
  behavior = { manualProbe: true, onProbeCreated: prepared };
  const before = recorderCount,
    probesBefore = probeCount;
  client.send({ type: 'record', withAudio: true, pid: 123 });
  const { child } = await probed;
  assert.equal(client.app.state().starting, true);
  client.send({ type: 'record', withAudio: true, pid: 123 });
  await client.wait((message) => message.type === 'notice' && /준비 중/.test(message.message));
  assert.equal(probeCount, probesBefore + 1, 'A second request cannot start another probe');
  await client.close();
  assert.equal(child.killed, true);
  assert.equal(recorderCount, before);
  assert.equal(client.app.state().starting, false);
  assert.equal(client.app.state().recording, null);
});

test('failed audio startup does not leave a dead helper attached to the next MIDI-only take', async () => {
  const client = await connect();
  try {
    behavior = { failBeforeReady: true };
    client.send({ type: 'record', withAudio: true, pid: 123 });
    await client.wait(
      (message) => message.type === 'notice' && /activation failure/.test(message.message),
    );
    client.clear();
    client.send({ type: 'record', withAudio: false, name: 'MIDI-only retry' });
    await client.wait((message) => message.type === 'state' && message.recording);
    const midiId = client.app.state().recording.id;
    recordings.add(path.join(client.dataDir, midiId));
    client.send({ type: 'stopRecord' });
    const saved = await client.wait((message) => message.type === 'saved', 700);
    assert.equal(saved.session.hasAudio, false);
  } finally {
    await client.close();
  }
});

test('an unexpected recorder exit is visible and does not advertise an unfinished WAV as audio', async () => {
  const client = await connect();
  try {
    client.send({ type: 'record', withAudio: true, pid: 123 });
    await client.wait((message) => message.type === 'state' && message.recording);
    client.clear();
    recorder.finish(1);
    await client.wait((message) => message.type === 'notice' && message.kind === 'error');
    if (client.app.state().recording) client.send({ type: 'stopRecord' });
    const saved = await client.wait((message) => message.type === 'saved', 1000);
    assert.equal(saved.session.hasAudio, false);
  } finally {
    await client.close();
  }
});

test('the app rejects a new recording while the previous audio file is finalizing', async () => {
  const client = await connect();
  try {
    behavior = { stopDelay: 150 };
    client.send({ type: 'record', withAudio: true, pid: 123 });
    await client.wait((message) => message.type === 'state' && message.recording);
    client.clear();
    client.send({ type: 'stopRecord' });
    client.send({ type: 'record', withAudio: false });
    await client.wait((message) => message.type === 'notice' && message.kind === 'error', 500);
    await client.wait((message) => message.type === 'saved');
    assert.equal(client.app.state().recording, null);
  } finally {
    const id = client.app.state().recording?.id;
    if (id) recordings.add(path.join(client.dataDir, id));
    await client.close();
  }
});

test(
  'MIDI received while the audio-ready message is delayed remains in the recorded take',
  { skip: process.platform !== 'win32' },
  async () => {
    const client = await connect();
    try {
      let prepared;
      const nativeStarted = new Promise((resolve) => (prepared = resolve));
      behavior = { manualReady: true, nativeStartAgeMs: 50, onReadyPrepared: prepared };
      client.send({ type: 'record', withAudio: true, pid: 123 });
      await client.wait((message) => message.type === 'state' && message.starting);
      const { startedMonotonicMs, releaseReady } = await nativeStarted;
      // Explicit native timestamps and a manual readiness gate make this independent
      // of how long overloaded CI/browser work delays setTimeout callbacks.
      midiBridge.message({
        type: 'midi',
        data: [144, 60, 91],
        qpcTimestamp: startedMonotonicMs + 10,
      });
      midiBridge.message({
        type: 'midi',
        data: [128, 60, 0],
        qpcTimestamp: startedMonotonicMs + 25,
      });
      const on = await client.wait((message) => message.type === 'midi' && message.data[0] === 144);
      const off = await client.wait(
        (message) => message.type === 'midi' && message.data[0] === 128,
      );
      assert.equal(client.app.state().starting, true);
      assert.equal(
        client.app.state().recording,
        null,
        'Both MIDI events arrived before native readiness',
      );
      releaseReady();
      const active = await client.wait((message) => message.type === 'state' && message.recording);
      client.send({ type: 'stopRecord' });
      const saved = await client.wait((message) => message.type === 'saved');
      assert.deepEqual(
        saved.session.events.map((event) => event.data),
        [
          [144, 60, 91],
          [128, 60, 0],
        ],
      );
      assert.deepEqual(
        saved.session.events.map((event) => event.t),
        [on.t - active.recording.startedAt, off.t - active.recording.startedAt],
        'Pre-ready events retain their captured times relative to the native audio start',
      );
      assert.ok(
        Math.abs(saved.session.events[1].t - saved.session.events[0].t - 0.015) < 0.002,
        'Explicit native note timestamps preserve the 15 ms interval',
      );
    } finally {
      await client.close();
    }
  },
);

test('a restored session reports missing audio honestly while preserving its MIDI events', async () => {
  const client = await connect();
  try {
    client.send({ type: 'record', withAudio: true, pid: 123 });
    await client.wait((message) => message.type === 'state' && message.recording);
    client.send({ type: 'stopRecord' });
    const { session } = await client.wait((message) => message.type === 'saved');
    assert.equal(session.hasAudio, true);
    await fsp.unlink(path.join(client.dataDir, session.id + '.wav'));
    const restored = await fetch(`http://127.0.0.1:${client.port}/api/session/${session.id}`).then(
      (response) => response.json(),
    );
    assert.equal(restored.hasAudio, false);
    assert.ok(restored.audioError);
    assert.deepEqual(restored.events, session.events);
  } finally {
    await client.close();
  }
});

test('closing during audio startup cancels the pending take without creating a late recording', async () => {
  const client = await connect();
  behavior = { readyDelay: 80 };
  client.send({ type: 'record', withAudio: true, pid: 123 });
  await client.wait((message) => message.type === 'state' && message.starting);
  await client.close();
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(client.app.state().starting, false);
  assert.equal(client.app.state().recording, null);
});

test('a MIDI-only take stops and restores without starting an audio helper', async () => {
  const client = await connect();
  try {
    const before = recorderCount;
    client.send({ type: 'record', withAudio: false, name: 'MIDI-only lifecycle' });
    const active = await client.wait((message) => message.type === 'state' && message.recording);
    recordings.add(path.join(client.dataDir, active.recording.id));
    if (process.platform === 'win32') {
      midiBridge.message({ type: 'midi', data: [144, 64, 80] });
      midiBridge.message({ type: 'midi', data: [128, 64, 0] });
    }
    client.send({ type: 'stopRecord' });
    const { session } = await client.wait((message) => message.type === 'saved', 700);
    assert.equal(recorderCount, before);
    assert.equal(session.hasAudio, false);
    assert.ok(session.duration > 0);
    assert.equal(client.app.state().recording, null);
    assert.equal(client.app.state().stopping, false);
    const restored = await fetch(`http://127.0.0.1:${client.port}/api/session/${session.id}`).then(
      (response) => response.json(),
    );
    assert.deepEqual(restored.events, session.events);
    if (process.platform === 'win32') assert.equal(restored.events.length, 2);
  } finally {
    await client.close();
  }
});
