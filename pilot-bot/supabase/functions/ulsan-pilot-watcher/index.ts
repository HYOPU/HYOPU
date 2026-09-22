import { createHandler } from './lib/runtime.ts';
import { createHyopuHandler } from './lib/hyopuRuntime.ts';
import { createTelegramSetup } from './lib/telegramSetup.ts';
const env=(key:string)=>Deno.env.get(key)??'';
const config={url:env('SUPABASE_URL'),serviceKey:env('SUPABASE_SERVICE_ROLE_KEY'),watcherKey:env('ULSAN_WATCHER_KEY'),operatorKey:env('ULSAN_OPERATOR_KEY'),botToken:env('TELEGRAM_BOT_TOKEN'),chatId:env('TELEGRAM_CHAT_ID')};
const legacy=createHandler(config);
const dual=createHyopuHandler({...config,login:{username:env('ULSAN_PILOT_USERNAME'),password:env('ULSAN_PILOT_PASSWORD'),sessionKey:env('ULSAN_SESSION_KEY'),transport:env('ULSAN_TRANSPORT')==='http-approved'?'http-approved':'https'}});
const setup=createTelegramSetup({...config,webhookSecret:env('TELEGRAM_WEBHOOK_SECRET'),adminChats:env('TELEGRAM_ADMIN_CHAT_IDS').split(','),botUsername:env('TELEGRAM_BOT_USERNAME'),gatewayJwt:env('ULSAN_GATEWAY_JWT')||env('SUPABASE_ANON_KEY')});
Deno.serve(req=>new URL(req.url).searchParams.has('telegramSetup')?setup(req):(env('ULSAN_HYOPU_ENABLED')==='true'||new URL(req.url).searchParams.get('hyopuPreview')==='true'?dual(req):legacy(req)));
