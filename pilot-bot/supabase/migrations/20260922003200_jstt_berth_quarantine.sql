-- A newly observed/unverified berth must not stop unrelated, valid schedules.
-- 4부두 was read on the authoritative grid for FIRST LION on 2026-09-22.
begin;
alter table public.jstt_schedule_state
 add column observed_raw_berth text,
 add column berth_verified boolean not null default true,
 add column last_verified_at timestamptz;
update public.jstt_schedule_state set observed_raw_berth=raw_berth,last_verified_at=last_seen_at;
alter table public.jstt_schedule_state alter column observed_raw_berth set not null;
alter table public.jstt_monitor_control
 add column unknown_count int not null default 0 check(unknown_count>=0),
 add column last_warning text,
 add column recovery_pending boolean not null default false;
alter table public.jstt_monitor_runs
 add column unknown_count int not null default 0 check(unknown_count>=0),
 add column warnings jsonb not null default '[]';

create or replace function public.jstt_plan_events(p_rows jsonb,p_chat text) returns jsonb language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('schedule_key',r->>'schedule_key','vessel_name',r->>'vessel_name','agency_name',r->>'agency_name',
 'schedule_datetime',r->>'schedule_datetime','old_berth',d.last_berth,'new_berth',r->>'normalized_berth','revision',coalesce(d.event_revision,0)+1,
 'event_type',case when r->>'normalized_berth'='UNASSIGNED' then 'BERTH_UNASSIGNED' when d.last_berth is null or not d.ever_assigned then 'INITIAL_ASSIGNED'
 when d.last_berth='UNASSIGNED' then 'REASSIGNED' else 'BERTH_CHANGED' end) order by r->>'schedule_datetime',r->>'schedule_key'),'[]')
 from jsonb_array_elements(p_rows) r left join public.jstt_schedule_delivery d on d.chat_id=p_chat and d.schedule_key=r->>'schedule_key'
 where coalesce((r->>'berth_verified')::boolean,true) and r->>'normalized_berth'<>'UNKNOWN'
 and r->>'source_status'<>'이안' and public.jstt_is_target(p_chat,r->>'agency_name',r->>'vessel_name')
 and d.last_berth is distinct from r->>'normalized_berth' and (d.last_berth is not null or r->>'normalized_berth'<>'UNASSIGNED')
$$;

create or replace function public.jstt_apply(p_id uuid,p_version bigint,p_hash text,p_rows jsonb default null,p_ingress bigint default 0,p_duration int default 0,p_at timestamptz default now()) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.jstt_monitor_control;r public.jstt_monitor_runs;x jsonb;allrows jsonb;events jsonb;chat text;
 today text:=(p_at at time zone 'Asia/Seoul')::date::text;finish text:=((p_at at time zone 'Asia/Seoul')::date+7)::text;
 amount int:=0;previous_count int;unknowns int;diagnostics jsonb;recover boolean;
