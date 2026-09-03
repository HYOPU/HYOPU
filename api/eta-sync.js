const crypto = require('crypto');
const { json, backend, configured: databaseConfigured } = require('../lib/workspace-auth');
const { configured: graphConfigured, missingConfig, readGraphEtaRows } = require('../lib/graph-eta');
const { key, callFromEta } = require('../lib/eta-source');
const { validateCall } = require('../lib/call-validation');

const stable = row => JSON.stringify([row.vessel, row.voyage, row.port, row.etaRaw, row.etdRaw, row.pic, row.status]);
const generatedId = row => `graph-eta-${crypto.createHash('sha256').update(key(row)).digest('hex').slice(0, 24)}`;
function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && req.headers?.authorization === `Bearer ${secret}`);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  if (!cronAuthorized(req)) return json(res, 401, { error: '예약 동기화 요청을 확인하지 못했습니다.' });
  if (!databaseConfigured()) return json(res, 503, { error: 'Supabase 공유 저장 설정이 필요합니다.' });
  if (!graphConfigured()) return json(res, 503, { error: `Microsoft Graph 설정이 필요합니다: ${missingConfig().join(', ')}` });
  try {
    const source = await readGraphEtaRows();
    const existingResponse = await backend('/rest/v1/hyopu_port_calls?select=id,data,revision&order=id.asc&limit=1000');
    if (!existingResponse.ok) return json(res, 502, { error: '기존 ETA 기록을 불러오지 못했습니다.' });
    const existingRows = await existingResponse.json();
    const existing = new Map(existingRows.map(row => [key(row.data), row]));
    const now = new Date().toISOString();
    const changes = [];
    for (const row of source) {
      const prior = existing.get(key(row));
      const call = callFromEta(row, prior?.data, prior?.id || generatedId(row));
      const error = validateCall(call);
      if (error) return json(res, 422, { error: `ETA 원본 행을 저장할 수 없습니다: ${error}` });
      if (!prior || stable(prior.data) !== stable(call)) changes.push({ id: call.id, data: call, revision: (prior?.revision || 0) + 1, updated_at: now });
    }
    if (changes.length) {
      const saved = await backend('/rest/v1/hyopu_port_calls?on_conflict=id', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(changes),
      });
      if (!saved.ok) return json(res, 502, { error: '동기화한 ETA 기록을 저장하지 못했습니다.' });
    }
    return json(res, 200, { synced: true, sourceRows: source.length, changed: changes.length, checkedAt: now });
  } catch (error) {
    return json(res, 502, { error: error instanceof Error ? error.message : 'ETA 동기화에 실패했습니다.' });
  }
};
