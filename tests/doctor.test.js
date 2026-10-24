import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessEnvironment, collectDiagnostics, formatDiagnostics } from '../scripts/doctor.mjs';

function installed(overrides = {}) {
  return {
    root: 'C:\\Music Projects\\EClone Piano',
    projectVersion: '0.1.5',
    platform: 'win32',
    osRelease: '10.0.19045',
    nodeVersion: '22.15.0',
    nodeArch: 'x64',
    osMachine: 'x86_64',
    wsVersion: '8.18.3',
    electron: {
      exists: true,
      version: '39.2.7',
      path: 'C:\\Music Projects\\EClone Piano\\node_modules\\electron\\dist\\electron.exe',
    },
    dotnetSdks: {
      ok: true,
      stdout: '9.0.313 [C:\\Program Files\\dotnet\\sdk]\n10.0.100 [C:\\Program Files\\dotnet\\sdk]',
    },
    dotnetRuntimes: {
      ok: true,
      stdout:
        'Microsoft.NETCore.App 9.0.10 [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]',
    },
    dotnetInfo: { ok: true, stdout: 'Host:\n  Version: 9.0.10\n  Architecture: x64\n' },
    powershell: { ok: true, stdout: '5.1.19041.6100' },
    audioHelper: true,
    midiBridge: true,
    ffmpeg: { ok: true, stdout: 'ffmpeg version 7.1' },
    ffprobe: { ok: true, stdout: 'ffprobe version 7.1' },
    ...overrides,
  };
}
const feature = (report, id) => report.features.find((entry) => entry.id === id);

test('a supported installed Windows setup is ready without launching any app', () => {
  const report = assessEnvironment(installed());
  assert.equal(report.ready, true);
  assert.ok(report.checks.every((entry) => entry.ok));
  assert.match(formatDiagnostics(report), /EClone Piano 0\.1\.5.*EClone Games/);
});

test('.NET 10 alone does not make the net9 audio helper runnable', () => {
  const report = assessEnvironment(
    installed({
      dotnetSdks: { ok: true, stdout: '10.0.100 [C:\\dotnet\\sdk]' },
      dotnetRuntimes: { ok: true, stdout: 'Microsoft.NETCore.App 10.0.0 [C:\\dotnet\\shared]' },
    }),
  );
  assert.equal(report.checks.find((entry) => entry.id === 'dotnetSdk').ok, true);
  assert.deepEqual(feature(report, 'audio').missing, ['dotnetRuntime']);
  assert.equal(feature(report, 'midi').ready, true);
  assert.equal(feature(report, 'export').ready, true);
});

test('missing export tools do not hide working MIDI, recording or desktop features', () => {
  const report = assessEnvironment(
    installed({ ffprobe: { ok: false, stdout: '', error: 'ENOENT' } }),
  );
  assert.deepEqual(feature(report, 'export').missing, ['ffprobe']);
  for (const id of ['studio', 'midi', 'audio', 'desktop'])
    assert.equal(feature(report, id).ready, true);
  assert.match(formatDiagnostics(report), /FFprobe.*PATH/s);
});

test('ARM or 32-bit Node is not reported ready for the supported native Windows setup', () => {
  for (const override of [
    { nodeArch: 'arm64', osMachine: 'arm64' },
    { nodeArch: 'x64', osMachine: 'arm64' },
    { nodeArch: 'ia32' },
  ]) {
    const report = assessEnvironment(installed(override));
    assert.equal(feature(report, 'studio').ready, true);
    for (const id of ['midi', 'audio', 'desktop'])
      assert.ok(feature(report, id).missing.includes('architecture'));
  }
});

test('a matching .NET 9 version from an x86 or unknown host cannot run the x64 audio helper', () => {
  for (const dotnetInfo of [
    { ok: true, stdout: 'Host:\n  Version: 9.0.10\n  Architecture: x86\n' },
    { ok: true, stdout: 'Host:\n  Version: 9.0.10\n  Architecture: arm64\n' },
    { ok: false, stdout: '', error: 'ENOENT' },
  ]) {
    const report = assessEnvironment(installed({ dotnetInfo }));
    assert.deepEqual(feature(report, 'audio').missing, ['dotnetArchitecture']);
    assert.equal(feature(report, 'midi').ready, true);
  }
});

test('an old Windows build or another OS retains preview but does not promise native capture', () => {
  for (const override of [{ osRelease: '10.0.18363' }, { platform: 'linux', osRelease: '6.8.0' }]) {
    const report = assessEnvironment(installed(override));
    assert.equal(feature(report, 'studio').ready, true);
    assert.equal(feature(report, 'midi').ready, false);
    assert.equal(feature(report, 'audio').ready, false);
    assert.equal(feature(report, 'desktop').ready, false);
  }
});

test('new checkout diagnostics use portable paths and only read-only version commands', async () => {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runtime = path.join(project, '.runtime');
  await fs.mkdir(runtime, { recursive: true });
  const root = await fs.mkdtemp(path.join(runtime, 'doctor spaces '));
  const commands = [];
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.5' }));
    const before = await fs.readdir(root);
    const report = await collectDiagnostics({
      root,
      platform: 'win32',
      osRelease: '10.0.19045',
      nodeVersion: '22.0.0',
      run: async (command, args) => {
        commands.push([command, args]);
        return { ok: false, stdout: '', error: 'ENOENT' };
      },
    });
    assert.equal(report.root, root);
    assert.equal(report.projectVersion, '0.1.5');
    assert.equal(report.ready, false);
    assert.deepEqual(
      await fs.readdir(root),
      before,
      'Doctor must not install, build or write files.',
    );
    assert.deepEqual(
      commands.map(([name, args]) => [name, ...args]),
      [
        ['dotnet', '--list-sdks'],
        ['dotnet', '--list-runtimes'],
        ['dotnet', '--info'],
        ['ffmpeg', '-version'],
        ['ffprobe', '-version'],
        [
          'powershell.exe',
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$PSVersionTable.PSVersion.ToString()',
        ],
      ],
    );
    assert.match(formatDiagnostics(report), /npm ci/);
    assert.match(formatDiagnostics(report), /npm run build:audio/);
  } finally {
    assert.equal(path.dirname(root), runtime);
    assert.ok(path.basename(root).startsWith('doctor spaces '));
    await fs.rm(root, { recursive: true, force: true });
  }
});