begin
 select * into c from public.jstt_monitor_control where id for update;
 select * into r from public.jstt_monitor_runs where id=p_id;
 if not r.claimed or r.finished_at is not null or c.lease_token is distinct from p_id or c.lease_until<p_at or c.version<>p_version then return jsonb_build_object('accepted',false);end if;
 if not c.enabled and not r.probe then return jsonb_build_object('accepted',false);end if;
 if p_hash is null or p_hash!~'^[a-f0-9]{64}$' or (p_rows is null and p_hash is distinct from c.last_hash) then raise exception 'JSTT_HASH_INVALID';end if;
 if p_rows is not null then
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>2000 or octet_length(p_rows::text)>524288 then raise exception 'JSTT_ROWS_INVALID';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) a where
   jsonb_typeof(a)<>'object' or coalesce(a->>'schedule_key','')!~'^\d{8,24}$'
   or coalesce(a->>'normalized_berth','') not in('UNKNOWN','UNASSIGNED','2부두','3부두','4부두','N3','N4','N5')
   or (a ? 'berth_verified' and jsonb_typeof(a->'berth_verified')<>'boolean')
   or jsonb_typeof(a->'raw_berth') is distinct from 'string' or length(a->>'raw_berth')>160 or (a->>'raw_berth')~'[[:cntrl:]]'
   or case when a->>'normalized_berth'='UNKNOWN' then
      a->'berth_verified' is distinct from 'false'::jsonb or a->>'raw_berth' in('대기','2부두','3부두','4부두','N3','N4','N5')
    else not coalesce((a->>'berth_verified')::boolean,true)
      or coalesce(a->>'raw_berth','')<>case when a->>'normalized_berth'='UNASSIGNED' then '대기' else a->>'normalized_berth' end end
   or coalesce(a->>'source_status','') not in('계획','요청','수정요청','확정','접안','이안')
   or coalesce(a->>'schedule_datetime','')!~'^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$'
   or left(a->>'schedule_datetime',10) not between today and finish or coalesce(a->>'vessel_name','')='' or coalesce(a->>'agency_name','')='')
   or (select count(*)<>count(distinct a->>'schedule_key') from jsonb_array_elements(p_rows) a) then raise exception 'JSTT_ROWS_INVALID';end if;
  -- Departed rows remain auditable but do not degrade active berth monitoring.
  select count(*) into unknowns from jsonb_array_elements(p_rows) a where a->>'normalized_berth'='UNKNOWN' and a->>'source_status'<>'이안';
  select coalesce(jsonb_agg(v),'[]') into diagnostics from (
   select jsonb_build_object('code','JSTT_BERTH_UNVERIFIED','schedule_key',a->>'schedule_key','raw_berth',left(a->>'raw_berth',60)) v
   from jsonb_array_elements(p_rows) a where a->>'normalized_berth'='UNKNOWN' order by a->>'schedule_key' limit 10) q;
 else
  -- Quality is part of the snapshot, not an error that a hash hit can erase.
  unknowns:=c.unknown_count;
  diagnostics:=case when unknowns>0 then jsonb_build_array(jsonb_build_object('code','JSTT_BERTH_UNVERIFIED','count',unknowns,'unchanged',true)) else '[]'::jsonb end;
 end if;
 if r.probe then
  update public.jstt_monitor_runs set success=true,finished_at=p_at,row_count=jsonb_array_length(p_rows),html_ingress_bytes=p_ingress,duration_ms=p_duration,unknown_count=unknowns,warnings=diagnostics where id=p_id;
  update public.jstt_monitor_control set lease_token=null,lease_until=null where id;
  select primary_chat_id into chat from public.hpbot_control where id;
  return jsonb_build_object('accepted',true,'probe',true,'rows',jsonb_array_length(p_rows),'unknown_count',unknowns,'quality',case when unknowns>0 then 'DEGRADED' else 'VERIFIED' end,'quality_status',case when unknowns>0 then 'DEGRADED' else 'HEALTHY' end,'warnings',diagnostics,'events',public.jstt_plan_events(p_rows,chat));
 end if;
 if p_rows is not null then
  select count(*) into previous_count from public.jstt_schedule_state where source_status<>'이안' and left(schedule_datetime,10) between today and finish;
  -- Count every structurally valid row, including quarantined berths.
  if (previous_count>0 and jsonb_array_length(p_rows)=0) or (previous_count>=10 and jsonb_array_length(p_rows)*2<previous_count) then
   perform public.jstt_fail(p_id,'JSTT_PARTIAL_RANGE',p_at);
   return jsonb_build_object('accepted',false,'error','JSTT_PARTIAL_RANGE');
  end if;
  for x in select value from jsonb_array_elements(p_rows) loop
   insert into public.jstt_schedule_state(schedule_key,vessel_name,normalized_vessel_name,agency_name,schedule_datetime,port_in_datetime,departure_datetime,source_status,
    raw_berth,normalized_berth,observed_raw_berth,berth_verified,last_verified_at,lifecycle,last_seen_at,updated_at)
   values(x->>'schedule_key',x->>'vessel_name',public.jstt_name(x->>'vessel_name'),x->>'agency_name',x->>'schedule_datetime',x->>'port_in_datetime',x->>'departure_datetime',x->>'source_status',
    x->>'raw_berth',x->>'normalized_berth',x->>'raw_berth',coalesce((x->>'berth_verified')::boolean,true),case when x->>'normalized_berth'<>'UNKNOWN' then p_at end,
    case when x->>'source_status'='이안' then 'ARCHIVED' else 'ACTIVE' end,p_at,p_at)
   on conflict(schedule_key) do update set vessel_name=excluded.vessel_name,normalized_vessel_name=excluded.normalized_vessel_name,agency_name=excluded.agency_name,schedule_datetime=excluded.schedule_datetime,
    port_in_datetime=excluded.port_in_datetime,departure_datetime=excluded.departure_datetime,source_status=excluded.source_status,
    raw_berth=case when excluded.berth_verified then excluded.raw_berth else jstt_schedule_state.raw_berth end,
    normalized_berth=case when excluded.berth_verified then excluded.normalized_berth else jstt_schedule_state.normalized_berth end,
    observed_raw_berth=excluded.observed_raw_berth,berth_verified=excluded.berth_verified,
    last_verified_at=case when excluded.berth_verified then excluded.last_verified_at
     -- A hash hit verifies all still-present rows without per-row writes. Preserve
     -- that latest proof when a previously verified row first enters quarantine.
     -- A missing/archived row has no such evidence from the last complete run.
     when jstt_schedule_state.berth_verified and jstt_schedule_state.missing_count=0 and jstt_schedule_state.lifecycle='ACTIVE'
      then greatest(jstt_schedule_state.last_verified_at,c.last_success)
     else jstt_schedule_state.last_verified_at end,
    revision=jstt_schedule_state.revision+case when excluded.berth_verified and jstt_schedule_state.normalized_berth<>excluded.normalized_berth then 1 else 0 end,
    missing_count=0,lifecycle=excluded.lifecycle,last_seen_at=p_at,updated_at=p_at;
  end loop;
  update public.jstt_schedule_state s set missing_count=missing_count+1,lifecycle=case when missing_count>=1 then 'MISSING' else lifecycle end
   where lifecycle<>'ARCHIVED' and not exists(select 1 from jsonb_array_elements(p_rows) a where a->>'schedule_key'=s.schedule_key);
 else
  update public.jstt_schedule_state set missing_count=missing_count+1,lifecycle='MISSING' where missing_count>0 and lifecycle<>'ARCHIVED';
 end if;
 update public.jstt_schedule_state set lifecycle='ARCHIVED' where left(schedule_datetime,10) not between today and finish;
 select coalesce(jsonb_agg(to_jsonb(s) order by schedule_key),'[]') into allrows from public.jstt_schedule_state s where lifecycle='ACTIVE' and missing_count=0;
 recover:=unknowns=0 and (c.failure_count>=5 or c.recovery_pending);
 for chat in select chat_id from public.pilot_telegram_chats where enabled loop
  events:=public.jstt_plan_events(allrows,chat);amount:=amount+jsonb_array_length(events);perform public.jstt_queue_events(events,chat,p_at);
  for x in select value from jsonb_array_elements(allrows) a where coalesce((a->>'berth_verified')::boolean,true) and a->>'normalized_berth'<>'UNKNOWN' and public.jstt_is_target(chat,a->>'agency_name',a->>'vessel_name') loop
   insert into public.jstt_schedule_delivery(chat_id,schedule_key,last_berth,ever_assigned,event_revision)
   values(chat,x->>'schedule_key',x->>'normalized_berth',x->>'normalized_berth'<>'UNASSIGNED',case when x->>'normalized_berth'<>'UNASSIGNED' then 1 else 0 end)
   on conflict(chat_id,schedule_key) do update set last_berth=excluded.last_berth,ever_assigned=jstt_schedule_delivery.ever_assigned or excluded.ever_assigned,
    event_revision=jstt_schedule_delivery.event_revision+case when jstt_schedule_delivery.last_berth<>excluded.last_berth then 1 else 0 end;
  end loop;
  if recover then insert into public.pilot_notifications(notification_key,notification_type,reference_id,message,telegram_chat_id)
   values('jstt_recovery:'||c.outage_id||':'||chat,'JSTT_RECOVERY',c.outage_id::text,'✅ [JSTT 감시 복구]'||chr(10)||'정상확인: '||public.pilot_kst_label(p_at),chat) on conflict do nothing;end if;
 end loop;
 update public.jstt_monitor_runs set success=true,finished_at=p_at,row_count=jsonb_array_length(allrows),html_ingress_bytes=p_ingress,duration_ms=p_duration,unknown_count=unknowns,warnings=diagnostics where id=p_id;
 update public.jstt_monitor_control set last_success=p_at,last_hash=p_hash,version=version+1,failure_count=0,
  outage_id=case when unknowns>0 and (c.failure_count>=5 or c.recovery_pending) then c.outage_id end,
  recovery_pending=unknowns>0 and (c.failure_count>=5 or c.recovery_pending),
  unknown_count=unknowns,last_warning=case when unknowns>0 then 'JSTT_BERTH_UNVERIFIED' end,
  last_error=null,candidate_hash=null,lease_token=null,lease_until=null where id;
 return jsonb_build_object('accepted',true,'rows',jsonb_array_length(allrows),'events',amount,'unknown_count',unknowns,'quality',case when unknowns>0 then 'DEGRADED' else 'VERIFIED' end,'quality_status',case when unknowns>0 then 'DEGRADED' else 'HEALTHY' end);
