import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { Performance as MidiPerformance } from '../public/engine.js';

const originalSpawn = childProcess.spawn;
const originalPerformance = globalThis.performance;
let milliseconds = 0,
  frozenNow = null,
  latestBridge,
  initialInputs = [{ id: 0, name: 'Test MIDI' }],
  failOpen = false;
// Advance only the server's musical clock; socket/event-loop timers stay real.
globalThis.performance = new Proxy(originalPerformance, {
  get(target, key) {
    if (key === 'now') return () => frozenNow ?? originalPerformance.now() + milliseconds;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

childProcess.spawn = (command) => {
  assert.equal(
    command,
    'powershell.exe',
    'MIDI tests must not spawn real audio or encoder processes',
  );
  const child = new EventEmitter();
  const inputs = initialInputs.map((input) => ({ ...input })),
    rejectOpen = failOpen;
  child.commands = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.message = (value) => {
    if (child.exitCode === null) child.stdout.write(JSON.stringify(value) + '\n');
  };
  child.finish = (code) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', code);
    child.emit('close', code);
  };
  let input = '';
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      input += chunk;
      while (input.includes('\n')) {
        const index = input.indexOf('\n'),
          line = input.slice(0, index);
        input = input.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        child.commands.push(message);
        if (message.type === 'open')
          setImmediate(() => {
            if (rejectOpen) {
              child.message({ type: 'error', message: 'Test device busy' });
              child.message({ type: 'status', connected: false });
            } else child.message({ type: 'status', connected: true, inputId: message.inputId });
          });
        if (message.type === 'ports')
          setImmediate(() => child.message({ type: 'ports', inputs, outputs: [] }));
        if (message.type === 'close')
          setImmediate(() => child.message({ type: 'status', connected: false }));
        if (message.type === 'quit') setImmediate(() => child.finish(0));
      }
      done();
    },
    final(done) {
      done();
      setImmediate(() => child.finish(0));
    },
  });
  latestBridge = child;
  setImmediate(() => child.message({ type: 'ports', inputs, outputs: [] }));
  return child;
};
syncBuiltinESMExports();
const { startServer } = await import('../server/index.js');

async function clientFor(port, viewer = false) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${viewer ? '?viewer=1' : ''}`, {
    origin: `http://127.0.0.1:${port}`,
  });
  const messages = [];
  ws.on('message', (bytes) => messages.push(JSON.parse(bytes.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const wait = async (predicate, timeout = 1500) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const message = messages.find(predicate);
      if (message) return message;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`Expected message did not arrive: ${JSON.stringify(messages)}`);
  };
  return {
    ws,
    messages,
    wait,
    send: (message) => ws.send(JSON.stringify(message)),
    clear: () => {
      messages.length = 0;
    },
  };
}

async function setup({
  inputName,
  inputs = [{ id: 0, name: 'Test MIDI' }],
  rejectOpen = false,
} = {}) {
  milliseconds = 0;
  frozenNow = null;
  initialInputs = inputs;
  failOpen = rejectOpen;
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'luma-server-midi-'));
  if (inputName)
    await fs.writeFile(path.join(dataDir, 'connection.json'), JSON.stringify({ inputName }));
  const app = await startServer({ port: 0, dataDir });
  const { port } = app;
  const bridge = latestBridge,
    client = await clientFor(port),
    clients = [client];
  const hello = await client.wait((message) => message.type === 'hello');
  const connect = async (viewer) => {
    const next = await clientFor(port, viewer);
    clients.push(next);
    return next;
  };
  const close = async () => {
    await app.close();
    for (const connection of clients) connection.ws.terminate();
    bridge?.finish(0);
    for (const name of await fs.readdir(dataDir)) {
      const file = path.resolve(dataDir, name);
      assert.equal(path.dirname(file), dataDir);
      assert.equal(
        (await fs.stat(file)).isFile(),
        true,
        'Tests must only create flat disposable files',
      );
      await fs.unlink(file);
    }
    await fs.rmdir(dataDir);
  };
  const record = async () => {
    client.clear();
    client.send({ type: 'record', withAudio: false, name: 'MIDI regression' });
    await client.wait((message) => message.type === 'state' && message.recording);
  };
  const stop = async () => {
    client.clear();
    client.send({ type: 'stopRecord' });
    return (await client.wait((message) => message.type === 'saved')).session;
  };
  return { app, client, bridge, hello, connect, close, record, stop, port, dataDir };
}

