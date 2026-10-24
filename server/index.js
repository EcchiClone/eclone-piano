import http from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { encodeMidi } from './midi-file.js';
import { mapMidiEventsToAudio } from './audio-clock.js';
import { Performance as MidiPerformance } from '../public/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA = path.join(ROOT, 'recordings');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mid': 'audio/midi',
};
const now = () => performance.now() / 1000;
const AUDIO_SAMPLE_RATES = [44100, 48000];
const defaultSettings = {
  theme: 'aurora',
  background: 'dark',
  direction: 'up',
  particles: true,
  glow: 0.75,
  keyboard: true,
  labels: true,
  minNote: 21,
  maxNote: 108,
  secondsVisible: 6,
  keyboardHeight: 0.19,
  overlayKeyboard: true,
  overlayNoteOpacity: 0.6,
  overlayKeyboardOpacity: 0.18,
  audioSampleRate: 44100,
};
const demo = {
  id: 'demo',
  name: 'First light · 미리보기',
  createdAt: new Date().toISOString(),
  duration: 32,
  hasAudio: false,
  events: [],
};
for (let bar = 0; bar < 8; bar++) {
  const chord = [
    [48, 55, 60, 64],
    [45, 52, 57, 60],
    [41, 48, 53, 57],
    [43, 50, 55, 59],
  ][bar % 4];
  for (let n = 0; n < 8; n++) {
    const note = chord[n % 4] + (n > 3 ? 12 : 0),
      t = bar * 4 + n * 0.5;
    demo.events.push(
      { t, data: [144, note, 75 + (n % 3) * 12] },
      { t: t + 0.9, data: [128, note, 0] },
    );
  }
  demo.events.push(
    { t: bar * 4, data: [144, chord[0] - 12, 85] },
    { t: bar * 4 + 3.5, data: [128, chord[0] - 12, 0] },
  );
}
demo.events.sort((a, b) => a.t - b.t);

