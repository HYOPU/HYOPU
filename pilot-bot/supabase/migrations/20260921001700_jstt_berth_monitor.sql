-- Independent JSTT read-only monitor. Disabled until cloud/billing validation.
begin;
create table public.jstt_monitor_control (
 id boolean primary key default true check(id), enabled boolean not null default false,
 disabled_reason text default 'VALIDATION_REQUIRED', billing_verified_at timestamptz,
 last_success timestamptz, last_hash text, version bigint not null default 0,
 failure_count int not null default 0, outage_id uuid, last_error text, candidate_hash text,
 lease_token uuid, lease_until timestamptz, last_manual_at timestamptz, dispatch_slot timestamptz
);
insert into public.jstt_monitor_control(id) values(true);
create table public.jstt_vessel_watchlist (
 id uuid primary key default gen_random_uuid(), chat_id text not null references public.pilot_telegram_chats,
 agency_name text, vessel_name text not null, normalized_vessel_name text not null,
 enabled boolean not null default true, notes text, created_by_telegram_id bigint not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(length(vessel_name) between 1 and 120),check(agency_name is null or length(agency_name) between 1 and 120)
);
create unique index jstt_watch_unique on public.jstt_vessel_watchlist(chat_id,coalesce(agency_name,''),normalized_vessel_name);
create table public.jstt_schedule_state (
 schedule_key text primary key, vessel_name text not null, normalized_vessel_name text not null,agency_name text not null,
 schedule_datetime text not null,port_in_datetime text,departure_datetime text,source_status text not null,
 raw_berth text not null,normalized_berth text not null,
 lifecycle text not null default 'ACTIVE' check(lifecycle in('ACTIVE','MISSING','ARCHIVED')),
 missing_count int not null default 0,revision bigint not null default 1,
 first_seen_at timestamptz not null default now(),last_seen_at timestamptz not null,updated_at timestamptz not null
);
-- Per-room durable observation cursor. Never infer delivery from source state.
create table public.jstt_schedule_delivery (
 chat_id text not null references public.pilot_telegram_chats, schedule_key text not null references public.jstt_schedule_state,
 last_berth text not null,ever_assigned boolean not null default false,event_revision bigint not null default 0,
 primary key(chat_id,schedule_key)
);
create table public.jstt_berth_events (
 id uuid primary key default gen_random_uuid(),chat_id text not null,schedule_key text not null,
 revision bigint not null,vessel_name text not null,agency_name text not null,schedule_datetime text not null,
 event_type text not null check(event_type in('INITIAL_ASSIGNED','BERTH_CHANGED','BERTH_UNASSIGNED','REASSIGNED')),
 old_berth text,new_berth text not null,detected_at timestamptz not null,notification_key text not null unique,
 notification_id uuid references public.pilot_notifications(id) on delete set null,
 unique(chat_id,schedule_key,revision)
);
create table public.jstt_monitor_runs (
 id uuid primary key,slot timestamptz not null,probe boolean not null default false,claimed boolean not null default false,
 started_at timestamptz not null,finished_at timestamptz,success boolean,error text,
 row_count int,html_ingress_bytes bigint,estimated_bytes bigint,duration_ms int
);
create unique index jstt_run_minute on public.jstt_monitor_runs(slot) where not probe;
create table public.jstt_budget_reservations (
 id uuid primary key,cycle_scope text not null,day_scope text not null,reserved_bytes bigint not null,
 settled_bytes bigint,created_at timestamptz not null default now(),settled_at timestamptz
);
create table public.jstt_ui_requests (
 id uuid primary key,chat_id text not null,user_id bigint not null,result jsonb,created_at timestamptz not null default now()
);

create function public.jstt_name(p_value text) returns text language sql immutable set search_path=pg_catalog as $$
 select upper(regexp_replace(btrim(coalesce(p_value,'')),'\s+',' ','g'))
$$;
create function public.jstt_is_target(p_chat text,p_agency text,p_vessel text) returns boolean
language sql stable set search_path=pg_catalog,public as $$
 select p_agency='협운해운(주)' or exists(select 1 from public.jstt_vessel_watchlist w where w.chat_id=p_chat and w.enabled
 and w.normalized_vessel_name=public.jstt_name(p_vessel) and (w.agency_name is null or w.agency_name=p_agency))
