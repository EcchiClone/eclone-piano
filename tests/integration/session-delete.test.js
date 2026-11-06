import { runtimePaths, prepareRuntime } from '../../scripts/lib/runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { WebSocket } from 'ws';

// Only generated fixtures are moved. Native MIDI and audio helpers are mocked.
const originalSpawn = childProcess.spawn;
const originalExists = fsSync.existsSync;
const originalRename = fs.rename;
const originalReadFile = fs.readFile;
const originalOpen = fs.open;
const originalStat = fs.stat;
const originalCreateReadStream = fsSync.createReadStream;
const children = new Set();
let audioBehavior = {},
  recorder;

function wave(file, finalized = true, sampleRate = 48000) {
  const bytes = Buffer.alloc(44 + 480 * 4);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(finalized ? bytes.length - 8 : 36, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 4, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(finalized ? bytes.length - 44 : 0, 40);
  fsSync.writeFileSync(file, bytes);
}

function fakeChild(onStop) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
    final(done) {
      done();
      onStop?.();
    },
  });
  child.message = (value) => {
    if (child.exitCode === null) child.stdout.write(JSON.stringify(value) + '\n');
  };
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
    child.finish(1);
    return true;
  };
  children.add(child);
  return child;
}

childProcess.spawn = (command, args) => {
  if (command === 'powershell.exe') {
    const child = fakeChild(() => setImmediate(() => child.finish()));
    setImmediate(() => child.message({ type: 'ports', inputs: [], outputs: [] }));
    return child;
  }
  assert.equal(command, 'dotnet', 'Deletion tests must never launch real helpers.');
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
  const behavior = { ...audioBehavior };
  const output = args[args.indexOf('--output') + 1];
  const sampleRate = Number(args[args.indexOf('--sample-rate') + 1]);
  const child = fakeChild(() => {
    if (!behavior.manualStop) setImmediate(() => child.complete());
  });
  child.output = output;
  child.ready = () =>
    child.message({
      type: 'ready',
      startedUnixMs: Date.now(),
      startedMonotonicMs: Number(process.hrtime.bigint()) / 1e6,
      sampleRate,
    });
  child.complete = () => {
    if (child.exitCode !== null) return;
    wave(output, true, sampleRate);
    child.message({ type: 'stopped', frames: 480, peak: 0, silent: true, discontinuities: 0 });
    child.finish();
  };
  wave(output, false, sampleRate);
  recorder = child;
  if (!behavior.manualReady) setImmediate(child.ready);
  return child;
};
fsSync.existsSync = (file) => String(file).endsWith('ProcessAudio.dll') || originalExists(file);
syncBuiltinESMExports();
const { startServer } = await import('../../server/index.js');

async function until(predicate, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Expected state was not reached.');
}

async function setup() {
  audioBehavior = {};
  recorder = null;
  const runtimeRoot = runtimePaths.tmp;
  await prepareRuntime();
  const dataDir = await fs.mkdtemp(path.join(runtimeRoot, 'session-delete-tests-'));
  const app = await startServer({ port: 0, dataDir });
  const { port } = app;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `http://127.0.0.1:${port}` });
  const messages = [];
  ws.on('message', (bytes) => messages.push(JSON.parse(bytes.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    app,
    ws,
    messages,
    dataDir,
    request: (route, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, options),
    send: (value) => ws.send(JSON.stringify(value)),
    wait: (predicate) => until(() => messages.find(predicate)),
    close: async () => {
      fs.rename = originalRename;
      fs.readFile = originalReadFile;
      fs.open = originalOpen;
      fs.stat = originalStat;
      fsSync.createReadStream = originalCreateReadStream;
      syncBuiltinESMExports();
      for (const child of children) if (child.complete) child.complete();
      ws.close();
      await app.close();
      for (const child of children) child.finish();
      const resolved = path.resolve(dataDir);
      assert.ok(
        resolved.startsWith(runtimeRoot + path.sep) &&
          path.basename(resolved).startsWith('session-delete-tests-'),
      );
      await fs.rm(resolved, { recursive: true, force: true });
    },
  };
}

async function fixture(client, { audio = true, id = randomUUID() } = {}) {
  const session = {
    version: 1,
    id,
    name: 'Deletion test fixture',
    createdAt: new Date().toISOString(),
    duration: 10,
    events: [],
    hasAudio: audio,
  };
  const bytes = JSON.stringify(session);
  await fs.writeFile(path.join(client.dataDir, id + '.session.json'), bytes);
  if (audio) wave(path.join(client.dataDir, id + '.wav'));
  return { id, bytes };
}
const remove = (client, id, headers) =>
  client.request('/api/session/' + id, { method: 'DELETE', headers });
const post = (client, route, body) =>
  client.request(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });

