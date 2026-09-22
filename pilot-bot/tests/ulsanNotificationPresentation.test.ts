// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
let db:PGlite;
const migration=()=>readFileSync('supabase/migrations/20260922003500_pilot_query_presentation.sql','utf8');
const rpc=async(name:string,args:any[]=[])=> (await db.query<any>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args)).rows[0].v;
const base={application_id:'1',vessel_name:'ARGENT IRIS',pilot_date:'2026-09-22',pilot_time:'07:30',from_location:'P/S',to_location:'OTK(S)',application_status:'030',completion_status:'ACTIVE',forecast_status:'UNSPECIFIED',match_basis:'UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE',mooring_name:'진산',display_sequence:1};
const change=(id='1',extra:any={pilot_time:'07:35'})=>[{type:'TIME_CHANGED',old:{...base,application_id:id},new:{...base,application_id:id,...extra},operational_continuous:true}];
beforeAll(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const f of ['20260920000000_ulsan_pilot_watcher','20260920000300_hpbot_operations','20260920000400_hpbot_telegram','20260920000500_hpbot_query_context','20260920000600_hpbot_mooring','20260920001300_pilot_pob_date_labels','20260921001500_pilot_pob_identity','20260921001600_pilot_concise_notifications','20260922002400_pilot_notification_policy','20260922002500_pilot_event_titles','20260922003400_pilot_event_presentation'])await db.exec(readFileSync('supabase/migrations/'+f+'.sql','utf8'));
},30000);
afterAll(async()=>await db?.close());
beforeEach(async()=>{
 await db.exec('truncate pilot_schedule_notification_events,pilot_schedule_notification_revisions,pilot_notifications,pilot_notification_attempts,pilot_weather_events,hpbot_pilot_current,hpbot_pilot_history,pilot_telegram_chats cascade');
 await db.exec("insert into pilot_telegram_chats(chat_id)values('-1');update hpbot_control set primary_chat_id='-1';");
});
async function ledger(changes:any[],keys:string[]=[],revision=1){
 const id=crypto.randomUUID();await db.query('insert into pilot_schedule_notification_events(external_key,revision,run_id,change_hash,changes,notification_keys,created_at) values($1,$2,$3,$4,$5,$6,now())',['1002:'+changes[0].new.application_id,revision,id,'h'+revision,changes,keys]);return id;
}
async function receipt(key:string,status='PENDING',attempts=0,type='SCHEDULE_CHANGE',ref='run'){
 return (await db.query<any>('insert into pilot_notifications(notification_key,notification_type,reference_id,message,status,attempts) values($1,$2,$3,$4,$5,$6) returning id',[key,type,ref,'original '+key,status,attempts])).rows[0].id;
}
it.each([
 ['040',null,'UNMATCHED',false,'POB'],
 ['020','PROCESSING','UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE',false,'PROCESSING'],
 ['020','PROCESSING','UNMATCHED',false,null],
 ['040','PROCESSING','UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE',true,null],
 ['020','UNSPECIFIED','UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE',false,''],
])('query exposes only trusted operational evidence: %s %s %s %s',async(application_status,forecast_status,match_basis,needs_review,expected)=>{
 await db.query('insert into hpbot_pilot_current(application_id,data,first_seen_at,last_seen_at,updated_at)values($1,$2,now(),now(),now())',['1',{...base,application_status,forecast_status,match_basis,needs_review}]);
 await db.exec(migration());const result=await rpc('hpbot_read',['search',0,'ARGENT','-1']);
 expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({application_status,operational_status:expected,mooring_name:'진산'});
});
it('recent changes uses semantic ledger, not raw administrative history, including disabled delivery events',async()=>{
 await db.query("insert into hpbot_pilot_history(external_key,vessel_name,event_type,old_data,new_data,detected_at,run_id)values('1002:1','ARGENT IRIS','STATUS_CHANGED',$1,$2,now(),$3)",[base,{...base,application_status:'020'},crypto.randomUUID()]);
 await ledger(change());await ledger([{type:'STATUS_CHANGED',old:base,new:{...base,application_status:'020'},operational_continuous:true}],[],2);
 await db.exec("update pilot_telegram_chats set settings=settings||'{\"TIME_CHANGED\":false}'::jsonb");
 await db.exec(migration());const result=await rpc('hpbot_read',['changes',0,'','-1']);
 expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({title:'⏰ [도선시간 변경]',application_id:'1'});
 expect(result.rows[0].summary).toContain('0730 → 09/22(화) 0735');expect(JSON.stringify(result)).not.toContain('신청:');
 expect((await db.query('select * from hpbot_pilot_history')).rows).toHaveLength(1);
});
it('recent changes bounds to ten jobs and 650 characters per summary',async()=>{
 for(let i=1;i<=12;i++)await ledger(change(String(i),{remarks:'가'.repeat(1200),pilot_time:'07:35'}));
 await db.exec(migration());const result=await rpc('hpbot_read',['changes',0,'','-1']);expect(result.rows).toHaveLength(10);
 expect(result.rows.every((r:any)=>r.summary.length<=650)).toBe(true);
});
it('rewrites only unattempted pending receipt in place and does not create revision/key',async()=>{
 const keys=['pending','sent','unknown','sending','retry'];
 for(const [i,status] of ['PENDING','SENT','UNKNOWN','SENDING','PENDING'].entries()){
  await ledger(change(String(i+1)),[keys[i]]);await receipt(keys[i],status,i?1:0);
 }
 await db.exec(migration());const rows=(await db.query<any>('select id,notification_key,message,status,attempts from pilot_notifications order by notification_key')).rows;
 const first=rows.find(r=>r.notification_key==='pending');expect(first.message).toContain('⏰ [도선시간 변경]');expect(first.status).toBe('PENDING');
 for(const key of keys.slice(1))expect(rows.find(r=>r.notification_key===key).message).toBe('original '+key);
 expect(rows).toHaveLength(5);expect((await db.query('select * from pilot_schedule_notification_events')).rows).toHaveLength(5);
 await db.exec(migration());expect((await db.query<any>('select id,notification_key,message,status,attempts from pilot_notifications order by notification_key')).rows).toEqual(rows);
});
it('partially delivered family and receipt attempt ledger are never rewritten',async()=>{
 await ledger(change(),['p1','p2']);await receipt('p1','SENT',1);await receipt('p2');
 await ledger(change('2'),['attempt']);const id=await receipt('attempt');
 await db.query("insert into pilot_notification_attempts(notification_id,attempt,started_at,status)values($1,1,now(),'UNKNOWN')",[id]);
 await db.exec(migration());const rows=(await db.query<any>('select notification_key,message from pilot_notifications')).rows;
 expect(rows.every(r=>r.message==='original '+r.notification_key)).toBe(true);
});
it('changed split count holds pending family instead of generating keys or dropping text',async()=>{
 await ledger(change(),['part0','part1']);await receipt('part0');await receipt('part1');
 await db.exec(migration());const rows=(await db.query<any>('select notification_key,status,error from pilot_notifications')).rows;
 expect(rows).toHaveLength(2);expect(rows.every(r=>r.status==='FAILED'&&r.error==='PRESENTATION_PARTS_REVIEW_REQUIRED')).toBe(true);
});
it('pending resume retains one weather receipt and merges reformatted changed fields',async()=>{
 const old={...base,forecast_status:'BAD_WEATHER'},next={...base,forecast_status:'PROCESSING',pilot_time:'07:35'};
 const changes=[{type:'STATUS_CHANGED',old,new:next,operational_continuous:true},{type:'TIME_CHANGED',old,new:next,operational_continuous:true}];
 const event=crypto.randomUUID();await db.query("insert into pilot_weather_events(id,started_at,resume_detected_at,resume_schedule_key,resume_method,max_bad_weather_count)values($1,now()-interval '1 hour',now(),'1002:1','HYOPU_TRANSITION',3)",[event]);
 await ledger(changes,['resume']);const id=await receipt('resume','PENDING',0,'WEATHER_RESUME',event);await db.exec(migration());
 const row=(await db.query<any>('select id,message,notification_type from pilot_notifications')).rows[0];
 expect(row.id).toBe(id);expect(row.notification_type).toBe('WEATHER_RESUME');expect(row.message).toContain('🟢 [울산 도선재개 감지]');expect(row.message).toContain('0735');expect(row.message).toContain('공개: PROCESSING');expect(row.message).not.toContain('신청:');
});
it('read and title helpers remain service-only',async()=>{
 await db.exec(migration());await db.exec('set role anon');
 await expect(rpc('hpbot_read',['changes'])).rejects.toThrow('permission denied');
 await expect(rpc('hpbot_notification_title',[change()])).rejects.toThrow('permission denied');await db.exec('reset role');
});