test.after(() => {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  globalThis.performance = originalPerformance;
});
const windows = { skip: process.platform !== 'win32' };
function liveFrom(hello) {
  const model = new MidiPerformance({ notePolicy: hello.notePolicy });
  for (const event of hello.history) model.ingest(event);
  return model;
}

test(
  'panic is recorded, survives reconnect, and does not inflate the physical MIDI counter',
  windows,
  async () => {
    const s = await setup();
    try {
      await s.record();
      s.bridge.message({ type: 'midi', data: [176, 64, 127] });
      s.bridge.message({ type: 'midi', data: [144, 60, 95] });
      s.bridge.message({ type: 'midi', data: [128, 60, 0] });
      const lastPhysical = s.app.state().lastMidi;
      s.client.clear();
      s.client.send({ type: 'panic' });
      await s.client.wait((message) => message.type === 'panic');
      assert.equal(s.app.state().midiCount, 3);
      assert.deepEqual(s.app.state().lastMidi, lastPhysical);
      assert.equal(
        s.client.messages.filter((message) => message.type === 'midi' && message.synthetic).length,
        32,
      );
      const session = await s.stop();
      assert.ok(session.events.some((event) => event.data[0] === 176 && event.data[1] === 120));
      const recorded = MidiPerformance.fromJSON(session);
      assert.equal(recorded.notes.length, 1);
      assert.ok(recorded.notes[0].end < session.duration);
      const reconnect = await s.connect(true),
        hello = await reconnect.wait((message) => message.type === 'hello');
      assert.equal(liveFrom(hello).activeAt(hello.serverTime).length, 0);
      assert.equal(hello.midiCount, 3);
    } finally {
      await s.close();
    }
  },
);

test(
  'disconnect and device-loss resets close sounding notes in the saved take',
  windows,
  async () => {
    for (const cause of ['command', 'status', 'exit']) {
      const s = await setup();
      try {
        s.client.send({ type: 'connect', inputId: 0 });
        await s.client.wait((message) => message.type === 'state' && message.midiStatus.connected);
        await s.record();
        s.bridge.message({ type: 'midi', data: [145, 67, 100] });
        s.bridge.message({ type: 'midi', data: [177, 64, 127] });
        s.client.clear();
        if (cause === 'command') s.client.send({ type: 'disconnect' });
        if (cause === 'status')
          s.bridge.message({ type: 'status', connected: false, reason: 'device-removed' });
        if (cause === 'exit') s.bridge.finish(1);
        await s.client.wait((message) => message.type === 'panic');
        assert.equal(s.app.state().midiCount, 2, cause);
        const session = await s.stop(),
          model = MidiPerformance.fromJSON(session);
        assert.ok(model.notes[0].end < session.duration, cause);
        assert.ok(
          session.events.some((event) => event.data[0] === 177 && event.data[1] === 120),
          cause,
        );
      } finally {
        await s.close();
      }
    }
  },
);

test(
  'reconnect restores held and pedal-sustained repeated pitches after more than 20 seconds',
  windows,
  async () => {
    const s = await setup();
    try {
      s.bridge.message({ type: 'midi', data: [176, 64, 127] });
      s.bridge.message({ type: 'midi', data: [144, 60, 80] });
      s.bridge.message({ type: 'midi', data: [128, 60, 0] });
      s.bridge.message({ type: 'midi', data: [144, 60, 110] });
      s.bridge.message({ type: 'midi', data: [145, 67, 75] });
      milliseconds += 21000;
      s.bridge.message({ type: 'midi', data: [177, 1, 30] }); // Forces history pruning.
      const reconnect = await s.connect(true),
        hello = await reconnect.wait((message) => message.type === 'hello');
      const model = liveFrom(hello),
        sounding = model.activeAt(hello.serverTime);
      assert.equal(sounding.length, 3);
      assert.equal(model.activeAt(hello.serverTime, true).length, 2);
      assert.deepEqual(
        sounding.filter((note) => note.note === 60).map((note) => note.velocity),
        [80, 110],
      );
      assert.equal(model.pedals[0], true);
      model.ingest({ t: hello.serverTime + 1, data: [176, 64, 0] });
      assert.equal(model.activeAt(hello.serverTime + 1).length, 2);
    } finally {
      await s.close();
    }
  },
);

