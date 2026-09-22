-- Additive, service-only login source integration. No LINE UP objects touched.
begin;
create table public.hpbot_control (
 id boolean primary key default true check(id), initialized boolean not null default false,
 alerts_enabled boolean not null default false, paused boolean not null default false,
 application_hash text, forecast_hash text, application_snapshot bigint, forecast_snapshot bigint,
 sealed_session text, session_updated_at timestamptz, last_refresh_at timestamptz, manual_started_at timestamptz,
 bootstrap_next date not null default '1900-01-01', bootstrap_done boolean not null default false,
 last_login_ok boolean, last_forecast_ok boolean, last_error text
);
insert into public.hpbot_control(id) values(true);
create table public.hpbot_source_snapshots (
 id bigint generated always as identity primary key, source text not null check(source in('applications','forecast')),
 content_hash text not null, rows jsonb not null check(jsonb_typeof(rows)='array'),
 ranges jsonb not null default '[]', observed_at timestamptz not null,
 check(octet_length(rows::text)<=800000)
);
create table public.hpbot_pilot_current (
 application_id text primary key check(application_id ~ '^[0-9]{1,30}$'),
 external_key text generated always as ('1002:'||application_id) stored,
 data jsonb not null,
 vessel_name text generated always as (data->>'vessel_name') stored,
 pilot_date text generated always as (data->>'pilot_date') stored,
 pilot_time text generated always as (data->>'pilot_time') stored,
 from_location text generated always as (data->>'from_location') stored,
 to_location text generated always as (data->>'to_location') stored,
 application_status text generated always as (data->>'application_status') stored,
 completion_status text generated always as (data->>'completion_status') stored,
 forecast_status text generated always as (data->>'forecast_status') stored,
 first_seen_at timestamptz not null, last_seen_at timestamptz not null, updated_at timestamptz not null,
 revision bigint not null default 1
);
create table public.hpbot_pilot_history (
 id bigint generated always as identity primary key, external_key text not null, vessel_name text not null,
 event_type text not null check(event_type in('NEW','TIME_CHANGED','ROUTE_CHANGED','STATUS_CHANGED','REMARK_CHANGED','CANCELLED','COMPLETED','BAD_WEATHER_TO_PROCESSING')),
 old_data jsonb, new_data jsonb, detected_at timestamptz not null, run_id uuid not null
);
create index on public.hpbot_pilot_history(detected_at desc);
create table public.pilot_monitor_logs (
 id uuid primary key, hpbot_login_ok boolean not null, forecast_fetch_ok boolean not null,
 hpbot_records int, active_records int, forecast_records int, bad_weather_count int,
 duration_ms int, error text, created_at timestamptz not null default now()
);
create table public.hpbot_collection_ranges (
 start_date date not null, end_date date not null, last_complete_at timestamptz not null,
 primary key(start_date,end_date)
);
create function public.hpbot_lifecycle(s text) returns text language sql immutable as $$
 select case when s in('050','060') then 'COMPLETED' when s='090' then 'CANCELLED'
 when s in('010','020','030','040') then 'ACTIVE' else 'UNKNOWN' end
$$;
create function public.hpbot_vessel(s text) returns text language sql immutable as $$
 select regexp_replace(regexp_replace(upper(trim(s)),'\s+',' ','g'),'^(M/V|MV)\s+','','i')
$$;
create function public.hpbot_match_key(r jsonb) returns text language sql immutable as $$
 select jsonb_build_array(upper(trim(r->>'callsign')),public.hpbot_vessel(r->>'vessel_name'),
 r->>'pilot_date',upper(trim(r->>'from_location')),upper(trim(r->>'to_location')))::text
$$;
create function public.hpbot_covered(d text,ranges jsonb) returns boolean language sql immutable as $$
 select exists(select 1 from jsonb_array_elements(ranges) r where d>=r->>'start' and d<=r->>'end')
$$;

