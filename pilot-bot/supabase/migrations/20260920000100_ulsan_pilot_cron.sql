-- Supabase-only scheduler. Migration does NOT create/enable any cron job.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create function public.pilot_cron_tick() returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control; v_slot timestamptz:=date_trunc('minute',now());
  endpoint text; secret text; gateway_jwt text; reserved boolean;
begin
  select * into c from public.pilot_watcher_control where id for update;
  if not c.enabled or c.dispatch_slot=v_slot or c.lease_until>now() then return; end if;
  select decrypted_secret into endpoint from vault.decrypted_secrets where name='ulsan_watcher_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name='ulsan_watcher_key';
  select decrypted_secret into gateway_jwt from vault.decrypted_secrets where name='ulsan_gateway_anon_jwt';
  if endpoint !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/ulsan-pilot-watcher$' or endpoint is null or length(secret)<32 or secret is null
    or gateway_jwt is null or gateway_jwt !~ '^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then
    perform public.pilot_disable(); return;
  end if;
  reserved:=public.pilot_reserve(1024);
  -- A new budget-stop gets exactly one final invocation, from its reserved
  -- emergency allowance. Future cron ticks return before any HTTP request.
  if not reserved and not exists(select 1 from public.pilot_notifications where notification_type='COST_STOP' and status='PENDING') then return; end if;
  update public.pilot_watcher_control set dispatch_slot=v_slot where id;
  perform net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||gateway_jwt,'x-watcher-key',secret),body:='{}'::jsonb,timeout_milliseconds:=55000);
end $$;

create function public.pilot_install_cron() returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not exists(select 1 from public.pilot_watcher_control where enabled and billing_verified_at is not null and cycle_end>now()) then raise exception 'WATCHER_NOT_APPROVED'; end if;
  -- Named jobs are updated, not duplicated on re-deploy.
  perform cron.schedule('ulsan-pilot-watcher','* * * * *','select public.pilot_cron_tick();');
  perform cron.schedule('ulsan-pilot-cleanup','37 18 * * *','select public.pilot_cleanup();');
end $$;
revoke all on function public.pilot_cron_tick() from public,anon,authenticated;
revoke all on function public.pilot_install_cron() from public,anon,authenticated;
grant execute on function public.pilot_cron_tick() to service_role;
grant execute on function public.pilot_install_cron() to service_role;
commit;
