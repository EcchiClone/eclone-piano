import { visualSettings } from './settings.js';
export const SCENE_STORAGE_KEY = 'eclone.piano.scenes.v1';
export function parseScene(text) {
  if (typeof text !== 'string' || text.length > 65536)
    throw new Error('장면 파일은 64KB 이하로 선택하세요.');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('장면 JSON을 읽지 못했습니다.');
  }
  if (
    data?.type !== 'eclone-scene' ||
    data.version !== 1 ||
    !data.settings ||
    typeof data.settings !== 'object' ||
    Array.isArray(data.settings)
  )
    throw new Error('EClone Piano 장면 파일을 선택하세요. 연주 세션과는 다른 파일입니다.');
  return {
    name:
      String(data.name || '가져온 장면')
        .trim()
        .slice(0, 60) || '가져온 장면',
    settings: visualSettings(data.settings),
  };
}
export function sceneFile(name, settings) {
  return JSON.stringify(
    {
      type: 'eclone-scene',
      version: 1,
      name: name.trim().slice(0, 60),
      settings: visualSettings(settings),
    },
    null,
    2,
  );
}
export function loadScenes(storage) {
  try {
    const data = JSON.parse(storage.getItem(SCENE_STORAGE_KEY) || '[]');
    return Array.isArray(data)
      ? data
          .slice(0, 12)
          .filter(
            (s) =>
              typeof s?.name === 'string' &&
              s.name.trim() &&
              s.settings &&
              typeof s.settings === 'object',
          )
          .map((s) => ({ name: s.name.slice(0, 60), settings: visualSettings(s.settings) }))
      : [];
  } catch {
    return [];
  }
}
export function saveScene(storage, scene) {
  const scenes = loadScenes(storage);
  const name = scene.name.trim().slice(0, 60);
  if (!name) throw new Error('장면 이름을 입력하세요.');
  const index = scenes.findIndex((s) => s.name === name);
  if (index < 0 && scenes.length >= 12)
    throw new Error('장면은 12개까지 저장할 수 있어요. 사용하지 않는 장면을 먼저 지워 주세요.');
  const saved = { name, settings: visualSettings(scene.settings) };
  if (index < 0) scenes.push(saved);
  else scenes[index] = saved;
  storage.setItem(SCENE_STORAGE_KEY, JSON.stringify(scenes));
  return scenes;
}
