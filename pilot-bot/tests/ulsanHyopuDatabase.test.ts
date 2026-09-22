// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
let db:PGlite;
const at=(n:number)=>new Date(Date.UTC(2026,8,20,0,n)).toISOString();
const app=(id='1',status='020',extra={})=>({application_id:id,vessel_name:`SHIP ${id}`,callsign:`CALL${id}`,pilot_date:'2026-09-20',pilot_time:'12:00',from_location:'P/S',to_location:'OTK(S)',application_status:status,agent:'협운',remarks:'',...extra});
const forecast=(id='1',status='BAD_WEATHER',extra={})=>({identity:`public${id}`,vessel_name:`SHIP ${id}`,callsign:`CALL${id}`,pilot_date:'2026-09-20',pilot_time:'12:00',from_location:'P/S',to_location:'OTK(S)',agent:'협운',status,raw_status:status,remarks:'',cancelled:false,...extra});
const ranges=[{start:'1900-01-01',end:'9999-12-31'}];
async function rpc(name:string,args:unknown[]=[]){return (await db.query<{v:any}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) v`,args)).rows[0].v;}
const j=JSON.stringify;
async function plan(old:any[],apps:any[],f:any[]=[],cont=true,baseline=false){return rpc('hpbot_plan',[j(old),j(apps),j(f),j(ranges),cont,baseline,at(1)]);}
let hashes=0;
async function tick(n:number,apps:any[]|null,f:any[]|null){
 const b=await rpc('hpbot_begin',[at(n)]); if(!b.token)return b;
 return rpc('hpbot_commit',[b.token,b.version,apps?(++hashes).toString(16).padStart(64,'0'):b.application_hash,f?(++hashes).toString(16).padStart(64,'0'):b.forecast_hash,apps?j(apps):null,f?j(f):null,j(ranges),null,null,1000,at(n)]);
}
beforeAll(async()=>{db=new PGlite();await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
 await db.exec(readFileSync('supabase/migrations/20260920000000_ulsan_pilot_watcher.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260920000300_hpbot_operations.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260920000400_hpbot_telegram.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260920000500_hpbot_query_context.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260920000600_hpbot_mooring.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260920001000_pilot_registration_status.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260920001300_pilot_pob_date_labels.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260921001500_pilot_pob_identity.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260921001600_pilot_concise_notifications.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260922002400_pilot_notification_policy.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260922002500_pilot_event_titles.sql','utf8'));
},30000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec(`truncate pilot_schedule_notification_events,pilot_schedule_notification_revisions,pilot_telegram_updates,pilot_telegram_confirmations,pilot_telegram_chats,hpbot_pilot_current,hpbot_pilot_history,hpbot_source_snapshots,hpbot_collection_ranges,pilot_monitor_logs,pilot_notifications,pilot_notification_attempts,pilot_weather_events,pilot_snapshots,pilot_runs,pilot_usage;
 delete from pilot_watcher_control;insert into pilot_watcher_control(id,enabled,billing_verified_at,cycle_start,cycle_end) values(true,true,'2026-09-01','2000-01-01','2100-01-01');
 delete from pilot_weather_state;insert into pilot_weather_state(id) values(true);delete from hpbot_control;insert into hpbot_control(id,alerts_enabled,bootstrap_done) values(true,true,true);`);hashes=0;});
describe('login truth reducer',()=>{
 it('bundles simultaneous changes into one concise vessel block with exact remark before/after',async()=>{
   const a=app('1','020',{remarks:'접안 전 연락',mooring_name:'글로'});
   const p=await plan([a],[{...a,application_status:'030',pilot_time:'14:00',to_location:'JSTT',remarks:'접안 후 연락'}]);
   const messages=await rpc('hpbot_schedule_messages',[j(p.changes)]);
   expect(messages).toHaveLength(1);const text=messages[0];
   expect(text.split('SHIP 1')).toHaveLength(2);
   expect(text).toContain('일시: 09/20(일) 1200 → 09/20(일) 1400');
   expect(text).toContain('구간: P/S → OTK(S) ⇒ P/S → JSTT');
   expect(text).not.toContain('신청:');expect(text).toContain('강취: 글로');expect(text).toContain('SHIP 1 — 일정 변경');
   expect(text).toContain('비고: 접안 전 연락 → 접안 후 연락');
 });
 it.each([['','검역 후 승선','없음 → 검역 후 승선'],['검역 후 승선','','검역 후 승선 → 없음'],[null,'새 비고','미확인 → 새 비고']])('shows remark addition/removal/missing evidence accurately: %s',async(before,after,expected)=>{
   const p=await plan([app('1','020',{remarks:before})],[app('1','020',{remarks:after})]);
   expect((await rpc('hpbot_schedule_messages',[j(p.changes)])).join('\n')).toContain(`비고: ${expected}`);
 });
 it('shows current remarks on NEW/cancel/complete and respects notification settings',async()=>{
   for(const type of ['NEW','CANCELLED','COMPLETED']){
    const ch={type,old:type==='NEW'?null:app(),new:app('1',type==='CANCELLED'?'090':type==='COMPLETED'?'050':'040',{remarks:'승선 전 연락',mooring_name:'진산'})};
    const text=(await rpc('hpbot_schedule_messages',[j([ch])])).join('\n');
    expect(text).toContain('비고:');expect(text).toContain('승선 전 연락');expect(text).toContain('강취: 진산');
   }
   await db.exec(`insert into pilot_telegram_chats(chat_id,settings) values('-1','{"REMARK_CHANGED":false}');update hpbot_control set primary_chat_id='-1'`);
   const ch={type:'REMARK_CHANGED',old:app(),new:app('1','020',{remarks:'changed'})};
   expect(await rpc('hpbot_filter_notifications',[j([ch])])).toEqual([]);
 });
 it('splits long remarks without losing the old/new text or exceeding Telegram/outbox limits',async()=>{
   const before='가'.repeat(1990)+'OLD_END',after='🚢'.repeat(1900)+'NEW_END';
   const messages=await rpc('hpbot_schedule_messages',[j([{type:'REMARK_CHANGED',old:app('1','020',{remarks:before}),new:app('1','020',{remarks:after})}])]);
   expect(messages.length).toBeGreaterThan(1);
   expect(messages.every((m:string)=>m.length<=4096&&Array.from(m).length<=2800)).toBe(true);
   const joined=messages.map((m:string)=>m.split('\n').slice(1).join('\n')).join('');
   expect(joined).toContain(`비고: ${before} → ${after}`);
   expect(messages.some((m:string)=>m.endsWith('[협운 도선일정 변경]'))).toBe(false);
 });
 it('never groups separate movements of the same vessel',async()=>{
   const changes=[1,2].map(id=>({type:'NEW',old:null,new:app(String(id),'010',{vessel_name:'SAME SHIP'})}));
   expect((await rpc('hpbot_schedule_messages',[j(changes)])).join('\n').split('SAME SHIP')).toHaveLength(3);
 });
 it('operational notices explain evidence/action while preserving unique keys and cost bounds',async()=>{
   await tick(0,[app()],[]);
   for(let i=1;i<=5;i++){const b=await rpc('hpbot_begin',[at(i)]);await rpc('pilot_fail',[b.token,'ACTIVE_APPLICATION_ID_MISSING',at(i)]);}
   const errors=await db.query<{message:string}>("select message from pilot_notifications where notification_type='SOURCE_ERROR'");
   expect(errors.rows).toHaveLength(1);expect(errors.rows[0].message).toContain('연속 실패: 5회');expect(errors.rows[0].message).toContain('ACTIVE_APPLICATION_ID_MISSING');expect(errors.rows[0].message).toContain('마지막 정상:');
   const cost=await rpc('pilot_operational_message',['COST_STOP','⚠️ 비용 보호 중지']);
   expect(cost).toContain('하루 24MiB / 주기 512MiB');expect(cost).toContain('수동 재개');expect(new TextEncoder().encode(cost).length).toBeLessThan(2048);
   expect(await rpc('pilot_operational_message',['COMMAND_REPLY','unchanged'])).toBe('unchanged');
 });
 it('live ID-less POB shape reconciles once after collection failure, without false weather recovery',async()=>{
   const a=app('202614303','030',{vessel_name:'GINGA TIGER',callsign:'S6SZ7',pilot_date:'2026-09-21',pilot_time:'09:30',to_location:'SOILG-3',mooring_name:'글로'});
   const f=forecast('1','BAD_WEATHER',{vessel_name:a.vessel_name,callsign:a.callsign,pilot_date:a.pilot_date,to_location:a.to_location});
   await tick(0,[a],[f,forecast('2')]);await tick(1,null,null);
   const b=await rpc('hpbot_begin',[at(2)]);await rpc('pilot_fail',[b.token,'ACTIVE_APPLICATION_ID_MISSING',at(2)]);
   const pob={...a,application_id:null,application_status:'040',raw_application_status:'POB'};
   await tick(3,[pob],[{...f,status:'PROCESSING'},forecast('2')]);
   await tick(4,null,null);await tick(5,[pob],[{...f,status:'PROCESSING'},forecast('2')]);
   const q=(await db.query('select application_id,application_status,completion_status,data from hpbot_pilot_current')).rows[0] as any;
   expect(q).toMatchObject({application_id:a.application_id,application_status:'040',completion_status:'ACTIVE'});
   expect(q.data.application_identity_basis).toBe('POB_UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE');
   expect(q.data.missing_count).toBe(0);
   const notices=await db.query<{notification_type:string;message:string}>('select notification_type,message from pilot_notifications');
   expect(notices.rows.filter(n=>n.message.includes('공개: POB'))).toHaveLength(1);
   expect(notices.rows.filter(n=>n.notification_type==='WEATHER_RESUME')).toHaveLength(0);
   expect((await db.query('select status from pilot_weather_state')).rows[0].status).toBe('SUSPENDED');
   expect((await db.query("select event_type from hpbot_pilot_history")).rows.map(r=>r.event_type)).toEqual(['STATUS_CHANGED']);
 });
 it('ID-less POB retains identity through time changes but never guesses date/route/callsign',async()=>{
   const p=await plan([app()],[app('1','040',{application_id:null,pilot_time:'14:00'})]);
   expect(p.rows[0].application_id).toBe('1');expect(p.changes.map((c:any)=>c.type)).toEqual(['TIME_CHANGED','STATUS_CHANGED']);
   for(const field of ['callsign','vessel_name','pilot_date','from_location','to_location']){
     await expect(plan([app()],[app('1','040',{application_id:null,[field]:'OTHER'})])).rejects.toThrow('POB_IDENTITY_UNRESOLVED');
   }
 });
 it('ambiguous, new or terminal-only ID-less POB fails closed instead of inventing identity or cancelling',async()=>{
   const pob=app('1','040',{application_id:null});
   await expect(plan([], [pob])).rejects.toThrow('POB_IDENTITY_UNRESOLVED');
   await expect(plan([app(),app('2','020',{vessel_name:'SHIP 1',callsign:'CALL1'})],[pob])).rejects.toThrow('POB_IDENTITY_UNRESOLVED');
   await expect(plan([app()],[pob,pob])).rejects.toThrow('POB_IDENTITY_UNRESOLVED');
   await expect(plan([app()],[pob,app()])).rejects.toThrow('POB_IDENTITY_UNRESOLVED');
   for(const status of ['050','060','090'])await expect(plan([app('1',status)],[pob])).rejects.toThrow('POB_IDENTITY_UNRESOLVED');
   await expect(plan([app()],[{...pob,agent:'OTHER'}])).rejects.toThrow('POB_IDENTITY_INVALID');
   await expect(plan([app()],[{...pob,callsign:''}])).rejects.toThrow('POB_IDENTITY_INVALID');
 });
 it('ID-less POB can subsequently complete without duplicate POB or false cancellation',async()=>{
   const first=await plan([app()],[app('1','040',{application_id:null})]);
   const second=await plan(first.rows,[app('1','060',{application_id:null})]);
   expect(second.rows[0]).toMatchObject({application_id:'1',completion_status:'COMPLETED'});
   expect(second.changes.map((c:any)=>c.type)).toEqual(['COMPLETED']);
 });
 it('POB transition queues once, retains active status, formats KST date/time and mooring',async()=>{
   const a=app('1','030',{pilot_date:'2026-09-21',pilot_time:'09:30',mooring_name:'글로'});
   await tick(0,[a],[]);await tick(1,[{...a,application_status:'040'}],[]);
   await tick(2,null,null);await tick(3,[{...a,application_status:'040'}],[]);
   const notices=await db.query<{message:string}>("select message from pilot_notifications where notification_type='SCHEDULE_CHANGE'");
   expect(notices.rows).toHaveLength(1);expect(notices.rows[0].message).toContain('공개: POB');
   expect(notices.rows[0].message).toContain('09/21(월) 0930');expect(notices.rows[0].message).toContain('강취: 글로');
   expect((await db.query('select application_status,completion_status from hpbot_pilot_queue')).rows[0]).toMatchObject({application_status:'040',completion_status:'ACTIVE'});
   expect((await db.query("select count(*)::int n from hpbot_pilot_history where event_type='STATUS_CHANGED'")).rows[0].n).toBe(1);
 });
 it('baseline POB never sends a retrospective boarding alert',async()=>{
   await tick(0,[app('1','040')],[]);await tick(1,null,null);
   expect((await db.query('select count(*)::int n from pilot_notifications')).rows[0].n).toBe(0);
 });
 it('PROCESSING alone is not POB; simultaneous POB and weather resume share one receipt',async()=>{
   const a=[app('1','030'),app('2')], f=[forecast(),forecast('2')];
   await tick(0,a,f);await tick(1,null,null);
   await tick(2,[app('1','040'),app('2')],[forecast('1','PROCESSING'),forecast('2')]);
   await tick(3,null,null);
   const notices=await db.query<{notification_type:string;message:string}>('select notification_type,message from pilot_notifications');
   expect(notices.rows.filter(x=>x.notification_type==='WEATHER_RESUME')).toHaveLength(1);
   expect(notices.rows.filter(x=>x.message.includes('공개: POB'))).toHaveLength(1);
   expect(notices.rows.filter(x=>x.notification_type==='SCHEDULE_CHANGE')).toHaveLength(0);
   expect(await rpc('hpbot_is_pob_change',[j({type:'STATUS_CHANGED',old:{application_status:'030'},new:{application_status:'030',forecast_status:'PROCESSING'}})])).toBe(false);
   expect(await rpc('hpbot_is_pob_change',[j({type:'NEW',new:{application_status:'040'}})])).toBe(false);
 });
 it('POB setting defaults on independently of generic status and can be disabled without losing history',async()=>{
   await db.exec(`insert into pilot_telegram_chats(chat_id,settings) values('-1','{"STATUS_CHANGED":false}');update hpbot_control set primary_chat_id='-1'`);
   await tick(0,[app('1','030')],[]);await tick(1,[app('1','040')],[]);
   expect((await db.query("select count(*)::int n from pilot_notifications where notification_type='SCHEDULE_CHANGE'")).rows[0].n).toBe(1);
   await rpc('hpbot_accept_update',[1,'-1',2,'setting']);
   expect(await rpc('hpbot_toggle_setting',[1,'POB'])).toBe(false);
   await tick(2,[app('1','030')],[]);await tick(3,[app('1','040')],[]);
   expect((await db.query("select count(*)::int n from pilot_notifications where notification_type='SCHEDULE_CHANGE'")).rows[0].n).toBe(1);
   expect((await db.query("select count(*)::int n from hpbot_pilot_history where event_type='STATUS_CHANGED'")).rows[0].n).toBe(3);
 });
 it('SQL weekday labels handle all weekdays and KST midnight without changing weather wording',async()=>{
   for(let i=0;i<7;i++)expect(await rpc('pilot_date_label',[`2026-09-${20+i}`,'06:15'])).toBe(`09/${20+i}(${'일월화수목금토'[i]}) 0615`);
   expect(await rpc('pilot_date_label',['2026-09-21',null])).toBe('09/21(월) 시간 미정');
   expect(await rpc('pilot_kst_label',['2026-09-20T15:00:00Z'])).toBe('09/21(월) 0000');
   const message=await rpc('pilot_weather_message',[j({type:'RESUME',method:'HYOPU_TRANSITION',vessel:app('1','040',{pilot_date:'2026-09-21',pilot_time:'09:30',mooring_name:'글로',sequence_no:1})}),j({started_at:at(0)}),'2026-09-21T00:30:00Z']);
   expect(message).toContain('시간: 09/21(월) 0930');expect(message).toContain('재개 감지: 09/21(월) 0930');
   expect(message).toContain('강취: 글로');expect(message).toContain('현재 순번: 1번');expect(message).not.toContain('협운');
 });
 it('registration status includes KST today through day 7; excludes day -1/day 8 and all terminal statuses',async()=>{
   await tick(0,[app('1','020',{pilot_date:'2026-09-19'}),app('2','020',{pilot_time:'00:00',mooring_name:'진산'}),app('3','040',{pilot_date:'2026-09-27'}),app('4','020',{pilot_date:'2026-09-28'}),app('5','050'),app('6','060'),app('7','090')],[]);
   const r=await rpc('hpbot_registration_status',[0,'2026-09-19T15:00:00Z']);
   expect(r.date_from).toBe('2026-09-20');expect(r.date_to).toBe('2026-09-27');expect(r.total).toBe(2);expect(r.rows.map((x:any)=>x.application_id)).toEqual(['2','3']);expect(r.rows[0].mooring_name).toBe('진산');
   expect((await rpc('hpbot_read',['queue'])).total).toBe(4); // internal full queue remains unchanged
 });
 it('registration status pages all records without dropping or duplicating movements',async()=>{
   await tick(0,Array.from({length:23},(_,i)=>app(String(i+1),'020',{pilot_date:'2026-09-22'})),[]);
   const pages=await Promise.all([0,1,2].map(p=>rpc('hpbot_registration_status',[p,at(0)])));
   expect(pages.map(p=>p.rows.length)).toEqual([10,10,3]);expect(new Set(pages.flatMap(p=>p.rows.map((r:any)=>r.application_id))).size).toBe(23);
 });
 it('registration status respects KST midnight and rejects browser execution',async()=>{
   await tick(0,[app('1','020',{pilot_date:'2026-09-19'}),app('2','020',{pilot_date:'2026-09-27'})],[]);
   expect((await rpc('hpbot_registration_status',[0,'2026-09-19T14:59:59Z'])).rows.map((r:any)=>r.application_id)).toEqual(['1']);
   const acl=await db.query<{allowed:boolean}>("select has_function_privilege('anon','public.hpbot_registration_status(integer,timestamptz)','EXECUTE') allowed");expect(acl.rows[0].allowed).toBe(false);
 });
 it('carries verified mooring to queue, change and resume messages without creating a migration alert',async()=>{
   const old=(await plan([],[app()],[],true,true)).rows;
   const p=await plan(old,[app('1','020',{mooring_name:'진산'})],[forecast()]);
   expect(p.changes).toEqual([]);
   expect(p.weather_rows[0].mooring_name).toBe('진산');
   await tick(0,[app('1','020',{mooring_name:'진산'})],[]);
   const queue=await rpc('hpbot_read',['queue',0,'',null]);
   expect(queue.rows[0].mooring_name).toBe('진산');
   const changed=await plan(p.rows,[app('1','020',{pilot_time:'15:00',mooring_name:'글로'})]);
   expect((await rpc('hpbot_schedule_messages',[j(changed.changes)])).join('')).toContain('강취: 글로');
   expect((await rpc('hpbot_schedule_messages',[j([{type:'NEW',new:app()}])])).join('')).not.toContain('강취:');
   const msg=await rpc('pilot_weather_message',[j({type:'RESUME',method:'HYOPU_TRANSITION',vessel:p.weather_rows[0]}),j({started_at:at(0)}),at(1)]);
   expect(msg).toContain('강취: 진산');
 });
 it('normal commit without bootstrap range preserves pending bootstrap',async()=>{
   await db.exec('update hpbot_control set bootstrap_done=false');
   await tick(0,[app()],[]);
   expect((await db.query('select bootstrap_done from hpbot_control')).rows[0].bootstrap_done).toBe(false);
 });
 it('first baseline silent; new jobs only after baseline',async()=>{
   expect((await plan([], [app()],[],true,true)).changes).toEqual([]);
   expect((await plan([], [app()])).changes.map((c:any)=>c.type)).toEqual(['NEW']);
 });
 it.each(['050','060','090'])('terminal %s excludes active queue; unknown/POB/overdue retained',async status=>{
   await tick(0,[app('1',status),app('2','040'),app('3','???'),app('4','020',{pilot_time:'00:00'})],[]);
   expect((await db.query('select application_id from hpbot_pilot_queue order by sequence_no')).rows.map((r:any)=>r.application_id)).toEqual(['4','2','3']);
 });
 it('050 to 060 never creates completion twice',async()=>{
   const p=await plan([app('1','050')],[app('1','060')]);expect(p.changes).toEqual([]);
 });
 it.each(['pilot_time','pilot_date','from_location','to_location'])('detects %s change without changing identity',async field=>{
   const value=field==='pilot_time'?'14:00':field==='pilot_date'?'2026-10-01':'JSTT2';
   const p=await plan([app()],[app('1','020',{[field]:value})]);
   expect(p.changes.map((c:any)=>c.type)).toEqual([field.startsWith('pilot_')?'TIME_CHANGED':'ROUTE_CHANGED']);
 });
 it('sequence shifts alone produce no changes',async()=>{
   const old=(await plan([],[app('1'),app('2')],[],true,true)).rows;
   const p=await plan(old,[app('1','050'),app('2')]);expect(p.changes.map((c:any)=>c.type)).toEqual(['COMPLETED']);
 });
 it('requires two complete consecutive absences; interruption resets',async()=>{
   const first=await plan([app()],[]);expect(first.rows[0].application_status).toBe('020');
   const second=await plan(first.rows,[]);expect(second.rows[0].application_status).toBe('090');
   const interrupted=await plan(first.rows,[],[],false);expect(interrupted.rows[0].application_status).toBe('020');expect(interrupted.rows[0].missing_count).toBe(0);
 });
 it('uniquely attaches ID-less billing to existing job',async()=>{
   const p=await plan([app()],[app('1','060',{application_id:null})]);
   expect(p.rows[0]).toMatchObject({application_id:'1',completion_status:'COMPLETED'});expect(p.changes.map((c:any)=>c.type)).toEqual(['COMPLETED']);
 });
 it('ambiguous terminal evidence keeps both active jobs',async()=>{
   const old=[app(),app('2','020',{vessel_name:'SHIP 1',callsign:'CALL1'})];
   const p=await plan(old,[app('1','060',{application_id:null})]);expect(p.rows.every((r:any)=>r.application_status==='020'&&r.needs_review)).toBe(true);
 });
 it('exact route required; OTK abbreviation cannot match OTK(S)',async()=>{
   expect((await plan([],[app()],[forecast('1','PROCESSING',{to_location:'OTK'})])).rows[0].forecast_status).toBeNull();
 });
 it('same vessel multiple applications are never merged',async()=>{
   const p=await plan([],[app(),app('2','020',{vessel_name:'SHIP 1',callsign:'CALL1'})],[forecast()]);
   expect(p.rows).toHaveLength(2);expect(p.rows.every((r:any)=>r.forecast_status===null)).toBe(true);
 });
 it('cancel-list PROCESSING never maps',async()=>{
   expect((await plan([],[app()],[forecast('1','PROCESSING',{cancelled:true})])).rows[0].forecast_status).toBeNull();
 });
});
describe('Telegram persistence and budgets',()=>{
 it('search context is chat-bound, expires, and stores only explicit accepted searches',async()=>{
   await db.exec("insert into pilot_telegram_chats(chat_id) values('-1'),('-2')");
   await rpc('hpbot_accept_update',[1,'-1',2,'search']);
   expect(await rpc('hpbot_search_context',[1,null,'SHIP A'])).toBe('SHIP A');
   await rpc('hpbot_accept_update',[2,'-2',3,'search']);
   expect(await rpc('hpbot_search_context',[2,1,null])).toBeNull();
   await rpc('hpbot_accept_update',[3,'-1',4,'search']);
   expect(await rpc('hpbot_search_context',[3,1,null])).toBe('SHIP A');
 });
 it('deduplicates update IDs and receipts; queues only once',async()=>{
   await db.exec("insert into pilot_telegram_chats(chat_id) values('-1')");
   expect(await rpc('hpbot_accept_update',[1,'-1',2,'queue'])).toBe(true);
   expect(await rpc('hpbot_accept_update',[1,'-1',2,'queue'])).toBe(false);
   await rpc('hpbot_reply',[1,'hello']);await rpc('hpbot_reply',[1,'again']);
   const n=await rpc('pilot_claim_notification');expect(n.chat_id).toBe('-1');expect(n.message).toBe('hello');
   await rpc('pilot_finish_notification',[n.id,'UNKNOWN',null,'TIMEOUT']);expect(await rpc('pilot_claim_notification')).toBeNull();
 });
 it('settings filter individual events without losing history',async()=>{
   await db.exec(`insert into pilot_telegram_chats(chat_id,settings) values('-1','{"NEW":false,"TIME_CHANGED":true,"COMPLETED":false}');update hpbot_control set primary_chat_id='-1'`);
   const time={type:'TIME_CHANGED',old:app(),new:app('1','020',{pilot_time:'14:00'})};
   const changes=[{type:'NEW'},time,{type:'COMPLETED'}];
   expect(await rpc('hpbot_filter_notifications',[j(changes)])).toEqual([{...time,type:'PILOT_DATETIME_CHANGED'}]);
 });
 it('confirmation belongs to actual sender, expires and cannot bypass cost stop',async()=>{
   await db.exec("insert into pilot_telegram_chats(chat_id) values('-1')");
   await rpc('hpbot_accept_update',[1,'-1',2,'stop']);const token=await rpc('hpbot_prepare_confirmation',[1,'stop']);
   await rpc('hpbot_accept_update',[2,'-1',3,'confirm']);expect(await rpc('hpbot_confirm',[2,token])).toBe('EXPIRED');
   await rpc('hpbot_accept_update',[3,'-1',2,'confirm']);expect(await rpc('hpbot_confirm',[3,token])).toBe('STOP');
   expect((await rpc('hpbot_begin')).skip).toBe('PAUSED');
   await rpc('hpbot_accept_update',[4,'-1',2,'resume']);const resume=await rpc('hpbot_prepare_confirmation',[4,'resume']);
   await db.exec("update pilot_watcher_control set enabled=false,disabled_reason='EGRESS_BUDGET'");
   expect(await rpc('hpbot_confirm',[4,resume])).toBe('COST_BLOCKED');
 });
 it('command burst budget stops only this bot, no new commands accepted',async()=>{
   await db.exec("insert into pilot_telegram_chats(chat_id) values('-1');update pilot_watcher_control set day_limit=32768");
   expect(await rpc('hpbot_accept_update',[1,'-1',2,'queue'])).toBe(true);
   expect(await rpc('hpbot_accept_update',[2,'-1',2,'queue'])).toBe(true);
   expect(await rpc('hpbot_accept_update',[3,'-1',2,'queue'])).toBe(false);
   expect((await db.query('select enabled from pilot_watcher_control')).rows[0].enabled).toBe(false);
   expect((await db.query("select count(*)::int n from pilot_notifications where notification_type='COST_STOP'")).rows[0].n).toBe(1);
 });
});
describe('notification policy: allowed semantic changes only',()=>{
 const notices=async()=> (await db.query<{message:string;notification_type:string;notification_key:string}>('select message,notification_type,notification_key from pilot_notifications order by created_at,id')).rows;
 it.each([['030','020'],['020','030']])('A/B: admin %s -> %s has history but no Telegram/revision',async(from,to)=>{
  await tick(0,[app('1',from)],[forecast('1','UNSPECIFIED')]);await tick(1,[app('1',to)],null);
  expect(await notices()).toEqual([]);
  expect((await db.query("select count(*)::int n from hpbot_pilot_history where event_type='STATUS_CHANGED'")).rows[0].n).toBe(1);
  expect((await db.query('select count(*)::int n from pilot_schedule_notification_events')).rows[0].n).toBe(0);
 });
 it.each([
  ['time',{pilot_time:'07:35'},'시간 변경','PILOT_DATETIME_CHANGED'],
  ['date',{pilot_date:'2026-09-21'},'시간 변경','PILOT_DATETIME_CHANGED'],
  ['route',{to_location:'JSTT'},'구간 변경','ROUTE_CHANGED'],
  ['remark',{remarks:'KEYOUNG STAR 이안 후 / 확정'},'비고 변경','REMARK_CHANGED'],
 ])('C/D/E: %s change creates one semantic event and receipt',async(_,extra,label,event)=>{
  const a=app('1','030',{pilot_time:'07:30',remarks:'KEYOUNG STAR 이안 후'});
  await tick(0,[a],[forecast('1','UNSPECIFIED')]);await tick(1,[{...a,...extra,application_status:'020'}],null);
  const ns=await notices();expect(ns).toHaveLength(1);expect(ns[0].message).toContain(`SHIP 1 — ${label}`);
  expect(ns[0].message).not.toContain('신청:');expect(ns[0].message).not.toContain('공개:');
  const ledger=(await db.query<{changes:any}>('select changes from pilot_schedule_notification_events')).rows;
  expect(ledger).toHaveLength(1);expect(ledger[0].changes.map((c:any)=>c.type)).toEqual([event]);
 });
 it('F: whitespace/NBSP/newline-only remarks create no event',async()=>{
  await tick(0,[app('1','020',{remarks:'KEYOUNG STAR 이안 후'})],[]);
  await tick(1,[app('1','020',{remarks:' \nKEYOUNG\u00a0 STAR   이안 후  '})],null);
  expect(await notices()).toEqual([]);expect((await db.query('select count(*)::int n from hpbot_pilot_history')).rows[0].n).toBe(0);
 });
 it('G: BAD WEATHER -> PROCESSING outside suspension is not suppressed',async()=>{
  await tick(0,[app()],[forecast()]);await tick(1,null,[forecast('1','PROCESSING')]);
  const ns=await notices();expect(ns).toHaveLength(1);expect(ns[0].notification_type).toBe('SCHEDULE_CHANGE');
  expect(ns[0].message).toContain('상태: BAD WEATHER → PROCESSING');expect(ns[0].message).toContain('공개: PROCESSING');
 });
 it('H/I: PROCESSING -> authenticated POB -> explicit blank is two alerts',async()=>{
  await tick(0,[app('1','030')],[forecast('1','PROCESSING')]);
  await tick(1,[app('1','040')],null);await tick(2,[app('1','020')],[forecast('1','UNSPECIFIED')]);
  const ns=await notices();expect(ns).toHaveLength(2);
  expect(ns[0].message).toContain('상태: PROCESSING → POB');expect(ns[0].message).toContain('공개: POB');
  expect(ns[1].message).toContain('상태: POB → 표시 종료');expect(ns[1].message).not.toContain('공개:');
  expect(ns.map(n=>n.message).join()).not.toContain('NORMAL');
 });
 it('public POB is operational too; login 040 is not invented',async()=>{
  await tick(0,[app()],[forecast('1','PROCESSING')]);await tick(1,null,[forecast('1','POB')]);
  expect((await notices())[0].message).toContain('상태: PROCESSING → POB');
  expect((await db.query('select application_status from hpbot_pilot_current')).rows[0].application_status).toBe('020');
 });
 it.each(['PROCESSING','BAD_WEATHER'])('%s -> empty displays end, no public row',async(status)=>{
  await tick(0,[app()],[forecast('1',status)]);await tick(1,null,[forecast('1','UNSPECIFIED')]);
  const ns=await notices();expect(ns).toHaveLength(1);expect(ns[0].message).toContain('→ 표시 종료');expect(ns[0].message).not.toContain('공개:');
 });
 it('J: blank public state never renders public row, including NEW',async()=>{
  await tick(0,[],[]);await tick(1,[app()],[forecast('1','UNSPECIFIED')]);
  const ns=await notices();expect(ns).toHaveLength(1);expect(ns[0].message).not.toContain('공개:');
 });
 it('K: time+route+remark+status yields one block/revision despite admin changes',async()=>{
  const a=app('1','030',{remarks:'KEYOUNG STAR 이안 후'});await tick(0,[a],[forecast()]);
  await tick(1,[{...a,application_status:'020',pilot_time:'14:00',to_location:'JSTT',remarks:'KEYOUNG STAR 이안 후 / 확정'}],[forecast('1','PROCESSING',{to_location:'JSTT'})]);
  const ns=await notices();expect(ns).toHaveLength(1);const text=ns[0].message;
  expect(text.split('SHIP 1')).toHaveLength(2);expect(text).toContain('— 일정 변경');
  for(const key of ['일시:','구간:','비고:','상태:'])expect(text).toContain(key);
  expect(text).toContain('공개: PROCESSING');expect(text).not.toContain('신청:');
  expect((await db.query<{changes:any}>('select changes from pilot_schedule_notification_events')).rows[0].changes).toHaveLength(4);
 });
 it('L: rank, mooring and parser metadata alone create no notification',async()=>{
  const a=[app(),app('2','020',{pilot_time:'13:00'})];await tick(0,a,[]);
  await tick(1,[app('1','050'),{...a[1],mooring_name:'글로',parser_version:'v2'}],null);
  expect(await notices()).toEqual([]);expect((await db.query('select sequence_no::int n from hpbot_pilot_queue')).rows[0].n).toBe(1);
 });
 it.each(['missing','other','ambiguous','failure','gap'])('does not manufacture end across %s',async(kind)=>{
  const a=app();await tick(0,[a],[forecast('1','PROCESSING')]);let minute=1;
  const f=kind==='missing'?[]:kind==='other'?[forecast('1','UNSPECIFIED',{agent:'기타'})]:kind==='ambiguous'?[forecast('1','UNSPECIFIED'),forecast('1','UNSPECIFIED',{identity:'other'})]:[forecast('1','UNSPECIFIED')];
  if(kind==='failure'){const b=await rpc('hpbot_begin',[at(1)]);await rpc('pilot_fail',[b.token,'TIMEOUT',at(1)]);minute=2;}
  if(kind==='gap')minute=3;
  await tick(minute,[{...a,application_status:'030'}],f);expect(await notices()).toEqual([]);
 });
 it('unmatched -> matched appearance alone does not create a status alert',async()=>{
  await tick(0,[app()],[]);await tick(1,null,[forecast('1','PROCESSING')]);expect(await notices()).toEqual([]);
 });
 it('resume merges matching changes only; preview matches commit',async()=>{
  const apps=[app(),app('2')];await tick(0,apps,[forecast(),forecast('2')]);await tick(1,null,null);
  const next=[{...apps[0],pilot_time:'14:00',remarks:'확정'},{...apps[1],remarks:'검역'}];const ff=[forecast('1','PROCESSING'),forecast('2')];
  const preview=await rpc('hpbot_preview',[j(next),j(ff),j(ranges),at(2)]);await tick(2,next,ff);
  const ns=(await notices()).filter(n=>n.notification_type!=='WEATHER_SUSPEND');expect(ns).toHaveLength(2);
  const resume=ns.find(n=>n.notification_type==='WEATHER_RESUME')!;
  expect(resume.message).toContain('1400');expect(resume.message).toContain('비고: 없음 → 확정');
  expect(resume.message).toContain('공개: PROCESSING');expect(resume.message).not.toContain('SHIP 2');
  expect(ns.find(n=>n.notification_type==='SCHEDULE_CHANGE')!.message).toContain('SHIP 2');
  expect([...preview.expected_telegram_messages].sort()).toEqual(ns.map(n=>n.message).sort());
  const event=(await db.query<{notification_keys:string[]}>("select notification_keys from pilot_schedule_notification_events where external_key='1002:1'")).rows[0];
  expect(event.notification_keys).toEqual([resume.notification_key]);
 });
 it('weather resume OFF does not swallow enabled status change',async()=>{
  await db.exec(`insert into pilot_telegram_chats(chat_id,settings) values('-1','{"WEATHER_RESUME":false}');update hpbot_control set primary_chat_id='-1'`);
  await tick(0,[app(),app('2')],[forecast(),forecast('2')]);await tick(1,null,null);await tick(2,null,[forecast('1','PROCESSING'),forecast('2')]);
  const ns=await notices();expect(ns.filter(n=>n.notification_type==='WEATHER_RESUME')).toHaveLength(0);
  expect(ns.filter(n=>n.notification_type==='SCHEDULE_CHANGE')).toHaveLength(1);
 });
 it('A->B->A->B gets revisions; retries/unchanged/UNKNOWN do not replay',async()=>{
  await tick(0,[app()],[forecast('1','UNSPECIFIED')]);await tick(1,[app('1','020',{pilot_time:'13:00'})],null);
  const saved=(await db.query<{run_id:string;changes:any}>('select run_id,changes from pilot_schedule_notification_events')).rows[0];
  await Promise.all([1,2].map(()=>rpc('hpbot_queue_notification_plan',[j(saved.changes),'[]','{}',null,saved.run_id,at(1)])));
  const first=await rpc('pilot_claim_notification');await rpc('pilot_finish_notification',[first.id,'UNKNOWN',null,'TIMEOUT']);
  await tick(2,[app()],null);await tick(3,[app('1','020',{pilot_time:'13:00'})],null);await tick(4,null,null);
  const ns=await notices();expect(ns).toHaveLength(3);expect(new Set(ns.map(n=>n.notification_key)).size).toBe(3);
  const es=(await db.query<{revision:number;change_hash:string}>('select revision::int,change_hash from pilot_schedule_notification_events order by revision')).rows;
  expect(es.map(e=>e.revision)).toEqual([1,2,3]);expect(es[0].change_hash).toBe(es[2].change_hash);
  expect((await db.query('select status from pilot_notifications where id=$1',[first.id])).rows[0].status).toBe('UNKNOWN');
 });
 it('semantic hash ignores sequence, admin and metadata',async()=>{
  const old=app(),next=app('1','030',{pilot_time:'13:00'});
  for(const [id,extra] of [['11111111-1111-4111-8111-111111111111',{}],['22222222-2222-4222-8222-222222222222',{application_status:'020',display_sequence:7,updated_at:'later'}]] as const)
   await rpc('hpbot_queue_notification_plan',[j([{type:'TIME_CHANGED',old,new:{...next,...extra}}]),'[]','{}',null,id,at(1)]);
  const hashes=(await db.query<{change_hash:string}>('select change_hash from pilot_schedule_notification_events')).rows;
  expect(hashes).toHaveLength(2);expect(hashes[0].change_hash).toBe(hashes[1].change_hash);
 });
 it('anon cannot read ledger or enqueue',async()=>{
  await db.exec('set role anon');await expect(db.query('select * from pilot_schedule_notification_events')).rejects.toThrow('permission denied');
  await expect(rpc('hpbot_queue_notification_plan',['[]','[]','{}',null,'11111111-1111-4111-8111-111111111111',at(1)])).rejects.toThrow('permission denied');await db.exec('reset role');
 });
 it.each([
  ['TIME_CHANGED',{pilot_time:'13:00'},'⏰ [도선시간 변경]'],
  ['ROUTE_CHANGED',{to_location:'JSTT'},'🧭 [도선구간 변경]'],
  ['REMARK_CHANGED',{remarks:'확정'},'📝 [비고 변경]'],
  ['STATUS_CHANGED',{forecast_status:'PROCESSING'},'🔄 [PROCESSING]'],
  ['STATUS_CHANGED',{application_status:'040'},'🚢 [POB · 도선사 승선]'],
  ['STATUS_CHANGED',{forecast_status:'BAD_WEATHER'},'⚠️ [BAD WEATHER]'],
  ['COMPLETED',{application_status:'050'},'✅ [도선완료]'],
  ['NEW',{},'🆕 [신규 도선등록]'],
  ['CANCELLED',{application_status:'090'},'❌ [도선취소]'],
 ])('agency-free event title: %s %j',async(type,extra,title)=>{
  const old=app('1','020',{forecast_status:'UNSPECIFIED',match_basis:'UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE'});
  const text=(await rpc('hpbot_schedule_messages',[j([{type,old:type==='NEW'?null:old,new:{...old,...extra},operational_continuous:true}])]))[0];
  expect(text.split('\n')[0]).toBe(title);expect(text).not.toContain('협운');
 });
 it('remark setting can be toggled without changing existing setting keys',async()=>{
  await db.exec(`insert into pilot_telegram_chats(chat_id) values('-1');update hpbot_control set primary_chat_id='-1'`);
  await rpc('hpbot_accept_update',[1,'-1',2,'setting']);expect(await rpc('hpbot_toggle_setting',[1,'REMARK_CHANGED'])).toBe(false);
 });
});

describe('atomic dual-source commit',()=>{
 it('same-minute manual refresh does not accelerate suspension or re-arm',async()=>{
   await tick(0,[app(),app('2')],[forecast(),forecast('2')]);
   const when='2026-09-20T00:00:35Z',b=await rpc('hpbot_begin',[when,true]);
   await rpc('hpbot_commit',[b.token,b.version,b.application_hash,b.forecast_hash,null,null,j(ranges),null,null,1000,when]);
   expect((await db.query('select status,candidate_count from pilot_weather_state')).rows[0]).toMatchObject({status:'NORMAL',candidate_count:1});
   await tick(1,null,null);expect((await db.query('select status from pilot_weather_state')).rows[0].status).toBe('SUSPENDED');
 });
 it('re-arm requires two low minutes, then new two high minutes create one new event',async()=>{
   await tick(0,[app(),app('2'),app('3')],[forecast(),forecast('2'),forecast('3')]);await tick(1,null,null);
   await tick(2,null,[forecast('1','PROCESSING'),forecast('2'),forecast('3')]);
   await tick(3,null,[forecast('1','PROCESSING'),forecast('2','PROCESSING'),forecast('3')]);
   await tick(4,null,null);expect((await db.query('select status from pilot_weather_state')).rows[0].status).toBe('NORMAL');
   await tick(5,null,[forecast(),forecast('2'),forecast('3')]);await tick(6,null,null);
   expect((await db.query('select count(*)::int n from pilot_weather_events')).rows[0].n).toBe(2);
 });
 it('fallback requires 30 uninterrupted zero minutes; failure resets timer',async()=>{
   await tick(0,[app(),app('2')],[forecast(),forecast('2')]);await tick(1,null,null);
   await tick(2,null,[forecast('1','WAITING'),forecast('2','WAITING')]);
   for(let n=3;n<20;n++)await tick(n,null,null);
   const b=await rpc('hpbot_begin',[at(20)]);await rpc('pilot_fail',[b.token,'TIMEOUT',at(20)]);
   for(let n=21;n<51;n++)await tick(n,null,null);
   expect((await db.query('select status from pilot_weather_state')).rows[0].status).toBe('SUSPENDED');await tick(51,null,null);
   expect((await db.query('select resume_method from pilot_weather_events')).rows[0].resume_method).toBe('ZERO_30_MINUTES');
 });
 it('retains existing event; one resume; lingering BAD never rearms immediately',async()=>{
   const a=[app(),app('2'),app('3')]; const f=[forecast(),forecast('2'),forecast('3')];
   await tick(0,a,f);await tick(1,null,null);
   const eid=(await db.query('select event_id from pilot_weather_state')).rows[0].event_id;
   await tick(2,null,[forecast('1','PROCESSING'),forecast('2'),forecast('3')]);
   expect((await db.query('select status,event_id from pilot_weather_state')).rows[0]).toMatchObject({status:'RESUMED',event_id:eid});
   await tick(3,null,null);expect((await db.query('select status from pilot_weather_state')).rows[0].status).toBe('RESUMED');
   expect((await db.query("select count(*)::int n from pilot_notifications where notification_type='WEATHER_RESUME'")).rows[0].n).toBe(1);
 });
 it.each(['failure','gap','new','other','different_id'])('does not falsely resume across %s',async kind=>{
   await tick(0,[app(),app('2')],[forecast(),forecast('2')]);await tick(1,null,null);
   let n=2;let apps:any[]|null=null;let f=[forecast('1','PROCESSING'),forecast('2')];
   if(kind==='failure'){const b=await rpc('hpbot_begin',[at(2)]);await rpc('pilot_fail',[b.token,'LOGIN_FAILED',at(2)]);n=3;}
   if(kind==='gap')n=3;
   if(kind==='new'){apps=[app(),app('2'),app('3')];f=[forecast(),forecast('2'),forecast('3','PROCESSING')];}
   if(kind==='other')f=[forecast('1','PROCESSING',{agent:'기타'}),forecast('2')];
   if(kind==='different_id')apps=[app('9','020',{vessel_name:'SHIP 1',callsign:'CALL1'}),app('2')];
   await tick(n,apps,f);expect((await db.query('select status from pilot_weather_state')).rows[0].status).toBe('SUSPENDED');
 });
 it('no full snapshot rewrite on unchanged ticks and no row revision bump',async()=>{
   await tick(0,[app()],[forecast()]);await tick(1,null,null);await tick(2,null,null);
   expect((await db.query('select count(*)::int n from hpbot_source_snapshots')).rows[0].n).toBe(2);
   expect((await db.query('select revision::int r from hpbot_pilot_current')).rows[0].r).toBe(1);
   expect((await db.query('select count(*)::int n from pilot_snapshots')).rows[0].n).toBe(1);
 });
 it('preview reads only and anonymous users have no access',async()=>{
   await tick(0,[app()],[forecast()]);
   const before=await rpc('hpbot_context');await rpc('hpbot_preview',[j([app()]),j([forecast()]),j(ranges),at(1)]);
   expect(await rpc('hpbot_context')).toEqual(before);
   await db.exec('set role anon');await expect(rpc('hpbot_context')).rejects.toThrow('permission denied');await db.exec('reset role');
 });
 it('31 days unchanged: two source versions, no rewritten queue, one suspension',async()=>{
   await tick(0,[app(),app('2')],[forecast(),forecast('2')]);
   for(let first=1;first<44640;first+=60)await db.exec(`do $$ declare b jsonb;t timestamptz;i int;begin
     for i in ${first}..${Math.min(first+59,44639)} loop
       t:='2026-09-20T00:00:00Z'::timestamptz+make_interval(mins=>i);b:=public.hpbot_begin(t);
       if b->>'token' is null then raise exception 'UNEXPECTED_STOP % %',i,b;end if;
       perform public.hpbot_commit((b->>'token')::uuid,(b->>'version')::bigint,b->>'application_hash',b->>'forecast_hash',null,null,'[{"start":"1900-01-01","end":"9999-12-31"}]',null,null,1000,t);
     end loop;end $$;`);
   expect((await db.query('select count(*)::int n from hpbot_source_snapshots')).rows[0].n).toBe(2);
   expect((await db.query('select max(revision)::int n from hpbot_pilot_current')).rows[0].n).toBe(1);
   expect((await db.query("select count(*)::int n from pilot_notifications where notification_type='WEATHER_SUSPEND'")).rows[0].n).toBe(1);
   expect((await db.query('select count(*)::int n from pilot_monitor_logs')).rows[0].n).toBe(44640);
 },240000);
});
