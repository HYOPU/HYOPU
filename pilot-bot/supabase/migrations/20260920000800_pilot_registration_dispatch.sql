begin;
alter table public.pilot_registration_requests add column dispatched_at timestamptz;
create function public.pilot_reg_dispatch() returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.pilot_registration_requests; endpoint text; secret text; gateway text;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 if not exists(select 1 from public.pilot_watcher_control where id and enabled) then return; end if;
 select * into r from public.pilot_registration_requests where
   (status='CONFIRMED' or (status in('SUBMITTING','VERIFYING') and worker_until<now())
     or (status='UNKNOWN' and reconcile_after<=now() and reconcile_attempts<3))
   and (dispatched_at is null or dispatched_at<now()-interval '1 minute')
   and (worker_until is null or worker_until<now()) order by created_at limit 1 for update skip locked;
 if r.id is null then return; end if; -- zero additional Edge invocations while idle
 select replace(decrypted_secret,'/ulsan-pilot-watcher','/ulsan-pilot-registration') into endpoint from vault.decrypted_secrets where name='ulsan_watcher_url';
 select decrypted_secret into secret from vault.decrypted_secrets where name='ulsan_watcher_key';
 select decrypted_secret into gateway from vault.decrypted_secrets where name='ulsan_gateway_anon_jwt';
 if endpoint is null or endpoint!~'^https://[a-z0-9]+\.supabase\.co/functions/v1/ulsan-pilot-registration$' or secret is null or length(secret)<32 or gateway is null then return; end if;
 if not public.pilot_reserve(2048) then return; end if;
 update public.pilot_registration_requests set dispatched_at=now() where id=r.id;
 perform net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||gateway,'x-watcher-key',secret),
   body:=jsonb_build_object('request_id',r.id),timeout_milliseconds:=55000);
end $$;
-- Preserve the existing job ID and schedule; add demand-only recovery dispatch.
alter function public.pilot_cron_tick() rename to pilot_cron_tick_before_registration;
create function public.pilot_cron_tick() returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform public.pilot_reg_dispatch();
 perform public.pilot_cron_tick_before_registration();
end $$;
revoke all on function public.pilot_reg_dispatch(),public.pilot_cron_tick(),public.pilot_cron_tick_before_registration() from public,anon,authenticated;
grant execute on function public.pilot_reg_dispatch(),public.pilot_cron_tick(),public.pilot_cron_tick_before_registration() to service_role;
commit;
