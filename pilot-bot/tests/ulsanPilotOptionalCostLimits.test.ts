// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
let db:PGlite;
const rpc=async(name:string,args:unknown[]=[])=> (await db.query<any>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args)).rows[0].v;
const control=async()=> (await db.query<any>('select enabled,cost_limits_enabled from pilot_watcher_control')).rows[0];
const ledger=async()=> (await db.query<any>('select estimated_bytes::int n from pilot_usage order by scope')).rows.map(x=>x.n);
beforeAll(async()=>{db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const f of ['20260920000000_ulsan_pilot_watcher','20260920000300_hpbot_operations','20260920000400_hpbot_telegram','20260920000500_hpbot_query_context','20260920000600_hpbot_mooring','20260920000700_pilot_registration','20260920000900_pilot_miniapp','20260920001100_pilot_copy_registration','20260920001200_pilot_budget_settlement','20260920001300_pilot_pob_date_labels','20260921001500_pilot_pob_identity','20260921001600_pilot_concise_notifications','20260921001700_jstt_berth_monitor','20260921001800_jstt_run_measurement','20260921002300_pilot_optional_cost_limits'])await db.exec(readFileSync('supabase/migrations/'+f+'.sql','utf8'));
 for(const f of ['20260922002400_pilot_notification_policy','20260922002500_pilot_event_titles','20260922003400_pilot_event_presentation','20260922003500_pilot_query_presentation'])await db.exec(readFileSync('supabase/migrations/'+f+'.sql','utf8'));
},30000);
afterAll(async()=>await db?.close());
beforeEach(async()=>await db.exec(`truncate pilot_budget_reservations,jstt_budget_reservations,pilot_usage,pilot_miniapp_limits,pilot_notifications cascade;
delete from pilot_watcher_control;insert into pilot_watcher_control(id,enabled,billing_verified_at,cycle_start,cycle_end,day_limit)values(true,true,now(),'2000-01-01','2100-01-01',16384);
update jstt_monitor_control set enabled=true,disabled_reason=null;insert into pilot_telegram_chats(chat_id)values('-1')on conflict do nothing;`));
it('fresh installs retain cost protection until explicit opt-out',async()=>{expect((await control()).cost_limits_enabled).toBe(true);expect(await rpc('pilot_reserve',[20000])).toBe(false);expect((await control()).enabled).toBe(false);});
it('off: allocations above both former caps stay atomically accounted and enabled',async()=>{
 await db.exec('update pilot_watcher_control set cost_limits_enabled=false,cycle_limit=20000,warning_limit=17000');
 expect(await Promise.all([rpc('pilot_reserve',[20000]),rpc('pilot_reserve',[30000])])).toEqual([true,true]);
 expect(await ledger()).toEqual([50000,50000]);expect((await control()).enabled).toBe(true);
 const msg=(await db.query<any>("select message from pilot_notifications where notification_type='COST_WARNING'")).rows;
 expect(msg).toHaveLength(1);expect(msg[0].message).toContain('자체 비용 자동중지: 해제');expect(msg[0].message).not.toContain('한도 도달 시 도선봇만 자동 중지');
});
it('off: old billing-review deadline does not stop monitoring or reset counters',async()=>{
 await db.exec("update pilot_watcher_control set cost_limits_enabled=false,cycle_end='2001-01-01'");
 expect(await rpc('pilot_reserve',[20000])).toBe(true);expect(await rpc('jstt_reserve',[crypto.randomUUID(),40000])).toBe(true);expect(await ledger()).toEqual([60000,60000]);
});
it('off: MiniApp and JSTT overruns are charged once without a global/module stop',async()=>{
 await db.exec('update pilot_watcher_control set cost_limits_enabled=false');
 const id=crypto.randomUUID();await rpc('pilot_mini_open',['-1',123,null,131072,id]);
 expect(await rpc('pilot_budget_settle',[id,150000])).toBe(true);expect(await rpc('pilot_budget_settle',[id,150000])).toBe(false);
 const jid=crypto.randomUUID();expect(await rpc('jstt_reserve',[jid,131072])).toBe(true);await rpc('jstt_settle',[jid,170000]);await rpc('jstt_settle',[jid,170000]);
 expect(await ledger()).toEqual([320000,320000]);expect((await control()).enabled).toBe(true);expect((await db.query<any>('select enabled from jstt_monitor_control')).rows[0].enabled).toBe(true);
});
it('off never resumes manual stop and still rejects oversized reservations',async()=>{
 await db.exec("update pilot_watcher_control set cost_limits_enabled=false,enabled=false,disabled_reason='MANUAL'");
 expect(await rpc('pilot_reserve',[500])).toBe(false);expect(await rpc('jstt_reserve',[crypto.randomUUID(),2000])).toBe(false);expect(await ledger()).toEqual([]);
 await expect(rpc('pilot_reserve',[1048577])).rejects.toThrow('INVALID_RESERVATION');
});
it('reenabling limits uses preserved usage, not a fresh allowance',async()=>{
 await db.exec('update pilot_watcher_control set cost_limits_enabled=false');await rpc('pilot_reserve',[30000]);
 await db.exec('update pilot_watcher_control set cost_limits_enabled=true');expect(await rpc('pilot_reserve',[1])).toBe(false);expect((await control()).enabled).toBe(false);
});
it('new APIs and control flag stay inaccessible to browser roles',async()=>{
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await expect(rpc('pilot_reserve',[1])).rejects.toThrow('permission denied');await expect(db.exec('update pilot_watcher_control set cost_limits_enabled=false')).rejects.toThrow('permission denied');await db.exec('reset role');}
});