-- Pure business reducer. A caller must supply only fully parsed, complete ranges.
create function public.hpbot_plan(p_old jsonb,p_apps jsonb,p_forecast jsonb,p_ranges jsonb,p_continuous boolean,p_baseline boolean,p_at timestamptz)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare result jsonb:='[]'; changes jsonb:='[]'; r jsonb; o jsonb; f jsonb; t jsonb; k text;
 n int; n2 int; typ text; lifecycle text; review boolean; misses int; weather_rows jsonb:='[]';
begin
 if jsonb_typeof(p_apps)<>'array' or jsonb_typeof(p_forecast)<>'array' or jsonb_typeof(p_ranges)<>'array' then raise exception 'SOURCE_SHAPE'; end if;
 if exists(select 1 from jsonb_array_elements(p_apps) a where a->>'application_id' is not null group by a->>'application_id' having count(*)>1) then raise exception 'APPLICATION_DUPLICATE'; end if;
 for r in select value from jsonb_array_elements(p_apps) where value->>'application_id' is not null loop
   if r->>'application_id' !~ '^[0-9]{1,30}$' or r->>'agent'<>'협운' then raise exception 'APPLICATION_ID_OR_AGENCY'; end if;
   r:=r||jsonb_build_object('completion_status',public.hpbot_lifecycle(r->>'application_status'),'missing_count',0,'needs_review',false);
   result:=result||jsonb_build_array(r);
 end loop;
 for o in select value from jsonb_array_elements(p_old) loop
   if exists(select 1 from jsonb_array_elements(result) a where a->>'application_id'=o->>'application_id') then continue; end if;
   r:=o; review:=false;
   select count(*),jsonb_agg(a)->0 into n,t from jsonb_array_elements(p_apps) a
     where a->>'application_id' is null and public.hpbot_match_key(a)=public.hpbot_match_key(o)
     and public.hpbot_lifecycle(a->>'application_status') in('COMPLETED','CANCELLED');
   select count(*) into n2 from jsonb_array_elements(p_old) a where public.hpbot_match_key(a)=public.hpbot_match_key(o);
   if n=1 and n2=1 then
     r:=o||t||jsonb_build_object('application_id',o->>'application_id','completion_status',public.hpbot_lifecycle(t->>'application_status'),'missing_count',0,'needs_review',false);
   elsif public.hpbot_lifecycle(o->>'application_status') not in('COMPLETED','CANCELLED') then
     -- A same-vessel candidate on another day/route or an ambiguous terminal row
     -- prevents absence from becoming cancellation.
     review:=n>0 or exists(select 1 from jsonb_array_elements(p_apps) a where
       upper(a->>'callsign')=upper(o->>'callsign') and public.hpbot_vessel(a->>'vessel_name')=public.hpbot_vessel(o->>'vessel_name')
       and a->>'application_id' is null);
     misses:=case when p_continuous and not review and public.hpbot_covered(o->>'pilot_date',p_ranges)
       then coalesce((o->>'missing_count')::int,0)+1 else 0 end;
     r:=o||jsonb_build_object('missing_count',misses,'needs_review',true);
     if misses>=2 then r:=r||jsonb_build_object('application_status','090','completion_status','CANCELLED','cancellation_basis','TWO_COMPLETE_OBSERVATIONS'); end if;
   end if;
   result:=result||jsonb_build_array(r);
 end loop;
 p_apps:=result; result:='[]';
 for r in select value from jsonb_array_elements(p_apps) loop
   f:=null; k:=public.hpbot_match_key(r);
   select count(*),jsonb_agg(a)->0 into n,f from jsonb_array_elements(p_forecast) a
     where a->>'agent'='협운' and not coalesce((a->>'cancelled')::boolean,true) and public.hpbot_match_key(a)=k;
   select count(*) into n2 from jsonb_array_elements(p_apps) a where public.hpbot_match_key(a)=k
     and public.hpbot_lifecycle(a->>'application_status') not in('COMPLETED','CANCELLED');
   if n<>1 or n2<>1 or coalesce(r->>'callsign','')='' or coalesce((r->>'needs_review')::boolean,false) or public.hpbot_lifecycle(r->>'application_status') in('COMPLETED','CANCELLED') then f:=null; end if;
   r:=r||jsonb_build_object('forecast_status',f->>'status','raw_forecast_status',f->>'raw_status',
     'forecast_time',f->>'pilot_time','match_basis',case when f is null then 'UNMATCHED' else 'UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE' end);
   result:=result||jsonb_build_array(r);
   select value into o from jsonb_array_elements(p_old) a where a->>'application_id'=r->>'application_id';
   if p_baseline then continue; end if;
   if o is null then
     if public.hpbot_lifecycle(r->>'application_status') not in('COMPLETED','CANCELLED') then changes:=changes||jsonb_build_array(jsonb_build_object('type','NEW','old',null,'new',r)); end if;
     continue;
   end if;
   for typ in select unnest(array['TIME_CHANGED','ROUTE_CHANGED','STATUS_CHANGED','REMARK_CHANGED','COMPLETED','CANCELLED','BAD_WEATHER_TO_PROCESSING']) loop
     if (typ='TIME_CHANGED' and (o->>'pilot_date' is distinct from r->>'pilot_date' or o->>'pilot_time' is distinct from r->>'pilot_time'))
       or (typ='ROUTE_CHANGED' and (o->>'from_location' is distinct from r->>'from_location' or o->>'to_location' is distinct from r->>'to_location'))
       or (typ='STATUS_CHANGED' and public.hpbot_lifecycle(r->>'application_status') not in('COMPLETED','CANCELLED') and
         (o->>'application_status' is distinct from r->>'application_status' or (p_continuous and o->>'forecast_status' is not null and r->>'forecast_status' is not null and o->>'forecast_status'<>r->>'forecast_status')))
       or (typ='REMARK_CHANGED' and o->>'remarks' is distinct from r->>'remarks')
       or (typ='COMPLETED' and public.hpbot_lifecycle(r->>'application_status')='COMPLETED' and public.hpbot_lifecycle(o->>'application_status')<>'COMPLETED')
       or (typ='CANCELLED' and public.hpbot_lifecycle(r->>'application_status')='CANCELLED' and public.hpbot_lifecycle(o->>'application_status')<>'CANCELLED')
       or (typ='BAD_WEATHER_TO_PROCESSING' and p_continuous and public.hpbot_match_key(o)=k
          and o->>'match_basis'='UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE' and r->>'match_basis'='UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE'
          and o->>'forecast_status'='BAD_WEATHER' and r->>'forecast_status'='PROCESSING') then
       changes:=changes||jsonb_build_array(jsonb_build_object('type',typ,'old',o,'new',r));
     end if;
   end loop;
 end loop;
 for f in select value from jsonb_array_elements(p_forecast) loop
   select count(*),jsonb_agg(a)->0 into n,r from jsonb_array_elements(result) a
     where a->>'match_basis'='UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE' and public.hpbot_match_key(a)=public.hpbot_match_key(f);
   if n=1 and f->>'agent'='협운' and not (f->>'cancelled')::boolean then
     f:=f||jsonb_build_object('identity','1002:'||(r->>'application_id')||':'||(f->>'identity'),'application_id',r->>'application_id');
   else f:=f||jsonb_build_object('agent',case when f->>'agent'='협운' then '협운(매칭미확인)' else f->>'agent' end); end if;
   weather_rows:=weather_rows||jsonb_build_array(f);
 end loop;
 return jsonb_build_object('rows',result,'changes',changes,'weather_rows',weather_rows);
