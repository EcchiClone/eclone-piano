// Explicit release publishing; credentials stay in memory and are never logged.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { projectPaths } from '../../shared/paths.cjs';

if (!process.argv.includes('--publish'))
  throw new Error('Pass --publish after validating the Windows artifacts.');
const root = projectPaths().root;
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
if (git('status', '--porcelain'))
  throw new Error('Commit the validated release sources before publishing.');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'))).version;
const tag = 'v' + version;
const head = git('rev-parse', 'HEAD');
if (git('rev-parse', tag + '^{commit}') !== head) throw new Error('Release tag must match HEAD.');
const dist = path.join(root, 'dist');
const names = [
  `EClone-Piano-${version}-Windows-x64-Setup.exe`,
  `EClone-Piano-${version}-Windows-x64.zip`,
  `EClone-Piano-${version}-ThirdParty-Sources.zip`,
  'SHA256SUMS.txt',
];
const auth = spawnSync('git', ['credential', 'fill'], {
  cwd: root,
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
  windowsHide: true,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
});
if (auth.status !== 0) throw new Error('Existing GitHub Git credentials are unavailable.');
const credentials = Object.fromEntries(
  auth.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
if (!credentials.password) throw new Error('GitHub credential unavailable.');
const headers = {
  Authorization: `Bearer ${credentials.password}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'eclone-piano-release',
};
const base = 'https://api.github.com/repos/EcchiClone/eclone-piano';
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${body.message}`);
  return body;
}
const account = await request('https://api.github.com/user');
if (account.login !== 'EcchiClone') throw new Error('Unexpected GitHub account.');
const all = await request(base + '/releases?per_page=100');
let release = all.find((item) => item.tag_name === tag);
if (release && !release.draft)
  throw new Error('A published release already exists; do not overwrite it.');
if (!release)
  release = await request(base + '/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: head,
      name: `EClone Piano ${version} · Windows`,
      body: await fs.readFile(path.join(root, 'docs', 'releases', tag + '.md'), 'utf8'),
      draft: true,
      prerelease: false,
    }),
  });
const assets = await request(base + `/releases/${release.id}/assets`);
for (const name of names) {
  const file = path.join(dist, name),
    stat = await fs.stat(file),
    hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const digest = 'sha256:' + hash.digest('hex');
  let asset = assets.find((item) => item.name === name);
  if (!asset)
    asset = await request(release.upload_url.split('{')[0] + '?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: {
        'Content-Type': name.endsWith('.txt') ? 'text/plain' : 'application/octet-stream',
        'Content-Length': String(stat.size),
      },
      body: createReadStream(file),
      duplex: 'half',
      signal: AbortSignal.timeout(20 * 60 * 1000),
    });
  if (asset.size !== stat.size || (asset.digest && asset.digest !== digest))
    throw new Error('Remote asset mismatch: ' + name);
  console.log(
    JSON.stringify({ uploaded: name, bytes: asset.size, digest: asset.digest || digest }),
  );
}
release = await request(base + `/releases/${release.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ draft: false, make_latest: 'true' }),
});
console.log(
  JSON.stringify({ published: release.html_url, tag: release.tag_name, draft: release.draft }),
);
