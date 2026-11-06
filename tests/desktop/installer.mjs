import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectPaths } from '../../shared/paths.cjs';
import { prepareRuntime, runtimePaths } from '../../scripts/lib/runtime.mjs';

await prepareRuntime();
const root = projectPaths().root;
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'))).version;
const exec = promisify(execFile);
const existing = await exec(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object DisplayName -eq 'EClone Piano' | Select-Object -ExpandProperty InstallLocation",
  ],
  { windowsHide: true },
);
assert.equal(
  existing.stdout.trim(),
  '',
  'An existing EClone Piano installation must not be replaced by a test.',
);
const install = await fs.mkdtemp(path.join(runtimePaths.tmp, 'installer-app-'));
const data = await fs.mkdtemp(path.join(runtimePaths.tmp, 'installer-user-'));
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      stdio: 'inherit',
      ...options,
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command}: ${code}`)),
    );
  });
}
const setup = path.join(root, 'dist', `EClone-Piano-${version}-Windows-x64-Setup.exe`);
await run(setup, ['/S', '/D=' + install], { windowsVerbatimArguments: true });
const executable = path.join(install, 'EClone Piano.exe');
await fs.access(executable);
let smokeError;
try {
  await run(process.execPath, ['tests/desktop/packaged.mjs'], {
    env: { ...process.env, ECLONE_PACKAGED_EXE: executable, ECLONE_PACKAGED_DATA: data },
  });
} catch (error) {
  smokeError = error;
}
const uninstallName = (await fs.readdir(install)).find((name) => /^Uninstall.*\.exe$/i.test(name));
assert.ok(uninstallName, 'Installer must provide an uninstaller.');
await run(path.join(install, uninstallName), ['/S']);
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  try {
    await fs.access(executable);
  } catch {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
await assert.rejects(fs.access(executable));
const saved = JSON.parse(await fs.readFile(path.join(data, 'recordings', 'settings.json')));
assert.equal(saved.theme, 'amber', 'Uninstall must preserve saved performances/settings.');
if (smokeError) throw smokeError;
const report = {
  passed: true,
  installed: true,
  packagedSmoke: true,
  uninstalled: true,
  userDataPreserved: true,
};
await fs.writeFile(
  path.join(runtimePaths.reports, 'installer-report.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
// Only the two exact folders created above are ours to remove.
for (const directory of [install, data]) {
  assert.equal(path.dirname(directory), runtimePaths.tmp);
  assert.match(path.basename(directory), /^installer-(app|user)-/);
  await fs.rm(directory, { recursive: true, force: true });
}
