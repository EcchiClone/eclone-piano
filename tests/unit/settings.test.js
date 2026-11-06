import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings, visualSettings } from '../../public/settings.js';
import {
  parseScene,
  sceneFile,
  loadScenes,
  saveScene,
  SCENE_STORAGE_KEY,
} from '../../public/presets.js';
import { themeFor, THEMES } from '../../public/engine.js';

test('custom ranges are atomic and invalid scene fields cannot escape their allowed types', () => {
  const previous = normalizeSettings({
    minNote: 43,
    maxNote: 80,
    customColor: '#AABBCC',
    useCustomColor: true,
  });
  assert.equal(previous.minNote, 43);
  assert.equal(previous.maxNote, 80);
  assert.equal(previous.customColor, '#aabbcc');
  const next = normalizeSettings(
    {
      minNote: 90,
      maxNote: 1,
      customColor: 'url(javascript:1)',
      glow: NaN,
      hitStrength: 5,
      keyboardHeight: -1,
      unknown: 5,
    },
    previous,
  );
  assert.equal(next.minNote, 43);
  assert.equal(next.maxNote, 80);
  assert.equal(next.customColor, '#aabbcc');
  assert.equal(next.hitStrength, 1);
  assert.equal(next.keyboardHeight, 0.08);
  assert.equal(next.unknown, undefined);
  assert.equal(normalizeSettings({ minNote: 0, maxNote: 127 }).maxNote, 127);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
});
test('scene round trip preserves visual choices without changing recording sample rate', () => {
  const settings = normalizeSettings({
    audioSampleRate: 48000,
    hitStrength: 0.7,
    minNote: 43,
    maxNote: 80,
    useCustomColor: true,
    customColor: '#ff8866',
    overlayKeyboardOpacity: 0.13,
  });
  const restored = parseScene(sceneFile('Night scene', settings));
  assert.deepEqual(restored.settings, visualSettings(settings));
  assert.equal(restored.settings.audioSampleRate, undefined);
  assert.equal(restored.settings.customColor, '#ff8866');
  assert.throws(() => parseScene(JSON.stringify({ version: 1, events: [] })), /장면 파일/);
  assert.throws(() => parseScene('a'.repeat(65537)), /64KB/);
});
test('scene library is bounded, permits explicit replacement and survives malformed storage', () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  data.set(SCENE_STORAGE_KEY, '{bad');
  assert.deepEqual(loadScenes(storage), []);
  for (let i = 0; i < 12; i++)
    saveScene(storage, { name: 'Scene ' + i, settings: { glow: i / 12 } });
  assert.throws(() => saveScene(storage, { name: 'Overflow', settings: {} }), /12개/);
  saveScene(storage, { name: 'Scene 0', settings: { hitStrength: 0.9 } });
  assert.equal(loadScenes(storage).length, 12);
  assert.equal(loadScenes(storage)[0].settings.hitStrength, 0.9);
  assert.throws(() => saveScene(storage, { name: '  ', settings: {} }), /이름/);
  assert.deepEqual(
    loadScenes({
      getItem() {
        throw new Error('blocked');
      },
    }),
    [],
  );
});
test('custom note palette accepts only six-digit colors and leaves built-in themes unchanged', () => {
  assert.equal(themeFor({ theme: 'amber' }), THEMES.amber);
  assert.equal(
    themeFor({ theme: 'violet', useCustomColor: true, customColor: 'invalid' }),
    THEMES.violet,
  );
  const theme = themeFor({ useCustomColor: true, customColor: '#ff8866' });
  assert.deepEqual(theme.main, [255, 136, 102]);
  assert.ok(theme.high.every((v) => v >= 0 && v <= 255));
});
