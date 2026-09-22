// User-approved dedicated-host migration. Secrets only in stdin/process memory.
import { spawn } from 'node:child_process';
import { botProject } from './host-boundary.mjs';
const project='nhujqbqygnhbnvmfmodi',team='team_ekejdEba7MSlpEzvRUqDvLAR';
let input='';if(process.stdin.isTTY)process.stdin.setRawMode(true);
for await(const c of process.stdin){input+=c;if(/[\r\n]/.test(input))break;}
if(process.stdin.isTTY)process.stdin.setRawMode(false);
const credentials=JSON.parse(input);input='';
if(credentials.user!=='hyopu'||!credentials.password||/[\r\n\0]/.test(credentials.password))throw Error('INPUT_INVALID');
async function cli(pkg,args,stdin){return new Promise((resolve,reject)=>{
 const p=spawn('pnpm.cmd',['dlx',pkg,...args],{shell:true,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let out='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',()=>{});p.stdin.end(stdin);
 p.on('error',()=>reject(Error('CLI_START_FAILED')));p.on('close',c=>c===0?resolve(out):reject(Error('CLI_FAILED')));
});}
const vc=async(path,body)=>JSON.parse(await cli('vercel@59.23.2',['api',`"${path}"`,...(body?['--method','POST','--input','-']:[]),'--raw'],body?JSON.stringify(body):undefined));
const target=await vc(`/v9/projects/${botProject}?teamId=${team}`);
if(target.name!=='hyopu-pilot-bot'||target.accountId!==team)throw Error('WRONG_HOST');
console.log(JSON.stringify({verified:'hosting_target'}));
const keys=JSON.parse(await cli('supabase@2.117.0',['projects','api-keys','--project-ref',project,'--output','json']));
const service=keys.find(k=>k.name==='service_role')?.api_key;
if(!service||JSON.parse(Buffer.from(service.split('.')[1],'base64url')).ref!==project)throw Error('WRONG_DATABASE');
console.log(JSON.stringify({verified:'database_target'}));
const result=JSON.parse(await cli('supabase@2.117.0',['db','query','--linked','--project-ref',project,'--file','scripts/read-jstt-key.sql','--output','json']));
const secret=result.rows?.[0]?.key;
if(result.rows?.length!==1||typeof secret!=='string'||secret.length<32)throw Error('DISPATCH_KEY_UNAVAILABLE');
console.log(JSON.stringify({verified:'existing_dispatch_key'}));
const values={HPBOT_SUPABASE_SERVICE_KEY:service,HPBOT_JSTT_KEY:secret,HPBOT_JSTT_USER_ID:credentials.user,HPBOT_JSTT_PASSWORD:credentials.password,HPBOT_JSTT_ENABLED:'true'};
const existing=await vc(`/v9/projects/${botProject}/env?teamId=${team}`);
if(existing.envs.some(e=>e.key.startsWith('HPBOT_')))throw Error('TARGET_ALREADY_CONFIGURED');
console.log(JSON.stringify({verified:'empty_target_environment'}));
await vc(`/v10/projects/${botProject}/env?teamId=${team}`,Object.entries(values).map(([key,value])=>({key,value,type:'sensitive',target:['production']})));
const after=await vc(`/v9/projects/${botProject}/env?teamId=${team}`);
if(Object.keys(values).some(key=>!after.envs.some(e=>e.key===key&&e.type==='sensitive'&&e.target.includes('production'))))throw Error('ENV_VERIFICATION_FAILED');
console.log(JSON.stringify({stored:true,project:target.name,keys:Object.keys(values),portalKeysCopied:false,sourceSecretsChanged:false}));
