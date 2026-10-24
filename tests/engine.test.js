import test from 'node:test';
import assert from 'node:assert/strict';
import { Performance, pianoLayout } from '../public/engine.js';

test('note on, zero-velocity note off, and physical vs sounding state', () => {
  const p = new Performance();
  p.ingest({ t: 1, data: [0x90, 60, 100] });
  assert.equal(p.activeAt(1).length, 1);
  p.ingest({ t: 2, data: [0x90, 60, 0] });
  assert.deepEqual(p.notes[0], { id: 1, note: 60, velocity: 100, channel: 0, start: 1, release: 2, end: 2 });
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
  const p = Performance.fromJSON({ duration: 2, events: [{ t: 1, data: [0x80, 60, 0] }, { t: 0, data: [0x90, 60, 100] }, { t: -1, data: [0x90, 40, 100] }] });
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
  assert.equal(layout.keys.filter(k => !k.black).length, 52);
  assert.equal(layout.keys.filter(k => k.black).length, 36);
  const c = layout.byNote.get(60);
  const cs = layout.byNote.get(61);
  assert.ok(Math.abs(cs.center - (c.x + c.width)) < 1e-8);
  assert.ok(Math.abs(layout.keys[0].x) < 1e-8);
  const last = layout.keys.at(-1);
  assert.ok(Math.abs(last.x + last.width - 1040) < 1e-8);
});
