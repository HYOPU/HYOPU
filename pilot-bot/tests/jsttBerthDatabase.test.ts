// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
let db:PGlite;let tick=0;
const base=Date.parse('2026-09-21T03:00:00Z');
const now=()=>new Date(base+tick++*60000).toISOString();
const rpc=async(name:string,args:any[]=[])=> (await db.query<any>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args)).rows[0].v;
const row=(berth='UNASSIGNED',id='202609140008',agency='협운해운(주)')=>({schedule_key:id,vessel_name:'ARGENT IRIS',agency_name:agency,schedule_datetime:'2026-09-23 07:00',port_in_datetime:'2026-09-21 06:00',departure_datetime:null,source_status:'계획',raw_berth:berth==='UNASSIGNED'?'대기':berth,normalized_berth:berth});
const unknownRow=(raw='미검증부두',id='202609140008',agency='협운해운(주)')=>({...row('UNKNOWN',id,agency),raw_berth:raw,berth_verified:false});
async function observe(rows:any[]|null,hash?:string){const id=crypto.randomUUID(),at=now();const b=await rpc('jstt_begin',[id,false,false,at]);expect(b.skip).toBeUndefined();await db.query('update jstt_monitor_control set lease_until=now()+interval \'1 day\'');await rpc('jstt_claim',[id]);const result=await rpc('jstt_apply',[id,b.version,hash??String(tick).padStart(64,'0'),rows,123,100,at]);await rpc('jstt_settle',[id,4096]);return result;}
const events=async()=> (await db.query<any>('select event_type,old_berth,new_berth,revision from jstt_berth_events order by detected_at,revision')).rows;
beforeAll(async()=>{db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const f of ['20260920000000_ulsan_pilot_watcher','20260920000300_hpbot_operations','20260920000400_hpbot_telegram','20260920000500_hpbot_query_context','20260920000600_hpbot_mooring','20260920000700_pilot_registration','20260920000900_pilot_miniapp','20260920001100_pilot_copy_registration','20260920001200_pilot_budget_settlement','20260920001300_pilot_pob_date_labels','20260921001700_jstt_berth_monitor','20260921001800_jstt_run_measurement'])await db.exec(readFileSync('supabase/migrations/'+f+'.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260921001900_jstt_twenty_minute_schedule.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260921002000_jstt_observed_requested_status.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260921002100_jstt_partial_range_guard.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260921002200_jstt_observed_modified_request.sql','utf8'));
 for(const f of ['20260921001500_pilot_pob_identity','20260921001600_pilot_concise_notifications','20260922002400_pilot_notification_policy','20260922002500_pilot_event_titles'])await db.exec(readFileSync('supabase/migrations/'+f+'.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260922003200_jstt_berth_quarantine.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260922003300_jstt_failure_collection_label.sql','utf8'));
 for(const f of ['20260922003400_pilot_event_presentation','20260922003500_pilot_query_presentation'])await db.exec(readFileSync('supabase/migrations/'+f+'.sql','utf8'));
},30000);
afterAll(async()=>await db?.close());
it('failure message labels last collection without claiming all berths were verified',async()=>{
 const definition=(await db.query<any>("select pg_get_functiondef('public.jstt_fail(uuid,text,timestamptz)'::regprocedure) v")).rows[0].v;
 expect(definition).toContain('마지막 수집: ');expect(definition).not.toContain('마지막 정상확인: ');
});
beforeEach(async()=>{tick=0;await db.exec(`truncate jstt_berth_events,jstt_schedule_delivery,jstt_schedule_state,jstt_vessel_watchlist,jstt_monitor_runs,jstt_budget_reservations,jstt_ui_requests,pilot_telegram_updates,pilot_notifications,pilot_notification_attempts,pilot_usage cascade;
delete from pilot_watcher_control;insert into pilot_watcher_control(id,enabled,billing_verified_at,cycle_start,cycle_end)values(true,true,now(),'2000-01-01','2100-01-01');
delete from jstt_monitor_control;insert into jstt_monitor_control(id,enabled,billing_verified_at)values(true,true,now());
insert into pilot_telegram_chats(chat_id)values('-1')on conflict do nothing;update hpbot_control set primary_chat_id='-1';`);});
it.each(['요청','수정요청'])('observed %s status is accepted without changing unassigned/event semantics',async(status)=>{
 await observe([{...row(),source_status:status}]);expect(await events()).toHaveLength(0);
 await observe([{...row('N3'),source_status:status}]);expect(await events()).toHaveLength(1);
});
it('scheduled JSTT runs only at 00/20/40; manual uses original lease/cooldown path',async()=>{
 for(const minute of [0,1,19,20,21,39,40,41,59]){
  const at=`2026-09-21T03:${String(minute).padStart(2,'0')}:05Z`;
  expect(await rpc('jstt_collection_due',[false,at])).toBe(minute%20===0);
  expect(await rpc('jstt_collection_due',[true,at])).toBe(true);
 }
 const def=(await db.query<any>("select pg_get_functiondef('public.jstt_dispatch(boolean)'::regprocedure) v")).rows[0].v;
 expect(def).toContain('NOT_DUE');expect(def).toContain('jstt_dispatch_before_twenty_minutes');
});
it('bootstrap, unchanged, repeated cycles, release and reassignment produce one event per transition',async()=>{
 for(const b of ['UNASSIGNED','N4','N4','N3','N3','N4','N3','UNASSIGNED','UNASSIGNED','N5'])await observe([row(b)]);
 expect((await events()).map(e=>e.event_type)).toEqual(['INITIAL_ASSIGNED','BERTH_CHANGED','BERTH_CHANGED','BERTH_CHANGED','BERTH_UNASSIGNED','REASSIGNED']);
 expect((await events()).map(e=>Number(e.revision))).toEqual([1,2,3,4,5,6]);
});
it('already assigned bootstrap once; ETA/date changes and hash fast path do not replay',async()=>{
 await observe([row('N4')]);await observe([{...row('N4'),schedule_datetime:'2026-09-24 08:00'}],'a'.repeat(64));await observe(null,'a'.repeat(64));expect(await events()).toHaveLength(1);
 await observe([row('N4'),row('N3','202609220001')]);expect(await events()).toHaveLength(2);
});
it('other agencies are ignored until exact agency/name or any-agency watch added',async()=>{
 await observe([row('N3','202609140008','OTHER AGENCY')]);expect(await events()).toHaveLength(0);
 await db.exec("insert into jstt_vessel_watchlist(chat_id,agency_name,vessel_name,normalized_vessel_name,created_by_telegram_id)values('-1',null,'ARGENT IRIS','ARGENT IRIS',1)");
 await observe([row('N3','202609140008','OTHER AGENCY')]);expect(await events()).toHaveLength(1);
 await db.exec('update jstt_vessel_watchlist set enabled=false');await observe([row('N3','202609140008','OTHER AGENCY')]);
 await db.exec('update jstt_vessel_watchlist set enabled=true');await observe([row('N3','202609140008','OTHER AGENCY')]);expect(await events()).toHaveLength(1);
});
it('automatic Hyopu omits agency text, watchlisted other agency retains it in body',async()=>{
 await db.exec("insert into jstt_vessel_watchlist(chat_id,agency_name,vessel_name,normalized_vessel_name,created_by_telegram_id)values('-1',null,'OTHER SHIP','OTHER SHIP',1)");
 await observe([row('N3'),{...row('N4','202609220001','윌헴슨'),vessel_name:'OTHER SHIP'}]);
 const message=(await db.query<any>('select message from pilot_notifications')).rows.map(r=>r.message).join('\n');
 expect(message).not.toContain('협운');expect(message).toContain('대리점: 윌헴슨');expect(message.split('\n')[0]).toBe('⚓ [JSTT 부두 배정]');
});
it('missing is not release; unchanged missing snapshot advances confirmation; departed excluded',async()=>{
 const other=row('UNASSIGNED','202609220001','협운');
 await observe([row('N4'),other]);await observe([other],'b'.repeat(64));await observe(null,'b'.repeat(64));expect(await events()).toHaveLength(1);
 expect((await db.query<any>("select lifecycle from jstt_schedule_state where schedule_key='202609140008'")).rows[0].lifecycle).toBe('MISSING');
 await observe([{...row('N4'),source_status:'이안'}]);expect(await events()).toHaveLength(1);
 expect((await db.query<any>("select lifecycle from jstt_schedule_state where schedule_key='202609140008'")).rows[0].lifecycle).toBe('ARCHIVED');
});
it('31 to 13 partial-range results never overwrite a good snapshot even on repeated identical hashes',async()=>{
 const all=Array.from({length:31},(_,i)=>({...row('UNASSIGNED',String(202609210001+i),'협운'),schedule_datetime:i<13?'2026-09-21 08:00':'2026-09-26 08:00',source_status:i===0?'이안':'계획'}));
 await observe(all,'a'.repeat(64));
 for(let i=0;i<3;i++)expect(await observe(all.slice(0,13),'b'.repeat(64))).toMatchObject({accepted:false,error:'JSTT_PARTIAL_RANGE'});
 expect((await db.query<any>('select count(*) n from jstt_schedule_state where missing_count>0')).rows[0].n).toBe(0);
 expect((await db.query<any>('select last_hash from jstt_monitor_control')).rows[0].last_hash).toBe('a'.repeat(64));
 expect(await events()).toHaveLength(0);expect((await observe(all,'a'.repeat(64))).accepted).toBe(true);
});
it('repeated empty result is not a complete removal and date-window rollover is not a false drop',async()=>{
 await observe([row('N4')]);for(let i=0;i<2;i++)expect((await observe([],'b'.repeat(64))).accepted).toBe(false);
 expect((await db.query<any>('select missing_count from jstt_schedule_state')).rows[0].missing_count).toBe(0);
 await db.exec("update jstt_schedule_state set schedule_datetime='2026-09-20 08:00'");
 expect((await observe([],'c'.repeat(64))).accepted).toBe(true);
});
it('same slot/repeated claim, stale version and delayed worker cannot double apply',async()=>{
 const id=crypto.randomUUID(),at=now();const b=await rpc('jstt_begin',[id,false,false,at]);
 expect((await rpc('jstt_begin',[crypto.randomUUID(),false,false,at])).skip).toBe('JOINED');
 await db.exec("update jstt_monitor_control set lease_until=now()+interval '1 day'");expect(await rpc('jstt_claim',[id])).not.toBeNull();expect(await rpc('jstt_claim',[id])).toBeNull();
 expect((await rpc('jstt_apply',[id,b.version+1,'a'.repeat(64),[row('N4')],0,0,at])).accepted).toBe(false);
 expect((await rpc('jstt_apply',[id,b.version,'a'.repeat(64),[row('N4')],0,0,at])).accepted).toBe(true);
 expect((await rpc('jstt_apply',[id,b.version,'a'.repeat(64),[row('N4')],0,0,at])).accepted).toBe(false);
});
it('JSTT budget stop preserves global bot and never automatically resumes',async()=>{
 await db.exec("insert into pilot_usage values('day:2026-09-21',20970000,now())");
 expect((await rpc('jstt_begin',[crypto.randomUUID(),false,false,now()])).skip).toBe('BUDGET');
 expect((await db.query<any>('select enabled from pilot_watcher_control')).rows[0].enabled).toBe(true);
 expect((await rpc('jstt_begin',[crypto.randomUUID(),false,false,now()])).skip).toBe('DISABLED');
});
it('watchlist UI idempotency, exact normalization, authorization and soft-delete',async()=>{
 const id=crypto.randomUUID();expect(await rpc('jstt_ui_begin',[id,'-1',123])).toBe(true);
 const added=await rpc('jstt_watch_change',[id,'add','  future  ship  ',null]);expect(added.changed).toBe(true);
 expect(await rpc('jstt_watch_change',[id,'add','WRONG',null])).toEqual(added);
 expect((await db.query<any>('select normalized_vessel_name from jstt_vessel_watchlist')).rows[0].normalized_vessel_name).toBe('FUTURE SHIP');
 expect(await rpc('jstt_ui_begin',[crypto.randomUUID(),'-other',123])).toBe(false);
 const remove=crypto.randomUUID();await rpc('jstt_ui_begin',[remove,'-1',123]);await rpc('jstt_watch_change',[remove,'remove',null,null,added.id]);expect((await db.query<any>('select enabled from jstt_vessel_watchlist')).rows[0].enabled).toBe(false);
});
it('dedupe/outbox/RLS persist outside process memory',async()=>{
 await observe([row('N4')]);expect((await db.query('select * from pilot_notifications')).rows).toHaveLength(1);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await expect(rpc('jstt_read',['-1'])).rejects.toThrow('permission denied');await expect(db.query('select * from jstt_schedule_state')).rejects.toThrow('permission denied');await db.exec('reset role');}
});
it('five failures alert once; recovery preserves berth and emits recovery once',async()=>{
 await observe([row('N4')]);
 for(let i=0;i<7;i++){const id=crypto.randomUUID(),at=now();await rpc('jstt_begin',[id,false,false,at]);await rpc('jstt_fail',[id,'JSTT_AUTH_EXPIRED',at]);await rpc('jstt_settle',[id,4096]);}
 expect((await db.query<any>("select count(*) n from pilot_notifications where notification_type='JSTT_ERROR'")).rows[0].n).toBe(1);
 expect((await db.query<any>('select normalized_berth from jstt_schedule_state')).rows[0].normalized_berth).toBe('N4');
 await observe([row('N4')]);await observe([row('N4')]);expect(await events()).toHaveLength(1);
 expect((await db.query<any>("select count(*) n from pilot_notifications where notification_type='JSTT_RECOVERY'")).rows[0].n).toBe(1);
});
it('probe previews bootstrap but does not mutate source, outbox, cursor or health',async()=>{
 const id=crypto.randomUUID(),at=now(),b=await rpc('jstt_begin',[id,false,true,at]);await db.exec("update jstt_monitor_control set lease_until=now()+interval '1 day'");await rpc('jstt_claim',[id]);
 const preview=await rpc('jstt_apply',[id,b.version,'a'.repeat(64),[row('N4')],100,123,at]);expect(preview.events).toHaveLength(1);
 expect(await events()).toHaveLength(0);expect((await db.query('select * from jstt_schedule_state')).rows).toHaveLength(0);
 expect((await db.query('select * from pilot_notifications')).rows).toHaveLength(0);
 expect((await db.query<any>('select last_success,version from jstt_monitor_control')).rows[0]).toEqual({last_success:null,version:0});
});
it('Hyopu plus watchlist dedupes, wrong agency does not match, pre-added vessel later appears',async()=>{
 await db.exec("insert into jstt_vessel_watchlist(chat_id,agency_name,vessel_name,normalized_vessel_name,created_by_telegram_id) values('-1','협운해운(주)','ARGENT IRIS','ARGENT IRIS',1),('-1','협운','FUTURE SHIP','FUTURE SHIP',1)");
 await observe([row('N4'),{...row('N3','202609220001','윌헴슨'),vessel_name:'FUTURE SHIP'}]);expect(await events()).toHaveLength(1);
 await observe([row('N4'),{...row('N3','202609220001','협운'),vessel_name:'FUTURE SHIP'}]);expect(await events()).toHaveLength(2);
});
it('settlement is idempotent and charging an overrun stops only JSTT',async()=>{
 const id=crypto.randomUUID();expect(await rpc('jstt_reserve',[id,65536])).toBe(true);await rpc('jstt_settle',[id,4000]);const first=await db.query('select scope,estimated_bytes from pilot_usage order by scope');
 await rpc('jstt_settle',[id,10]);expect((await db.query('select scope,estimated_bytes from pilot_usage order by scope')).rows).toEqual(first.rows);
 const second=crypto.randomUUID();await rpc('jstt_reserve',[second,2048]);await rpc('jstt_settle',[second,4096]);
 expect((await db.query<any>('select enabled from jstt_monitor_control')).rows[0].enabled).toBe(false);expect((await db.query<any>('select enabled from pilot_watcher_control')).rows[0].enabled).toBe(true);
});
it('normal execution requires separate JSTT billing verification; probes remain bounded',async()=>{
 await db.exec('update jstt_monitor_control set billing_verified_at=null');expect((await rpc('jstt_begin',[crypto.randomUUID(),false,false,now()])).skip).toBe('BILLING_REQUIRED');
 expect((await rpc('jstt_begin',[crypto.randomUUID(),false,true,now()])).skip).toBeUndefined();
});
it('accepts live-observed 4부두 and preserves event semantics',async()=>{
 await observe([row()]);await observe([{...row('4부두'),berth_verified:true}]);await observe([row('4부두')]);
 expect((await events()).map(e=>e.new_berth)).toEqual(['4부두']);
});
it('unverified other-agency row is quarantined while a valid Hyopu assignment progresses',async()=>{
 const result=await observe([row('N4'),unknownRow('새 부두','202609220099','다른대리점')]);
 expect(result).toMatchObject({accepted:true,quality:'DEGRADED',quality_status:'DEGRADED',unknown_count:1,events:1});
 expect((await events()).map(e=>e.new_berth)).toEqual(['N4']);
 const health=await rpc('jstt_read',['-1','health']);expect(health).toMatchObject({failure_count:0,last_error:null,unknown_count:1,last_warning:'JSTT_BERTH_UNVERIFIED',quality:'DEGRADED',quality_status:'DEGRADED'});
});
it('N4 to unknown preserves trusted berth/cursor, presence and hash-fast-path quality',async()=>{
 await observe([row('N4')]);
 const trusted=(await db.query<any>('select last_verified_at from jstt_schedule_state')).rows[0].last_verified_at;
 await observe([unknownRow('')],'a'.repeat(64));await observe(null,'a'.repeat(64));
 expect(await events()).toHaveLength(1);
 expect((await db.query<any>('select raw_berth,normalized_berth,observed_raw_berth,berth_verified,last_verified_at,missing_count,lifecycle from jstt_schedule_state')).rows[0]).toEqual({raw_berth:'N4',normalized_berth:'N4',observed_raw_berth:'',berth_verified:false,last_verified_at:trusted,missing_count:0,lifecycle:'ACTIVE'});
 expect((await db.query<any>('select last_berth,event_revision from jstt_schedule_delivery')).rows[0]).toMatchObject({last_berth:'N4',event_revision:1});
 expect((await rpc('jstt_read',['-1'])).rows[0]).toMatchObject({observed_raw_berth:'',berth_verified:false,normalized_berth:'N4'});
 expect(await rpc('jstt_read',['-1','health'])).toMatchObject({unknown_count:1,quality:'DEGRADED'});
 await observe([row('N4')]);expect(await events()).toHaveLength(1);
 await observe([unknownRow('J3')]);await observe([row('N3')]);
 expect((await events()).map(e=>[e.old_berth,e.new_berth])).toEqual([[null,'N4'],['N4','N3']]);
});
it('new unknown creates no delivery cursor; later verified berth bootstraps once',async()=>{
 await observe([unknownRow('TBA')]);expect(await events()).toHaveLength(0);
 expect((await db.query('select * from jstt_schedule_delivery')).rows).toHaveLength(0);
 expect((await db.query<any>('select normalized_berth,last_verified_at from jstt_schedule_state')).rows[0]).toEqual({normalized_berth:'UNKNOWN',last_verified_at:null});
 await observe([row('4부두')]);await observe([row('4부두')]);
 expect((await events()).map(e=>e.event_type)).toEqual(['INITIAL_ASSIGNED']);
});
it('unverified departed row archives without release and cannot block other schedules',async()=>{
 await observe([row('N4')]);
 expect(await observe([{...unknownRow('-'),source_status:'이안'},row('N3','202609220002')])).toMatchObject({unknown_count:0,quality_status:'HEALTHY'});
 expect((await events()).map(e=>e.event_type)).toEqual(['INITIAL_ASSIGNED','INITIAL_ASSIGNED']);
 expect((await db.query<any>("select lifecycle,missing_count,normalized_berth from jstt_schedule_state where schedule_key='202609140008'")).rows[0]).toEqual({lifecycle:'ARCHIVED',missing_count:0,normalized_berth:'N4'});
 expect(await rpc('jstt_read',['-1','health'])).toMatchObject({unknown_count:0,last_warning:null,quality_status:'HEALTHY'});
 const run=(await db.query<any>('select warnings,unknown_count from jstt_monitor_runs order by started_at desc limit 1')).rows[0];expect(run.unknown_count).toBe(0);expect(run.warnings).toHaveLength(1);
});
it('five-failure outage only recovers once after a fully verified snapshot',async()=>{
 await observe([row('N4')]);
 for(let i=0;i<5;i++){const id=crypto.randomUUID(),at=now();await rpc('jstt_begin',[id,false,false,at]);await rpc('jstt_fail',[id,'JSTT_BERTH_UNKNOWN',at]);await rpc('jstt_settle',[id,4096]);}
 await observe([unknownRow('J3')],'a'.repeat(64));await observe(null,'a'.repeat(64));
 expect((await db.query<any>('select failure_count,recovery_pending,unknown_count from jstt_monitor_control')).rows[0]).toEqual({failure_count:0,recovery_pending:true,unknown_count:1});
 expect((await db.query("select * from pilot_notifications where notification_type='JSTT_RECOVERY'")).rows).toHaveLength(0);
 await observe([row('N4')]);await observe([row('N4')]);
 expect((await db.query("select * from pilot_notifications where notification_type='JSTT_RECOVERY'")).rows).toHaveLength(1);
 expect((await db.query<any>('select recovery_pending,outage_id,unknown_count,last_warning from jstt_monitor_control')).rows[0]).toEqual({recovery_pending:false,outage_id:null,unknown_count:0,last_warning:null});
 expect(await rpc('jstt_read',['-1','health'])).toMatchObject({quality_status:'HEALTHY'});
 expect(await events()).toHaveLength(1);
});
it('quarantine uses the latest verified hash-hit timestamp, but never a missing observation',async()=>{
 await observe([row('N4')],'a'.repeat(64));await observe(null,'a'.repeat(64));await observe(null,'a'.repeat(64));
 const priorSuccess=(await db.query<any>('select last_success from jstt_monitor_control')).rows[0].last_success;
 await observe([unknownRow('?')]);
 expect((await db.query<any>('select last_verified_at from jstt_schedule_state')).rows[0].last_verified_at).toEqual(priorSuccess);
 await observe([row('N4')]);
 const verified=(await db.query<any>('select last_verified_at from jstt_schedule_state')).rows[0].last_verified_at;
 const other=row('N3','202609220002','협운');await observe([other]);await observe([other]);
 await observe([unknownRow('?'),other]);
 expect((await db.query<any>("select last_verified_at from jstt_schedule_state where schedule_key='202609140008'")).rows[0].last_verified_at).toEqual(verified);
});
it('complete 31-row snapshot with 18 quarantined berths is not a partial-range loss',async()=>{
 const all=Array.from({length:31},(_,i)=>row('N4',String(202609210001+i),'협운'));
 await observe(all);expect((await observe(all.map((r,i)=>i<13?r:unknownRow('?',r.schedule_key,'협운')))).accepted).toBe(true);
 expect((await db.query<any>('select count(*) n from jstt_schedule_state where missing_count>0')).rows[0].n).toBe(0);
 expect((await db.query<any>('select unknown_count from jstt_monitor_control')).rows[0].unknown_count).toBe(18);
 const run=(await db.query<any>('select warnings from jstt_monitor_runs order by started_at desc limit 1')).rows[0];expect(run.warnings).toHaveLength(10);
});
it.each([
 ()=>({...unknownRow(),berth_verified:true}),
 ()=>({...unknownRow(),berth_verified:undefined}),
 ()=>unknownRow('대기'),()=>unknownRow('4부두'),
 ()=>({...row('N4'),berth_verified:false}),
 ()=>({...row('N4'),raw_berth:'new-raw'}),
 ()=>({...row('NEW-BERTH'),berth_verified:true}),
 ()=>({...unknownRow(),raw_berth:'a'.repeat(161)}),
 ()=>({...unknownRow(),raw_berth:'bad\nraw'}),
])('rejects inconsistent or untrusted berth evidence without modifying source',async(makeRow)=>{
 await expect(observe([makeRow()])).rejects.toThrow();
 expect((await db.query('select * from jstt_schedule_state')).rows).toHaveLength(0);expect(await events()).toHaveLength(0);
});
it('duplicate IDs across verified/quarantined rows remain a fatal snapshot violation',async()=>{
 await expect(observe([row('N4'),unknownRow('J3')])).rejects.toThrow('JSTT_ROWS_INVALID');
 expect((await db.query('select * from jstt_schedule_state')).rows).toHaveLength(0);
});
it('quarantine probe returns bounded diagnostics without source/cursor/health/outbox writes',async()=>{
 const id=crypto.randomUUID(),at=now(),b=await rpc('jstt_begin',[id,false,true,at]);await db.exec("update jstt_monitor_control set lease_until=now()+interval '1 day'");await rpc('jstt_claim',[id]);
 const preview=await rpc('jstt_apply',[id,b.version,'a'.repeat(64),[row('N4'),unknownRow('J3','202609220002')],100,123,at]);
 expect(preview).toMatchObject({accepted:true,quality:'DEGRADED',unknown_count:1});expect(preview.events).toHaveLength(1);expect(preview.warnings).toHaveLength(1);
 for(const table of ['jstt_schedule_state','jstt_schedule_delivery','jstt_berth_events','pilot_notifications'])expect((await db.query('select * from '+table)).rows).toHaveLength(0);
 expect((await db.query<any>('select unknown_count,last_warning,last_success,version from jstt_monitor_control')).rows[0]).toEqual({unknown_count:0,last_warning:null,last_success:null,version:0});
});
