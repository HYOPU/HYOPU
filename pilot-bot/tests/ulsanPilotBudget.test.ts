// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {commitReservation} from '../supabase/functions/ulsan-pilot-watcher/lib/hyopuRuntime';
import {bytes,Meter,database} from '../supabase/functions/ulsan-pilot-watcher/lib/runtime';
let db:PGlite;
async function rpc(name:string,args:unknown[]=[]){return (await db.query<any>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args)).rows[0].v;}
const open=(id=crypto.randomUUID(),size=131072)=>rpc('pilot_mini_open',['-1',123,null,size,id]);
const usage=async()=> (await db.query<any>('select scope,estimated_bytes::int n from pilot_usage order by scope')).rows;
beforeAll(async()=>{db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const f of ['20260920000000_ulsan_pilot_watcher','20260920000300_hpbot_operations','20260920000400_hpbot_telegram','20260920000500_hpbot_query_context','20260920000600_hpbot_mooring','20260920000700_pilot_registration','20260920000900_pilot_miniapp','20260920001100_pilot_copy_registration','20260920001200_pilot_budget_settlement','20260920001400_pilot_mini_active_draft'])await db.exec(readFileSync('supabase/migrations/'+f+'.sql','utf8'));
},30000);
afterAll(async()=>await db?.close());
beforeEach(async()=>await db.exec(`truncate pilot_action_logs,pilot_registration_requests,pilot_budget_reservations,pilot_budget_corrections,pilot_usage,pilot_miniapp_limits,pilot_telegram_chats,pilot_notifications,pilot_notification_attempts,pilot_runs,hpbot_source_snapshots;
delete from pilot_watcher_control;insert into pilot_watcher_control(id,enabled,billing_verified_at,cycle_start,cycle_end) values(true,true,now(),'2000-01-01','2100-01-01');insert into pilot_telegram_chats(chat_id) values('-1');`));
it('reopening selects live draft over cancelled predecessor with identical update timestamp',async()=>{
 const previous=crypto.randomUUID(),active=crypto.randomUUID();
 await rpc('pilot_mini_save',['-1',123,previous,0,'CREATE','sealed']);
 await db.exec("update pilot_registration_requests set expires_at=now()-interval '1 minute'");
 await rpc('pilot_mini_save',['-1',123,active,0,'CREATE','sealed-next']);
 await db.exec("update pilot_registration_requests set updated_at=now(),created_at=now()");
 expect((await open()).id).toBe(active);
 expect((await rpc('pilot_mini_open',['-1',123,previous])).status).toBe('CANCELLED');
 expect(await rpc('pilot_mini_open',['-1',999,active])).toEqual({});
});
it('changed payload is reserved once, with bootstrap and headroom preserved',()=>{
 const args={p_applications:[{text:'가'.repeat(10000)}],p_forecast:[{text:'b'.repeat(10000)}]};
 expect(commitReservation(8000,args,1300,false)).toBe(8000+bytes(JSON.stringify(args))+1300-8192);
 expect(commitReservation(4000,{},1300,false)).toBe(0);
 expect(commitReservation(4000,{},1300,true)).toBe(8192);
});
it('refund is atomic, once only, leaving 8 KiB minimum',async()=>{
 const r=await open();expect((await usage()).map(x=>x.n)).toEqual([131072,131072]);
 expect(await rpc('pilot_budget_settle',[r.budget_id,3000])).toBe(true);
 expect((await usage()).map(x=>x.n)).toEqual([8192,8192]);
 expect(await rpc('pilot_budget_settle',[r.budget_id,0])).toBe(false);
 expect((await usage()).map(x=>x.n)).toEqual([8192,8192]);
});
it('parallel settlements and repeated reservation IDs cannot double refund',async()=>{
 const r=await open();expect((await open(r.budget_id)).error).toBe('MINI_RESERVATION_REUSED');
 const done=await Promise.all([rpc('pilot_budget_settle',[r.budget_id,16000]),rpc('pilot_budget_settle',[r.budget_id,16000])]);
 expect(done.sort()).toEqual([false,true]);expect((await usage()).map(x=>x.n)).toEqual([16000,16000]);
});
it('crash and unacknowledged reservation retain the entire allocation',async()=>{
 await open();expect((await usage()).map(x=>x.n)).toEqual([131072,131072]);
 expect(await rpc('pilot_budget_settle',[crypto.randomUUID(),8192])).toBe(false);
});
it('midnight settlement refunds the original day, not the new day',async()=>{
 const r=await open();const prior='day:1999-12-31';
 await db.query("update pilot_usage set scope=$1 where scope like 'day:%'",[prior]);
 await db.query('update pilot_budget_reservations set day_scope=$1',[prior]);
 await db.exec("insert into pilot_usage(scope,estimated_bytes) values('day:2100-01-01',500)");
 await rpc('pilot_budget_settle',[r.budget_id,9000]);
 expect((await usage()).map(x=>x.n)).toEqual([9000,9000,500]);
});
it('refund never resumes a latched stop and caps are unchanged',async()=>{
 const r=await open();await db.exec("update pilot_watcher_control set enabled=false,disabled_reason='EGRESS_BUDGET'");
 await rpc('pilot_budget_settle',[r.budget_id,8192]);expect((await open()).error).toBe('MINI_BUDGET');
 const c=(await db.query<any>('select enabled,day_limit::int,cycle_limit::int,warning_limit::int from pilot_watcher_control')).rows[0];
 expect(c).toEqual({enabled:false,day_limit:25165824,cycle_limit:536870912,warning_limit:402653184});
});
it('overruns are charged and stop further traffic, not silently truncated',async()=>{
 const r=await open();await rpc('pilot_budget_settle',[r.budget_id,150000]);
 expect((await usage()).map(x=>x.n)).toEqual([150000,150000]);expect((await open()).error).toBe('MINI_BUDGET');
});
it('competing allocations fail closed at the original daily limit',async()=>{
 await db.exec('update pilot_watcher_control set day_limit=200000');
 const results=await Promise.all([open(),open()]);expect(results.filter(r=>r.budget_id)).toHaveLength(1);expect(results.filter(r=>r.error==='MINI_BUDGET')).toHaveLength(1);
});
it('lower bound stays below serialized bytes for Unicode, escapes and scalars',async()=>{
 const value=[{v:'한글"\\\n😀',n:1.23,yes:true,no:null},'문자'];
 const n=await rpc('pilot_json_string_lower_bound',[value]);expect(Number(n)).toBeGreaterThan(0);expect(Number(n)).toBeLessThan(bytes(JSON.stringify(value)));
});
it('historical correction requires a unique successful snapshot timestamp and is capped',async()=>{
 const id=crypto.randomUUID();
 await db.query("insert into pilot_runs(id,slot,started_at,finished_at,success,parser_version,estimated_bytes) values($1,'2026-09-20 08:00Z','2026-09-20 08:00Z','2026-09-20 08:00:02Z',true,'hyopu-dual-v1',20000)",[id]);
 await db.query("insert into hpbot_source_snapshots(source,content_hash,rows,ranges,observed_at) values('applications','hash',$1,'[]','2026-09-20 08:00:02Z')",[[{text:'a'.repeat(20000)}]]);
 const result=await db.query<any>("select * from pilot_duplicate_budget_candidates('2026-09-20 07:28Z','2026-09-20 13:10Z')");
 expect(Number(result.rows[0].correction_bytes)).toBe(5904);
 await db.query("insert into pilot_budget_corrections values($1,5904,'cycle:test','day:2026-09-20','test',now())",[id]);
 expect((await db.query("select * from pilot_duplicate_budget_candidates('2026-09-20 07:28Z','2026-09-20 13:10Z')")).rows).toHaveLength(0);
});
it('budget APIs and ledgers deny browser roles',async()=>{
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);
 await expect(open()).rejects.toThrow('permission denied');await expect(rpc('pilot_budget_settle',[crypto.randomUUID(),8192])).rejects.toThrow('permission denied');
 await expect(db.query('select * from pilot_budget_reservations')).rejects.toThrow('permission denied');await db.exec('reset role');}
});
it('meter stops before an unreserved request and retains uncertainty on transport loss',async()=>{
 const m=new Meter();m.limit=1000;expect(()=>m.checkRequest('x',{},300)).toThrow('MINI_ALLOCATION_LIMIT');
 m.limit=Infinity;const call=database({url:'https://db.test',serviceKey:'test'} as any,m,async()=>{throw Error('NETWORK');});
 await expect(call('rpc')).rejects.toThrow('NETWORK');expect(m.uncertain).toBe(true);
});
