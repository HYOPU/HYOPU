-- Independent watcher. Disabled until billing and Telegram have been verified.
begin;
create table public.pilot_watcher_control (
  id boolean primary key default true check(id), enabled boolean not null default false,
  disabled_reason text, billing_verified_at timestamptz, billing_evidence jsonb,
  cycle_start timestamptz, cycle_end timestamptz,
  cycle_limit bigint not null default 536870912, warning_limit bigint not null default 402653184,
  day_limit bigint not null default 25165824,
  last_hash text, snapshot_id bigint, version bigint not null default 0,
  last_success timestamptz, last_slot timestamptz, continuous boolean not null default false,
  failure_count int not null default 0, outage_id uuid,
  lease_token uuid, lease_until timestamptz, lease_slot timestamptz, dispatch_slot timestamptz,
  drop_hash text, drop_counts jsonb,
  check(cycle_limit >= 16384 and day_limit >= 16384 and warning_limit < cycle_limit)
);
insert into public.pilot_watcher_control(id) values(true);
create table public.pilot_weather_state (
  id boolean primary key default true check(id), status text not null default 'NORMAL' check(status in ('NORMAL','SUSPENDED','RESUMED')),
  bad_weather_count int not null default 0, candidate_count int not null default 0,
  rearm_count int not null default 0, started_at timestamptz, resumed_at timestamptz,
  resume_alert_sent boolean not null default false, recovery_started_at timestamptz,
  event_id uuid, last_seen_at timestamptz, updated_at timestamptz not null default now()
);
insert into public.pilot_weather_state(id) values(true);
create table public.pilot_snapshots (
  id bigint generated always as identity primary key, content_hash text not null,
  rows jsonb not null, observed_at timestamptz not null,
  check(jsonb_typeof(rows)='array' and octet_length(rows::text)<=800000)
);
create table public.pilot_current (
  id uuid primary key default gen_random_uuid(), external_key text unique not null,
  vessel_name text not null, pilot_date date not null, pilot_time text not null,
  from_location text not null, to_location text not null, remarks text not null,
  status text not null, raw_status text not null, agent text not null, raw_data jsonb not null,
  first_seen_at timestamptz not null, last_seen_at timestamptz not null, updated_at timestamptz not null
);
create table public.pilot_history (
  id bigint generated always as identity primary key, external_key text not null,
  vessel_name text not null, event_type text not null check(event_type in ('NEW','TIME_CHANGED','ROUTE_CHANGED','STATUS_CHANGED','REMARK_CHANGED','CANCELLED','BAD_WEATHER_TO_PROCESSING')),
  old_data jsonb, new_data jsonb, detected_at timestamptz not null
);
create table public.pilot_weather_events (
  id uuid primary key, started_at timestamptz not null, ended_at timestamptz,
  resume_detected_at timestamptz, resume_vessel_name text, resume_schedule_key text,
  resume_method text, duration_seconds bigint, max_bad_weather_count int not null,
  suspension_notification_sent_at timestamptz, resume_notification_sent_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.pilot_notifications (
  id uuid primary key default gen_random_uuid(), notification_key text unique not null,
  notification_type text not null, reference_id text not null, message text not null,
  status text not null default 'PENDING' check(status in ('PENDING','SENDING','SENT','UNKNOWN','FAILED')),
  telegram_message_id bigint, error text, attempts int not null default 0,
  next_attempt_at timestamptz not null default now(), claimed_at timestamptz,
  created_at timestamptz not null default now(), sent_at timestamptz,
  check(octet_length(message)<=12000)
);
create table public.pilot_runs (
  id uuid primary key, slot timestamptz unique not null, started_at timestamptz not null,
  finished_at timestamptz, success boolean, error text, snapshot_id bigint,
  ingress_bytes bigint not null default 0, estimated_bytes bigint not null default 8192,
  parser_version text not null default 'ulsan-html-20-v1'
);
create table public.pilot_usage (
  scope text primary key, estimated_bytes bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table public.pilot_notification_attempts (
  notification_id uuid not null references public.pilot_notifications(id) on delete cascade,
  attempt int not null, started_at timestamptz not null, finished_at timestamptz,
  status text not null, error text, primary key(notification_id,attempt)
);
create index on public.pilot_history(detected_at);
create index on public.pilot_notifications(status,next_attempt_at);
create index on public.pilot_runs(started_at);

-- Effective last_seen_at without rewriting unchanged rows every minute.
create view public.pilot_current_observed with (security_invoker=true) as
select c.id,c.external_key,c.vessel_name,c.pilot_date,c.pilot_time,c.from_location,c.to_location,
 c.remarks,c.status,c.raw_status,c.agent,c.raw_data,c.first_seen_at,
 coalesce(live.observed_at,c.last_seen_at) as last_seen_at,c.updated_at
from public.pilot_current c left join (
 select distinct r->>'external_key' as external_key,w.last_success as observed_at
 from public.pilot_watcher_control w join public.pilot_snapshots s on s.id=w.snapshot_id,
 lateral jsonb_array_elements(s.rows) r
) live on live.external_key=c.external_key;
revoke all on public.pilot_current_observed from public,anon,authenticated;
grant select on public.pilot_current_observed to service_role;

-- Pure reducer: used by BOTH live commit and read-only preview. No network/SQL writes.
create function public.pilot_plan(p_old jsonb,p_rows jsonb,p_state jsonb,p_continuous boolean,p_at timestamptz)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare
  r jsonb; o jsonb; x jsonb; s jsonb := p_state; mapped jsonb := '[]'; changes jsonb := '[]';
  resumes jsonb := '[]'; events jsonb := '[]'; n int; old_n int; cur_n int; k text; typ text;
  strict_match boolean; unambiguous boolean; candidate int; rearm int; recovery timestamptz;
begin
  for r in select value from jsonb_array_elements(p_rows) loop
    o := null; strict_match := false;
    select count(*) into cur_n from jsonb_array_elements(p_rows) a where a->>'identity'=r->>'identity';
    select count(*) into old_n from jsonb_array_elements(p_old) a where a->>'identity'=r->>'identity';
    unambiguous := cur_n=1 and coalesce(r->>'callsign','')<>'';
    if unambiguous and old_n=1 then
      select value into o from jsonb_array_elements(p_old) where value->>'identity'=r->>'identity';
      strict_match := coalesce((o->>'unambiguous')::boolean,false);
    elsif unambiguous and old_n=0 then
      -- Route-only matching: one old and one new operation for this vessel/day/agent.
      select count(*) into old_n from jsonb_array_elements(p_old) a where a->>'callsign'=r->>'callsign' and a->>'vessel_name'=r->>'vessel_name' and a->>'pilot_date'=r->>'pilot_date' and a->>'agent'=r->>'agent';
      select count(*) into n from jsonb_array_elements(p_rows) a where a->>'callsign'=r->>'callsign' and a->>'vessel_name'=r->>'vessel_name' and a->>'pilot_date'=r->>'pilot_date' and a->>'agent'=r->>'agent';
      if old_n=1 and n=1 then
        select value into o from jsonb_array_elements(p_old) a where a->>'callsign'=r->>'callsign' and a->>'vessel_name'=r->>'vessel_name' and a->>'pilot_date'=r->>'pilot_date' and a->>'agent'=r->>'agent'
          and (a->>'from_location'=r->>'from_location' or a->>'to_location'=r->>'to_location');
      end if;
    end if;
    k := coalesce(o->>'external_key',r->>'identity');
    -- Ambiguous collisions are observation records only, never merged current operations.
    r := r || jsonb_build_object('external_key',k,'unambiguous',unambiguous);
    mapped := mapped || jsonb_build_array(r);
    if not p_continuous or not unambiguous or r->>'agent'<>'협운' or jsonb_array_length(p_old)=0 then continue; end if;
    if o is null then
      -- First-seen cancelled entries are historical, not new operational schedules.
      if not (r->>'cancelled')::boolean then changes := changes||jsonb_build_array(jsonb_build_object('type','NEW','key',k,'old',null,'new',r)); end if;
    else
      for typ in select unnest(array['TIME_CHANGED','ROUTE_CHANGED','STATUS_CHANGED','REMARK_CHANGED']) loop
        if (typ='TIME_CHANGED' and o->>'pilot_time' is distinct from r->>'pilot_time') or
          (typ='ROUTE_CHANGED' and (o->>'from_location' is distinct from r->>'from_location' or o->>'to_location' is distinct from r->>'to_location')) or
          (typ='STATUS_CHANGED' and o->>'status' is distinct from r->>'status') or
          (typ='REMARK_CHANGED' and o->>'remarks' is distinct from r->>'remarks') then
          changes := changes||jsonb_build_array(jsonb_build_object('type',case when typ='STATUS_CHANGED' and (r->>'cancelled')::boolean then 'CANCELLED' else typ end,'key',k,'old',o,'new',r));
        end if;
      end loop;
      if p_continuous and strict_match and o->>'agent'='협운' and o->>'status'='BAD_WEATHER' and r->>'status'='PROCESSING' and not (o->>'cancelled')::boolean and not (r->>'cancelled')::boolean then
        resumes := resumes||jsonb_build_array(r);
        changes := changes||jsonb_build_array(jsonb_build_object('type','BAD_WEATHER_TO_PROCESSING','key',k,'old',o,'new',r));
      end if;
    end if;
  end loop;
  select count(distinct coalesce(nullif(a->>'callsign',''),a->>'vessel_name')) into n
    from jsonb_array_elements(p_rows) a where a->>'status'='BAD_WEATHER' and not (a->>'cancelled')::boolean;
  candidate := case when p_continuous then coalesce((s->>'candidate_count')::int,0) else 0 end;
  rearm := case when p_continuous then coalesce((s->>'rearm_count')::int,0) else 0 end;
  recovery := case when p_continuous then (s->>'recovery_started_at')::timestamptz else null end;
  if s->>'status'='NORMAL' then
    candidate := case when n>=2 then candidate+1 else 0 end;
    if candidate>=2 then
      s := s||jsonb_build_object('status','SUSPENDED','started_at',p_at,'resumed_at',null,'resume_alert_sent',false);
      events := jsonb_build_array(jsonb_build_object('type','SUSPEND'));
      candidate := 0;
    end if;
  elsif s->>'status'='SUSPENDED' then
    if n=0 then recovery := coalesce(recovery,p_at); else recovery:=null; end if;
    if jsonb_array_length(resumes)>0 or (recovery is not null and p_at-recovery>=interval '30 minutes') then
      s := s||jsonb_build_object('status','RESUMED','resumed_at',p_at);
      events := jsonb_build_array(jsonb_build_object('type','RESUME','method',case when jsonb_array_length(resumes)>0 then 'HYOPU_TRANSITION' else 'ZERO_30_MINUTES' end,'vessel',resumes->0));
      rearm:=0; recovery:=null;
    end if;
  elsif s->>'status'='RESUMED' then
    rearm:=case when n<2 then rearm+1 else 0 end;
    if rearm>=2 then s:=s||jsonb_build_object('status','NORMAL','event_id',null); rearm:=0; candidate:=0; end if;
  end if;
  s:=s||jsonb_build_object('bad_weather_count',n,'candidate_count',candidate,'rearm_count',rearm,'recovery_started_at',recovery,'last_seen_at',p_at,'updated_at',p_at);
  return jsonb_build_object('state',s,'rows',mapped,'changes',changes,'resumes',resumes,'events',events);
end $$;

create function public.pilot_queue(p_key text,p_type text,p_ref text,p_message text)
returns void language sql set search_path=pg_catalog,public as $$
  insert into public.pilot_notifications(notification_key,notification_type,reference_id,message)
  values(p_key,p_type,p_ref,left(p_message,2800)) on conflict(notification_key) do nothing;
$$;

-- Reserves, never refunds: hard crashes remain conservatively charged. The final
-- 8 KiB of each allowance is reserved exclusively for the stop notification.
create function public.pilot_reserve(p_bytes bigint,p_at timestamptz default now())
returns boolean language plpgsql set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control; cycle_key text; day_key text; used_cycle bigint; used_day bigint;
begin
  if p_bytes<0 or p_bytes>1048576 then raise exception 'INVALID_RESERVATION'; end if;
  select * into c from public.pilot_watcher_control where id for update;
  if not c.enabled then return false; end if;
  if c.billing_verified_at is null or c.cycle_start is null or c.cycle_end is null or p_at<c.cycle_start or p_at>=c.cycle_end then
    update public.pilot_watcher_control set enabled=false,disabled_reason='BILLING_REVIEW_REQUIRED',continuous=false where id;
    return false;
  end if;
  cycle_key:='cycle:'||to_char(c.cycle_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  day_key:='day:'||(p_at at time zone 'Asia/Seoul')::date::text;
  insert into public.pilot_usage(scope) values(cycle_key),(day_key) on conflict do nothing;
  select estimated_bytes into used_cycle from public.pilot_usage where scope=cycle_key;
  select estimated_bytes into used_day from public.pilot_usage where scope=day_key;
  if used_cycle+p_bytes>c.cycle_limit-8192 or used_day+p_bytes>c.day_limit-8192 then
    update public.pilot_watcher_control set enabled=false,disabled_reason='EGRESS_BUDGET',continuous=false where id;
    -- Reserve the one cost-stop alert even though ordinary spending is now closed.
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

create function public.pilot_fail(p_token uuid,p_error text,p_at timestamptz default now())
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control; incident uuid;
begin
  select * into c from public.pilot_watcher_control where id for update;
  if c.lease_token is distinct from p_token then return; end if;
  if not c.enabled then
    update public.pilot_watcher_control set continuous=false,lease_token=null,lease_until=null where id;
    update public.pilot_runs set finished_at=p_at,success=false,error='WATCHER_STOPPED' where id=p_token;
    update public.pilot_weather_state set candidate_count=0,rearm_count=0,recovery_started_at=null where id;
    return;
  end if;
  incident:=coalesce(c.outage_id,gen_random_uuid());
  update public.pilot_watcher_control set failure_count=failure_count+1,outage_id=incident,continuous=false,lease_token=null,lease_until=null where id;
  update public.pilot_weather_state set candidate_count=0,rearm_count=0,recovery_started_at=null where id;
  update public.pilot_runs set finished_at=p_at,success=false,error=left(p_error,80) where id=p_token;
  if c.failure_count=4 then perform public.pilot_queue('outage:'||incident,'SOURCE_ERROR',incident::text,'⚠️ [울산도선사회 감시 오류]'||chr(10)||'5회 연속 정상 수집에 실패했습니다. 기존 중단·재개 상태를 유지합니다.'); end if;
end $$;

create function public.pilot_begin(p_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control; token uuid:=gen_random_uuid(); v_slot timestamptz:=date_trunc('minute',p_at);
begin
  select * into c from public.pilot_watcher_control where id for update;
  if not c.enabled then return jsonb_build_object('skip','DISABLED_OR_BUDGET'); end if;
  if c.lease_until>p_at then return jsonb_build_object('skip','BUSY'); end if;
  if exists(select 1 from public.pilot_runs where pilot_runs.slot=v_slot) then return jsonb_build_object('skip','DUPLICATE_SLOT'); end if;
  if c.lease_token is not null then perform public.pilot_fail(c.lease_token,'EXECUTION_EXPIRED',p_at); end if;
  if not public.pilot_reserve(case when c.dispatch_slot=v_slot then 7168 else 8192 end,p_at) then return jsonb_build_object('skip','DISABLED_OR_BUDGET'); end if;
  insert into public.pilot_runs(id,slot,started_at) values(token,v_slot,p_at);
  update public.pilot_watcher_control set lease_token=token,lease_until=p_at+interval '50 seconds',lease_slot=v_slot where id;
  return jsonb_build_object('token',token,'hash',c.last_hash,'version',c.version);
end $$;

create function public.pilot_reserve_extra(p_token uuid,p_bytes bigint,p_at timestamptz default now())
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform 1 from public.pilot_watcher_control where id and lease_token=p_token and lease_until>p_at for update;
  if not found then return false; end if;
  if not public.pilot_reserve(p_bytes,p_at) then return false; end if;
  update public.pilot_runs set estimated_bytes=estimated_bytes+p_bytes where id=p_token;
  return true;
end $$;

create function public.pilot_weather_message(ev jsonb,s jsonb,p_at timestamptz)
returns text language plpgsql immutable set search_path=pg_catalog,public as $$
declare message text; duration bigint;
begin
  if ev->>'type'='SUSPEND' then
    return '🚨 [울산 도선중단 감지]'||chr(10)||'BAD WEATHER 표시 선박이 2척 이상 연속 확인되었습니다.'||chr(10)||'현재 BAD WEATHER: '||(s->>'bad_weather_count')||'척'||chr(10)||'중단 시작 감지: '||to_char(p_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI')||chr(10)||'※ 도선예보현황 자동감지 기준';
  end if;
  duration:=greatest(0,extract(epoch from p_at-(s->>'started_at')::timestamptz)::bigint);
  if ev->>'method'='HYOPU_TRANSITION' then
    message:='🟢 [울산 도선재개 감지]'||chr(10)||'협운 대리점 선박의 상태가 BAD WEATHER → PROCESSING으로 변경되었습니다.'||chr(10)||'선박: '||(ev#>>'{vessel,vessel_name}')||chr(10)||'시간: '||(ev#>>'{vessel,pilot_date}')||' '||(ev#>>'{vessel,pilot_time}')||chr(10)||'구간: '||(ev#>>'{vessel,from_location}')||' → '||(ev#>>'{vessel,to_location}');
  else message:='🟢 [울산 도선재개 추정]'||chr(10)||'BAD WEATHER 표시가 30분 이상 확인되지 않습니다.'||chr(10)||'협운 선박의 BAD WEATHER → PROCESSING 전환은 직접 확인되지 않았습니다.'; end if;
  return message||chr(10)||'중단 감지: '||to_char((s->>'started_at')::timestamptz at time zone 'Asia/Seoul','MM/DD HH24:MI')||chr(10)||'재개 감지: '||to_char(p_at at time zone 'Asia/Seoul','MM/DD HH24:MI')||chr(10)||'중단 지속시간: 약 '||(duration/3600)||'시간 '||((duration%3600)/60)||'분'||chr(10)||'※ 울산도선사회 도선예보현황 자동감지 기준';
end $$;

create function public.pilot_schedule_messages(changes jsonb,s jsonb)
returns text[] language plpgsql immutable set search_path=pg_catalog,public as $$
declare ch jsonb; message text:=''; label text; messages text[]:='{}';
begin
  for ch in select value from jsonb_array_elements(changes) loop
    if ch->>'type'='BAD_WEATHER_TO_PROCESSING' or (ch->>'type'='STATUS_CHANGED' and s->>'status'='RESUMED' and ch#>>'{old,status}'='BAD_WEATHER' and ch#>>'{new,status}'='PROCESSING') then continue; end if;
    label:=(ch#>>'{new,vessel_name}')||' ['||(ch->>'type')||'] ';
    label:=label||case ch->>'type'
      when 'TIME_CHANGED' then (ch#>>'{old,pilot_time}')||' → '||(ch#>>'{new,pilot_time}')
      when 'ROUTE_CHANGED' then (ch#>>'{old,from_location}')||' → '||(ch#>>'{old,to_location}')||' / 변경: '||(ch#>>'{new,from_location}')||' → '||(ch#>>'{new,to_location}')
      when 'STATUS_CHANGED' then (ch#>>'{old,raw_status}')||' → '||(ch#>>'{new,raw_status}')
      when 'REMARK_CHANGED' then left(ch#>>'{old,remarks}',250)||' → '||left(ch#>>'{new,remarks}',250)
      when 'CANCELLED' then '취소 목록에서 확인'
      else (ch#>>'{new,pilot_date}')||' '||(ch#>>'{new,pilot_time}') end||chr(10);
    if length(message)+length(label)>2400 and message<>'' then
      messages:=array_append(messages,'🔔 [협운 도선일정 변경]'||chr(10)||message); message:='';
    end if;
    message:=message||left(label,2400);
  end loop;
  if message<>'' then messages:=array_append(messages,'🔔 [협운 도선일정 변경]'||chr(10)||message); end if;
  return messages;
end $$;

create function public.pilot_has_row_drop(p_old jsonb,p_rows jsonb) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
  select exists(select 1 from (
    select d,
      (select count(*) from jsonb_array_elements(p_old) a where a->>'pilot_date'=d and not (a->>'cancelled')::boolean) as old_n,
      (select count(*) from jsonb_array_elements(p_rows) a where a->>'pilot_date'=d and not (a->>'cancelled')::boolean) as new_n
    from (select distinct a->>'pilot_date' d from jsonb_array_elements(p_rows) a) dates
  ) counts where old_n-new_n>=5 and new_n*2<=old_n);
$$;

-- Preview only reads. It returns no previous snapshot to the Edge Function.
create function public.pilot_preview(p_rows jsonb,p_at timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control; s jsonb; old_rows jsonb; plan jsonb; messages text[]; ev jsonb;
begin
  select * into c from public.pilot_watcher_control where id;
  select to_jsonb(w) into s from public.pilot_weather_state w where id;
  select rows into old_rows from public.pilot_snapshots where id=c.snapshot_id;
  if public.pilot_has_row_drop(coalesce(old_rows,'[]'),p_rows) then
    return jsonb_build_object('eligible',false,'reason','ABNORMAL_ROW_DROP','current_state',s->>'status','next_state',s,'expected_telegram_messages','[]'::jsonb,'truncated',false);
  end if;
  plan:=public.pilot_plan(coalesce(old_rows,'[]'),p_rows,s,c.continuous and date_trunc('minute',p_at)=c.last_slot+interval '1 minute' and p_at-c.last_success<=interval '90 seconds',p_at);
  messages:=public.pilot_schedule_messages(plan->'changes',plan->'state');
  for ev in select value from jsonb_array_elements(plan->'events') loop messages:=array_prepend(public.pilot_weather_message(ev,plan->'state',p_at),messages); end loop;
  return jsonb_build_object('eligible',c.enabled,'disabled_reason',c.disabled_reason,'current_state',s->>'status','next_state',plan->'state','counts',jsonb_build_object('total',jsonb_array_length(p_rows),'hyopu',(select count(*) from jsonb_array_elements(p_rows) a where a->>'agent'='협운'),'bad_weather',plan#>'{state,bad_weather_count}'),'events',(select coalesce(jsonb_agg(jsonb_build_object('type',a->>'type','method',a->>'method')),'[]') from jsonb_array_elements(plan->'events') a),'resumes',(select coalesce(jsonb_agg(x),'[]') from (select a->>'vessel_name' as vessel,a->>'external_key' as schedule_key from jsonb_array_elements(plan->'resumes') a limit 10) x),'changes_count',jsonb_array_length(plan->'changes'),'expected_telegram_messages',messages[1:2],'changes',(select coalesce(jsonb_agg(x),'[]') from (select a->>'type' as type,a#>>'{new,vessel_name}' as vessel from jsonb_array_elements(plan->'changes') a limit 20) x),'truncated',jsonb_array_length(plan->'changes')>20 or cardinality(messages)>2 or jsonb_array_length(plan->'resumes')>10);
end $$;

create function public.pilot_commit(p_token uuid,p_version bigint,p_hash text,p_rows jsonb,p_ingress bigint,p_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control; old_rows jsonb; rows_now jsonb; st jsonb; plan jsonb; s jsonb; ev jsonb; ch jsonb; r jsonb;
  sid bigint; eid uuid; continuous boolean; current_count int; old_count int; d text; dropped boolean:=false;
  counts jsonb:='{}'; message text:=''; part int:=0; duration bigint; resume_key text;
begin
  select * into c from public.pilot_watcher_control where id for update;
  if not c.enabled or c.lease_token is distinct from p_token or c.lease_until<=p_at or c.version<>p_version then raise exception 'STALE_EXECUTION'; end if;
  if p_hash !~ '^[a-f0-9]{64}$' or p_ingress<0 or p_ingress>4000000 then raise exception 'INVALID_SOURCE'; end if;
  select rows into old_rows from public.pilot_snapshots where id=c.snapshot_id;
  old_rows:=coalesce(old_rows,'[]');
  if p_rows is null then
    if c.last_hash is distinct from p_hash then raise exception 'HASH_REQUIRES_ROWS'; end if;
    rows_now:=old_rows;
  else
    if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>8000 or octet_length(p_rows::text)>800000 then raise exception 'ROW_LIMIT'; end if;
    rows_now:=p_rows;
  end if;
  continuous:=c.continuous and c.lease_slot=c.last_slot+interval '1 minute' and p_at-c.last_success<=interval '90 seconds';
  for d in select distinct a->>'pilot_date' from jsonb_array_elements(rows_now) a loop
    select count(*) into current_count from jsonb_array_elements(rows_now) a where a->>'pilot_date'=d and not (a->>'cancelled')::boolean;
    select count(*) into old_count from jsonb_array_elements(old_rows) a where a->>'pilot_date'=d and not (a->>'cancelled')::boolean;
    counts:=counts||jsonb_build_object(d,current_count);
    if old_count-current_count>=5 and current_count*2<=old_count then dropped:=true; end if;
  end loop;
  if dropped then
    update public.pilot_watcher_control set drop_hash=p_hash,drop_counts=counts where id;
    perform public.pilot_fail(p_token,'ABNORMAL_ROW_DROP',p_at);
    return jsonb_build_object('accepted',false,'reason','ABNORMAL_ROW_DROP');
  end if;
  select to_jsonb(w) into st from public.pilot_weather_state w where id;
  plan:=public.pilot_plan(old_rows,rows_now,st,continuous,p_at); s:=plan->'state';
  sid:=c.snapshot_id;
  if p_hash is distinct from c.last_hash then
    insert into public.pilot_snapshots(content_hash,rows,observed_at) values(p_hash,plan->'rows',p_at) returning id into sid;
  end if;
  eid:=(st->>'event_id')::uuid;
  for ev in select value from jsonb_array_elements(plan->'events') loop
    if ev->>'type'='SUSPEND' then
      eid:=gen_random_uuid();
      insert into public.pilot_weather_events(id,started_at,max_bad_weather_count) values(eid,p_at,(s->>'bad_weather_count')::int);
      perform public.pilot_queue('weather_suspend:'||eid,'WEATHER_SUSPEND',eid::text,public.pilot_weather_message(ev,s,p_at));
    elsif ev->>'type'='RESUME' and eid is not null then
      duration:=greatest(0,extract(epoch from p_at-(st->>'started_at')::timestamptz)::bigint);
      resume_key:=ev#>>'{vessel,external_key}';
      update public.pilot_weather_events set ended_at=p_at,resume_detected_at=p_at,resume_vessel_name=ev#>>'{vessel,vessel_name}',resume_schedule_key=resume_key,resume_method=ev->>'method',duration_seconds=duration where id=eid;
      perform public.pilot_queue('weather_resume:'||eid,'WEATHER_RESUME',eid::text,public.pilot_weather_message(ev,s,p_at));
    end if;
  end loop;
  if s->>'status'='NORMAL' then eid:=null; end if;
  if eid is not null then update public.pilot_weather_events set max_bad_weather_count=greatest(max_bad_weather_count,(s->>'bad_weather_count')::int) where id=eid; end if;
  update public.pilot_weather_state set status=s->>'status',bad_weather_count=(s->>'bad_weather_count')::int,candidate_count=(s->>'candidate_count')::int,rearm_count=(s->>'rearm_count')::int,started_at=(s->>'started_at')::timestamptz,resumed_at=(s->>'resumed_at')::timestamptz,recovery_started_at=(s->>'recovery_started_at')::timestamptz,event_id=eid,last_seen_at=p_at,updated_at=p_at,resume_alert_sent=case when s->>'status'='SUSPENDED' then false else resume_alert_sent end where id;
  -- No per-minute rewriting of every current row. last_seen_at is resolved by
  -- the observation/snapshot relation when the content is unchanged.
  if p_hash is distinct from c.last_hash then
    for r in select value from jsonb_array_elements(plan->'rows') where (value->>'unambiguous')::boolean loop
      insert into public.pilot_current(external_key,vessel_name,pilot_date,pilot_time,from_location,to_location,remarks,status,raw_status,agent,raw_data,first_seen_at,last_seen_at,updated_at)
      values(r->>'external_key',r->>'vessel_name',(r->>'pilot_date')::date,r->>'pilot_time',r->>'from_location',r->>'to_location',r->>'remarks',r->>'status',r->>'raw_status',r->>'agent',r,p_at,p_at,p_at)
      on conflict(external_key) do update set pilot_time=excluded.pilot_time,from_location=excluded.from_location,to_location=excluded.to_location,remarks=excluded.remarks,status=excluded.status,raw_status=excluded.raw_status,agent=excluded.agent,raw_data=excluded.raw_data,last_seen_at=p_at,updated_at=p_at
        where pilot_current.raw_data is distinct from excluded.raw_data;
    end loop;
  end if;
  for ch in select value from jsonb_array_elements(plan->'changes') loop
    insert into public.pilot_history(external_key,vessel_name,event_type,old_data,new_data,detected_at) values(ch->>'key',ch#>>'{new,vessel_name}',ch->>'type',ch->'old',ch->'new',p_at);
  end loop;
  foreach message in array public.pilot_schedule_messages(plan->'changes',s) loop
    perform public.pilot_queue('schedule_change:'||p_token||':'||part,'SCHEDULE_CHANGE',p_token::text,message); part:=part+1;
  end loop;
  if c.failure_count>=5 then perform public.pilot_queue('source_recovery:'||c.outage_id,'SOURCE_RECOVERY',c.outage_id::text,'✅ [울산도선사회 감시 복구]'||chr(10)||'정상 수집이 복구되었습니다. 중단 구간의 상태 전환은 추정하지 않습니다.'); end if;
  update public.pilot_watcher_control set last_hash=p_hash,snapshot_id=sid,version=version+1,last_success=p_at,last_slot=lease_slot,continuous=true,failure_count=0,outage_id=null,lease_token=null,lease_until=null,drop_hash=null,drop_counts=null where id;
  update public.pilot_runs set finished_at=p_at,success=true,snapshot_id=sid,ingress_bytes=p_ingress where id=p_token;
  return jsonb_build_object('accepted',true,'state',s->>'status','changes',jsonb_array_length(plan->'changes'));
end $$;

create function public.pilot_claim_notification(p_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare n public.pilot_notifications; c public.pilot_watcher_control;
begin
  select * into c from public.pilot_watcher_control where id for update;
  update public.pilot_notification_attempts a set status='UNKNOWN',error='SENDER_INTERRUPTED',finished_at=p_at from public.pilot_notifications pn where pn.id=a.notification_id and a.attempt=pn.attempts and pn.status='SENDING' and pn.claimed_at<p_at-interval '2 minutes';
  update public.pilot_notifications set status='UNKNOWN',error='SENDER_INTERRUPTED' where status='SENDING' and claimed_at<p_at-interval '2 minutes';
  select * into n from public.pilot_notifications where status='PENDING' and next_attempt_at<=p_at and (c.enabled or notification_type='COST_STOP') order by case notification_type when 'COST_STOP' then 0 when 'WEATHER_SUSPEND' then 1 when 'WEATHER_RESUME' then 2 else 3 end,created_at,id limit 1 for update skip locked;
  if n.id is null then return null; end if;
  if n.notification_type<>'COST_STOP' and not public.pilot_reserve(2*octet_length(n.message)+6144,p_at) then
    -- The last sender must deliver the emergency alert now: disabled cron will
    -- not call this function again next minute.
    select * into n from public.pilot_notifications where status='PENDING' and notification_type='COST_STOP' order by created_at,id limit 1 for update skip locked;
    if n.id is null then return null; end if;
  end if;
  update public.pilot_notifications set status='SENDING',claimed_at=p_at,attempts=attempts+1 where id=n.id;
  insert into public.pilot_notification_attempts(notification_id,attempt,started_at,status) values(n.id,n.attempts+1,p_at,'SENDING');
  return jsonb_build_object('id',n.id,'message',n.message);
end $$;

create function public.pilot_finish_notification(p_id uuid,p_status text,p_message_id bigint default null,p_error text default null,p_retry_seconds int default null,p_at timestamptz default now())
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare n public.pilot_notifications;
begin
  select * into n from public.pilot_notifications where id=p_id for update;
  if n.status<>'SENDING' then return; end if;
  if p_status not in ('SENT','UNKNOWN','FAILED','RATE_LIMITED') then raise exception 'INVALID_NOTIFICATION_STATUS'; end if;
  update public.pilot_notification_attempts set status=p_status,error=left(p_error,80),finished_at=p_at where notification_id=p_id and attempt=n.attempts;
  update public.pilot_notifications set status=case when p_status='RATE_LIMITED' and attempts<3 and notification_type<>'COST_STOP' then 'PENDING' when p_status='RATE_LIMITED' then 'FAILED' else p_status end,telegram_message_id=p_message_id,error=left(p_error,80),sent_at=case when p_status='SENT' then p_at else null end,next_attempt_at=p_at+make_interval(secs=>greatest(60,least(coalesce(p_retry_seconds,60),86400))) where id=p_id;
  if p_status='SENT' and n.notification_type in('WEATHER_SUSPEND','WEATHER_RESUME') then
    update public.pilot_weather_events set suspension_notification_sent_at=case when n.notification_type='WEATHER_SUSPEND' then p_at else suspension_notification_sent_at end,resume_notification_sent_at=case when n.notification_type='WEATHER_RESUME' then p_at else resume_notification_sent_at end where id=n.reference_id::uuid;
    if n.notification_type='WEATHER_RESUME' then update public.pilot_weather_state set resume_alert_sent=true where event_id=n.reference_id::uuid; end if;
  end if;
end $$;

create function public.pilot_cleanup(p_at timestamptz default now()) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  delete from public.pilot_runs where started_at<p_at-interval '30 days';
  delete from public.pilot_snapshots where observed_at<p_at-interval '7 days' and id<>(select coalesce(snapshot_id,0) from public.pilot_watcher_control);
  delete from public.pilot_history where detected_at<p_at-interval '365 days';
  delete from public.pilot_notifications n where created_at<p_at-interval '365 days' and status in('SENT','FAILED','UNKNOWN') and not exists(select 1 from public.pilot_weather_events e where e.id::text=n.reference_id and e.ended_at is null);
  delete from public.pilot_weather_events where ended_at<p_at-interval '365 days';
  delete from public.pilot_current c where last_seen_at<p_at-interval '365 days' and not exists(
    select 1 from public.pilot_watcher_control w join public.pilot_snapshots s on s.id=w.snapshot_id,
    lateral jsonb_array_elements(s.rows) r where r->>'external_key'=c.external_key);
end $$;

-- Explicit human billing gate: no automatic cycle rollover or restart.
create function public.pilot_enable(p_evidence jsonb,p_cycle_start timestamptz,p_cycle_end timestamptz)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control;
begin
  select * into c from public.pilot_watcher_control where id for update;
  if p_evidence->>'plan' not in ('Free','Pro') or p_evidence->>'plan' is null
    or (p_evidence->>'plan'='Pro' and (p_evidence->>'spend_cap_enabled')::boolean is distinct from true)
    or coalesce((p_evidence->>'organization_remaining_bytes')::bigint,0)<c.cycle_limit
    or coalesce(p_evidence->>'project_ref','')='' or coalesce(p_evidence->>'verified_by','')=''
    or (p_evidence->>'telegram_verified')::boolean is distinct from true
    or p_cycle_start>now() or p_cycle_end<=now() or p_cycle_end-p_cycle_start>interval '32 days'
    or p_cycle_start is null or p_cycle_end is null then raise exception 'BILLING_OR_DELIVERY_NOT_VERIFIED'; end if;
  -- Old pending messages do not suddenly flood a manually resumed watcher.
  update public.pilot_notifications set status='FAILED',error='MANUAL_REBASE' where status='PENDING';
  update public.pilot_watcher_control set enabled=true,disabled_reason=null,billing_verified_at=now(),billing_evidence=p_evidence,cycle_start=p_cycle_start,cycle_end=p_cycle_end,continuous=false,lease_token=null,lease_until=null where id;
  update public.pilot_weather_state set candidate_count=0,rearm_count=0,recovery_started_at=null where id;
end $$;

create function public.pilot_disable() returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  update public.pilot_watcher_control set enabled=false,disabled_reason='MANUAL',continuous=false,lease_token=null,lease_until=null where id;
  update public.pilot_weather_state set candidate_count=0,rearm_count=0,recovery_started_at=null where id;
end $$;

do $$ declare t text; f record; begin
  foreach t in array array['pilot_watcher_control','pilot_weather_state','pilot_snapshots','pilot_current','pilot_history','pilot_weather_events','pilot_notifications','pilot_notification_attempts','pilot_runs','pilot_usage'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('alter table public.%I force row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  for f in select p.oid::regprocedure as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pilot\_%' escape '\' loop
    execute format('revoke all on function %s from public, anon, authenticated',f.name);
    execute format('grant execute on function %s to service_role',f.name);
  end loop;
end $$;
commit;
