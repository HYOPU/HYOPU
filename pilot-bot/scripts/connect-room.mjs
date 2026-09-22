// Approved one-use local transport. Account secrets arrive via no-echo stdin,
// the new bot token via browser password input. Never log secret values.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
let input='';if(process.stdin.isTTY)process.stdin.setRawMode(true);
for await(const chunk of process.stdin){input+=chunk;if(/[\r\n]/.test(input))break;}
if(process.stdin.isTTY)process.stdin.setRawMode(false);
const account=JSON.parse(input);input='';
if(account.username!=='1002'||!account.password||account.chat!=='-5108887122')throw Error('TARGET_NOT_VERIFIED');
const project='nhujqbqygnhbnvmfmodi',bot='hyopu_ulsan_pilot_20260922_bot',nonce=randomUUID();let used=false;
const server=createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/html; charset=utf-8');
 res.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
 if(req.url!==`/${nonce}`){res.writeHead(404);return res.end();}
 if(req.method==='GET')return res.end(`<h1>협운 방 연결</h1><p>협운 도선봇 ${account.chat} / 협운 서버 ${project}</p><form method="POST"><label>새 협운 봇 토큰 <input name="token" type="password" autocomplete="off"></label><button>방 확인·계정 연결</button></form>`);
 if(req.method!=='POST'||used||req.headers.origin!==`http://127.0.0.1:${server.address().port}`){res.writeHead(403);return res.end();}
 let raw='',dir;
 try{
  for await(const part of req){raw+=part;if(raw.length>2048)throw Error('INPUT_LIMIT');}
  const token=new URLSearchParams(raw).get('token');
  if(!/^\d{6,12}:[A-Za-z0-9_-]{25,}$/.test(token??''))throw Error('TOKEN_FORMAT');
  const api=async(method,payload={})=>{const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});const data=await r.json();if(!r.ok||!data.ok)throw Error('TELEGRAM_CHECK_FAILED');return data.result;};
  const me=await api('getMe');if(me.username!==bot||me.id!==8480968321)throw Error('WRONG_BOT');
  const chat=await api('getChat',{chat_id:account.chat});
  if(chat.title!=='협운 도선봇'||!['group','supergroup'].includes(chat.type))throw Error('WRONG_ROOM');
  const count=await api('getChatMemberCount',{chat_id:chat.id});
  const member=await api('getChatMember',{chat_id:chat.id,user_id:me.id});
  const hook=await api('getWebhookInfo');if(hook.url)throw Error('EXISTING_WEBHOOK');
  used=true;
  const values={TELEGRAM_CHAT_ID:String(chat.id),TELEGRAM_ADMIN_CHAT_IDS:String(chat.id),ULSAN_PILOT_USERNAME:account.username,ULSAN_PILOT_PASSWORD:account.password,ULSAN_TRANSPORT:'http-approved'};
  dir=await mkdtemp(join(tmpdir(),'hyopu-room-'));const file=join(dir,'secrets.env');
  if(Object.values(values).some(v=>/[\r\n\0]/.test(v)))throw Error('SECRET_FORMAT');
  await writeFile(file,Object.entries(values).map(([k,v])=>k+'='+v).join('\n'),{flag:'wx',mode:0o600});
  await new Promise((resolve,reject)=>{const child=spawn('pnpm.cmd',['dlx','supabase@2.117.0','secrets','set','--project-ref',project,'--env-file',`"${file}"`],{shell:true,windowsHide:true,stdio:['ignore','ignore','ignore']});child.on('error',()=>reject(Error('CLI_START_FAILED')));child.on('close',code=>code===0?resolve():reject(Error('SECRET_STORE_FAILED')));});
  console.log(JSON.stringify({stored:true,project,chatId:chat.id,title:chat.title,type:chat.type,members:count,botRole:member.status,bot:me.username,webhookConnected:false}));
  res.end(`<h1>협운 방 확인·계정 저장 완료</h1><p>방: ${chat.title} / 참여 ${count}명 / 봇 권한: ${member.status}</p><p>협운 서버에 계정과 방 ID를 저장했습니다. 자동 수집·신청·수정·Webhook은 아직 켜지 않았습니다.</p>`);
 }catch(e){const code=/^[A-Z_]+$/.test(e.message)?e.message:'SETUP_FAILED';console.log(JSON.stringify({error:code}));res.writeHead(502);res.end(code);}
 finally{raw='';if(dir){await unlink(join(dir,'secrets.env')).catch(()=>{});await rmdir(dir).catch(()=>{});}}
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/${nonce}`})));
setTimeout(()=>server.close(),15*60*1000).unref();
