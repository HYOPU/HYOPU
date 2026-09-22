// Bounded service-only operational bridge. No pilot registration write action.
import { database,Meter,createHandler } from '../ulsan-pilot-watcher/lib/runtime.ts';
import { createHyopuHandler } from '../ulsan-pilot-watcher/lib/hyopuRuntime.ts';
import { createTelegramSetup } from '../ulsan-pilot-watcher/lib/telegramSetup.ts';
const env=(k:string)=>Deno.env.get(k)??'';
const config={url:env('SUPABASE_URL'),serviceKey:env('SUPABASE_SERVICE_ROLE_KEY'),watcherKey:env('ULSAN_WATCHER_KEY'),operatorKey:env('ULSAN_OPERATOR_KEY'),botToken:env('TELEGRAM_BOT_TOKEN'),chatId:env('TELEGRAM_CHAT_ID')};
const dual=createHyopuHandler({...config,login:{username:env('ULSAN_PILOT_USERNAME'),password:env('ULSAN_PILOT_PASSWORD'),sessionKey:env('ULSAN_SESSION_KEY'),transport:env('ULSAN_TRANSPORT')==='http-approved'?'http-approved':'https'}});
const telegram=createTelegramSetup({...config,webhookSecret:env('TELEGRAM_WEBHOOK_SECRET'),adminChats:env('TELEGRAM_ADMIN_CHAT_IDS').split(','),botUsername:env('TELEGRAM_BOT_USERNAME'),gatewayJwt:env('ULSAN_GATEWAY_JWT')||env('SUPABASE_ANON_KEY')});
Deno.serve(async(req:Request)=>{
 let c:any={};try{const token=(req.headers.get('authorization')??'').split(' ')[1];c=JSON.parse(atob(token.split('.')[1].replaceAll('-','+').replaceAll('_','/')));}catch{}
 // Signature verification is performed by Supabase gateway (verify_jwt=true).
 if(req.method!=='POST'||c.role!=='service_role'||c.ref!=='nhujqbqygnhbnvmfmodi'||!(c.exp>Date.now()/1000))return new Response(null,{status:401});
 if(config.url!=='https://nhujqbqygnhbnvmfmodi.supabase.co'||config.chatId!=='-1004425641291'||env('ULSAN_PILOT_USERNAME')!=='1002')return Response.json({error:'WRONG_TARGET'},{status:503});
 try{
 const {action}=await req.json();
 if(action==='vault'){
  const gateway=env('ULSAN_GATEWAY_JWT')||env('SUPABASE_ANON_KEY');
  if(!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(gateway))throw Error('GATEWAY_JWT_REQUIRED');
  await database(config,new Meter(),async(input,init)=>{
   const r=await fetch(input,init);if(!r.ok){const e=await r.clone().json().catch(()=>({}));
    if(/^[A-Z_]+$/.test(e.message??''))throw Error(e.message);
    throw Error('VAULT_DB_'+String(e.code??r.status).replace(/[^A-Z0-9]/g,''));}return r;
  })('hpbot_provision_vault',{p_key:config.watcherKey,p_gateway:gateway});return Response.json({provisioned:true});
 }
 if(action==='preview')return dual(new Request(config.url+'/functions/v1/ulsan-pilot-watcher?dryRun=true',{headers:{'x-watcher-key':config.operatorKey}}));
 if(action==='collect')return dual(new Request(config.url+'/functions/v1/ulsan-pilot-watcher',{method:'POST',headers:{'x-watcher-key':config.watcherKey}}));
 if(action==='deliveryTest')return createHandler(config)(new Request(config.url+'/functions/v1/ulsan-pilot-watcher?deliveryTest=true',{method:'POST',headers:{'x-watcher-key':config.operatorKey}}));
 if(action==='webhook')return telegram(new Request(config.url+'/functions/v1/ulsan-pilot-watcher?telegramSetup=apply',{method:'POST',headers:{'x-watcher-key':config.operatorKey}}));
 return Response.json({error:'ACTION_INVALID'},{status:400});
 }catch(e){return Response.json({error:e instanceof Error&&/^[A-Z_0-9]+$/.test(e.message)?e.message:'SETUP_FAILED'},{status:502});}
});
