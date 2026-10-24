/**
 * Luma piano performance and Canvas renderer. All time values are seconds.
 * Performance.notes use MIDI velocity (1–127), zero-based channels and Infinity
 * for a sounding note. `release` is physical key-up, `end` includes sustain.
 */
const BLACK = new Set([1, 3, 6, 8, 10]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const key = (channel, note) => `${channel}:${note}`;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export class Performance {
  constructor() { this.reset(); }

  reset() {
    this.notes = [];
    this.events = [];
    this.pedals = new Array(16).fill(false);
    this.held = new Map();
    this.lastTime = 0;
    this.nextId = 1;
    return this;
  }

  get duration() { return this.lastTime; }

  ingest(event) {
    if (!event || !Array.isArray(event.data) || event.data.length < 1) return null;
    const data = event.data.slice(0, 3).map(Number);
    if (!Number.isInteger(data[0]) || data[0] < 128 || data[0] > 239) return null;
    const command = data[0] & 0xf0;
    const required = command === 0xc0 || command === 0xd0 ? 2 : 3;
    if (data.length < required || data.slice(1).some(n => !Number.isInteger(n) || n < 0 || n > 127)) return null;
    const t = Math.max(this.lastTime, finite(event.t));
    this.lastTime = t;
    this.events.push({ t, data });
    const channel = data[0] & 0x0f;
    const pitch = data[1];
    const velocity = data[2];
    if (command === 0x90 && velocity > 0) {
      const note = { id: this.nextId++, note: pitch, channel, velocity, start: t, release: Infinity, end: Infinity };
      const id = key(channel, pitch);
      const pressed = this.held.get(id) || [];
      pressed.push(note);
      this.held.set(id, pressed);
      this.notes.push(note);
      return note;
    }
    if (command === 0x80 || (command === 0x90 && velocity === 0)) {
      const id = key(channel, pitch);
      const pressed = this.held.get(id);
      const note = pressed?.shift();
      if (pressed?.length === 0) this.held.delete(id);
      if (note) {
        note.release = t;
        if (!this.pedals[channel]) note.end = t;
      }
      return note || null;
    }
    if (command === 0xb0) {
      if (pitch === 64) {
        const down = velocity >= 64;
        if (this.pedals[channel] && !down) {
          for (const note of this.notes) {
            if (note.channel === channel && Number.isFinite(note.release) && !Number.isFinite(note.end)) note.end = t;
          }
        }
        this.pedals[channel] = down;
      } else if (pitch === 120) {
        this.silence(t, channel);
      } else if (pitch === 123) {
        // MIDI All Notes Off releases physical keys, respecting CC64 sustain.
        for (const [id, pressed] of this.held) {
          if (pressed[0]?.channel !== channel) continue;
          for (const note of pressed) {
            note.release = t;
            if (!this.pedals[channel]) note.end = t;
          }
          this.held.delete(id);
        }
      } else if (pitch === 121) {
        this.pedals[channel] = false;
        for (const note of this.notes) {
          if (note.channel === channel && Number.isFinite(note.release) && !Number.isFinite(note.end)) note.end = t;
        }
      }
    }
    return null;
  }

  silence(t = this.lastTime, channel = null) {
    t = Math.max(this.lastTime, finite(t));
    this.lastTime = t;
    for (const note of this.notes) {
      if ((channel === null || channel === note.channel) && !Number.isFinite(note.end)) {
        note.release = Math.min(note.release, t);
        note.end = t;
      }
    }
    for (const [id, pressed] of this.held) {
      if (channel === null || pressed[0]?.channel === channel) this.held.delete(id);
    }
    if (channel === null) this.pedals.fill(false);
    else this.pedals[channel] = false;
    return this;
  }

  finish(t = this.lastTime) { return this.silence(t); }

  activeAt(t, physical = false) {
    return this.notes.filter(note => note.start <= t && t < (physical ? note.release : note.end));
  }

  /** Discard old visual history without discarding a recording's raw events. */
  prune(before, { events = false } = {}) {
    this.notes = this.notes.filter(note => note.end >= before);
    if (events) this.events = this.events.filter(event => event.t >= before);
    return this;
  }

  toJSON() {
    return { version: 1, duration: this.duration, events: this.events.map(e => ({ t: e.t, data: [...e.data] })) };
  }

  static fromJSON(value) {
    if (!value || !Array.isArray(value.events)) throw new Error('Invalid performance: events array is required.');
    if (value.events.length > 2000000) throw new Error('Performance exceeds the event limit.');
    const performance = new Performance();
    const events = value.events.filter(e => e && Number.isFinite(e.t) && e.t >= 0).sort((a, b) => a.t - b.t);
    for (const event of events) performance.ingest(event);
    performance.finish(Math.max(performance.duration, finite(value.duration)));
    return performance;
  }
}

export const THEMES = {
  aurora: { main: [102, 232, 214], high: [192, 255, 241], low: [44, 135, 161], secondary: [145, 173, 255] },
  amber: { main: [255, 202, 112], high: [255, 246, 199], low: [178, 105, 48], secondary: [255, 149, 111] },
  violet: { main: [190, 155, 255], high: [238, 220, 255], low: [100, 75, 175], secondary: [241, 159, 210] },
};
const color = (rgb, alpha = 1) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${clamp(alpha, 0, 1)})`;
const whiteBefore = note => { let n = 0; for (let i = 0; i < note; i++) if (!BLACK.has(i % 12)) n++; return n; };
const noteName = note => `${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][note % 12]}${Math.floor(note / 12) - 1}`;

export function pianoLayout(width, minNote = 21, maxNote = 108) {
  minNote = clamp(Math.round(minNote), 0, 126);
  maxNote = clamp(Math.round(maxNote), minNote + 1, 127);
  const first = whiteBefore(minNote) - (BLACK.has(minNote % 12) ? 0.5 : 0);
  const last = whiteBefore(maxNote) + (BLACK.has(maxNote % 12) ? 0.5 : 1);
  const whiteWidth = width / (last - first);
  const keys = [];
  for (let note = minNote; note <= maxNote; note++) {
    const black = BLACK.has(note % 12);
    const unit = whiteBefore(note) - first;
    const w = whiteWidth * (black ? 0.61 : 1);
    const x = (unit - (black ? 0.305 : 0)) * whiteWidth;
    keys.push({ note, black, x, width: w, center: x + w / 2 });
  }
  return { keys, whiteWidth, byNote: new Map(keys.map(k => [k.note, k])) };
}

function rounded(ctx, x, y, width, height, radius = 3) {
  if (width <= 0 || height <= 0) return;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
  else ctx.rect(x, y, width, height);
}

/**
 * State: time, notes, direction:'up'|'down', theme, background:'dark'|'transparent',
 * particles, glow (0..1), keyboard, labels, minNote, maxNote, secondsVisible.
 * Optional: keyboardHeight (fraction 0.04..0.4), quality (0.5..2), grid, opacity.
 * `renderAt(time, overrides)` also supports deterministic image/video export.
 */
export class PianoRenderer {
  constructor(canvas, getState = () => ({})) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: true });
    if (!this.context) throw new Error('Canvas 2D is unavailable.');
    this.getState = getState;
    this.running = false;
    this.frame = null;
    this.width = canvas.width || 1280;
    this.height = canvas.height || 720;
    this.ratio = 1;
    this.layoutCache = null;
    this.resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    this.resizeObserver?.observe(canvas);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect?.();
    const w = Math.max(1, Math.round(rect?.width || this.canvas.width || 1280));
    const h = Math.max(1, Math.round(rect?.height || this.canvas.height || 720));
    const quality = clamp(finite(this.getState()?.quality, 1), 0.5, 2);
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2) * quality;
    if (this.width === w && this.height === h && this.ratio === ratio && this.canvas.width === Math.round(w * ratio)) return;
    this.width = w;
    this.height = h;
    this.ratio = ratio;
    this.canvas.width = Math.round(w * ratio);
    this.canvas.height = Math.round(h * ratio);
    this.layoutCache = null;
    if (!this.running) this.renderAt();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.renderAt();
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    this.running = false;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  destroy() { this.stop(); this.resizeObserver?.disconnect(); }

  renderAt(time, overrides = {}) {
    const s = { direction: 'up', theme: 'aurora', background: 'dark', particles: true, glow: 0.7, keyboard: true, labels: true, minNote: 21, maxNote: 108, secondsVisible: 6, ...this.getState(), ...overrides };
    const t = finite(time, finite(s.time));
    const ctx = this.context;
    const w = this.width;
    const h = this.height;
    const theme = THEMES[s.theme] || THEMES.aurora;
    const glow = clamp(finite(s.glow, 0.7), 0, 1);
    const keyboardHeight = s.keyboard ? Math.max(30, h * clamp(finite(s.keyboardHeight, 0.19), 0.04, 0.4)) : 0;
    const strike = h - keyboardHeight;
    const seconds = clamp(finite(s.secondsVisible, 6), 1, 30);
    const speed = strike / seconds;
    const down = s.direction === 'down';
    const cacheKey = `${w}:${s.minNote}:${s.maxNote}`;
    if (this.layoutCache?.key !== cacheKey) this.layoutCache = { key: cacheKey, ...pianoLayout(w, s.minNote, s.maxNote) };
    const layout = this.layoutCache;
    const notes = Array.isArray(s.notes) ? s.notes : [];
    const active = new Map();
    const visible = [];
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = clamp(finite(s.opacity, 1), 0, 1);
    ctx.globalCompositeOperation = 'source-over';
    if (s.background !== 'transparent') this.drawBackground(ctx, w, h, strike, theme, s.grid !== false);

    for (const note of notes) {
      const k = layout.byNote.get(note.note);
      if (!k || !Number.isFinite(note.start)) continue;
      const end = note.end == null || note.end === null ? Infinity : note.end;
      if (note.start <= t && t < end) {
        const current = active.get(note.note);
        if (!current || current.velocity < note.velocity) active.set(note.note, note);
      }
      if (down ? end < t || note.start > t + seconds + 0.2 : note.start > t || end < t - seconds - 0.2) continue;
      visible.push({ note, k, end });
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, w, strike); ctx.clip();
    for (const item of visible) this.drawNote(ctx, item, t, strike, speed, down, theme, glow, s.labels && layout.whiteWidth > 30);
    if (s.particles && glow > 0) this.drawParticles(ctx, active, layout, t, strike, theme, glow);
    ctx.restore();
    if (s.keyboard) this.drawKeyboard(ctx, layout, active, strike, keyboardHeight, theme, glow, s.labels, t);
    this.drawStrike(ctx, w, strike, active, layout, theme, glow);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
  }

  drawBackground(ctx, w, h, strike, theme, grid) {
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, '#080c14'); gradient.addColorStop(0.7, '#0b111b'); gradient.addColorStop(1, '#101922');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
    const aura = ctx.createRadialGradient(w * 0.5, strike, 0, w * 0.5, strike, w * 0.65);
    aura.addColorStop(0, color(theme.low, 0.08)); aura.addColorStop(1, color(theme.low, 0));
    ctx.fillStyle = aura; ctx.fillRect(0, 0, w, h);
    if (!grid) return;
    ctx.strokeStyle = 'rgba(184,205,228,0.032)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const key of this.layoutCache.keys) {
      if (key.note % 12 === 0) { ctx.moveTo(Math.round(key.x) + 0.5, 0); ctx.lineTo(Math.round(key.x) + 0.5, strike); }
    }
    ctx.stroke();
  }

  drawNote(ctx, { note, k, end }, t, strike, speed, down, theme, glow, labels) {
    const sounding = note.start <= t && t < end;
    const velocity = clamp(finite(note.velocity, 90) / 127, 0.03, 1);
    const width = k.width * (k.black ? 0.85 : 0.83);
    const x = k.center - width / 2;
    const actualEnd = Number.isFinite(end) ? end : Math.max(t, note.start) + (down ? 0.14 : 0);
    const y1 = down ? strike - (actualEnd - t) * speed : strike - (t - note.start) * speed;
    const y2 = down ? strike - (note.start - t) * speed : strike - (t - actualEnd) * speed;
    const top = Math.max(-12, y1);
    const bottom = Math.min(strike + 1, Math.max(y1 + 3, y2));
    const height = bottom - top;
    if (height <= 0) return;
    const base = k.black ? theme.secondary : theme.main;
    const fade = down ? 1 : clamp(1 - Math.max(0, strike - bottom) / Math.max(strike, 1) * 0.85, 0.12, 1);
    ctx.save();
    ctx.globalAlpha *= fade * (0.52 + velocity * 0.48);
    if (glow > 0) { ctx.shadowBlur = (sounding ? 18 : 9) * glow; ctx.shadowColor = color(base, sounding ? 0.75 : 0.4); }
    const body = ctx.createLinearGradient(x, 0, x + width, 0);
    body.addColorStop(0, color(base, 0.7)); body.addColorStop(0.3, color(theme.high, 0.95)); body.addColorStop(0.75, color(base, 0.95)); body.addColorStop(1, color(base, 0.65));
    ctx.fillStyle = body;
    rounded(ctx, x, top, width, height, Math.min(width * 0.2, 5)); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = color(theme.high, 0.42); ctx.lineWidth = 0.65; ctx.stroke();
    if (width > 8 && height > 9) {
      ctx.fillStyle = color(theme.high, 0.35);
      rounded(ctx, x + 2, top + 2, Math.max(1, width * 0.12), height - 4, 1); ctx.fill();
    }
    // A thin seam keeps pedal extension distinguishable from a physically held key.
    if (Number.isFinite(note.release) && note.release > note.start && note.release < end) {
      const releaseY = down ? strike - (note.release - t) * speed : strike - (t - note.release) * speed;
      if (releaseY > top + 2 && releaseY < bottom - 2) {
        ctx.fillStyle = 'rgba(9,16,24,0.35)'; ctx.fillRect(x + 1, releaseY, width - 2, 1);
      }
    }
    if (labels && height > 28 && width > 22) {
      ctx.fillStyle = 'rgba(9,26,35,0.65)'; ctx.font = `600 ${Math.min(12, width * 0.35)}px "Segoe UI",sans-serif`;
      ctx.textAlign = 'center'; ctx.fillText(noteName(note.note), k.center, Math.min(bottom - 7, top + 17));
    }
    ctx.restore();
  }

  drawParticles(ctx, active, layout, t, strike, theme, glow) {
    // Deterministic particles are seekable and have fixed work/memory bounds.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    let emitted = 0;
    for (const [pitch, note] of active) {
      const k = layout.byNote.get(pitch);
      const velocity = clamp(note.velocity / 127, 0.1, 1);
      const count = Math.floor(7 + velocity * 9);
      for (let i = 0; i < count && emitted < 480; i++, emitted++) {
        const age = ((t * (0.72 + velocity * 0.18) + i * 0.618033 + pitch * 0.013) % 1 + 1) % 1;
        if (age > Math.max(0, t - note.start) * 1.5 + 0.05) continue;
        const seed = Math.sin(pitch * 32.12 + i * 71.7) * 43758.5453;
        const random = seed - Math.floor(seed);
        const spread = (random - 0.5) * (22 + age * 48);
        const x = k.center + spread * age;
        const y = strike - age * (36 + velocity * 92) - Math.sin(age * Math.PI) * 8;
        const alpha = (1 - age) ** 2 * glow * (0.5 + velocity * 0.5);
        const radius = 0.55 + random * 1.35;
        ctx.fillStyle = color(i % 3 ? theme.main : theme.high, alpha);
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  drawKeyboard(ctx, layout, active, y, height, theme, glow, labels, time) {
    const keys = layout.keys;
    ctx.save();
    ctx.fillStyle = '#05090e'; ctx.fillRect(0, y, this.width, height);
    for (const black of [false, true]) {
      for (const k of keys) {
        if (k.black !== black) continue;
        const note = active.get(k.note);
        const held = note && (note.release == null || time < note.release);
        const amount = note ? clamp(note.velocity / 127, 0.2, 1) * (held ? 1 : 0.65) : 0;
        const gap = black ? 0.8 : Math.max(0.7, layout.whiteWidth * 0.035);
        const x = k.x + gap / 2;
        const kw = Math.max(1, k.width - gap);
        const kh = black ? height * 0.63 : height - 3;
        const surface = ctx.createLinearGradient(0, y, 0, y + kh);
        if (black) {
          surface.addColorStop(0, note ? color(theme.low, 1) : '#17222d');
          surface.addColorStop(0.84, note ? color(theme.main, 0.8) : '#0a111a');
          surface.addColorStop(1, note ? color(theme.low, 1) : '#1c2834');
          ctx.shadowColor = 'rgba(0,0,0,0.65)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 3;
        } else {
          surface.addColorStop(0, note ? color(theme.main, 0.75 + amount * 0.25) : '#acb9c5');
          surface.addColorStop(0.14, note ? color(theme.high, 0.9) : '#e6ecf0');
          surface.addColorStop(0.88, note ? color(theme.main, 0.9) : '#ccd6df');
          surface.addColorStop(1, note ? color(theme.low, 1) : '#8799a9');
          ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        }
        ctx.fillStyle = surface; rounded(ctx, x, y + 1, kw, kh, black ? 3 : 2); ctx.fill();
        ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        ctx.strokeStyle = black ? 'rgba(188,218,239,0.13)' : 'rgba(248,253,255,0.42)'; ctx.lineWidth = 0.7; ctx.stroke();
        if (note && glow > 0) {
          const sheen = ctx.createLinearGradient(0, y, 0, y + kh);
          sheen.addColorStop(0, color(theme.high, amount * 0.75)); sheen.addColorStop(0.6, color(theme.main, 0));
          ctx.fillStyle = sheen; ctx.fillRect(x + 1, y + 1, Math.max(0, kw - 2), kh - 2);
        }
        if (labels && !black && k.note % 12 === 0 && kw > 10 && height > 36) {
          ctx.fillStyle = 'rgba(24,41,58,0.58)'; ctx.textAlign = 'center'; ctx.font = `500 ${clamp(kw * 0.35, 8, 12)}px "Segoe UI",sans-serif`;
          ctx.fillText(noteName(k.note), k.center, y + kh - 12);
        }
      }
    }
    ctx.restore();
  }

  drawStrike(ctx, width, y, active, layout, theme, glow) {
    ctx.save();
    ctx.strokeStyle = color(theme.main, 0.25 + glow * 0.15); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(width, y + 0.5); ctx.stroke();
    for (const [pitch, note] of active) {
      const k = layout.byNote.get(pitch);
      const radius = Math.max(12, k.width * 1.3) * (0.8 + glow * 0.5);
      const spot = ctx.createRadialGradient(k.center, y, 0, k.center, y, radius);
      spot.addColorStop(0, color(theme.high, 0.75 * glow)); spot.addColorStop(0.18, color(theme.main, 0.32 * glow)); spot.addColorStop(1, color(theme.main, 0));
      ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = spot;
      ctx.fillRect(k.center - radius, y - radius, radius * 2, radius * 2);
      ctx.shadowBlur = 10 * glow; ctx.shadowColor = color(theme.main, 1);
      ctx.fillStyle = color(theme.high, 0.55 + note.velocity / 127 * 0.45);
      rounded(ctx, k.center - k.width * 0.42, y - 1, k.width * 0.84, 2.5, 1); ctx.fill();
    }
    ctx.restore();
  }
}
