begin;
-- Explicit operator opt-out only. Provider billing protections, authentication,
-- request-size limits, leases and rate limits are NOT changed by this switch.
alter table public.pilot_watcher_control add column cost_limits_enabled boolean not null default true;
comment on column public.pilot_watcher_control.cost_limits_enabled is
 'App budget/review auto-stop only. False keeps accounting and warnings; does not change provider billing.';

create or replace function public.pilot_reserve(p_bytes bigint,p_at timestamptz default now())
returns boolean language plpgsql set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control; cycle_key text; day_key text; used_cycle bigint; used_day bigint;
begin
 if p_bytes is null or p_bytes<0 or p_bytes>1048576 then raise exception 'INVALID_RESERVATION'; end if;
 select * into c from public.pilot_watcher_control where id for update;
 if not c.enabled then return false; end if;
 if c.cost_limits_enabled and (c.billing_verified_at is null or c.cycle_start is null or c.cycle_end is null or p_at<c.cycle_start or p_at>=c.cycle_end) then
  update public.pilot_watcher_control set enabled=false,disabled_reason='BILLING_REVIEW_REQUIRED',continuous=false where id;
  return false;
 end if;
 -- Do not reset the ledger on opt-out or at the old manual review deadline.
 -- Without enforcement, this remains an anchored cumulative estimate, NOT a
 -- claim about the provider billing cycle. Daily scopes still roll over in KST.
 if c.cycle_start is null then raise exception 'USAGE_ANCHOR_REQUIRED';end if;
 cycle_key:='cycle:'||to_char(c.cycle_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
 day_key:='day:'||(p_at at time zone 'Asia/Seoul')::date::text;
 insert into public.pilot_usage(scope) values(cycle_key),(day_key) on conflict do nothing;
 select estimated_bytes into used_cycle from public.pilot_usage where scope=cycle_key;
 select estimated_bytes into used_day from public.pilot_usage where scope=day_key;
 if c.cost_limits_enabled and (used_cycle+p_bytes>c.cycle_limit-8192 or used_day+p_bytes>c.day_limit-8192) then
  update public.pilot_watcher_control set enabled=false,disabled_reason='EGRESS_BUDGET',continuous=false where id;
  update public.pilot_usage set estimated_bytes=estimated_bytes+8192,updated_at=p_at where scope in(cycle_key,day_key);
  perform public.pilot_queue('cost_stop:'||cycle_key||':'||day_key,'COST_STOP',cycle_key,'⚠️ [울산 도선 감시 비용 보호 중지]'||chr(10)||'추정 전송량 예산에 도달하여 이 watcher를 중지했습니다. 사용량 확인 후 수동 재개가 필요합니다.');
  return false;
 end if;
 update public.pilot_usage set estimated_bytes=estimated_bytes+p_bytes,updated_at=p_at where scope in(cycle_key,day_key);
 if used_cycle<c.warning_limit and used_cycle+p_bytes>=c.warning_limit then
  perform public.pilot_queue('cost_warning:'||cycle_key,'COST_WARNING',cycle_key,'⚠️ [울산 도선 감시 전송량 경고]'||chr(10)||'추정 전송량이 경고 기준에 도달했습니다. 실제 청구량은 Supabase Usage에서 확인해 주세요.');
 end if;
 return true;
end $$;

create or replace function public.pilot_budget_settle(p_id uuid,p_bytes bigint) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.pilot_budget_reservations;n bigint;refund bigint;enforced boolean;
begin
 select cost_limits_enabled into enforced from public.pilot_watcher_control where id for update;
 select * into r from public.pilot_budget_reservations where id=p_id for update;
 if r.id is null or r.settled_at is not null then return false;end if;
 if p_bytes is null or p_bytes<0 or p_bytes>1048576 then raise exception 'INVALID_SETTLEMENT';end if;
 n:=greatest(8192,p_bytes);refund:=r.reserved_bytes-n;
 if (select count(*) from public.pilot_usage where scope in(r.cycle_scope,r.day_scope) and estimated_bytes>=greatest(0,refund))<>2 then
  raise exception 'SETTLEMENT_LEDGER_MISMATCH';
 end if;
 update public.pilot_usage set estimated_bytes=estimated_bytes-refund,updated_at=now() where scope in(r.cycle_scope,r.day_scope);
 update public.pilot_budget_reservations set settled_bytes=n,refund_bytes=refund,settled_at=now() where id=p_id;
 if enforced and refund<0 then
  update public.pilot_watcher_control set enabled=false,disabled_reason='EGRESS_BUDGET',continuous=false where id;
  update public.pilot_weather_state set candidate_count=0,rearm_count=0,recovery_started_at=null where id;
 end if;
 return true;
end $$;

create or replace function public.jstt_reserve(p_id uuid,p_bytes bigint,p_at timestamptz default now()) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control;cy text;dy text;used_c bigint;used_d bigint;
begin
 select * into c from public.pilot_watcher_control where id for update;
 perform 1 from public.jstt_monitor_control where id for update;
 if p_bytes is null or p_bytes<1024 or p_bytes>524288 or exists(select 1 from public.jstt_budget_reservations where id=p_id) then return false;end if;
 if not c.enabled then return false;end if;
 if c.cost_limits_enabled and (c.billing_verified_at is null or c.cycle_start is null or c.cycle_end is null or p_at<c.cycle_start or p_at>=c.cycle_end) then return false;end if;
 if c.cycle_start is null then raise exception 'USAGE_ANCHOR_REQUIRED';end if;
 cy:='cycle:'||to_char(c.cycle_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');dy:='day:'||(p_at at time zone 'Asia/Seoul')::date::text;
 select coalesce(max(estimated_bytes),0) into used_c from public.pilot_usage where scope=cy;
 select coalesce(max(estimated_bytes),0) into used_d from public.pilot_usage where scope=dy;
 if c.cost_limits_enabled and (used_c+p_bytes>least(402653184,c.warning_limit,c.cycle_limit-8192) or used_d+p_bytes>least(20971520,c.day_limit-8192)) then
  update public.jstt_monitor_control set enabled=false,disabled_reason='JSTT_BUDGET' where id;return false;
 end if;
 if not public.pilot_reserve(p_bytes,p_at) then return false;end if;
 insert into public.jstt_budget_reservations values(p_id,cy,dy,p_bytes,null,p_at,null);return true;
end $$;

create or replace function public.jstt_settle(p_id uuid,p_bytes bigint) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.jstt_budget_reservations;n bigint;enforced boolean;
begin
 select cost_limits_enabled into enforced from public.pilot_watcher_control where id for update;
 select * into r from public.jstt_budget_reservations where id=p_id for update;
 if not found or r.settled_at is not null then return;end if;
 n:=greatest(2048,coalesce(p_bytes,r.reserved_bytes));
 update public.pilot_usage set estimated_bytes=greatest(0,estimated_bytes-r.reserved_bytes+n),updated_at=now() where scope in(r.cycle_scope,r.day_scope);
 update public.jstt_budget_reservations set settled_bytes=n,settled_at=now() where id=p_id;
 update public.jstt_monitor_runs set estimated_bytes=n where id=p_id;
 if enforced and n>r.reserved_bytes then update public.jstt_monitor_control set enabled=false,disabled_reason='JSTT_BUDGET_OVERRUN' where id;end if;
end $$;

-- Do not claim that the bot will auto-stop in informational warnings while off.
alter function public.pilot_operational_message(text,text) rename to pilot_operational_message_before_optional_limits;
create function public.pilot_operational_message(p_type text,p_message text) returns text
language plpgsql stable set search_path=pg_catalog,public as $$
begin
 if not (select cost_limits_enabled from public.pilot_watcher_control where id) and p_type='COST_WARNING' then
  return p_message||chr(10)||'자체 비용 자동중지: 해제 (사용량 기록 유지)'||chr(10)||'※ 앱 추정량이며 실제 청구 Egress와 다릅니다.';
 end if;
 return public.pilot_operational_message_before_optional_limits(p_type,p_message);
end $$;
-- Rebind SQL queue after function rename (SQL dependencies may retain old OID).
create or replace function public.pilot_queue(p_key text,p_type text,p_ref text,p_message text) returns void
language sql set search_path=pg_catalog,public as $$
 insert into public.pilot_notifications(notification_key,notification_type,reference_id,message)
 values(p_key,p_type,p_ref,left(public.pilot_operational_message(p_type,p_message),2800)) on conflict do nothing
$$;
revoke all on function public.pilot_reserve(bigint,timestamptz),public.pilot_budget_settle(uuid,bigint),public.jstt_reserve(uuid,bigint,timestamptz),public.jstt_settle(uuid,bigint),public.pilot_operational_message(text,text),public.pilot_operational_message_before_optional_limits(text,text) from public,anon,authenticated;
grant execute on function public.pilot_reserve(bigint,timestamptz),public.pilot_budget_settle(uuid,bigint),public.jstt_reserve(uuid,bigint,timestamptz),public.jstt_settle(uuid,bigint),public.pilot_operational_message(text,text) to service_role;
commit;