end $$;

-- Keep all existing read filters, search, pagination and room authorization.
do $$declare body text;needle text;begin
 body:=pg_get_functiondef('public.jstt_read(text,text,integer,text,text)'::regprocedure);
 needle:=$old$'running',lease_until>now()$old$;
 if position(needle in body)=0 then raise exception 'JSTT_READ_HEALTH_CONTRACT_CHANGED';end if;
 body:=replace(body,needle,$new$'running',lease_until>now(),'unknown_count',unknown_count,'last_warning',last_warning,'quality',case when unknown_count>0 then 'DEGRADED' else 'VERIFIED' end,'quality_status',case when unknown_count>0 then 'DEGRADED' else 'HEALTHY' end$new$);
 needle:='s.normalized_berth,s.lifecycle,s.missing_count';
 if position(needle in body)=0 then raise exception 'JSTT_READ_ROWS_CONTRACT_CHANGED';end if;
 execute replace(body,needle,'s.normalized_berth,s.lifecycle,s.missing_count,s.observed_raw_berth,s.berth_verified,s.last_verified_at');
end $$;
revoke all on function public.jstt_plan_events(jsonb,text),public.jstt_apply(uuid,bigint,text,jsonb,bigint,integer,timestamptz),public.jstt_read(text,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.jstt_plan_events(jsonb,text),public.jstt_apply(uuid,bigint,text,jsonb,bigint,integer,timestamptz),public.jstt_read(text,text,integer,text,text) to service_role;
commit;