end $$;

create view public.hpbot_pilot_queue with(security_invoker=true) as
select row_number() over(order by case when nullif(c.pilot_time,'') is null then 1 else 0 end,c.pilot_date,c.pilot_time,c.application_id::numeric,c.application_id) as sequence_no,
 c.application_id,c.external_key,c.vessel_name,c.pilot_date,c.pilot_time,c.from_location,c.to_location,
 c.application_status,c.completion_status,c.forecast_status,c.data->>'raw_forecast_status' as raw_forecast_status,
 c.data->>'forecast_time' as forecast_time,c.data->>'match_basis' as match_basis,
 coalesce((c.data->>'needs_review')::boolean,false) as needs_review,
 nullif(c.pilot_time,'') is not null and (c.pilot_date||'T'||c.pilot_time||':00+09:00')::timestamptz<now() as is_overdue,
 w.last_success as observed_at
from public.hpbot_pilot_current c cross join public.pilot_watcher_control w
where c.completion_status not in('COMPLETED','CANCELLED');

create function public.hpbot_context() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare d public.hpbot_control; today date:=(now() at time zone 'Asia/Seoul')::date; old_dates jsonb; boot_end date;
begin
 select * into d from public.hpbot_control where id;
 select coalesce(jsonb_agg(pilot_date),'[]') into old_dates from (select distinct pilot_date from public.hpbot_pilot_current where completion_status not in('COMPLETED','CANCELLED') and pilot_date<(today-30)::text order by pilot_date limit 61) a;
 if jsonb_array_length(old_dates)>60 then raise exception 'OLD_RANGE_LIMIT'; end if;
 boot_end:=least(case when d.bootstrap_next<'2018-01-01' then date '2017-12-31' else (d.bootstrap_next+interval '1 year'-interval '1 day')::date end,today-31);
 return jsonb_build_object('application_hash',d.application_hash,'forecast_hash',d.forecast_hash,'sealed_session',d.sealed_session,
 'ranges',jsonb_build_array(jsonb_build_object('start',today-30,'end','9999-12-31')),'old_dates',old_dates,
 'bootstrap',case when d.bootstrap_done or d.bootstrap_next>today-31 then null else jsonb_build_object('start',d.bootstrap_next,'end',boot_end) end,
 'initialized',d.initialized,'paused',d.paused,'bootstrap_done',d.bootstrap_done);
