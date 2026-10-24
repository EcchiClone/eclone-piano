/**
 * Losslessly align MIDI to recorded PCM using the capture helper's QPC/frame
 * anchors. The waveform and MIDI bytes never change. Each mapped event retains
 * its original capture-clock timestamp in wallTime; t becomes PCM seconds.
 */
export function mapMidiEventsToAudio(events, clockMap, wave) {
  const fallback = { events, mapping: undefined, clockMap: undefined };
  if (
    !clockMap ||
    clockMap.version !== 1 ||
    !Array.isArray(clockMap.anchors) ||
    clockMap.anchors.length < 2 ||
    clockMap.anchors.length > 4096 ||
    !Number.isFinite(wave?.sampleRate) ||
    wave.sampleRate <= 0 ||
    clockMap.sampleRate !== wave.sampleRate ||
    !Number.isFinite(wave.frames) ||
    wave.frames < 1
  )
    return fallback;
  const anchors = [];
  for (const point of clockMap.anchors) {
    if (!point || !Number.isFinite(point.wallTime) || !Number.isSafeInteger(point.frame))
      return fallback;
    const previous = anchors.at(-1);
    if (previous && (point.wallTime <= previous.wallTime || point.frame <= previous.frame))
      return fallback;
    if (previous) {
      const rateRatio =
        (point.frame - previous.frame) / (point.wallTime - previous.wallTime) / wave.sampleRate;
      // A malformed or severely discontinuous clock must not rewrite MIDI.
      if (rateRatio < 0.5 || rateRatio > 2) return fallback;
    }
    anchors.push({ wallTime: point.wallTime, frame: point.frame });
  }
  let maxAdjustmentMs = 0,
    mappedEventCount = 0;
  const mapped = events.map((event) => {
    const wallTime = Number.isFinite(event.wallTime) ? event.wallTime : event.t;
    if (!Number.isFinite(wallTime) || wallTime < 0) return event;
    let low = 0,
      high = anchors.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (anchors[middle].wallTime <= wallTime) low = middle;
      else high = middle;
    }
    if (wallTime >= anchors.at(-1).wallTime) {
      low = anchors.length - 2;
      high = anchors.length - 1;
    }
    const left = anchors[low],
      right = anchors[high];
    const frame =
      left.frame +
      ((wallTime - left.wallTime) * (right.frame - left.frame)) / (right.wallTime - left.wallTime);
    const t = Math.min(wave.frames, Math.max(0, Math.round(frame))) / wave.sampleRate;
    mappedEventCount++;
    maxAdjustmentMs = Math.max(maxAdjustmentMs, Math.abs(t - wallTime) * 1000);
    return { ...event, t, wallTime };
  });
  return {
    events: mapped,
    clockMap: { version: 1, sampleRate: wave.sampleRate, anchors },
    mapping: {
      version: 1,
      method: 'piecewise-linear',
      source: 'capture-clock',
      target: 'audio-pcm',
      anchorCount: anchors.length,
      mappedEventCount,
      maxAdjustmentMs,
    },
  };
}
