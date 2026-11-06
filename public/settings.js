export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'aurora',
  background: 'dark',
  direction: 'up',
  particles: true,
  glow: 0.75,
  keyboard: true,
  labels: true,
  minNote: 21,
  maxNote: 108,
  secondsVisible: 6,
  keyboardHeight: 0.19,
  overlayKeyboard: true,
  overlayNoteOpacity: 0.6,
  overlayKeyboardOpacity: 0.18,
  audioSampleRate: 44100,
  customColor: '#7ee5d2',
  useCustomColor: false,
  hitStrength: 0.35,
});
const ranges = {
  glow: [0, 1],
  secondsVisible: [2, 15],
  keyboardHeight: [0.08, 0.35],
  overlayNoteOpacity: [0, 1],
  overlayKeyboardOpacity: [0, 1],
  hitStrength: [0, 1],
};
export function normalizeSettings(patch = {}, previous = DEFAULT_SETTINGS) {
  const result = { ...DEFAULT_SETTINGS, ...previous };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return result;
  for (const [key, choices] of Object.entries({
    theme: ['aurora', 'amber', 'violet'],
    background: ['dark', 'transparent'],
    direction: ['up', 'down'],
    audioSampleRate: [44100, 48000],
  })) {
    if (choices.includes(patch[key])) result[key] = patch[key];
  }
  for (const key of ['particles', 'keyboard', 'labels', 'overlayKeyboard', 'useCustomColor'])
    if (typeof patch[key] === 'boolean') result[key] = patch[key];
  for (const [key, [min, max]] of Object.entries(ranges))
    if (Number.isFinite(patch[key])) result[key] = Math.min(max, Math.max(min, patch[key]));
  if (typeof patch.customColor === 'string' && /^#[\da-f]{6}$/i.test(patch.customColor))
    result.customColor = patch.customColor.toLowerCase();
  if (
    Number.isInteger(patch.minNote) &&
    Number.isInteger(patch.maxNote) &&
    patch.minNote >= 0 &&
    patch.maxNote <= 127 &&
    patch.maxNote > patch.minNote
  ) {
    result.minNote = patch.minNote;
    result.maxNote = patch.maxNote;
  }
  return result;
}
export function visualSettings(settings) {
  const result = normalizeSettings(settings);
  delete result.audioSampleRate;
  return result;
}
export function noteLabel(note) {
  return (
    ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][note % 12] +
    (Math.floor(note / 12) - 1)
  );
}
