import { Buffer } from 'node:buffer';

const PPQ = 480;
const TICKS_PER_SECOND = PPQ * 2; // Fixed 120 BPM, 500,000 microseconds/quarter.
const MAX_VLQ = 0x0fffffff;
const MAX_TIMELINE_TICKS = 0xffffffff; // Over 51 days; bounds silence expansion.

function variableLength(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VLQ) {
    throw new RangeError('MIDI delta time is outside the four-byte VLQ range.');
  }
  const bytes = [value & 0x7f];
  while ((value = Math.floor(value / 128)) > 0) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
}

/**
 * Encode a performance as a Standard MIDI File, format 0 / PPQ 480 / 120 BPM.
 * Events contain { t: seconds since recording began, data: complete MIDI bytes }.
 * Channel voice messages are preserved; MIDI transport/clock and SysEx are omitted.
 * The declared duration is extended to the last event if needed, never truncating
 * the performance. Unreleased keys and active sustain pedals end at that boundary.
 */
export function encodeMidi(events, duration) {
  if (!Array.isArray(events)) throw new TypeError('MIDI events must be an array.');
  if (duration !== undefined && (!Number.isFinite(duration) || duration < 0)) {
    throw new RangeError('MIDI duration must be a finite, nonnegative number of seconds.');
  }
  let endSeconds = duration ?? 0;
  const ordered = events
    .map((event, index) => {
      if (!event || !Number.isFinite(event.t) || event.t < 0) {
        throw new RangeError(`MIDI event ${index} has an invalid time.`);
      }
      if (!Array.isArray(event.data) && !(event.data instanceof Uint8Array)) {
        throw new TypeError(`MIDI event ${index} must contain a byte array.`);
      }
      const data = Array.from(event.data);
      if (
        !data.length ||
        !data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
      ) {
        throw new RangeError(`MIDI event ${index} contains an invalid byte.`);
      }
      const status = data[0];
      if (status < 0x80)
        throw new RangeError(`MIDI event ${index} requires an explicit status byte.`);
      if (status < 0xf0) {
        const expected = (status & 0xe0) === 0xc0 ? 2 : 3;
        if (data.length !== expected || data.slice(1).some((byte) => byte > 127)) {
          throw new RangeError(`MIDI event ${index} is not a complete channel message.`);
        }
      }
      endSeconds = Math.max(endSeconds, event.t);
      const tick = Math.round(event.t * TICKS_PER_SECOND);
      if (!Number.isSafeInteger(tick) || tick > MAX_TIMELINE_TICKS)
        throw new RangeError(`MIDI event ${index} exceeds the supported timeline.`);
      return { tick, time: event.t, data, index };
    })
    .filter((event) => event.data[0] < 0xf0)
    .sort((a, b) => a.time - b.time || a.index - b.index);

  const endTick = Math.round(endSeconds * TICKS_PER_SECOND);
  if (!Number.isSafeInteger(endTick) || endTick > MAX_TIMELINE_TICKS)
    throw new RangeError('MIDI duration exceeds the supported timeline.');

  // Tempo is explicit so other applications reproduce the recording's seconds.
  const track = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20];
  const held = Array.from({ length: 16 }, () => new Map());
  const sustain = new Array(16).fill(false);
  let previousTick = 0;
  const append = (tick, bytes) => {
    let delta = tick - previousTick;
    // Empty text events safely bridge a silence longer than the VLQ limit.
    while (delta > MAX_VLQ) {
      track.push(...variableLength(MAX_VLQ), 0xff, 0x01, 0);
      delta -= MAX_VLQ;
    }
    track.push(...variableLength(delta), ...bytes);
    previousTick = tick;
  };

  for (const { tick, data } of ordered) {
    append(tick, data);
    const channel = data[0] & 0x0f;
    const kind = data[0] & 0xf0;
    const notes = held[channel];
    const note = data[1];
    if (kind === 0x90 && data[2] > 0) notes.set(note, (notes.get(note) ?? 0) + 1);
    else if (kind === 0x80 || (kind === 0x90 && data[2] === 0)) {
      const count = notes.get(note) ?? 0;
      if (count > 1) notes.set(note, count - 1);
      else notes.delete(note);
    } else if (kind === 0xb0) {
      if (data[1] === 64) sustain[channel] = data[2] >= 64;
      else if (data[1] === 121) sustain[channel] = false;
      else if (data[1] === 120 || data[1] >= 123) notes.clear();
    }
  }

  for (let channel = 0; channel < 16; channel++) {
    for (const [note, count] of held[channel]) {
      for (let i = 0; i < count; i++) append(endTick, [0x80 | channel, note, 0]);
    }
    if (sustain[channel]) append(endTick, [0xb0 | channel, 64, 0]);
  }
  append(endTick, [0xff, 0x2f, 0]);

  const body = Buffer.from(track);
  const header = Buffer.alloc(22);
  header.write('MThd', 0, 'ascii');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(0, 8); // Format 0.
  header.writeUInt16BE(1, 10); // One track; all 16 channels remain separate.
  header.writeUInt16BE(PPQ, 12);
  header.write('MTrk', 14, 'ascii');
  header.writeUInt32BE(body.length, 18);
  return Buffer.concat([header, body]);
}
