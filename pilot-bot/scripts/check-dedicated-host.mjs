// Bounded approved read-only source probe (records probe usage, sends no alerts).
import { spawn } from 'node:child_process';
const project='nhujqbqygnhbnvmfmodi';
const raw=await new Promise((resolve,reject)=>{
 const p=spawn('pnpm.cmd',['dlx','supabase@2.117.0','db','query','--linked','--project-ref',project,'--file','scripts/read-jstt-key.sql','--output','json'],{shell:true,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let out='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',()=>{});p.on('error',()=>reject(Error('CLI_FAILED')));p.on('close',c=>c===0?resolve(out):reject(Error('CLI_FAILED')));
});
const key=JSON.parse(raw).rows?.[0]?.key;if(typeof key!=='string'||key.length<32)throw Error('KEY_MISSING');
const response=await fetch('https://hyopu-pilot-bot.vercel.app/api/hpbot-jstt',{method:'POST',headers:{'Content-Type':'application/json','x-jstt-key':key},body:JSON.stringify({probe:true}),signal:AbortSignal.timeout(55000),redirect:'error'});
const body=await response.text();if(body.length>10000)throw Error('RESPONSE_TOO_LARGE');
let data;try{data=JSON.parse(body);}catch{data={parseable:false};}
console.log(JSON.stringify({status:response.status,accepted:data.accepted,error:data.error,skip:data.skip,window:data.window,quality:data.quality,estimated_bytes:data.estimated_bytes,duration_ms:data.duration_ms,hyopu:data.hyopu}));
if(!response.ok)process.exitCode=1;
