// One-use loopback intake for the operator-approved HYOPU bot secret.
// Tokens and generated keys never appear in stdout or in the repository.
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const project = 'nhujqbqygnhbnvmfmodi';
const username = 'hyopu_ulsan_pilot_20260922_bot';
const nonce = randomUUID();
let used = false;
function execute(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm.cmd', ['dlx', 'supabase@2.117.0', ...args], { shell: true, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let out = '';
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', () => {});
    child.on('error', () => reject(Error('CLI_START_FAILED')));
    child.on('close', code => code === 0 ? resolve(out) : reject(Error('SECRET_STORE_FAILED')));
  });
}
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (req.url !== `/${nonce}`) { res.writeHead(404); return res.end(); }
  if (req.method === 'GET') return res.end(`<title>HYOPU private secret setup</title><h1>협운 봇 전용 서버 저장</h1><p>대상: ${project} / @${username}</p><p>동진 봇에는 접근하지 않습니다. 새 키는 서버에서 생성합니다.</p><form method="POST"><label>협운 봇 토큰 <input name="token" type="password" autocomplete="off" required></label><button type="submit">협운 Supabase에 저장</button></form>`);
  if (req.method !== 'POST' || used || req.headers.origin !== `http://127.0.0.1:${server.address().port}`) { res.writeHead(403); return res.end('REQUEST_DENIED'); }
  let body = '', dir;
  try {
    for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body)>2048) throw Error('INPUT_LIMIT'); }
    const token = new URLSearchParams(body).get('token') ?? '';
    if (!/^\d{6,12}:[A-Za-z0-9_-]{25,}$/.test(token)) throw Error('TOKEN_FORMAT');
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {signal:AbortSignal.timeout(15000)});
    const data = await response.json();
    if (!response.ok || !data.ok || data.result.username !== username || !data.result.is_bot) throw Error('BOT_IDENTITY_MISMATCH');
    // Only consume after verification. CLI uncertainty is surfaced, not retried.
    used = true;
    const secrets = {
      TELEGRAM_BOT_TOKEN:token, TELEGRAM_BOT_USERNAME:username,
      TELEGRAM_WEBHOOK_SECRET:randomBytes(32).toString('hex'),
      ULSAN_SESSION_KEY:randomBytes(32).toString('hex'),
      ULSAN_WATCHER_KEY:randomBytes(32).toString('hex'),
      ULSAN_OPERATOR_KEY:randomBytes(32).toString('hex'),
      ULSAN_HYOPU_ENABLED:'false',
      ULSAN_PILOT_REGISTRATION_ENABLED:'false', ULSAN_PILOT_UPDATE_ENABLED:'false', ULSAN_PILOT_COPY_REGISTRATION_ENABLED:'false',
      JSTT_BERTH_MONITOR_ENABLED:'false',
    };
    dir = await mkdtemp(join(tmpdir(),'hyopu-pilot-secrets-'));
    const file = join(dir,'secrets.env');
    await writeFile(file,Object.entries(secrets).map(([key,value])=>`${key}=${value}`).join('\n'),{mode:0o600,flag:'wx'});
    await execute(['secrets','set','--project-ref',project,'--env-file',`"${file}"`]);
    console.log(JSON.stringify({stored:true,project,bot:username,botId:data.result.id,secretNames:Object.keys(secrets),writesEnabled:false}));
    res.end('<h1>협운 전용 키 저장 확인</h1><p>새 봇 토큰·인증키·세션 암호화키를 협운 서버에 저장했습니다. 토큰은 화면에 표시하지 않습니다. 신청·수정·자동 수집은 아직 활성화하지 않았습니다.</p>');
  } catch(error) {
    const code=/^[A-Z_]+$/.test(error.message)?error.message:'SETUP_FAILED';
    console.log(JSON.stringify({stored:false,error:code})); res.writeHead(502); res.end(code);
  } finally { body=''; if(dir) { await unlink(join(dir,'secrets.env')).catch(()=>{}); await rmdir(dir).catch(()=>{}); } }
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/${nonce}`,project})));
setTimeout(()=>server.close(),15*60*1000).unref();
