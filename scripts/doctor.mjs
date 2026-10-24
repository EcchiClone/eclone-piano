import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runCommand(command, args) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 512 * 1024,
        ...(command === 'dotnet'
          ? { env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en-US' } }
          : {}),
      },
      (error, stdout) => {
        resolve({ ok: !error, stdout: stdout || '', error: error?.code || '' });
      },
    );
  });
}
async function exists(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
async function packageInfo(root, name) {
  try {
    return JSON.parse(
      await fs.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
    );
  } catch {
    return null;
  }
}

export function assessEnvironment(evidence) {
  const checks = [];
  const add = (id, label, ok, detail, fix) =>
    checks.push({ id, label, ok: !!ok, detail, ...(ok ? {} : { fix }) });
  const nodeMajor = Number(evidence.nodeVersion.split('.')[0]);
  const [major, minor, build] = evidence.osRelease.split('.').map(Number);
  const windows =
    evidence.platform === 'win32' &&
    (major > 10 || (major === 10 && (minor > 0 || build >= 19041)));
  add(
    'node',
    'Node.js 22 이상',
    nodeMajor >= 22,
    evidence.nodeVersion,
    'Node.js 22 이상을 설치하고 터미널을 다시 여세요.',
  );
  add(
    'windows',
    'Windows 10 2004 이상 / Windows 11 (버전 기준)',
    windows,
    `${evidence.platform} ${evidence.osRelease}`,
    '실시간 Windows MIDI·프로세스 녹음·데스크톱 오버레이는 지원되는 Windows에서 실행하세요.',
  );
  add(
    'architecture',
    'Windows x64 / Node.js x64',
    evidence.nodeArch === 'x64' && /^(x86_64|amd64)$/i.test(evidence.osMachine),
    `OS ${evidence.osMachine || '알 수 없음'} · Node.js ${evidence.nodeArch || '알 수 없음'}`,
    '지원 대상은 x64 Windows와 x64 Node.js입니다. Windows ARM·32비트 실행 환경은 검증하지 않았습니다.',
  );
  add(
    'dependencies',
    '프로젝트 npm 패키지',
    !!evidence.wsVersion,
    evidence.wsVersion ? `ws ${evidence.wsVersion}` : '설치되지 않음',
    '프로젝트 폴더에서 npm ci를 실행하세요.',
  );
  add(
    'electron',
    'Electron 데스크톱 실행 파일',
    evidence.electron.exists,
    evidence.electron.exists
      ? `${evidence.electron.version} · ${evidence.electron.path}`
      : '로컬 Electron 실행 파일 없음',
    'npm ci로 개발 의존성까지 설치하세요. npm ci --omit=dev는 데스크톱 실행 파일을 설치하지 않습니다.',
  );
  add(
    'powershell',
    'Windows PowerShell / MIDI 브리지',
    windows && evidence.powershell.ok && evidence.midiBridge,
    evidence.powershell.ok ? evidence.powershell.stdout.trim() : '사용할 수 없음',
    'Windows PowerShell과 native/midi-bridge.ps1, native/MidiBridge.cs 파일을 확인하세요.',
  );
  const sdks = evidence.dotnetSdks.stdout.split(/\r?\n/).filter((line) => /^\d+\./.test(line));
  const sdk = evidence.dotnetSdks.ok && sdks.some((line) => Number(line.split('.')[0]) >= 9);
  add(
    'dotnetSdk',
    '.NET SDK 9 이상 (도우미 빌드)',
    sdk,
    sdks.length ? sdks.map((line) => line.split(' ')[0]).join(', ') : 'SDK 없음',
    '.NET 9 SDK 또는 더 최신 SDK를 설치하세요. 실행에는 별도로 .NET 9 런타임이 필요합니다.',
  );
  const runtimes = evidence.dotnetRuntimes.stdout
    .split(/\r?\n/)
    .filter((line) => /^Microsoft\.NETCore\.App 9\./.test(line));
  add(
    'dotnetRuntime',
    '.NET 9 런타임 (도우미 실행)',
    evidence.dotnetRuntimes.ok && runtimes.length > 0,
    runtimes.length
      ? runtimes.map((line) => line.split(' ').slice(0, 2).join(' ')).join(', ')
      : '.NET 9 런타임 없음',
    'x64 .NET 9 Runtime 또는 .NET 9 SDK를 설치하세요. .NET 10만 설치한 상태에서는 net9 도우미가 실행되지 않습니다.',
  );
  const dotnetArch = evidence.dotnetInfo?.stdout.match(/^\s*Architecture:\s*(\S+)\s*$/m)?.[1];
  add(
    'dotnetArchitecture',
    'PATH의 .NET 호스트 x64',
    evidence.dotnetInfo?.ok && dotnetArch === 'x64',
    dotnetArch || '아키텍처를 확인할 수 없음',
    'x64 .NET을 설치하고 PATH에서 먼저 실행되는 dotnet이 x64인지 dotnet --info로 확인하세요. 도우미는 x64 전용입니다.',
  );
  add(
    'audioHelper',
    '빌드된 오디오 도우미',
    evidence.audioHelper,
    evidence.audioHelper
      ? 'native-audio/bin/Release/net9.0-windows/ProcessAudio.dll'
      : 'DLL 또는 runtimeconfig.json 없음',
    'npm run build:audio 또는 npm run setup을 실행하세요.',
  );
  for (const id of ['ffmpeg', 'ffprobe'])
    add(
      id,
      id === 'ffmpeg' ? 'FFmpeg' : 'FFprobe',
      evidence[id].ok,
      evidence[id].ok ? evidence[id].stdout.split(/\r?\n/)[0] : 'PATH에서 실행할 수 없음',
      'FFmpeg와 FFprobe가 포함된 빌드를 설치하고 두 실행 파일의 폴더를 PATH에 추가한 뒤 앱과 터미널을 다시 여세요.',
    );
  const byId = new Map(checks.map((check) => [check.id, check]));
  const definitions = [
    ['studio', '미리보기·세션 재생 (브라우저)', ['node', 'dependencies']],
    ['midi', '실시간 MIDI 입력', ['node', 'dependencies', 'architecture', 'powershell']],
    [
      'audio',
      'Kontakt 원음 녹음',
      [
        'node',
        'dependencies',
        'windows',
        'architecture',
        'dotnetRuntime',
        'dotnetArchitecture',
        'audioHelper',
      ],
    ],
    [
      'desktop',
      '데스크톱 앱·전체 화면 오버레이',
      ['node', 'dependencies', 'windows', 'architecture', 'electron'],
    ],
    ['export', '1080p60 MP4 내보내기', ['node', 'dependencies', 'ffmpeg', 'ffprobe']],
  ];
  const features = definitions.map(([id, label, requires]) => {
    const missing = requires.filter((key) => !byId.get(key).ok);
    return { id, label, ready: missing.length === 0, missing };
  });
  return {
    version: 1,
    projectVersion: evidence.projectVersion,
    root: evidence.root,
    checks,
    features,
    ready: features.every((feature) => feature.ready),
    notes: [
      '이 진단은 앱·녹음·MIDI 장치를 시작하거나 설정을 변경하지 않습니다.',
      'Windows 버전만으로 프로세스 캡처 API 동작을 보장하지 않습니다. 최신 업데이트를 적용하고 첫 녹음의 입력 미터와 WAV를 확인하세요.',
      'MP4에는 WebCodecs H.264를 지원하는 최신 Chrome 또는 Electron이 필요하며, 실제 인코더 지원은 내보낼 때 확인합니다.',
      'Kontakt 독립 실행 앱의 녹음은 Windows 공유 오디오 경로와 소스의 샘플레이트에 맞는 설정이 필요합니다. 장치 연결·음질은 이 진단만으로 보장하지 않습니다.',
    ],
  };
}

export async function collectDiagnostics({
  root = PROJECT,
  platform = process.platform,
  nodeVersion = process.versions.node,
  nodeArch = process.arch,
  osMachine = os.machine(),
  osRelease = os.release(),
  run = runCommand,
} = {}) {
  const helper = path.join(
    root,
    'native-audio',
    'bin',
    'Release',
    'net9.0-windows',
    'ProcessAudio',
  );
  const [
    ws,
    electronPackage,
    dotnetSdks,
    dotnetRuntimes,
    dotnetInfo,
    ffmpeg,
    ffprobe,
    powershell,
    audioDll,
    audioConfig,
    midiPs,
    midiCs,
  ] = await Promise.all([
    packageInfo(root, 'ws'),
    packageInfo(root, 'electron'),
    run('dotnet', ['--list-sdks']),
    run('dotnet', ['--list-runtimes']),
    run('dotnet', ['--info']),
    run('ffmpeg', ['-version']),
    run('ffprobe', ['-version']),
    platform === 'win32'
      ? run('powershell.exe', [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$PSVersionTable.PSVersion.ToString()',
        ])
      : { ok: false, stdout: '' },
    exists(helper + '.dll'),
    exists(helper + '.runtimeconfig.json'),
    exists(path.join(root, 'native', 'midi-bridge.ps1')),
    exists(path.join(root, 'native', 'MidiBridge.cs')),
  ]);
  let electronPath = '';
  try {
    const executable = (
      await fs.readFile(path.join(root, 'node_modules', 'electron', 'path.txt'), 'utf8')
    ).trim();
    const distribution =
      process.env.ELECTRON_OVERRIDE_DIST_PATH ||
      path.join(root, 'node_modules', 'electron', 'dist');
    electronPath = path.join(distribution, executable);
  } catch {}
  let projectVersion = 'unknown';
  try {
    projectVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  } catch {}
  return assessEnvironment({
    root,
    platform,
    nodeVersion,
    nodeArch,
    osMachine,
    osRelease,
    projectVersion,
    wsVersion: ws?.version,
    electron: {
      exists: !!electronPackage && !!electronPath && (await exists(electronPath)),
      version: electronPackage?.version,
      path: electronPath,
    },
    dotnetSdks,
    dotnetRuntimes,
    dotnetInfo,
    ffmpeg,
    ffprobe,
    powershell,
    audioHelper: audioDll && audioConfig,
    midiBridge: midiPs && midiCs,
  });
}

export function formatDiagnostics(report) {
  const lines = [
    `EClone Piano ${report.projectVersion} 환경 진단 · EClone Games`,
    `프로젝트: ${report.root}`,
    '',
  ];
  for (const check of report.checks) {
    lines.push(`${check.ok ? '[OK]' : '[확인]'} ${check.label}: ${check.detail}`);
    if (!check.ok) lines.push(`  → ${check.fix}`);
  }
  lines.push('', '기능별 준비 상태');
  for (const feature of report.features) {
    const missing = feature.missing
      .map((id) => report.checks.find((check) => check.id === id).label)
      .join(', ');
    lines.push(
      `${feature.ready ? '[준비]' : '[미준비]'} ${feature.label}${missing ? ' — ' + missing : ''}`,
    );
  }
  lines.push(
    '',
    ...report.notes,
    '',
    '처음 화면 확인: npm ci → npm run doctor → npm start',
    'Kontakt 녹음 준비: x64 .NET 9 SDK 설치 → npm run setup → npm start',
    '진단만: npm run doctor | JSON: npm run doctor -- --json | 엄격 검사: npm run doctor -- --strict',
  );
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await collectDiagnostics();
    console.log(
      process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatDiagnostics(report),
    );
    if (process.argv.includes('--strict') && !report.ready) process.exitCode = 1;
  } catch (error) {
    console.error('환경 진단 실패: ' + error.message);
    process.exitCode = 1;
  }
}
