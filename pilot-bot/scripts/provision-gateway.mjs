import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const project='nhujqbqygnhbnvmfmodi';
async function cli(args){return new Promise((resolve,reject)=>{const p=spawn('pnpm.cmd',['dlx','supabase@2.117.0',...args],{shell:true,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',()=>{});p.on('error',()=>reject(Error('CLI_FAILED')));p.on('close',c=>c===0?resolve(out):reject(Error('CLI_FAILED')));});}
const keys=JSON.parse(await cli(['projects','api-keys','--project-ref',project,'--output','json']));
const key=keys.find(k=>k.name==='anon')?.api_key;
if(typeof key!=='string'||!key.startsWith('eyJ'))throw Error('LEGACY_GATEWAY_KEY_UNAVAILABLE');
const c=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString());
if(c.ref!==project||c.role!=='anon'||c.exp<Date.now()/1000)throw Error('WRONG_GATEWAY_KEY');
const dir=await mkdtemp(join(tmpdir(),'hyopu-gateway-')),file=join(dir,'secrets.env');
try{await writeFile(file,'ULSAN_GATEWAY_JWT='+key+'\n',{mode:0o600});await cli(['secrets','set','--project-ref',project,'--env-file',file]);console.log(JSON.stringify({stored:['ULSAN_GATEWAY_JWT'],project}));}finally{await unlink(file).catch(()=>{});await rmdir(dir).catch(()=>{});}
