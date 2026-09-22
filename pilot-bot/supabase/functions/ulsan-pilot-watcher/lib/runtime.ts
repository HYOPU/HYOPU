import { fetchForecast, readBounded, sha256 } from './source.ts';

export interface Config { url:string; serviceKey:string; watcherKey:string; operatorKey:string; botToken:string; chatId:string }
export const bytes = (value:string) => new TextEncoder().encode(value).length;
// A conservative application-data estimate, NOT the provider billing meter.
// Includes one 512-byte allowance per outbound request and DB response headers.
export class Meter {
  total=512; // Cron invocation + 204 response allowance
  uncertain=false;
  limit=Infinity;
  checkRequest(body:string,headers:Record<string,string>,responseAllowance=0) {
    if(this.total+bytes(body)+bytes(JSON.stringify(headers))+512+responseAllowance+8192>this.limit)throw new Error('MINI_ALLOCATION_LIMIT');
  }
  addRequest(body:string, headers:Record<string,string>={}) { this.total+=bytes(body)+bytes(JSON.stringify(headers))+512; }
  addDatabaseResponse(size:number) { this.total+=size+512; }
}
type Rpc = <T=any>(name:string,args?:Record<string,unknown>,maximum?:number)=>Promise<T>;
export function database(config:Config, meter:Meter, fetcher:typeof fetch=fetch):Rpc {
  return async <T>(name:string,args:Record<string,unknown>={},maximum=2048):Promise<T> => {
    const body=JSON.stringify(args);
    const headers={apikey:config.serviceKey,Authorization:`Bearer ${config.serviceKey}`,'Content-Type':'application/json','Prefer':'return=minimal'};
    meter.checkRequest(body,headers,maximum+512);
    meter.addRequest(body,headers);
    // Deliberately no retries: a timed-out mutation may already have committed.
    try {
    const r=await fetcher(`${config.url}/rest/v1/rpc/${name}`,{method:'POST',headers,body,signal:AbortSignal.timeout(6000),redirect:'error'});
    // PostgREST void RPCs legitimately return HTTP 204 with no body.
    // Do not classify an already committed receipt as a transport failure.
    const data=r.status===204?new Uint8Array():await readBounded(r,maximum);meter.addDatabaseResponse(data.length);
    if(!r.ok)throw new Error(`DB_${r.status}`);
    const text=new TextDecoder().decode(data);return (text?JSON.parse(text):null) as T;
    } catch(error) { meter.uncertain=true; throw error; }
  };
}
export async function sendTelegram(config:Config,message:string,fetcher:typeof fetch=fetch,replyMarkup?:unknown,replyParameters?:unknown) {
  try {
    const r=await fetcher(`https://api.telegram.org/bot${config.botToken}/sendMessage`,{
      method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(6000),
      body:JSON.stringify({chat_id:config.chatId,text:message,link_preview_options:{is_disabled:true},...(replyMarkup?{reply_markup:replyMarkup}:{}),...(replyParameters?{reply_parameters:replyParameters}:{})}),
    });
    // A valid 429 is the only auto-retry case: Telegram explicitly refused it.
    const result=JSON.parse(new TextDecoder().decode(await readBounded(r,32768)));
    if(r.ok && result.ok===true && Number.isSafeInteger(result.result?.message_id)) return {p_status:'SENT',p_message_id:result.result.message_id};
    if(r.status===429 && result.ok===false) return {p_status:'RATE_LIMITED',p_error:'TELEGRAM_429',p_retry_seconds:Math.min(86400,Math.max(60,Number(result.parameters?.retry_after)||60))};
    if(r.status>=400 && r.status<500 && result.ok===false) return {p_status:'FAILED',p_error:`TELEGRAM_${r.status}`};
    return {p_status:'UNKNOWN',p_error:'TELEGRAM_UNCERTAIN'};
  } catch { return {p_status:'UNKNOWN',p_error:'TELEGRAM_UNCERTAIN'}; }
}
async function authorized(actual:string|null, expected:string) {
  return expected.length>=32 && actual!==null && actual.length<=512 && await sha256(actual)===await sha256(expected);
}
export function boundedJson(value:any,max=32768):Response {
  let data=JSON.stringify(value);
  if(bytes(data)>max) data=JSON.stringify({counts:value.counts,current_state:value.current_state,next_state:value.next_state,eligible:value.eligible,truncated:true,reason:'RESPONSE_LIMIT',events:value.events?.map((e:any)=>({type:e.type,method:e.method})),changes_count:value.changes_count});
  if(bytes(data)>max) data='{"truncated":true,"reason":"RESPONSE_LIMIT"}';
  return new Response(data,{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
}
export function createHandler(config:Config,fetcher:typeof fetch=fetch,observeMeter?:(total:number)=>void) {
  // Server-side, per-isolate throttle; not a distributed global limiter. Secrets
  // restrict this operational endpoint. Provider Spend Cap remains the backstop.
  let nextPreview=0;
  return async (request:Request):Promise<Response> => {
    const dry=new URL(request.url).searchParams.get('dryRun')==='true';
    const deliveryTest=new URL(request.url).searchParams.get('deliveryTest')==='true';
    if(dry && deliveryTest)return new Response(null,{status:400});
    if(request.method!==(dry?'GET':'POST'))return new Response(null,{status:405});
    if(!await authorized(request.headers.get('x-watcher-key'),dry||deliveryTest?config.operatorKey:config.watcherKey))return new Response(null,{status:401});
    if(dry && Date.now()<nextPreview)return new Response(null,{status:429,headers:{'Retry-After':'60'}});
    if(dry)nextPreview=Date.now()+60_000;
    const meter=new Meter(); const rpc=database(config,meter,fetcher);
    let token:string|undefined;
    const measuredFetch:typeof fetch=(input,init)=>{
      // Only source requests use this wrapper. Received HTML is ingress, not egress.
      meter.addRequest(String(init?.body??''),(init?.headers??{}) as Record<string,string>);
      return fetcher(input,init);
    };
    const drain=async()=>{
      // Bound fan-out. Each claim atomically reserves its own notification budget.
      for(let i=0;i<2;i++){
        const n=await rpc<{id:string;message:string}|null>('pilot_claim_notification',{},14000);
        if(!n)return;
        const result=await sendTelegram(config,n.message,fetcher);
        await rpc('pilot_finish_notification',{p_id:n.id,...result});
      }
    };
    if(deliveryTest){
      if(!config.botToken || !config.chatId)return new Response(null,{status:503});
      try{
        const n=await rpc<{id:string;message?:string;status:string}>('pilot_claim_delivery_test');
        if(!n.message)return boundedJson({test_id:n.id,status:n.status,already_attempted:true});
        const result=await sendTelegram(config,n.message,fetcher);
        // Setup tests never auto-retry, including an explicit Telegram 429.
        const status=result.p_status==='RATE_LIMITED'?'FAILED':result.p_status;
        await rpc('pilot_finish_notification',{p_id:n.id,...result,p_status:status});
        return boundedJson({test_id:n.id,status,telegram_message_id:'p_message_id' in result?result.p_message_id:null});
      }catch{return new Response('{"error":"DELIVERY_TEST_UNAVAILABLE"}',{status:502,headers:{'Content-Type':'application/json'}});}
    }
    try {
      if(dry){
        const data=await fetchForecast(measuredFetch);
        const preview=await rpc('pilot_preview',{p_rows:data.rows},32768);
        return boundedJson({...preview,html_ingress_bytes:data.ingress,app_bytes_estimate:meter.total});
      }
      // No source traffic without configured delivery credentials.
      if(!config.botToken || !config.chatId)return new Response(null,{status:503});
      const begin=await rpc<{token?:string;hash?:string;version?:number;skip?:string}>('pilot_begin');
      if(!begin.token){
        if(begin.skip==='DISABLED_OR_BUDGET')await drain();
        return new Response(null,{status:204});
      }
      token=begin.token;
      const data=await fetchForecast(measuredFetch);
      const changed=data.hash!==begin.hash;
      // Payload + request headers/auth + two RPC round trips allowance, reserved
      // before sending changed data. No snapshot bytes leave DB on unchanged runs.
      if(changed && !await rpc<boolean>('pilot_reserve_extra',{p_token:token,p_bytes:bytes(JSON.stringify(data.rows))+4096})){
        await rpc('pilot_fail',{p_token:token,p_error:'BUDGET_STOP'}); token=undefined;await drain();return new Response(null,{status:204});
      }
      const args={p_token:token,p_version:begin.version,p_hash:data.hash,p_rows:changed?data.rows:null,p_ingress:data.ingress};
      // Runtime estimate excludes Telegram (its reservation is tracked separately).
      await rpc('pilot_commit',args);token=undefined;
      await drain();
      observeMeter?.(meter.total);
      return new Response(null,{status:204});
    } catch(error){
      if(token)await rpc('pilot_fail',{p_token:token,p_error:error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)?error.message:'EXECUTION_FAILED'}).catch(()=>{});
      // Delivery problems never undo a committed observation. Do not echo HTML,
      // keys, Telegram URLs, DB responses, or stack traces into function logs.
      if(!dry)await drain().catch(()=>{});
      return dry?new Response('{"error":"PREVIEW_UNAVAILABLE"}',{status:502,headers:{'Content-Type':'application/json'}}):new Response(null,{status:204});
    }
  };
}
