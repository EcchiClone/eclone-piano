// Read-only diagnostics for PCM16 stereo capture files. Never changes a take.
import fs from 'node:fs/promises';

for (const filename of process.argv.slice(2)) {
  const bytes = await fs.readFile(filename);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`${filename}: not a RIFF WAV`);
  let format, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4),
      size = bytes.readUInt32LE(offset + 4);
    if (kind === 'fmt ') format = bytes.subarray(offset + 8, offset + 8 + size);
    if (kind === 'data')
      data = bytes.subarray(offset + 8, Math.min(bytes.length, offset + 8 + size));
    offset += 8 + size + (size & 1);
  }
  if (
    !format ||
    !data ||
    format.readUInt16LE(0) !== 1 ||
    format.readUInt16LE(2) !== 2 ||
    format.readUInt16LE(14) !== 16
  )
    throw new Error(`${filename}: diagnostics require PCM16 stereo`);
  const rate = format.readUInt32LE(4),
    frames = data.length / 4;
  let peak = 0,
    squares = 0,
    clipped = 0,
    zeroStart = -1,
    firstSignal = -1,
    lastSignal = -1;
  const zeroRuns = [],
    jumps = [];
  let previousL = 0,
    previousR = 0;
  const frame = (i) =>
    i < 0 || i >= frames ? [0, 0] : [data.readInt16LE(i * 4), data.readInt16LE(i * 4 + 2)];
  for (let i = 0; i < frames; i++) {
    const [left, right] = frame(i),
      absolute = Math.max(Math.abs(left), Math.abs(right));
    peak = Math.max(peak, absolute);
    squares += left * left + right * right;
    clipped += Number(Math.abs(left) >= 32767) + Number(Math.abs(right) >= 32767);
    if (absolute > 16) {
      if (firstSignal < 0) firstSignal = i;
      lastSignal = i;
    }
    if (left === 0 && right === 0) {
      if (zeroStart < 0) zeroStart = i;
    } else if (zeroStart >= 0) {
      if (i - zeroStart >= 8) zeroRuns.push({ start: zeroStart, end: i });
      zeroStart = -1;
    }
    const delta = Math.max(Math.abs(left - previousL), Math.abs(right - previousR));
    if (delta > 400)
      jumps.push({
        frame: i,
        delta,
        stereo: Math.min(Math.abs(left - previousL), Math.abs(right - previousR)),
      });
    previousL = left;
    previousR = right;
  }
  if (zeroStart >= 0) zeroRuns.push({ start: zeroStart, end: frames });
  const internalRuns = zeroRuns
    .filter((run) => run.start > firstSignal && run.end < lastSignal)
    .map((run) => {
      const previous = frame(run.start - 1),
        next = frame(run.end);
      let nearbyPeak = 0;
      for (let i = Math.max(0, run.start - 240); i < Math.min(frames, run.end + 240); i++) {
        if (i >= run.start && i < run.end) continue;
        nearbyPeak = Math.max(nearbyPeak, ...frame(i).map(Math.abs));
      }
      return {
        at: run.start / rate,
        frames: run.end - run.start,
        ms: ((run.end - run.start) / rate) * 1000,
        previous,
        next,
        nearbyPeak,
        boundaryPeak: Math.max(...previous.map(Math.abs), ...next.map(Math.abs)),
      };
    });
  const likelyGaps = internalRuns.filter((run) => run.nearbyPeak > 64);
  jumps.sort((a, b) => b.delta - a.delta);
  console.log(
    JSON.stringify(
      {
        filename,
        rate,
        frames,
        seconds: frames / rate,
        peak: peak / 32768,
        peakDbfs: 20 * Math.log10(peak / 32768),
        rms: Math.sqrt(squares / frames / 2) / 32768,
        clippedSamples: clipped,
        firstSignal: firstSignal / rate,
        lastSignal: lastSignal / rate,
        zeroRuns: zeroRuns.length,
        internalZeroRuns: internalRuns.length,
        likelyGapCount: likelyGaps.length,
        likelyGaps: likelyGaps.slice(0, 60),
        topJumps: jumps.slice(0, 20).map((item) => ({
          at: item.frame / rate,
          delta: item.delta,
          stereoDelta: item.stereo,
          before: frame(item.frame - 1),
          after: frame(item.frame),
        })),
      },
      null,
      2,
    ),
  );
}
