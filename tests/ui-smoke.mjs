import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const base = process.env.LUMA_TEST_URL || 'http://127.0.0.1:3210';
const executablePath =
  process.env.LUMA_TEST_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
await fs.mkdir('.runtime', { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const report = { screenshots: [], layouts: [] };
let originalSettings;

async function capture(name, options = {}) {
  const path = `.runtime/${name}.png`;
  await page.screenshot({ path, ...options });
  report.screenshots.push(path);
}
async function diagnostics() {
  return page.evaluate(() => window.lumaDiagnostics());
}
async function waitSettings(key, value) {
  await page.waitForFunction(
    ({ key, value }) => window.lumaDiagnostics()?.settings?.[key] === value,
    { key, value },
  );
}
async function overflow() {
  return page.evaluate(() => ({
    viewport: innerWidth,
    bodyWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('body *')]
      .filter((el) => {
        if (getComputedStyle(el).display === 'none' || el.closest('dialog:not([open])'))
          return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
      })
      .slice(0, 20)
      .map(
        (el) => `${el.tagName.toLowerCase()}#${el.id}.${String(el.className).replaceAll(' ', '.')}`,
      ),
  }));
}
async function seekTo(t) {
  await page.locator('#seek').evaluate((element, value) => {
    element.value = String(value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, t);
  await page.waitForFunction(
    (value) => Math.abs(window.lumaDiagnostics().position - value) < 0.1,
    t,
  );
}

try {
  await page.goto(base);
  await page.waitForFunction(() => window.lumaDiagnostics()?.mode);
  originalSettings = (await diagnostics()).settings;
  await page.locator('#returnLive').click();
  await page.waitForFunction(() => window.lumaDiagnostics().mode === 'live');
  await capture('studio-live-1920');
  report.layouts.push({ name: 'desktop-1920', ...(await overflow()) });
  await page.locator('#demoButton').click();
  await page.waitForFunction(
    () => window.lumaDiagnostics().mode === 'demo' && window.lumaDiagnostics().session === 'demo',
  );
  await page.locator('#playButton').click();
  await seekTo(5);
  await page.locator('[data-direction="up"]').click();
  await waitSettings('direction', 'up');
  await capture('studio-demo-up-1920');
  await page.locator('[data-direction="down"]').click();
  await waitSettings('direction', 'down');
  await capture('studio-demo-down-1920');
  await page.locator('[data-theme="amber"]').click();
  await waitSettings('theme', 'amber');
  assert.equal(await page.locator('#themeName').innerText(), 'Golden');
  await capture('studio-golden-down-1920');
  await page.locator('[data-theme="violet"]').click();
  await waitSettings('theme', 'violet');
  await page.locator('#noteRange').selectOption('37');
  await waitSettings('minNote', 48);
  await capture('studio-violet-37-1920');
  await page.locator('#transparent').check();
  await waitSettings('background', 'transparent');
  report.studioAlpha = await page
    .locator('canvas')
    .evaluate((canvas) => canvas.getContext('2d').getImageData(5, 5, 1, 1).data[3]);
  assert.equal(report.studioAlpha, 0, 'Transparent canvas must preserve alpha.');

  const stage = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  stage.on('pageerror', (error) => errors.push(error.message));
  await stage.goto(base + '/stage?transparent=1');
  await stage.waitForFunction(() => window.lumaDiagnostics()?.session === 'demo');
  report.stage = await stage.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return {
      topAlpha: canvas.getContext('2d').getImageData(5, 5, 1, 1).data[3],
      keyboardAlpha: canvas.getContext('2d').getImageData(500, 1000, 1, 1).data[3],
      width: canvas.width,
      height: canvas.height,
      frameHeight: document.querySelector('.preview-frame').getBoundingClientRect().height,
      headerVisible: getComputedStyle(document.querySelector('.topbar')).display !== 'none',
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  assert.equal(report.stage.topAlpha, 0);
  assert.equal(report.stage.headerVisible, false);
  assert.equal(report.stage.width, 1920);
  assert.equal(report.stage.height, 1080);
  assert.equal(
    report.stage.frameHeight,
    1080,
    'Stage frame must not clip the keyboard below a CSS max-height.',
  );
  assert.equal(
    report.stage.keyboardAlpha,
    255,
    'Keyboard must remain visible over a transparent background.',
  );
  await stage.screenshot({ path: '.runtime/stage-transparent-1920.png', omitBackground: true });
  report.screenshots.push('.runtime/stage-transparent-1920.png');
  const desktopOverlay = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await desktopOverlay.goto(base + '/stage?transparent=1&overlay=1');
  await desktopOverlay.waitForFunction(() => window.lumaDiagnostics()?.session === 'demo');
  await desktopOverlay.bringToFront();
  await desktopOverlay.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  // In the 37-key view, strike glow can reach 150px into the keyboard. Sample
  // its lower edge to measure keyboard opacity independently of the note layer.
  const keyAlpha = () =>
    desktopOverlay.evaluate(
      () => document.querySelector('canvas').getContext('2d').getImageData(500, 1070, 1, 1).data[3],
    );
  const defaultOverlayAlpha = await keyAlpha();
  const overlayPixels = await desktopOverlay.evaluate(() => {
    const canvas = document.querySelector('canvas'),
      ctx = canvas.getContext('2d');
    return {
      settings: window.lumaDiagnostics().settings,
      dimensions: [canvas.width, canvas.height],
      samples: [900, 950, 1000, 1030, 1060, 1070].map((y) => ({
        x: 500,
        y,
        alpha: ctx.getImageData(500, y, 1, 1).data[3],
      })),
    };
  });
  console.log('Overlay alpha diagnostic:', JSON.stringify(overlayPixels));
  await desktopOverlay.screenshot({
    path: '.runtime/overlay-alpha-diagnostic.png',
    omitBackground: true,
  });
  assert.ok(
    defaultOverlayAlpha >= 44 && defaultOverlayAlpha <= 48,
    `Overlay keys must start at18% rather than opaque white; actual alpha=${defaultOverlayAlpha}.`,
  );
  await page.locator('#overlayKeyboardOpacity').evaluate((element) => {
    element.value = '0.08';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitSettings('overlayKeyboardOpacity', 0.08);
  await desktopOverlay.bringToFront();
  await desktopOverlay
    .waitForFunction(() => {
      const alpha = document.querySelector('canvas').getContext('2d').getImageData(500, 1070, 1, 1)
        .data[3];
      return alpha >= 18 && alpha <= 22;
    })
    .catch(async (error) => {
      throw new Error(
        JSON.stringify(
          await desktopOverlay.evaluate(() => ({
            settings: window.lumaDiagnostics().settings,
            alpha: document.querySelector('canvas').getContext('2d').getImageData(500, 1070, 1, 1)
              .data[3],
          })),
        ),
        { cause: error },
      );
    });
  report.overlay = {
    defaultKeyboardAlpha: defaultOverlayAlpha,
    adjustedKeyboardAlpha: await keyAlpha(),
  };
  assert.equal(
    await stage.evaluate(
      () => document.querySelector('canvas').getContext('2d').getImageData(500, 1000, 1, 1).data[3],
    ),
    255,
    'Overlay preferences must not fade the OBS source.',
  );
  await page.locator('#overlayKeyboardOpacity').evaluate((element) => {
    element.value = '0.18';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitSettings('overlayKeyboardOpacity', 0.18);
  await desktopOverlay.close();
  await stage.close();

  await page.locator('#transparent').uncheck();
  await page.locator('[data-theme="aurora"]').click();
  await page.locator('#noteRange').selectOption('88');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(120);
  report.layouts.push({ name: 'desktop-1280', ...(await overflow()) });
  await capture('studio-demo-1280', { fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(120);
  report.layouts.push({ name: 'mobile-390', ...(await overflow()) });
  await capture('studio-demo-mobile', { fullPage: true });
  report.errors = errors;
  assert.deepEqual(errors, []);
  for (const layout of report.layouts)
    assert.ok(layout.bodyWidth <= layout.viewport, `${layout.name}: horizontal overflow`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (originalSettings) {
    await page
      .evaluate(async (settings) => {
        await new Promise((resolve) => {
          const socket = new WebSocket(`ws://${location.host}/`);
          socket.onopen = () => {
            socket.send(JSON.stringify({ type: 'settings', settings }));
            socket.send(JSON.stringify({ type: 'live' }));
            setTimeout(() => {
              socket.close();
              resolve();
            }, 100);
          };
          socket.onerror = resolve;
        });
      }, originalSettings)
      .catch(() => {});
  }
  await fs.writeFile('.runtime/ui-report.json', JSON.stringify(report, null, 2));
  await browser.close();
}