test.after(() => {
  childProcess.spawn = originalSpawn;
  fsSync.existsSync = originalExists;
  fs.rename = originalRename;
  fs.readFile = originalReadFile;
  fs.open = originalOpen;
  fs.stat = originalStat;
  fsSync.createReadStream = originalCreateReadStream;
  syncBuiltinESMExports();
});

test('reversibly removes only take JSON/WAV/MID, preserves videos, and stops its replay', async () => {
  const client = await setup();
  try {
    const { id, bytes } = await fixture(client);
    const other = await fixture(client, { audio: false });
    const preserved = [
      id + '.mp4',
      id + '.webm',
      id + '-' + randomUUID() + '.mp4',
      'settings.json',
      id + '.wav.backup',
    ];
    for (const filename of preserved)
      await fs.writeFile(path.join(client.dataDir, filename), 'keep');
    await fs.writeFile(path.join(client.dataDir, id + '.mid'), 'generated midi');
    client.send({ type: 'play', sessionId: id });
    await client.wait((message) => message.type === 'state' && message.transport.sessionId === id);
    const response = await remove(client, id);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true, id, trashed: true });
    await client.wait((message) => message.type === 'deleted' && message.sessionId === id);
    assert.equal(client.app.state().transport.mode, 'live');
    assert.equal(client.app.state().transport.playing, false);
    assert.equal((await client.request('/api/session/' + id)).status, 404);
    const entries = await fs.readdir(path.join(client.dataDir, '.trash'));
    assert.equal(entries.length, 1);
    const trash = path.join(client.dataDir, '.trash', entries[0]);
    assert.equal(await fs.readFile(path.join(trash, id + '.session.json'), 'utf8'), bytes);
    assert.ok((await fs.stat(path.join(trash, id + '.wav'))).size > 44);
    assert.equal(await fs.readFile(path.join(trash, id + '.mid'), 'utf8'), 'generated midi');
    const manifest = JSON.parse(await fs.readFile(path.join(trash, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.files, [id + '.session.json', id + '.wav', id + '.mid']);
    for (const filename of preserved)
      assert.equal(await fs.readFile(path.join(client.dataDir, filename), 'utf8'), 'keep');
    const list = await (await client.request('/api/sessions')).json();
    assert.deepEqual(
      list.map((session) => session.id),
      [other.id],
    );
    assert.equal((await client.request(`/media/.trash/${entries[0]}/${id}.wav`)).status, 400);
  } finally {
    await client.close();
  }
});

