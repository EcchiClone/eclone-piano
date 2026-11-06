import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectPaths } from '../shared/paths.cjs';

const { root } = projectPaths();
let checked = 0;
async function check(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await check(file);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        console.error(result.stderr);
        process.exit(1);
      }
      checked++;
    }
  }
}
for (const directory of ['desktop', 'public', 'server', 'shared', 'scripts', 'tests']) {
  await check(path.join(root, directory));
}
console.log(`Syntax checked ${checked} JavaScript files.`);
