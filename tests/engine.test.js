import test from 'node:test';
import assert from 'node:assert/strict';
import { Performance, PianoRenderer, pianoLayout } from '../public/engine.js';

test('note on, zero-velocity note off, and physical vs sounding state', () => {
  const p = new Performance();
  p.ingest({ t: 1, data: [0x90, 60, 100] });
  assert.equal(p.activeAt(1).length, 1);
  p.ingest({ t: 2, data: [0x90, 60, 0] });
  assert.deepEqual(p.notes[0], {
    id: 1,
    note: 60,
    velocity: 100,
    channel: 0,
    start: 1,
    release: 2,
    end: 2,
  });
  assert.equal(p.activeAt(2).length, 0);
});

test('sustain is channel-specific and ends released notes at pedal-up', () => {
  const p = new Performance();
  p.ingest({ t: 0, data: [0xb0, 64, 127] });
  p.ingest({ t: 1, data: [0x90, 60, 90] });
  p.ingest({ t: 1, data: [0x91, 60, 90] });
  p.ingest({ t: 2, data: [0x80, 60, 0] });
  p.ingest({ t: 2, data: [0x81, 60, 0] });
  assert.equal(p.notes[0].end, Infinity);
  assert.equal(p.notes[1].end, 2);
  assert.equal(p.activeAt(2.5, true).length, 0);
  assert.equal(p.activeAt(2.5).length, 1);
  p.ingest({ t: 3, data: [0xb0, 64, 0] });
  assert.equal(p.notes[0].release, 2);
  assert.equal(p.notes[0].end, 3);
});

test('repeated pitch keeps distinct lifetimes and matches offs FIFO', () => {
  const p = new Performance();
  p.ingest({ t: 0, data: [0x90, 60, 64] });
  p.ingest({ t: 0.1, data: [0x90, 60, 96] });
  p.ingest({ t: 0.2, data: [0x80, 60, 0] });
  p.ingest({ t: 0.3, data: [0x80, 60, 0] });
  assert.equal(p.notes[0].end, 0.2);
  assert.equal(p.notes[1].end, 0.3);
  assert.equal(p.held.size, 0);
});

test('piano retrigger policy recovers a missing key-up without changing raw MIDI or pedal tails', () => {
  const events = [
    { t: 0, data: [187, 64, 127] },
    { t: 1, data: [155, 60, 64] },
    // A missing first key-up must not leave a second physically held instance forever.
    { t: 2, data: [155, 60, 96] },
    { t: 3, data: [155, 60, 0] },
    { t: 4, data: [187, 64, 0] },
  ];
  const p = new Performance({ notePolicy: 'piano' });
  for (const event of events) p.ingest(event);
  assert.equal(p.notes.length, 2);
  assert.equal(p.notes[0].release, 2);
  assert.equal(p.notes[1].release, 3);
  assert.equal(p.notes[0].end, 4);
  assert.equal(p.notes[1].end, 4);
  assert.equal(p.activeAt(3.5).length, 2);
  assert.equal(p.activeAt(3.5, true).length, 0);
  assert.equal(p.activeAt(4).length, 0);
  assert.equal(p.retriggerRecoveries, 1);
  assert.deepEqual(p.events, events);
  const restored = Performance.fromJSON(JSON.parse(JSON.stringify(p)));
  assert.equal(restored.notePolicy, 'piano');
  assert.deepEqual(restored.notes, p.notes);
});

test('piano policy preserves arbitrarily long valid keys and pedal tails across channels', () => {
  const p = new Performance({ notePolicy: 'piano' });
  p.ingest({ t: 0, data: [144, 60, 80] });
  p.ingest({ t: 0, data: [177, 64, 127] });
  p.ingest({ t: 0, data: [145, 60, 80] });
  p.ingest({ t: 1, data: [129, 60, 0] });
  p.ingest({ t: 3600, data: [176, 1, 10] });
  p.prune(3580, { events: true });
  assert.equal(p.activeAt(3600).length, 2);
  assert.equal(p.activeAt(3600, true).length, 1);
  assert.equal(p.retriggerRecoveries, 0);
  p.ingest({ t: 3601, data: [177, 64, 0] });
  assert.equal(p.activeAt(3601).length, 1);
  p.ingest({ t: 3602, data: [128, 60, 0] });
  assert.equal(p.activeAt(3602).length, 0);
});