test(
  'recording begun during a long pedal tail seeds sounding and physical state correctly',
  windows,
  async () => {
    const s = await setup();
    try {
      s.bridge.message({ type: 'midi', data: [176, 64, 127] });
      s.bridge.message({ type: 'midi', data: [144, 60, 80] });
      s.bridge.message({ type: 'midi', data: [128, 60, 0] });
      s.bridge.message({ type: 'midi', data: [144, 64, 100] });
      milliseconds += 21000;
      s.bridge.message({ type: 'midi', data: [177, 1, 30] });
      await s.record();
      milliseconds += 1000;
      s.bridge.message({ type: 'midi', data: [176, 64, 0] });
      milliseconds += 1000;
      s.bridge.message({ type: 'midi', data: [128, 64, 0] });
      const session = await s.stop(),
        model = MidiPerformance.fromJSON(session);
      assert.equal(model.activeAt(0.1).length, 2);
      assert.equal(model.activeAt(0.1, true).length, 1);
      assert.deepEqual(
        model.activeAt(1.5).map((note) => note.note),
        [64],
      );
      assert.equal(model.notes.find((note) => note.note === 60).release, 0);
    } finally {
      await s.close();
    }
  },
);

test(
  'a key release exactly at the bootstrap boundary is emitted once for recording and reconnect',
  windows,
  async () => {
    const s = await setup();
    try {
      frozenNow = originalPerformance.now() + 100000;
      s.bridge.message({ type: 'midi', data: [187, 64, 127] });
      s.bridge.message({ type: 'midi', data: [155, 60, 90] });
      frozenNow += 1000;
      const boundary = frozenNow;
      s.bridge.message({ type: 'midi', data: [155, 60, 0] });
      await s.record();
      frozenNow += 1000;
      const saved = await s.stop();
      assert.deepEqual(
        saved.events.map((event) => event.data),
        [
          [187, 64, 127],
          [155, 60, 90],
          [155, 60, 0],
        ],
      );
      assert.ok(saved.events.every((event) => event.t === 0));
      frozenNow = boundary + 20000;
      const reconnect = await s.connect(true);
      const hello = await reconnect.wait((message) => message.type === 'hello');
      assert.equal(
        hello.history.filter(
          (event) =>
            (event.data[0] & 240) === 128 || ((event.data[0] & 240) === 144 && event.data[2] === 0),
        ).length,
        1,
      );
      const restored = liveFrom(hello);
      assert.equal(restored.activeAt(hello.serverTime).length, 1);
      assert.equal(restored.activeAt(hello.serverTime, true).length, 0);
      frozenNow += 1000;
      s.bridge.message({ type: 'midi', data: [187, 64, 0] });
      const pedalUp = await reconnect.wait(
        (message) => message.type === 'midi' && message.data[1] === 64 && message.data[2] === 0,
      );
      restored.ingest(pedalUp);
      assert.equal(restored.activeAt(pedalUp.t).length, 0);
    } finally {
      await s.close();
      frozenNow = null;
    }
  },
);

