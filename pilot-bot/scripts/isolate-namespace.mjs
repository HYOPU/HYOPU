// Mechanical isolation: bot RPCs must not share the existing portal's hyopu_* ACL scope.
import {readFile,writeFile,readdir,rename} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const replace=s=>s.replace(/_hyopu_/g,'_hpbot_').replace(/\bhyopu_(?!ulsan_pilot_20260922_bot\b)/g,'hpbot_');
let changed=0;
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){
 if(e.name.startsWith('.')||e.name==='node_modules')continue;
 const path=join(dir,e.name);if(e.isDirectory()){await walk(path);continue;}
 if(!/\.(ts|mjs|js|sql)$/.test(e.name))continue;
 const text=await readFile(path,'utf8'),next=replace(text);
 if(text!==next){await writeFile(path,next);changed++;}
 if(e.name.includes('_hyopu_'))await rename(path,join(dir,e.name.replace('_hyopu_','_hpbot_')));
}}
for(const dir of ['supabase','tests','api'])await walk(join(root,dir));
console.log(JSON.stringify({changed,namespace:'hpbot_',existingPortalUntouched:true}));
