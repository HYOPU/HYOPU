-- Keep the compact execution log connected to its already-idempotent settlement.
begin;
create or replace function public.jstt_settle(p_id uuid,p_bytes bigint) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.jstt_budget_reservations;n bigint;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 select * into r from public.jstt_budget_reservations where id=p_id for update;
 if not found or r.settled_at is not null then return;end if;
 n:=greatest(2048,coalesce(p_bytes,r.reserved_bytes));
 update public.pilot_usage set estimated_bytes=greatest(0,estimated_bytes-r.reserved_bytes+n),updated_at=now() where scope in(r.cycle_scope,r.day_scope);
 update public.jstt_budget_reservations set settled_bytes=n,settled_at=now() where id=p_id;
 update public.jstt_monitor_runs set estimated_bytes=n where id=p_id;
 if n>r.reserved_bytes then update public.jstt_monitor_control set enabled=false,disabled_reason='JSTT_BUDGET_OVERRUN' where id;end if;
end $$;
revoke all on function public.jstt_settle(uuid,bigint) from public,anon,authenticated;
grant execute on function public.jstt_settle(uuid,bigint) to service_role;
commit;