test('playback naturally stops at exact duration and seek remains inside the saved take', async () => {
  const s = await setup();
  try {
    const response = await fetch(`http://127.0.0.1:${s.port}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Short take',
        duration: 0.12,
        events: [
          { t: 0, data: [144, 60, 80] },
          { t: 0.1, data: [128, 60, 0] },
        ],
      }),
    });
    const session = await response.json();
    assert.equal(response.status, 200);
    s.client.clear();
    s.client.send({ type: 'play', sessionId: session.id });
    await s.client.wait((message) => message.type === 'state' && message.transport.playing);
    const ended = await s.client.wait(
      (message) =>
        message.type === 'state' &&
        message.transport.sessionId === session.id &&
        !message.transport.playing,
    );
    assert.equal(ended.transport.position, session.duration);
    s.client.clear();
    s.client.send({ type: 'seek', position: 999 });
    const bounded = await s.client.wait((message) => message.type === 'state');
    assert.equal(bounded.transport.position, session.duration);
  } finally {
    await s.close();
  }
});

test('OBS viewer clients cannot mutate recording or visual settings', async () => {
  const s = await setup();
  try {
    const viewer = await s.connect(true);
    await viewer.wait((message) => message.type === 'hello');
    viewer.send({ type: 'settings', settings: { theme: 'violet' } });
    await viewer.wait((message) => message.type === 'notice' && message.kind === 'error');
    assert.equal(s.app.state().settings.theme, 'aurora');
    viewer.clear();
    viewer.send({ type: 'record', withAudio: false });
    await viewer.wait((message) => message.type === 'notice' && message.kind === 'error');
    assert.equal(s.app.state().recording, null);
    viewer.clear();
    viewer.send({ type: 'ping', echo: 123 });
    assert.equal((await viewer.wait((message) => message.type === 'pong')).echo, 123);
  } finally {
    await s.close();
  }
});

test('cross-origin HTTP and WebSocket requests cannot control the localhost service', async () => {
  const s = await setup();
  try {
    const response = await fetch(`http://127.0.0.1:${s.port}/api/state`, {
      headers: { Origin: 'https://untrusted.example' },
    });
    assert.equal(response.status, 403);
    const socket = new WebSocket(`ws://127.0.0.1:${s.port}`, {
      origin: 'https://untrusted.example',
    });
    const outcome = await new Promise((resolve) => {
      socket.once('open', () => resolve('opened'));
      socket.once('error', () => resolve('rejected'));
    });
    socket.terminate();
    assert.equal(outcome, 'rejected');
  } finally {
    await s.close();
  }
});

test(
  'the successful MIDI input name is remembered and a changed numeric port ID reconnects safely',
  windows,
  async () => {
    const first = await setup();
    try {
      first.client.send({ type: 'connect', inputId: 0 });
      await first.client.wait(
        (message) => message.type === 'state' && message.midiStatus.connected,
      );
      let saved;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          saved = JSON.parse(
            await fs.readFile(path.join(first.dataDir, 'connection.json'), 'utf8'),
          );
        } catch {}
        if (saved) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.deepEqual(saved, { inputName: 'Test MIDI' });
    } finally {
      await first.close();
    }
    const restarted = await setup({
      inputName: 'Test MIDI',
      inputs: [
        { id: 0, name: 'Other keyboard' },
        { id: 7, name: 'Test MIDI' },
      ],
    });
    try {
      await restarted.client.wait(
        (message) => ['hello', 'state'].includes(message.type) && message.midiStatus.connected,
      );
      assert.deepEqual(
        restarted.bridge.commands.filter((command) => command.type === 'open'),
        [{ type: 'open', inputId: 7 }],
      );
    } finally {
      await restarted.close();
    }
  },
);

test(
  'remembered MIDI reconnection never guesses a port and never retries a driver error',
  windows,
  async () => {
    for (const scenario of [
      { inputName: 'Missing MIDI', expected: 0 },
      {
        inputName: 'Test MIDI',
        inputs: [
          { id: 0, name: 'Test MIDI' },
          { id: 1, name: 'Test MIDI' },
        ],
        expected: 0,
      },
      { inputName: 'Test MIDI', rejectOpen: true, expected: 1 },
    ]) {
      const s = await setup(scenario);
      try {
        s.client.clear();
        s.client.send({ type: 'refreshPorts' });
        await s.client.wait((message) => message.type === 'state');
        assert.equal(
          s.bridge.commands.filter((command) => command.type === 'open').length,
          scenario.expected,
        );
        assert.equal(s.app.state().midiStatus.connected, false);
      } finally {
        await s.close();
      }
    }
  },
);

test('a failed manual connection is not saved as a preferred MIDI input', windows, async () => {
  const s = await setup({ rejectOpen: true });
  try {
    s.client.send({ type: 'connect', inputId: 0 });
    await s.client.wait(
      (message) => message.type === 'notice' && /device busy/.test(message.message),
    );
    await assert.rejects(fs.readFile(path.join(s.dataDir, 'connection.json')), { code: 'ENOENT' });
  } finally {
    await s.close();
  }
});

