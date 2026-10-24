import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const dll = resolve('native-audio/bin/Release/net9.0-windows/ProcessAudio.dll');
const probe = spawnSync('dotnet', [dll, '--probe'], { encoding: 'utf8', windowsHide: true });
assert.equal(probe.status, 0, probe.stderr);
const info = JSON.parse(probe.stdout.trim());
console.log(info);
if (!info.supported || !info.processes.length) {
  console.log('Live capture skipped: compatible Windows and a running Kontakt process are required.');
  process.exit(0);
}
const directory = await mkdtemp(join(tmpdir(), 'piano-process-audio-'));
const output = join(directory, 'smoke.wav');
const child = spawn('dotnet', [dll, '--pid', String(info.processes[0].pid), '--output', output, '--seconds', '1'], { windowsHide: true });
let stdout = '', stderr = '';
child.stdout.on('data', data => { stdout += data; });
child.stderr.on('data', data => { stderr += data; });
const timeout = setTimeout(() => child.kill(), 20000);
try {
  const code = await new Promise(resolve => child.once('exit', resolve));
  console.log(stdout.trim());
  assert.equal(code, 0, stderr || stdout);
  const events = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === 'ready'));
  const stopped = events.find(event => event.type === 'stopped');
  assert.ok(stopped && stopped.durationMs >= 900 && stopped.durationMs < 2000);
  const wav = await readFile(output);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt16LE(22), 2);
  console.log('Process-loopback activation, one-second capture, and finalized WAV passed. Silence is expected when Kontakt is idle.');
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  await unlink(output).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await rmdir(directory);
}
