const { json, configured: databaseConfigured, sameOrigin } = require('../lib/workspace-auth');
const { parseEtaClipboard } = require('../lib/eta-source');
const { syncEtaRows } = require('../lib/eta-sync');

const MAX_CHARS = 1024 * 1024;

module.exports = async function handler(req, res) {
  res.setHeader?.('Cache-Control', 'no-store');
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (!sameOrigin(req)) return json(res, 403, { error: 'HYOPU 화면에서 붙여넣은 ETA만 반영할 수 있습니다.' });
  if (!databaseConfigured()) return json(res, 503, { error: 'Supabase 공유 저장 설정이 필요합니다.' });
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_CHARS) {
    return json(res, 400, { error: 'Excel에서 복사한 ETA 표를 붙여넣어 주세요.' });
  }
  try {
    const result = await syncEtaRows(parseEtaClipboard(text));
    return json(res, 200, { synced: true, ...result });
  } catch (error) {
    return json(res, 502, { error: error instanceof Error ? error.message : 'ETA 동기화에 실패했습니다.' });
  }
};
