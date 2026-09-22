// Read-only contract inspection. Credentials accepted through stdin only.
// No application create/update/cancel path is permitted. No HTML/cookies stored.
import {parse} from 'parse5';
const all=(n,name)=>[...(n.nodeName===name?[n]:[]),...(n.childNodes??[]).flatMap(x=>all(x,name))];
const attr=(n,name)=>n.attrs?.find(x=>x.name===name)?.value??'';
const text=n=>['script','style','#comment'].includes(n.nodeName)?'':n.value??(n.childNodes??[]).map(text).join(' ');
const clean=s=>s.replace(/\s+/gu,' ').trim();
const cells=n=>(n.childNodes??[]).filter(x=>['td','th'].includes(x.nodeName));
let input='';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
for await(const chunk of process.stdin){input+=chunk;if(/[\r\n]/.test(input))break;}
if(process.stdin.isTTY)process.stdin.setRawMode(false);
const traces=[];
try{
 const config=JSON.parse(input);input='';
 if(!config.username||!config.password||!['https','http-approved'].includes(config.transport))throw Error('PROBE_CONFIG');
 const origin=config.transport==='http-approved'?'http://www.ulsanpilot.co.kr':'https://www.ulsanpilot.co.kr';
 const paths=['/crew/member/login.php','/crew/member/login_check.php','/crew/sub01/sub02_01.php'];
 const jar=new Map();
 async function request(path,body){
  if(!paths.includes(path))throw Error('READ_ONLY_PATH');
  const headers={Accept:'text/html'};
  if(body)headers['Content-Type']='application/x-www-form-urlencoded';
  if(jar.size)headers.Cookie=[...jar].map(([k,v])=>`${k}=${v}`).join('; ');
  const r=await fetch(origin+path,{method:body?'POST':'GET',headers,body,redirect:'manual',signal:AbortSignal.timeout(15000)});
  for(const cookie of r.headers.getSetCookie()){
   const [pair,...parts]=cookie.split(';');const i=pair.indexOf('=');
   if(i<1||parts.some(x=>/^\s*domain=/i.test(x)&&!/^\s*domain=\.?((www\.)?ulsanpilot\.co\.kr)\s*$/i.test(x)))throw Error('COOKIE_DOMAIN');
   if(parts.some(x=>/^\s*secure\s*$/i.test(x))&&origin.startsWith('http:'))throw Error('COOKIE_SECURE');
   jar.set(pair.slice(0,i),pair.slice(i+1));
  }
  const loc=r.headers.get('location');
  if(loc&&new URL(loc,origin+path).origin!==origin)throw Error('REDIRECT_HOST');
  if(!r.ok&&r.status!==302)throw Error('HTTP_'+r.status);
  const reader=r.body?.getReader();const chunks=[];let size=0;
  if(reader)while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>2000000){await reader.cancel();throw Error('BODY_LIMIT');}chunks.push(p.value);}
  const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  traces.push({path,method:body?'POST':'GET',status:r.status,bytes:size,redirect:loc?new URL(loc,origin).pathname:null});
  return new TextDecoder('utf-8',{fatal:true}).decode(data);
 }
 const login=await request(paths[0]);const doc=parse(login);
 const forms=all(doc,'form').filter(n=>attr(n,'name')==='login_frm');
 if(forms.length!==1||attr(forms[0],'method').toLowerCase()!=='post'||new URL(attr(forms[0],'action'),origin+paths[0]).pathname!==paths[1])throw Error('LOGIN_FORM');
 const inputs=all(forms[0],'input');
 if(!['l_id','l_pw'].every(name=>inputs.some(n=>attr(n,'name')===name)))throw Error('LOGIN_FIELDS');
 if(/g-recaptcha|h-captcha|cf-chl-/i.test(login))throw Error('LOGIN_CHALLENGE');
 const body=new URLSearchParams(inputs.filter(n=>attr(n,'type')==='hidden').map(n=>[attr(n,'name'),attr(n,'value')]));
 body.set('l_id',config.username);body.set('l_pw',config.password);
 const auth=await request(paths[1],body);
 if(/alert\s*\(/i.test(auth)||!jar.size)throw Error('LOGIN_REJECTED');
 const today=config.start??new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 const end=config.end??new Date(Date.parse(today+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(today)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||today>end)throw Error('PROBE_RANGE');
 const html=await request(paths[2],new URLSearchParams({s_dt_ships:today.replaceAll('-',''),s_dt_shipe:end.replaceAll('-',''),s_tm_ship_f:'00',s_tm_ship_t:'23'}));
 if(!/<\/body\s*>[\s\S]*<\/html\s*>/i.test(html))throw Error('INCOMPLETE_LIST');
 const root=parse(html);if(all(root,'form').some(n=>attr(n,'name')==='login_frm'))throw Error('SESSION_EXPIRED');
 const tables=all(root,'table').filter(n=>{const h=all(n,'tr')[0];return h&&cells(h).length===29&&clean(text(cells(h)[11]))==='C/SIGN';});
 if(tables.length!==1)throw Error('APPLICATION_TABLE');
 const rows=all(tables[0],'tr');
 const header=cells(rows[0]).map(n=>clean(text(n)));
 const values=rows.slice(1).filter(n=>cells(n).length===29).map(n=>{
  const c=cells(n).map(x=>clean(text(x)));const links=all(n,'a').map(x=>attr(x,'href')).filter(x=>x.includes('sub02_03.php?'));
  const params=links.length===1?new URL(links[0],origin+paths[2]).searchParams:null;
  return{state:c[1],date:c[4],time:c[5],vessel:c[6],callsign:c[11],from:c[15],to:c[16],agency:c[21],mooring:c[23],application_id:params?.get('no_forecast')??null,agency_code:params?.get('s_cd_partner')??null};
 });
 const partner=all(root,'input').filter(n=>['cd_partner','ln_partner','s_cd_partner','s_dt_ships','s_dt_shipe'].includes(attr(n,'name'))).map(n=>({name:attr(n,'name'),value:attr(n,'value')}));
 const on=clean(text(root)).match(/.{0,35}\bON\b.{0,15}/)?.[0]??null;
 console.log(JSON.stringify({ok:true,observedAt:new Date().toISOString(),transport:config.transport,loginFields:inputs.map(n=>({name:attr(n,'name'),type:attr(n,'type')})),cookieNames:[...jar.keys()],accountIndicator:on,range:{start:today,end},partner,header,rows:values,traces}));
}catch(error){console.log(JSON.stringify({ok:false,error:error instanceof Error&&/^[A-Z_0-9]+$/.test(error.message)?error.message:'PROBE_FAILED',traces}));process.exitCode=1;}
