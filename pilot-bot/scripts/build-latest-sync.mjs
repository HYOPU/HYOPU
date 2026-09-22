// Emits SQL only; execution is a separate, explicitly targeted deployment step.
// Never logs credentials, source HTML or application payloads.
import {readFileSync} from 'node:fs';
const commit=process.argv[2]==='--apply';
if(process.argv[2]&&!commit)throw Error('EXPECTED_APPLY_OR_NO_ARGUMENT');
const files=[
 '20260922003200_jstt_berth_quarantine.sql',
 '20260922003300_jstt_failure_collection_label.sql',
 '20260922003400_pilot_event_presentation.sql',
 '20260922003500_pilot_query_presentation.sql',
 '20260922003600_pilot_suspension_core.sql',
 '20260922003700_pilot_suspension_presentation.sql',
];
const migrations=files.map(f=>readFileSync('supabase/migrations/'+f,'utf8').replace(/^begin;\s*/m,'').replace(/commit;\s*$/,'')).join('\n');
if(/public\.dongjin_|public\.hyopu_|ybkxpwqtgajpgggqczhb/.test(migrations))throw Error('WRONG_NAMESPACE');
const guards=`
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
select 1 from public.pilot_watcher_control where id for update;
select 1 from public.jstt_monitor_control where id for update;
select 1 from public.pilot_registration_control where id for update;
do $$ begin
 if exists(select 1 from public.pilot_watcher_control where lease_until>now())
  or exists(select 1 from public.jstt_monitor_control where lease_until>now())
  or exists(select 1 from public.pilot_registration_control where writer_until>now())
  or exists(select 1 from public.pilot_notifications where status='SENDING') then raise exception 'SYNC_BUSY';end if;
 if (select primary_chat_id from public.hpbot_control where id) is distinct from '-1004425641291'
  or exists(select 1 from public.hpbot_pilot_current where external_key not like '1002:%') then raise exception 'WRONG_ACCOUNT_OR_ROOM';end if;
 if to_regprocedure('public.pilot_is_suspension(text)') is not null then raise exception 'SYNC_ALREADY_APPLIED';end if;
end $$;
create temp table suspension_cutover_before as select
 (select to_jsonb(w) from public.pilot_weather_state w where id) state,
 (select md5(coalesce(jsonb_agg(to_jsonb(n) order by n.id)::text,'[]')) from public.pilot_notifications n where status in('SENT','SENDING','UNKNOWN')) receipts;
create temp view hpbot_sync_safety_now as select
 (select md5(coalesce(string_agg(pg_get_functiondef(p.oid)||coalesce(p.proacl::text,''),E'\\n' order by p.oid),'')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'hyopu_%') portal_functions,
 (select md5(coalesce(jsonb_agg(jsonb_build_array(c.oid,c.relacl,c.relrowsecurity,c.reloptions) order by c.oid)::text,'[]')) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in('r','v') and c.relname !~'^(hpbot_|pilot_|jstt_)') portal_access,
 (select md5(coalesce(jsonb_agg(to_jsonb(c) order by c.application_id)::text,'[]')) from public.hpbot_pilot_current c) applications,
 (select jsonb_build_object('enabled',enabled,'reason',disabled_reason,'limits',cost_limits_enabled,'cycle_limit',cycle_limit,'day_limit',day_limit,'warning_limit',warning_limit,'cycle_start',cycle_start,'cycle_end',cycle_end) from public.pilot_watcher_control where id) cost_control,
 (select jsonb_build_object('create',create_enabled,'update',update_enabled,'copy',copy_enabled) from public.pilot_registration_control where id) write_flags;
create temp table hpbot_sync_safety_before as select * from hpbot_sync_safety_now;
`;
const end=`
do $$ begin
 if (select to_jsonb(n) from hpbot_sync_safety_now n) is distinct from (select to_jsonb(b) from hpbot_sync_safety_before b) then raise exception 'SYNC_SAFETY_STATE_CHANGED';end if;
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname ~'^(hpbot_|pilot_|jstt_)' and (not c.relrowsecurity or has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE'))) then raise exception 'SYNC_ACCESS_BOUNDARY';end if;
end $$;
select jsonb_build_object('verified',true,'mode','${commit?'APPLY':'ROLLBACK_REHEARSAL'}','portal_unchanged',true,'applications_unchanged',true,'attempted_receipts_unchanged',true,'real_submissions',0) as sync_verification;
${commit?'commit;':'rollback;'}
`;
process.stdout.write(guards+migrations+'\n'+readFileSync('scripts/latest-sync-assertions.sql','utf8')+'\n'+end);
