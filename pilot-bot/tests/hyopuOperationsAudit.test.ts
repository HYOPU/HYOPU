import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,afterAll,it,expect} from 'vitest';

let db:PGlite;
const auditSql=readFileSync('scripts/operations-audit.sql','utf8');
beforeAll(async()=>{
 db=new PGlite();
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema cron;create table cron.job(jobname text,schedule text,active boolean);');
 for(const f of ['20260920000000_ulsan_pilot_watcher','20260920000300_hpbot_operations',
  '20260920000400_hpbot_telegram','20260920000500_hpbot_query_context','20260920000600_hpbot_mooring',
  '20260920000700_pilot_registration','20260920000900_pilot_miniapp','20260920001100_pilot_copy_registration',
  '20260920001200_pilot_budget_settlement','20260920001300_pilot_pob_date_labels',
  '20260921001600_pilot_concise_notifications','20260921001700_jstt_berth_monitor',
  '20260921001800_jstt_run_measurement','20260921002300_pilot_optional_cost_limits'])
  await db.exec(readFileSync('supabase/migrations/'+f+'.sql','utf8'));
},30000);
afterAll(async()=>await db?.close());

async function audit(at:string){
 const sql=auditSql.replace('select now() as checked_at',`select timestamptz '${at}' as checked_at`);
 await db.exec('begin read only');
 try{return (await db.query<{evidence:any}>(sql)).rows[0].evidence;}
 finally{await db.exec('rollback');}
}

it('runs read-only and does not claim 24 hours or provider billing before evidence exists',async()=>{
 const r=await audit('2026-09-22 02:31:30+00');
 expect(r.observation.has_24_hours).toBe(false);
 expect(r.observation.provider_cost_verified).toBe(false);
 expect(r.pilot_missing_full_minutes).toBe(11);
 expect(r.jstt_missing_scheduled_slots).toBe(1);
 expect(r.security.rls_disabled).toEqual([]);
 expect(r.security.browser_table_privileges).toEqual([]);
 expect(JSON.stringify(r)).not.toMatch(/sealed_data|sealed_session|billing_evidence|telegram_user_id/);
});

it('counts complete 24-hour scheduled windows independently of test intent',async()=>{
 const r=await audit('2026-09-23 02:20:00+00');
 expect(r.observation.has_24_hours).toBe(true);
 expect(r.observation.provider_cost_verified).toBe(false);
 expect(r.pilot_missing_full_minutes).toBe(1440);
 expect(r.jstt_missing_scheduled_slots).toBe(72);
});

it('separates unchanged transfer estimates from changed snapshots and HTML ingress',async()=>{
 await db.exec(`insert into pilot_runs(id,slot,started_at,finished_at,success,estimated_bytes,ingress_bytes) values
 ('00000000-0000-0000-0000-000000000101','2026-09-22 02:29:00+00','2026-09-22 02:29:00+00','2026-09-22 02:29:05+00',true,6000,200000),
 ('00000000-0000-0000-0000-000000000102','2026-09-22 02:30:00+00','2026-09-22 02:30:00+00','2026-09-22 02:30:05+00',true,50000,300000);
 insert into hpbot_source_snapshots(source,content_hash,rows,observed_at)
 values('applications','audit_changed','[]','2026-09-22 02:30:05+00');`);
 try{
  const r=await audit('2026-09-22 02:31:30+00');
  expect(r.last_fifteen_minutes).toEqual({successful_runs:2,unchanged_runs:1,
   unchanged_average_estimated_bytes:6000,unchanged_max_estimated_bytes:6000,
   source_snapshot_writes:1,html_ingress_bytes:500000,unchanged_mean_target_bytes:8192,
   estimate_basis:'reserved_execution_budget',measured_transfer_target_verified:false,
   provider_billed_bytes:null});
 }finally{
  await db.exec("delete from pilot_runs where id in('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000102');delete from hpbot_source_snapshots where content_hash='audit_changed';");
 }
});

it('flags missing row security and duplicate receipts without changing operational state',async()=>{
 await db.exec(`alter table pilot_usage disable row level security;grant select on pilot_usage to anon;
 insert into pilot_notifications(notification_key,notification_type,reference_id,message,status,telegram_chat_id,telegram_message_id)
 values('audit:1','TEST','1','not sent','SENT','-1',77),('audit:2','TEST','2','not sent','SENT','-1',77);`);
 try{
  const r=await audit('2026-09-22 02:31:30+00');
  expect(r.security.rls_disabled).toContain('pilot_usage');
  expect(r.security.browser_table_privileges).toContain('pilot_usage');
  expect(r.duplicate_telegram_receipts).toBe(1);
  expect(r.duplicate_notification_keys).toBe(0);
 }finally{
  await db.exec("delete from pilot_notifications where notification_key in('audit:1','audit:2');alter table pilot_usage enable row level security;revoke select on pilot_usage from anon;");
 }
});
