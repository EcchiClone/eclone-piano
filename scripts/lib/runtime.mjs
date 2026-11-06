import fs from 'node:fs/promises';
import path from 'node:path';
import paths from '../../shared/paths.cjs';

const root = path.join(paths.projectPaths().root, '.runtime');
export const runtimePaths = {
  root,
  reports: path.join(root, 'reports'),
  screenshots: path.join(root, 'screenshots'),
  tmp: path.join(root, 'tmp'),
};

export async function prepareRuntime() {
  await Promise.all(
    Object.values(runtimePaths).map((directory) => fs.mkdir(directory, { recursive: true })),
  );
}
