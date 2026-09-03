const crypto = require('crypto');
const { backend } = require('./workspace-auth');
const { key, callFromEta } = require('./eta-source');
const { validateCall } = require('./call-validation');

const sourceFields = row => JSON.stringify([row.vessel, row.voyage, row.port, row.etaRaw, row.etdRaw, row.pic, row.status]);
const generatedId = row => `flow-eta-${crypto.createHash('sha256').update(key(row)).digest('hex').slice(0, 24)}`;

async function syncEtaRows(source, request = backend, now = new Date().toISOString()) {
  if (!Array.isArray(source) || !source.length) throw new Error('동기화할 ETA 행이 없습니다.');
  const existingResponse = await request('/rest/v1/hyopu_port_calls?select=id,data,revision&order=id.asc&limit=1000');
  if (!existingResponse.ok) throw new Error('기존 ETA 기록을 불러오지 못했습니다.');
  const existingRows = await existingResponse.json();
  const existing = new Map(existingRows.map(row => [key(row.data), row]));
  const changes = [];
  for (const row of source) {
    const prior = existing.get(key(row));
    const call = callFromEta(row, prior?.data, prior?.id || generatedId(row));
    const error = validateCall(call);
    if (error) throw new Error(`ETA 원본 행을 저장할 수 없습니다: ${error}`);
    if (!prior || sourceFields(prior.data) !== sourceFields(call)) changes.push({ id: call.id, data: call, revision: (prior?.revision || 0) + 1, updated_at: now });
  }
  if (changes.length) {
    const saved = await request('/rest/v1/hyopu_port_calls?on_conflict=id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(changes),
    });
    if (!saved.ok) throw new Error('동기화한 ETA 기록을 저장하지 못했습니다.');
  }
  return { sourceRows: source.length, changed: changes.length, checkedAt: now };
}

module.exports = { syncEtaRows };
