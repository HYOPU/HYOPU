import { fetchForecast, sha256 } from './source.ts';
import { Meter, database, boundedJson, sendTelegram, bytes } from './runtime.ts';
import type { Config } from './runtime.ts';
import { collectApplications } from './hyopuCollector.ts';
import type { LoginConfig, CollectionContext } from './hyopuCollector.ts';
export interface DualConfig extends Config { login:LoginConfig }
// args already contains both changed lists. Never add their sizes a second time.
export function commitReservation(measured:number,args:unknown,overhead:number,bootstrap:boolean){
  return (bootstrap?8192:0)+Math.max(0,measured+bytes(JSON.stringify(args))+overhead-8192);
}
export async function drainPilotNotifications(config:Config,rpc:ReturnType<typeof database>,fetcher:typeof fetch=fetch){
  for(let i=0;i<2;i++){
    const n=await rpc<any>('pilot_claim_notification',{},16000);if(!n)return;
    const result=await sendTelegram({...config,chatId:n.chat_id??config.chatId},n.message,fetcher,n.reply_markup,n.reply_parameters);
    await rpc('pilot_finish_notification',{p_id:n.id,...result});
  }
}
export function createHyopuHandler(config:DualConfig,fetcher:typeof fetch=fetch,observeMeter?:(n:number)=>void){
  let nextPreview=0;
  return async(request:Request):Promise<Response>=>{
    const dry=new URL(request.url).searchParams.get('dryRun')==='true';
    if(request.method!==(dry?'GET':'POST'))return new Response(null,{status:405});
    const expected=dry?config.operatorKey:config.watcherKey, actual=request.headers.get('x-watcher-key')??'';
    if(expected.length<32||actual.length>512||await sha256(actual)!==await sha256(expected))return new Response(null,{status:401});
    if(dry&&Date.now()<nextPreview)return new Response(null,{status:429});if(dry)nextPreview=Date.now()+60_000;
    const meter=new Meter(), rpc=database(config,meter,fetcher);let token:string|undefined;let loginOk=false,forecastOk=false;
    const measured:typeof fetch=(url,init)=>{meter.addRequest(String(init?.body??''),(init?.headers??{}) as Record<string,string>);return fetcher(url,init);};
    try{
      if(!config.botToken||!config.chatId)throw new Error('DELIVERY_NOT_CONFIGURED');
      const manual=new URL(request.url).searchParams.get('manual')==='true';
      const context=await rpc<any>(dry?'hpbot_context':'hpbot_begin',dry?{}:{p_manual:manual},12000);
      if(!dry&&!context.token){await drainPilotNotifications(config,rpc,fetcher);return new Response(null,{status:204});}
      token=context.token;
      if(!dry&&context.old_dates.length>1&&!await rpc<boolean>('pilot_reserve_extra',{p_token:token,p_bytes:context.old_dates.length*1024}))throw new Error('BUDGET_STOP');
      // Stop the whole observation on either source failure. No partial commit.
      const apps=await collectApplications(config.login,context as CollectionContext,measured,async()=>{
        if(!dry&&!await rpc<boolean>('pilot_reserve_extra',{p_token:token,p_bytes:4096}))throw new Error('BUDGET_STOP');
      });loginOk=true;
      const forecast=await fetchForecast(measured);forecastOk=true;
      if(dry){
        const preview=await rpc('hpbot_preview',{p_applications:apps.rows,p_forecast:forecast.rows,p_ranges:apps.ranges},32768);
        return boundedJson({...preview,html_ingress_bytes:apps.ingress+forecast.ingress,app_bytes_estimate:meter.total});
      }
      const appChanged=apps.hash!==context.application_hash, forecastChanged=forecast.hash!==context.forecast_hash;
      const args={p_token:token,p_version:context.version,p_application_hash:apps.hash,p_forecast_hash:forecast.hash,
        p_applications:appChanged?apps.rows:null,p_forecast:forecastChanged?forecast.rows:null,p_ranges:apps.ranges,p_session:apps.session,
        p_bootstrap_end:apps.bootstrapEnd,p_ingress:apps.ingress+forecast.ingress};
      // Base reservation covers unchanged bounded traffic. Reserve all changed
      // payload bytes plus margin BEFORE sending them to the DB.
      const commitOverhead=1024+128+bytes(JSON.stringify({apikey:config.serviceKey,Authorization:`Bearer ${config.serviceKey}`,'Content-Type':'application/json',Prefer:'return=minimal'}));
      const extra=commitReservation(meter.total,args,commitOverhead,!!context.bootstrap);
      if(extra>0&&!await rpc<boolean>('pilot_reserve_extra',{p_token:token,p_bytes:extra+2048}))throw new Error('BUDGET_STOP');
      const result=await rpc<any>('hpbot_commit',args,16000);token=undefined;
      if(result.notification){
        const n=result.notification;
        const sent=await sendTelegram({...config,chatId:n.chat_id??config.chatId},n.message,fetcher,n.reply_markup,n.reply_parameters);
        await rpc('pilot_finish_notification',{p_id:n.id,...sent});
      }
      observeMeter?.(meter.total);
      return new Response(null,{status:204,headers:{'x-pilot-accepted':String(result.accepted===true)}});
    }catch(error){
      const code=error instanceof Error&&/^[A-Z_0-9]+$/.test(error.message)?error.message:'EXECUTION_FAILED';
      if(token)await rpc('hpbot_fail',{p_token:token,p_error:code,p_login_ok:loginOk,p_forecast_ok:forecastOk}).catch(()=>{});
      if(!dry)await drainPilotNotifications(config,rpc,fetcher).catch(()=>{});
      return dry?new Response(JSON.stringify({error:code,login_ok:loginOk,forecast_ok:forecastOk}),{status:502,headers:{'Content-Type':'application/json'}}):new Response(null,{status:204});
    }
  };
}
