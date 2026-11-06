import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { projectPaths } from '../../shared/paths.cjs';

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Build on Windows x64.');
const { root } = projectPaths();
const work = path.join(root, '.runtime', 'distribution');
const stage = path.join(work, 'stage');
const cache = path.join(work, 'cache');
const licenses = path.join(stage, 'licenses');
const sources = path.join(work, 'sources');
const lock = JSON.parse(await fs.readFile(new URL('./media-lock.json', import.meta.url)));
await Promise.all([cache, licenses, sources].map((dir) => fs.mkdir(dir, { recursive: true })));
async function hash(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function download(url, file, expected) {
  try {
    if (!expected || (await hash(file)) === expected) {
      await fs.access(file);
      return;
    }
  } catch {}
  const response = await fetch(url, { headers: { 'User-Agent': 'eclone-piano-build' } });
  if (!response.ok) throw new Error(`Download ${response.status}: ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  if (expected && (await hash(file)) !== expected) throw new Error('Checksum mismatch: ' + file);
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
await download(lock.url, path.join(cache, 'ffmpeg.zip'), lock.sha256);
const unpacked = path.join(work, 'ffmpeg-input');
try {
  await fs.access(path.join(unpacked, lock.name.replace(/\.zip$/, '')));
} catch {
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath ${quote(path.join(cache, 'ffmpeg.zip'))} -DestinationPath ${quote(unpacked)} -Force`,
  ]);
}
const input = path.join(unpacked, lock.name.replace(/\.zip$/, ''));
const media = path.join(stage, 'media');
await fs.mkdir(media, { recursive: true });
for (const name of await fs.readdir(path.join(input, 'bin'))) {
  if (name !== 'ffplay.exe')
    await fs.copyFile(path.join(input, 'bin', name), path.join(media, name));
}
await fs.copyFile(path.join(input, 'LICENSE.txt'), path.join(licenses, 'FFmpeg-LGPL-3.0.txt'));
await download(
  'https://raw.githubusercontent.com/FFmpeg/FFmpeg/8dca1586f4/COPYING.GPLv3',
  path.join(licenses, 'GPL-3.0.txt'),
);
await download(lock.sourceUrl, path.join(sources, 'FFmpeg-8dca1586f4.tar.gz'));
await download(lock.buildSourceUrl, path.join(sources, 'FFmpeg-Builds.tar.gz'));
await fs.writeFile(
  path.join(sources, 'README.txt'),
  `Unmodified FFmpeg LGPL shared binaries from ${lock.url}\nFFmpeg source: ${lock.sourceUrl}\nOriginal build scripts, patches and dependency versions: ${lock.buildSourceUrl}\nThe build scripts identify the upstream sources of linked third-party components.\n`,
);
await fs.writeFile(path.join(sources, 'media-lock.json'), JSON.stringify(lock, null, 2));
const audio = path.join(stage, 'native', 'audio');
await run('dotnet', [
  'publish',
  'native/audio',
  '-c',
  'Release',
  '-r',
  'win-x64',
  '--self-contained',
  'true',
  '-p:RuntimeFrameworkVersion=9.0.21',
  '-p:PublishSingleFile=false',
  '-p:DebugType=None',
  '-o',
  audio,
]);
await run(path.join(audio, 'ProcessAudio.exe'), ['--self-test']);
await run(path.join(media, 'ffmpeg.exe'), ['-version']);
await fs.copyFile(path.join(root, 'LICENSE'), path.join(licenses, 'EClone-Piano-MIT.txt'));
await fs.copyFile(
  path.join(root, 'node_modules', 'ws', 'LICENSE'),
  path.join(licenses, 'ws-MIT.txt'),
);
await fs.copyFile(
  path.join(root, 'node_modules', 'electron', 'dist', 'LICENSE'),
  path.join(licenses, 'Electron-MIT.txt'),
);
await fs.copyFile(
  path.join(root, 'node_modules', 'electron', 'dist', 'LICENSES.chromium.html'),
  path.join(licenses, 'Chromium-Node-Notices.html'),
);
await download(
  'https://raw.githubusercontent.com/dotnet/runtime/v9.0.21/LICENSE.TXT',
  path.join(licenses, 'dotnet-MIT.txt'),
);
await download(
  'https://raw.githubusercontent.com/dotnet/runtime/v9.0.21/THIRD-PARTY-NOTICES.TXT',
  path.join(licenses, 'dotnet-Notices.txt'),
);
const notice = `EClone Piano · EClone Games\n\nEClone Piano: MIT.\nElectron/Chromium/Node.js: see Electron-MIT.txt and Chromium-Node-Notices.html.\n.NET runtime: MIT and third-party notices.\nws: MIT.\nFFmpeg and FFprobe: unmodified LGPL v3 shared build; see FFmpeg-LGPL-3.0.txt and GPL-3.0.txt.\nFFmpeg is invoked as a separate process; its DLLs in resources/media can be replaced by compatible modified builds.\n\nBinary provenance: ${lock.url}\nSHA-256: ${lock.sha256}\nFFmpeg source: ${lock.sourceUrl}\nBuild scripts/dependency sources: ${lock.buildSourceUrl}\nA source archive is also attached to the EClone Piano GitHub release.\nhttps://github.com/EcchiClone/eclone-piano/releases\n\nKontakt, piano libraries, loopMIDI and device drivers are not included.\n`;
await fs.writeFile(path.join(licenses, 'THIRD-PARTY-NOTICES.txt'), notice);
const { stdout } = await new Promise((resolve, reject) => {
  let stdout = '';
  const child = spawn(path.join(media, 'ffmpeg.exe'), ['-version'], { windowsHide: true });
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.once('error', reject);
  child.once('close', (code) =>
    code === 0 ? resolve({ stdout }) : reject(new Error('Media probe failed')),
  );
});
await fs.writeFile(path.join(licenses, 'FFmpeg-build-configuration.txt'), stdout);
await fs.writeFile(
  path.join(work, 'bundle-manifest.json'),
  JSON.stringify({ media: lock, audioSelfContained: true }, null, 2),
);
console.log('Windows runtime bundle prepared.');
