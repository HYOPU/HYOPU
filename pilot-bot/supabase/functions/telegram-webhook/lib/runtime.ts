import { database, Meter } from '../../ulsan-pilot-watcher/lib/runtime.ts';
import type { Config } from '../../ulsan-pilot-watcher/lib/runtime.ts';
import { readBounded, sha256 } from '../../ulsan-pilot-watcher/lib/source.ts';
import { drainPilotNotifications } from '../../ulsan-pilot-watcher/lib/hyopuRuntime.ts';
import { parseCommand, parseCallback, adminCommands } from './commands.ts';
import { formatReply, mainMenu, kst } from './formatters.ts';
import { handleRegistrationUpdate, registrationMenuRows } from './registration.ts';
import type { PilotRegistrationSettings } from './registration.ts';
import { isPilotRoomParticipant } from '../../_shared/pilotRoomAccess.ts';
import { pilotDateTimeLabel } from '../../_shared/pilotDateTime.ts';
import { pilotSuspensionSummary } from '../../_shared/pilotSuspension.ts';
import { formatJstt,jsttMenu,jsttMiniUrl } from '../../_shared/jstt.ts';
export interface WebhookConfig extends Config { webhookSecret:string; adminChats:string[]; botUsername:string; gatewayJwt:string; registration?:PilotRegistrationSettings; miniAppEnabled?:boolean }
export async function telegramApi(config:Config,method:string,payload:unknown,fetcher:typeof fetch=fetch){
 const r=await fetcher(`https://api.telegram.org/bot${config.botToken}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(6000)});
 const data=JSON.parse(new TextDecoder().decode(await readBounded(r,16384)));
 if(!r.ok||!data.ok)throw new Error('TELEGRAM_API_REJECTED');return data.result;
}
export function createWebhook(config:WebhookConfig,fetcher:typeof fetch=fetch){
 return async(req:Request):Promise<Response>=>{
   if(req.method!=='POST')return new Response(null,{status:405});
   const header=req.headers.get('X-Telegram-Bot-Api-Secret-Token')??'';
   if(config.webhookSecret.length<32||header.length>256||await sha256(header)!==await sha256(config.webhookSecret))return new Response(null,{status:401});
   let update:any;try{update=JSON.parse(new TextDecoder().decode(await readBounded(new Response(req.body),65536)));}catch{return new Response(null,{status:400});}
   const cb=update.callback_query,m=cb?.message??update.message,from=cb?.from??m?.from;
   if(!Number.isSafeInteger(update.update_id)||!Number.isSafeInteger(from?.id)||from.is_bot||m?.sender_chat||!m?.chat?.id)return new Response(null,{status:200});
   const chat=String(m.chat.id);
   if(!config.adminChats.includes(chat))return new Response(null,{status:200});
   const regAdmin=async(c:string,u:number)=>{try{const member=await telegramApi(config,'getChatMember',{chat_id:c,user_id:u},fetcher);return isPilotRoomParticipant(member);}catch{return false;}};
   if(config.registration&&await handleRegistrationUpdate(config,update,fetcher,regAdmin,async(id)=>{await telegramApi(config,'answerCallbackQuery',{callback_query_id:id},fetcher);}))return new Response(null,{status:200});
   let command=cb?parseCallback(String(cb.data??'')):parseCommand(String(m.text??''),config.botUsername);
   if(!command)return new Response(null,{status:200});
   const rpc=database(config,new Meter(),fetcher);let accepted=false;
   try{
     accepted=await rpc<boolean>('hpbot_accept_update',{p_update:update.update_id,p_chat:chat,p_user:from.id,p_command:command.name,
       p_search:command.name==='search'&&!command.explicit?command.search??null:null});
     if(!accepted){await drainPilotNotifications(config,rpc,fetcher);return new Response(null,{status:200});}
     if(cb?.id)await telegramApi(config,'answerCallbackQuery',{callback_query_id:cb.id},fetcher).catch(()=>{});
     let text:string|undefined;let markup:any=mainMenu;
     if(command.name.startsWith('jstt_')){
       if(!await regAdmin(chat,from.id))text='⛔ 현재 방 참여자만 사용할 수 있습니다.';
       else{
         const view=command.name.slice(5);let refresh='';
         if(view==='refresh')refresh=String(await rpc('jstt_dispatch',{p_manual:true}));
         const data=await rpc<any>('jstt_read',{p_chat:chat,p_view:['current','watchlist','changes'].includes(view)?view:'current',p_page:command.page??0},24000);
         text=(refresh?({RUN:'🔄 새 조회를 시작했습니다. 아래는 마지막 수집 자료입니다.\n\n',JOINED:'🔄 이미 조회 중입니다.\n\n',COOLDOWN:'30초 후 다시 확인해 주세요.\n\n',RECENT:'방금 수집한 자료입니다.\n\n'} as Record<string,string>)[refresh]??'⏸ JSTT 조회가 중지되어 있습니다.\n\n':'')+formatJstt(data,view);
         const rows=[...jsttMenu.inline_keyboard];
         if(config.miniAppEnabled&&/^[A-Za-z0-9_]{5,32}$/.test(config.botUsername))rows.unshift([{text:'➕ 특정선박 추가 / ➖ 삭제 (인앱)',url:jsttMiniUrl(config.botUsername)}] as any);
         if(view!=='changes'&&data.total>10){const p=command.page??0;const paging:any[]=[];if(p>0)paging.push({text:'◀ 이전',callback_data:`v1:jstt:${view==='watchlist'?'watchlist':'current'}:${p-1}`});if((p+1)*10<data.total)paging.push({text:'다음 ▶',callback_data:`v1:jstt:${view==='watchlist'?'watchlist':'current'}:${p+1}`});rows.unshift(paging);}
         markup={inline_keyboard:rows};
       }
     }
     if(command.name==='search'&&(command.search||command.contextId)){
       const query=await rpc<string|null>('hpbot_search_context',{p_update:update.update_id,p_previous:command.contextId??null,p_query:command.search??null});
       if(!query)text='검색 버튼이 만료되었습니다. 선박명을 다시 입력해 주세요.';
       else command={...command,search:query,contextId:update.update_id};
     }
     if(adminCommands.has(command.name)){
       if(!await regAdmin(chat,from.id))text='⛔ 이 방의 현재 참여자만 사용할 수 있습니다. 참여 여부를 확인하지 못한 경우에도 실행하지 않습니다.';
     }
     if(!text&&['stop','resume'].includes(command.name)){
       const token=await rpc<string>('hpbot_prepare_confirmation',{p_update:update.update_id,p_action:command.name});
       text=`감시를 ${command.name==='stop'?'중지':'재개'}할까요? 비용 보호 중지는 이 명령으로 해제할 수 없습니다.`;
       markup={inline_keyboard:[[{text:'확인',callback_data:`v1:confirm:${token}`}]]};
     }else if(!text&&command.name==='confirm'){
       const result=await rpc<string>('hpbot_confirm',{p_update:update.update_id,p_token:command.token});
       text=({STOP:'⏸ 감시를 중지했습니다. 기존 업무·사건은 보존합니다.',RESUME:'▶ 감시를 재개했습니다. 첫 정상 조회를 새 기준으로 사용합니다.',COST_BLOCKED:'비용·요금제 확인 후 운영자가 재개해야 합니다.',EXPIRED:'확인 버튼이 만료되었거나 다른 사용자의 요청입니다.'} as Record<string,string>)[result]??'확인 요청을 처리하지 않았습니다.';
     }else if(!text&&command.name==='setting'){
       await rpc('hpbot_toggle_setting',{p_update:update.update_id,p_setting:command.setting});command={name:'settings'};
     }else if(!text&&command.name==='refresh'){
       const state=await rpc<string>('hpbot_request_refresh',{p_update:update.update_id});
       let observed=false;
       if(state==='RUN'){
         const response=await fetcher(`${config.url}/functions/v1/ulsan-pilot-watcher?manual=true`,{method:'POST',headers:{Authorization:`Bearer ${config.gatewayJwt}`,'x-watcher-key':config.watcherKey,'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(45000)});
         if(!response.ok)throw new Error('WATCHER_UNAVAILABLE');
         observed=response.headers.get('x-pilot-accepted')==='true';
       }
       let data=await rpc<any>('hpbot_read',{p_command:'health'});
       if(state==='JOINED'&&await rpc<boolean>('pilot_reserve',{p_bytes:32768})){
         const previous=data.last_success;
         for(let i=0;i<8&&data.lease_until&&Date.parse(data.lease_until)>Date.now();i++){
           await new Promise(resolve=>setTimeout(resolve,4000));
           data=await rpc<any>('hpbot_read',{p_command:'health'});
           if(data.last_success!==previous){observed=true;break;}
         }
       }
       text=`${state==='STOPPED'?'⏸ 감시가 중지되어 있습니다.':state==='COOLDOWN'?'잠시 후 다시 조회해 주세요. (30초 제한)':observed?'✅ 조회 완료':state==='JOINED'?'조회가 진행 중입니다. 아래는 마지막 정상 결과입니다.':'⚠️ 새 관측이 확정되지 않았습니다. 마지막 정상 결과를 표시합니다.'}\n전체 미완료: ${data.active}건\n${pilotSuspensionSummary(data)}\n마지막 정상확인: ${kst(data.last_success)}`;
     }else if(!text&&command.name==='test')text='✅ [도선봇 테스트 알림]\nTelegram 명령 수신 → 채팅방 참여 확인 → DB 발송 예약을 통과했습니다.';
     else if(!text&&command.name==='search'&&!command.search)text='검색할 선박명을 입력해 주세요.\n예: 선박검색 GINGA TIGER\n등록된 선박명만 입력해도 조회할 수 있습니다.';
     if(!text){const data=command.name==='queue'
       ?await rpc<any>('hpbot_registration_status',{p_page:command.page??0},24000)
       :await rpc<any>('hpbot_read',{p_command:command.name,p_page:command.page??0,p_search:command.search??'',p_chat:chat},24000);
       const reply=formatReply(command,data);text=reply.text;markup=reply.markup;
       if(['health','debug'].includes(command.name)){
         try{const j=await rpc<any>('jstt_read',{p_chat:chat,p_view:'health'},4096);text+=`\n\nJSTT (20분 간격): ${!j.enabled?'중지':j.failure_count?'오류':!j.last_success||Date.now()-Date.parse(j.last_success)>25*60000?'관측 지연':j.unknown_count||j.quality_status==='DEGRADED'?'일부 부두 확인 필요':'정상'}\n마지막 수집: ${kst(j.last_success)} / 연속 오류 ${j.failure_count}${j.unknown_count?`\n미확인 부두: ${j.unknown_count}건 (기존 배정 유지)`:''}`;}catch{text+='\nJSTT: 확인 불가';}
       }
       if(config.miniAppEnabled&&['queue','search'].includes(command.name)&&/^[A-Za-z0-9_]{5,32}$/.test(config.botUsername)){
         const links=await rpc<Record<string,string>>('pilot_copy_links',{p_applications:(data.rows??[]).map((x:any)=>x.application_id).filter(Boolean).slice(0,10)});
         const buttons=(data.rows??[]).filter((x:any)=>links[x.application_id]).slice(0,10).map((x:any)=>[{text:`📄 복사 · ${x.vessel_name} ${pilotDateTimeLabel(x.pilot_date,x.pilot_time)}`,url:`https://t.me/${config.botUsername}?startapp=copy_${links[x.application_id]}&mode=compact`}]);
         buttons.push([{text:'📋 최근 완료 포함 · 복사 목록',url:`https://t.me/${config.botUsername}?startapp=copy&mode=compact`}]);
         for(const r of (data.rows??[]).filter((x:any)=>/^\d+$/.test(x.application_id??'')).slice(0,10))buttons.push([{text:`⚓ JSTT 조회 · ${r.vessel_name}`,url:jsttMiniUrl(config.botUsername,r.application_id)}]);
         markup={inline_keyboard:[...(markup.inline_keyboard??[]),...buttons]};
       }
     }
     if(config.registration&&markup?.keyboard&&await regAdmin(chat,from.id)){
       markup={...markup,keyboard:[...markup.keyboard,...registrationMenuRows]};
       if(command.name==='help')text+='\n\n방 참여자: 도선등록 / 도선수정 / 도선등록테스트 / 신청처리상태\n현재 실제 제출은 별도 활성화와 최종 확인이 필요합니다.';
       await rpc('pilot_reg_reply',{p_update:update.update_id,p_id:null,p_revision:0,p_message:text,p_markup:markup,p_reply:m.message_id});
     }else await rpc('hpbot_reply',{p_update:update.update_id,p_message:text,p_markup:markup});
     await drainPilotNotifications(config,rpc,fetcher);
     return new Response(null,{status:200});
   }catch{
     // Never retry an accepted command blindly: mutations/Telegram may have
     // completed before an uncertain response. A fresh user command is explicit.
     return new Response(null,{status:accepted?200:503});
   }
 };
}
