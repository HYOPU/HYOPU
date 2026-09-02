const { json, configured, backend, sameOrigin, memberForToken, sessionCookie, authorize } = require('../lib/workspace-auth');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET','POST'].includes(req.method)) return json(res,405,{error:'Method not allowed'});
  try {
    if (req.method === 'POST' && !sameOrigin(req)) return json(res,403,{error:'요청 출처를 확인할 수 없습니다.'});
    if (req.method === 'POST' && req.body?.action === 'logout') { res.setHeader('Set-Cookie',sessionCookie('',0)); return json(res,200,{signedOut:true}); }
    if (!configured()) return json(res, req.method === 'GET' ? 200 : 503, {configured:false,authenticated:false,error:'운영 Supabase 연결 설정이 필요합니다.'});
    if (req.method === 'GET') {
      const health = await Promise.all([backend('/rest/v1/hyopu_port_calls?select=id&limit=0'),backend('/rest/v1/hyopu_members?select=user_id&limit=0')]);
      if (health.some(result=>!result.ok)) return json(res,200,{configured:true,ready:false,authenticated:false,error:'선박 업무 저장·담당자 테이블 설정이 필요합니다.'});
      if (!String(req.headers?.cookie || '').includes('hyopu_session=')) return json(res,200,{configured:true,ready:true,authenticated:false});
      const member = await authorize(req,res);
      if (!member) return;
      return json(res,200,{configured:true,ready:true,authenticated:true,member});
    }
    const {email,password,action} = req.body || {};
    if (action !== 'login' || typeof email !== 'string' || email.length>254 || typeof password!=='string' || !password || password.length>1024) return json(res,400,{error:'이메일과 비밀번호를 확인해 주세요.'});
    const result = await backend('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})});
    if (!result.ok) return json(res,result.status===429?429:401,{error:result.status===429?'로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요.':'로그인 정보를 확인해 주세요.'});
    const session=await result.json();
    const member=await memberForToken(session.access_token);
    if (!member) return json(res,403,{error:'HYOPU 담당자로 등록되지 않은 계정입니다.'});
    res.setHeader('Set-Cookie',sessionCookie(session.access_token,Math.min(session.expires_in||3600,3600)));
    return json(res,200,{authenticated:true,member});
  } catch { return json(res,502,{saved:false,error:'업무 공간 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.'}); }
};
