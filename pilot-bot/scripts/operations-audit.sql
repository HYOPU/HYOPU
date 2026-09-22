-- Read-only HYOPU operational evidence, not a migration or a health mutation.
-- Run with --project-ref nhujqbqygnhbnvmfmodi. No raw snapshots, messages,
-- contact details, sealed data, cookies, credentials or billing evidence.
-- Provider billing must be checked separately; estimated bytes are NOT bills.
with bounds as (
 select now() as checked_at,
        timestamptz '2026-09-22 02:20:00+00' as commissioned_at,
        greatest(timestamptz '2026-09-22 02:20:00+00', now()-interval '24 hours') as since
), slots as (
 select s from bounds, lateral generate_series(date_trunc('minute',since),
   date_trunc('minute',checked_at)-interval '1 minute', interval '1 minute') s
), bot_tables as (
 select c.oid,c.relname,c.relrowsecurity from pg_class c
 join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r'
 and c.relname ~ '^(hpbot_|pilot_|jstt_)'
)
select jsonb_build_object(
 'checked_at',b.checked_at,
 'observation',jsonb_build_object('commissioned_at',b.commissioned_at,
   'hours_since_commissioning',round((extract(epoch from b.checked_at-b.commissioned_at)/3600)::numeric,2),
   'has_24_hours',b.checked_at>=b.commissioned_at+interval '24 hours',
   'window_start',b.since,'provider_cost_verified',false),
 'watcher',(select jsonb_build_object('enabled',enabled,'disabled_reason',disabled_reason,
   'last_success',last_success,'failure_count',failure_count,'cost_limits_enabled',cost_limits_enabled,
   'cycle_limit',cycle_limit,'day_limit',day_limit) from public.pilot_watcher_control where id),
 'source',(select jsonb_build_object('initialized',initialized,'paused',paused,
   'alerts_enabled',alerts_enabled,'bootstrap_done',bootstrap_done,'bootstrap_next',bootstrap_next,
   'last_login_ok',last_login_ok,'last_forecast_ok',last_forecast_ok,'last_error',last_error)
   from public.hpbot_control where id),
 'pilot_window',(select jsonb_build_object('runs',count(*),'successful',count(*) filter(where success),
   'failed',count(*) filter(where success=false),'unfinished',count(*) filter(where success is null),
   'average_estimated_bytes',round(avg(estimated_bytes)),
   'last_success',max(finished_at) filter(where success))
   from public.pilot_runs where started_at>=b.since),
 'pilot_missing_full_minutes',(select count(*) from slots s where not exists
   (select 1 from public.pilot_runs r where r.slot=s.s)),
 'monitor_logs',(select jsonb_build_object('count',count(*),
   'both_sources_ok',count(*) filter(where hpbot_login_ok and forecast_fetch_ok),
   'last_observation',max(created_at)) from public.pilot_monitor_logs where created_at>=b.since),
 'queue',jsonb_build_object(
   'active_total',(select count(*) from public.hpbot_pilot_queue),
   'active_today_through_seven_days',(select count(*) from public.hpbot_pilot_queue where
     pilot_date between (b.checked_at at time zone 'Asia/Seoul')::date::text
     and ((b.checked_at at time zone 'Asia/Seoul')::date+7)::text),
   'terminal_in_queue',(select count(*) from public.hpbot_pilot_queue where application_status in('050','060','090')),
   'active_past_date',(select count(*) from public.hpbot_pilot_queue where pilot_date<(b.checked_at at time zone 'Asia/Seoul')::date::text),
   'lifecycle_inconsistencies',(select count(*) from public.hpbot_pilot_current
     where application_status in('050','060') and completion_status<>'COMPLETED'
        or application_status='090' and completion_status<>'CANCELLED')),
 'weather',(select jsonb_build_object('status',status,'bad_weather_count',bad_weather_count,
   'dense_fog_count',to_jsonb(pilot_weather_state)->'dense_fog_count',
   'port_close_count',to_jsonb(pilot_weather_state)->'port_close_count',
   'suspension_total_count',to_jsonb(pilot_weather_state)->'suspension_total_count',
   'suspension_reasons',to_jsonb(pilot_weather_state)->'suspension_reasons',
   'started_at',started_at,'resumed_at',resumed_at,'last_seen_at',last_seen_at)
   from public.pilot_weather_state where id),
 'jstt',(select jsonb_build_object('enabled',enabled,'disabled_reason',disabled_reason,
   'last_success',last_success,'failure_count',failure_count,'last_error',last_error,
   'unknown_count',to_jsonb(jstt_monitor_control)->'unknown_count',
   'last_warning',to_jsonb(jstt_monitor_control)->'last_warning')
   from public.jstt_monitor_control where id),
 'jstt_window',(select jsonb_build_object('runs',count(*),'successful',count(*) filter(where success),
   'failed',count(*) filter(where success=false),'unfinished',count(*) filter(where success is null),
   'max_duration_ms',max(duration_ms),'average_estimated_bytes',round(avg(estimated_bytes)))
   from public.jstt_monitor_runs where started_at>=b.since and not probe),
 'jstt_missing_scheduled_slots',(select count(*) from slots s
   where extract(minute from s.s at time zone 'Asia/Seoul')::int%20=0
   and not exists(select 1 from public.jstt_monitor_runs r where r.slot=s.s and not r.probe)),
 'jstt_events',(select count(*) from public.jstt_berth_events),
 'notifications',(select coalesce(jsonb_agg(t),'[]') from (
   select notification_type,status,count(*) as count from public.pilot_notifications
   group by notification_type,status order by notification_type,status)t),
 'outbox_older_than_five_minutes',(select count(*) from public.pilot_notifications
   where status in('PENDING','SENDING') and created_at<b.checked_at-interval '5 minutes'),
 'duplicate_notification_keys',(select count(*) from (select notification_key from public.pilot_notifications group by notification_key having count(*)>1)t),
 'duplicate_telegram_receipts',(select count(*) from (select telegram_chat_id,telegram_message_id
   from public.pilot_notifications where telegram_message_id is not null
   group by telegram_chat_id,telegram_message_id having count(*)>1)t),
 'registration',(select jsonb_build_object('create_enabled',create_enabled,
   'update_enabled',update_enabled,'copy_enabled',copy_enabled)
   from public.pilot_registration_control where id),
 'requests',(select coalesce(jsonb_agg(t),'[]') from (
   select action,status,count(*) as count,count(submitted_at) as submitted
   from public.pilot_registration_requests group by action,status order by action,status)t),
 'copy_sources',(select jsonb_build_object('total',count(*),'complete',count(*) filter(where complete))
   from public.pilot_copy_sources),
 'copy_jobs',(select count(*) from public.pilot_copy_jobs),
 'estimated_usage',(select coalesce(jsonb_agg(t),'[]') from (
   select scope,estimated_bytes,updated_at from public.pilot_usage order by updated_at desc limit 4)t),
 'security',jsonb_build_object('bot_tables', (select count(*) from bot_tables),
   'rls_disabled',(select coalesce(jsonb_agg(relname),'[]') from bot_tables where not relrowsecurity),
   'browser_table_privileges',(select coalesce(jsonb_agg(relname),'[]') from bot_tables where
     has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE') or
     has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE'))),
 'cron',(select coalesce(jsonb_agg(t),'[]') from (
   select jobname,schedule,active from cron.job where jobname in('ulsan-pilot-watcher','ulsan-pilot-cleanup') order by jobname)t)
) as evidence from bounds b;
