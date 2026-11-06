import { runtimePaths, prepareRuntime } from '../../scripts/lib/runtime.mjs';
import { pcm16Stereo } from '../helpers/audio.mjs';
import { browserExecutablePath } from '../../scripts/lib/browser.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../../server/index.js';

// This test uses its own generated tone + MIDI fixture and its own local server.
// It never records Kontakt, opens a MIDI input, or uses the user's browser session.
const exec = promisify(execFile);
const id = 'export-smoke-' + randomUUID();
await prepareRuntime();
const recordingRoot = await fs.mkdtemp(path.join(runtimePaths.tmp, 'export-data-'));
const prefix = path.join(recordingRoot, id);
const duration = 2.4;
const onset = 0.35;
const rate = 48000;
const wav = pcm16Stereo({
  duration,
  sampleRate: rate,
  sample: (t) => {
    const envelope = t < onset || t > 1.85 ? 0 : Math.min(1, (t - onset) / 0.01, (1.85 - t) / 0.02);
    return Math.sin(2 * Math.PI * 440 * t) * envelope * 0.25;
  },
});
const session = {
  id,
  version: 1,
  name: 'Generated export smoke fixture',
  createdAt: new Date().toISOString(),
  duration,
  hasAudio: true,
  events: [
    { t: onset, data: [144, 69, 100] },
    { t: 1.85, data: [128, 69, 0] },
  ],
};

