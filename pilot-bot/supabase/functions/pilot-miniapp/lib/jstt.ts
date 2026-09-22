import { database,Meter } from '../../ulsan-pilot-watcher/lib/runtime.ts';
import { readBounded } from '../../ulsan-pilot-watcher/lib/source.ts';
import { isPilotRoomParticipant } from '../../_shared/pilotRoomAccess.ts';
import type { MiniConfig } from './runtime.ts';

/** Called only after initData, origin and fixed-room verification. No draft RPC. */
export async function handleJsttMini(config:MiniConfig,body:any,user:number,fetcher:typeof fetch,respond:(value:unknown,status?:number)=>Response){
 const chat=config.chatId,meter=new Meter(),rpc=database(config,meter,fetcher);
 const id=body.requestId;
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id??'')||!Number.isInteger(body.page??0)||(body.page??0)<0||(body.page??0)>999||typeof(body.search??'')!=='string'||(body.search??'').length>120)return respond({error:'JSTT_INPUT'},400);
 let reserved=false;
 try{
  reserved=await rpc<boolean>('jstt_ui_begin',{p_id:id,p_chat:chat,p_user:user});
  if(!reserved)return respond({error:'JSTT_LIMIT',message:'중복 요청·호출 제한 또는 JSTT 비용 보호 상태입니다.'},429);
  meter.limit=65536;
  const payload=JSON.stringify({chat_id:chat,user_id:user});meter.addRequest(payload,{'Content-Type':'application/json'});
  const r=await fetcher(`https://api.telegram.org/bot${config.botToken}/getChatMember`,{method:'POST',headers:{'Content-Type':'application/json'},body:payload,redirect:'error',signal:AbortSignal.timeout(6000)});
  const raw=await readBounded(r,8192);meter.addDatabaseResponse(raw.length);const role=JSON.parse(new TextDecoder().decode(raw));
  if(!r.ok||!role.ok||!isPilotRoomParticipant(role.result))return respond({error:'JSTT_MEMBER',message:'현재 방 참여자만 사용할 수 있습니다.'},403);
  let result:any;
  if(body.op==='jsttAdd'||body.op==='jsttRemove'){
   if(body.confirm!==true||typeof(body.vessel??'')!=='string'||typeof(body.agency??'')!=='string'||(body.vessel??'').length>120||(body.agency??'').length>120
     ||(body.op==='jsttRemove'&&!/^[a-f0-9-]{36}$/.test(body.watchId??'')))return respond({error:'JSTT_CONFIRM_REQUIRED'},400);
   result=await rpc('jstt_watch_change',{p_request:id,p_action:body.op==='jsttAdd'?'add':'remove',p_vessel:body.vessel??null,p_agency:body.agency??null,p_id:body.watchId??null});
   if(body.op==='jsttAdd'&&result.changed)result.refresh=await rpc('jstt_dispatch',{p_manual:true});
  }else if(body.op==='jsttRefresh')result={refresh:await rpc('jstt_dispatch',{p_manual:true})};
  else result=await rpc('jstt_read',{p_chat:chat,p_view:({jsttCurrent:'current',jsttWatchlist:'watchlist',jsttSearch:'search',jsttChanges:'changes'} as Record<string,string>)[body.op],p_page:body.page??0,p_search:body.search??'',p_reference:body.reference??null},24000);
  // Settlement counts response bytes plus the final RPC's conservative margin.
  meter.addRequest(JSON.stringify(result));
  return respond(result);
 }catch{return respond({error:'JSTT_UNAVAILABLE',message:'처리를 확인하지 못했습니다. 기존 감시목록과 도선신청은 보존됩니다.'},502);}
 finally{if(reserved&&!meter.uncertain)await rpc('jstt_settle',{p_id:id,p_bytes:meter.total+4096}).catch(()=>{});}
}
