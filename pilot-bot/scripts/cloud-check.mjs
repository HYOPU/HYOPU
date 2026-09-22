// Capture CLI credentials in memory; print only the bounded diagnostic result.
import {spawn} from 'node:child_process';
const project='nhujqbqygnhbnvmfmodi';
const raw=await new Promise((resolve,reject)=>{
 const p=spawn('pnpm.cmd',['dlx','supabase@2.117.0','projects','api-keys','--project-ref',project,'--output','json'],{shell:true,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let out='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',()=>{});p.on('error',()=>reject(Error('CLI_FAILED')));p.on('close',c=>c===0?resolve(out):reject(Error('CLI_FAILED')));
});
const keys=JSON.parse(raw);const key=keys.find(k=>k.name==='service_role')?.api_key;
if(typeof key!=='string'||!key.startsWith('eyJ'))throw Error('SERVICE_KEY_NOT_AVAILABLE');
const action=process.argv[2];
const setup=['vault','preview','collect','deliveryTest','webhook'].includes(action);
const r=await fetch(`https://${project}.supabase.co/functions/v1/${setup?'hyopu-pilot-setup':'hyopu-pilot-check'}`,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(setup?{action}:{inspectMigrations:process.argv.includes('--migrations')}),signal:AbortSignal.timeout(55000)});
const text=await r.text();if(text.length>16000)throw Error('RESPONSE_LIMIT');console.log(JSON.stringify({status:r.status,data:text?JSON.parse(text):null}));if(!r.ok)process.exitCode=1;
