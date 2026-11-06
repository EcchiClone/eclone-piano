import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectPaths } from '../../shared/paths.cjs';

test('source mode preserves existing recordings and dotnet invocation', () => {
  const root = path.resolve('source with spaces');
  const paths = projectPaths(root);
  assert.equal(paths.recordings, path.join(root, 'recordings'));
  assert.equal(paths.audioCommand, 'dotnet');
  assert.deepEqual(paths.audioArgs, [paths.audioHelper]);
  assert.equal(paths.ffmpeg, 'ffmpeg');
  assert.equal(paths.bundled, false);
});
test('packaged mode uses real resources and user data outside the read-only archive', () => {
  const root = path.resolve('Install Folder/resources/app.asar');
  const resourcesPath = path.resolve('Install Folder/resources');
  const dataDir = path.resolve('사용자 데이터/recordings');
  const paths = projectPaths(root, { resourcesPath, dataDir });
  assert.equal(paths.recordings, dataDir);
  assert.equal(paths.audioCommand, path.join(resourcesPath, 'native/audio/ProcessAudio.exe'));
  assert.deepEqual(paths.audioArgs, []);
  assert.equal(paths.ffmpeg, path.join(resourcesPath, 'media/ffmpeg.exe'));
  assert.equal(paths.ffprobe, path.join(resourcesPath, 'media/ffprobe.exe'));
  assert.equal(paths.midiScript, path.join(resourcesPath, 'native/midi/midi-bridge.ps1'));
  for (const file of [paths.recordings, paths.audioHelper, paths.midiScript, paths.ffmpeg])
    assert.ok(!file.includes('app.asar'));
});
