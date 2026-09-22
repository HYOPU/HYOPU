// Service-role-only read-only cloud contract check. No registration writes or DB mutations.
import { UlsanReadClient } from '../ulsan-pilot-watcher/lib/hyopuSource.ts';
import { fetchForecast } from '../ulsan-pilot-watcher/lib/source.ts';
const env=(key:string)=>Deno.env.get(key)??'';
let next=0;
Deno.serve(async(req:Request)=>{
 // The Supabase gateway (verify_jwt=true) verifies this legacy JWT signature.
 // Service credentials can be rotated independently of injected environment
 // credentials, so authorize the signed role and project rather than equality.
 let claims:{role?:string;ref?:string;exp?:number}={};
 try{const token=(req.headers.get('authorization')??'').match(/^Bearer (eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1];if(token){const payload=token.split('.')[1];claims=JSON.parse(atob(payload.replaceAll('-','+').replaceAll('_','/')));}}catch{}
 if(req.method!=='POST'||claims.role!=='service_role'||claims.ref!=='nhujqbqygnhbnvmfmodi'||!claims.exp||claims.exp<=Date.now()/1000)return new Response(null,{status:401});
 if(env('SUPABASE_URL')!=='https://nhujqbqygnhbnvmfmodi.supabase.co'||env('ULSAN_PILOT_USERNAME')!=='1002')return Response.json({error:'WRONG_PROJECT_OR_ACCOUNT'},{status:503});
 if(Date.now()<next)return new Response(null,{status:429});next=Date.now()+60000;
 try{
  const telegram=async(method:string,payload:unknown={})=>{
   const r=await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
   const data=await r.json();if(!r.ok||!data.ok){if(Number.isSafeInteger(data.parameters?.migrate_to_chat_id))throw Error('CHAT_MIGRATED_'+data.parameters.migrate_to_chat_id);throw Error('TELEGRAM_'+method.toUpperCase()+'_FAILED');}return data.result;
  };
  const me=await telegram('getMe');if(me.id!==8480968321||me.username!=='hyopu_ulsan_pilot_20260922_bot')throw Error('WRONG_BOT');
  const operation=await req.json().catch(()=>({}));
  if(operation.inspectMigrations===true){const updates=await telegram('getUpdates',{limit:100,timeout:0});return Response.json({migrations:updates.filter((u:any)=>u.message?.migrate_to_chat_id||u.message?.migrate_from_chat_id).map((u:any)=>({chat:u.message.chat.id,title:u.message.chat.title,to:u.message.migrate_to_chat_id??null,from:u.message.migrate_from_chat_id??null}))});}
  const chat=await telegram('getChat',{chat_id:env('TELEGRAM_CHAT_ID')});
  const member=await telegram('getChatMember',{chat_id:chat.id,user_id:me.id});
  const count=await telegram('getChatMemberCount',{chat_id:chat.id});
  const webhook=await telegram('getWebhookInfo');
  const reader=new UlsanReadClient({username:env('ULSAN_PILOT_USERNAME'),password:env('ULSAN_PILOT_PASSWORD')},fetch,[],env('ULSAN_TRANSPORT')==='http-approved'?'http-approved':'https');
  const start=new Date(Date.now()+9*3600000-29*86400000).toISOString().slice(0,10);
  const apps=await reader.authenticatedApplications({start,end:'9999-12-31'});
  const forecast=await fetchForecast();
  const active=apps.filter(r=>r.completion_status==='ACTIVE').sort((a,b)=>(a.pilot_date+a.pilot_time+a.application_id).localeCompare(b.pilot_date+b.pilot_time+b.application_id));
  return Response.json({project:'nhujqbqygnhbnvmfmodi',bot:me.username,chat:{id:chat.id,title:chat.title,members:count,botRole:member.status,can_delete_messages:member.can_delete_messages??false,can_restrict_members:member.can_restrict_members??false,can_promote_members:member.can_promote_members??false},webhook:{url:webhook.url,pending:webhook.pending_update_count},
   source:{login:true,total:apps.length,completed:apps.filter(r=>r.completion_status==='COMPLETED').length,cancelled:apps.filter(r=>r.completion_status==='CANCELLED').length,active:active.length,rows:active.map((r,i)=>({sequence:i+1,application_id:r.application_id,vessel:r.vessel_name,date:r.pilot_date,time:r.pilot_time,from:r.from_location,to:r.to_location,status:r.application_status,mooring:r.mooring_name}))},
   forecast:{total:forecast.rows.length,agencyRows:forecast.rows.filter(r=>r.agent==='협운').length},
   secretPresence:Object.fromEntries(['TELEGRAM_BOT_TOKEN','TELEGRAM_WEBHOOK_SECRET','ULSAN_SESSION_KEY','ULSAN_WATCHER_KEY','ULSAN_OPERATOR_KEY'].map(k=>[k,env(k).length>=32])),
   flags:Object.fromEntries(['ULSAN_HYOPU_ENABLED','ULSAN_PILOT_REGISTRATION_ENABLED','ULSAN_PILOT_UPDATE_ENABLED','ULSAN_PILOT_COPY_REGISTRATION_ENABLED'].map(k=>[k,env(k)==='true'])),checked_at:new Date().toISOString(),writes:0
  });
 }catch(e){return Response.json({error:e instanceof Error&&/^[A-Z_0-9-]+$/.test(e.message)?e.message:'CHECK_FAILED'},{status:502});}
});