$$;
create function public.jstt_reserve(p_id uuid,p_bytes bigint,p_at timestamptz default now()) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control; cy text; dy text; used_c bigint;used_d bigint;
begin
 select * into c from public.pilot_watcher_control where id for update;
 perform 1 from public.jstt_monitor_control where id for update;
 if p_bytes<1024 or p_bytes>524288 or exists(select 1 from public.jstt_budget_reservations where id=p_id) then return false;end if;
 if not c.enabled or c.billing_verified_at is null or p_at<c.cycle_start or p_at>=c.cycle_end then return false;end if;
 cy:='cycle:'||to_char(c.cycle_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');dy:='day:'||(p_at at time zone 'Asia/Seoul')::date::text;
 select coalesce(max(estimated_bytes),0) into used_c from public.pilot_usage where scope=cy;
 select coalesce(max(estimated_bytes),0) into used_d from public.pilot_usage where scope=dy;
 if used_c+p_bytes>least(402653184,c.warning_limit,c.cycle_limit-8192) or used_d+p_bytes>least(20971520,c.day_limit-8192) then
  update public.jstt_monitor_control set enabled=false,disabled_reason='JSTT_BUDGET' where id;
  return false; -- NEVER call the global stop path when JSTT has no headroom.
 end if;
 if not public.pilot_reserve(p_bytes,p_at) then return false;end if;
 insert into public.jstt_budget_reservations values(p_id,cy,dy,p_bytes,null,p_at,null);return true;
end $$;
create function public.jstt_settle(p_id uuid,p_bytes bigint) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.jstt_budget_reservations;n bigint;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 select * into r from public.jstt_budget_reservations where id=p_id for update;
 if not found or r.settled_at is not null then return;end if;
 n:=greatest(2048,coalesce(p_bytes,r.reserved_bytes));
 update public.pilot_usage set estimated_bytes=greatest(0,estimated_bytes-r.reserved_bytes+n),updated_at=now() where scope in(r.cycle_scope,r.day_scope);
 update public.jstt_budget_reservations set settled_bytes=n,settled_at=now() where id=p_id;
 if n>r.reserved_bytes then update public.jstt_monitor_control set enabled=false,disabled_reason='JSTT_BUDGET_OVERRUN' where id;end if;
end $$;

create function public.jstt_fail(p_id uuid,p_error text,p_at timestamptz default now()) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.jstt_monitor_control;incident uuid;chat text;
begin
 select * into c from public.jstt_monitor_control where id for update;
 if c.lease_token is distinct from p_id then return;end if;
 update public.jstt_monitor_runs set success=false,error=left(p_error,60),finished_at=p_at where id=p_id;
 if exists(select 1 from public.jstt_monitor_runs where id=p_id and probe) then
  update public.jstt_monitor_control set lease_token=null,lease_until=null where id;return;
 end if;
 incident:=coalesce(c.outage_id,gen_random_uuid());
 update public.jstt_monitor_control set failure_count=failure_count+1,outage_id=incident,last_error=left(p_error,60),candidate_hash=null,lease_token=null,lease_until=null where id;
 if c.failure_count=4 then
  for chat in select chat_id from public.pilot_telegram_chats where enabled loop
   insert into public.pilot_notifications(notification_key,notification_type,reference_id,message,telegram_chat_id)
   values('jstt_error:'||incident||':'||chat,'JSTT_ERROR',incident::text,'⚠️ [JSTT 감시 오류]'||chr(10)||'5회 연속 수집 실패 · 기존 부두 유지'||chr(10)||'마지막 정상확인: '||coalesce(public.pilot_kst_label(c.last_success),'없음')||chr(10)||'오류: '||left(p_error,60),chat) on conflict do nothing;
  end loop;
 end if;
end $$;
create function public.jstt_begin(p_id uuid,p_manual boolean default false,p_probe boolean default false,p_at timestamptz default now()) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.jstt_monitor_control; v_slot timestamptz:=date_trunc('minute',p_at);
begin
 perform 1 from public.pilot_watcher_control where id for update;
 select * into c from public.jstt_monitor_control where id for update;
 if (not c.enabled and not p_probe) or (p_probe and c.disabled_reason in('JSTT_BUDGET','JSTT_BUDGET_OVERRUN')) then return jsonb_build_object('skip','DISABLED');end if;
 if not p_probe and c.billing_verified_at is null then return jsonb_build_object('skip','BILLING_REQUIRED');end if;
 if c.lease_until>p_at then return jsonb_build_object('skip','JOINED');end if;
 if p_manual and c.last_manual_at>p_at-interval '30 seconds' then return jsonb_build_object('skip','COOLDOWN');end if;
 if exists(select 1 from public.jstt_monitor_runs where id=p_id or (not probe and not p_probe and jstt_monitor_runs.slot=v_slot)) then return jsonb_build_object('skip','RECENT');end if;
 if c.lease_token is not null then perform public.jstt_fail(c.lease_token,'JSTT_EXECUTION_EXPIRED',p_at);end if;
 if not public.jstt_reserve(p_id,131072,p_at) then return jsonb_build_object('skip','BUDGET');end if;
 insert into public.jstt_monitor_runs(id,slot,probe,started_at) values(p_id,v_slot,p_probe,p_at);
 update public.jstt_monitor_control set lease_token=p_id,lease_until=p_at+interval '55 seconds',last_manual_at=case when p_manual then p_at else last_manual_at end where id;
 return jsonb_build_object('id',p_id,'hash',c.last_hash,'version',c.version,'reserved_bytes',131072);
end $$;
create function public.jstt_claim(p_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.jstt_monitor_control;r public.jstt_monitor_runs;
begin
 select * into c from public.jstt_monitor_control where id for update;
 update public.jstt_monitor_runs set claimed=true where id=p_id and not claimed and finished_at is null
 and c.lease_token=p_id and c.lease_until>now() returning * into r;
 if r.id is null then return null;end if;
 return jsonb_build_object('id',r.id,'probe',r.probe,'hash',c.last_hash,'version',c.version,'reserved_bytes',131072);
end $$;

create function public.jstt_plan_events(p_rows jsonb,p_chat text) returns jsonb language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('schedule_key',r->>'schedule_key','vessel_name',r->>'vessel_name','agency_name',r->>'agency_name',
 'schedule_datetime',r->>'schedule_datetime','old_berth',d.last_berth,'new_berth',r->>'normalized_berth','revision',coalesce(d.event_revision,0)+1,
 'event_type',case when r->>'normalized_berth'='UNASSIGNED' then 'BERTH_UNASSIGNED' when d.last_berth is null or not d.ever_assigned then 'INITIAL_ASSIGNED'
 when d.last_berth='UNASSIGNED' then 'REASSIGNED' else 'BERTH_CHANGED' end) order by r->>'schedule_datetime',r->>'schedule_key'),'[]')
 from jsonb_array_elements(p_rows) r left join public.jstt_schedule_delivery d on d.chat_id=p_chat and d.schedule_key=r->>'schedule_key'
 where r->>'source_status'<>'이안' and public.jstt_is_target(p_chat,r->>'agency_name',r->>'vessel_name')
 and d.last_berth is distinct from r->>'normalized_berth' and (d.last_berth is not null or r->>'normalized_berth'<>'UNASSIGNED')
