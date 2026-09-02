const json = (res, code, body) => res.status(code).json(body);
const configured = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
function headers(token = process.env.SUPABASE_SERVICE_ROLE_KEY) { return { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }; }
function backend(path, options = {}) { return fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}${path}`, { ...options, headers: { ...headers(), ...options.headers }, signal: AbortSignal.timeout(8000) }); }
function sameOrigin(req) {
  try { return new URL(req.headers?.origin).host === req.headers?.host && /^application\/json(?:;|$)/i.test(req.headers?.['content-type'] || ''); } catch { return false; }
}
async function memberForToken(token) {
  if (!token || token.length > 8192) return null;
  const response = await backend('/auth/v1/user', { headers: headers(token) });
  if (!response.ok) return null;
  const user = await response.json();
  if (!user.id || !user.email) return null;
  const members = await backend(`/rest/v1/hyopu_members?user_id=eq.${encodeURIComponent(user.id)}&select=user_id,pic,role&limit=1`);
  if (!members.ok) throw new Error('Workspace membership is not configured');
  const member = (await members.json())[0];
  return member ? { ...member, email: user.email } : null;
}
function sessionCookie(token, seconds = 3600) { return `hyopu_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`; }
async function authorize(req, res, write = false) {
  if (!configured()) { json(res, 503, { configured: false, saved: false, error: '공유 저장 설정이 필요합니다.' }); return null; }
  if (write && !sameOrigin(req)) { json(res, 403, { error: '다른 사이트에서 보낸 저장 요청은 허용하지 않습니다.' }); return null; }
  const cookie = String(req.headers?.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('hyopu_session='));
  let token; try { token = cookie ? decodeURIComponent(cookie.slice('hyopu_session='.length)) : ''; } catch { token = ''; }
  const member = await memberForToken(token);
  if (!member) { json(res, 401, { error: '승인된 담당자 계정으로 로그인해 주세요.' }); return null; }
  if (write && member.role !== 'editor') { json(res, 403, { error: '이 계정은 조회 권한만 있습니다.' }); return null; }
  return member;
}
module.exports = { json, configured, headers, backend, sameOrigin, memberForToken, sessionCookie, authorize };
