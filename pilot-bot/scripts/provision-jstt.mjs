// Read approved credentials from stdin; values never appear in CLI arguments/logs.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
let input='';if(process.stdin.isTTY)process.stdin.setRawMode(true);
for await(const c of process.stdin){input+=c;if(/[\r\n]/.test(input))break;}
if(process.stdin.isTTY)process.stdin.setRawMode(false);
const config=JSON.parse(input);input='';
if(config.user!=='hyopu'||typeof config.password!=='string'||!config.password||/[\r\n\0]/.test(config.password))throw Error('CONFIG_INVALID');
const project='nhujqbqygnhbnvmfmodi';
async function cli(pkg,args,stdin,cwd){return new Promise((resolve,reject)=>{
 const p=spawn('pnpm.cmd',['dlx',pkg,...args],{shell:true,windowsHide:true,cwd,stdio:['pipe','pipe','pipe']});
 let out='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',()=>{});p.stdin.end(stdin);p.on('error',()=>reject(Error('CLI_FAILED')));p.on('close',c=>c===0?resolve(out):reject(Error('CLI_FAILED')));
});}
const keys=JSON.parse(await cli('supabase@2.117.0',['projects','api-keys','--project-ref',project,'--output','json']));
const service=keys.find(k=>k.name==='service_role')?.api_key;
if(typeof service!=='string'||!service.startsWith('eyJ')||JSON.parse(Buffer.from(service.split('.')[1],'base64url')).ref!==project)throw Error('SERVICE_IDENTITY');
const key=randomBytes(32).toString('hex');
const values={HPBOT_SUPABASE_SERVICE_KEY:service,HPBOT_JSTT_USER_ID:config.user,HPBOT_JSTT_PASSWORD:config.password,HPBOT_JSTT_KEY:key,HPBOT_JSTT_ENABLED:'false'};
for(const [name,value] of Object.entries(values)){
 await cli('vercel@59.23.2',['env','add',name,'production','--sensitive','--yes'],value,resolve('..'));
 console.log(JSON.stringify({stored:name,project:'hyopu'}));
}
const r=await fetch(`https://${project}.supabase.co/rest/v1/rpc/hpbot_jstt_provision`,{method:'POST',headers:{apikey:service,Authorization:'Bearer '+service,'Content-Type':'application/json'},body:JSON.stringify({p_key:key}),signal:AbortSignal.timeout(15000)});
if(!r.ok)throw Error('VAULT_PROVISION_FAILED');
console.log(JSON.stringify({vaultConfigured:true,automatic:false}));
