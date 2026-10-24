import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

await fs.mkdir('.runtime', { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.lumaDiagnostics?.().mode === 'live');
  assert.equal(await page.title(), 'Luma Piano — 연주를 빛으로');
  const displays = await page.evaluate(() => window.desktop.displays());
  assert.ok(displays.length > 0);
  await page.screenshot({ path: '.runtime/desktop-studio.png' });
  await page.evaluate((id) => window.desktop.overlay(id), displays[0].id);
  const overlay = await app.waitForEvent('window', {
    predicate: (p) => p !== page,
    timeout: 10000,
  });
  await overlay.waitForFunction(() => document.body.classList.contains('viewer'));
  const properties = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      url: w.webContents.getURL(),
      alwaysOnTop: w.isAlwaysOnTop(),
      focusable: w.isFocusable(),
      bounds: w.getBounds(),
      background: w.getBackgroundColor(),
    })),
  );
  const window = properties.find((w) => w.url.includes('overlay=1'));
  assert.ok(window?.alwaysOnTop);
  assert.equal(window.focusable, false);
  assert.equal(window.bounds.width, displays[0].width);
  assert.equal(window.bounds.height, displays[0].height);
  const layout = await overlay.evaluate(() => ({
    height: document.querySelector('.preview-frame').getBoundingClientRect().height,
    viewport: innerHeight,
    uiHidden: getComputedStyle(document.querySelector('.topbar')).display === 'none',
  }));
  assert.equal(layout.height, layout.viewport);
  assert.equal(layout.uiHidden, true);
  const pixels = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('overlay=1'),
    );
    const img = await w.webContents.capturePage();
    const b = img.toBitmap(),
      s = img.getSize();
    return {
      width: s.width,
      height: s.height,
      cornerAlpha: b[3],
      keyboardAlpha: b[(s.width * (s.height - 30) + 20) * 4 + 3],
    };
  });
  assert.equal(pixels.cornerAlpha, 0, 'Overlay window itself must preserve transparent pixels');
  assert.ok(pixels.keyboardAlpha > 0, 'Overlay keyboard must be visible');
  const closed = overlay.waitForEvent('close');
  await page.evaluate(() => window.desktop.overlay());
  await closed;
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  console.log(JSON.stringify({ passed: true, displays, overlay: window, layout, pixels }, null, 2));
} finally {
  await app.close();
}
