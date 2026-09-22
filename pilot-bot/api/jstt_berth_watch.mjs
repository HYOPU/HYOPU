import { randomUUID, timingSafeEqual } from 'node:crypto';
import { collectJsttBerths } from './_jstt_berth_browser.mjs';
import { jsttWindow, safeJsttError } from './_jstt_berth_core.mjs';
import { loadJsttScheduleConfig } from './_jstt_schedule_core.mjs';

export function createJsttBerthHandler({env=process.env,fetcher=fetch,collect=collectJsttBerths,logger=console}={}) {
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).end();
  const expected=env.JSTT_BERTH_KEY??'',actual=req.headers['x-jstt-key']??'';
  if(typeof actual!=='string'||expected.length<32||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return res.status(401).end();
  let body=req.body;
  try{if(typeof body==='string')body=JSON.parse(body);if(!body||JSON.stringify(body).length>256)throw Error();}catch{return res.status(400).end();}
  const probe=body.probe===true;
  if(!probe&&env.JSTT_BERTH_MONITOR_ENABLED!=='true')return res.status(503).end();
  if(!probe&&!/^[a-f0-9-]{36}$/.test(body.id??''))return res.status(400).end();
  let id=probe?randomUUID():body.id,claimed=false;
  const meter={probe,total:1024,ingress:0,limit:131072,uncertain:false,blocked:false,add(n,reserve=12000){if(this.total+n+reserve>this.limit){this.blocked=true;throw Error('JSTT_BYTE_LIMIT');}this.total+=n;}};
  let rpc;
  const started=Date.now();
  try {
   const config=loadJsttScheduleConfig(env);
   rpc=async(name,args,limit=32768)=>{
    const payload=JSON.stringify(args),headers={apikey:config.store.serviceRoleKey,Authorization:'Bearer '+config.store.serviceRoleKey,'Content-Type':'application/json'};
    // The browser leaves 12KiB for final control/settlement RPCs. Use that margin
    // here without increasing the already-reserved total budget.
    meter.add(Buffer.byteLength(payload)+Buffer.byteLength(JSON.stringify(headers))+512,0);
    let r;try{r=await fetcher(config.store.supabaseUrl+'/rest/v1/rpc/'+name,{method:'POST',headers,body:payload,redirect:'error',signal:AbortSignal.timeout(6000)});}catch(e){meter.uncertain=true;throw e;}
    const reader=r.body?.getReader(),decoder=new TextDecoder();let raw='',length=0;
    if(reader)while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>limit){await reader.cancel();throw Error('JSTT_DB_RESPONSE_LIMIT');}raw+=decoder.decode(part.value,{stream:true});}raw+=decoder.decode();
    meter.total+=length+512;if(!r.ok)throw Error('JSTT_DB_FAILED');return raw?JSON.parse(raw):null;
   };
   if(probe){const begin=await rpc('jstt_begin',{p_id:id,p_probe:true});if(begin.skip)return res.status(409).json({skip:begin.skip});}
   const context=await rpc('jstt_claim',{p_id:id});if(!context)return res.status(204).end();claimed=true;
   meter.deadlineAt=started+44000;
   const snapshot=await collect(config.credentials,jsttWindow(),meter);
   const result=await rpc('jstt_apply',{p_id:id,p_version:context.version,p_hash:snapshot.hash,
    p_rows:probe||snapshot.hash!==context.hash?snapshot.rows:null,p_ingress:meter.ingress,p_duration:Date.now()-started});
   if(snapshot.quality?.unknown_count)logger.warn(JSON.stringify({component:'jstt_berth',event:'BERTH_QUARANTINED',run_id:id,
    unknown_count:snapshot.quality.unknown_count,samples:snapshot.quality.samples}));
   await rpc('jstt_settle',{p_id:id,p_bytes:meter.total+4096});
   if(probe)return res.status(result.accepted?200:409).json({...result,window:snapshot.window,hash:snapshot.hash,quality:snapshot.quality,estimated_bytes:meter.total,
    hyopu:snapshot.rows.filter(r=>r.agency_name==='협운해운(주)'&&r.source_status!=='이안').map(r=>({vessel:r.vessel_name,etb:r.schedule_datetime,berth:r.raw_berth})),cache_hits:meter.cacheHits??0,duration_ms:Date.now()-started});
   return res.status(204).end();
  }catch(error){
   const code=meter.blocked?'JSTT_BYTE_LIMIT':safeJsttError(error);
   // Fixed code only: never log browser errors, credentials, HTML or headers.
   logger.error(JSON.stringify({component:'jstt_berth',event:'COLLECTION_FAILED',run_id:id,code,duration_ms:Date.now()-started,
    estimated_bytes:meter.total,ingress_bytes:meter.ingress}));
   if(claimed&&rpc){await rpc('jstt_fail',{p_id:id,p_error:code}).catch(()=>{});if(!meter.uncertain)await rpc('jstt_settle',{p_id:id,p_bytes:meter.total+4096}).catch(()=>{});}
   return probe?res.status(502).json({error:code,estimated_bytes:meter.total,ingress_bytes:meter.ingress,duration_ms:Date.now()-started,...(meter.loginDiagnostic?{login_diagnostic:meter.loginDiagnostic}:{}),...(meter.loginInputDiagnostic?{input_diagnostic:meter.loginInputDiagnostic}:{}),...(meter.loginNotice?{login_notice:meter.loginNotice}:{}),...(meter.gridDiagnostic?{grid_diagnostic:meter.gridDiagnostic}:{})}):res.status(204).end();
  }
 };
}
export default createJsttBerthHandler();
