import { Meter, database } from '../../ulsan-pilot-watcher/lib/runtime.ts';
import type { Config } from '../../ulsan-pilot-watcher/lib/runtime.ts';
import { readBounded, sha256 } from '../../ulsan-pilot-watcher/lib/source.ts';
import { openSession } from '../../ulsan-pilot-watcher/lib/hyopuSource.ts';
import { drainPilotNotifications } from '../../ulsan-pilot-watcher/lib/hyopuRuntime.ts';
import { PilotRegistrationClient, pilotDate } from '../../_shared/pilot-registration/client.ts';
import { ADVISORY_POLICY } from '../../_shared/pilot-registration/eligibility.ts';
import { pilotOpen, pilotSeal } from '../../_shared/pilot-registration/crypto.ts';
import type { PilotDraft } from '../../_shared/pilot-registration/wizard.ts';
import type { PilotRegistrationSettings } from '../../telegram-webhook/lib/registration.ts';
import { isPilotRoomParticipant } from '../../_shared/pilotRoomAccess.ts';
import { assertCopyDraft, prepareCopy } from '../../_shared/pilot-registration/copy.ts';
import { registrationSuccessMessage, registrationFailureMessage } from './messages.ts';

export interface RegistrationWorkerConfig extends Config { registration:PilotRegistrationSettings; adminChats:string[] }
export function createRegistrationHandler(config:RegistrationWorkerConfig,fetcher:typeof fetch=fetch){
 return async(request:Request):Promise<Response>=>{
   if(request.method!=='POST')return new Response(null,{status:405});
   const key=request.headers.get('x-watcher-key')??'';
   if(config.watcherKey.length<32||key.length>512||await sha256(key)!==await sha256(config.watcherKey))return new Response(null,{status:401});
   let id:string;try{const body=JSON.parse(new TextDecoder().decode(await readBounded(new Response(request.body),256)));
     if(Object.keys(body).join(',')!=='request_id'||!/^[a-f0-9-]{36}$/.test(body.request_id))throw Error();id=body.request_id;
   }catch{return new Response(null,{status:400});}
   const rpc=database(config,new Meter(),fetcher);let claim:any;let uncertain=false;let draft:PilotDraft|undefined;
   try{
     claim=await rpc<any>('pilot_reg_claim',{p_id:id},120000);
     if(!claim)return new Response(null,{status:204});
     uncertain=claim.recovery;
     if(!config.adminChats.includes(claim.chat))throw Error('REG_CHAT_REVOKED');
     const checkAdmin=async()=>{
       const r=await fetcher(`https://api.telegram.org/bot${config.botToken}/getChatMember`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:claim.chat,user_id:claim.user}),redirect:'error',signal:AbortSignal.timeout(6000)});
       const v=JSON.parse(new TextDecoder().decode(await readBounded(r,8192)));
       if(!r.ok||!v.ok||!isPilotRoomParticipant(v.result))throw Error('REG_MEMBER_REVOKED');
     };
     const d=draft=await pilotOpen<PilotDraft>(claim.sealed_data,config.registration.sessionKey,id);
     const ctx=await rpc<any>('pilot_reg_context',{},14000);
     const cookies=ctx.sealed_session?await openSession(ctx.sealed_session,config.registration.sessionKey):[];
     const source=new PilotRegistrationClient(config.registration,fetcher,cookies);
     let fields,ids;
     if(claim.recovery){
       // Recovery can ONLY read. No route through prepare/submit exists here.
       if(!d.prepared)throw Error('REG_RECOVERY_EVIDENCE_MISSING');
       fields=d.prepared.fields;ids=d.prepared.baselineIds;
       await source.authenticate(pilotDate(fields));
     }else{
       await checkAdmin();
       if(config.registration.eligibilityPolicy===ADVISORY_POLICY&&d.eligibilityPolicy!==ADVISORY_POLICY)throw Error('REG_POLICY_REVIEW_REQUIRED');
       if(d.dryRun||d.step!=='review'||!(d.action==='CREATE'?config.registration.createEnabled:config.registration.updateEnabled))throw Error('REG_FEATURE_DISABLED');
       if(d.mode==='COPY'&&!config.registration.copyEnabled)throw Error('COPY_FEATURE_DISABLED');
       if(d.mode==='COPY')assertCopyDraft(d);
       const p=d.mode==='COPY'?await (async()=>{await source.authenticate(d.copy!.date);return prepareCopy(source,d,await rpc('pilot_copy_get',{p_id:d.copy!.sourceId},34000),config.registration.sessionKey);})():await source.prepare(d.action,d.fields,d.originalHash);
       fields=p.fields;ids=p.baseline.map(r=>r.application_id).filter((x):x is string=>x!==null);
       d.prepared={fields,baselineIds:ids,eligibilityPolicy:config.registration.eligibilityPolicy??'strict',eligibilityWarnings:p.eligibilityWarnings??[]};
       await checkAdmin(); // Fresh role check immediately before durable permit.
       uncertain=true; // Even an uncertain DB acknowledgement must not re-submit.
       const permitted=await rpc<boolean>('pilot_reg_submitting',{p_id:id,p_token:claim.token,p_sealed:await pilotSeal(d,config.registration.sessionKey,id)});
       if(!permitted){uncertain=false;throw Error('REG_PERMIT_REJECTED');}
       await source.submit(p,{requestId:id,status:'SUBMITTING'});
       await rpc('pilot_reg_verifying',{p_id:id,p_token:claim.token});
     }
     const row=await source.verify(d.action,fields,ids);
     const msg=registrationSuccessMessage(d,fields,row);
     const ok=await rpc<boolean>('pilot_reg_finish',{p_id:id,p_token:claim.token,p_status:'SUCCESS',p_row:row,p_message:msg});
     if(!ok)throw Error('REG_RECEIPT_UNCERTAIN');
   }catch(error){
     if(claim){const raw=error instanceof Error?error.message:'';const code=/^[A-Z_0-9]{1,80}$/.test(raw)?raw:'REG_EXTERNAL_UNCERTAIN';
       await rpc('pilot_reg_finish',{p_id:id,p_token:claim.token,p_status:uncertain?'UNKNOWN':'FAILED',p_error:code,
         p_message:registrationFailureMessage(id,code,uncertain,draft)}).catch(()=>{});
     }
   }
   await drainPilotNotifications(config,rpc,fetcher).catch(()=>{});
   return new Response(null,{status:204});
 };
}
