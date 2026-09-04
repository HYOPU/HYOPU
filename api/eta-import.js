const crypto = require('crypto');
const { json, configured: databaseConfigured } = require('../lib/workspace-auth');
const { parseEtaRows, parseEtaWorkbook } = require('../lib/eta-source');
const { syncEtaRows } = require('../lib/eta-sync');

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_JSON_ROWS = 2000;
const MAX_JSON_COLUMNS = 32;
const MAX_JSON_CHARS = 2 * 1024 * 1024;
function authorized(req) {
  const secret = process.env.FLOW_SYNC_SECRET;
  const authorization = req.headers?.authorization;
  if (!secret || typeof authorization !== 'string') return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(authorization);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
function asBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const encoded = typeof body === 'string' ? body : body?.$content;
  if (typeof encoded !== 'string' || !encoded.trim()) return null;
  const base64 = encoded.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return null;
  return Buffer.from(base64, 'base64');
}
function asRows(body) {
  if (!Array.isArray(body?.rows) || !body.rows.length || body.rows.length > MAX_JSON_ROWS) {
    throw new Error(`ETA 행은 1~${MAX_JSON_ROWS}개여야 합니다.`);
  }
  let characters = 0;
  return body.rows.map(row => {
    if (!Array.isArray(row) || row.length > MAX_JSON_COLUMNS) throw new Error(`ETA 열은 ${MAX_JSON_COLUMNS}개 이하여야 합니다.`);
    return row.map(cell => {
      if (cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)) throw new Error('ETA 셀 값 형식이 올바르지 않습니다.');
      const value = String(cell ?? '');
      characters += value.length;
      if (value.length > 4096 || characters > MAX_JSON_CHARS) throw new Error('ETA 데이터가 허용 크기를 초과했습니다.');
      return value;
    });
  });
}
function setOfficeScriptHeaders(res) {
  res.setHeader?.('Access-Control-Allow-Origin', '*');
  res.setHeader?.('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader?.('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader?.('Cache-Control', 'no-store');
}

module.exports = async function handler(req, res) {
  setOfficeScriptHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (!authorized(req)) return json(res, 401, { error: '자동화 수신 요청을 확인하지 못했습니다.' });
  if (!databaseConfigured()) return json(res, 503, { error: 'Supabase 공유 저장 설정이 필요합니다.' });
  let source;
  try {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'rows')) source = parseEtaRows(asRows(req.body));
    else {
      const buffer = asBuffer(req.body);
      if (!buffer?.length || buffer.length > MAX_BYTES || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('10MB 이하의 Excel(.xlsx) 파일 또는 Office Script ETA 행을 전달해 주세요.');
      source = parseEtaWorkbook(buffer);
    }
  } catch (error) {
    return json(res, 400, { error: error instanceof Error ? error.message : 'ETA 입력 형식이 올바르지 않습니다.' });
  }
  try {
    const result = await syncEtaRows(source);
    return json(res, 200, { synced: true, ...result });
  } catch (error) {
    return json(res, 502, { error: error instanceof Error ? error.message : 'ETA 동기화에 실패했습니다.' });
  }
};
