import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMidi } from '../server/midi-file.js';

// Read the SMF independently, checking framing and converting deltas to ticks.
function parse(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'MThd');
  assert.equal(bytes.readUInt32BE(4), 6);
  assert.equal(bytes.readUInt16BE(8), 0);
  assert.equal(bytes.readUInt16BE(10), 1);
  assert.equal(bytes.readUInt16BE(12), 480);
  assert.equal(bytes.toString('ascii', 14, 18), 'MTrk');
  assert.equal(bytes.readUInt32BE(18), bytes.length - 22);
  let offset = 22;
  let tick = 0;
  const events = [];
  const vlq = () => {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = bytes[offset++];
      assert.notEqual(byte, undefined, 'Truncated VLQ');
      value = value * 128 + (byte & 127);
      if (byte < 128) return value;
    }
    assert.fail('VLQ longer than four bytes');
  };
  while (offset < bytes.length) {
    tick += vlq();
    const status = bytes[offset++];
    if (status === 255) {
      const type = bytes[offset++];
      const length = vlq();
      events.push({ tick, meta: type, data: [...bytes.subarray(offset, offset + length)] });
      offset += length;
    } else {
      assert.ok(status >= 128 && status < 240);
      const length = (status & 224) === 192 ? 1 : 2;
      events.push({ tick, data: [status, ...bytes.subarray(offset, offset + length)] });
      offset += length;
    }
  }
  assert.equal(offset, bytes.length);
  assert.equal(events.at(-1).meta, 47);
  return events;
}

test('encodes exact seconds with explicit tempo, VLQ deltas and trailing duration', () => {
  const bytes = encodeMidi([
    { t: 0, data: [144, 60, 100] },
    { t: 1, data: [128, 60, 20] },
  ], 1.5);
  const events = parse(bytes);
  assert.deepEqual(events, [
    { tick: 0, meta: 81, data: [7, 161, 32] },
    { tick: 0, data: [144, 60, 100] },
    { tick: 960, data: [128, 60, 20] },
    { tick: 1440, meta: 47, data: [] },
  ]);
  assert.ok(bytes.includes(Buffer.from([0x87, 0x40, 128, 60, 20])));
});

test('releases unreleased notes and sustain independently on each MIDI channel', () => {
  const events = parse(encodeMidi([
    { t: 0, data: [145, 64, 90] },
    { t: 0.1, data: [177, 64, 127] },
    { t: 0.2, data: [146, 64, 70] },
    { t: 0.3, data: [146, 64, 0] },
  ], 2));
  assert.deepEqual(events.filter(event => event.tick === 1920), [
    { tick: 1920, data: [129, 64, 0] },
    { tick: 1920, data: [177, 64, 0] },
    { tick: 1920, meta: 47, data: [] },
  ]);
});

test('preserves controller, program, pressure and pitch messages while ignoring transport', () => {
  const events = parse(encodeMidi([
    { t: 0, data: [0xf8] },
    { t: 0, data: [192, 10] },
    { t: 0.1, data: [208, 60] },
    { t: 0.2, data: [224, 0, 64] },
    { t: 0.3, data: [160, 60, 22] },
    { t: 0.4, data: [176, 11, 85] },
    { t: 0.5, data: [0xfe] },
  ]));
  assert.deepEqual(events.filter(event => event.meta === undefined).map(event => event.data), [
    [192, 10], [208, 60], [224, 0, 64], [160, 60, 22], [176, 11, 85],
  ]);
  assert.equal(events.at(-1).tick, 480);
});

test('sorts events without changing equal-time order or mutating the source', () => {
  const source = [
    { t: 1, data: [128, 60, 0] },
    { t: 0, data: [144, 60, 90] },
    { t: 1, data: [144, 60, 50] },
  ];
  const copy = structuredClone(source);
  const events = parse(encodeMidi(source, 2));
  assert.deepEqual(source, copy);
  assert.deepEqual(events.filter(event => event.tick === 960).map(event => event.data), [[128, 60, 0], [144, 60, 50]]);
  assert.deepEqual(events.filter(event => event.tick === 1920 && event.meta === undefined).map(event => event.data), [[128, 60, 0]]);
});

test('counts overlapping same-pitch notes and honors reset/all-notes-off controllers', () => {
  const repeated = parse(encodeMidi([
    { t: 0, data: [144, 60, 90] },
    { t: 0.1, data: [144, 60, 80] },
    { t: 0.2, data: [128, 60, 0] },
  ], 1));
  assert.equal(repeated.filter(event => event.tick === 960 && event.data[0] === 128).length, 1);
  const reset = parse(encodeMidi([
    { t: 0, data: [144, 60, 90] },
    { t: 0, data: [176, 64, 127] },
    { t: 0.1, data: [176, 123, 0] },
    { t: 0.2, data: [176, 121, 0] },
  ], 1));
  assert.deepEqual(reset.filter(event => event.tick === 960), [{ tick: 960, meta: 47, data: [] }]);
});

test('sub-tick events retain chronological ordering after time quantization', () => {
  const events = parse(encodeMidi([
    { t: 0.1002, data: [128, 60, 0] },
    { t: 0.1001, data: [144, 60, 90] },
  ], 1));
  assert.deepEqual(events.filter(event => event.tick === 96).map(event => event.data), [[144, 60, 90], [128, 60, 0]]);
  assert.deepEqual(events.filter(event => event.tick === 960), [{ tick: 960, meta: 47, data: [] }]);
});

test('empty recording is valid and duration cannot truncate recorded events', () => {
  assert.deepEqual(parse(encodeMidi([], 0)).at(-1), { tick: 0, meta: 47, data: [] });
  const events = parse(encodeMidi([{ t: 2, data: [144, 60, 100] }], 1));
  assert.equal(events.at(-1).tick, 1920);
  assert.deepEqual(events.at(-2).data, [128, 60, 0]);
});

test('rejects malformed data instead of writing corrupt SMF bytes', () => {
  assert.throws(() => encodeMidi(null, 1), TypeError);
  assert.throws(() => encodeMidi([], NaN), RangeError);
  assert.throws(() => encodeMidi([], 1e12), RangeError);
  for (const event of [
    { t: -1, data: [144, 60, 1] },
    { t: Infinity, data: [144, 60, 1] },
    { t: 0, data: [144, 60] },
    { t: 0, data: [144, 60, 128] },
    { t: 0, data: [144, 60.5, 1] },
    { t: 0, data: [60, 1] },
  ]) assert.throws(() => encodeMidi([event], 1), RangeError);
});

test('long silence uses legal four-byte VLQs and preserves absolute time', () => {
  const duration = (0x0fffffff + 960) / 960;
  const events = parse(encodeMidi([], duration));
  assert.equal(events.at(-1).tick, 0x0fffffff + 960);
  assert.deepEqual(events[1], { tick: 0x0fffffff, meta: 1, data: [] });
});
