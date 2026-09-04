import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = fs.readFileSync(new URL('../office-scripts/hyopu-eta-sync.ts', import.meta.url), 'utf8');

async function compiledContext(fetchImpl) {
  const withTestKey = source.replace("const HYOPU_SYNC_KEY = 'PASTE_FLOW_SYNC_SECRET_HERE';", "const HYOPU_SYNC_KEY = 'office-script-test-key';");
  const compiled = await transform(withTestKey, { loader: 'ts', format: 'cjs', target: 'es2022' });
  const context = vm.createContext({ fetch: fetchImpl });
  new vm.Script(compiled.code).runInContext(context);
  return context;
}

const worksheet = (name, rows) => ({
  getName: () => name,
  getUsedRange: () => ({ getTexts: () => rows }),
});

test('Excel Online script sends only the first sheet contiguous ETA table with its dedicated key', async () => {
  const requests = [];
  const context = await compiledContext(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, text: async () => JSON.stringify({ synced: true, sourceRows: 1, changed: 1, hidden: 0 }) };
  });
  context.workbook = {
    getWorksheets: () => [
      worksheet('ETA UPDATE(SC포함) ', [
        ['KOREA ETA update'],
        ['Vessel','Voy','Port','ETA/Arrived','Remark','ETD','PIC'],
        ['S.CONFIDENCE','TPW 196','ULSAN','09/05 2300','','','JAE LEE'],
        [],
        [],
        ['S.SAGALAND','TPW 91 + TRAMP 92','ULSAN','05/18 1130','ARRIVED','05/18 1130','BRYAN'],
      ]),
      worksheet('출항', [['must not be read']]),
    ],
  };
  const message = await vm.runInContext('main(workbook)', context);
  assert.match(message, /1건 확인/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://hyopu-ten.vercel.app/api/eta-import');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer office-script-test-key');
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.rows.length, 2);
  assert.equal(body.rows[1][0], 'S.CONFIDENCE');
  assert.ok(!requests[0].options.body.includes('S.SAGALAND'));
});

test('Excel Online script refuses to read a matching sheet unless it is first', async () => {
  let requested = false;
  const context = await compiledContext(async () => { requested = true; });
  context.workbook = {
    getWorksheets: () => [
      worksheet('출항', [['Vessel','Voy','Port','ETA/Arrived','Remark','ETD','PIC']]),
      worksheet('ETA UPDATE(SC포함)', [['Vessel','Voy','Port','ETA/Arrived','Remark','ETD','PIC']]),
    ],
  };
  await assert.rejects(vm.runInContext('main(workbook)', context), /맨 앞 시트/);
  assert.equal(requested, false);
});