test('rejects foreign origins, demo, unsafe IDs and missing takes without moving files', async () => {
  const client = await setup();
  try {
    const { id, bytes } = await fixture(client);
    assert.equal((await remove(client, id, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await remove(client, 'demo')).status, 400);
    assert.equal((await remove(client, 'settings')).status, 400);
    assert.equal((await remove(client, id + '%2f..%2fsettings')).status, 400);
    assert.equal((await remove(client, randomUUID())).status, 404);
    assert.equal(await fs.readFile(path.join(client.dataDir, id + '.session.json'), 'utf8'), bytes);
    await assert.rejects(fs.stat(path.join(client.dataDir, '.trash')), { code: 'ENOENT' });
  } finally {
    await client.close();
  }
});

test('deleting lock rejects duplicate, read, play and export operations including case aliases', async () => {
  const client = await setup();
  let release;
  try {
    const { id } = await fixture(client);
    let entered = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    fs.rename = async (source, destination) => {
      if (source === path.join(client.dataDir, id + '.session.json')) {
        entered = true;
        await gate;
      }
      return originalRename(source, destination);
    };
    const deletion = remove(client, id);
    await until(() => entered);
    assert.equal((await remove(client, id.toUpperCase())).status, 409);
    assert.equal((await client.request('/api/session/' + id.toUpperCase())).status, 409);
    assert.equal((await post(client, '/api/export/start', { sessionId: id })).status, 409);
    client.send({ type: 'play', sessionId: id });
    await client.wait((message) => message.type === 'notice' && /삭제 중/.test(message.message));
    assert.equal(client.app.state().transport.mode, 'live');
    assert.deepEqual(await (await client.request('/api/sessions')).json(), []);
    release();
    assert.equal((await deletion).status, 200);
  } finally {
    release?.();
    await client.close();
  }
});

test('partially failed file move rolls the take back and leaves replay intact', async () => {
  const client = await setup();
  try {
    const { id, bytes } = await fixture(client);
    client.send({ type: 'play', sessionId: id });
    await client.wait((message) => message.type === 'state' && message.transport.sessionId === id);
    fs.rename = async (source, destination) => {
      if (source === path.join(client.dataDir, id + '.wav'))
        throw Object.assign(new Error('Test file locked'), { code: 'EACCES' });
      return originalRename(source, destination);
    };
    assert.equal((await remove(client, id)).status, 400);
    assert.equal(await fs.readFile(path.join(client.dataDir, id + '.session.json'), 'utf8'), bytes);
    assert.ok((await fs.stat(path.join(client.dataDir, id + '.wav'))).size > 44);
    assert.deepEqual(await fs.readdir(path.join(client.dataDir, '.trash')), []);
    assert.equal(client.app.state().transport.sessionId, id);
    assert.equal(
      client.messages.some((message) => message.type === 'deleted'),
      false,
    );
    fs.rename = originalRename;
    assert.equal(
      (await remove(client, id)).status,
      200,
      'Rollback must release the deleting lock.',
    );
  } finally {
    await client.close();
  }
});

test('active export protects source files until cancelled', async () => {
  const client = await setup();
  try {
    const { id } = await fixture(client);
    const start = await post(client, '/api/export/start', { sessionId: id });
    assert.equal(start.status, 200);
    const { uploadId } = await start.json();
    assert.equal((await remove(client, id.toUpperCase())).status, 409);
    assert.ok((await fs.stat(path.join(client.dataDir, id + '.wav'))).size > 44);
    assert.equal((await post(client, '/api/export/cancel/' + uploadId)).status, 200);
    assert.equal((await remove(client, id)).status, 200);
  } finally {
    await client.close();
  }
});

test('export-start lease protects its source while asynchronous output creation is pending', async () => {
  const client = await setup();
  let release;
  try {
    const { id } = await fixture(client);
    let entered = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    fs.open = async (file, ...args) => {
      if (
        String(file).startsWith(path.join(client.dataDir, id + '-')) &&
        String(file).endsWith('.webm')
      ) {
        entered = true;
        await gate;
      }
      return originalOpen(file, ...args);
    };
    const starting = post(client, '/api/export/start', { sessionId: id });
    await until(() => entered);
    assert.equal((await remove(client, id)).status, 409);
    release();
    const { uploadId } = await (await starting).json();
    await post(client, '/api/export/cancel/' + uploadId);
    assert.equal((await remove(client, id)).status, 200);
  } finally {
    release?.();
    await client.close();
  }
});

test('session read lease prevents a take being moved midway through a read', async () => {
  const client = await setup();
  let release;
  try {
    const { id } = await fixture(client, { audio: false });
    let entered = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    fs.readFile = async (file, ...args) => {
      if (file === path.join(client.dataDir, id + '.session.json')) {
        entered = true;
        await gate;
      }
      return originalReadFile(file, ...args);
    };
    const reading = client.request('/api/session/' + id);
    await until(() => entered);
    assert.equal((await remove(client, id)).status, 409);
    release();
    assert.equal((await reading).status, 200);
    assert.equal((await remove(client, id)).status, 200);
  } finally {
    release?.();
    await client.close();
  }
});

test('media lease protects stat-to-open and releases after range, HEAD and invalid-range responses', async () => {
  const client = await setup();
  let release;
  try {
    const { id } = await fixture(client);
    let entered = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    fs.stat = async (file, ...args) => {
      const result = await originalStat(file, ...args);
      if (file === path.join(client.dataDir, id + '.wav')) {
        entered = true;
        await gate;
      }
      return result;
    };
    const reading = client.request('/media/' + id + '.wav', { headers: { Range: 'bytes=44-83' } });
    await until(() => entered);
    assert.equal((await remove(client, id)).status, 409);
    release();
    const response = await reading;
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 40);
    fs.stat = originalStat;
    assert.equal(
      (await client.request('/media/' + id + '.session.json', { method: 'HEAD' })).status,
      200,
    );
    assert.equal(
      (await client.request('/media/' + id + '.wav', { headers: { Range: 'bytes=999999-' } }))
        .status,
      416,
    );
    assert.equal((await remove(client, id)).status, 200);
  } finally {
    release?.();
    await client.close();
  }
});

