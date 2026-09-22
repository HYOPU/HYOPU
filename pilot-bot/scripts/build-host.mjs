// Dedicated bot static output only. Never copy the sibling operations/SOF portal.
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBotHost, miniAppAssets } from './host-boundary.mjs';
assertBotHost(process.env);
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(resolve(root, 'dist/pilot-bot'), { recursive: true });
for (const name of miniAppAssets) {
  await copyFile(resolve(root, 'pilot-miniapp', name), resolve(root, 'dist/pilot-bot', name));
}
console.log(JSON.stringify({ module: 'hyopu-pilot-bot', assets: miniAppAssets.length, portalAssets: 0 }));