export async function startServer({ port = 3210, onOverlay, dataDir = DEFAULT_DATA } = {}) {
  const DATA = path.resolve(dataDir);
  await fs.mkdir(DATA, { recursive: true });
  let settings = { ...defaultSettings };
  try {
    settings = {
      ...settings,
      ...JSON.parse(await fs.readFile(path.join(DATA, 'settings.json'), 'utf8')),
    };
  } catch {}
  if (!AUDIO_SAMPLE_RATES.includes(settings.audioSampleRate)) settings.audioSampleRate = 44100;
  let rememberedInputName = null,
    initialPortsSeen = false,
    connectionSave = Promise.resolve(),
    settingsSave = Promise.resolve(),
    settingsRevision = 0,
    lastMidiReset = -Infinity,
    lastMidiResetQpc = -Infinity;
  try {
    const saved = JSON.parse(await fs.readFile(path.join(DATA, 'connection.json'), 'utf8'));
    if (
      typeof saved.inputName === 'string' &&
      saved.inputName.length > 0 &&
      saved.inputName.length <= 256
    )
      rememberedInputName = saved.inputName;
  } catch {}
  let ports = { inputs: [], outputs: [] },
    midiStatus = { connected: false },
    midiCount = 0,
    lastMidi = null,
    bridge = null,
    audio = null,
    recording = null,
    starting = false,
    stopping = false,
    closing = false;
  let startTask = null,
    stopTask = null;
  let transport = { mode: 'live', sessionId: null, position: 0, playing: false, startedAt: now() },
    transportDuration = 0;
  const controllers = new Map(),
    historyControllers = new Map(),
    history = [];
  const livePerformance = new MidiPerformance({ notePolicy: 'piano' });
  const midiRecoveries = [];
  const clients = new Set();
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of clients) if (client.readyState === 1) client.send(data);
  };
  const state = () => ({
    type: 'state',
    serverTime: now(),
    settings,
    ports,
    midiStatus,
    midiCount,
    lastMidi,
    notePolicy: livePerformance.notePolicy,
    midiDiagnostics: {
      heldKeys: livePerformance.held.size,
      soundingVoices: livePerformance.activeAt(now()).length,
      sustainChannels: livePerformance.pedals.flatMap((down, channel) =>
        down ? [channel + 1] : [],
      ),
      retriggerRecoveries: livePerformance.retriggerRecoveries,
    },
    recording: recording
      ? {
          id: recording.id,
          name: recording.name,
          startedAt: recording.startedAt,
          withAudio: recording.withAudio,
        }
      : null,
    transport,
    starting,
    stopping,
  });
  const publish = () => broadcast(state());
  function updateControllers(target, data) {
    if ((data[0] & 240) !== 176) return;
    const channel = data[0] & 15,
      key = `${channel}:${data[1]}`;
    if (data[1] < 120) target.set(key, data);
    if (data[1] === 120) target.delete(`${channel}:64`);
    if (data[1] === 121)
      for (const controller of target.keys())
        if (controller.startsWith(`${channel}:`)) target.delete(controller);
  }
  function bootstrapHistory(boundary) {
    const initial = new Map(historyControllers);
    for (const event of history) {
      if (event.t >= boundary) break;
      updateControllers(initial, event.data);
    }
    const events = [...initial.values()].map((data) => ({ t: boundary, data }));
    // Sounding voices survive history trimming, including pedal-held notes whose keys are up.
    // Emitting each released voice's note-off immediately preserves FIFO repeated-pitch pairs.
    for (const note of livePerformance.notes) {
      if (note.start >= boundary || note.end <= boundary) continue;
      events.push({ t: boundary, data: [144 + note.channel, note.note, note.velocity] });
      if (note.release < boundary)
        events.push({ t: boundary, data: [128 + note.channel, note.note, 0] });
    }
    events.push(...history.filter((event) => event.t >= boundary));
    return events;
  }
  function acceptMidi(data, t = now(), physical = true) {
    if (!Array.isArray(data) || !Number.isInteger(data[0]) || data[0] < 128 || data[0] > 239)
      return;
    const length = (data[0] & 240) === 192 || (data[0] & 240) === 208 ? 2 : 3;
    if (
      data.length !== length ||
      data.slice(1).some((value) => !Number.isInteger(value) || value < 0 || value > 127)
    )
      return;
    if (physical && t < lastMidiReset) return;
    t = Math.max(livePerformance.lastTime, t);
    const event = { t, data };
    if (physical) {
      midiCount++;
      lastMidi = { data, t };
    }
    const recoveriesBefore = livePerformance.retriggerRecoveries;
    livePerformance.ingest(event);
    if (livePerformance.retriggerRecoveries !== recoveriesBefore) {
      midiRecoveries.push({
        type: 'piano-retrigger',
        t,
        channel: (data[0] & 15) + 1,
        note: data[1],
        context: [...history.slice(-16), event],
      });
      if (midiRecoveries.length > 32) midiRecoveries.shift();
    }
    updateControllers(controllers, data);
    history.push(event);
    while (history.length && history[0].t < t - 20)
      updateControllers(historyControllers, history.shift().data);
    livePerformance.prune(t - 20, { events: true });
    if (recording) recording.events.push({ t: Math.max(0, t - recording.startedAt), data });
    broadcast({ type: 'midi', ...event, synthetic: !physical });
  }
  function resetMidi() {
    const t = now();
    lastMidiReset = t;
    lastMidiResetQpc = Number(process.hrtime.bigint()) / 1e6;
    for (let channel = 0; channel < 16; channel++) {
      acceptMidi([176 + channel, 64, 0], t, false);
      acceptMidi([176 + channel, 120, 0], t, false);
    }
    controllers.clear();
    broadcast({ type: 'panic', t });
  }
  const bridgeCommand = (msg) => {
    if (!bridge?.stdin.writable) throw new Error('MIDI 브리지가 아직 준비되지 않았습니다.');
    bridge.stdin.write(JSON.stringify(msg) + '\n');
  };
  function startBridge() {
    if (process.platform !== 'win32') {
      midiStatus = { connected: false, error: 'Windows MIDI 브리지는 Windows에서 실행하세요.' };
      return;
    }
    bridge = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(ROOT, 'native', 'midi-bridge.ps1'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    createInterface({ input: bridge.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === 'ports') {
        ports = { inputs: msg.inputs, outputs: msg.outputs };
        publish();
        if (!initialPortsSeen) {
          initialPortsSeen = true;
          const matches = ports.inputs.filter((input) => input.name === rememberedInputName);
          if (matches.length === 1) bridgeCommand({ type: 'open', inputId: matches[0].id });
        }
      }
      if (msg.type === 'status') {
        if (midiStatus.connected && (!msg.connected || msg.inputId !== midiStatus.inputId))
          resetMidi();
        midiStatus = msg;
        if (msg.connected) {
          const inputName = ports.inputs.find((input) => input.id === msg.inputId)?.name;
          if (typeof inputName === 'string' && inputName !== rememberedInputName) {
            rememberedInputName = inputName;
            connectionSave = connectionSave
              .then(() =>
                fs.writeFile(path.join(DATA, 'connection.json'), JSON.stringify({ inputName })),
              )
              .catch((error) =>
                broadcast({
                  type: 'notice',
                  kind: 'warning',
                  message: 'MIDI 입력 설정을 저장하지 못했습니다: ' + error.message,
                }),
              );
          }
        }
        publish();
      }
      if (msg.type === 'error') {
        midiStatus = { ...midiStatus, error: msg.message };
        broadcast({ type: 'notice', kind: 'error', message: msg.message });
        publish();
      }
      if (msg.type === 'midi') {
        // Even a pipe backlog outside our 30-second clock-conversion window must
        // not resurrect notes that were physically played before an explicit reset.
        if (Number.isFinite(msg.qpcTimestamp) && msg.qpcTimestamp < lastMidiResetQpc) return;
        const received = now(),
          elapsed = (Number(process.hrtime.bigint()) / 1e6 - msg.qpcTimestamp) / 1000;
        acceptMidi(
          msg.data,
          Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 30
            ? Math.max(0, received - elapsed)
            : received,
        );
      }
    });
    bridge.stderr.on('data', (chunk) => console.error('[MIDI]', chunk.toString().trim()));
    bridge.on('error', (error) => {
      midiStatus = { connected: false, error: error.message };
      publish();
    });
    bridge.on('exit', () => {
      bridge = null;
      midiStatus = {
        connected: false,
        error: closing ? undefined : 'MIDI 브리지가 종료됐습니다. 새로고침으로 재시작하세요.',
      };
      resetMidi();
      publish();
    });
  }
  async function inspectWave(id) {
    let file;
    try {
      file = await fs.open(path.join(DATA, id + '.wav'), 'r');
      const stat = await file.stat(),
        header = Buffer.alloc(44);
      const { bytesRead } = await file.read(header, 0, 44, 0);
      if (
        bytesRead !== 44 ||
        header.toString('ascii', 0, 4) !== 'RIFF' ||
        header.toString('ascii', 8, 12) !== 'WAVE' ||
        header.toString('ascii', 12, 16) !== 'fmt ' ||
        header.toString('ascii', 36, 40) !== 'data'
      )
        return null;
      const bytes = header.readUInt32LE(40),
        rate = header.readUInt32LE(24),
        align = header.readUInt16LE(32);
      if (
        header.readUInt32LE(4) !== stat.size - 8 ||
        bytes !== stat.size - 44 ||
        !bytes ||
        header.readUInt16LE(20) !== 1 ||
        !AUDIO_SAMPLE_RATES.includes(rate) ||
        align !== 4 ||
        header.readUInt16LE(22) !== 2 ||
        header.readUInt16LE(34) !== 16 ||
        bytes % align
      )
        return null;
      return {
        duration: bytes / align / rate,
        frames: bytes / align,
        sampleRate: rate,
        channels: 2,
        bitsPerSample: 16,
      };
    } catch {
      return null;
    } finally {
      await file?.close();
    }
  }
  async function reconcileSessionAudio(session) {
    if (!session.hasAudio) return session;
    const wave = await inspectWave(session.id);
    return wave
      ? session
      : {
          ...session,
          hasAudio: false,
          audioError:
            '녹음 WAV 파일이 없거나 완전하지 않습니다. MIDI 연주는 계속 재생할 수 있습니다.',
        };
  }
  const deletingSessions = new Set(),
    activeTakeIds = new Set(),
    sessionReaders = new Map();
  const sessionConflict = (message) => Object.assign(new Error(message), { statusCode: 409 });
  function retainSession(id) {
    id = String(id).toLowerCase();
    if (deletingSessions.has(id)) throw sessionConflict('이 연주를 삭제 중입니다.');
    sessionReaders.set(id, (sessionReaders.get(id) || 0) + 1);
    return () => {
      const remaining = sessionReaders.get(id) - 1;
      if (remaining) sessionReaders.set(id, remaining);
      else sessionReaders.delete(id);
    };
  }
  const sessions = async () => {
    const entries = await fs.readdir(DATA);
    const list = [];
    for (const entry of entries.filter((n) => /^[\w-]+\.session\.json$/.test(n))) {
      if (deletingSessions.has(entry.slice(0, -'.session.json'.length))) continue;
      try {
        const d = await reconcileSessionAudio(
          JSON.parse(await fs.readFile(path.join(DATA, entry), 'utf8')),
        );
        list.push({
          id: d.id,
          name: d.name,
          createdAt: d.createdAt,
          duration: d.duration,
          hasAudio: d.hasAudio,
          audioError: d.audioError,
          eventCount: d.events.length,
        });
      } catch {}
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };
  const getSession = async (id) => {
    if (id === 'demo') return demo;
    if (!/^[\w-]+$/.test(id)) throw new Error('올바르지 않은 세션입니다.');
    const release = retainSession(id);
    try {
      return await reconcileSessionAudio(
        JSON.parse(await fs.readFile(path.join(DATA, id + '.session.json'), 'utf8')),
      );
    } finally {
      release();
    }
  };
  async function deleteSession(id) {
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    )
      throw new Error('삭제할 수 있는 저장된 연주를 선택하세요.');
    id = id.toLowerCase();
    if (closing) throw sessionConflict('앱을 종료 중입니다.');
    if (deletingSessions.has(id)) throw sessionConflict('이 연주를 이미 삭제 중입니다.');
    if (activeTakeIds.has(id) || recording?.id === id || audio?.id === id)
      throw sessionConflict('녹음하거나 저장 중인 연주는 삭제할 수 없습니다.');
    if (
      sessionReaders.has(id) ||
      [...exportUploads.values()].some((upload) => upload.sessionId.toLowerCase() === id)
    )
      throw sessionConflict('연주를 불러오거나 영상을 내보내는 중입니다. 완료 후 삭제하세요.');
    deletingSessions.add(id);
    const moved = [];
    let trashDirectory;
    try {
      const files = [];
      // Only these exact source files belong to the take. Completed videos remain intact.
      for (const extension of ['.session.json', '.wav', '.mid']) {
        const filename = id + extension,
          source = path.join(DATA, filename);
        let stat;
        try {
          stat = await fs.lstat(source);
        } catch (error) {
          if (error.code === 'ENOENT' && extension !== '.session.json') continue;
          throw error;
        }
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error('일반 연주 파일만 삭제할 수 있습니다.');
        files.push({ filename, source });
      }
      const trashRoot = path.join(DATA, '.trash');
      await fs.mkdir(trashRoot, { recursive: true });
      const trashStat = await fs.lstat(trashRoot);
      if (!trashStat.isDirectory() || trashStat.isSymbolicLink())
        throw new Error('안전한 연주 보관함을 만들 수 없습니다.');
      trashDirectory = await fs.mkdtemp(path.join(trashRoot, `${id}-${Date.now()}-`));
      await fs.writeFile(
        path.join(trashDirectory, 'manifest.json'),
        JSON.stringify({
          version: 1,
          sessionId: id,
          trashedAt: new Date().toISOString(),
          files: files.map((file) => file.filename),
        }),
      );
      for (const file of files) {
        const destination = path.join(trashDirectory, file.filename);
        await fs.rename(file.source, destination);
        moved.push({ source: file.source, destination });
      }
      if (transport.sessionId?.toLowerCase() === id) {
        transportDuration = 0;
        transport = {
          mode: 'live',
          sessionId: null,
          position: 0,
          playing: false,
          startedAt: now(),
        };
        publish();
      }
      broadcast({ type: 'deleted', sessionId: id });
      return { deleted: true, id, trashed: true };
    } catch (error) {
      const rollbackErrors = [];
      for (const file of moved.reverse()) {
        try {
          await fs.rename(file.destination, file.source);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (trashDirectory && !rollbackErrors.length) {
        await fs.unlink(path.join(trashDirectory, 'manifest.json')).catch(() => {});
        await fs.rmdir(trashDirectory).catch(() => {});
      }
      if (rollbackErrors.length)
        throw Object.assign(
          new Error(
            '삭제를 완료하지 못했습니다. 일부 파일은 recordings/.trash 보관함에 안전하게 남아 있습니다.',
          ),
          { statusCode: 500 },
        );
      throw error;
    } finally {
      deletingSessions.delete(id);
    }
  }
  const helper = path.join(
    ROOT,
    'native-audio',
    'bin',
    'Release',
    'net9.0-windows',
    'ProcessAudio.dll',
  );
  async function probeAudio() {
    if (!existsSync(helper))
      return {
        supported: false,
        processes: [],
        error: '오디오 도우미를 빌드하세요: npm run build:audio',
      };
    return await new Promise((resolve) => {
      const child = spawn('dotnet', [helper, '--list'], { windowsHide: true });
      let result = '';
      child.stdout.on('data', (d) => (result += d));
      child.on('error', (e) => resolve({ error: e.message, processes: [] }));
      child.on('close', () => {
        try {
          const lines = result.trim().split(/\r?\n/);
          resolve(JSON.parse(lines.at(-1)));
        } catch {
          resolve({ error: result || 'Kontakt 프로세스를 찾지 못했습니다.', processes: [] });
        }
      });
    });
  }
  function startCapture(id, pid, sampleRate) {
    let resolveReady, rejectReady, resolveDone;
    const run = {
      id,
      child: null,
      ready: false,
      closed: false,
      stopRequested: false,
      forced: false,
      final: null,
      error: null,
      exitCode: null,
      signal: null,
      readyPromise: new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      }),
      done: new Promise((resolve) => {
        resolveDone = resolve;
      }),
      stopPromise: null,
    };
    const fail = (error) => {
      run.error ??= error;
      if (!run.ready) rejectReady(run.error);
    };
    const child = (run.child = spawn(
      'dotnet',
      [
        helper,
        '--pid',
        String(pid),
        '--output',
        path.join(DATA, id + '.wav'),
        '--sample-rate',
        String(sampleRate),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    ));
    const timeout = setTimeout(() => {
      fail(new Error('Kontakt 오디오 연결 시간 초과 (15초)'));
      run.forced = true;
      child.kill();
    }, 15000);
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === 'ready' && !run.ready) {
        if (msg.sampleRate !== sampleRate) {
          fail(
            new Error('오디오 도우미의 샘플레이트가 요청과 다릅니다. 도우미를 다시 빌드해 주세요.'),
          );
          return;
        }
        if (!Number.isFinite(msg.startedUnixMs)) {
          fail(new Error('오디오 도우미가 올바른 시작 시각을 반환하지 않았습니다.'));
          return;
        }
        run.ready = true;
        clearTimeout(timeout);
        // Windows Node hrtime and the helper both use QPC. Prefer that clock to wall time.
        const elapsed = Number.isFinite(msg.startedMonotonicMs)
          ? (Number(process.hrtime.bigint()) / 1e6 - msg.startedMonotonicMs) / 1000
          : (Date.now() - msg.startedUnixMs) / 1000;
        run.startedAt = now() - Math.max(0, elapsed);
        resolveReady(run);
      }
      if (msg.type === 'level') broadcast({ ...msg, type: 'audioLevel', sessionId: id });
      if (msg.type === 'warning')
        broadcast({ type: 'notice', kind: 'warning', message: msg.message });
      if (msg.type === 'error') {
        clearTimeout(timeout);
        fail(new Error(msg.message + (msg.hresult ? ` (${msg.hresult})` : '')));
      }
      if (msg.type === 'stopped') {
        run.final = msg;
        broadcast({ ...msg, type: 'audioFinal', sessionId: id });
      }
    });
    child.stderr.on('data', (data) => console.error('[Audio]', data.toString().trim()));
    child.stdin.on('error', (error) => {
      if (!run.closed && !run.stopRequested) fail(error);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      fail(error);
    });
    child.on('exit', (code, signal) => {
      run.exitCode = code;
      run.signal = signal;
    });
    // close follows stdout completion, so a final WAV acknowledgement cannot arrive too late.
    child.on('close', (code, signal) => {
      run.closed = true;
      run.exitCode = code;
      run.signal = signal;
      clearTimeout(timeout);
      if (!run.ready) fail(new Error(`오디오 캡처 시작 실패 (${signal || code})`));
      if (run.ready && !run.stopRequested && !closing) {
        const message =
          run.error?.message ||
          (run.final
            ? '오디오 캡처가 종료되어 연주를 저장했습니다.'
            : `오디오 캡처가 예기치 않게 종료됐습니다 (${signal || code}). MIDI 연주는 보존합니다.`);
        broadcast({ type: 'notice', kind: run.final && !run.error ? 'warning' : 'error', message });
        if (recording?.id === id)
          stopRecording().catch((error) =>
            broadcast({ type: 'notice', kind: 'error', message: error.message }),
          );
      }
      resolveDone(run);
    });
    return run;
  }
  function stopCapture(run) {
    if (run.stopPromise) return run.stopPromise;
    run.stopRequested = true;
    run.stopPromise = (async () => {
      if (run.closed) return run;
      const child = run.child;
      if (
        child.exitCode === null &&
        child.signalCode == null &&
        !child.stdin.destroyed &&
        child.stdin.writable
      ) {
        try {
          child.stdin.end('stop\n');
        } catch (error) {
          run.error ??= error;
        }
      }
      let killTimer, deadline;
      try {
        killTimer = setTimeout(() => {
          run.forced = true;
          run.error ??= new Error('오디오 파일 마무리 시간 초과 (5초)');
          child.kill();
        }, 5000);
        await Promise.race([
          run.done,
          new Promise((resolve) => {
            deadline = setTimeout(() => {
              run.forced = true;
              run.error ??= new Error('오디오 도우미 종료를 확인하지 못했습니다.');
              resolve();
            }, 6000);
          }),
        ]);
      } finally {
        clearTimeout(killTimer);
        clearTimeout(deadline);
      }
      return run;
    })();
    return run.stopPromise;
  }
  async function beginRecording(payload) {
    if (recording || starting || stopping || closing)
      throw new Error(
        stopping
          ? '이전 연주를 저장 중입니다. 잠시 후 다시 녹음하세요.'
          : '이미 녹음 중이거나 앱을 종료 중입니다.',
      );
    starting = true;
    publish();
    const id = randomUUID(),
      name = String(payload.name || `연주 ${new Date().toLocaleString('ko-KR')}`).slice(0, 120);
    activeTakeIds.add(id);
    const requestedAt = now();
    let run;
    try {
      let startedAt = requestedAt;
      if (payload.withAudio) {
        if (!existsSync(helper)) throw new Error('오디오 도우미를 빌드한 뒤 다시 시도하세요.');
        if (!Number.isInteger(payload.pid) || payload.pid <= 0)
          throw new Error('녹음할 Kontakt 프로세스를 선택하세요.');
        const sampleRate = payload.sampleRate ?? settings.audioSampleRate;
        if (!AUDIO_SAMPLE_RATES.includes(sampleRate))
          throw new Error('Kontakt 샘플레이트는 44,100 또는 48,000 Hz를 선택하세요.');
        audio = run = startCapture(id, payload.pid, sampleRate);
        await run.readyPromise;
        startedAt = run.startedAt;
        if (run.closed || run.error)
          throw run.error || new Error('오디오 도우미가 녹음 준비 직후 종료됐습니다.');
      }
      if (closing) throw new Error('앱 종료로 녹음을 취소했습니다.');
      // Reconstruct all sounding voices at audio zero, then keep MIDI received during readiness.
      const events = bootstrapHistory(startedAt).map((event) => ({
        t: event.t - startedAt,
        data: event.data,
      }));
      recording = {
        id,
        name,
        createdAt: new Date().toISOString(),
        startedAt,
        withAudio: !!payload.withAudio,
        events,
      };
      transport = { mode: 'live', sessionId: null, position: 0, playing: false, startedAt: now() };
    } catch (error) {
      if (run) {
        await stopCapture(run);
        if (audio === run) audio = null;
      }
      activeTakeIds.delete(id);
      throw error;
    } finally {
      starting = false;
      publish();
    }
  }
  function stopRecording() {
    if (stopTask) return stopTask;
    if (!recording) throw new Error('녹음 중인 연주가 없습니다.');
    const rec = recording,
      run = audio,
      savedSettings = { ...settings };
    const midiDuration = Math.max(0.01, now() - rec.startedAt);
    if (run) run.stopRequested = true;
    stopping = true;
    recording = null;
    publish();
    stopTask = (async () => {
      try {
        if (run) await stopCapture(run);
        const wave =
          rec.withAudio && run?.final && !run.forced && run.exitCode === 0
            ? await inspectWave(rec.id)
            : null;
        const audioError =
          rec.withAudio && !wave
            ? run?.error?.message ||
              '오디오 파일이 완전히 저장되지 않았습니다. MIDI 연주는 저장했습니다.'
            : undefined;
        const synchronized = wave
          ? mapMidiEventsToAudio(rec.events, run.final.clockMap, wave)
          : { events: rec.events };
        const saved = {
          version: 1,
          notePolicy: livePerformance.notePolicy,
          id: rec.id,
          name: rec.name,
          createdAt: rec.createdAt,
          duration: Math.max(midiDuration, wave?.duration || 0),
          hasAudio: !!wave,
          audioError,
          eventTimebase: synchronized.mapping ? 'audio-pcm' : 'capture-clock',
          midiClockMapping: synchronized.mapping,
          audio: wave
            ? {
                ...wave,
                peak: run.final.peak,
                silent: run.final.silent,
                discontinuities: run.final.discontinuities,
                insertedGapFrames: run.final.insertedGapFrames,
                clockResets: run.final.clockResets,
                timestampErrors: run.final.timestampErrors,
                maxClockDriftMs: run.final.maxClockDriftMs,
                frameCounterMode: run.final.frameCounterMode,
                unavailablePositionPackets: run.final.unavailablePositionPackets,
                rejectedClockAnchors: run.final.rejectedClockAnchors,
                clockMap: synchronized.clockMap,
              }
            : undefined,
          events: synchronized.events,
          settings: savedSettings,
        };
        await fs.writeFile(path.join(DATA, rec.id + '.session.json'), JSON.stringify(saved));
        if (audioError) broadcast({ type: 'notice', kind: 'error', message: audioError });
        broadcast({ type: 'saved', session: saved });
        return saved;
      } finally {
        if (audio === run) audio = null;
        activeTakeIds.delete(rec.id);
        stopping = false;
        stopTask = null;
        publish();
      }
    })();
    return stopTask;
  }
  async function command(msg) {
    switch (msg.type) {
      case 'refreshPorts':
        if (!bridge) startBridge();
        else bridgeCommand({ type: 'ports' });
        break;
      case 'connect':
        if (!Number.isInteger(msg.inputId)) throw new Error('MIDI 입력을 선택하세요.');
        bridgeCommand({ type: 'open', inputId: msg.inputId });
        break;
      case 'disconnect':
        bridgeCommand({ type: 'close' });
        resetMidi();
        break;
      case 'panic':
        resetMidi();
        bridgeCommand({ type: 'panic' });
        break;
      case 'settings': {
        const p = msg.settings || {};
        if (AUDIO_SAMPLE_RATES.includes(p.audioSampleRate))
          settings.audioSampleRate = p.audioSampleRate;
        for (const key of ['theme', 'background', 'direction'])
          if (
            {
              theme: ['aurora', 'amber', 'violet'],
              background: ['dark', 'transparent'],
              direction: ['up', 'down'],
            }[key].includes(p[key])
          )
            settings[key] = p[key];
        for (const key of ['particles', 'keyboard', 'labels', 'overlayKeyboard'])
          if (typeof p[key] === 'boolean') settings[key] = p[key];
        for (const [key, min, max] of [
          ['glow', 0, 1],
          ['secondsVisible', 2, 15],
          ['keyboardHeight', 0.08, 0.35],
          ['overlayNoteOpacity', 0, 1],
          ['overlayKeyboardOpacity', 0, 1],
        ])
          if (Number.isFinite(p[key])) settings[key] = Math.min(max, Math.max(min, p[key]));
        if (
          [
            [21, 108],
            [36, 96],
            [36, 84],
            [48, 84],
          ].some(([min, max]) => p.minNote === min && p.maxNote === max)
        ) {
          settings.minNote = p.minNote;
          settings.maxNote = p.maxNote;
        }
        const serialized = JSON.stringify(settings),
          revision = ++settingsRevision;
        settingsSave = settingsSave
          .catch(() => {})
          .then(async () => {
            if (revision !== settingsRevision) return;
            const temporary = path.join(DATA, 'settings.json.tmp');
            await fs.writeFile(temporary, serialized);
            // Windows readers or antivirus can hold the destination briefly; retain the old file
            // and retry the atomic rename rather than falling back to a partial overwrite.
            for (let attempt = 0; ; attempt++) {
              try {
                await fs.rename(temporary, path.join(DATA, 'settings.json'));
                break;
              } catch (error) {
                if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
                await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
              }
            }
          });
        await settingsSave;
        publish();
        break;
      }
      case 'live':
        transport = {
          mode: 'live',
          sessionId: null,
          position: 0,
          playing: false,
          startedAt: now(),
        };
        publish();
        break;
      case 'play': {
        if (recording || starting || stopping)
          throw new Error('먼저 녹음을 종료하고 저장이 완료될 때까지 기다리세요.');
        const session = await getSession(msg.sessionId || transport.sessionId || 'demo');
        transportDuration = session.duration;
        transport = {
          mode: session.id === 'demo' ? 'demo' : 'replay',
          sessionId: session.id,
          position: Math.min(session.duration, Math.max(0, Number(msg.position) || 0)),
          playing: true,
          startedAt: now(),
        };
        publish();
        break;
      }
      case 'pause':
        transport.position = Number.isFinite(msg.position)
          ? Math.min(transportDuration, Math.max(0, msg.position))
          : transport.position + (transport.playing ? now() - transport.startedAt : 0);
        transport.playing = false;
        transport.startedAt = now();
        delete transport.reason;
        publish();
        break;
      case 'seek':
        transport.position = Math.min(transportDuration, Math.max(0, Number(msg.position) || 0));
        transport.startedAt = now();
        delete transport.reason;
        publish();
        break;
      case 'record': {
        if (startTask) throw new Error('녹음을 준비 중입니다.');
        const pending = beginRecording(msg);
        startTask = pending;
        try {
          await pending;
        } finally {
          if (startTask === pending) startTask = null;
        }
        break;
      }
      case 'stopRecord':
        await stopRecording();
        break;
      case 'overlay':
        if (!onOverlay) throw new Error('전체 화면 오버레이는 데스크톱 앱에서 사용할 수 있습니다.');
        onOverlay(msg.displayId);
        break;
      default:
        throw new Error('지원하지 않는 요청입니다.');
    }
  }
  const exportUploads = new Map(),
    maxExportBytes = 4 * 1024 * 1024 * 1024;
  let exportStarts = 0,
    exportToolsPromise;
  function exportTool(command, args, upload, timeout = 0) {
    return new Promise((resolve) => {
      let stdout = '',
        stderr = '',
        spawnError,
        timer;
      const proc = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (upload) upload.process = proc;
      proc.stdout.on('data', (data) => {
        if (stdout.length < 262144) stdout += data;
      });
      proc.stderr.on('data', (data) => {
        if (stderr.length < 16384) stderr += data;
      });
      proc.once('error', (error) => {
        spawnError = error;
      });
      proc.once('close', (code) => {
        clearTimeout(timer);
        if (upload?.process === proc) upload.process = null;
        resolve({ ok: code === 0 && !spawnError, stdout, stderr, error: spawnError });
      });
      if (timeout) timer = setTimeout(() => proc.kill(), timeout);
    });
  }
  function requireExportTools() {
    return (exportToolsPromise ??= Promise.all([
      exportTool('ffmpeg', ['-version'], null, 5000),
      exportTool('ffprobe', ['-version'], null, 5000),
    ])
      .then((results) => {
        if (results.some((result) => !result.ok))
          throw new Error(
            '고정 60fps 영상 내보내기에는 FFmpeg와 FFprobe가 필요합니다. 설치 후 다시 시도하세요.',
          );
      })
      .catch((error) => {
        exportToolsPromise = null;
        throw error;
      }));
  }
  async function finishFrameExport(upload) {
    const probe = await exportTool(
      'ffprobe',
      [
        '-v',
        'error',
        '-f',
        'h264',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height,nb_read_frames',
        '-of',
        'json',
        upload.source,
      ],
      upload,
    );
    if (upload.cancelled) throw new Error('영상 내보내기를 취소했습니다.');
    let input;
    try {
      input = JSON.parse(probe.stdout).streams?.[0];
    } catch {}
    if (
      !probe.ok ||
      probe.stderr.trim() ||
      input?.codec_name !== 'h264' ||
      Number(input.nb_read_frames) !== upload.totalFrames
    )
      throw new Error(
        `영상 프레임이 누락되거나 손상되었습니다. ${upload.totalFrames}프레임이 필요하지만 ${input?.nb_read_frames || 0}프레임을 확인했습니다.`,
      );
    if (input.width !== 1920 || input.height !== 1080)
      throw new Error('영상 프레임 크기가 1920 × 1080과 일치하지 않습니다.');
    const mux = await exportTool(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-fflags',
        '+genpts',
        '-r',
        String(upload.fps),
        '-f',
        'h264',
        '-i',
        upload.source,
        ...(upload.hasAudio
          ? [
              '-i',
              path.join(DATA, upload.sessionId + '.wav'),
              '-map',
              '0:v:0',
              '-map',
              '1:a:0',
              '-af',
              'apad',
            ]
          : ['-map', '0:v:0']),
        '-c:v',
        'copy',
        '-t',
        String(upload.totalFrames / upload.fps),
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        '-video_track_timescale',
        '60000',
        upload.mp4,
      ],
      upload,
    );
    if (upload.cancelled) throw new Error('영상 내보내기를 취소했습니다.');
    if (!mux.ok)
      throw new Error(
        'MP4 영상 저장에 실패했습니다. ' +
          (mux.stderr.trim() || mux.error?.message || 'FFmpeg 오류'),
      );
    const verify = await exportTool(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=nb_read_frames,avg_frame_rate,r_frame_rate',
        '-of',
        'json',
        upload.mp4,
      ],
      upload,
    );
    if (upload.cancelled) throw new Error('영상 내보내기를 취소했습니다.');
    let output;
    try {
      output = JSON.parse(verify.stdout).streams?.[0];
    } catch {}
    if (
      !verify.ok ||
      verify.stderr.trim() ||
      Number(output?.nb_read_frames) !== upload.totalFrames ||
      output.avg_frame_rate !== `${upload.fps}/1`
    )
      throw new Error('완성된 MP4의 프레임 수나 60fps 간격이 원본과 일치하지 않습니다.');
    await fs.unlink(upload.source);
    if (upload.cancelled) throw new Error('영상 내보내기를 취소했습니다.');
    return {
      url: '/media/' + upload.stem + '.mp4',
      format: 'mp4',
      fps: upload.fps,
      frames: upload.totalFrames,
    };
  }
  async function cancelExport(upload) {
    if (upload.cleanup) return upload.cleanup;
    upload.cancelled = true;
    upload.cleanup = (async () => {
      upload.input?.destroy(new Error('Export cancelled'));
      upload.process?.kill();
      await upload.writing?.catch(() => {});
      await upload.conversion?.catch(() => {});
      await Promise.all([upload.source, upload.mp4].map((file) => fs.unlink(file).catch(() => {})));
      exportUploads.delete(upload.id);
    })();
    return upload.cleanup;
  }
  const expireExports = setInterval(() => {
    for (const upload of exportUploads.values())
      if (!upload.finishing && Date.now() - upload.updatedAt > 60 * 60 * 1000)
        cancelExport(upload).catch(console.error);
  }, 60000);
  expireExports.unref();
  const server = http.createServer(async (req, res) => {
    let releaseMedia;
    const releaseMediaLease = () => {
      const release = releaseMedia;
      releaseMedia = null;
      release?.();
    };
    const json = (obj, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(obj));
    };
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '')) {
      json({ error: 'Local requests only' }, 403);
      return;
    }
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) {
      json({ error: 'Origin rejected' }, 403);
      return;
    }
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`),
        p = decodeURIComponent(url.pathname);
      if (p === '/api/state') return json(state());
      if (p === '/api/midi-diagnostics')
        return json({
          serverTime: now(),
          notePolicy: livePerformance.notePolicy,
          ...state().midiDiagnostics,
          recentEvents: history,
          recoveries: midiRecoveries,
        });
      if (p === '/api/sessions') return json(await sessions());
      if (p === '/api/audio') return json(await probeAudio());
      if (p.startsWith('/api/session/')) {
        const id = p.slice(13);
        if (req.method === 'DELETE') return json(await deleteSession(id));
        if (req.method !== 'GET' && req.method !== 'HEAD')
          return json({ error: 'Method not allowed' }, 405);
        return json(await getSession(id));
      }
      if (p.startsWith('/api/midi/')) {
        const session = await getSession(p.slice(10));
        res.writeHead(200, {
          'Content-Type': 'audio/midi',
          'Content-Disposition': 'attachment; filename="performance.mid"',
        });
        return res.end(encodeMidi(session.events, session.duration));
      }
      if (p === '/api/import' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 20_000_000) throw new Error('세션 파일이 너무 큽니다.');
        }
        const src = JSON.parse(body);
        if (
          !Array.isArray(src.events) ||
          src.events.length > 200000 ||
          !Number.isFinite(src.duration) ||
          src.duration <= 0 ||
          src.duration > 86400
        )
          throw new Error('지원하지 않는 세션 파일입니다.');
        if (
          !src.events.every(
            (e) =>
              Number.isFinite(e.t) &&
              e.t >= 0 &&
              e.t <= src.duration + 1 &&
              Array.isArray(e.data) &&
              e.data.length === ((e.data[0] & 0xe0) === 0xc0 ? 2 : 3) &&
              e.data.every((n, i) => Number.isInteger(n) && n >= 0 && n <= (i ? 127 : 239)) &&
              e.data[0] >= 128,
          )
        )
          throw new Error('올바르지 않은 MIDI 이벤트입니다.');
        const id = randomUUID(),
          saved = {
            version: 1,
            id,
            name: String(src.name || '가져온 연주').slice(0, 120),
            notePolicy: src.notePolicy === 'piano' ? 'piano' : 'fifo',
            createdAt: new Date().toISOString(),
            duration: src.duration,
            events: src.events.sort((a, b) => a.t - b.t),
            hasAudio: false,
          };
        await fs.writeFile(path.join(DATA, id + '.session.json'), JSON.stringify(saved));
        return json(saved);
      }
      if (p === '/api/export/start' && req.method === 'POST') {
        if (closing) throw new Error('앱을 종료 중입니다.');
        if (exportUploads.size + exportStarts >= 3)
          throw new Error('진행 중인 영상 내보내기를 먼저 마치거나 취소하세요.');
        exportStarts++;
        let releaseSession;
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 4096) throw new Error('잘못된 내보내기 요청입니다.');
          }
          const { sessionId, format = 'webm', fps, totalFrames } = JSON.parse(body);
          if (typeof sessionId !== 'string' || sessionId === 'demo')
            throw new Error('저장된 연주를 선택하세요.');
          if (!['webm', 'h264'].includes(format)) throw new Error('지원하지 않는 영상 형식입니다.');
          releaseSession = retainSession(sessionId);
          const session = await getSession(sessionId),
            id = randomUUID(),
            stem = `${sessionId}-${id}`;
          if (format === 'h264') {
            if (
              fps !== 60 ||
              !Number.isInteger(totalFrames) ||
              totalFrames !== Math.ceil(session.duration * fps)
            )
              throw new Error('영상 프레임 수가 연주 길이의 60fps 타임라인과 일치하지 않습니다.');
            await requireExportTools();
            if (closing) throw new Error('앱을 종료 중입니다.');
          }
          const upload = {
            id,
            stem,
            sessionId,
            duration: session.duration,
            hasAudio: !!session.hasAudio,
            bytes: 0,
            sequence: 0,
            updatedAt: Date.now(),
            format,
            fps,
            totalFrames,
            source: path.join(DATA, stem + '.' + format),
            webm: path.join(DATA, stem + '.webm'),
            mp4: path.join(DATA, stem + '.mp4'),
          };
          const file = await fs.open(upload.source, 'wx');
          await file.close();
          exportUploads.set(id, upload);
          return json({ uploadId: id, maxBytes: maxExportBytes });
        } finally {
          releaseSession?.();
          exportStarts--;
        }
      }
      const exportRoute = /^\/api\/export\/(chunk|finish|cancel)\/([0-9a-f-]{36})$/.exec(p);
      if (exportRoute && req.method === 'POST') {
        const [, action, id] = exportRoute,
          upload = exportUploads.get(id);
        if (!upload)
          return json({ error: '영상 저장 작업이 만료되었거나 존재하지 않습니다.' }, 404);
        upload.updatedAt = Date.now();
        if (action === 'cancel') {
          await cancelExport(upload);
          return json({ cancelled: true });
        }
        if (upload.cancelled || upload.finishing || upload.busy)
          throw new Error('영상 저장 작업이 이미 처리 중입니다.');
        if (action === 'chunk') {
          if (req.headers['x-export-sequence'] !== String(upload.sequence))
            throw new Error('영상 조각 순서가 올바르지 않습니다. 다시 내보내세요.');
          const length = Number(req.headers['content-length']);
          if (
            Number.isFinite(length) &&
            (length > 64 * 1024 * 1024 || upload.bytes + length > maxExportBytes)
          ) {
            await cancelExport(upload);
            throw new Error(
              '영상 원본은 4GB까지 저장할 수 있습니다. 더 짧은 연주로 다시 내보내세요.',
            );
          }
          upload.busy = true;
          upload.input = req;
          let chunkBytes = 0;
          req.on('data', (chunk) => {
            chunkBytes += chunk.length;
            if (chunkBytes > 64 * 1024 * 1024 || upload.bytes + chunkBytes > maxExportBytes)
              req.destroy(new Error('영상 저장 크기 제한을 초과했습니다.'));
          });
          try {
            upload.writing = pipeline(req, createWriteStream(upload.source, { flags: 'a' }));
            await upload.writing;
            upload.bytes += chunkBytes;
            upload.sequence++;
            upload.updatedAt = Date.now();
            return json({ bytes: upload.bytes, sequence: upload.sequence });
          } catch (error) {
            await cancelExport(upload);
            throw error;
          } finally {
            upload.busy = false;
            upload.input = null;
          }
        }
        if (!upload.bytes) throw new Error('저장된 영상 프레임이 없습니다.');
        upload.finishing = true;
        if (upload.format === 'h264') {
          upload.conversion = finishFrameExport(upload);
          try {
            const result = await upload.conversion;
            exportUploads.delete(id);
            return json(result);
          } catch (error) {
            await cancelExport(upload);
            throw error;
          }
        }
        upload.conversion = new Promise((resolve) => {
          const proc = (upload.process = spawn(
            'ffmpeg',
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-y',
              '-i',
              upload.webm,
              ...(upload.hasAudio
                ? [
                    '-i',
                    path.join(DATA, upload.sessionId + '.wav'),
                    '-map',
                    '0:v:0',
                    '-map',
                    '1:a:0',
                    '-af',
                    'apad',
                  ]
                : ['-map', '0:v:0']),
              '-vf',
              `fps=60:start_time=0,tpad=stop_mode=clone:stop_duration=${upload.duration}`,
              '-t',
              String(upload.duration),
              '-r',
              '60',
              '-fps_mode',
              'cfr',
              '-c:v',
              'libx264',
              '-preset',
              'fast',
              '-crf',
              '18',
              '-pix_fmt',
              'yuv420p',
              '-c:a',
              'aac',
              '-movflags',
              '+faststart',
              upload.mp4,
            ],
            { windowsHide: true, stdio: 'ignore' },
          ));
          proc.on('error', () => resolve(false));
          proc.on('close', (code) => resolve(code === 0));
        });
        const converted = await upload.conversion;
        upload.process = null;
        if (upload.cancelled) throw new Error('영상 내보내기를 취소했습니다.');
        if (!converted) await fs.unlink(upload.mp4).catch(() => {});
        exportUploads.delete(id);
        return json({
          url: '/media/' + upload.stem + (converted ? '.mp4' : '.webm'),
          format: converted ? 'mp4' : 'webm',
        });
      }
      let file;
      if (p.startsWith('/media/')) {
        if (!/^[\w-]+\.(wav|mp4|webm|session\.json)$/.test(p.slice(7)))
          throw new Error('잘못된 파일 경로');
        file = path.join(DATA, p.slice(7));
        const take = /^([\w-]+)\.(?:wav|session\.json)$/.exec(p.slice(7));
        if (take) releaseMedia = retainSession(take[1]);
      } else {
        file = path.resolve(ROOT, 'public', p === '/' || p === '/stage' ? 'index.html' : '.' + p);
        if (!file.startsWith(path.join(ROOT, 'public') + path.sep))
          throw new Error('잘못된 파일 경로');
      }
      let reader;
      res.once('close', () => {
        if (reader) reader.destroy();
        else releaseMediaLease();
      });
      const stat = await fs.stat(file);
      if (res.destroyed) return releaseMediaLease();
      let start = 0,
        end = stat.size - 1,
        status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!match) {
          releaseMediaLease();
          res.writeHead(416);
          return res.end();
        }
        start = +match[1];
        end = match[2] ? Math.min(+match[2], end) : end;
        if (start > end || start >= stat.size) {
          releaseMediaLease();
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return res.end();
        }
        status = 206;
      }
      res.writeHead(status, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
      });
      if (req.method === 'HEAD') {
        releaseMediaLease();
        return res.end();
      }
      reader = createReadStream(file, { start, end });
      reader.once('close', releaseMediaLease);
      reader.once('error', () => res.destroy());
      reader.pipe(res);
    } catch (e) {
      releaseMediaLease();
      json(
        { error: e.code === 'ENOENT' ? '파일을 찾지 못했습니다.' : e.message },
        e.code === 'ENOENT' ? 404 : [409, 500].includes(e.statusCode) ? e.statusCode : 400,
      );
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on('upgrade', (req, socket, head) => {
    if (
      req.headers.host !== `127.0.0.1:${port}` ||
      req.headers.origin !== `http://127.0.0.1:${port}`
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    clients.add(ws);
    ws.send(
      JSON.stringify({
        ...state(),
        type: 'hello',
        history: bootstrapHistory(Math.max(0, now() - 20)),
      }),
    );
    const viewer = new URL(req.url, 'http://127.0.0.1').searchParams.has('viewer');
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', echo: msg.echo, serverTime: now() }));
          return;
        }
        if (viewer) throw new Error('보기 전용 화면입니다.');
        await command(msg);
      } catch (e) {
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'notice', kind: 'error', message: e.message }));
      }
    });
    ws.on('close', () => clients.delete(ws));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  // Let isolated tests request an OS-assigned port without risking a live service collision.
  port = server.address().port;
  startBridge();
  const playbackClock = setInterval(() => {
    if (
      transport.playing &&
      transport.position + now() - transport.startedAt >= transportDuration
    ) {
      transport.position = transportDuration;
      transport.playing = false;
      transport.startedAt = now();
      transport.reason = 'ended';
      publish();
    }
  }, 100);
  console.log(`Luma Piano http://127.0.0.1:${port}`);
  return {
    server,
    port,
    close: async () => {
      closing = true;
      clearInterval(expireExports);
      await Promise.all([...exportUploads.values()].map(cancelExport));
      clearInterval(playbackClock);
      if (starting && audio) await stopCapture(audio);
      if (startTask) await startTask.catch(() => {});
      if (recording) await stopRecording();
      if (stopTask) await stopTask;
      if (audio) {
        await stopCapture(audio);
        audio = null;
      }
      await connectionSave;
      await settingsSave.catch(() => {});
      if (bridge?.stdin.writable) bridge.stdin.end('{"type":"quit"}\n');
      for (const c of clients) c.close();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
    state,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startServer();
  let stopped = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, async () => {
      if (stopped) return;
      stopped = true;
      await app.close();
      process.exit(0);
    });
}
