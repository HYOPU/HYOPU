const { json, configured: databaseConfigured, sameOrigin } = require('../lib/workspace-auth');
const { parseEtaWorkbook } = require('../lib/eta-source');
const { syncEtaRows } = require('../lib/eta-sync');

const MAX_BYTES = 10 * 1024 * 1024;

function asBuffer(body) {
  const encoded = typeof body === 'string' ? body : body?.$content;
  if (typeof encoded !== 'string' || !encoded.trim()) return null;
  const base64 = encoded.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return null;
  return Buffer.from(base64, 'base64');
}

// Shared workspace editors can run this only from the HYOPU page. The secret
// used by Power Automate never reaches the browser.
module.exports = async function handler(req, res) {
  res.setHeader?.('Cache-Control', 'no-store');
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (!sameOrigin(req)) return json(res, 403, { error: 'HYOPU 화면에서 선택한 파일만 반영할 수 있습니다.' });
  if (!databaseConfigured()) return json(res, 503, { error: 'Supabase 공유 저장 설정이 필요합니다.' });
  const buffer = asBuffer(req.body);
  if (!buffer?.length || buffer.length > MAX_BYTES || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    return json(res, 400, { error: '10MB 이하의 Excel(.xlsx) 파일을 선택해 주세요.' });
  }
  try {
    const result = await syncEtaRows(parseEtaWorkbook(buffer));
    return json(res, 200, { synced: true, ...result });
  } catch (error) {
    return json(res, 502, { error: error instanceof Error ? error.message : 'ETA 동기화에 실패했습니다.' });
  }
};
