import { database, Meter, boundedJson } from './runtime.ts';
import { sha256 } from './source.ts';
import { telegramApi } from '../../telegram-webhook/lib/runtime.ts';
import type { WebhookConfig } from '../../telegram-webhook/lib/runtime.ts';
export function createTelegramSetup(config:WebhookConfig,fetcher:typeof fetch=fetch){return async(req:Request)=>{
 const secret=req.headers.get('x-watcher-key')??'';
 if(req.method!=='POST'||secret.length>512||config.operatorKey.length<32||await sha256(secret)!==await sha256(config.operatorKey))return new Response(null,{status:401});
 const rpc=database(config,new Meter(),fetcher);
 try{
   if(!await rpc<boolean>('pilot_reserve',{p_bytes:32768}))throw new Error('BUDGET_STOP');
   const me=await telegramApi(config,'getMe',{},fetcher);
   if(me.username!==config.botUsername||!me.is_bot)throw new Error('WRONG_BOT');
   const hook=await telegramApi(config,'getWebhookInfo',{},fetcher);
   const apply=new URL(req.url).searchParams.get('telegramSetup')==='apply';
   const inspectChat=new URL(req.url).searchParams.get('inspectChat');
   if(inspectChat&&(apply||!/^-[0-9]{5,18}$/.test(inspectChat)))throw new Error('CHAT_INSPECTION_INVALID');
   const chat=await telegramApi(config,'getChat',{chat_id:inspectChat??config.chatId},fetcher);
   const member=await telegramApi(config,'getChatMember',{chat_id:chat.id,user_id:me.id},fetcher);
   const endpoint=`${config.url}/functions/v1/telegram-webhook`;
   if(apply){
     if(hook.url&&hook.url!==endpoint)throw new Error('EXISTING_WEBHOOK_CONFLICT');
     if(member.status!=='administrator')throw new Error('BOT_NOT_ADMIN');
     if(!/^[A-Za-z0-9_-]{32,256}$/.test(config.webhookSecret))throw new Error('WEBHOOK_SECRET_NOT_CONFIGURED');
     await telegramApi(config,'setWebhook',{url:endpoint,secret_token:config.webhookSecret,allowed_updates:['message','callback_query'],max_connections:2,drop_pending_updates:false},fetcher);
     await telegramApi(config,'setMyCommands',{commands:[{command:'start',description:'한국어 메뉴 / 도움말'},{command:'queue',description:'협운 미완료 도선일정'},{command:'status',description:'도선 현재상태'},{command:'weather',description:'BAD WEATHER 현황'},{command:'refresh',description:'방 참여자 새로고침'}]},fetcher);
   }
   return boundedJson({bot:me.username,bot_id:me.id,chat_id:chat.id,chat_title:chat.title,group_role:member.status,can_delete_messages:member.can_delete_messages,can_restrict_members:member.can_restrict_members,can_promote_members:member.can_promote_members,webhook_url:apply?endpoint:hook.url,pending_updates:hook.pending_update_count,last_error:hook.last_error_message??null,applied:apply});
 }catch(e){return new Response(JSON.stringify({error:e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'SETUP_UNAVAILABLE'}),{status:502,headers:{'Content-Type':'application/json'}});}
};}