let server, browser;
const report = { id, inputDuration: duration, errors: [] };
try {
  await fs.mkdir(recordingRoot, { recursive: true });
  await prepareRuntime();
  await fs.writeFile(prefix + '.wav', wav);
  await fs.writeFile(prefix + '.session.json', JSON.stringify(session));
  const silentId = id + '-silent';
  await fs.writeFile(
    path.join(recordingRoot, silentId + '.session.json'),
    JSON.stringify({
      ...session,
      id: silentId,
      name: 'Generated MIDI-only export fixture',
      duration: 0.8,
      hasAudio: false,
      events: [
        { t: 0.1, data: [144, 60, 100] },
        { t: 0.5, data: [128, 60, 0] },
      ],
    }),
  );
  server = await startServer({
    port: Number(process.env.ECLONE_EXPORT_TEST_PORT || process.env.LUMA_EXPORT_TEST_PORT || 0),
    dataDir: recordingRoot,
  });
  const { port } = server;
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body, headers = {}) =>
    fetch(base + route, { method: 'POST', body, headers });
  const starts = await Promise.all(
    Array.from({ length: 5 }, () =>
      post('/api/export/start', JSON.stringify({ sessionId: id }), {
        'Content-Type': 'application/json',
      }),
    ),
  );
  assert.equal(
    starts.filter((response) => response.ok).length,
    3,
    'Concurrent start requests must respect the three-upload limit.',
  );
  const uploads = await Promise.all(
    starts.filter((response) => response.ok).map((response) => response.json()),
  );
  const probeUpload = uploads[0].uploadId;
  assert.equal(
    (
      await post('/api/export/chunk/' + probeUpload, Buffer.from('test'), {
        'X-Export-Sequence': '1',
      })
    ).status,
    400,
  );
  assert.ok(
    (
      await post('/api/export/chunk/' + probeUpload, Buffer.from('test'), {
        'X-Export-Sequence': '0',
      })
    ).ok,
  );
  for (const upload of uploads) assert.ok((await post('/api/export/cancel/' + upload.uploadId)).ok);
  await assert.rejects(fs.stat(`${prefix}-${probeUpload}.webm`), { code: 'ENOENT' });
  report.uploadProtocol = 'concurrency, sequence and cancellation passed';
  const h264Body = {
    sessionId: id,
    format: 'h264',
    fps: 60,
    totalFrames: Math.ceil(duration * 60),
  };
  assert.equal(
    (
      await post('/api/export/start', JSON.stringify({ ...h264Body, totalFrames: 1 }), {
        'Content-Type': 'application/json',
      })
    ).status,
    400,
    'The server must independently enforce every expected frame.',
  );
  const incompleteSource = path.join(recordingRoot, id + '-incomplete.h264');
  await exec('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=1920x1080:r=60',
    '-frames:v',
    String(h264Body.totalFrames - 1),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'h264',
    incompleteSource,
  ]);
  const incompleteStart = await post('/api/export/start', JSON.stringify(h264Body), {
    'Content-Type': 'application/json',
  });
  assert.equal(incompleteStart.status, 200);
  const incompleteUpload = (await incompleteStart.json()).uploadId;
  assert.equal(
    (
      await post('/api/export/chunk/' + incompleteUpload, await fs.readFile(incompleteSource), {
        'X-Export-Sequence': '0',
      })
    ).status,
    200,
  );
  const incompleteFinish = await post('/api/export/finish/' + incompleteUpload);
  assert.equal(incompleteFinish.status, 400, 'An export missing even one encoded frame must fail.');
  assert.match((await incompleteFinish.json()).error, /144.*143/);
  await assert.rejects(fs.stat(`${prefix}-${incompleteUpload}.h264`), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${prefix}-${incompleteUpload}.mp4`), { code: 'ENOENT' });
  await fs.unlink(incompleteSource);
  report.h264Validation =
    'Incorrect declared count and 143/144 decoded frames rejected; partial files cleaned';
  browser = await chromium.launch({
    executablePath: browserExecutablePath(),
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  // HiDPI is intentional: exports must be 1080p regardless of Windows scaling.
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.addInitScript(() => {
    const NativeVideoFrame = window.VideoFrame;
    window.exportFrameStats = [];
    window.VideoFrame = class extends NativeVideoFrame {
      constructor(...args) {
        super(...args);
        window.exportFrameStats.push({
          width: this.codedWidth,
          height: this.codedHeight,
          timestamp: this.timestamp,
        });
      }
    };
  });
  await page.goto(base);
  await page.waitForFunction(() => window.ecloneDiagnostics()?.mode === 'live');
  await page.locator('#useCustomColor').check();
  await page.locator('#customColor').fill('#ff8866');
  await page.locator('#hitStrength').evaluate((element) => {
    element.value = '0.8';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(
    () =>
      window.ecloneDiagnostics().settings.customColor === '#ff8866' &&
      window.ecloneDiagnostics().settings.useCustomColor &&
      window.ecloneDiagnostics().settings.hitStrength === 0.8,
  );
  await page.locator('#playbackVolume').evaluate((element) => {
    element.value = '0';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator(`[data-export="${id}"]`).click();
  await page.waitForFunction(() => !document.getElementById('exportDownload').hidden, null, {
    timeout: 90000,
  });
  const generatedFrames = await page.evaluate(() => window.exportFrameStats);
  report.capture = { ...generatedFrames[0], frames: generatedFrames.length };
  assert.equal(
    generatedFrames.length,
    h264Body.totalFrames,
    'Offline export must render every scheduled frame.',
  );
  for (let index = 0; index < generatedFrames.length; index++) {
    assert.equal(generatedFrames[index].width, 1920);
    assert.equal(generatedFrames[index].height, 1080);
    assert.equal(generatedFrames[index].timestamp, Math.round((index * 1_000_000) / 60));
  }
  report.resultUrl = await page.locator('#exportDownload').getAttribute('href');
  report.exportStatus = await page.locator('#exportStatus').innerText();
  assert.ok(report.resultUrl.endsWith('.mp4'), 'Expected local FFmpeg to create MP4.');
  const outputPath = path.join(recordingRoot, path.basename(report.resultUrl));
  const { stdout } = await exec(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath],
    { maxBuffer: 1024 * 1024 },
  );
  const metadata = JSON.parse(stdout);
  const video = metadata.streams.find((stream) => stream.codec_type === 'video');
  const audio = metadata.streams.find((stream) => stream.codec_type === 'audio');
  report.video = video && {
    width: video.width,
    height: video.height,
    codec: video.codec_name,
    frameRate: video.avg_frame_rate,
    duration: video.duration,
  };
  report.audio = audio && {
    codec: audio.codec_name,
    sampleRate: audio.sample_rate,
    channels: audio.channels,
    duration: audio.duration,
  };
  assert.ok(video && audio, 'MP4 must contain video and original audio.');
  assert.equal(video.avg_frame_rate, '60/1', 'MP4 must use a stable 60 fps editing timeline.');
  const { stdout: timestamps } = await exec('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=best_effort_timestamp_time',
    '-of',
    'csv=p=0',
    outputPath,
  ]);
  const pts = timestamps
    .trim()
    .split(/\r?\n/)
    .map((line) => Number.parseFloat(line))
    .filter(Number.isFinite);
  assert.equal(
    pts.length,
    h264Body.totalFrames,
    'Actual decoded frames must match the planned frame count.',
  );
  for (let index = 0; index < pts.length; index++)
    assert.ok(Math.abs(pts[index] - index / 60) < 0.00001);
  const { stdout: frameHashes } = await exec(
    'ffmpeg',
    ['-v', 'error', '-ss', '0.5', '-i', outputPath, '-t', '1', '-an', '-f', 'framemd5', 'pipe:1'],
    { maxBuffer: 1024 * 1024 },
  );
  const hashes = frameHashes
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(',').at(-1).trim());
  const duplicates = hashes.slice(1).filter((hash, index) => hash === hashes[index]).length;
  report.cadence = {
    decodedFrames: pts.length,
    actualFps: (pts.length - 1) / (pts.at(-1) - pts[0]),
    animatedFrames: hashes.length,
    consecutiveDuplicates: duplicates,
  };
  assert.ok(hashes.length >= 59);
  assert.equal(
    duplicates,
    0,
    'A moving sustained note must advance in every frame, rather than cloning low-FPS captures.',
  );
  assert.ok(
    Math.abs(Number(video.duration) - duration) < 0.05,
    'Video track must cover the whole performance.',
  );
  assert.ok(
    Math.abs(Number(audio.duration) - duration) < 0.05,
    'Audio track must cover the whole performance.',
  );
  const { stdout: pcm } = await exec(
    'ffmpeg',
    ['-v', 'error', '-i', outputPath, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
  );
  let sum = 0,
    peak = 0,
    firstSound = null;
  for (let i = 0; i + 4 <= pcm.length; i += 4) {
    const value = pcm.readFloatLE(i);
    sum += value * value;
    peak = Math.max(peak, Math.abs(value));
    if (firstSound === null && Math.abs(value) > 0.02) firstSound = i / 4 / rate;
  }
  report.audioAnalysis = {
    rms: Math.sqrt(sum / (pcm.length / 4)),
    peak,
    firstSound,
    expectedOnset: onset,
  };
  assert.ok(report.audioAnalysis.rms > 0.05, 'Exported original audio must not be silent.');
  assert.ok(
    Math.abs(firstSound - onset) < 0.15,
    'Audio onset must stay aligned with the MIDI timeline.',
  );
  assert.ok(
    Math.abs(Number(metadata.format.duration) - duration) < 0.4,
    'Export duration must match the performance.',
  );
  report.remainingOffscreenCanvases = await page.locator('body > canvas').count();
  assert.equal(report.remainingOffscreenCanvases, 0, 'Export must release its offscreen canvas.');
  assert.deepEqual(report.errors, []);
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);

  // A second export creates a distinct file and can be cancelled after chunking.
  await page.locator('#cancelExport').click();
  const startResponse = page.waitForResponse(
    (response) => response.url().endsWith('/api/export/start') && response.ok(),
  );
  await page.locator(`[data-export="${id}"]`).click();
  const cancelUpload = (await (await startResponse).json()).uploadId;
  await page.waitForResponse(
    (response) => response.url().endsWith('/api/export/chunk/' + cancelUpload) && response.ok(),
  );
  await page.locator('#cancelExport').click();
  await page.waitForFunction(
    () =>
      !document.getElementById('exportDialog').open &&
      document.querySelectorAll('body > canvas').length === 0,
  );
  await assert.rejects(fs.stat(`${prefix}-${cancelUpload}.h264`), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${prefix}-${cancelUpload}.mp4`), { code: 'ENOENT' });
  assert.ok(
    (await fs.stat(outputPath)).size > 0,
    'Cancelling a new export must preserve the prior completed video.',
  );
  report.cancelledExportCleaned = true;

  await page.locator(`[data-export="${silentId}"]`).click();
  await page.waitForFunction(() => !document.getElementById('exportDownload').hidden, null, {
    timeout: 90000,
  });
  const silentUrl = await page.locator('#exportDownload').getAttribute('href');
  assert.ok(silentUrl.endsWith('.mp4'), 'MIDI-only recordings must also export as MP4.');
  const { stdout: silentProbe } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-of',
    'json',
    path.join(recordingRoot, path.basename(silentUrl)),
  ]);
  const silentStreams = JSON.parse(silentProbe).streams;
  assert.equal(silentStreams.length, 1);
  assert.equal(silentStreams[0].codec_type, 'video');
  assert.equal(silentStreams[0].avg_frame_rate, '60/1');
  assert.ok(Math.abs(Number(silentStreams[0].duration) - 0.8) < 0.05);
  report.midiOnlyExport = '1080p60 MP4, correct duration, no fake audio track';

  const shutdownUpload = await (
    await post('/api/export/start', JSON.stringify({ sessionId: id }), {
      'Content-Type': 'application/json',
    })
  ).json();
  assert.ok(
    (
      await post('/api/export/chunk/' + shutdownUpload.uploadId, Buffer.from('partial'), {
        'X-Export-Sequence': '0',
      })
    ).ok,
  );
  await browser.close();
  browser = null;
  await server.close();
  server = null;
  await assert.rejects(fs.stat(`${prefix}-${shutdownUpload.uploadId}.webm`), { code: 'ENOENT' });
  report.shutdownCleanedPartial = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.writeFile(
    path.join(runtimePaths.reports, 'export-report.json'),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  await server?.close();
  // These exact fixture files were created by this run; never remove user takes.
  for (const filename of await fs.readdir(recordingRoot)) {
    if (filename.startsWith(id + '.') || filename.startsWith(id + '-'))
      await fs.unlink(path.join(recordingRoot, filename)).catch(() => {});
  }
  if (!recordingRoot.startsWith(runtimePaths.tmp + path.sep + 'export-data-'))
    throw new Error('Unsafe export test path');
  await fs.rm(recordingRoot, { recursive: true, force: true });
}
