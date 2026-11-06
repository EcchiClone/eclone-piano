import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectPaths } from '../../shared/paths.cjs';

const { root } = projectPaths();
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'))).version;
const dist = path.join(root, 'dist');
const sources = path.join(root, '.runtime', 'distribution', 'sources');
const sourceZip = path.join(dist, `EClone-Piano-${version}-ThirdParty-Sources.zip`);
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
await promisify(execFile)(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -LiteralPath ${quote(sources)} -DestinationPath ${quote(sourceZip)} -Force`,
  ],
  { windowsHide: true },
);
const files = [
  `EClone-Piano-${version}-Windows-x64-Setup.exe`,
  `EClone-Piano-${version}-Windows-x64.zip`,
  path.basename(sourceZip),
];
const hashes = [];
for (const file of files) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(dist, file))) hash.update(chunk);
  hashes.push(`${hash.digest('hex')}  ${file}`);
}
await fs.writeFile(path.join(dist, 'SHA256SUMS.txt'), hashes.join('\n') + '\n');
console.log(hashes.join('\n'));
