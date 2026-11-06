const path = require('node:path');

// Shared by the server, Electron and command-line tools; independent of cwd.
function projectPaths(root = path.resolve(__dirname, '..'), { resourcesPath, dataDir } = {}) {
  root = path.resolve(root);
  const bundled = !!resourcesPath;
  const nativeRoot = bundled ? path.join(resourcesPath, 'native') : path.join(root, 'native');
  const audioHelper = bundled
    ? path.join(nativeRoot, 'audio', 'ProcessAudio.exe')
    : path.join(nativeRoot, 'audio', 'bin', 'Release', 'net9.0-windows', 'ProcessAudio.dll');
  return {
    root,
    bundled,
    recordings: dataDir ? path.resolve(dataDir) : path.join(root, 'recordings'),
    midiScript: path.join(nativeRoot, 'midi', 'midi-bridge.ps1'),
    midiSource: path.join(nativeRoot, 'midi', 'MidiBridge.cs'),
    audioHelper,
    audioCommand: bundled ? audioHelper : 'dotnet',
    audioArgs: bundled ? [] : [audioHelper],
    ffmpeg: bundled ? path.join(resourcesPath, 'media', 'ffmpeg.exe') : 'ffmpeg',
    ffprobe: bundled ? path.join(resourcesPath, 'media', 'ffprobe.exe') : 'ffprobe',
  };
}

module.exports = { projectPaths };
