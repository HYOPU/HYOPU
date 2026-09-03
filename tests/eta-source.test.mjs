import test from 'node:test';
import assert from 'node:assert/strict';
import etaSource from '../lib/eta-source.js';
import graphEta from '../lib/graph-eta.js';
import syncHandler from '../api/eta-sync.js';

const rows = [
  ['KOREA ETA update'],
  ['Vessel', 'Voy', 'Port', 'ETA/Arrived', 'Remark', 'ETD', 'PIC'],
  ['S.PONDO', 'PACS 116 + HBR 117', 'ULSAN', '08/21 0618', 'INPORT', '09/03 2000', 'DENNIS'],
  ['S.PERSEVERANCE', 'HBR 131', 'ULSAN', '08/26 1100', 'INPORT', '09/06 1400', 'JAE LEE'],
  ['RGDS / RICK', '', '', '', '', '', ''],
];

test('SharePoint ETA sheet parses canonical source rows only', () => {
  assert.deepEqual(etaSource.parseEtaRows(rows), [
    { vessel: 'S.PONDO', voyage: 'PACS 116 + HBR 117', port: 'ULSAN', etaRaw: '08/21 0618', remark: 'INPORT', etdRaw: '09/03 2000', pic: 'DENNIS' },
    { vessel: 'S.PERSEVERANCE', voyage: 'HBR 131', port: 'ULSAN', etaRaw: '08/26 1100', remark: 'INPORT', etdRaw: '09/06 1400', pic: 'JAE LEE' },
  ]);
});

test('SharePoint ETA updates preserve vessel workspace details', () => {
  const [row] = etaSource.parseEtaRows(rows);
  const existing = { id: 'eta-2026-001', year: 2026, notes: 'Keep this', activityNotes: 'Agent called', vcrFileName: '', latestReport: '', reportType: 'DEP.REPORT', reportReceived: '', reportChecked: false, activities: [], cargo: [], crew: [], tasks: [], sof: null, highlight: ['vessel'] };
  const call = etaSource.callFromEta(row, existing, existing.id);
  assert.equal(call.etdRaw, '09/03 2000');
  assert.equal(call.status, 'INPORT');
  assert.equal(call.notes, 'Keep this');
  assert.deepEqual(call.highlight, ['vessel']);
});

test('Graph client credentials uses the tenant-scoped token endpoint', async () => {
  const env = { GRAPH_TENANT_ID: 'tenant-id', GRAPH_CLIENT_ID: 'client-id', GRAPH_CLIENT_SECRET: 'secret' };
  let request;
  const token = await graphEta.accessToken(env, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ access_token: 'graph-token' }) };
  });
  assert.equal(token, 'graph-token');
  assert.match(request.url, /tenant-id\/oauth2\/v2\.0\/token$/);
  assert.equal(request.options.body.get('scope'), 'https://graph.microsoft.com/.default');
  assert.equal(request.options.body.get('grant_type'), 'client_credentials');
});

test('ETA sync denies untrusted requests before contacting Microsoft Graph', async () => {
  const original = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  let result;
  await syncHandler({ method: 'GET', headers: {} }, { status(code) { result = { code }; return this; }, json(body) { result.body = body; return this; } });
  if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original;
  assert.equal(result.code, 401);
  assert.match(result.body.error, /예약 동기화/);
});
