import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DELAY_MS, DEFAULT_ENDPOINT, fingerprint, isXlsx, parseArgs, resolveFile, syncEtaFile, watchEtaFile } from '../scripts/eta-local-sync.mjs';

test('local ETA sync parses safe command options', () => {
  assert.deepEqual(parseArgs(['--once', '--file', 'C:/ETA.xlsx']), { file: 'C:/ETA.xlsx', endpoint: DEFAULT_ENDPOINT, delayMs: DEFAULT_DELAY_MS, watch: false });
  assert.deepEqual(parseArgs(['--watch', '--delay', '60']).delayMs, 60_000);
  assert.throws(() => parseArgs(['--bad']), /알 수 없는 옵션/);
});

test('local ETA sync requires a zip-based workbook and stable source path', () => {
  const workbook = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]);
  assert.equal(isXlsx(workbook), true);
  assert.equal(isXlsx(Buffer.from('not-a-workbook')), false);
  assert.equal(fingerprint(workbook), fingerprint(Buffer.from(workbook)));
  assert.equal(resolveFile({ file: '' }, { HYOPU_ETA_SOURCE_FILE: 'C:/ETA.xlsx' }), 'C:/ETA.xlsx');
});

test('local ETA watcher ignores neighboring OneDrive files', () => {
  let count = 0;
  const file = fileURLToPath(new URL('./fixtures/betula.txt', import.meta.url));
  const result = watchEtaFile({ file, delayMs: 5_000, onChange: () => { count += 1; } });
  result.schedule('other.xlsx');
  assert.equal(count, 0);
  result.watcher.close();
});

test('local ETA sync sends one validated workbook and skips its unchanged hash', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hyopu-eta-'));
  const file = path.join(directory, 'KOREA ETA UPDATE.xlsx');
  const statePath = path.join(directory, 'state.json');
  await fs.writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]));
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ synced: true, sourceRows: 42, changed: 3 }) };
  };
  try {
    const first = await syncEtaFile({ file, token: 'test-token', statePath, fetchImpl, stableDelayMs: 1 });
    const second = await syncEtaFile({ file, token: 'test-token', statePath, fetchImpl, stableDelayMs: 1 });
    assert.equal(first.changed, 3); assert.equal(second.skipped, true); assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token');
    assert.match(JSON.parse(requests[0].options.body).$content, /^UEs/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
