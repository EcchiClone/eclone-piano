import { Performance, PianoRenderer } from './engine.js';
import { DEFAULT_SETTINGS, visualSettings, noteLabel } from './settings.js';
import { loadScenes, saveScene, parseScene, sceneFile, SCENE_STORAGE_KEY } from './presets.js';

const $ = (id) => document.getElementById(id),
  params = new URLSearchParams(location.search),
  viewer = location.pathname === '/stage';
if (viewer) document.body.classList.add('viewer');
const live = new Performance({ notePolicy: 'piano' }),
  cache = new Map();
const sceneStorage = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      throw new Error('장면 저장이 차단됐거나 공간이 부족해요. 장면 파일로 내보내어 보관하세요.');
    }
  },
};
let audioDiscovery = null;
let libraryItems = [],
  playbackVolume = 1,
  volumeBeforeMute = 1;
try {
  const saved = localStorage.getItem('eclone.playbackVolume');
  if (saved !== null && Number.isFinite(Number(saved)))
    playbackVolume = Math.max(0, Math.min(1, Number(saved)));
} catch {}
let socket,
  socketClientId = null,
  state = null,
  offset = 0,
  currentSession = null,
  replay = new Performance(),
  toastTimer,
  count = 0,
  lastMidiAt = 0,
  audio = null,
  audioSession = null,
  audioTransport = null,
  audioWantedPlaying = false,
  audioStartPosition = 0,
  audioPendingSeek = null,
  audioPlayPending = null,
  audioPlayBlocked = false,
  audioRevision = 0,
  audioLoadRevision = 0,
  recordPreparing = false,
  exportAbort = null,
  exporting = false,
  renderFrames = 0,
  sessionLoad = 0;