test('All Notes Off honors sustain while All Sound Off immediately silences its channel', () => {
  const p = new Performance();
  p.ingest({ t: 0, data: [0xb0, 64, 127] });
  p.ingest({ t: 0, data: [0x90, 60, 100] });
  p.ingest({ t: 0, data: [0x91, 62, 100] });
  p.ingest({ t: 1, data: [0xb0, 123, 0] });
  assert.equal(p.notes[0].release, 1);
  assert.equal(p.notes[0].end, Infinity);
  p.ingest({ t: 2, data: [0xb0, 120, 0] });
  assert.equal(p.notes[0].end, 2);
  assert.equal(p.notes[1].end, Infinity);
  p.finish(3);
  assert.equal(p.notes[1].end, 3);
});

test('recording round trip preserves sustain and closes unfinished notes at duration', () => {
  const p = new Performance();
  p.ingest({ t: 0.2, data: [0x90, 60, 100] });
  p.ingest({ t: 0.3, data: [0xb0, 64, 127] });
  p.ingest({ t: 0.5, data: [0x80, 60, 0] });
  p.finish(1.5);
  const loaded = Performance.fromJSON(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(loaded.notes, p.notes);
  assert.equal(loaded.duration, 1.5);
});

test('import sorts events stably, ignores malformed MIDI and rejects missing event lists', () => {
  const p = Performance.fromJSON({
    duration: 2,
    events: [
      { t: 1, data: [0x80, 60, 0] },
      { t: 0, data: [0x90, 60, 100] },
      { t: -1, data: [0x90, 40, 100] },
    ],
  });
  assert.equal(p.notes[0].start, 0);
  assert.equal(p.notes[0].end, 1);
  assert.equal(p.ingest({ t: 3, data: [0x90, 200, 80] }), null);
  assert.equal(p.notes.length, 1);
  assert.throws(() => Performance.fromJSON({}), /events/);
});

test('pruning leaves sounding notes and recording data intact', () => {
  const p = new Performance();
  p.ingest({ t: 0, data: [0x90, 60, 100] });
  p.ingest({ t: 1, data: [0x80, 60, 0] });
  p.ingest({ t: 2, data: [0x90, 62, 100] });
  p.prune(1.5);
  assert.equal(p.notes.length, 1);
  assert.equal(p.notes[0].note, 62);
  assert.equal(p.events.length, 3);
});

test('88-key layout contains 52 whites and 36 blacks with C-sharp at the C/D boundary', () => {
  const layout = pianoLayout(1040);
  assert.equal(layout.keys.length, 88);
  assert.equal(layout.keys.filter((k) => !k.black).length, 52);
  assert.equal(layout.keys.filter((k) => k.black).length, 36);
  const c = layout.byNote.get(60);
  const cs = layout.byNote.get(61);
  assert.ok(Math.abs(cs.center - (c.x + c.width)) < 1e-8);
  assert.ok(Math.abs(layout.keys[0].x) < 1e-8);
  const last = layout.keys.at(-1);
  assert.ok(Math.abs(last.x + last.width - 1040) < 1e-8);
});

test('explicit export pixelRatio keeps a 1080p canvas exact on a high-DPI display', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
  Object.defineProperty(globalThis, 'devicePixelRatio', { value: 3, configurable: true });
  try {
    const ctx = Object.fromEntries(
      [
        'setTransform',
        'clearRect',
        'save',
        'restore',
        'beginPath',
        'rect',
        'clip',
        'moveTo',
        'lineTo',
        'stroke',
      ].map((name) => [name, () => {}]),
    );
    const makeCanvas = () => ({
      width: 300,
      height: 150,
      getContext: () => ctx,
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
    });
    const settings = {
      background: 'transparent',
      keyboard: false,
      particles: false,
      glow: 0,
      quality: 2,
      pixelRatio: 1,
    };
    const canvas = makeCanvas();
    const renderer = new PianoRenderer(canvas, () => settings);
    assert.equal(canvas.width, 1920);
    assert.equal(canvas.height, 1080);
    assert.equal(renderer.ratio, 1);
    delete settings.pixelRatio;
    renderer.resize();
    assert.equal(
      canvas.width,
      7680,
      'Without an override, capped device DPI and quality still apply.',
    );
    assert.equal(canvas.height, 4320);
    renderer.destroy();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'devicePixelRatio', previous);
    else delete globalThis.devicePixelRatio;
  }
});