$$;
create function public.jstt_queue_events(p_events jsonb,p_chat text,p_at timestamptz) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare e jsonb;kind text;msg text:='';nid uuid;eid uuid;ids uuid[]:='{}';batch int:=0;typ text;
begin
 -- Group only the same setting category, so each room toggle stays effective.
 foreach kind in array array['JSTT_ASSIGNED','JSTT_CHANGED','JSTT_UNASSIGNED'] loop
  msg:='';ids:='{}';batch:=0;
  for e in select value from jsonb_array_elements(p_events) loop
   typ:=case e->>'event_type' when 'BERTH_CHANGED' then 'JSTT_CHANGED' when 'BERTH_UNASSIGNED' then 'JSTT_UNASSIGNED' else 'JSTT_ASSIGNED' end;
   if typ<>kind then continue;end if;
   insert into public.jstt_berth_events(chat_id,schedule_key,revision,vessel_name,agency_name,schedule_datetime,event_type,old_berth,new_berth,detected_at,notification_key)
   values(p_chat,e->>'schedule_key',(e->>'revision')::bigint,e->>'vessel_name',e->>'agency_name',e->>'schedule_datetime',e->>'event_type',e->>'old_berth',e->>'new_berth',p_at,
    'jstt:'||p_chat||':'||(e->>'schedule_key')||':'||(e->>'revision')) on conflict do nothing returning id into eid;
   if eid is null then continue;end if;
   ids:=array_append(ids,eid);
   msg:=msg||chr(10)||chr(10)||(e->>'vessel_name')||' / '||(e->>'agency_name')||case when e->>'agency_name'<>'협운해운(주)' then ' · 지정선박' else '' end||chr(10)
    ||public.pilot_date_label(left(e->>'schedule_datetime',10),right(e->>'schedule_datetime',5))||chr(10)
    ||coalesce(nullif(e->>'old_berth','UNASSIGNED'),'미정')||' → '||case when e->>'new_berth'='UNASSIGNED' then '미정' else e->>'new_berth' end;
   if array_length(ids,1)>=8 then
    nid:=gen_random_uuid();insert into public.pilot_notifications(id,notification_key,notification_type,reference_id,message,telegram_chat_id)
    values(nid,'jstt_batch:'||ids[1],kind,ids[1]::text,case kind when 'JSTT_CHANGED' then '🟠 [JSTT 부두 변경]' when 'JSTT_UNASSIGNED' then '🔴 [JSTT 부두 배정 해제]' else '⚓ [JSTT 부두 배정]' end||msg||chr(10)||chr(10)||'감지: '||public.pilot_kst_label(p_at),p_chat);
    update public.jstt_berth_events set notification_id=nid where id=any(ids);msg:='';ids:='{}';
   end if;
  end loop;
  if cardinality(ids)>0 then
   nid:=gen_random_uuid();insert into public.pilot_notifications(id,notification_key,notification_type,reference_id,message,telegram_chat_id)
   values(nid,'jstt_batch:'||ids[1],kind,ids[1]::text,case kind when 'JSTT_CHANGED' then '🟠 [JSTT 부두 변경]' when 'JSTT_UNASSIGNED' then '🔴 [JSTT 부두 배정 해제]' else '⚓ [JSTT 부두 배정]' end||msg||chr(10)||chr(10)||'감지: '||public.pilot_kst_label(p_at),p_chat);
   update public.jstt_berth_events set notification_id=nid where id=any(ids);
  end if;
 end loop;