test('aborted media and read errors close their stream and release deletion leases', async () => {
  const client = await setup();
  try {
    for (const failure of ['abort', 'error']) {
      const { id } = await fixture(client);
      let reader;
      fsSync.createReadStream = (file, ...args) => {
        if (file !== path.join(client.dataDir, id + '.wav'))
          return originalCreateReadStream(file, ...args);
        reader = new PassThrough();
        return reader;
      };
      syncBuiltinESMExports();
      const controller = new AbortController();
      const pending = client.request('/media/' + id + '.wav', { signal: controller.signal });
      await until(() => reader);
      assert.equal((await remove(client, id)).status, 409);
      if (failure === 'abort') {
        reader.write(Buffer.alloc(64));
        const response = await pending;
        controller.abort();
        await assert.rejects(response.arrayBuffer());
      } else {
        reader.destroy(new Error('Injected media read failure'));
        await assert.rejects(pending);
      }
      await until(() => reader.closed);
      assert.equal(
        (await client.request('/api/state')).status,
        200,
        'Read errors must not terminate the server.',
      );
      assert.equal((await remove(client, id)).status, 200);
    }
  } finally {
    await client.close();
  }
});

test('audio-only take is protected throughout startup, recording and finalization', async () => {
  const client = await setup();
  try {
    audioBehavior = { manualReady: true, manualStop: true };
    client.send({ type: 'record', withAudio: true, pid: 123, name: 'Audio-only deletion guard' });
    await until(() => recorder && client.app.state().starting);
    const id = path.basename(recorder.output, '.wav');
    assert.equal((await remove(client, id)).status, 409);
    recorder.ready();
    await until(() => client.app.state().recording?.id === id);
    assert.equal((await remove(client, id)).status, 409);
    client.send({ type: 'stopRecord' });
    await until(() => client.app.state().stopping);
    assert.equal((await remove(client, id)).status, 409);
    recorder.complete();
    const saved = await client.wait(
      (message) => message.type === 'saved' && message.session.id === id,
    );
    assert.equal(saved.session.events.length, 0);
    assert.equal(saved.session.hasAudio, true);
    assert.equal((await remove(client, id)).status, 200);
    await assert.rejects(fs.stat(path.join(client.dataDir, id + '.wav')), { code: 'ENOENT' });
  } finally {
    await client.close();
  }
});
