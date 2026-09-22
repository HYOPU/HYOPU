import { createMiniApp } from './lib/runtime.ts';
import { eligibilityPolicyFromEnv } from '../_shared/pilot-registration/eligibility.ts';
const env=(name:string)=>Deno.env.get(name)??'';
Deno.serve(createMiniApp({url:env('SUPABASE_URL'),serviceKey:env('SUPABASE_SERVICE_ROLE_KEY'),
 watcherKey:env('ULSAN_WATCHER_KEY'),operatorKey:env('ULSAN_OPERATOR_KEY'),botToken:env('TELEGRAM_BOT_TOKEN'),chatId:env('TELEGRAM_CHAT_ID'),
 origin:env('PILOT_MINIAPP_ORIGIN'),adminChats:env('TELEGRAM_ADMIN_CHAT_IDS').split(',').map(s=>s.trim()).filter(Boolean),
 registration:{eligibilityPolicy:eligibilityPolicyFromEnv(env('ULSAN_PILOT_ELIGIBILITY_POLICY')),username:env('ULSAN_PILOT_USERNAME'),password:env('ULSAN_PILOT_PASSWORD'),sessionKey:env('ULSAN_SESSION_KEY'),
 transport:env('ULSAN_TRANSPORT')==='http-approved'?'http-approved':'https',createEnabled:env('ULSAN_PILOT_REGISTRATION_ENABLED')==='true',updateEnabled:env('ULSAN_PILOT_UPDATE_ENABLED')==='true',copyEnabled:env('ULSAN_PILOT_COPY_REGISTRATION_ENABLED')==='true',copyHistoryDays:Number(env('PILOT_COPY_HISTORY_DAYS')||30)}}));