end $$;
create function public.jstt_apply(p_id uuid,p_version bigint,p_hash text,p_rows jsonb default null,p_ingress bigint default 0,p_duration int default 0,p_at timestamptz default now()) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.jstt_monitor_control;r public.jstt_monitor_runs;x jsonb;allrows jsonb;events jsonb;chat text;today text:=(p_at at time zone 'Asia/Seoul')::date::text;finish text:=((p_at at time zone 'Asia/Seoul')::date+7)::text;amount int:=0;previous_count int;
begin
 select * into c from public.jstt_monitor_control where id for update;
 select * into r from public.jstt_monitor_runs where id=p_id;
 if not r.claimed or r.finished_at is not null or c.lease_token is distinct from p_id or c.lease_until<p_at or c.version<>p_version then return jsonb_build_object('accepted',false);end if;
 if not c.enabled and not r.probe then return jsonb_build_object('accepted',false);end if;
 if p_hash!~'^[a-f0-9]{64}$' or (p_rows is null and p_hash is distinct from c.last_hash) then raise exception 'JSTT_HASH_INVALID';end if;
 if p_rows is not null then
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>2000 or octet_length(p_rows::text)>524288 then raise exception 'JSTT_ROWS_INVALID';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) a where coalesce(a->>'schedule_key','')!~'^\d{8,24}$' or coalesce(a->>'normalized_berth','') not in('UNASSIGNED','2부두','3부두','N3','N4','N5')
   or coalesce(a->>'raw_berth','')<>case when a->>'normalized_berth'='UNASSIGNED' then '대기' else a->>'normalized_berth' end
   or coalesce(a->>'source_status','') not in('계획','확정','접안','이안') or coalesce(a->>'schedule_datetime','')!~'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$'
   or left(a->>'schedule_datetime',10) not between today and finish or coalesce(a->>'vessel_name','')='' or coalesce(a->>'agency_name','')='')
   or (select count(*)<>count(distinct a->>'schedule_key') from jsonb_array_elements(p_rows) a) then raise exception 'JSTT_ROWS_INVALID';end if;
 end if;
 if r.probe then
  update public.jstt_monitor_runs set success=true,finished_at=p_at,row_count=jsonb_array_length(p_rows),html_ingress_bytes=p_ingress,duration_ms=p_duration where id=p_id;
  update public.jstt_monitor_control set lease_token=null,lease_until=null where id;
  select primary_chat_id into chat from public.hpbot_control where id;
  return jsonb_build_object('accepted',true,'probe',true,'rows',jsonb_array_length(p_rows),'events',public.jstt_plan_events(p_rows,chat));
 end if;
 if p_rows is not null and c.candidate_hash is distinct from p_hash then
  select count(*) into previous_count from public.jstt_schedule_state where missing_count=0 and left(schedule_datetime,10) between today and finish;
  if (previous_count>0 and jsonb_array_length(p_rows)=0) or (previous_count>=10 and jsonb_array_length(p_rows)<previous_count/4) then
   perform public.jstt_fail(p_id,'JSTT_COUNT_DROP',p_at);
   update public.jstt_monitor_control set candidate_hash=p_hash where id;
   return jsonb_build_object('accepted',false,'error','JSTT_COUNT_DROP');
  end if;
 end if;
 if p_rows is not null then
  for x in select value from jsonb_array_elements(p_rows) loop
   insert into public.jstt_schedule_state(schedule_key,vessel_name,normalized_vessel_name,agency_name,schedule_datetime,port_in_datetime,departure_datetime,source_status,raw_berth,normalized_berth,lifecycle,last_seen_at,updated_at)
   values(x->>'schedule_key',x->>'vessel_name',public.jstt_name(x->>'vessel_name'),x->>'agency_name',x->>'schedule_datetime',x->>'port_in_datetime',x->>'departure_datetime',x->>'source_status',x->>'raw_berth',x->>'normalized_berth',case when x->>'source_status'='이안' then 'ARCHIVED' else 'ACTIVE' end,p_at,p_at)
   on conflict(schedule_key) do update set vessel_name=excluded.vessel_name,normalized_vessel_name=excluded.normalized_vessel_name,agency_name=excluded.agency_name,schedule_datetime=excluded.schedule_datetime,
    port_in_datetime=excluded.port_in_datetime,departure_datetime=excluded.departure_datetime,source_status=excluded.source_status,raw_berth=excluded.raw_berth,normalized_berth=excluded.normalized_berth,
    revision=jstt_schedule_state.revision+case when jstt_schedule_state.normalized_berth<>excluded.normalized_berth then 1 else 0 end,
    missing_count=0,lifecycle=excluded.lifecycle,last_seen_at=p_at,updated_at=p_at;
  end loop;
  update public.jstt_schedule_state s set missing_count=missing_count+1,lifecycle=case when missing_count>=1 then 'MISSING' else lifecycle end
   where lifecycle<>'ARCHIVED' and not exists(select 1 from jsonb_array_elements(p_rows) a where a->>'schedule_key'=s.schedule_key);
 else
  -- An identical snapshot advances absence confirmation without rewriting rows.
  update public.jstt_schedule_state set missing_count=missing_count+1,lifecycle='MISSING' where missing_count>0 and lifecycle<>'ARCHIVED';
 end if;
 update public.jstt_schedule_state set lifecycle='ARCHIVED' where left(schedule_datetime,10) not between today and finish;
 select coalesce(jsonb_agg(to_jsonb(s) order by schedule_key),'[]') into allrows from public.jstt_schedule_state s where lifecycle='ACTIVE' and missing_count=0;
 for chat in select chat_id from public.pilot_telegram_chats where enabled loop
  events:=public.jstt_plan_events(allrows,chat);amount:=amount+jsonb_array_length(events);perform public.jstt_queue_events(events,chat,p_at);
  for x in select value from jsonb_array_elements(allrows) a where public.jstt_is_target(chat,a->>'agency_name',a->>'vessel_name') loop
   insert into public.jstt_schedule_delivery(chat_id,schedule_key,last_berth,ever_assigned,event_revision)
   values(chat,x->>'schedule_key',x->>'normalized_berth',x->>'normalized_berth'<>'UNASSIGNED',case when x->>'normalized_berth'<>'UNASSIGNED' then 1 else 0 end)
   on conflict(chat_id,schedule_key) do update set last_berth=excluded.last_berth,ever_assigned=jstt_schedule_delivery.ever_assigned or excluded.ever_assigned,
    event_revision=jstt_schedule_delivery.event_revision+case when jstt_schedule_delivery.last_berth<>excluded.last_berth then 1 else 0 end;
  end loop;
  if c.failure_count>=5 then insert into public.pilot_notifications(notification_key,notification_type,reference_id,message,telegram_chat_id)
   values('jstt_recovery:'||c.outage_id||':'||chat,'JSTT_RECOVERY',c.outage_id::text,'✅ [JSTT 감시 복구]'||chr(10)||'정상확인: '||public.pilot_kst_label(p_at),chat) on conflict do nothing;end if;
 end loop;
 update public.jstt_monitor_runs set success=true,finished_at=p_at,row_count=jsonb_array_length(allrows),html_ingress_bytes=p_ingress,duration_ms=p_duration where id=p_id;
 update public.jstt_monitor_control set last_success=p_at,last_hash=p_hash,version=version+1,failure_count=0,outage_id=null,last_error=null,candidate_hash=null,lease_token=null,lease_until=null where id;
 return jsonb_build_object('accepted',true,'rows',jsonb_array_length(allrows),'events',amount);