const serverNow = () => performance.now() / 1000 + offset;
const timeText = (t) => {
  t = Math.max(0, Math.floor(t || 0));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const send = (msg) => {
  if (msg.type === 'seek' && usesAudioClock() && playbackPlaying() && !state.transport.playing)
    msg = { type: 'play', sessionId: audioSession, position: msg.position };
  if (msg.type === 'pause' && usesAudioClock()) {
    msg = { ...msg, position: Number.isFinite(msg.position) ? msg.position : position() };
    audioWantedPlaying = false;
    audio.pause();
    updateUI();
  }
  if (socket?.readyState === 1) socket.send(JSON.stringify(msg));
  else toast('서버 연결을 기다려 주세요.', 'error');
};
function toast(message, kind = 'info') {
  if (viewer) return;
  $('toast').textContent = message;
  $('toast').className = 'visible' + (kind === 'error' ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').className = ''), 6500);
}
function transportPosition() {
  if (!state || state.transport.mode === 'live') return serverNow();
  const tr = state.transport;
  return Math.min(
    currentSession?.duration || Infinity,
    tr.position + (tr.playing ? serverNow() - tr.startedAt : 0),
  );
}
function usesAudioClock() {
  return !!(
    canPlayAudio() &&
    audio &&
    audioSession === state?.transport.sessionId &&
    currentSession?.hasAudio &&
    state.transport.mode !== 'live'
  );
}
function canPlayAudio() {
  return (
    socket?.readyState === 1 &&
    !!socketClientId &&
    (viewer ? params.get('audio') === '1' : state?.studioAudioOwnerId === socketClientId)
  );
}
function position() {
  if (!usesAudioClock()) return transportPosition();
  return Math.max(
    0,
    Math.min(currentSession.duration, audio.readyState ? audio.currentTime : audioStartPosition),
  );
}
function playbackPlaying() {
  return usesAudioClock()
    ? audioWantedPlaying && !audioPlayBlocked && !audio.ended
    : !!state?.transport.playing;
}
const transportKeys = ['mode', 'sessionId', 'position', 'playing', 'startedAt', 'reason'];
const changedTransport = (previous, next) =>
  transportKeys.some((key) => previous?.[key] !== next?.[key]);
function visualState() {
  const mode = state?.transport.mode || 'live',
    settings = state?.settings || {};
  return {
    ...settings,
    notes: mode === 'live' ? live.notes : replay.notes,
    time: position(),
    direction: mode === 'live' ? 'up' : settings.direction,
    background: params.has('transparent') ? 'transparent' : settings.background || 'dark',
    ...(params.get('overlay') === '1'
      ? {
          keyboard: settings.keyboard !== false && settings.overlayKeyboard !== false,
          noteOpacity: settings.overlayNoteOpacity ?? 0.6,
          keyboardOpacity: settings.overlayKeyboardOpacity ?? 0.18,
        }
      : {}),
    quality: 1,
  };
}
const renderer = new PianoRenderer($('pianoCanvas'), visualState);
renderer.start();
async function getSession(id) {
  if (cache.has(id)) return cache.get(id);
  const response = await fetch('/api/session/' + encodeURIComponent(id));
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  cache.set(id, data);
  return data;
}
function stopAudio() {
  audioRevision++;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audio = null;
  }
  audioSession = null;
  audioTransport = null;
  audioWantedPlaying = false;
  audioStartPosition = 0;
  audioPendingSeek = null;
  audioPlayPending = null;
  audioPlayBlocked = false;
}
async function syncSession(initialPosition) {
  const request = ++sessionLoad,
    id = state?.transport.sessionId,
    requestedTransport = state?.transport;
  if (!id) {
    currentSession = null;
    replay.reset();
    stopAudio();
    return;
  }
  if (audioSession && audioSession !== id) stopAudio();
  try {
    const session = await getSession(id);
    if (request !== sessionLoad) return;
    currentSession = session;
    replay = Performance.fromJSON(session);
    if (session.hasAudio && canPlayAudio()) {
      if (audioSession !== id) {
        stopAudio();
        audio = new Audio('/media/' + id + '.wav');
        audio.volume = viewer ? 1 : playbackVolume;
        audio.preload = 'auto';
        audioSession = id;
        const element = audio;
        audio.addEventListener('loadedmetadata', () => {
          if (audio !== element) return;
          if (audioPendingSeek !== null) seekAudio(audioPendingSeek);
          playAudioIfWanted();
        });
        audio.addEventListener('ended', () => {
          if (audio !== element) return;
          audioWantedPlaying = false;
          updateUI();
        });
        audio.addEventListener('error', () =>
          toast('원음 파일을 재생할 수 없습니다. 저장 폴더에서 WAV 파일을 확인하세요.', 'error'),
        );
      }
      syncAudio(
        true,
        !changedTransport(requestedTransport, state.transport) ? initialPosition : undefined,
      );
    } else stopAudio();
    updateUI();
  } catch (error) {
    toast(error.message, 'error');
  }
}
function seekAudio(target) {
  audioStartPosition = Math.max(0, Math.min(currentSession.duration, target));
  try {
    audio.currentTime = audioStartPosition;
    audioPendingSeek = null;
  } catch {
    audioPendingSeek = audioStartPosition;
  }
}
function playAudioIfWanted() {
  if (
    !audio ||
    !audioWantedPlaying ||
    !audio.paused ||
    audio.ended ||
    audioPlayPending ||
    audioPlayBlocked
  )
    return;
  const element = audio,
    revision = audioRevision;
  const pending = Promise.resolve(element.play())
    .catch(() => {
      if (audio !== element || revision !== audioRevision || !audioWantedPlaying) return;
      audioPlayBlocked = true;
      if (!viewer) toast('원음 재생을 시작하려면 재생 버튼을 한 번 눌러 주세요.');
      updateUI();
    })
    .finally(() => {
      if (audio === element && audioPlayPending === pending) {
        audioPlayPending = null;
        playAudioIfWanted();
      }
    });
  audioPlayPending = pending;
}
function syncAudio(force = false, initialPosition) {
  if (!audio || !state || exporting || !usesAudioClock()) return;
  const tr = state.transport;
  if (force || changedTransport(audioTransport, tr)) {
    audioRevision++;
    const previous = audioTransport;
    const naturalEnd = tr.reason === 'ended' && previous?.playing && !tr.playing;
    audioTransport = { ...tr };
    if (!naturalEnd) {
      audioWantedPlaying = !!tr.playing;
      audioPlayBlocked = false;
      // Pause at the sample currently being heard. A later explicit seek or
      // resume carries its own requested position and may intentionally move it.
      const justPaused = previous?.playing && !tr.playing;
      if (!justPaused) seekAudio(Number.isFinite(initialPosition) ? initialPosition : tr.position);
      if (!audioWantedPlaying) audio.pause();
    }
    // Natural server completion must not discard a media tail that began after
    // buffering. The local visual clock follows that tail until audio 'ended'.
  }
  playAudioIfWanted();
}
function connectSocket() {
  socket = new WebSocket(`ws://${location.host}/?${viewer ? 'viewer=1' : ''}`);
  socket.onopen = () => {
    if (!viewer) {
      $('serverState').classList.add('online');
      $('serverState').innerHTML = '<i></i> 앱 연결됨';
    }
    socket.send(JSON.stringify({ type: 'ping', echo: performance.now() / 1000 }));
  };
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'hello' || msg.type === 'state') {
      const audioAllowedBefore = canPlayAudio();
      const oldTransport = state?.transport;
      const oldId = oldTransport?.sessionId;
      const transportChanged = changedTransport(oldTransport, msg.transport);
      if (msg.type === 'hello') socketClientId = msg.clientId;
      state = msg;
      const audioPermissionChanged = audioAllowedBefore !== canPlayAudio();
      if (!canPlayAudio()) stopAudio();
      if (state.starting || state.recording || state.stopping) recordPreparing = false;
      offset = msg.serverTime - performance.now() / 1000;
      count = msg.midiCount;
      if (msg.type === 'hello') {
        live.reset();
        for (const e of msg.history || []) live.ingest(e);
      }
      if (oldId !== msg.transport.sessionId || msg.type === 'hello' || audioPermissionChanged)
        syncSession(msg.type === 'hello' ? transportPosition() : msg.transport.position);
      else syncAudio(transportChanged);
      updateUI();
    } else if (msg.type === 'midi') {
      live.ingest(msg);
      if (!msg.synthetic) {
        lastMidiAt = performance.now();
        count++;
      }
      if (!viewer && !msg.synthetic) {
        $('emptyMessage').hidden = true;
        $('midiLight').classList.add('pulse');
        $('eventCount').textContent = count.toLocaleString() + ' events';
        const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
        const cmd = msg.data[0] & 240;
        if (cmd === 144 && msg.data[2])
          $('footerStatus').textContent =
            `${names[msg.data[1] % 12]}${Math.floor(msg.data[1] / 12) - 1} · Velocity ${msg.data[2]} · Ch ${(msg.data[0] & 15) + 1}`;
      }
    } else if (msg.type === 'deleted') {
      cache.delete(msg.sessionId);
      if (audioSession === msg.sessionId) stopAudio();
      loadLibrary();
    } else if (msg.type === 'panic') {
      live.finish(msg.t);
    } else if (msg.type === 'pong') {
      const received = performance.now() / 1000;
      offset = msg.serverTime - (received + msg.echo) / 2;
    } else if (msg.type === 'notice') {
      if (msg.kind === 'error') {
        recordPreparing = false;
        updateUI();
      }
      toast(msg.message, msg.kind);
      if (msg.code === 'AUDIO_SOURCE_CHANGED') loadAudio();
    } else if (msg.type === 'audioLevel') {
      if (!viewer) {
        $('audioMeter').style.width = Math.min(100, Math.sqrt(msg.peak) * 100) + '%';
        const peak = Math.max(0, Number(msg.peak) || 0);
        $('audioLevelText').textContent =
          peak > 0.0001 ? (20 * Math.log10(peak)).toFixed(1) + ' dBFS' : '입력 대기';
        document.querySelector('.capture-card').classList.toggle('clipping', peak >= 0.98);
        if (state?.recording)
          $('recordHint').textContent =
            msg.peak > 0.0001
              ? peak >= 0.98
                ? '입력이 최대치에 가까워요. Kontakt 출력 음량을 낮춰 주세요.'
                : 'Kontakt 원음 수신 중'
              : '오디오 신호 대기 중 · 소리가 들려도 미터가 조용하면 출력 설정을 확인하세요.';
      }
    } else if (msg.type === 'audioFinal') {
      if (msg.silent)
        toast(
          '녹음된 오디오가 무음에 가깝습니다. Kontakt 출력 설정과 입력 미터를 확인하세요.',
          'error',
        );
    } else if (msg.type === 'saved') {
      cache.set(msg.session.id, msg.session);
      loadLibrary();
      toast('연주를 저장했습니다. 내 연주에서 원음과 함께 다시 재생할 수 있어요.');
    }
  };
  socket.onclose = () => {
    socketClientId = null;
    stopAudio();
    recordPreparing = false;
    updateUI();
    if (!viewer) {
      $('serverState').classList.remove('online');
      $('serverState').innerHTML = '<i></i> 재연결 중';
    }
    live.finish(serverNow());
    setTimeout(connectSocket, 2000);
  };
  socket.onerror = () => {};
}
function updateUI() {
  if (!state || viewer) return;
  const s = state.settings,
    tr = state.transport,
    liveMode = tr.mode === 'live',
    demoMode = tr.mode === 'demo',
    busy = !!(state.recording || state.starting || state.stopping || recordPreparing);
  $('modeTag').innerHTML = `<i></i> ${liveMode ? 'LIVE' : demoMode ? 'DEMO' : 'REPLAY'}`;
  $('modeTag').className = 'mode-tag ' + (demoMode ? 'demo' : liveMode ? '' : 'replay');
  $('stageCaption').textContent = liveMode
    ? state.midiStatus.connected
      ? 'MIDI 연결됨 · 건반을 연주해 보세요'
      : 'MIDI 입력 대기 중'
    : demoMode
      ? '디자인 미리보기 · 무음 데모'
      : '저장된 연주';
  $('emptyMessage').hidden = !liveMode || live.notes.length > 0;
  $('takeTitle').textContent = liveMode
    ? '라이브 연주'
    : currentSession?.name || '연주 불러오는 중';
  $('takeSubtitle').textContent = liveMode
    ? '지금 연주하는 음을 실시간으로 표시합니다.'
    : demoMode
      ? '데모 시각화 · 실제 입력이 아닙니다'
      : currentSession?.hasAudio
        ? state.studioAudioOwnerId && !canPlayAudio()
          ? '다른 스튜디오 창에서 원음 재생 · 이 창은 화면만 표시'
          : canPlayAudio()
            ? '이 창에서 원음 WAV와 함께 재생'
            : '재생을 누르면 이 창에서 원음 출력'
        : 'MIDI 시각화 · 원음 없음';
  $('seek').disabled = liveMode;
  $('seek').max = currentSession?.duration || 1;
  $('duration').textContent = liveMode ? 'LIVE' : timeText(currentSession?.duration);
  $('playButton').textContent = playbackPlaying() ? 'Ⅱ' : '▶';
  $('playButton').title = liveMode ? '무음 데모 재생' : playbackPlaying() ? '일시정지' : '재생';
  $('playButton').setAttribute('aria-label', $('playButton').title);
  $('stageDirection').textContent =
    (liveMode || s.direction === 'up' ? 'RISING' : 'FALLING') +
    (liveMode ? ' · REAL TIME' : ' · PLAYBACK');
  document
    .querySelectorAll('[data-theme]')
    .forEach((b) => b.classList.toggle('active', b.dataset.theme === s.theme && !s.useCustomColor));
  $('themeName').textContent = s.useCustomColor
    ? '직접 색상'
    : { aurora: 'Aurora', amber: 'Golden', violet: 'Violet' }[s.theme];
  $('useCustomColor').checked = !!s.useCustomColor;
  if (document.activeElement !== $('customColor')) $('customColor').value = s.customColor;
  $('customColor').disabled = !s.useCustomColor;
  $('customColorValue').textContent = s.customColor;
  document.querySelectorAll('[data-direction]').forEach((b) => {
    b.classList.toggle('active', b.dataset.direction === (liveMode ? 'up' : s.direction));
    b.classList.toggle('unavailable', liveMode && b.dataset.direction === 'down');
  });
  $('flowDescription').textContent = liveMode ? '실시간' : '재생';
  $('flowHelp').textContent = liveMode
    ? '실시간 연주는 건반에서 위로 뻗어 나갑니다.'
    : '내려오는 노트를 미리 보며 저장된 연주를 감상하세요.';
  $('secondsVisible').value = s.secondsVisible;
  $('audioSampleRate').value = String(s.audioSampleRate ?? 44100);
  $('secondsValue').textContent = Number(s.secondsVisible).toFixed(1) + '초';
  if (document.activeElement !== $('glow')) $('glow').value = s.glow;
  for (const key of ['hitStrength', 'keyboardHeight']) {
    if (document.activeElement !== $(key)) $(key).value = s[key];
    $(key + 'Value').textContent = Math.round(s[key] * 100) + '%';
  }
  $('glowValue').textContent = Math.round(s.glow * 100) + '%';
  for (const key of ['particles', 'keyboard', 'labels']) $(key).checked = s[key];
  $('overlayKeyboard').checked = s.overlayKeyboard !== false;
  for (const [key, fallback] of [
    ['overlayNoteOpacity', 0.6],
    ['overlayKeyboardOpacity', 0.18],
  ]) {
    $(key).value = s[key] ?? fallback;
    $(key + 'Value').textContent = Math.round((s[key] ?? fallback) * 100) + '%';
  }
  $('transparent').checked = s.background === 'transparent';
  const range =
    { '21:108': '88', '36:96': '61', '36:84': '49', '48:84': '37' }[s.minNote + ':' + s.maxNote] ||
    'custom';
  if ($('noteRange').value !== 'custom' || range === 'custom') $('noteRange').value = range;
  $('customRange').hidden = $('noteRange').value !== 'custom';
  $('minNote').value = s.minNote;
  $('maxNote').value = s.maxNote;
  $('stageKeys').textContent = s.maxNote - s.minNote + 1 + ' KEYS';
  document
    .querySelector('.preview-frame')
    .classList.toggle('transparent-preview', s.background === 'transparent');
  const previous = $('midiInput').value,
    signature = JSON.stringify(state.ports.inputs);
  if ($('midiInput').dataset.signature !== signature) {
    $('midiInput').innerHTML = state.ports.inputs.length
      ? state.ports.inputs.map((p) => `<option value="${p.id}">${escape(p.name)}</option>`).join('')
      : '<option value="">MIDI 장치 없음</option>';
    $('midiInput').dataset.signature = signature;
    const preferred = state.ports.inputs.find((p) => /eclone|luma|loopmidi/i.test(p.name));
    if (preferred) $('midiInput').value = preferred.id;
    else if (state.ports.inputs.some((p) => String(p.id) === previous))
      $('midiInput').value = previous;
  }
  if (state.midiStatus.connected && state.midiStatus.inputId != null)
    $('midiInput').value = state.midiStatus.inputId;
  $('connectButton').textContent = state.midiStatus.connected ? '연결 해제' : '연결';
  $('connectButton').disabled = !state.midiStatus.connected && !state.ports.inputs.length;
  $('midiInput').disabled = state.midiStatus.connected;
  $('midiStatus').textContent = state.midiStatus.connected
    ? '입력 연결됨'
    : state.midiStatus.error
      ? '연결 확인 필요'
      : '연결되지 않음';
  $('midiStatus').title = state.midiStatus.error || '';
  $('connectionHelp').textContent =
    state.midiStatus.error ||
    (state.midiStatus.connected
      ? '건반과 페달을 눌렀다 떼며 노트가 끝나는지 확인하세요.'
      : 'MIDI 입력을 선택해 연결하세요. 소리를 내려면 Kontakt나 외부 음원이 필요합니다.');
  const volumeAvailable = !liveMode && !demoMode && !!currentSession?.hasAudio;
  $('playbackVolume').disabled = !volumeAvailable;
  $('muteAudio').disabled = !volumeAvailable;
  $('midiLight').classList.toggle('connected', state.midiStatus.connected);
  $('eventCount').textContent = count.toLocaleString() + ' events';
  $('recordButton').classList.toggle('recording', !!state.recording);
  $('recordLabel').textContent = recordPreparing
    ? 'Kontakt 확인 중…'
    : state.starting
      ? '오디오 연결 중…'
      : state.stopping
        ? '저장 중…'
        : state.recording
          ? '녹음 종료'
          : '녹음 시작';
  $('recordButton').disabled = !!(recordPreparing || state.starting || state.stopping);
  $('refreshAudio').disabled = busy;
  for (const id of ['takeName', 'audioProcess', 'withAudio']) $(id).disabled = busy;
  $('audioProcess').disabled = busy || !$('withAudio').checked;
  $('audioSampleRate').disabled = busy || !$('withAudio').checked;
  $('demoButton').disabled = busy;
  $('playButton').disabled = busy;
  $('audioLevelText').hidden = !state.recording?.withAudio;
  $('captureFormat').textContent = $('withAudio').checked ? 'MIDI + 원음 WAV' : 'MIDI 시각화';
  if (!busy) {
    document.querySelector('.capture-card').classList.remove('clipping');
    $('audioMeter').style.width = '0';
    $('recordHint').textContent = $('withAudio').checked
      ? audioDiscovery === 0
        ? 'Kontakt를 찾지 못했어요. MIDI만 저장하려면 원음 녹음을 해제하세요.'
        : 'Kontakt와 같은 샘플레이트인지 확인하세요. 원음은 녹음 중에 확인할 수 있습니다.'
      : 'MIDI만 저장합니다. 다시 재생하거나 영상으로 내보낼 때 소리는 포함되지 않습니다.';
  }
}
async function loadAudio({ strict = false } = {}) {
  if (viewer) return;
  const revision = ++audioLoadRevision;
  const selected = $('audioProcess').value;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 8000);
  try {
    const r = await fetch('/api/audio', { signal: abort.signal });
    const data = await r.json();
    if (!r.ok || data.error)
      throw new Error(
        data.error
          ? 'Kontakt 목록을 확인하지 못했습니다. ' + data.error
          : '오디오 소스를 확인하지 못했습니다.',
      );
    if (revision !== audioLoadRevision) return null;
    const processes = (data.processes || []).filter((p) => Number.isInteger(p.pid) && p.pid > 0);
    const choice = processes.some((p) => String(p.pid) === selected)
      ? selected
      : processes.length === 1
        ? String(processes[0].pid)
        : '';
    const placeholder = processes.length ? '녹음할 Kontakt를 선택하세요' : 'Kontakt를 실행하세요';
    $('audioProcess').innerHTML =
      (choice ? '' : `<option value="">${placeholder}</option>`) +
      processes
        .map(
          (p) =>
            `<option value="${p.pid}">${escape(p.name)}${processes.length > 1 ? ' · PID ' + p.pid : ''}</option>`,
        )
        .join('');
    $('audioProcess').value = choice;
    audioDiscovery = processes.length;
    updateUI();
    return { pid: Number(choice) || null, count: processes.length };
  } catch (error) {
    if (revision === audioLoadRevision)
      $('audioProcess').innerHTML = '<option value="">오디오 소스 확인 필요</option>';
    const failure = new Error(
      error.name === 'AbortError'
        ? 'Kontakt 확인 시간이 초과됐습니다. 잠시 후 다시 시도하세요.'
        : error.message === 'Failed to fetch'
          ? '오디오 소스 정보를 읽지 못했습니다. 다시 시도하세요.'
          : error.message,
    );
    if (strict) throw failure;
    toast(failure.message, 'error');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
function renderLibrary() {
  const query = $('librarySearch').value.trim().toLocaleLowerCase();
  const filter = $('libraryFilter').value,
    sort = $('librarySort').value;
  const items = libraryItems
    .filter(
      (s) =>
        s.name.toLocaleLowerCase().includes(query) &&
        (filter === 'all' || (filter === 'audio' ? s.hasAudio : !s.hasAudio)),
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name, 'ko')
        : sort === 'duration'
          ? b.duration - a.duration
          : new Date(b.createdAt) - new Date(a.createdAt),
    );
  $('sessionCount').textContent = libraryItems.length;
  $('libraryCount').textContent = libraryItems.length;
  $('libraryResults').textContent =
    query || filter !== 'all' ? items.length + '개 표시 · 전체 ' + libraryItems.length + '개' : '';
  $('sessionList').innerHTML = items.length
    ? items
        .map(
          (s) =>
            `<article class="session-card"><div class="session-icon">♩</div><div class="session-info"><strong title="${escape(s.name)}">${escape(s.name)}</strong><small>${new Date(s.createdAt).toLocaleDateString('ko-KR')} · ${timeText(s.duration)} · ${s.hasAudio ? '원음 포함' : '시각화만'}</small></div><div class="session-actions"><button class="button outline" data-play="${s.id}">▷ 재생</button><button class="button export-button" data-export="${s.id}">영상 내보내기</button><details class="session-more"><summary aria-label="${escape(s.name)} 다운로드">다운로드</summary><div class="menu-content"><a href="/api/midi/${s.id}" download="performance.mid">MIDI 파일</a>${s.hasAudio ? `<a href="/media/${s.id}.wav" download>원음 WAV</a>` : ''}<a href="/media/${s.id}.session.json" download>세션 JSON</a></div></details><button class="button delete-button" data-delete="${s.id}" data-name="${escape(s.name)}" aria-label="${escape(s.name)} 삭제">삭제</button></div></article>`,
        )
        .join('')
    : '<div class="library-empty">' +
      (libraryItems.length
        ? '조건에 맞는 연주가 없어요. 검색어나 종류를 바꿔 보세요.'
        : '저장한 연주가 없어요. 위에서 짧게 녹음해 보세요.') +
      '</div>';
}
async function loadLibrary() {
  if (viewer) return;
  try {
    const response = await fetch('/api/sessions');
    if (!response.ok) throw new Error();
    libraryItems = (await response.json())
      .filter((s) => typeof s.id === 'string')
      .map((s) => ({ ...s, name: typeof s.name === 'string' ? s.name : '이름 없는 연주' }));
    renderLibrary();
  } catch {
    toast('저장된 연주 목록을 읽지 못했습니다.', 'error');
  }
}
const setSettings = (patch) => send({ type: 'settings', settings: patch });
let pendingDelete = null;
function showDeleteDialog(id, name) {
  if (exporting) return toast('영상 내보내기가 끝난 뒤 연주를 삭제할 수 있습니다.');
  pendingDelete = id;
  $('deleteTakeName').textContent = name;
  $('confirmDelete').disabled = false;
  $('confirmDelete').textContent = '연주 삭제';
  $('deleteDialog').showModal();
}
async function exportVideo(id) {
  if (exporting) return;
  if (state?.recording || state?.starting || state?.stopping) {
    toast('녹음을 마친 뒤 영상을 내보내세요.');
    return;
  }
  exporting = true;
  let cancelled = false,
    exportRenderer,
    canvas,
    uploadId,
    sequence = 0;
  const abort = new AbortController();
  const check = () => {
    if (cancelled || abort.signal.aborted) throw new Error('EXPORT_CANCELLED');
  };
  const request = async (url, body, headers = {}) => {
    check();
    const response = await fetch(url, { method: 'POST', body, headers, signal: abort.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '영상 저장 요청이 실패했습니다.');
    return result;
  };
  $('exportDialog').showModal();
  $('exportTitle').textContent = '영상으로 담는 중';
  $('exportDescription').textContent =
    '1920 × 1080 · 60fps로 모든 프레임을 차례로 만듭니다. 컴퓨터 성능에 따라 연주 길이보다 오래 걸릴 수 있습니다.';
  $('exportProgress').value = 0;
  $('exportStatus').textContent = '준비 중…';
  $('exportDownload').hidden = true;
  $('cancelExport').hidden = false;
  $('cancelExport').textContent = '취소';
  exportAbort = () => {
    cancelled = true;
    abort.abort();
  };
  try {
    const take = await getSession(id);
    check();
    const model = Performance.fromJSON(take),
      fps = 60,
      options = {
        ...state.settings,
        background: 'dark',
        notes: model.notes,
        quality: 1,
        pixelRatio: 1,
        time: 0,
      };
    const playbackPosition = position();
    if (audio) audio.pause();
    send({ type: 'pause', position: playbackPosition });
    renderer.stop();
    ({ uploadId } = await request(
      '/api/export/start',
      JSON.stringify({
        sessionId: id,
        format: 'h264',
        fps,
        totalFrames: Math.ceil(take.duration * fps),
      }),
      { 'Content-Type': 'application/json' },
    ));
    canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    canvas.style.cssText = 'position:fixed;left:-20000px;width:1920px;height:1080px';
    document.body.appendChild(canvas);
    exportRenderer = new PianoRenderer(canvas, () => options);
    const { encodeCanvasFrames } = await import('./offline-video.js');
    window.ecloneExportDiagnostics = window.lumaExportDiagnostics = await encodeCanvasFrames({
      canvas,
      duration: take.duration,
      signal: abort.signal,
      render: (time) => {
        options.time = time;
        exportRenderer.renderAt(time);
      },
      onChunk: (chunk) =>
        request('/api/export/chunk/' + uploadId, chunk, {
          'X-Export-Sequence': String(sequence++),
        }),
      onProgress: (report) => {
        window.ecloneExportDiagnostics = window.lumaExportDiagnostics = report;
        $('exportProgress').value = report.renderedFrames / report.totalFrames;
        $('exportStatus').textContent =
          `${report.renderedFrames.toLocaleString()} / ${report.totalFrames.toLocaleString()} 프레임 · 1080p · 60fps`;
      },
    });
    check();
    $('exportStatus').textContent = '원음을 합치고 프레임 수를 검증하는 중…';
    const result = await request('/api/export/finish/' + uploadId);
    uploadId = null;
    $('exportTitle').textContent = '영상이 준비됐어요.';
    $('exportDescription').textContent = '모든 프레임과 원음을 담은 60fps MP4 영상을 저장했습니다.';
    $('exportStatus').textContent = '1920 × 1080 · 60fps · MP4';
    $('exportProgress').value = 1;
    $('exportDownload').href = result.url;
    $('exportDownload').download =
      `${take.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)}-${options.theme}.mp4`;
    $('exportDownload').hidden = false;
    $('cancelExport').textContent = '닫기';
  } catch (error) {
    if (!cancelled) toast(error.message, 'error');
    $('exportDialog').close();
  } finally {
    abort.abort();
    if (uploadId) await fetch('/api/export/cancel/' + uploadId, { method: 'POST' }).catch(() => {});
    exportRenderer?.destroy();
    canvas?.remove();
    renderer.start();
    exporting = false;
    exportAbort = null;
  }
}

if (!viewer) {
  $('helpButton').onclick = () => $('helpDialog').showModal();
  $('obsButton').onclick = () => $('obsDialog').showModal();
  document
    .querySelectorAll('[data-close]')
    .forEach((b) => (b.onclick = () => $(b.dataset.close).close()));
  $('copyObs').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('obsUrl').value);
      toast('OBS 브라우저 소스 주소를 복사했습니다.');
    } catch {
      $('obsUrl').select();
      toast('주소를 선택했습니다. Ctrl+C로 복사하세요.');
    }
  };
  $('obsAudio').onchange = () =>
    ($('obsUrl').value =
      location.origin + '/stage?transparent=1' + ($('obsAudio').checked ? '&audio=1' : ''));
  $('openStage').onclick = () => window.open($('obsUrl').value, '_blank');
  $('demoButton').onclick = $('emptyDemo').onclick = () =>
    send({ type: 'play', sessionId: 'demo', position: 0 });
  $('playButton').onclick = () => {
    if (playbackPlaying()) send({ type: 'pause', position: position() });
    else
      send({
        type: 'play',
        sessionId: state?.transport.sessionId || 'demo',
        position:
          position() >= (currentSession?.duration || Infinity)
            ? 0
            : state?.transport.mode === 'live'
              ? 0
              : position(),
      });
  };
  $('returnLive').onclick = () => send({ type: 'live' });
  $('liveTab').onclick = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('liveTab').classList.add('active');
    $('libraryTab').classList.remove('active');
  };
  $('libraryTab').onclick = () => {
    $('library').scrollIntoView({ behavior: 'smooth' });
    $('libraryTab').classList.add('active');
    $('liveTab').classList.remove('active');
  };
  $('seek').oninput = () => send({ type: 'seek', position: Number($('seek').value) });
  $('connectButton').onclick = () => {
    if (state?.midiStatus.connected) send({ type: 'disconnect' });
    else if ($('midiInput').value !== '')
      send({ type: 'connect', inputId: Number($('midiInput').value) });
    else toast('가상 MIDI 포트를 만든 뒤 새로고침하세요.');
  };
  $('refreshPorts').onclick = () => send({ type: 'refreshPorts' });
  $('panicButton').onclick = () => send({ type: 'panic' });
  document
    .querySelectorAll('[data-theme]')
    .forEach(
      (b) => (b.onclick = () => setSettings({ theme: b.dataset.theme, useCustomColor: false })),
    );
  document.querySelectorAll('[data-direction]').forEach(
    (b) =>
      (b.onclick = () => {
        if (b.dataset.direction === 'down' && state?.transport.mode === 'live') {
          toast('하강형은 저장된 연주나 데모를 재생할 때 사용할 수 있습니다.');
          return;
        }
        setSettings({ direction: b.dataset.direction });
      }),
  );
  for (const key of ['particles', 'keyboard', 'labels', 'overlayKeyboard', 'useCustomColor'])
    $(key).onchange = () => setSettings({ [key]: $(key).checked });
  for (const key of [
    'secondsVisible',
    'glow',
    'overlayNoteOpacity',
    'overlayKeyboardOpacity',
    'hitStrength',
    'keyboardHeight',
  ])
    $(key).oninput = () => {
      const value = Number($(key).value);
      if ($(key + 'Value'))
        $(key + 'Value').textContent =
          key === 'secondsVisible' ? value.toFixed(1) + '초' : Math.round(value * 100) + '%';
      setSettings({ [key]: value });
    };
  $('transparent').onchange = () =>
    setSettings({ background: $('transparent').checked ? 'transparent' : 'dark' });
  $('noteRange').onchange = () => {
    $('customRange').hidden = $('noteRange').value !== 'custom';
    const range = {
      37: { minNote: 48, maxNote: 84 },
      49: { minNote: 36, maxNote: 84 },
      61: { minNote: 36, maxNote: 96 },
      88: { minNote: 21, maxNote: 108 },
    }[$('noteRange').value];
    if (range) setSettings(range);
  };
  for (const [id, first, last] of [
    ['minNote', 0, 126],
    ['maxNote', 1, 127],
  ])
    $(id).innerHTML = Array.from(
      { length: last - first + 1 },
      (_, i) => '<option value="' + (i + first) + '">' + noteLabel(i + first) + '</option>',
    ).join('');
  for (const id of ['minNote', 'maxNote'])
    $(id).onchange = () => {
      let minNote = Number($('minNote').value),
        maxNote = Number($('maxNote').value);
      if (minNote >= maxNote) {
        if (id === 'minNote') maxNote = Math.min(127, minNote + 12);
        else minNote = Math.max(0, maxNote - 12);
      }
      setSettings({ minNote, maxNote });
    };
  $('fitRange').onclick = () => {
    const notes = state?.transport.mode === 'live' ? live.notes : replay.notes;
    if (!notes.length) return toast('먼저 몇 음을 연주하거나 저장한 연주를 열어 주세요.');
    const [low, high] = notes.reduce(
      ([lo, hi], n) => [Math.min(lo, n.note), Math.max(hi, n.note)],
      [127, 0],
    );
    const minNote = Math.max(0, Math.floor(low / 12) * 12),
      maxNote = Math.min(127, Math.max(minNote + 12, Math.ceil(high / 12) * 12));
    setSettings({ minNote, maxNote });
    toast('연주한 음이 들어오도록 표시 범위를 맞췄어요.');
  };
  $('customColor').oninput = () =>
    setSettings({ customColor: $('customColor').value, useCustomColor: true });
  function panel(name) {
    $('appearancePanel').hidden = name !== 'scene';
    $('overlayPanel').hidden = name !== 'overlay';
    $('sceneTab').setAttribute('aria-selected', String(name === 'scene'));
    $('overlayTab').setAttribute('aria-selected', String(name === 'overlay'));
    $('sceneTab').tabIndex = name === 'scene' ? 0 : -1;
    $('overlayTab').tabIndex = name === 'overlay' ? 0 : -1;
    $('panelScope').textContent =
      name === 'scene'
        ? '장면 디자인은 OBS와 영상에도 반영됩니다.'
        : '이 탭의 설정은 데스크톱 오버레이에만 적용됩니다.';
  }
  $('sceneTab').onclick = () => panel('scene');
  $('overlayTab').onclick = () => panel('overlay');
  for (const [name, other] of [
    ['scene', 'overlay'],
    ['overlay', 'scene'],
  ])
    $(name + 'Tab').onkeydown = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        panel(other);
        $(other + 'Tab').focus();
      }
    };
  for (const id of ['librarySearch', 'libraryFilter', 'librarySort'])
    $(id).addEventListener(id === 'librarySearch' ? 'input' : 'change', renderLibrary);
  function volume(value) {
    playbackVolume = Math.max(0, Math.min(1, value));
    if (playbackVolume) volumeBeforeMute = playbackVolume;
    if (audio) audio.volume = viewer ? 1 : playbackVolume;
    $('playbackVolume').value = playbackVolume;
    $('playbackVolumeValue').textContent = Math.round(playbackVolume * 100) + '%';
    $('muteAudio').textContent = playbackVolume ? '음량' : '음소거';
    $('muteAudio').setAttribute('aria-pressed', String(playbackVolume === 0));
    try {
      localStorage.setItem('eclone.playbackVolume', String(playbackVolume));
    } catch {}
  }
  $('playbackVolume').oninput = () => volume(Number($('playbackVolume').value));
  $('muteAudio').onclick = () => volume(playbackVolume ? 0 : volumeBeforeMute || 1);
  volume(playbackVolume);
  function scenes(selected = $('sceneSelect').value) {
    const list = loadScenes(sceneStorage);
    $('sceneSelect').innerHTML =
      '<option value="">저장한 장면</option>' +
      list
        .map((s) => '<option value="' + escape(s.name) + '">' + escape(s.name) + '</option>')
        .join('');
    $('sceneSelect').value = selected;
    $('deleteScene').disabled = !$('sceneSelect').value;
  }
  scenes();
  $('sceneSelect').onchange = () => {
    const scene = loadScenes(sceneStorage).find((s) => s.name === $('sceneSelect').value);
    if (scene) {
      setSettings(scene.settings);
      toast(scene.name + ' 장면을 적용했어요.');
    }
    scenes();
  };
  $('saveScene').onclick = () => {
    $('sceneName').value = $('sceneSelect').value;
    $('sceneDialog').showModal();
    $('sceneName').focus();
  };
  $('confirmSceneSave').onclick = () => {
    try {
      const name = $('sceneName').value.trim();
      saveScene(sceneStorage, { name, settings: state.settings });
      scenes(name);
      $('sceneDialog').close();
      toast('장면을 저장했어요.');
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  $('sceneName').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('confirmSceneSave').click();
    }
  };
  $('deleteScene').onclick = () => {
    const name = $('sceneSelect').value;
    if (!name) return;
    try {
      sceneStorage.setItem(
        SCENE_STORAGE_KEY,
        JSON.stringify(loadScenes(sceneStorage).filter((s) => s.name !== name)),
      );
      scenes('');
      document.querySelector('.scene-tools').open = false;
      toast('저장 목록에서 장면을 지웠어요. 현재 디자인은 계속 사용할 수 있습니다.');
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  $('resetAppearance').onclick = () => {
    setSettings(visualSettings(DEFAULT_SETTINGS));
    scenes('');
    document.querySelector('.scene-tools').open = false;
    toast('기본 디자인을 적용했어요.');
  };
  $('exportScene').onclick = () => {
    const blob = new Blob([sceneFile($('sceneSelect').value || '나의 장면', state.settings)], {
      type: 'application/json',
    });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = 'eclone-scene.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    document.querySelector('.scene-tools').open = false;
  };
  $('importScene').onclick = () => $('sceneFile').click();
  $('sceneFile').onchange = async () => {
    try {
      const file = $('sceneFile').files[0];
      if (!file) return;
      if (file.size > 65536) throw new Error('장면 파일은 64KB 이하로 선택하세요.');
      const scene = parseScene(await file.text());
      const base = scene.name;
      let suffix = 2;
      const existing = loadScenes(sceneStorage);
      while (existing.some((saved) => saved.name === scene.name))
        scene.name = base.slice(0, 50) + ' (' + suffix++ + ')';
      saveScene(sceneStorage, scene);
      setSettings(scene.settings);
      scenes(scene.name);
      toast('장면을 가져왔어요.');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      $('sceneFile').value = '';
      document.querySelector('.scene-tools').open = false;
    }
  };
  $('fullscreenButton').onclick = () => {
    const frame = document.querySelector('.preview-frame');
    if (document.fullscreenElement) document.exitFullscreen();
    else frame.requestFullscreen().catch(() => window.open('/stage', '_blank'));
  };
  $('refreshAudio').onclick = loadAudio;
  $('withAudio').onchange = () => updateUI();
  $('audioSampleRate').onchange = () =>
    setSettings({ audioSampleRate: Number($('audioSampleRate').value) });
  $('recordButton').onclick = async () => {
    if (recordPreparing || state?.starting || state?.stopping) return;
    if (state?.recording) {
      send({ type: 'stopRecord' });
      return;
    }
    recordPreparing = true;
    updateUI();
    let sent = false;
    try {
      const withAudio = $('withAudio').checked;
      const source = withAudio ? await loadAudio({ strict: true }) : null;
      if (withAudio && !source?.pid)
        throw new Error(
          source?.count > 1
            ? 'Kontakt가 여러 개 실행 중입니다. 녹음할 소스를 선택한 뒤 다시 시작하세요.'
            : '실행 중인 Kontakt를 찾지 못했습니다. Kontakt를 실행한 뒤 다시 녹음하세요.',
        );
      if (state?.recording || state?.starting || state?.stopping)
        throw new Error('다른 화면에서 녹음 상태가 바뀌었습니다. 현재 상태를 확인하세요.');
      if (socket?.readyState !== 1) throw new Error('서버 연결을 기다린 뒤 다시 녹음하세요.');
      send({
        type: 'record',
        name: $('takeName').value,
        withAudio,
        pid: source?.pid,
        sampleRate: Number($('audioSampleRate').value),
      });
      sent = true;
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      if (!sent) recordPreparing = false;
      updateUI();
    }
  };
  $('sessionList').onclick = (e) => {
    const play = e.target.closest('[data-play]'),
      exp = e.target.closest('[data-export]'),
      del = e.target.closest('[data-delete]');
    if (play) send({ type: 'play', sessionId: play.dataset.play, position: 0 });
    if (exp) exportVideo(exp.dataset.export);
    if (del) showDeleteDialog(del.dataset.delete, del.dataset.name);
  };
  $('confirmDelete').onclick = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete;
    $('confirmDelete').disabled = true;
    $('confirmDelete').textContent = '삭제 중…';
    try {
      const response = await fetch('/api/session/' + encodeURIComponent(id), { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '연주를 삭제하지 못했습니다.');
      cache.delete(id);
      if (audioSession === id) stopAudio();
      pendingDelete = null;
      $('deleteDialog').close();
      await loadLibrary();
      toast('연주와 원음을 앱 휴지통으로 옮겼습니다. 내보낸 영상은 유지됩니다.');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      $('confirmDelete').disabled = false;
      $('confirmDelete').textContent = '연주 삭제';
    }
  };
  $('importButton').onclick = () => $('importFile').click();
  $('importFile').onchange = async () => {
    const file = $('importFile').files[0];
    if (!file) return;
    try {
      if (file.size > 20_000_000) throw new Error('세션 파일은 20MB 이하만 지원합니다.');
      const response = await fetch('/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: await file.text(),
        }),
        result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await loadLibrary();
      toast('MIDI 세션을 가져왔습니다. 원음 파일은 포함되지 않습니다.');
    } catch (e) {
      toast(e.message, 'error');
    }
    $('importFile').value = '';
  };
  $('folderButton').onclick = () =>
    window.desktop
      ? window.desktop.recordings()
      : toast('프로젝트의 recordings 폴더에 저장됩니다.');
  $('overlayButton').onclick = () => {
    const id = Number($('displaySelect').value) || undefined;
    if (window.desktop) window.desktop.overlay(id);
    else send({ type: 'overlay', displayId: id });
  };
  if (window.desktop)
    window.desktop.displays().then((displays) => {
      $('displaySelect').innerHTML = displays
        .map((d) => `<option value="${d.id}">${escape(d.label)} · ${d.width}×${d.height}</option>`)
        .join('');
    });
  if (window.desktop?.appInfo) {
    window.desktop.appInfo().then((info) => {
      $('appVersion').textContent = `v${info.version}`;
    });
    $('licensesButton').hidden = false;
    $('licensesButton').onclick = () => window.desktop.licenses();
  }
  if (window.desktop?.overlayState) {
    const showOverlay = (info) => {
      $('overlayButton').textContent = info.active ? '오버레이 끄기' : '오버레이 켜기';
      $('overlayButton').setAttribute('aria-pressed', String(info.active));
      $('overlayStatus').textContent = info.active ? '표시 중 · 클릭 통과' : '꺼짐';
      $('overlayStatus').classList.toggle('active', info.active);
    };
    window.desktop.overlayState().then(showOverlay);
    const unsubscribe = window.desktop.onOverlayState(showOverlay);
    window.addEventListener('beforeunload', () => unsubscribe(), { once: true });
  }
  if (!window.desktop) {
    $('overlayButton').disabled = true;
    $('overlayButton').textContent = '데스크톱 앱에서 켜기';
    $('overlayStatus').textContent = '설치 앱에서 사용';
  }
  for (const id of [
    'secondsVisible',
    'glow',
    'hitStrength',
    'keyboardHeight',
    'customColor',
    'overlayNoteOpacity',
    'overlayKeyboardOpacity',
  ])
    $(id).addEventListener('blur', updateUI);
  window.addEventListener('storage', (event) => {
    if (event.key === SCENE_STORAGE_KEY) scenes();
  });
  $('cancelExport').onclick = () => {
    if (exportAbort) exportAbort();
    else $('exportDialog').close();
  };
  $('exportDialog').addEventListener('cancel', (e) => {
    if (exporting) {
      e.preventDefault();
      exportAbort?.();
    }
  });
  document.addEventListener('click', (event) => {
    for (const menu of document.querySelectorAll(
      'details.scene-tools[open], details.session-more[open]',
    ))
      if (!menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    for (const menu of document.querySelectorAll(
      'details.scene-tools[open], details.session-more[open]',
    )) {
      menu.open = false;
      if (menu.contains(document.activeElement)) menu.querySelector('summary').focus();
      e.preventDefault();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (
      e.code === 'Space' &&
      !e.repeat &&
      !e.defaultPrevented &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.target.isContentEditable &&
      !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(e.target.tagName) &&
      !document.querySelector('dialog[open]')
    ) {
      e.preventDefault();
      $('playButton').click();
    }
  });
  loadAudio();
  loadLibrary();
}
connectSocket();
setInterval(() => {
  if (socket?.readyState === 1)
    socket.send(JSON.stringify({ type: 'ping', echo: performance.now() / 1000 }));
  live.prune(serverNow() - 20, { events: true });
}, 5000);
setInterval(() => {
  if (!state) return;
  syncAudio();
  if (viewer) return;
  const tr = state.transport,
    t = position();
  $('currentTime').textContent = timeText(
    state.recording ? serverNow() - state.recording.startedAt : tr.mode === 'live' ? 0 : t,
  );
  if (tr.mode !== 'live') $('seek').value = t;
  $('stageNotes').textContent =
    (tr.mode === 'live' ? live.notes.length : replay.notes.filter((n) => n.start <= t).length) +
    ' NOTES';
  if (performance.now() - lastMidiAt > 120) $('midiLight').classList.remove('pulse');
  if (state.recording)
    $('recordLabel').textContent = '종료 · ' + timeText(serverNow() - state.recording.startedAt);
}, 100);
window.addEventListener('beforeunload', () => {
  renderer.destroy();
  stopAudio();
  socket?.close();
});
// Read-only diagnostics support repeatable rendering and connection checks.
window.ecloneDiagnostics = () => ({
  mode: state?.transport.mode,
  connected: state?.midiStatus.connected,
  midiCount: count,
  notes: live.notes.length,
  position: position(),
  session: currentSession?.id,
  studioAudioOwnerId: state?.studioAudioOwnerId,
  ownsStudioAudio: !viewer && canPlayAudio(),
  recording: !!state?.recording,
  settings: state?.settings,
});
window.lumaDiagnostics = window.ecloneDiagnostics;
