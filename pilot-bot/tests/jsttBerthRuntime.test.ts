// @vitest-environment node
import {it,expect,vi} from 'vitest';
import {handleJsttMini} from '../supabase/functions/pilot-miniapp/lib/jstt';
import {createJsttBerthHandler} from '../api/jstt_berth_watch.mjs';
import {cacheableJsttAsset} from '../api/_jstt_berth_browser.mjs';
const config:any={url:'https://test.supabase.co',serviceKey:'test-key',botToken:'TOKEN',chatId:'-1',adminChats:['-1']};
const respond=(x:any,status=200)=>new Response(JSON.stringify(x),{status});
it('only public same-origin script/css assets can be reused within a collection',()=>{
 const url='https://www.jstt.co.kr:5440/_framework/blazor.web.9hsif5t8mt.js';
 expect(cacheableJsttAsset(url,'script','GET',{'cache-control':'public,max-age=3600'})).toBe(true);
 for(const headers of [{'cache-control':'private'},{'cache-control':'no-store'},{'set-cookie':'session=x'}])expect(cacheableJsttAsset(url,'script','GET',headers)).toBe(false);
 expect(cacheableJsttAsset(url,'document','GET')).toBe(false);expect(cacheableJsttAsset(url,'script','POST')).toBe(false);
 expect(cacheableJsttAsset(url.replace('www.jstt.co.kr:5440','example.org'),'script','GET')).toBe(false);
 expect(cacheableJsttAsset('https://www.jstt.co.kr:5440/TW/VesselSchedule/List','script','GET')).toBe(false);
});
it('nonparticipant denied before mutation; uses no pilot draft RPC',async()=>{
 const methods:string[]=[];const fetcher:any=async(url:string)=>{const name=url.split('/').pop()!;methods.push(name);return Response.json(name==='jstt_ui_begin'?true:name==='getChatMember'?{ok:true,result:{status:'left'}}:null);};
 const response=await handleJsttMini(config,{op:'jsttAdd',requestId:crypto.randomUUID(),vessel:'SHIP',confirm:true},42,fetcher,respond);
 expect(response.status).toBe(403);expect(methods).not.toContain('jstt_watch_change');expect(methods).not.toContain('pilot_mini_open');expect(methods).toContain('jstt_settle');
});
it('ordinary member may confirm exact vessel and triggers independent refresh',async()=>{
 const calls:any[]=[];const fetcher:any=async(url:string,init:any)=>{const n=url.split('/').pop();calls.push([n,JSON.parse(init.body)]);return Response.json(n==='jstt_ui_begin'?true:n==='getChatMember'?{ok:true,result:{status:'member'}}:n==='jstt_watch_change'?{changed:true}:n==='jstt_dispatch'?'RUN':null);};
 const response=await handleJsttMini(config,{op:'jsttAdd',requestId:crypto.randomUUID(),vessel:'SHIP',agency:null,confirm:true},42,fetcher,respond);
 expect(response.status).toBe(200);expect(calls.map(x=>x[0])).toContain('jstt_watch_change');expect(calls.map(x=>x[0])).toContain('jstt_dispatch');
});
it('internal collector rejects unauthorized requests and disabled flag before browser work',async()=>{
 const collect=vi.fn();const handler=createJsttBerthHandler({env:{JSTT_BERTH_KEY:'x'.repeat(32)},collect});
 const res:any={code:0,setHeader(){},status(n:number){this.code=n;return this;},end(){return this;},json(){return this;}};
 await handler({method:'POST',headers:{},body:{}},res);expect(res.code).toBe(401);
 await handler({method:'POST',headers:{'x-jstt-key':'x'.repeat(32)},body:{id:crypto.randomUUID()}},res);expect(res.code).toBe(503);expect(collect).not.toHaveBeenCalled();
});
it('single claimed run applies compact hash fast path and duplicate claim does not collect',async()=>{
 let claim=true;const calls:any[]=[];const collect=vi.fn(async()=>({rows:[],hash:'a'.repeat(64),window:{}}));
 const fetcher:any=async(url:string,init:any)=>{const n=url.split('/').pop();calls.push([n,JSON.parse(init.body)]);return Response.json(n==='jstt_claim'?(claim?{version:1,hash:'a'.repeat(64)}:null):n==='jstt_apply'?{accepted:true}:null);};
 const env={JSTT_BERTH_KEY:'x'.repeat(32),JSTT_BERTH_MONITOR_ENABLED:'true',JSTT_SCHEDULE_USER_ID:'user',JSTT_SCHEDULE_PASSWORD:'password',SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'a'.repeat(40)};
 const handler=createJsttBerthHandler({env,fetcher,collect});const res:any={setHeader(){},status(){return this;},end(){},json(){}};
 const req={method:'POST',headers:{'x-jstt-key':'x'.repeat(32)},body:{id:crypto.randomUUID()}};
 await handler(req,res);expect(calls.find(x=>x[0]==='jstt_apply')[1].p_rows).toBeNull();claim=false;await handler(req,res);expect(collect).toHaveBeenCalledTimes(1);
});
it('browser budget exhaustion retains space for failure and settlement without increasing the cap',async()=>{
 const calls:string[]=[];let captured:any;
 const fetcher:any=async(url:string)=>{const n=url.split('/').pop()!;calls.push(n);return Response.json(n==='jstt_begin'?{}:n==='jstt_claim'?{version:1,hash:null}:null);};
 const collect=async(_c:any,_w:any,m:any)=>{captured=m;m.add(m.limit-m.total-12000);try{m.add(1);}catch{}throw Error('JSTT_QUERY_FAILED');};
 const env={JSTT_BERTH_KEY:'x'.repeat(32),JSTT_SCHEDULE_USER_ID:'user',JSTT_SCHEDULE_PASSWORD:'password',SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'a'.repeat(40)};
 let result:any;const res:any={setHeader(){},status(){return this;},end(){},json(x:any){result=x;}};
 await createJsttBerthHandler({env,fetcher,collect})({method:'POST',headers:{'x-jstt-key':'x'.repeat(32)},body:{probe:true}},res);
 expect(result.error).toBe('JSTT_BYTE_LIMIT');expect(calls).toContain('jstt_fail');expect(calls).toContain('jstt_settle');expect(captured.total).toBeLessThanOrEqual(131072);
});
it('quarantined collection is applied with quality diagnostics, without global failure',async()=>{
 const calls:any[]=[];const logger={warn:vi.fn(),error:vi.fn()};let result:any;
 const collect=async()=>({rows:[{schedule_key:'202609220099',raw_berth:'NEW',normalized_berth:'UNKNOWN',berth_verified:false}],hash:'b'.repeat(64),window:{},quality:{status:'DEGRADED',unknown_count:1,samples:[{schedule_key:'202609220099',raw_berth:'NEW'}]}});
 const fetcher:any=async(url:string,init:any)=>{const n=url.split('/').pop();calls.push([n,JSON.parse(init.body)]);return Response.json(n==='jstt_claim'?{version:1,hash:null}:n==='jstt_apply'?{accepted:true}:{});};
 const env={JSTT_BERTH_KEY:'x'.repeat(32),JSTT_SCHEDULE_USER_ID:'secret-user',JSTT_SCHEDULE_PASSWORD:'secret-password',SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'a'.repeat(40)};
 const res:any={setHeader(){},status(){return this;},end(){},json(x:any){result=x;}};
 await createJsttBerthHandler({env,collect,fetcher,logger})({method:'POST',headers:{'x-jstt-key':'x'.repeat(32)},body:{probe:true}},res);
 expect(result.quality.status).toBe('DEGRADED');expect(calls.some(x=>x[0]==='jstt_fail')).toBe(false);
 expect(logger.warn).toHaveBeenCalledOnce();expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-');
});
it('failure logs fixed code and counters, never raw error details or credentials',async()=>{
 const logger={warn:vi.fn(),error:vi.fn()};const fetcher:any=async(url:string)=>Response.json(url.endsWith('jstt_claim')?{version:1,hash:null}:{});
 const env={JSTT_BERTH_KEY:'x'.repeat(32),JSTT_SCHEDULE_USER_ID:'user',JSTT_SCHEDULE_PASSWORD:'password',SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'a'.repeat(40)};
 const collect=async()=>{throw Error('password=PRIVATE https://secret.invalid');};const res:any={setHeader(){},status(){return this;},end(){},json(){}};
 await createJsttBerthHandler({env,fetcher,collect,logger})({method:'POST',headers:{'x-jstt-key':'x'.repeat(32)},body:{probe:true}},res);
 expect(JSON.stringify(logger.error.mock.calls)).toContain('JSTT_COLLECTION_FAILED');expect(JSON.stringify(logger.error.mock.calls)).not.toContain('PRIVATE');
});
