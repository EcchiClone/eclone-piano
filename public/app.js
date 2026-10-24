import { Performance, PianoRenderer } from './engine.js';

const $ = (id) => document.getElementById(id),
  params = new URLSearchParams(location.search),
  viewer = location.pathname === '/stage';
if (viewer) document.body.classList.add('viewer');
const live = new Performance(),
  cache = new Map();
let socket,
  state = null,
  offset = 0,
  currentSession = null,
  replay = new Performance(),
  toastTimer,
  count = 0,
  lastMidiAt = 0,
  audio = null,
  audioSession = null,
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
function position() {
  if (!state || state.transport.mode === 'live') return serverNow();
  const tr = state.transport;
  return Math.min(
    currentSession?.duration || Infinity,
    tr.position + (tr.playing ? serverNow() - tr.startedAt : 0),
  );
}
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
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audio = null;
  }
  audioSession = null;
}
async function syncSession() {
  const request = ++sessionLoad,
    id = state?.transport.sessionId;
  if (!id) {
    currentSession = null;
    replay.reset();
    stopAudio();
    return;
  }
  try {
    const session = await getSession(id);
    if (request !== sessionLoad) return;
    currentSession = session;
    replay = Performance.fromJSON(session);
    if (session.hasAudio && (!viewer || params.get('audio') === '1')) {
      if (audioSession !== id) {
        stopAudio();
        audio = new Audio('/media/' + id + '.wav');
        audio.preload = 'auto';
        audioSession = id;
        audio.addEventListener('error', () =>
          toast('원음 파일을 재생할 수 없습니다. 저장 폴더에서 WAV 파일을 확인하세요.', 'error'),
        );
      }
      syncAudio(true);
    } else stopAudio();
    updateUI();
  } catch (error) {
    toast(error.message, 'error');
  }
}
function syncAudio(force = false) {
  if (!audio || !state || exporting) return;
  const target = position();
  if (force || Math.abs(audio.currentTime - target) > 0.18) {
    try {
      audio.currentTime = target;
    } catch {}
  }
  const shouldPlay = state.transport.playing && target < (currentSession?.duration || 0);
  if (shouldPlay && audio.paused)
    audio.play().catch(() => {
      if (!viewer) toast('원음 재생을 시작하려면 재생 버튼을 한 번 눌러 주세요.');
    });
  if (!shouldPlay && !audio.paused) audio.pause();
}
function connectSocket() {
  socket = new WebSocket(`ws://${location.host}/?${viewer ? 'viewer=1' : ''}`);
  socket.onopen = () => {
    if (!viewer) {
      $('serverState').classList.add('online');
      $('serverState').innerHTML = '<i></i> LOCAL CONNECTED';
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
      const oldId = state?.transport.sessionId;
      state = msg;
      offset = msg.serverTime - performance.now() / 1000;
      count = msg.midiCount;
      if (msg.type === 'hello') {
        live.reset();
        for (const e of msg.history || []) live.ingest(e);
      }
      if (oldId !== msg.transport.sessionId || msg.type === 'hello') syncSession();
      else syncAudio(true);
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
    } else if (msg.type === 'panic') {
      live.finish(msg.t);
    } else if (msg.type === 'pong') {
      const received = performance.now() / 1000;
      offset = msg.serverTime - (received + msg.echo) / 2;
    } else if (msg.type === 'notice') toast(msg.message, msg.kind);
    else if (msg.type === 'audioLevel') {
      if (!viewer) {
        $('audioMeter').style.width = Math.min(100, Math.sqrt(msg.peak) * 100) + '%';
        if (state?.recording)
          $('recordHint').textContent =
            msg.peak > 0.0001
              ? 'Kontakt 전용 오디오 수신 중'
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
    busy = !!(state.recording || state.starting || state.stopping);
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
        ? '원음 WAV와 함께 재생'
        : 'MIDI 시각화 · 원음 없음';
  $('seek').disabled = liveMode;
  $('seek').max = currentSession?.duration || 1;
  $('duration').textContent = liveMode ? 'LIVE' : timeText(currentSession?.duration);
  $('playButton').textContent = tr.playing ? 'Ⅱ' : '▶';
  $('playButton').title = liveMode ? '데모 재생' : '재생 / 일시정지';
  $('stageDirection').textContent =
    (liveMode || s.direction === 'up' ? 'RISING' : 'FALLING') +
    (liveMode ? ' · REAL TIME' : ' · PLAYBACK');
  document
    .querySelectorAll('[data-theme]')
    .forEach((b) => b.classList.toggle('active', b.dataset.theme === s.theme));
  $('themeName').textContent = { aurora: 'Aurora', amber: 'Golden', violet: 'Violet' }[s.theme];
  document.querySelectorAll('[data-direction]').forEach((b) => {
    b.classList.toggle('active', b.dataset.direction === (liveMode ? 'up' : s.direction));
    b.classList.toggle('unavailable', liveMode && b.dataset.direction === 'down');
  });
  $('flowDescription').textContent = liveMode ? '실시간' : '재생';
  $('flowHelp').textContent = liveMode
    ? '실시간 연주는 건반에서 위로 뻗어 나갑니다.'
    : '내려오는 노트를 미리 보며 저장된 연주를 감상하세요.';
  $('secondsVisible').value = s.secondsVisible;
  $('secondsValue').textContent = Number(s.secondsVisible).toFixed(1) + '초';
  $('glow').value = s.glow;
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
  $('noteRange').value = String(s.maxNote - s.minNote + 1);
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
    const preferred = state.ports.inputs.find((p) => /luma|loopmidi/i.test(p.name));
    if (preferred) $('midiInput').value = preferred.id;
    else if (state.ports.inputs.some((p) => String(p.id) === previous))
      $('midiInput').value = previous;
  }
  if (state.midiStatus.connected && state.midiStatus.inputId != null)
    $('midiInput').value = state.midiStatus.inputId;
  $('connectButton').textContent = state.midiStatus.connected ? '연결 해제' : '연결';
  $('midiInput').disabled = state.midiStatus.connected;
  $('midiStatus').textContent = state.midiStatus.connected
    ? '입력 연결됨'
    : state.midiStatus.error
      ? '연결 확인 필요'
      : '연결되지 않음';
  $('midiStatus').title = state.midiStatus.error || '';
  $('midiLight').classList.toggle('connected', state.midiStatus.connected);
  $('eventCount').textContent = count.toLocaleString() + ' events';
  $('recordButton').classList.toggle('recording', !!state.recording);
  $('recordLabel').textContent = state.starting
    ? '오디오 연결 중…'
    : state.stopping
      ? '저장 중…'
      : state.recording
        ? '녹음 종료'
        : '녹음 시작';
  $('recordButton').disabled = !!(state.starting || state.stopping);
  for (const id of ['takeName', 'audioProcess', 'withAudio']) $(id).disabled = busy;
  $('audioProcess').disabled = busy || !$('withAudio').checked;
  $('demoButton').disabled = busy;
  $('playButton').disabled = busy;
  if (!busy) {
    $('audioMeter').style.width = '0';
    $('recordHint').textContent =
      '연주 데이터와 원음을 따로 보관해 언제든 다시 스타일링할 수 있어요.';
  }
}
async function loadAudio() {
  if (viewer) return;
  try {
    const r = await fetch('/api/audio');
    const data = await r.json();
    $('audioProcess').innerHTML = (data.processes || []).length
      ? data.processes
          .map((p) => `<option value="${p.pid}">${escape(p.name)} · ${p.pid}</option>`)
          .join('')
      : '<option value="">Kontakt를 실행하세요</option>';
    if (data.error) toast(data.error, 'error');
  } catch {
    toast('오디오 장치 정보를 읽지 못했습니다.', 'error');
  }
}
async function loadLibrary() {
  if (viewer) return;
  try {
    const response = await fetch('/api/sessions'),
      items = await response.json();
    $('sessionCount').textContent = items.length;
    $('libraryCount').textContent = items.length;
    $('sessionList').innerHTML = items.length
      ? items
          .map(
            (s) =>
              `<article class="session-card"><div class="session-icon">♩</div><div class="session-info"><strong>${escape(s.name)}</strong><small>${new Date(s.createdAt).toLocaleDateString('ko-KR')} · ${timeText(s.duration)} · ${s.hasAudio ? 'MIDI + WAV' : 'MIDI'} · ${s.eventCount} events</small></div><div class="session-actions"><a href="/api/midi/${s.id}" download="performance.mid">MIDI</a>${s.hasAudio ? `<a href="/media/${s.id}.wav" download>WAV</a>` : ''}<a href="/media/${s.id}.session.json" download>세션</a><button class="button outline" data-play="${s.id}">▷ 재생</button><button class="button export-button" data-export="${s.id}">영상 내보내기</button></div></article>`,
          )
          .join('')
      : '<div class="library-empty">아직 담아 둔 연주가 없어요. 첫 연주를 녹음해 보세요.</div>';
  } catch (error) {
    toast('저장된 연주 목록을 읽지 못했습니다.', 'error');
  }
}
const setSettings = (patch) => send({ type: 'settings', settings: patch });
async function exportVideo(id) {
  if (exporting) return;
  if (state?.recording || state?.starting || state?.stopping) {
    toast('녹음을 마친 뒤 영상을 내보내세요.');
    return;
  }
  exporting = true;
  let cancelled = false,
    failure = null,
    recorder = null,
    exportAudio = null,
    audioContext = null,
    raf = 0,
    stream = null,
    exportRenderer = null,
    canvas = null,
    uploadId = null;
  let uploadChain = Promise.resolve(),
    queuedBytes = 0,
    sequence = 0,
    acceptChunks = true;
  const abort = new AbortController();
  const fail = (error) => {
    failure ??= error;
    abort.abort();
    if (recorder?.state === 'recording') recorder.stop();
  };
  const check = () => {
    if (failure) throw failure;
    if (cancelled) throw new Error('EXPORT_CANCELLED');
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
    '현재 디자인으로 1920 × 1080 영상을 생성합니다. 연주 길이만큼 시간이 걸리며, 영상은 디스크에 나누어 저장합니다.';
  $('exportProgress').value = 0;
  $('exportStatus').textContent = '준비 중…';
  $('exportDownload').hidden = true;
  $('cancelExport').hidden = false;
  $('cancelExport').textContent = '취소';
  exportAbort = () => {
    cancelled = true;
    abort.abort();
    if (recorder?.state === 'recording') recorder.stop();
  };
  try {
    const take = await getSession(id);
    check();
    const model = Performance.fromJSON(take),
      options = {
        ...state.settings,
        background: 'dark',
        notes: model.notes,
        quality: 1,
        pixelRatio: 1,
        time: 0,
      };
    if (audio) audio.pause();
    send({ type: 'pause' });
    canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    canvas.style.cssText = 'position:fixed;left:-20000px;width:1920px;height:1080px';
    document.body.appendChild(canvas);
    exportRenderer = new PianoRenderer(canvas, () => options);
    exportRenderer.renderAt(0);
    stream = canvas.captureStream(60);
    if (take.hasAudio) {
      audioContext = new AudioContext();
      await audioContext.resume();
      check();
      exportAudio = new Audio('/media/' + id + '.wav');
      exportAudio.preload = 'auto';
      await new Promise((resolve, reject) => {
        const done = (error) => {
          clearTimeout(timer);
          abort.signal.removeEventListener('abort', onAbort);
          exportAudio.removeEventListener('canplay', ready);
          exportAudio.removeEventListener('error', broken);
          error ? reject(error) : resolve();
        };
        const ready = () => done(),
          broken = () => done(new Error('원음 WAV를 읽지 못했습니다.')),
          onAbort = () => done(failure || new Error('EXPORT_CANCELLED'));
        const timer = setTimeout(() => done(new Error('원음 WAV 로딩 시간 초과')), 15000);
        exportAudio.addEventListener('canplay', ready, { once: true });
        exportAudio.addEventListener('error', broken, { once: true });
        abort.signal.addEventListener('abort', onAbort, { once: true });
        exportAudio.load();
      });
      const source = audioContext.createMediaElementSource(exportAudio),
        destination = audioContext.createMediaStreamDestination();
      source.connect(destination);
      for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    }
    check();
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(
      (m) => MediaRecorder.isTypeSupported(m),
    );
    if (!mime)
      throw new Error('이 브라우저에서 영상 녹화를 지원하지 않습니다. 데스크톱 앱을 사용하세요.');
    ({ uploadId } = await request('/api/export/start', JSON.stringify({ sessionId: id }), {
      'Content-Type': 'application/json',
    }));
    recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 14_000_000,
      audioBitsPerSecond: 192_000,
    });
    recorder.ondataavailable = (e) => {
      if (!e.data.size || cancelled || failure || !acceptChunks) return;
      queuedBytes += e.data.size;
      if (queuedBytes > 64 * 1024 * 1024) {
        fail(
          new Error(
            '디스크 저장이 영상 생성 속도를 따라가지 못했습니다. 여유 공간을 확인하고 다시 시도하세요.',
          ),
        );
        return;
      }
      const chunk = e.data,
        index = sequence++;
      uploadChain = uploadChain
        .then(async () => {
          if (cancelled || failure) return;
          await request('/api/export/chunk/' + uploadId, chunk, {
            'X-Export-Sequence': String(index),
          });
        })
        .catch((error) => {
          if (!cancelled) fail(error);
        })
        .finally(() => {
          queuedBytes -= chunk.size;
        });
    };
    const finished = new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.onerror = (e) => {
        fail(e.error || new Error('영상 인코딩 오류'));
        resolve();
      };
    });
    exportRenderer.renderAt(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    check();
    recorder.start(1000);
    if (exportAudio) await exportAudio.play();
    check();
    const started = performance.now();
    await new Promise((resolve, reject) => {
      const onAbort = () => reject(failure || new Error('EXPORT_CANCELLED'));
      abort.signal.addEventListener('abort', onAbort, { once: true });
      const frame = () => {
        const t =
          exportAudio && !exportAudio.ended
            ? exportAudio.currentTime
            : (performance.now() - started) / 1000;
        options.time = t;
        exportRenderer.renderAt(t);
        $('exportProgress').value = Math.min(1, t / take.duration);
        $('exportStatus').textContent =
          `${timeText(t)} / ${timeText(take.duration)} · 1080p · 디스크에 저장 중`;
        if (t >= take.duration) {
          abort.signal.removeEventListener('abort', onAbort);
          resolve();
          return;
        }
        raf = requestAnimationFrame(frame);
      };
      frame();
    });
    if (recorder.state === 'recording') recorder.stop();
    await finished;
    await uploadChain;
    check();
    $('exportStatus').textContent = 'MP4로 변환하고 저장하는 중…';
    const result = await request('/api/export/finish/' + uploadId);
    uploadId = null;
    $('exportTitle').textContent = '영상이 준비됐어요.';
    $('exportDescription').textContent =
      result.format === 'mp4'
        ? '원음과 시각화를 담은 MP4 영상을 저장했습니다.'
        : 'FFmpeg 변환을 사용할 수 없어 WebM 원본으로 저장했습니다.';
    $('exportStatus').textContent = '1920 × 1080 · ' + result.format.toUpperCase();
    $('exportProgress').value = 1;
    $('exportDownload').href = result.url;
    $('exportDownload').download =
      `${take.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)}-${options.theme}.${result.format}`;
    $('exportDownload').hidden = false;
    $('cancelExport').textContent = '닫기';
    $('cancelExport').hidden = false;
  } catch (error) {
    if (!cancelled) toast(failure?.message || error.message, 'error');
    $('exportDialog').close();
  } finally {
    acceptChunks = false;
    cancelAnimationFrame(raf);
    if (recorder?.state === 'recording') recorder.stop();
    exportAudio?.pause();
    stream?.getTracks().forEach((t) => t.stop());
    abort.abort();
    await uploadChain;
    if (uploadId) await fetch('/api/export/cancel/' + uploadId, { method: 'POST' }).catch(() => {});
    if (exportAudio) {
      exportAudio.removeAttribute('src');
      exportAudio.load();
    }
    await audioContext?.close().catch(() => {});
    exportRenderer?.destroy();
    canvas?.remove();
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
    if (audio) audio.play().catch(() => {});
    if (state?.transport.playing) send({ type: 'pause' });
    else
      send({
        type: 'play',
        sessionId: state?.transport.sessionId || 'demo',
        position:
          position() >= (currentSession?.duration || Infinity) ? 0 : state?.transport.position || 0,
      });
  };
  $('returnLive').onclick = $('liveTab').onclick = () => send({ type: 'live' });
  $('libraryTab').onclick = () => $('library').scrollIntoView({ behavior: 'smooth' });
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
    .forEach((b) => (b.onclick = () => setSettings({ theme: b.dataset.theme })));
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
  for (const key of ['particles', 'keyboard', 'labels', 'overlayKeyboard'])
    $(key).onchange = () => setSettings({ [key]: $(key).checked });
  for (const key of ['secondsVisible', 'glow', 'overlayNoteOpacity', 'overlayKeyboardOpacity'])
    $(key).oninput = () => setSettings({ [key]: Number($(key).value) });
  $('transparent').onchange = () =>
    setSettings({ background: $('transparent').checked ? 'transparent' : 'dark' });
  $('noteRange').onchange = () =>
    setSettings(
      {
        37: { minNote: 48, maxNote: 84 },
        49: { minNote: 36, maxNote: 84 },
        61: { minNote: 36, maxNote: 96 },
        88: { minNote: 21, maxNote: 108 },
      }[$('noteRange').value],
    );
  $('fullscreenButton').onclick = () => {
    const frame = document.querySelector('.preview-frame');
    if (document.fullscreenElement) document.exitFullscreen();
    else frame.requestFullscreen().catch(() => window.open('/stage', '_blank'));
  };
  $('refreshAudio').onclick = loadAudio;
  $('withAudio').onchange = () => updateUI();
  $('recordButton').onclick = () => {
    if (state?.recording) {
      send({ type: 'stopRecord' });
      return;
    }
    const pid = Number($('audioProcess').value);
    if ($('withAudio').checked && !pid) {
      toast('Kontakt를 실행한 뒤 오디오 소스 새로고침을 눌러 주세요.', 'error');
      return;
    }
    send({ type: 'record', name: $('takeName').value, withAudio: $('withAudio').checked, pid });
  };
  $('sessionList').onclick = (e) => {
    const play = e.target.closest('[data-play]'),
      exp = e.target.closest('[data-export]');
    if (play) send({ type: 'play', sessionId: play.dataset.play, position: 0 });
    if (exp) exportVideo(exp.dataset.export);
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
  document.addEventListener('keydown', (e) => {
    if (
      e.code === 'Space' &&
      !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName) &&
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
window.lumaDiagnostics = () => ({
  mode: state?.transport.mode,
  connected: state?.midiStatus.connected,
  midiCount: count,
  notes: live.notes.length,
  position: position(),
  session: currentSession?.id,
  recording: !!state?.recording,
  settings: state?.settings,
});
