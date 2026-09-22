// @vitest-environment node
import { describe,it,expect } from 'vitest';
import { createHandler,sendTelegram,boundedJson,bytes } from '../supabase/functions/ulsan-pilot-watcher/lib/runtime';
import { fetchForecast } from '../supabase/functions/ulsan-pilot-watcher/lib/source';
const config={url:'https://example.supabase.co',serviceKey:'s'.repeat(220),watcherKey:'w'.repeat(40),operatorKey:'o'.repeat(40),botToken:'123:example',chatId:'456'};
const html=`<tr>${['1','Bad weather','','12:00','Vessel','','CALL','10','10','1','P/S','OTK','협운','','','','','','',''].map(x=>`<td>${x}</td>`).join('')}</tr>`;
const source=()=>new Response(html,{headers:{'date':new Date().toUTCString(),'content-type':'text/html'}});
const req=(dry=false)=>new Request(`https://example.test/${dry?'?dryRun=true':''}`,{method:dry?'GET':'POST',headers:{'x-watcher-key':dry?config.operatorKey:config.watcherKey}});
describe('authenticated, bounded, low-egress Edge handler',()=>{
  it('delivery test uses operator auth, DB claim, production sender and receipt only',async()=>{
    const calls:string[]=[];
    const f=(async(input:any)=>{const u=String(input);calls.push(u);
      if(u.endsWith('pilot_claim_delivery_test'))return Response.json({id:'test',message:'test',status:'SENDING'});
      if(u.includes('api.telegram.org'))return Response.json({ok:true,result:{message_id:99}});
      if(u.endsWith('pilot_finish_notification'))return new Response(null,{status:204});
      throw new Error('UNEXPECTED');})as typeof fetch;
    const h=createHandler(config,f);
    const r=await h(new Request('https://test?deliveryTest=true',{method:'POST',headers:{'x-watcher-key':config.operatorKey}}));
    expect((await r.json()).status).toBe('SENT');expect(calls).toHaveLength(3);
    expect(calls.some(u=>u.includes('ulsanpilot'))).toBe(false);
    expect((await h(new Request('https://test?deliveryTest=true',{method:'POST',headers:{'x-watcher-key':config.watcherKey}}))).status).toBe(401);
  });
  it('requires distinct credentials and rejects before any outgoing call',async()=>{
    let calls=0;const handler=createHandler(config,(async()=>{calls++;throw new Error();}) as typeof fetch);
    expect((await handler(new Request('https://test',{method:'POST'}))).status).toBe(401);expect(calls).toBe(0);
    expect((await handler(new Request('https://test?dryRun=true',{headers:{'x-watcher-key':config.watcherKey}}))).status).toBe(401);
  });
  it('unchanged run sends only hash/controls, response 204; four source requests',async()=>{
    const snapshot=await fetchForecast((async()=>source()) as typeof fetch);
    const calls:{url:string;args:any}[]=[];
    const f=(async(input:any,init:any)=>{
      const url=String(input);const args=url.includes('/rpc/')?JSON.parse(init.body):null;calls.push({url,args});
      if(url.startsWith('http://www.ulsanpilot'))return source();
      if(url.endsWith('pilot_begin'))return Response.json({token:'test',hash:snapshot.hash,version:1});
      if(url.endsWith('pilot_commit'))return Response.json({accepted:true,state:'NORMAL',changes:0});
      if(url.endsWith('pilot_claim_notification'))return Response.json(null);
      throw new Error('UNEXPECTED');
    }) as typeof fetch;
    let metered=0;
    const result=await createHandler(config,f,n=>metered=n)(req());expect(result.status).toBe(204);expect(await result.text()).toBe('');
    expect(metered).toBeLessThanOrEqual(8192);
    expect(calls.filter(c=>c.url.startsWith('http:'))).toHaveLength(4);
    expect(calls.find(c=>c.url.endsWith('pilot_commit'))?.args.p_rows).toBeNull();
    expect(calls.some(c=>c.url.endsWith('pilot_reserve_extra'))).toBe(false);
  });
  it('dryRun reads only preview and throttles on server, caps response at 32 KiB',async()=>{
    const calls:string[]=[];
    const f=(async(input:any)=>{const url=String(input);calls.push(url);return url.startsWith('http:')?source():Response.json({current_state:'NORMAL',counts:{total:4},changes:[],truncated:false});})as typeof fetch;
    const handler=createHandler(config,f);expect((await handler(req(true))).status).toBe(200);expect((await handler(req(true))).status).toBe(429);
    expect(calls.filter(u=>u.includes('/rpc/'))).toEqual([config.url+'/rest/v1/rpc/pilot_preview']);
    expect(bytes(await boundedJson({changes:'x'.repeat(50000)}).text())).toBeLessThanOrEqual(32768);
  });
  it.each(['timeout','bad-json','server-error'])('marks %s UNKNOWN without a resend',async kind=>{
    let count=0;
    const f=(async()=>{count++;if(kind==='timeout')throw new Error('Timeout');return new Response(kind==='bad-json'?'?':'{"ok":false}',{status:kind==='server-error'?500:200});})as typeof fetch;
    expect((await sendTelegram(config,'message',f)).p_status).toBe('UNKNOWN');expect(count).toBe(1);
  });
  it('explicit 429 can be retried; other definite 4xx rejected',async()=>{
    expect((await sendTelegram(config,'m',(async()=>Response.json({ok:false,parameters:{retry_after:120}},{status:429}))as typeof fetch)).p_status).toBe('RATE_LIMITED');
    expect((await sendTelegram(config,'m',(async()=>Response.json({ok:false},{status:400}))as typeof fetch)).p_status).toBe('FAILED');
  });
});