end $$;

create function public.jstt_read(p_chat text,p_view text default 'current',p_page int default 0,p_search text default '',p_reference text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;data jsonb;total int;today text:=(now() at time zone 'Asia/Seoul')::date::text;finish text:=((now() at time zone 'Asia/Seoul')::date+7)::text;
begin
 if p_page<0 or p_page>999 or length(p_search)>120 or not exists(select 1 from public.pilot_telegram_chats where chat_id=p_chat and enabled) then raise exception 'JSTT_QUERY_INVALID';end if;
 select jsonb_build_object('enabled',enabled,'disabled_reason',disabled_reason,'last_success',last_success,'failure_count',failure_count,'last_error',last_error,'running',lease_until>now()) into result from public.jstt_monitor_control where id;
 if p_view='health' then return result;end if;
 if p_reference is not null then
  if p_reference!~'^\d{1,24}$' then raise exception 'JSTT_REFERENCE_INVALID';end if;
  select vessel_name into p_search from public.hpbot_pilot_current where application_id=p_reference limit 1;
  if p_search is null then raise exception 'JSTT_REFERENCE_EXPIRED';end if;
  p_view:='search';
 end if;
 if p_view='watchlist' then
  select count(*) into total from public.jstt_vessel_watchlist where chat_id=p_chat and enabled;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into data from(select w.id,w.vessel_name,w.agency_name,
   exists(select 1 from public.jstt_schedule_state s where s.normalized_vessel_name=w.normalized_vessel_name and (w.agency_name is null or s.agency_name=w.agency_name) and s.lifecycle='ACTIVE' and left(s.schedule_datetime,10) between today and finish) as matched
   from public.jstt_vessel_watchlist w where w.chat_id=p_chat and w.enabled order by w.vessel_name,w.id offset p_page*10 limit 10)x;
 elsif p_view='changes' then
  select count(*) into total from public.jstt_berth_events where chat_id=p_chat;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into data from(select e.vessel_name,e.agency_name,e.schedule_datetime,e.event_type,e.old_berth,e.new_berth,e.detected_at,n.status notification_status
   from public.jstt_berth_events e left join public.pilot_notifications n on n.id=e.notification_id where e.chat_id=p_chat order by e.detected_at desc,e.id desc limit 10)x;
 else
  select count(*) into total from public.jstt_schedule_state s where s.lifecycle<>'ARCHIVED' and left(s.schedule_datetime,10) between today and finish
   and (p_view='search' or public.jstt_is_target(p_chat,s.agency_name,s.vessel_name)) and position(public.jstt_name(p_search) in s.normalized_vessel_name)>0;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into data from(select s.schedule_key,s.vessel_name,s.agency_name,s.schedule_datetime,s.raw_berth,s.normalized_berth,s.lifecycle,s.missing_count
   from public.jstt_schedule_state s where s.lifecycle<>'ARCHIVED' and left(s.schedule_datetime,10) between today and finish
   and (p_view='search' or public.jstt_is_target(p_chat,s.agency_name,s.vessel_name)) and position(public.jstt_name(p_search) in s.normalized_vessel_name)>0
   order by s.agency_name<>'협운해운(주)',s.schedule_datetime,s.schedule_key offset p_page*10 limit 10)x;
 end if;
 return result||jsonb_build_object('rows',data,'total',total,'page',p_page,'view',p_view,'search',p_search);
end $$;
create function public.jstt_ui_begin(p_id uuid,p_chat text,p_user bigint) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform 1 from public.pilot_watcher_control where id for update;
 if p_user<=0 or not exists(select 1 from public.pilot_telegram_chats where chat_id=p_chat and enabled)
 or exists(select 1 from public.jstt_ui_requests where id=p_id)
 or (select count(*) from public.jstt_ui_requests where user_id=p_user and created_at>now()-interval '1 minute')>=20 then return false;end if;
 if not public.jstt_reserve(p_id,65536) then return false;end if;
 insert into public.jstt_ui_requests(id,chat_id,user_id) values(p_id,p_chat,p_user);return true;
end $$;
create function public.jstt_watch_change(p_request uuid,p_action text,p_vessel text default null,p_agency text default null,p_id uuid default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.jstt_ui_requests;wid uuid;v_result jsonb;
begin
 select * into u from public.jstt_ui_requests where id=p_request for update;
 if not found then raise exception 'JSTT_UI_INVALID';end if;
 if u.result is not null then return u.result;end if;
 if p_action='add' then
  p_vessel:=public.jstt_name(p_vessel);p_agency:=nullif(btrim(p_agency),'');
  if length(p_vessel) not between 1 and 120 or length(coalesce(p_agency,''))>120 or p_vessel~'[[:cntrl:]]' or coalesce(p_agency,'')~'[[:cntrl:]]' then raise exception 'JSTT_WATCH_INVALID';end if;
  if (select count(*) from public.jstt_vessel_watchlist where chat_id=u.chat_id and enabled)>=100 then raise exception 'JSTT_WATCH_LIMIT';end if;
  insert into public.jstt_vessel_watchlist(chat_id,agency_name,vessel_name,normalized_vessel_name,created_by_telegram_id)
  values(u.chat_id,p_agency,p_vessel,p_vessel,u.user_id)
  on conflict(chat_id,(coalesce(agency_name,'')),normalized_vessel_name) do update set enabled=true,updated_at=now() where not jstt_vessel_watchlist.enabled returning id into wid;
 elsif p_action='remove' then
  update public.jstt_vessel_watchlist set enabled=false,updated_at=now() where id=p_id and chat_id=u.chat_id and enabled returning id into wid;
 else raise exception 'JSTT_WATCH_INVALID';end if;
 v_result:=jsonb_build_object('id',wid,'changed',wid is not null);update public.jstt_ui_requests set result=v_result where id=p_request;
 if wid is not null then insert into public.pilot_notifications(notification_key,notification_type,reference_id,message,telegram_chat_id)
 values('jstt_ui:'||p_request,'COMMAND_REPLY',p_request::text,'👀 [JSTT 특정선박 감시 '||case when p_action='add' then '추가' else '삭제' end||']'||chr(10)||
 (select vessel_name||' / '||coalesce(agency_name,'대리점 무관') from public.jstt_vessel_watchlist where id=wid),u.chat_id) on conflict do nothing;end if;
 return v_result;
end $$;

-- Existing settings behavior is delegated untouched for non-JSTT names.
alter function public.hpbot_toggle_setting(bigint,text) rename to hpbot_toggle_setting_before_jstt;
create function public.hpbot_toggle_setting(p_update bigint,p_setting text) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare chat text;v boolean;
begin
 if p_setting not in('JSTT_ASSIGNED','JSTT_CHANGED','JSTT_UNASSIGNED') then return public.hpbot_toggle_setting_before_jstt(p_update,p_setting);end if;
 select chat_id into chat from public.pilot_telegram_updates where update_id=p_update and status='RECEIVED';if chat is null then raise exception 'SETTING_INVALID';end if;
 select not coalesce((settings->>p_setting)::boolean,true) into v from public.pilot_telegram_chats where chat_id=chat for update;
 update public.pilot_telegram_chats set settings=settings||jsonb_build_object(p_setting,v),updated_at=now() where chat_id=chat;return v;
end $$;

-- net/vault absent in unit databases. No new Cron job or automatic enable.
do $$ begin if to_regprocedure('public.pilot_cron_tick()') is not null then
 execute $sql$create function public.jstt_dispatch(p_manual boolean default false) returns text language plpgsql security definer set search_path=pg_catalog,public as $fn$
 declare endpoint text;secret text;run uuid:=gen_random_uuid();r jsonb;
 begin
  if not (select enabled from public.jstt_monitor_control where id) then return 'DISABLED';end if;
  select decrypted_secret into endpoint from vault.decrypted_secrets where name='jstt_berth_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name='jstt_berth_key';
  if endpoint is null or endpoint!~'^https://[a-z0-9.-]+/api/jstt_berth_watch$' or secret is null or length(secret)<32 then return 'CONFIG_REQUIRED';end if;
  r:=public.jstt_begin(run,p_manual);if r->>'skip' is not null then return r->>'skip';end if;
  perform net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','x-jstt-key',secret),body:=jsonb_build_object('id',run),timeout_milliseconds:=55000);
  return 'RUN';
 end $fn$;$sql$;
 alter function public.pilot_cron_tick() rename to pilot_cron_tick_before_jstt;
 execute $sql$create function public.pilot_cron_tick() returns void language plpgsql security definer set search_path=pg_catalog,public as $fn$
 begin
  perform public.pilot_cron_tick_before_jstt();
  begin perform public.jstt_dispatch();exception when others then null;end;
 end $fn$;$sql$;
 else
 execute $sql$create function public.jstt_dispatch(p_manual boolean default false) returns text language sql as 'select ''DISABLED''::text'$sql$;
 end if;end $$;
alter function public.pilot_cleanup(timestamptz) rename to pilot_cleanup_before_jstt;
create function public.pilot_cleanup(p_at timestamptz default now()) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform public.pilot_cleanup_before_jstt(p_at);
 delete from public.jstt_berth_events where detected_at<p_at-interval '365 days';
 delete from public.jstt_monitor_runs where finished_at<p_at-interval '30 days';
 delete from public.jstt_budget_reservations where created_at<p_at-interval '30 days';
 delete from public.jstt_ui_requests where created_at<p_at-interval '30 days';
 -- Keep compact per-ID cursors, including archived calls, to prevent bootstrap replay.
end $$;
do $$declare t text;f record;begin
 foreach t in array array['jstt_monitor_control','jstt_vessel_watchlist','jstt_schedule_state','jstt_schedule_delivery','jstt_berth_events','jstt_monitor_runs','jstt_budget_reservations','jstt_ui_requests'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant all on public.%I to service_role',t);end loop;
 for f in select p.oid::regprocedure name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and (p.proname like 'jstt_%' and p.proname not like 'jstt_schedule_%' or p.proname in('pilot_cron_tick','pilot_cron_tick_before_jstt','pilot_cleanup','pilot_cleanup_before_jstt','hpbot_toggle_setting','hpbot_toggle_setting_before_jstt')) loop
 execute format('revoke all on function %s from public,anon,authenticated',f.name);execute format('grant execute on function %s to service_role',f.name);end loop;
end $$;
commit;