end $$;
create function public.hpbot_begin(p_at timestamptz default now(),p_manual boolean default false) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare b jsonb; c public.pilot_watcher_control; token uuid; manual_slot timestamptz;
begin
 select * into c from public.pilot_watcher_control where id for update;
 if (select paused from public.hpbot_control where id) then return jsonb_build_object('skip','PAUSED'); end if;
 if p_manual then
   if not c.enabled then return jsonb_build_object('skip','DISABLED_OR_BUDGET'); end if;
   if c.lease_until>p_at then return jsonb_build_object('skip','BUSY'); end if;
   if (select manual_started_at from public.hpbot_control where id)>p_at-interval '30 seconds' then return jsonb_build_object('skip','COOLDOWN'); end if;
   if c.lease_token is not null then perform public.pilot_fail(c.lease_token,'EXECUTION_EXPIRED',p_at); end if;
   if not public.pilot_reserve(8192,p_at) then return jsonb_build_object('skip','DISABLED_OR_BUDGET'); end if;
   token:=gen_random_uuid();manual_slot:=p_at;
   if exists(select 1 from public.pilot_runs where pilot_runs.slot=manual_slot) then manual_slot:=manual_slot+interval '1 microsecond'; end if;
   insert into public.pilot_runs(id,slot,started_at) values(token,manual_slot,p_at);
   update public.pilot_watcher_control set lease_token=token,lease_until=p_at+interval '50 seconds',lease_slot=date_trunc('minute',p_at) where id;
   update public.hpbot_control set manual_started_at=p_at where id;
   b:=jsonb_build_object('token',token,'hash',c.last_hash,'version',c.version);
 else b:=public.pilot_begin(p_at); end if;
 if b->>'token' is null then return b; end if;
 return b||public.hpbot_context();
end $$;

create function public.hpbot_filter_notifications(changes jsonb) returns jsonb language sql stable as $$
 select coalesce(jsonb_agg(c),'[]') from jsonb_array_elements(changes) c where c->>'type'<>'COMPLETED'
