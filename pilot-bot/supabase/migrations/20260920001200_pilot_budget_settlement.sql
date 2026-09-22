begin;
-- Reservations remain conservative until an authenticated worker settles them.
-- This is an application estimate, not Supabase's billing meter.
create table public.pilot_budget_reservations (
 id uuid primary key, cycle_scope text not null, day_scope text not null,
 reserved_bytes bigint not null check(reserved_bytes in(131072,262144)),
 settled_bytes bigint, refund_bytes bigint, created_at timestamptz not null default now(), settled_at timestamptz,
 check(settled_bytes is null or settled_bytes>=8192)
);
alter table public.pilot_budget_reservations enable row level security;
revoke all on public.pilot_budget_reservations from public,anon,authenticated;
grant select on public.pilot_budget_reservations to service_role;

alter function public.pilot_mini_open(text,bigint,uuid,int) rename to pilot_mini_open_before_budget;
create function public.pilot_mini_open(p_chat text,p_user bigint,p_id uuid default null,p_bytes int default 131072,p_reservation uuid default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r jsonb; c public.pilot_watcher_control;
begin
 select * into c from public.pilot_watcher_control where id for update;
 if p_reservation is not null and exists(select 1 from public.pilot_budget_reservations where id=p_reservation) then
  return jsonb_build_object('error','MINI_RESERVATION_REUSED');
 end if;
 r:=public.pilot_mini_open_before_budget(p_chat,p_user,p_id,p_bytes);
 if r ? 'error' or p_reservation is null then return r; end if;
 insert into public.pilot_budget_reservations(id,cycle_scope,day_scope,reserved_bytes)
 values(p_reservation,'cycle:'||to_char(c.cycle_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'day:'||(now() at time zone 'Asia/Seoul')::date::text,p_bytes);
 return r||jsonb_build_object('budget_id',p_reservation,'reserved_bytes',p_bytes);
end $$;

create function public.pilot_budget_settle(p_id uuid,p_bytes bigint) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.pilot_budget_reservations; n bigint; refund bigint;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 select * into r from public.pilot_budget_reservations where id=p_id for update;
 if r.id is null or r.settled_at is not null then return false; end if;
 if p_bytes is null or p_bytes<0 or p_bytes>1048576 then raise exception 'INVALID_SETTLEMENT'; end if;
 n:=greatest(8192,p_bytes); refund:=r.reserved_bytes-n;
 -- Both counters are the original reservation scopes, even across midnight.
 if (select count(*) from public.pilot_usage where scope in(r.cycle_scope,r.day_scope) and estimated_bytes>=greatest(0,refund))<>2 then
  raise exception 'SETTLEMENT_LEDGER_MISMATCH';
 end if;
 update public.pilot_usage set estimated_bytes=estimated_bytes-refund,updated_at=now() where scope in(r.cycle_scope,r.day_scope);
 update public.pilot_budget_reservations set settled_bytes=n,refund_bytes=refund,settled_at=now() where id=p_id;
 if refund<0 then
  -- Never conceal an unexpectedly large operation. Record the excess and latch
  -- a stop for manual review; no automatic resume from a refund either.
  update public.pilot_watcher_control set enabled=false,disabled_reason='EGRESS_BUDGET',continuous=false where id;
  update public.pilot_weather_state set candidate_count=0,rearm_count=0,recovery_started_at=null where id;
 end if;
 return true;
end $$;

-- Audited one-time corrections keep original per-run reservations intact.
create table public.pilot_budget_corrections (
 run_id uuid primary key, correction_bytes bigint not null check(correction_bytes>0),
 cycle_scope text not null, day_scope text not null, evidence text not null,
 created_at timestamptz not null default now()
);
alter table public.pilot_budget_corrections enable row level security;
revoke all on public.pilot_budget_corrections from public,anon,authenticated;

-- Lower bound only: UTF-8 object keys and string values, excluding punctuation,
-- escapes, numbers and all whitespace formatting. Always <= JSON.stringify.
create function public.pilot_json_string_lower_bound(p_value jsonb) returns bigint
language plpgsql immutable set search_path=pg_catalog,public as $$
declare n bigint:=0; k text; v jsonb;
begin
 if jsonb_typeof(p_value)='string' then return octet_length(p_value#>>'{}');
 elsif jsonb_typeof(p_value)='array' then
  for v in select value from jsonb_array_elements(p_value) loop n:=n+public.pilot_json_string_lower_bound(v); end loop;
 elsif jsonb_typeof(p_value)='object' then
  for k,v in select key,value from jsonb_each(p_value) loop n:=n+octet_length(k)+public.pilot_json_string_lower_bound(v); end loop;
 end if;
 return n;
end $$;

create function public.pilot_duplicate_budget_candidates(p_start timestamptz,p_end timestamptz)
returns table(run_id uuid,day_scope text,correction_bytes bigint)
language sql stable set search_path=pg_catalog,public as $$
 select r.id,'day:'||(r.started_at at time zone 'Asia/Seoul')::date::text,
 least(sum(public.pilot_json_string_lower_bound(s.rows)),(r.estimated_bytes-8192)/2)::bigint
 from public.pilot_runs r join public.hpbot_source_snapshots s on s.observed_at=r.finished_at
 where r.success and r.parser_version='hyopu-dual-v1' and r.started_at>=p_start and r.finished_at<p_end
 and r.estimated_bytes>8192
 and not exists(select 1 from public.pilot_budget_corrections x where x.run_id=r.id)
 and (select count(*) from public.pilot_runs x where x.finished_at=r.finished_at)=1
 group by r.id,r.started_at,r.estimated_bytes
 having least(sum(public.pilot_json_string_lower_bound(s.rows)),(r.estimated_bytes-8192)/2)>0;
$$;

revoke all on function public.pilot_mini_open(text,bigint,uuid,int,uuid),public.pilot_budget_settle(uuid,bigint),public.pilot_json_string_lower_bound(jsonb),public.pilot_duplicate_budget_candidates(timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.pilot_mini_open(text,bigint,uuid,int,uuid),public.pilot_budget_settle(uuid,bigint) to service_role;
-- Unsettled reservations remain charged. Ledger has no personal data.
alter function public.pilot_cleanup(timestamptz) rename to pilot_cleanup_before_budget;
create function public.pilot_cleanup(p_at timestamptz default now()) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform public.pilot_cleanup_before_budget(p_at);
 delete from public.pilot_budget_reservations where settled_at<p_at-interval '30 days';
end $$;
revoke all on function public.pilot_cleanup(timestamptz) from public,anon,authenticated;
grant execute on function public.pilot_cleanup(timestamptz) to service_role;
commit;
