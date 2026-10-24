// Bounded, explicit diagnostic capture; never runs as part of the test suite.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const pid = Number(process.argv[2]);
if (!Number.isInteger(pid) || pid <= 0) throw new Error('Provide the explicit Kontakt PID.');
const state = await fetch('http://127.0.0.1:3210/api/state').then((r) => r.json());
if (state.recording || state.starting || state.stopping)
  throw new Error('A user recording is active; diagnostic capture cancelled.');
await fs.mkdir('.runtime', { recursive: true });
const output = path.resolve('.runtime', `packet-diagnostic-${Date.now()}.wav`);
const child = spawn(
  'dotnet',
  [
    path.resolve('native-audio/bin/Release/net9.0-windows/ProcessAudio.dll'),
    '--pid',
    String(pid),
    '--output',
    output,
    '--seconds',
    '6',
  ],
  { windowsHide: true },
);
let stdout = '',
  stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});
const monitor = setInterval(async () => {
  try {
    const current = await fetch('http://127.0.0.1:3210/api/state').then((r) => r.json());
    if (current.recording || current.starting || current.stopping) child.stdin.end('stop\n');
  } catch {
    child.stdin.end('stop\n');
  }
}, 1000);
const timeout = setTimeout(() => child.stdin.end('stop\n'), 12000);
const forceTimeout = setTimeout(() => child.kill(), 16000);
try {
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  const events = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  await fs.writeFile(output + '.json', JSON.stringify({ code, stderr, events }, null, 2));
  console.log(
    JSON.stringify(
      {
        output,
        code,
        stderr,
        ready: events.find((e) => e.type === 'ready'),
        stopped: events.find((e) => e.type === 'stopped'),
        errors: events.filter((e) => e.type === 'error'),
      },
      null,
      2,
    ),
  );
  if (code !== 0) process.exitCode = 1;
} finally {
  clearInterval(monitor);
  clearTimeout(timeout);
  clearTimeout(forceTimeout);
  child.stdin.end();
}
