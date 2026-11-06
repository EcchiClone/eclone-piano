const path = require('node:path');

// Shared by the server, Electron and command-line tools; independent of cwd.
function projectPaths(root = path.resolve(__dirname, '..')) {
  root = path.resolve(root);
  return {
    root,
    recordings: path.join(root, 'recordings'),
    midiScript: path.join(root, 'native', 'midi', 'midi-bridge.ps1'),
    midiSource: path.join(root, 'native', 'midi', 'MidiBridge.cs'),
    audioHelper: path.join(
      root,
      'native',
      'audio',
      'bin',
      'Release',
      'net9.0-windows',
      'ProcessAudio.dll',
    ),
  };
}

module.exports = { projectPaths };
