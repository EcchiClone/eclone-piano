import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { projectPaths } from '../../shared/paths.cjs';
import assert from 'node:assert/strict';

// This smoke test enumerates devices and validates rejection paths. It never
// opens a real input, synthesizes a note, or changes any external application's settings.
const script = projectPaths().midiScript;
const child = spawn(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
  {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
const events = [];
let stderr = '';
child.stderr.setEncoding('utf8').on('data', (text) => {
  stderr += text;
});
const lines = createInterface({ input: child.stdout });
const pending = new Set();
lines.on('line', (line) => {
  let event;
  try {
    event = JSON.parse(line.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`Non-JSON bridge output: ${line}`);
  }
  events.push(event);
  for (const waiter of pending) {
    if (waiter.predicate(event)) {
      pending.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  }
});
function waitFor(predicate, timeout = 15000) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      pending.delete(waiter);
      reject(
        new Error(`Bridge response timed out. stderr=${stderr}; events=${JSON.stringify(events)}`),
      );
    }, timeout);
    pending.add(waiter);
  });
}
function send(command) {
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

try {
  const ready = await waitFor((event) => event.type === 'ready' || event.code === 'bridge-startup');
  assert.equal(ready.type, 'ready', ready.message);
  assert.equal(ready.protocol, 1);
  const ports = await waitFor((event) => event.type === 'ports');
  assert.ok(Array.isArray(ports.inputs));
  assert.ok(Array.isArray(ports.outputs));
  assert.ok(
    ports.inputs.every((port) => Number.isInteger(port.id) && typeof port.name === 'string'),
  );
  assert.ok(
    ports.outputs.every((port) => Number.isInteger(port.id) && typeof port.name === 'string'),
  );
  send({ type: 'open', inputId: -1, requestId: 'invalid-input' });
  assert.equal((await waitFor((event) => event.requestId === 'invalid-input')).type, 'error');
  send({ type: 'send', outputId: -1, data: [144, 60, 100], requestId: 'invalid-output' });
  assert.equal((await waitFor((event) => event.requestId === 'invalid-output')).type, 'error');
  if (ports.outputs.length) {
    // Validation happens before opening an output, including this real device ID.
    for (const [name, data] of Object.entries({
      'truncated-note': [144, 60],
      'invalid-velocity': [144, 60, 128],
      'fractional-note': [144, 60.5, 100],
      'sysex-rejected': [240, 1, 2],
      'missing-data': null,
    })) {
      send({ type: 'send', outputId: ports.outputs[0].id, data, requestId: name });
      assert.equal((await waitFor((event) => event.requestId === name)).type, 'error');
    }
  }
  send({ type: 'unknown', requestId: 'unknown' });
  assert.equal((await waitFor((event) => event.requestId === 'unknown')).type, 'error');
  send({ type: 'ports', requestId: 'enumeration' });
  assert.equal((await waitFor((event) => event.requestId === 'enumeration')).type, 'ack');
  send({ type: 'panic', requestId: 'panic' });
  assert.equal((await waitFor((event) => event.requestId === 'panic')).type, 'ack');
  send({ type: 'close', requestId: 'close' });
  assert.equal((await waitFor((event) => event.requestId === 'close')).type, 'ack');
  send({ type: 'quit', requestId: 'quit' });
  assert.equal((await waitFor((event) => event.requestId === 'quit')).type, 'ack');
  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(exitCode, 0, stderr);
  console.log(
    JSON.stringify({ passed: true, inputs: ports.inputs, outputs: ports.outputs }, null, 2),
  );
} finally {
  for (const waiter of pending) clearTimeout(waiter.timer);
  lines.close();
  if (child.exitCode === null) child.kill();
}
