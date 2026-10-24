import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../server/index.js';

const runtime = path.resolve('.runtime');
await fs.mkdir(runtime, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(runtime, 'ui-data-'));
const server = await startServer({ port: 3221, dataDir });
try {
  process.env.LUMA_TEST_URL = 'http://127.0.0.1:3221';
  process.env.LUMA_UI_ISOLATED = '1';
  await import('./ui-smoke.mjs');
} finally {
  await server.close();
  if (!dataDir.startsWith(runtime + path.sep + 'ui-data-')) throw new Error('Unsafe test path');
  await fs.rm(dataDir, { recursive: true, force: true });
}
