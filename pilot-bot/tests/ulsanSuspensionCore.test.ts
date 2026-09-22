// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';

let db:PGlite;let hash=0;
const at=(minute:number)=>new Date(Date.UTC(2026,8,22,0,minute)).toISOString();
const j=JSON.stringify;
const migrations=[
 '20260920000000_ulsan_pilot_watcher.sql','20260920000300_hpbot_operations.sql',
 '20260920000400_hpbot_telegram.sql','20260920000500_hpbot_query_context.sql',
 '20260920000600_hpbot_mooring.sql','20260920001000_pilot_registration_status.sql',
 '20260920001300_pilot_pob_date_labels.sql','20260921001500_pilot_pob_identity.sql',
 '20260921001600_pilot_concise_notifications.sql','20260922002400_pilot_notification_policy.sql',
 '20260922002500_pilot_event_titles.sql','20260922003400_pilot_event_presentation.sql',
 '20260922003500_pilot_query_presentation.sql','20260922003600_pilot_suspension_core.sql',
];
const row=(id:string,status='BAD_WEATHER',extra={})=>({identity:id,vessel_name:`SHIP ${id}`,callsign:`CALL${id}`,pilot_date:'2026-09-22',pilot_time:'12:00',from_location:'P/S',to_location:'OTK(S)',agent:'협운',status,raw_status:status,remarks:'',cancelled:false,...extra});
const app=(id:string,extra={})=>({application_id:id,vessel_name:`SHIP ${id}`,callsign:`CALL${id}`,pilot_date:'2026-09-22',pilot_time:'12:00',from_location:'P/S',to_location:'OTK(S)',agent:'협운',application_status:'020',remarks:'',...extra});
const ranges=[{start:'1900-01-01',end:'9999-12-31'}];
async function rpc(name:string,args:unknown[]=[]){return (await db.query<{v:any}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) v`,args)).rows[0].v;}
async function scalar(sql:string){return Object.values((await db.query(sql)).rows[0] as object)[0];}
async function tick(n:number,rows:any[]|null,apps:any[]|null=null){
 const b=await rpc('hpbot_begin',[at(n)]);if(!b.token)return b;
 return rpc('hpbot_commit',[b.token,b.version,apps?(++hash).toString(16).padStart(64,'0'):b.application_hash,rows?(++hash).toString(16).padStart(64,'0'):b.forecast_hash,apps?j(apps):null,rows?j(rows):null,j(ranges),null,null,1000,at(n)]);
}
beforeAll(async()=>{db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const path of migrations)await db.exec(readFileSync(`supabase/migrations/${path}`,'utf8'));
},30000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{hash=0;await db.exec(`truncate pilot_schedule_notification_events,pilot_schedule_notification_revisions,pilot_telegram_updates,pilot_telegram_chats,hpbot_pilot_current,hpbot_pilot_history,hpbot_source_snapshots,hpbot_collection_ranges,pilot_monitor_logs,pilot_notifications,pilot_notification_attempts,pilot_weather_events,pilot_snapshots,pilot_runs,pilot_usage,pilot_current,pilot_history;
 delete from pilot_watcher_control;insert into pilot_watcher_control(id,enabled,billing_verified_at,cycle_start,cycle_end) values(true,true,'2026-09-01','2000-01-01','2100-01-01');
 delete from pilot_weather_state;insert into pilot_weather_state(id) values(true);delete from hpbot_control;insert into hpbot_control(id,alerts_enabled,bootstrap_done) values(true,true,true);`);});

describe('three-status suspension core',()=>{
 it.each([[' Bad  Weather ','BAD_WEATHER'],[' dense\n fog ','DENSE_FOG'],['PORT\u00a0CLOSE','PORT_CLOSE'],['PORT CLOSED','PORT CLOSED'],['UNSPECIFIED','UNSPECIFIED'],[null,null]])('canonicalizes only confirmed aliases %s',async(input,output)=>{
  expect(await rpc('pilot_status_canonical',[input])).toBe(output);
  expect(await rpc('pilot_is_suspension',[input])).toBe(['BAD_WEATHER','DENSE_FOG','PORT_CLOSE'].includes(output??''));
 });
 it('counts one representative per ship in PORT CLOSE > FOG > WEATHER order',async()=>{
  const rows=[row('1'),row('2','DENSE_FOG',{callsign:'CALL1'}),row('3','PORT_CLOSE',{callsign:'CALL1'}),row('4','DENSE_FOG'),row('5'),row('6','PORT_CLOSE',{cancelled:true})];
  expect(await rpc('pilot_suspension_counts',[j(rows)])).toEqual({bad_weather_count:1,dense_fog_count:1,port_close_count:1,suspension_total_count:3,suspension_reasons:['PORT_CLOSE','DENSE_FOG','BAD_WEATHER']});
 });
 it('fallback ship-name matching is exact normalized and does not strip MV prefixes',async()=>{
  const rows=[row('1','DENSE FOG',{callsign:'',vessel_name:' MV  SAME '}),row('2','PORT CLOSE',{callsign:null,vessel_name:'mv same'}),row('3','BAD WEATHER',{callsign:'',vessel_name:'SAME'})];
  expect(await rpc('pilot_suspension_counts',[j(rows)])).toMatchObject({bad_weather_count:1,port_close_count:1,suspension_total_count:2});
 });
 it.each([['BAD_WEATHER','BAD_WEATHER'],['DENSE_FOG','DENSE_FOG'],['PORT_CLOSE','PORT_CLOSE'],['BAD_WEATHER','DENSE_FOG'],['DENSE_FOG','PORT_CLOSE'],['BAD_WEATHER','PORT_CLOSE']])('suspends after two distinct observations for %s + %s',async(a,b)=>{
  await tick(0,[row('1',a),row('2',b)],[app('1'),app('2')]);
  expect(await scalar('select status from pilot_weather_state')).toBe('NORMAL');
  await tick(1,null);
  expect(await scalar('select status from pilot_weather_state')).toBe('SUSPENDED');
  expect(await scalar("select count(*)::int from pilot_notifications where notification_type='WEATHER_SUSPEND'")).toBe(1);
  expect(await scalar('select suspension_total_count from pilot_weather_state')).toBe(2);
  expect(await scalar('select suspension_total_count from pilot_monitor_logs order by created_at desc limit 1')).toBe(2);
  expect(await scalar('select suspension_total_count from pilot_runs order by started_at desc limit 1')).toBe(2);
  expect(await scalar("select (initial_suspension_counts->>'suspension_total_count')::int from pilot_weather_events")).toBe(2);
 });
 it('single duplicated ship cannot suspend even with three reasons',async()=>{
  await tick(0,[row('1'),row('2','DENSE_FOG',{callsign:'CALL1'}),row('3','PORT_CLOSE',{callsign:'CALL1'})],[app('1')]);await tick(1,null);
  expect(await scalar('select status from pilot_weather_state')).toBe('NORMAL');
 });
 it.each(['DENSE_FOG','PORT_CLOSE'])('resumes once with the actual prior %s evidence',async status=>{
  await tick(0,[row('1',status),row('2',status),row('3',status)],[app('1'),app('2'),app('3')]);await tick(1,null);
  const before=await scalar('select event_id::text from pilot_weather_state');
  await tick(2,[row('1','PROCESSING'),row('2',status),row('3',status)]);
  expect(await scalar('select status from pilot_weather_state')).toBe('RESUMED');
  expect(await scalar('select event_id::text from pilot_weather_state')).toBe(before);
  expect(await scalar('select resume_previous_status from pilot_weather_events')).toBe(status);
  await tick(3,[row('1','PROCESSING'),row('2','PROCESSING'),row('3',status)]);
  expect(await scalar("select count(*)::int from pilot_notifications where notification_type='WEATHER_RESUME'")).toBe(1);
 });
 it('plain-to-canonical spelling does not create application change history',async()=>{
  await tick(0,[row('1','DENSE FOG')],[app('1')]);await tick(1,[row('1','DENSE_FOG')]);
  expect(await scalar('select count(*)::int from hpbot_pilot_history')).toBe(0);
  expect(await scalar('select count(*)::int from pilot_schedule_notification_events')).toBe(0);
 });
 it('entry subtypes supplement history without duplicating projected notifications',async()=>{
  await tick(0,[row('1','UNSPECIFIED')],[app('1')]);await tick(1,[row('1','DENSE_FOG')]);
  expect(await scalar("select count(*)::int from hpbot_pilot_history where event_type='PILOT_ENTERED_DENSE_FOG'")).toBe(1);
  expect(await scalar('select count(*)::int from pilot_schedule_notification_events')).toBe(1);
  expect(await scalar("select count(*)::int from pilot_notifications where notification_type='SCHEDULE_CHANGE'")).toBe(1);
 });
 it('reason changes preserve the same global incident and update its separate peak counts',async()=>{
  await tick(0,[row('1'),row('2')],[app('1'),app('2')]);await tick(1,null);
  await tick(2,[row('1','DENSE_FOG'),row('2','DENSE_FOG')]);
  await tick(3,[row('1','PORT_CLOSE'),row('2','PORT_CLOSE')]);
  const event=(await db.query('select max_bad_weather_count,max_dense_fog_count,max_port_close_count,max_suspension_total_count,initial_suspension_counts from pilot_weather_events')).rows[0];
  expect(event).toMatchObject({max_bad_weather_count:2,max_dense_fog_count:2,max_port_close_count:2,max_suspension_total_count:2,initial_suspension_counts:{bad_weather_count:2,dense_fog_count:0}});
  expect(await scalar("select count(*)::int from pilot_notifications where notification_type='WEATHER_SUSPEND'")).toBe(1);
 });
 it('a nonzero fog count blocks fallback, and uninterrupted all-zero 30 minutes enables it',async()=>{
  await tick(0,[row('1','DENSE_FOG'),row('2','DENSE_FOG')],[app('1'),app('2')]);await tick(1,null);
  await tick(2,[row('1','DENSE_FOG'),row('2','UNSPECIFIED')]);
  for(let i=3;i<34;i++)await tick(i,null);
  expect(await scalar('select status from pilot_weather_state')).toBe('SUSPENDED');
  await tick(34,[row('1','UNSPECIFIED'),row('2','UNSPECIFIED')]);
  for(let i=35;i<64;i++)await tick(i,null);
  expect(await scalar('select status from pilot_weather_state')).toBe('SUSPENDED');await tick(64,null);
  expect(await scalar('select resume_method from pilot_weather_events')).toBe('ZERO_30_MINUTES');
 });
 it('unchanged normalized snapshots are not repeatedly stored',async()=>{
  await tick(0,[row('1','DENSE_FOG')],[app('1')]);await tick(1,null);await tick(2,null);
  expect(await scalar('select count(*)::int from pilot_snapshots')).toBe(1);
  expect(await scalar('select count(*)::int from hpbot_source_snapshots')).toBe(2);
 });
 it('preview adds counts with no writes and agrees with the next commit',async()=>{
  const rows=[row('1','DENSE_FOG'),row('2','PORT_CLOSE')];const apps=[app('1'),app('2')];
  await tick(0,rows,apps);const before=await scalar('select count(*)::int from pilot_runs');
  const p=await rpc('hpbot_preview',[j(apps),j(rows),j(ranges),at(1)]);
  expect(p.counts).toMatchObject({bad_weather:0,bad_weather_count:0,dense_fog_count:1,port_close_count:1,suspension_total_count:2});
  expect(p.next_state.status).toBe('SUSPENDED');expect(await scalar('select count(*)::int from pilot_runs')).toBe(before);
  await tick(1,null);expect(await scalar('select status from pilot_weather_state')).toBe(p.next_state.status);
 });
 it('legacy commit persists counts and marker history without duplicate resume messages',async()=>{
  let last:string|null=null;
  for(let n=0;n<3;n++){
   const rows=[row('1',n===2?'PROCESSING':'PORT_CLOSE'),row('2','DENSE_FOG')];const b=await rpc('pilot_begin',[at(n)]);last=(++hash).toString(16).padStart(64,'0');
   await rpc('pilot_commit',[b.token,b.version,last,j(rows),1000,at(n)]);
  }
  expect(await scalar('select status from pilot_weather_state')).toBe('RESUMED');
  expect(await scalar('select dense_fog_count from pilot_weather_state')).toBe(1);
  expect(await scalar('select resume_previous_status from pilot_weather_events')).toBe('PORT_CLOSE');
  expect(await scalar("select count(*)::int from pilot_history where event_type='SUSPENSION_TO_PROCESSING'")).toBe(1);
  expect(await scalar("select count(*)::int from pilot_notifications where notification_type='WEATHER_RESUME'")).toBe(1);
 });
 it('new helpers stay service-only',async()=>{
  await db.exec('set role anon');await expect(rpc('pilot_suspension_counts',['[]'])).rejects.toThrow('permission denied');await db.exec('reset role');
 });
 it('cutover preserves the active incident and attempted delivery receipts while clearing old-policy timers',async()=>{
  const upgrade=new PGlite();
  try{
   await upgrade.exec('create role anon;create role authenticated;create role service_role bypassrls;');
   for(const path of migrations.slice(0,-1))await upgrade.exec(readFileSync(`supabase/migrations/${path}`,'utf8'));
   const eid='00000000-0000-0000-0000-000000000001';
   await upgrade.query("insert into pilot_snapshots(content_hash,rows,observed_at) values(repeat('a',64),$1,'2026-09-22')",[j([row('1','DENSE FOG'),row('2','PORT CLOSE')])]);
   await upgrade.exec(`insert into pilot_weather_events(id,started_at,max_bad_weather_count) values('${eid}','2026-09-20',2);
    update pilot_weather_state set status='SUSPENDED',event_id='${eid}',started_at='2026-09-20',candidate_count=1,rearm_count=1,recovery_started_at='2026-09-22',bad_weather_count=2;
    update pilot_watcher_control set snapshot_id=(select max(id) from pilot_snapshots),version=8,continuous=true;
    insert into pilot_notifications(notification_key,notification_type,reference_id,message,status,attempts) values
     ('weather_suspend:${eid}','WEATHER_SUSPEND','${eid}','already sent','SENT',1),
     ('uncertain','SCHEDULE_CHANGE','run','uncertain text','UNKNOWN',1),
     ('sending','SCHEDULE_CHANGE','run','sending text','SENDING',1);`);
   const before=await upgrade.query('select notification_key,status,message,attempts from pilot_notifications order by notification_key');
   await upgrade.exec(readFileSync(`supabase/migrations/${migrations.at(-1)}`,'utf8'));
   expect((await upgrade.query('select status,event_id,started_at,candidate_count,rearm_count,recovery_started_at,bad_weather_count,dense_fog_count,port_close_count,suspension_total_count from pilot_weather_state')).rows[0]).toMatchObject({status:'SUSPENDED',event_id:eid,candidate_count:0,rearm_count:0,recovery_started_at:null,bad_weather_count:0,dense_fog_count:1,port_close_count:1,suspension_total_count:2});
   expect((await upgrade.query('select version::int,continuous from pilot_watcher_control')).rows[0]).toEqual({version:9,continuous:false});
   expect((await upgrade.query('select notification_key,status,message,attempts from pilot_notifications order by notification_key')).rows).toEqual(before.rows);
   expect((await upgrade.query('select initial_suspension_counts,resume_previous_status from pilot_weather_events')).rows[0]).toEqual({initial_suspension_counts:null,resume_previous_status:null});
  }finally{await upgrade.close();}
 });
});
