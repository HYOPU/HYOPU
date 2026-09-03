const { json, configured, backend } = require('../lib/workspace-auth');

// The operations board is a shared internal workspace. Authentication is not
// shown in the product; the browser only receives a readiness signal and every
// write is still restricted to same-origin JSON in the port-calls endpoint.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  try {
    if (!configured()) return json(res, 200, { configured: false, ready: false, shared: true, error: '운영 Supabase 연결 설정이 필요합니다.' });
    const health = await backend('/rest/v1/hyopu_port_calls?select=id&limit=0');
    if (!health.ok) return json(res, 200, { configured: true, ready: false, shared: true, error: '선박 업무 저장 테이블 설정이 필요합니다.' });
    return json(res, 200, { configured: true, ready: true, shared: true, member: { role: 'editor' } });
  } catch {
    return json(res, 502, { configured: true, ready: false, shared: true, error: '업무 공간 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
  }
};
