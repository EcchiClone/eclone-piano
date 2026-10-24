import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes('overlay=1'),
    );
    if (!window.isVisible()) return new Promise((resolve) => window.once('show', resolve));
  });
  const properties = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      url: w.webContents.getURL(),
      alwaysOnTop: w.isAlwaysOnTop(),
      focusable: w.isFocusable(),
      bounds: w.getBounds(),
      background: w.getBackgroundColor(),
      nativeHandle:
        process.platform === 'win32'
          ? w.getNativeWindowHandle().readBigUInt64LE(0).toString()
          : null,
      ownerPid: process.pid,
    })),
  );
  const window = properties.find((w) => w.url.includes('overlay=1'));
  assert.ok(window?.alwaysOnTop);
  assert.equal(window.focusable, false);
  assert.equal(window.bounds.width, displays[0].width);
  assert.equal(window.bounds.height, displays[0].height);
  let nativeStyles = null;
  if (process.platform === 'win32') {
    // Read only the HWND returned by this test's own Electron app. Do not inject
    // mouse input or inspect other applications; physical click-through remains
    // a user acceptance check on the user's Windows desktop.
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LumaOverlayWindowCheck {
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")]
  public static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
$windowHandle = [IntPtr]::new([Int64]${window.nativeHandle})
[uint32]$windowOwner = 0
[void][LumaOverlayWindowCheck]::GetWindowThreadProcessId($windowHandle, [ref]$windowOwner)
if ($windowOwner -ne ${window.ownerPid}) { throw 'The target HWND is not owned by the isolated Electron test app.' }
$styles = [LumaOverlayWindowCheck]::GetWindowLong($windowHandle, -20)
[pscustomobject]@{ transparent = (($styles -band 0x20) -ne 0); layered = (($styles -band 0x80000) -ne 0); noActivate = (($styles -band 0x8000000) -ne 0); ownerPid = $windowOwner } | ConvertTo-Json -Compress
`;
    const result = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10000 },
    );
    nativeStyles = JSON.parse(result.stdout.trim());
    assert.equal(nativeStyles.transparent, true, 'Whole overlay HWND must have WS_EX_TRANSPARENT');
    assert.equal(
      nativeStyles.layered,
      true,
      'Click-through layered HWND must preserve WS_EX_LAYERED',
    );
    assert.equal(nativeStyles.noActivate, true, 'Overlay must not activate on pointer interaction');
  }
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
  console.log(
    JSON.stringify(
      { passed: true, displays, overlay: window, nativeStyles, layout, pixels },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
