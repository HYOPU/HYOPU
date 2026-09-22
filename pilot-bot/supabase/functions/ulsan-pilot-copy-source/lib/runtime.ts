import { database,Meter } from '../../ulsan-pilot-watcher/lib/runtime.ts';
import type { Config } from '../../ulsan-pilot-watcher/lib/runtime.ts';
import { sha256 } from '../../ulsan-pilot-watcher/lib/source.ts';
import { openSession } from '../../ulsan-pilot-watcher/lib/hyopuSource.ts';
import { PilotRegistrationClient } from '../../_shared/pilot-registration/client.ts';
import { readCopySource } from '../../_shared/pilot-registration/copy.ts';
import { pilotSeal } from '../../_shared/pilot-registration/crypto.ts';
import type { PilotRegistrationSettings } from '../../telegram-webhook/lib/registration.ts';
export function createCopySourceHandler(config:Config&{registration:PilotRegistrationSettings},fetcher:typeof fetch=fetch){
 return async(req:Request)=>{
  const key=req.headers.get('x-watcher-key')??'';
  if(req.method!=='POST')return new Response(null,{status:405});
  if(config.watcherKey.length<32||key.length>512||await sha256(key)!==await sha256(config.watcherKey))return new Response(null,{status:401});
  const rpc=database(config,new Meter(),fetcher);
  const jobs=await rpc<any[]>('pilot_copy_claim',{},12000);
  if(jobs.length){
   const ctx=await rpc<any>('pilot_reg_context',{},14000);
   const source=new PilotRegistrationClient({...config.registration,createEnabled:false,updateEnabled:false},fetcher,ctx.sealed_session?await openSession(ctx.sealed_session,config.registration.sessionKey):[]);
   for(const job of jobs.slice(0,2))try{
    await source.authenticate(job.metadata.pilot_date);
    const ref=await readCopySource(source,job,config.registration.sessionKey);
    await rpc('pilot_copy_store',{p_id:job.id,p_fingerprint:job.fingerprint,p_hash:ref.hash,
     p_sealed:await pilotSeal({version:1,fields:ref.fields},config.registration.sessionKey,'copy:'+job.id),p_at:ref.observedAt,p_token:job.token});
   }catch(error){const code=error instanceof Error&&/^[A-Z_0-9]{1,80}$/.test(error.message)?error.message:'COPY_READ_FAILED';await rpc('pilot_copy_fail',{p_id:job.id,p_token:job.token,p_error:code});}
  }
  await rpc('pilot_copy_cleanup');return new Response(null,{status:204});
 };
}
