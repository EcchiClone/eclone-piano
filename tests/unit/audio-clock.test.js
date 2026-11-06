import test from 'node:test';
import assert from 'node:assert/strict';
import { mapMidiEventsToAudio } from '../../server/audio-clock.js';

const wave = { sampleRate: 48000, frames: 28_800_000 };
const clock = (anchors) => ({ version: 1, sampleRate: 48000, anchors });

test('actual 336-frame / 7.0068ms process-loopback slope maps MIDI without touching raw data', () => {
  const wallTime = 7.0068,
    original = [{ t: wallTime, data: [144, 60, 100] }];
  const mapped = mapMidiEventsToAudio(
    original,
    clock([
      { wallTime: 0, frame: 0 },
      { wallTime: 7.0068, frame: 336000 },
    ]),
    wave,
  );
  assert.equal(mapped.events[0].t, 7);
  assert.equal(mapped.events[0].wallTime, wallTime);
  assert.equal(original[0].t, wallTime);
  assert.equal(original[0].wallTime, undefined);
  assert.deepEqual(mapped.events[0].data, original[0].data);
  assert.ok(Math.abs(mapped.mapping.maxAdjustmentMs - 6.8) < 1e-8);
});

test('piecewise mapping preserves note/pedal order and endpoint extrapolation', () => {
  const data = [
    [144, 60, 80],
    [176, 64, 127],
    [128, 60, 0],
    [176, 64, 0],
  ];
  const original = [0, 10.01, 15.015, 25.025].map((t, i) => ({ t, data: data[i] }));
  const result = mapMidiEventsToAudio(
    original,
    clock([
      { wallTime: 1.001, frame: 48000 },
      { wallTime: 10.01, frame: 480000 },
      { wallTime: 20.02, frame: 960000 },
    ]),
    wave,
  );
  assert.deepEqual(
    result.events.map((e) => e.t),
    [0, 10, 15, 25],
  );
  assert.deepEqual(
    result.events.map((e) => e.wallTime),
    original.map((e) => e.t),
  );
  assert.deepEqual(
    result.events.map((e) => e.data),
    data,
  );
  assert.deepEqual(
    mapMidiEventsToAudio(result.events, result.clockMap, wave).events,
    result.events,
  );
});

test('six-hour mapping remains sample-accurate with bounded anchors and original timestamps', () => {
  const longWave = { sampleRate: 48000, frames: 21_600 * 48000 };
  const drift = 1 + 68 / 70000;
  const anchors = Array.from({ length: 2161 }, (_, i) => ({
    wallTime: i * 10 * drift,
    frame: i * 10 * 48000,
  }));
  const original = [{ t: 21599 * drift, data: [128, 60, 0] }];
  const result = mapMidiEventsToAudio(original, clock(anchors), longWave);
  assert.equal(result.events[0].t, 21599);
  assert.equal(result.events[0].wallTime, original[0].t);
  assert.ok(result.mapping.maxAdjustmentMs > 20000);
});

test('invalid or missing clock maps leave MIDI timestamps unchanged', () => {
  const events = [{ t: 5, data: [144, 60, 100] }];
  for (const invalid of [
    undefined,
    clock([]),
    clock([{ wallTime: 0, frame: 0 }]),
    clock([
      { wallTime: 1, frame: 0 },
      { wallTime: 0, frame: 480 },
    ]),
    clock([
      { wallTime: 0, frame: 0 },
      { wallTime: 1, frame: 2 },
    ]),
  ]) {
    const result = mapMidiEventsToAudio(events, invalid, wave);
    assert.equal(result.events, events);
    assert.equal(result.mapping, undefined);
  }
});

test('mapped MIDI respects the WAV bounds including final wall-duration silence', () => {
  const result = mapMidiEventsToAudio(
    [
      { t: 0, data: [144, 60, 90] },
      { t: 2, data: [128, 60, 0] },
    ],
    clock([
      { wallTime: 0.01, frame: 0 },
      { wallTime: 1.01, frame: 48000 },
    ]),
    { sampleRate: 48000, frames: 72000 },
  );
  assert.deepEqual(
    result.events.map((e) => e.t),
    [0, 1.5],
  );
  assert.deepEqual(
    result.events.map((e) => e.wallTime),
    [0, 2],
  );
});
