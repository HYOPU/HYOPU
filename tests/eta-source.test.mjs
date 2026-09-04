import test from 'node:test';
import assert from 'node:assert/strict';
import etaSource from '../lib/eta-source.js';
import importHandler from '../api/eta-import.js';

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

test('ETA parsing stops at the end of the first contiguous table', () => {
  const source = [
    ...rows.slice(0, -1),
    [],
    [],
    ['S.SAGALAND', 'TPW 91 + TRAMP 92', 'ULSAN', '05/18 1130', 'ARRIVED', '05/18 1130', 'BRYAN'],
  ];
  const parsed = etaSource.parseEtaRows(source);
  assert.equal(parsed.length, 2);
  assert.ok(parsed.every(row => row.pic !== 'BRYAN'));
});

test('workbook import accepts only the first ETA UPDATE(SC포함) sheet', () => {
  const sourceSheet = rows.slice(0, -1);
  const fakeXlsx = {
    read: () => ({ SheetNames: ['ETA UPDATE(SC포함) ', 'ETA UPDATE'], Sheets: { 'ETA UPDATE(SC포함) ': sourceSheet, 'ETA UPDATE': [['wrong']] } }),
    utils: { sheet_to_json: sheet => sheet },
  };
  assert.equal(etaSource.parseEtaWorkbook(Buffer.from('workbook'), fakeXlsx).length, 2);
  fakeXlsx.read = () => ({ SheetNames: ['출항', 'ETA UPDATE(SC포함) '], Sheets: { '출항': sourceSheet, 'ETA UPDATE(SC포함) ': sourceSheet } });
  assert.throws(() => etaSource.parseEtaWorkbook(Buffer.from('workbook'), fakeXlsx), /첫 번째 ETA UPDATE\(SC포함\)/);
});

test('Excel clipboard table uses the same ETA parser without a saved workbook', () => {
  const pasted = `KOREA ETA UPDATE\r\nVessel\tVoy\tPort\tETA/Arrived\tRemark\tETD\tPIC\r\nS.PONDO\tPACS 116 + HBR 117\tULSAN\t08/21 0618\tINPORT\t09/03 2000\tDENNIS`;
  assert.deepEqual(etaSource.parseEtaClipboard(pasted), [
    { vessel: 'S.PONDO', voyage: 'PACS 116 + HBR 117', port: 'ULSAN', etaRaw: '08/21 0618', remark: 'INPORT', etdRaw: '09/03 2000', pic: 'DENNIS' },
  ]);
});

test('Power Automate ETA updates preserve vessel workspace details', () => {
  const [row] = etaSource.parseEtaRows(rows);
  const existing = { id: 'eta-2026-001', year: 2026, notes: 'Keep this', activityNotes: 'Agent called', proformaNotes: 'Keep draft limit', vcrFileName: '', latestReport: '', reportType: 'DEP.REPORT', reportReceived: '', reportChecked: false, activities: [], cargo: [], crew: [], tasks: [], sof: null, highlight: ['vessel'] };
  const call = etaSource.callFromEta(row, existing, existing.id);
  assert.equal(call.etdRaw, '09/03 2000');
  assert.equal(call.status, 'INPORT');
  assert.equal(call.notes, 'Keep this');
  assert.equal(call.proformaNotes, 'Keep draft limit');
  assert.deepEqual(call.highlight, ['vessel']);
});

test('ETA import rejects requests without the private Power Automate secret', async () => {
  const original = process.env.FLOW_SYNC_SECRET;
  delete process.env.FLOW_SYNC_SECRET;
  let result;
  await importHandler({ method: 'POST', headers: {}, body: Buffer.from('PK') }, { status(code) { result = { code }; return this; }, json(body) { result.body = body; return this; } });
  if (original === undefined) delete process.env.FLOW_SYNC_SECRET; else process.env.FLOW_SYNC_SECRET = original;
  assert.equal(result.code, 401);
  assert.match(result.body.error, /자동화 수신/);
});

test('ETA import rejects a wrong Office Script key without exposing the configured key', async () => {
  const original = process.env.FLOW_SYNC_SECRET;
  process.env.FLOW_SYNC_SECRET = 'configured-secret-value';
  let result;
  try {
    await importHandler({ method: 'POST', headers: { authorization: 'Bearer wrong-secret-value' }, body: { rows: [] } }, {
      status(code) { result = { code }; return this; },
      json(body) { result.body = body; return this; },
    });
    assert.equal(result.code, 401);
    assert.ok(!JSON.stringify(result).includes('configured-secret-value'));
  } finally {
    if (original === undefined) delete process.env.FLOW_SYNC_SECRET; else process.env.FLOW_SYNC_SECRET = original;
  }
});

test('Office Script preflight is limited to the authenticated ETA import endpoint', async () => {
  const result = { headers: {} };
  await importHandler({ method: 'OPTIONS', headers: {} }, {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.status = code; return this; },
    end() { result.ended = true; },
  });
  assert.equal(result.status, 204);
  assert.equal(result.headers['Access-Control-Allow-Origin'], '*');
  assert.match(result.headers['Access-Control-Allow-Headers'], /Authorization/);
});

test('an authenticated Office Script JSON table syncs through the existing Supabase path', async () => {
  const previous = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    secret: process.env.FLOW_SYNC_SECRET,
    fetch: global.fetch,
  };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-only-test-key';
  process.env.FLOW_SYNC_SECRET = 'office-script-test-secret';
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (!options.method) return { ok: true, json: async () => [] };
    return { ok: true, json: async () => ({}) };
  };
  const result = { headers: {} };
  try {
    await importHandler({
      method: 'POST',
      headers: { authorization: 'Bearer office-script-test-secret', 'content-type': 'application/json' },
      body: { rows: rows.slice(0, -1) },
    }, {
      setHeader(name, value) { result.headers[name] = value; },
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.synced, true);
    assert.equal(result.body.sourceRows, 2);
    assert.equal(result.body.changed, 2);
    assert.equal(result.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(requests.length, 2);
    assert.match(requests[1].url, /hyopu_port_calls/);
    assert.ok(!JSON.stringify(result).includes('server-only-test-key'));
  } finally {
    global.fetch = previous.fetch;
    for (const [name, value] of [['SUPABASE_URL', previous.url], ['SUPABASE_SERVICE_ROLE_KEY', previous.key], ['FLOW_SYNC_SECRET', previous.secret]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
