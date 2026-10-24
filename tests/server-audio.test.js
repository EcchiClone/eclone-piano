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
const testDirectory = await fsp.mkdtemp(path.join(tmpdir(), 'luma-server-audio-'));
let behavior = {};
let recorder;
let midiBridge;
let recorderCount = 0;

function waveFile(file, finalized = true) {
  const data = Buffer.alloc(44 + 4800 * 4);
  data.write('RIFF', 0);
  data.writeUInt32LE(finalized ? data.length - 8 : 36, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(48000, 24);
  data.writeUInt32LE(192000, 28);
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
    const child = fakeChild();
    setImmediate(() => {
      child.message({
        type: 'processes',
        supported: true,
        processes: [{ pid: 123, name: 'Kontakt Test' }],
      });
      child.finish();
    });
    return child;
  }
  const current = { ...behavior };
  recorderCount++;
  const output = args[args.indexOf('--output') + 1];
  recordings.add(output.slice(0, -4));
  const child = fakeChild(() => {
    if (child.exitCode !== null) return;
    setTimeout(() => {
      if (child.exitCode !== null) return;
      if (current.finalize !== false) {
        waveFile(output, true);
        child.message({
          type: 'stopped',
          path: output,
          durationMs: 100,
          frames: 4800,
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
  setImmediate(() => {
    waveFile(output, false);
    if (current.failBeforeReady) {
      child.message({ type: 'error', message: 'Test activation failure' });
      child.finish(1);
      return;
    }
    const startedUnixMs = Date.now(),
      startedMonotonicMs = Number(process.hrtime.bigint()) / 1e6;
    const ready = () => {
      if (child.exitCode !== null) return;
      child.message({
        type: 'ready',
        pid: 123,
        path: output,
        startedUnixMs,
        startedMonotonicMs,
        sampleRate: 48000,
        channels: 2,
        bitsPerSample: 16,
      });
    };
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
    client.send({ type: 'record', withAudio: true, pid: 123, name: 'Clock-mapped take' });
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
      behavior = { readyDelay: 80 };
      client.send({ type: 'record', withAudio: true, pid: 123 });
      await client.wait((message) => message.type === 'state' && message.starting);
      midiBridge.message({ type: 'midi', data: [144, 60, 91], timestamp: 0 });
      await new Promise((resolve) => setTimeout(resolve, 15));
      midiBridge.message({ type: 'midi', data: [128, 60, 0], timestamp: 15 });
      await client.wait((message) => message.type === 'state' && message.recording);
      client.send({ type: 'stopRecord' });
      const saved = await client.wait((message) => message.type === 'saved');
      assert.deepEqual(
        saved.session.events.map((event) => event.data),
        [
          [144, 60, 91],
          [128, 60, 0],
        ],
      );
      assert.ok(saved.session.events[1].t > saved.session.events[0].t);
      assert.ok(saved.session.events[1].t < 0.08);
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