$$;
create function public.hpbot_schedule_messages(changes jsonb) returns text[] language plpgsql immutable as $$
declare ch jsonb; label text; message text:=''; messages text[]:='{}';
begin
 for ch in select value from jsonb_array_elements(changes) loop
   if ch->>'type'='BAD_WEATHER_TO_PROCESSING' or
     (ch->>'type'='STATUS_CHANGED' and ch#>>'{old,forecast_status}'='BAD_WEATHER' and ch#>>'{new,forecast_status}'='PROCESSING') then continue; end if;
   label:=coalesce(ch#>>'{new,vessel_name}','')||' — '||case ch->>'type'
     when 'NEW' then '신규 도선 등록' when 'TIME_CHANGED' then '도선시간 변경' when 'ROUTE_CHANGED' then '구간 변경'
     when 'CANCELLED' then '취소' when 'COMPLETED' then '완료' when 'REMARK_CHANGED' then '비고 변경' else '상태 변경' end||chr(10);
   if ch->>'type'='TIME_CHANGED' then label:=label||coalesce(ch#>>'{old,pilot_date}','')||' '||coalesce(ch#>>'{old,pilot_time}','시간 미정')||' → '; end if;
   label:=label||coalesce(ch#>>'{new,pilot_date}','')||' '||coalesce(ch#>>'{new,pilot_time}','시간 미정')||chr(10);
   if ch->>'type'='ROUTE_CHANGED' then label:=label||coalesce(ch#>>'{old,from_location}','')||' → '||coalesce(ch#>>'{old,to_location}','')||' 변경 후 '; end if;
   label:=label||coalesce(ch#>>'{new,from_location}','')||' → '||coalesce(ch#>>'{new,to_location}','');
   if length(message)+length(label)>2300 then messages:=array_append(messages,'🔔 [협운 도선일정 변경]'||chr(10)||message); message:=''; end if;
   message:=message||case when message='' then '' else chr(10)||chr(10) end||label;
 end loop;
 if message<>'' then messages:=array_append(messages,'🔔 [협운 도선일정 변경]'||chr(10)||message); end if;
 return messages;
end $$;

create function public.hpbot_commit(p_token uuid,p_version bigint,p_application_hash text,p_forecast_hash text,p_applications jsonb,p_forecast jsonb,p_ranges jsonb,p_session text,p_bootstrap_end date,p_ingress bigint,p_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control; d public.hpbot_control; apps jsonb; forecast jsonb; old jsonb; old_weather jsonb; st jsonb; plan jsonb; wp jsonb; s jsonb;
 continuous boolean; r jsonb; ch jsonb; ev jsonb; eid uuid; sid bigint; aid bigint; fid bigint; msg text; part int:=0;
begin
 select * into c from public.pilot_watcher_control where id for update;
 select * into d from public.hpbot_control where id for update;
 if not c.enabled or d.paused or c.lease_token is distinct from p_token or c.lease_until<=p_at or c.version<>p_version then raise exception 'STALE_EXECUTION'; end if;
 if p_application_hash !~ '^[a-f0-9]{64}$' or p_forecast_hash !~ '^[a-f0-9]{64}$' or p_ingress<0 or p_ingress>12000000 then raise exception 'INVALID_SOURCE'; end if;
 if p_applications is null then
   if d.application_hash is distinct from p_application_hash then raise exception 'HASH_REQUIRES_ROWS'; end if;
   select rows into apps from public.hpbot_source_snapshots where id=d.application_snapshot;
 else apps:=p_applications; end if;
 if p_forecast is null then
   if d.forecast_hash is distinct from p_forecast_hash then raise exception 'HASH_REQUIRES_ROWS'; end if;
   select rows into forecast from public.hpbot_source_snapshots where id=d.forecast_snapshot;
 else forecast:=p_forecast; end if;
 if apps is null or forecast is null or octet_length(apps::text)>800000 or octet_length(forecast::text)>800000 then raise exception 'SOURCE_LIMIT'; end if;
 select coalesce(jsonb_agg(data),'[]') into old from public.hpbot_pilot_current;
 select coalesce(rows,'[]') into old_weather from public.pilot_snapshots where id=c.snapshot_id;
 old_weather:=coalesce(old_weather,'[]');
 if public.pilot_has_row_drop(old_weather,forecast) then perform public.pilot_fail(p_token,'ABNORMAL_ROW_DROP',p_at); return jsonb_build_object('accepted',false); end if;
 continuous:=d.initialized and c.continuous and c.lease_slot in(c.last_slot,c.last_slot+interval '1 minute') and p_at-c.last_success<=interval '90 seconds';
 plan:=public.hpbot_plan(old,apps,forecast,p_ranges,continuous,not d.initialized or not d.alerts_enabled,p_at);
 select to_jsonb(w) into st from public.pilot_weather_state w where id;
 wp:=public.pilot_plan(old_weather,plan->'weather_rows',st,continuous,p_at); s:=wp->'state'; eid:=(st->>'event_id')::uuid;
 if c.lease_slot=c.last_slot then
   -- A refresh can show real same-work transitions, but cannot create a second
   -- weather threshold observation or advance the re-arm counters this minute.
   s:=s||jsonb_build_object('candidate_count',st->'candidate_count','rearm_count',st->'rearm_count');
   if not (st->>'status'='SUSPENDED' and wp#>>'{events,0,method}'='HYOPU_TRANSITION') then
     s:=s||jsonb_build_object('status',st->>'status','started_at',st->'started_at','resumed_at',st->'resumed_at','recovery_started_at',st->'recovery_started_at');
     wp:=wp||jsonb_build_object('events','[]'::jsonb);
   end if;
 end if;
 -- The existing weather event ID and notification unique keys survive cutover.
 for ev in select value from jsonb_array_elements(wp->'events') loop
   if ev->>'type'='SUSPEND' then
     eid:=gen_random_uuid(); insert into public.pilot_weather_events(id,started_at,max_bad_weather_count) values(eid,p_at,(s->>'bad_weather_count')::int);
     perform public.pilot_queue('weather_suspend:'||eid,'WEATHER_SUSPEND',eid::text,public.pilot_weather_message(ev,s,p_at));
   elsif ev->>'type'='RESUME' and eid is not null then
     update public.pilot_weather_events set ended_at=p_at,resume_detected_at=p_at,resume_vessel_name=ev#>>'{vessel,vessel_name}',resume_schedule_key='1002:'||(ev#>>'{vessel,application_id}'),resume_method=ev->>'method',duration_seconds=greatest(0,extract(epoch from p_at-(st->>'started_at')::timestamptz)::bigint) where id=eid;
     perform public.pilot_queue('weather_resume:'||eid,'WEATHER_RESUME',eid::text,public.pilot_weather_message(ev,s,p_at));
   end if;
 end loop;
 if s->>'status'='NORMAL' then eid:=null; end if;
 if eid is not null then update public.pilot_weather_events set max_bad_weather_count=greatest(max_bad_weather_count,(s->>'bad_weather_count')::int) where id=eid; end if;
 update public.pilot_weather_state set status=s->>'status',bad_weather_count=(s->>'bad_weather_count')::int,candidate_count=(s->>'candidate_count')::int,rearm_count=(s->>'rearm_count')::int,started_at=(s->>'started_at')::timestamptz,resumed_at=(s->>'resumed_at')::timestamptz,recovery_started_at=(s->>'recovery_started_at')::timestamptz,event_id=eid,last_seen_at=p_at,updated_at=p_at,resume_alert_sent=case when s->>'status'='SUSPENDED' then false else resume_alert_sent end where id;
 aid:=d.application_snapshot; fid:=d.forecast_snapshot; sid:=c.snapshot_id;
 if p_application_hash is distinct from d.application_hash then
   insert into public.hpbot_source_snapshots(source,content_hash,rows,ranges,observed_at) values('applications',p_application_hash,apps,p_ranges,p_at) returning id into aid;
 end if;
 if p_forecast_hash is distinct from d.forecast_hash then
   insert into public.hpbot_source_snapshots(source,content_hash,rows,observed_at) values('forecast',p_forecast_hash,forecast,p_at) returning id into fid;
 end if;
 if not d.initialized or wp->'rows' is distinct from old_weather then
   insert into public.pilot_snapshots(content_hash,rows,observed_at) values(p_forecast_hash,wp->'rows',p_at) returning id into sid;
 end if;
 for r in select value from jsonb_array_elements(plan->'rows') loop
   insert into public.hpbot_pilot_current(application_id,data,first_seen_at,last_seen_at,updated_at)
   values(r->>'application_id',r,p_at,p_at,p_at) on conflict(application_id) do update set
     data=excluded.data,last_seen_at=p_at,updated_at=p_at,revision=hpbot_pilot_current.revision+1
     where hpbot_pilot_current.data is distinct from excluded.data;
 end loop;
 for ch in select value from jsonb_array_elements(plan->'changes') loop
   insert into public.hpbot_pilot_history(external_key,vessel_name,event_type,old_data,new_data,detected_at,run_id)
   values('1002:'||(ch#>>'{new,application_id}'),ch#>>'{new,vessel_name}',ch->>'type',ch->'old',ch->'new',p_at,p_token);
 end loop;
 foreach msg in array public.hpbot_schedule_messages(public.hpbot_filter_notifications(plan->'changes')) loop
   perform public.pilot_queue('hpbot_change:'||p_token||':'||part,'SCHEDULE_CHANGE',p_token::text,msg); part:=part+1;
 end loop;
 for r in select value from jsonb_array_elements(p_ranges) loop
   insert into public.hpbot_collection_ranges values((r->>'start')::date,(r->>'end')::date,p_at)
   on conflict(start_date,end_date) do update set last_complete_at=p_at;
 end loop;
 if p_session is not null and (length(p_session)>65536 or p_session not like '{%') then raise exception 'SESSION_INVALID'; end if;
 update public.hpbot_control set initialized=true,application_hash=p_application_hash,forecast_hash=p_forecast_hash,application_snapshot=aid,forecast_snapshot=fid,
 sealed_session=coalesce(p_session,sealed_session),session_updated_at=case when p_session is null then session_updated_at else p_at end,
 bootstrap_next=case when p_bootstrap_end is null then bootstrap_next else p_bootstrap_end+1 end,
 bootstrap_done=bootstrap_done or coalesce(p_bootstrap_end>=(p_at at time zone 'Asia/Seoul')::date-31,false),
 last_login_ok=true,last_forecast_ok=true,last_error=null where id;
 if c.failure_count>=5 then perform public.pilot_queue('source_recovery:'||c.outage_id,'SOURCE_RECOVERY',c.outage_id::text,'✅ [울산도선사회 감시 복구] 정상 수집이 복구되었습니다.'); end if;
 update public.pilot_watcher_control set last_hash=p_forecast_hash,snapshot_id=sid,version=version+1,last_success=p_at,last_slot=lease_slot,continuous=true,failure_count=0,outage_id=null,lease_token=null,lease_until=null where id;
 update public.pilot_runs set finished_at=p_at,success=true,snapshot_id=sid,ingress_bytes=p_ingress,parser_version='hyopu-dual-v1' where id=p_token;
 insert into public.pilot_monitor_logs(id,hpbot_login_ok,forecast_fetch_ok,hpbot_records,active_records,forecast_records,bad_weather_count,duration_ms,created_at)
 values(p_token,true,true,jsonb_array_length(apps),(select count(*) from public.hpbot_pilot_queue),jsonb_array_length(forecast),(s->>'bad_weather_count')::int,greatest(0,extract(epoch from p_at-(select started_at from public.pilot_runs where id=p_token))*1000)::int,p_at);
 return jsonb_build_object('accepted',true,'active',(select count(*) from public.hpbot_pilot_queue),'changes',jsonb_array_length(plan->'changes'),'state',s->>'status','notification',public.pilot_claim_notification(p_at));
end $$;

create function public.hpbot_fail(p_token uuid,p_error text,p_login_ok boolean,p_forecast_ok boolean) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform 1 from public.pilot_watcher_control where id and lease_token=p_token for update;
 if not found then return; end if;
 perform public.pilot_fail(p_token,p_error);
 update public.hpbot_control set last_login_ok=p_login_ok,last_forecast_ok=p_forecast_ok,last_error=left(p_error,80) where id;
 insert into public.pilot_monitor_logs(id,hpbot_login_ok,forecast_fetch_ok,error) values(p_token,p_login_ok,p_forecast_ok,left(p_error,80)) on conflict do nothing;
end $$;

create function public.hpbot_preview(p_applications jsonb,p_forecast jsonb,p_ranges jsonb,p_at timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control; old jsonb; wold jsonb; st jsonb; plan jsonb; wp jsonb; messages text[]; ev jsonb;
begin
 select * into c from public.pilot_watcher_control where id;
 select coalesce(jsonb_agg(data),'[]') into old from public.hpbot_pilot_current;
 select rows into wold from public.pilot_snapshots where id=c.snapshot_id;
 select to_jsonb(s) into st from public.pilot_weather_state s where id;
 if public.pilot_has_row_drop(coalesce(wold,'[]'),p_forecast) then
   return jsonb_build_object('login_ok',true,'eligible',false,'error','ABNORMAL_FORECAST_ROW_DROP','current_state',st->>'status','next_state',st,'changes_count',0,'expected_telegram_messages','[]'::jsonb);
 end if;
 plan:=public.hpbot_plan(old,p_applications,p_forecast,p_ranges,c.continuous and p_at-c.last_success<=interval '90 seconds' and date_trunc('minute',p_at)=c.last_slot+interval '1 minute',not (select initialized and alerts_enabled from public.hpbot_control where id),p_at);
 wp:=public.pilot_plan(coalesce(wold,'[]'),plan->'weather_rows',st,c.continuous and p_at-c.last_success<=interval '90 seconds' and date_trunc('minute',p_at)=c.last_slot+interval '1 minute',p_at);
 messages:=public.hpbot_schedule_messages(public.hpbot_filter_notifications(plan->'changes'));
 for ev in select value from jsonb_array_elements(wp->'events') loop messages:=array_prepend(public.pilot_weather_message(ev,wp->'state',p_at),messages); end loop;
 return jsonb_build_object('login_ok',true,'eligible',not public.pilot_has_row_drop(coalesce(wold,'[]'),p_forecast),
 'counts',jsonb_build_object('registered',jsonb_array_length(p_applications),'completed',(select count(*) from jsonb_array_elements(p_applications) r where public.hpbot_lifecycle(r->>'application_status')='COMPLETED'),
 'active',(select count(*) from jsonb_array_elements(plan->'rows') r where public.hpbot_lifecycle(r->>'application_status') not in('COMPLETED','CANCELLED')),'forecast',jsonb_array_length(p_forecast),'bad_weather',wp#>'{state,bad_weather_count}',
 'processing',(select count(*) from jsonb_array_elements(p_forecast) r where r->>'status'='PROCESSING' and not (r->>'cancelled')::boolean),'matched',(select count(*) from jsonb_array_elements(plan->'rows') r where r->>'match_basis'='UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE')),
 'current_state',st->>'status','next_state',wp->'state','changes_count',jsonb_array_length(plan->'changes'),'expected_telegram_messages',messages[1:3],
 'queue',(select coalesce(jsonb_agg(x),'[]') from (select row_number() over(order by case when nullif(r->>'pilot_time','') is null then 1 else 0 end,r->>'pilot_date',r->>'pilot_time',(r->>'application_id')::numeric) as sequence_no,r->>'vessel_name' as vessel_name,r->>'pilot_date' as pilot_date,r->>'pilot_time' as pilot_time,r->>'from_location' as from_location,r->>'to_location' as to_location from jsonb_array_elements(plan->'rows') r where public.hpbot_lifecycle(r->>'application_status') not in('COMPLETED','CANCELLED') order by sequence_no limit 10) x),
 'transitions',(select coalesce(jsonb_agg(x),'[]') from (select r->>'vessel_name' as vessel_name,r->>'application_id' as application_id from jsonb_array_elements(wp->'resumes') r limit 10) x),'truncated',cardinality(messages)>3);
end $$;

do $$ declare t text; f record; begin
 foreach t in array array['hpbot_control','hpbot_source_snapshots','hpbot_pilot_current','hpbot_pilot_history','pilot_monitor_logs','hpbot_collection_ranges'] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from public,anon,authenticated',t);
   execute format('grant all on public.%I to service_role',t);
 end loop;
 for f in select p.oid::regprocedure as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'hpbot_%' loop
   execute format('revoke all on function %s from public,anon,authenticated',f.name);
   execute format('grant execute on function %s to service_role',f.name);
 end loop;
end $$;
revoke all on public.hpbot_pilot_queue from public,anon,authenticated;
grant select on public.hpbot_pilot_queue to service_role;
commit;
