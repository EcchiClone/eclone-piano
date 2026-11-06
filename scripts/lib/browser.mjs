import { existsSync } from 'node:fs';

// One browser selection policy for UI, pixel, export and documentation checks.
export function browserExecutablePath(override) {
  const configured = override || process.env.ECLONE_TEST_BROWSER || process.env.LUMA_TEST_BROWSER;
  if (configured) return configured;
  if (process.platform === 'win32') {
    for (const candidate of [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ])
      if (existsSync(candidate)) return candidate;
  }
  return undefined; // Use Playwright's installed Chromium on other setups.
}