test(
  'overlay opacity composites whole note and keyboard layers without alpha buildup',
  { timeout: 30000 },
  async () => {
    const { chromium } = await import('@playwright/test');
    const { readFile, access } = await import('node:fs/promises');
    const source = await readFile(new URL('../public/engine.js', import.meta.url), 'utf8');
    let executablePath = process.env.LUMA_TEST_BROWSER;
    if (!executablePath && process.platform === 'win32') {
      for (const candidate of [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      ]) {
        try {
          await access(candidate);
          executablePath = candidate;
          break;
        } catch {}
      }
    }
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.route('http://luma-render.test/**', (route) =>
        route.fulfill({
          contentType: route.request().url().endsWith('/engine.js')
            ? 'text/javascript'
            : 'text/html',
          body: route.request().url().endsWith('/engine.js')
            ? source
            : '<canvas id="piano" width="640" height="360" style="width:640px;height:360px"></canvas>',
        }),
      );
      await page.goto('http://luma-render.test/');
      const result = await page.evaluate(async () => {
        const { PianoRenderer } = await import('/engine.js');
        const canvas = document.getElementById('piano');
        const state = {
          background: 'transparent',
          pixelRatio: 1,
          minNote: 48,
          maxNote: 72,
          keyboard: true,
          labels: true,
          particles: true,
          glow: 1,
          time: 1,
          notes: Array.from({ length: 3 }, (_, id) => ({
            id,
            note: 60,
            velocity: 127,
            channel: 0,
            start: 0,
            end: Infinity,
            release: Infinity,
          })),
        };
        const renderer = new PianoRenderer(canvas, () => state);
        const capture = (overrides) => {
          renderer.renderAt(1, overrides);
          return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const maxAlpha = (bytes) => {
          let max = 0;
          for (let i = 3; i < bytes.length; i += 4) max = Math.max(max, bytes[i]);
          return max;
        };
        const keys = capture({ keyboardOpacity: 0.18, noteOpacity: 0 });
        const scratch = renderer.layerCanvas;
        const notes = capture({ keyboardOpacity: 0, noteOpacity: 0.6 });
        const combined = capture({ keyboardOpacity: 0.18, noteOpacity: 0.6 });
        const repeated = capture({ keyboardOpacity: 0.18, noteOpacity: 0.6 });
        let compositionError = 0,
          repeatedError = 0;
        for (let i = 3; i < combined.length; i += 4) {
          const expected = notes[i] + keys[i] * (1 - notes[i] / 255);
          compositionError = Math.max(compositionError, Math.abs(combined[i] - expected));
          repeatedError = Math.max(repeatedError, Math.abs(combined[i] - repeated[i]));
        }
        const blank = capture({ keyboardOpacity: 0, noteOpacity: 0 });
        const defaults = capture({ notes: [] });
        const dark = capture({ background: 'dark', keyboardOpacity: 0.18, noteOpacity: 0.6 });
        let darkMinimum = 255;
        for (let i = 3; i < dark.length; i += 4) darkMinimum = Math.min(darkMinimum, dark[i]);
        const reused = scratch === renderer.layerCanvas;
        state.pixelRatio = 2;
        renderer.resize();
        const scaled = capture({ keyboardOpacity: 0.18, noteOpacity: 0 });
        const scaledSize = [
          canvas.width,
          canvas.height,
          renderer.layerCanvas.width,
          renderer.layerCanvas.height,
        ];
        renderer.destroy();
        return {
          keyMax: maxAlpha(keys),
          noteMax: maxAlpha(notes),
          combinedMax: maxAlpha(combined),
          topAlpha: combined[3],
          compositionError,
          repeatedError,
          blankMax: maxAlpha(blank),
          defaultMax: maxAlpha(defaults),
          darkMinimum,
          reused,
          scaledMax: maxAlpha(scaled),
          scaledSize,
          releasedSize: [scratch.width, scratch.height],
        };
      });
      assert.equal(
        result.keyMax,
        46,
        'Every key fill, highlight, black key and label stays within 18% alpha.',
      );
      assert.equal(
        result.noteMax,
        153,
        'Overlapping notes, particles and strike glow stay within 60% alpha.',
      );
      assert.equal(result.topAlpha, 0, 'The untouched canvas corner remains fully transparent.');
      assert.ok(
        result.compositionError <= 1.1,
        'Notes composite over keys once, without holes or accumulated group alpha.',
      );
      assert.ok(
        result.combinedMax <= 172,
        'The two layers overlap using ordinary source-over alpha.',
      );
      assert.equal(result.repeatedError, 0, 'Repeated frames do not accumulate opacity.');
      assert.equal(
        result.blankMax,
        0,
        'Setting both layer opacities to zero also hides strike glows.',
      );
      assert.equal(
        result.defaultMax,
        255,
        'Default studio and OBS keyboard opacity remains unchanged.',
      );
      assert.equal(
        result.darkMinimum,
        255,
        'Layer compositing does not punch holes in the background.',
      );
      assert.equal(
        result.reused,
        true,
        'Both visual groups and subsequent frames reuse one scratch surface.',
      );
      assert.equal(result.scaledMax, 46);
      assert.deepEqual(result.scaledSize, [1280, 720, 1280, 720]);
      assert.deepEqual(result.releasedSize, [0, 0]);
    } finally {
      await browser.close();
    }
  },
);
