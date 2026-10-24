import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../server/index.js';

// Mock process discovery and intercept record commands before WebSocket delivery.
// No Kontakt process, live connection or audio capture is changed by this test.
const runtime = path.resolve('.runtime');
await fs.mkdir(runtime, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(runtime, 'audio-source-test-data-'));
const report = { cases: [], errors: [] };
const processList = (...pids) => pids.map((pid) => ({ pid, name: 'Kontakt 7' }));
let mock = { processes: processList(19592) },
  probeCalls = 0,
  server,
  browser;
try {
  server = await startServer({ port: 3228, dataDir });
  browser = await chromium.launch({
    executablePath:
      process.env.LUMA_TEST_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.addInitScript(() => {
    window.recordProbe = [];
    const Socket = window.WebSocket;
    window.WebSocket = class extends Socket {
      send(data) {
        let message;
        try {
          message = JSON.parse(data);
        } catch {}
        if (message?.type === 'record') {
          window.recordProbe.push(message);
          // Release the real UI's pending-record guard without starting capture.
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  type: 'notice',
                  kind: 'error',
                  message: '테스트에서 녹음 요청을 가로챘습니다.',
                }),
              }),
            ),
          );
          return;
        }
        return super.send(data);
      }
    };
  });
  await page.route('**/api/audio', async (route) => {
    probeCalls++;
    const response = { ...mock };
    if (response.delay) await new Promise((resolve) => setTimeout(resolve, response.delay));
    if (response.networkError) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: response.status || 200,
      contentType: 'application/json',
      body: JSON.stringify({
        supported: true,
        processes: response.processes || [],
        ...(response.error ? { error: response.error } : {}),
      }),
    });
  });
  await page.goto('http://127.0.0.1:3228');
  await page.waitForFunction(
    () =>
      window.lumaDiagnostics()?.mode === 'live' &&
      document.getElementById('audioProcess').value === '19592',
  );

  const records = () => page.evaluate(() => window.recordProbe);
  const clear = () =>
    page.evaluate(() => {
      window.recordProbe = [];
      document.getElementById('toast').textContent = '';
    });
  async function probeAction(selector) {
    const network = mock.networkError
      ? page.waitForEvent('requestfailed', (request) => request.url().endsWith('/api/audio'))
      : page.waitForResponse((response) => response.url().endsWith('/api/audio'));
    await page.locator(selector).click();
    const result = await network;
    if (result.finished) await result.finished();
    await page.waitForFunction(() => !document.getElementById('recordButton').disabled);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  async function expectRecord(pid) {
    await page.waitForFunction(
      (expected) => window.recordProbe.length === 1 && window.recordProbe[0].pid === expected,
      pid,
    );
    assert.equal((await records()).length, 1);
  }

  mock = { processes: processList(26332) };
  await probeAction('#recordButton');
  await expectRecord(26332);
  assert.equal(await page.locator('#audioProcess').inputValue(), '26332');
  report.cases.push('stale19592 replaced with sole current26332 before record');

  await clear();
  mock = { processes: processList(26332, 30001) };
  await probeAction('#refreshAudio');
  await page.locator('#audioProcess').selectOption('30001');
  mock = { processes: processList(30002, 30001, 26332) };
  await probeAction('#recordButton');
  await expectRecord(30001);
  assert.equal(await page.locator('#audioProcess').inputValue(), '30001');
  report.cases.push('explicit valid choice survives reordered process list');

  await clear();
  mock = { processes: processList(41001, 41002) };
  await probeAction('#recordButton');
  assert.deepEqual(
    await records(),
    [],
    'Multiple replacements must not silently select a process.',
  );
  assert.equal(await page.locator('#audioProcess').inputValue(), '');
  assert.match(await page.locator('#toast').textContent(), /선택|고르/);
  await page.locator('#audioProcess').selectOption('41002');
  await probeAction('#recordButton');
  await expectRecord(41002);
  report.cases.push('multiple replacements require an explicit choice');

  await clear();
  mock = { processes: [] };
  await probeAction('#recordButton');
  assert.deepEqual(
    await records(),
    [],
    'An empty discovery response must not record the stale PID.',
  );
  assert.equal(await page.locator('#audioProcess').inputValue(), '');
  assert.match(await page.locator('#toast').textContent(), /[가-힣]/);
  report.cases.push('empty list rejects stale PID');

  mock = { processes: processList(50001) };
  await probeAction('#refreshAudio');
  assert.equal(await page.locator('#audioProcess').inputValue(), '50001');
  await clear();
  mock = { networkError: true };
  await probeAction('#recordButton');
  assert.deepEqual(
    await records(),
    [],
    'Discovery network failure must not use the prior selected PID.',
  );
  assert.match(await page.locator('#toast').textContent(), /[가-힣]/);
  report.cases.push('network error blocks recording with a Korean explanation');

  mock = { processes: processList(50002) };
  await probeAction('#refreshAudio');
  await clear();
  await probeAction('#recordButton');
  await expectRecord(50002);
  report.cases.push('next refresh recovers from network failure');

  await clear();
  mock = { processes: processList(50002), error: 'Probe failed: HRESULT 0x88890003' };
  await probeAction('#recordButton');
  assert.deepEqual(await records(), [], 'A probe error must not use even a listed stale process.');
  assert.match(
    await page.locator('#toast').textContent(),
    /[가-힣]/,
    'Probe failures need an understandable Korean message.',
  );
  mock = { processes: processList(50003) };
  await probeAction('#refreshAudio');
  await clear();
  await probeAction('#recordButton');
  await expectRecord(50003);
  report.cases.push('probe error blocks recording and later discovery recovers');

  await clear();
  mock = { processes: processList(60001), delay: 250 };
  const before = probeCalls;
  const response = page.waitForResponse((response) => response.url().endsWith('/api/audio'));
  await page.locator('#recordButton').evaluate((button) => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await (await response).finished();
  await expectRecord(60001);
  await page.waitForFunction(() => !document.getElementById('recordButton').disabled);
  assert.equal(probeCalls - before, 1, 'A rapid double click must share one preflight.');
  assert.equal((await records()).length, 1, 'A rapid double click must send one record command.');
  report.cases.push('preflight double click emits exactly one record command');

  assert.equal(server.state().recording, null);
  assert.equal(server.state().starting, false);
  assert.equal(server.state().midiStatus.connected, false);
  assert.equal(
    (await fs.readdir(dataDir)).filter(
      (name) => name.endsWith('.wav') || name.endsWith('.session.json'),
    ).length,
    0,
  );
  assert.deepEqual(report.errors, []);
  report.probeRequests = probeCalls;
  report.actualRecordings = 0;
  console.log('Audio source refresh regression: ' + JSON.stringify(report, null, 2));
} finally {
  await fs.writeFile(
    path.join(runtime, 'audio-source-refresh-report.json'),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  await server?.close();
  if (!dataDir.startsWith(runtime + path.sep + 'audio-source-test-data-'))
    throw new Error('Unsafe test data path');
  await fs.rm(dataDir, { recursive: true, force: true });
}
