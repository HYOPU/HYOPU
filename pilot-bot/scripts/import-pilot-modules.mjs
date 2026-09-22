// One-time mechanical port; source is read-only. Never import secrets or deployment settings.
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const target=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=resolve(process.argv[2]??'');
if(!process.argv[2] || source===target)throw Error('EXPLICIT_SOURCE_REQUIRED');
const files=[];
async function walk(path){for(const entry of await readdir(join(source,path),{withFileTypes:true})){
  if(entry.name.startsWith('.')||entry.name==='node_modules')continue;
  const item=path+'/'+entry.name;if(entry.isDirectory())await walk(item);else files.push(item);
}}
await walk('supabase/functions');files.push('supabase/config.toml');
for(const name of await readdir(join(source,'supabase/migrations')))if(/^2026092[012]\d+_(ulsan|dongjin|pilot|jstt)_.*\.sql$/.test(name))files.push('supabase/migrations/'+name);
for(const name of await readdir(join(source,'tests')))if(/^(ulsan|jsttBerth|pilotRoomAccess).*\.test\.ts$/.test(name))files.push('tests/'+name);
for(const name of ['app.js','boot.js','index.html','jstt.js','phone.js','time.js','style.css'])files.push('pilot-miniapp/'+name);
for(const name of ['_jstt_berth_browser.mjs','_jstt_berth_core.mjs','_jstt_berth_dates.mjs','_jstt_berth_query.mjs','_jstt_schedule_core.mjs','jstt_berth_watch.mjs'])files.push('api/'+name);
const manifest=[];
for(const path of files){
  const destPath=path.replaceAll('dongjin','hyopu').replaceAll('Dongjin','Hyopu');
  const dest=resolve(target,destPath);
  if(!dest.startsWith(target+'\\')&&!dest.startsWith(target+'/'))throw Error('OUTSIDE_PORT_ROOT');
  try{await access(dest);throw Error('DESTINATION_ALREADY_EXISTS:'+destPath);}catch(e){if(e.code!=='ENOENT')throw e;}
  const original=await readFile(join(source,path),'utf8');
  const ported=original.replaceAll('동진상운','협운해운').replaceAll('동진','협운')
    .replaceAll('dongjin','hyopu').replaceAll('Dongjin','Hyopu').replaceAll('DONGJIN','HYOPU')
    .replaceAll('2105','1002').replaceAll('ybkxpwqtgajpgggqczhb','nhujqbqygnhbnvmfmodi');
  await mkdir(dirname(dest),{recursive:true});await writeFile(dest,ported);
  manifest.push({source:path,target:destPath,sourceSha256:createHash('sha256').update(original).digest('hex'),targetSha256:createHash('sha256').update(ported).digest('hex')});
}
await writeFile(join(target,'PORT_MANIFEST.json'),JSON.stringify({note:'Candidate port, not deployed. HYOPU contracts require independent verification. No operating data imported.',files:manifest},null,2)+'\n');
console.log(JSON.stringify({files:files.length,deployed:false}));
