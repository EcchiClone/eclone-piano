import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { listPackage } from '@electron/asar';
import { pcm16Stereo } from '../helpers/audio.mjs';
import { projectPaths } from '../../shared/paths.cjs';
import { runtimePaths, prepareRuntime } from '../../scripts/lib/runtime.mjs';

await prepareRuntime();
const root = projectPaths().root;
const executablePath =
  process.env.ECLONE_PACKAGED_EXE || path.join(root, 'dist', 'win-unpacked', 'EClone Piano.exe');
const data =
  process.env.ECLONE_PACKAGED_DATA ||
  (await fs.mkdtemp(path.join(runtimePaths.tmp, 'packaged-user-')));
const recordings = path.join(data, 'recordings');
await fs.mkdir(recordings, { recursive: true });
const id = randomUUID();
await fs.writeFile(
  path.join(recordings, id + '.session.json'),
  JSON.stringify({
    version: 1,
    id,
    name: 'Packaged synthetic fixture',
    duration: 1.2,
    createdAt: new Date().toISOString(),
    hasAudio: true,
    events: [
      { t: 0, data: [144, 69, 90] },
      { t: 1, data: [128, 69, 0] },
    ],
  }),
);
await fs.writeFile(
  path.join(recordings, id + '.wav'),
  pcm16Stereo({
    duration: 1.2,
    sampleRate: 44100,
    sample: (t) => Math.sin(t * 2 * Math.PI * 440) * 0.1,
  }),
);
const env = { ...process.env, ECLONE_USER_DATA_DIR: data, DOTNET_MULTILEVEL_LOOKUP: '0' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_PATH;
delete env.DOTNET_ROOT;
delete env.DOTNET_ROOT_X64;
env.PATH = [
  path.join(env.SystemRoot, 'System32'),
  env.SystemRoot,
  path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
].join(';');
const exec = promisify(execFile);
const report = { executablePath, data, errors: [] };
let app;
try {
  app = await electron.launch({ executablePath, args: ['--mute-audio'], env, timeout: 45000 });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.waitForFunction(() => window.ecloneDiagnostics?.().mode === 'live');
  const info = await page.evaluate(() => window.desktop.appInfo());
  assert.equal(info.packaged, true);
  assert.equal(path.resolve(info.recordings), recordings);
  report.app = info;
  const resources = path.join(path.dirname(executablePath), 'resources');
  const archive = listPackage(path.join(resources, 'app.asar'));
  assert.ok(
    !archive.some((file) =>
      /(?:^|[\\/])(recordings|\.runtime|tests|scripts|\.git)(?:[\\/]|$)/.test(file),
    ),
  );
  report.privateFilesExcluded = true;
  const probe = await exec(
    path.join(resources, 'native', 'audio', 'ProcessAudio.exe'),
    ['--self-test'],
    { env, windowsHide: true },
  );
  assert.equal(JSON.parse(probe.stdout.trim()).passed, true);
  const native = await page.evaluate(() => fetch('/api/audio').then((r) => r.json()));
  assert.equal(native.error, undefined, JSON.stringify(native));
  report.native = native;
  await page.locator(`[data-play="${id}"]`).click();
  await page.waitForFunction(() => window.ecloneDiagnostics().mode === 'replay');
  await page.locator('[data-theme="amber"]').click();
  await page.waitForFunction(() => window.ecloneDiagnostics().settings.theme === 'amber');
  await page.locator(`[data-export="${id}"]`).click();
  await page.waitForFunction(
    () => document.getElementById('exportStatus').textContent.includes('MP4'),
    null,
    { timeout: 120000 },
  );
  const video = (await fs.readdir(recordings)).find(
    (file) => file.startsWith(id + '-') && file.endsWith('.mp4'),
  );
  assert.ok(video, await page.locator('#exportStatus').textContent());
  const result = await exec(
    path.join(resources, 'media', 'ffprobe.exe'),
    ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', path.join(recordings, video)],
    { env, windowsHide: true },
  );
  const streams = JSON.parse(result.stdout).streams;
  const track = streams.find((s) => s.codec_type === 'video');
  assert.equal(track.width, 1920);
  assert.equal(track.height, 1080);
  assert.equal(Number(track.nb_read_frames), 72);
  assert.ok(streams.some((s) => s.codec_type === 'audio'));
  report.export = { frames: Number(track.nb_read_frames), fps: track.r_frame_rate, audio: true };
  await page.screenshot({ path: path.join(runtimePaths.screenshots, 'packaged-studio.png') });
  await page.locator('#cancelExport').click();
  const opened = app.waitForEvent('window', {
    predicate: (candidate) => candidate !== page,
    timeout: 10000,
  });
  await page.evaluate(() => window.desktop.overlay());
  const overlay = await opened;
  await overlay.waitForFunction(() => document.body.classList.contains('viewer'));
  await page.evaluate(() => window.desktop.overlay());
  report.overlay = true;
  await app.close();
  app = null;
  const saved = JSON.parse(await fs.readFile(path.join(recordings, 'settings.json'), 'utf8'));
  assert.equal(saved.theme, 'amber');
  report.settingsPersisted = true;
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify({ passed: true, ...report }, null, 2));
} finally {
  await app?.close();
  await fs.writeFile(
    path.join(runtimePaths.reports, 'packaged-report.json'),
    JSON.stringify(report, null, 2),
  );
  if (!process.env.ECLONE_PACKAGED_DATA && report.settingsPersisted) {
    assert.equal(path.dirname(data), runtimePaths.tmp);
    assert.ok(path.basename(data).startsWith('packaged-user-'));
    await fs.rm(data, { recursive: true, force: true });
  }
}