test(
  'switching connected MIDI devices clears voices belonging to the old device',
  windows,
  async () => {
    const s = await setup({
      inputs: [
        { id: 0, name: 'First keyboard' },
        { id: 1, name: 'Second keyboard' },
      ],
    });
    try {
      s.client.send({ type: 'connect', inputId: 0 });
      await s.client.wait((message) => message.type === 'state' && message.midiStatus.connected);
      await s.record();
      s.bridge.message({ type: 'midi', data: [144, 60, 100] });
      s.client.clear();
      s.client.send({ type: 'connect', inputId: 1 });
      await s.client.wait((message) => message.type === 'panic');
      const session = await s.stop(),
        model = MidiPerformance.fromJSON(session);
      assert.ok(model.notes[0].end < session.duration);
      assert.equal(s.app.state().midiCount, 1);
    } finally {
      await s.close();
    }
  },
);

test(
  'MIDI clock and system messages do not make a saved performance fail its own importer',
  windows,
  async () => {
    const s = await setup();
    try {
      await s.record();
      for (const data of [[248], [254], [242, 0, 1], [144, 60, 88], [128, 60, 0]])
        s.bridge.message({ type: 'midi', data });
      const session = await s.stop();
      assert.equal(session.events.length, 2);
      assert.equal(s.app.state().midiCount, 2);
      const response = await fetch(`http://127.0.0.1:${s.port}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(session),
      });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).events, session.events);
    } finally {
      await s.close();
    }
  },
);

test('rapid slider changes persist a complete final settings document', async () => {
  const s = await setup();
  try {
    for (let index = 0; index < 25; index++)
      s.client.send({
        type: 'settings',
        settings: { glow: index / 24, secondsVisible: 2 + index / 3 },
      });
    await s.client.wait((message) => message.type === 'state' && message.settings.glow === 1);
    let saved;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const source = await fs.readFile(path.join(s.dataDir, 'settings.json'), 'utf8');
        saved = JSON.parse(source); // Any partial write is a test failure.
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (saved?.glow === 1 && saved?.secondsVisible === 10) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(
      saved.glow,
      1,
      JSON.stringify(s.client.messages.filter((message) => message.type === 'notice')),
    );
    assert.equal(saved.secondsVisible, 10);
    assert.equal(saved.theme, 'aurora');
  } finally {
    await s.close();
  }
});

test(
  'native QPC timestamps retain MIDI timing across delayed bridge delivery',
  windows,
  async () => {
    const s = await setup();
    try {
      await s.record();
      const playedAt = Number(process.hrtime.bigint()) / 1e6;
      await new Promise((resolve) => setTimeout(resolve, 160));
      s.bridge.message({ type: 'midi', data: [144, 60, 100], qpcTimestamp: playedAt });
      const event = await s.client.wait((message) => message.type === 'midi' && !message.synthetic);
      const now = s.app.state().serverTime;
      assert.ok(now - event.t >= 0.14 && now - event.t < 0.4);
      const session = await s.stop();
      assert.ok(
        session.events[0].t < 0.08,
        `Recorded onset should use native time, received ${session.events[0].t}`,
      );
    } finally {
      await s.close();
    }
  },
);

test('queued notes played before panic cannot resurrect a cleared keyboard', windows, async () => {
  const s = await setup();
  try {
    const oldTimestamp = Number(process.hrtime.bigint()) / 1e6;
    s.client.send({ type: 'panic' });
    await s.client.wait((message) => message.type === 'panic');
    s.bridge.message({ type: 'midi', data: [144, 60, 100], qpcTimestamp: oldTimestamp });
    s.bridge.message({ type: 'midi', data: [144, 64, 100], qpcTimestamp: oldTimestamp - 31000 });
    const reconnected = await s.connect(true),
      hello = await reconnected.wait((message) => message.type === 'hello');
    assert.equal(liveFrom(hello).activeAt(hello.serverTime).length, 0);
    assert.equal(hello.midiCount, 0);
  } finally {
    await s.close();
  }
});

test(
  'closing an overlay viewer during sustain does not lose key-up or pedal-up in studio or recording',
  windows,
  async () => {
    const s = await setup();
    try {
      await s.record();
      const overlay = await s.connect(true);
      const overlayHello = await overlay.wait((message) => message.type === 'hello');
      const studioLive = liveFrom(s.hello);
      const overlayLive = liveFrom(overlayHello);
      const onStudio = (bytes) => {
        const event = JSON.parse(bytes);
        if (event.type === 'midi') studioLive.ingest(event);
      };
      const onOverlay = (bytes) => {
        const event = JSON.parse(bytes);
        if (event.type === 'midi') overlayLive.ingest(event);
      };
      s.client.ws.on('message', onStudio);
      overlay.ws.on('message', onOverlay);
      s.bridge.message({ type: 'midi', data: [187, 64, 127] });
      s.bridge.message({ type: 'midi', data: [155, 60, 90] });
      s.bridge.message({ type: 'midi', data: [155, 60, 0] });
      await overlay.wait(
        (message) => message.type === 'midi' && message.data[0] === 155 && message.data[2] === 0,
      );
      assert.equal(studioLive.activeAt(s.app.state().serverTime).length, 1);
      assert.equal(overlayLive.activeAt(s.app.state().serverTime).length, 1);
      await new Promise((resolve) => {
        overlay.ws.once('close', resolve);
        overlay.ws.close();
      });
      // Closing a viewer must not silence a correctly held pedal tail, or modify the take.
      assert.equal(studioLive.activeAt(s.app.state().serverTime).length, 1);
      s.bridge.message({ type: 'midi', data: [187, 64, 0] });
      await s.client.wait(
        (message) => message.type === 'midi' && message.data[0] === 187 && message.data[2] === 0,
      );
      assert.equal(studioLive.activeAt(s.app.state().serverTime).length, 0);
      const saved = await s.stop();
      assert.deepEqual(
        saved.events.map((event) => event.data),
        [
          [187, 64, 127],
          [155, 60, 90],
          [155, 60, 0],
          [187, 64, 0],
        ],
      );
      const restored = MidiPerformance.fromJSON(saved);
      assert.ok(restored.notes[0].release < restored.notes[0].end);
      const reconnect = await s.connect(true),
        hello = await reconnect.wait((message) => message.type === 'hello');
      assert.equal(liveFrom(hello).activeAt(hello.serverTime).length, 0);
    } finally {
      await s.close();
    }
  },
);

test(
  'piano live and replay recover a prior missing key-up through overlay closure without dropping recorded events',
  windows,
  async () => {
    const s = await setup();
    try {
      await s.record();
      const overlay = await s.connect(true);
      await overlay.wait((message) => message.type === 'hello');
      const studio = liveFrom(s.hello);
      s.client.ws.on('message', (bytes) => {
        const event = JSON.parse(bytes);
        if (event.type === 'midi') studio.ingest(event);
      });
      const source = [
        [187, 64, 127],
        [155, 60, 65],
        [155, 60, 95],
        [155, 60, 0],
        [187, 64, 0],
      ];
      s.bridge.message({ type: 'midi', data: source[0] });
      s.bridge.message({ type: 'midi', data: source[1] });
      await overlay.wait((message) => message.type === 'midi' && message.data[0] === 155);
      await new Promise((resolve) => {
        overlay.ws.once('close', resolve);
        overlay.ws.close();
      });
      for (const data of source.slice(2)) s.bridge.message({ type: 'midi', data });
      await s.client.wait(
        (message) => message.type === 'midi' && message.data[0] === 187 && message.data[2] === 0,
      );
      assert.equal(studio.activeAt(s.app.state().serverTime).length, 0);
      assert.equal(s.app.state().midiDiagnostics.heldKeys, 0);
      assert.equal(s.app.state().midiDiagnostics.soundingVoices, 0);
      assert.equal(s.app.state().midiDiagnostics.retriggerRecoveries, 1);
      const diagnostics = await fetch(`http://127.0.0.1:${s.port}/api/midi-diagnostics`).then(
        (response) => response.json(),
      );
      assert.equal(diagnostics.recoveries[0].note, 60);
      assert.deepEqual(diagnostics.recoveries[0].context.at(-1).data, source[2]);
      const saved = await s.stop();
      assert.equal(saved.notePolicy, 'piano');
      assert.deepEqual(
        saved.events.map((event) => event.data),
        source,
      );
      const replay = MidiPerformance.fromJSON(saved);
      assert.deepEqual(
        replay.notes.map((note) => [note.note, note.velocity]),
        [
          [60, 65],
          [60, 95],
        ],
      );
      assert.ok(replay.notes.every((note) => Number.isFinite(note.end)));
    } finally {
      await s.close();
    }
  },
);
