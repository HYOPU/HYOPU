begin;
-- Presentation and read compatibility for the shared suspension reducer.
-- Keep the semantic projection, delivery keys and original history intact.
create or replace function public.pilot_operational_status(r jsonb) returns text
language sql immutable set search_path=pg_catalog,public as $$
 select case when coalesce((r->>'needs_review')::boolean,false) then null
  when r->>'application_status'='040' then 'POB'
  when r->>'match_basis'='UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE' and r->>'forecast_status' is not null then
   case public.pilot_status_canonical(r->>'forecast_status') when 'UNSPECIFIED' then '' when 'P.O.B' then 'POB'
    else public.pilot_status_canonical(r->>'forecast_status') end
  else null end
$$;
create or replace function public.pilot_operational_label(v text,p_end boolean default false) returns text
language sql immutable set search_path=pg_catalog,public as $$
 select case when v is null then '미확인' when v='' then case when p_end then '표시 종료' else '표시 없음' end
  when public.pilot_is_suspension(v) then replace(public.pilot_status_canonical(v),'_',' ')
  else v end
$$;

create or replace function public.hpbot_notification_title(changes jsonb) returns text
language plpgsql immutable set search_path=pg_catalog,public as $$
declare types text[];c jsonb;
begin
 changes:=public.hpbot_notification_projection(changes);
 if jsonb_array_length(changes)=0 then return '';end if;
 select array_agg(distinct value->>'type') into types from jsonb_array_elements(changes);
 if 'COMPLETED'=any(types) then return '✅ [도선완료]';end if;
 if 'CANCELLED'=any(types) then return '❌ [도선취소]';end if;
 if 'NEW'=any(types) then return '🆕 [신규 도선등록]';end if;
 for c in select value from jsonb_array_elements(changes) where value->>'type'='OPERATIONAL_STATUS_CHANGED'
  order by case value->>'operational_new' when 'POB' then 1 when 'PORT_CLOSE' then 2 when 'DENSE_FOG' then 3
   when 'BAD_WEATHER' then 4 when 'PROCESSING' then 5 else 6 end loop
  if c->>'operational_new'='POB' then return '🚢 [POB · 도선사 승선]';end if;
  if c->>'operational_new'='PORT_CLOSE' then return '⛔ [PORT CLOSE]';end if;
  if c->>'operational_new'='DENSE_FOG' then return '🌫️ [DENSE FOG]';end if;
  if c->>'operational_new'='BAD_WEATHER' then return '⚠️ [BAD WEATHER]';end if;
  if c->>'operational_new'='PROCESSING' then return '🔄 [PROCESSING]';end if;
 end loop;
 if 'PILOT_DATETIME_CHANGED'=any(types) then
  if exists(select 1 from jsonb_array_elements(changes) t(value) where t.value->>'type'='PILOT_DATETIME_CHANGED'
   and t.value#>>'{old,pilot_date}' is distinct from t.value#>>'{new,pilot_date}') then return '📅 [도선일자 변경]';end if;
  return '⏰ [도선시간 변경]';
 end if;
 if 'ROUTE_CHANGED'=any(types) then return '🧭 [도선구간 변경]';end if;
 if 'REMARK_CHANGED'=any(types) then return '📝 [비고 변경]';end if;
 return '🔄 [도선상태 변경]';
end $$;

create function public.pilot_suspension_summary(s jsonb) returns text
language plpgsql immutable set search_path=pg_catalog,public as $$
declare body text:='';n int;pair record;
begin
 for pair in select * from (values ('BAD WEATHER','bad_weather_count'),('DENSE FOG','dense_fog_count'),('PORT CLOSE','port_close_count'))v(label,key) loop
  n:=coalesce((s->>pair.key)::int,0);
  if n>0 then body:=body||case when body='' then '' else chr(10) end||pair.label||': '||n||'척';end if;
 end loop;
 return body||case when body='' then '' else chr(10) end||'영향 선박: 총 '||coalesce(s->>'suspension_total_count',s->>'bad_weather_count','0')||'척';
end $$;
create or replace function public.pilot_weather_message_v1(ev jsonb,s jsonb,p_at timestamptz) returns text
language plpgsql immutable set search_path=pg_catalog,public as $$
declare message text;duration bigint;prior text;
begin
 if ev->>'type'='SUSPEND' then
  return '🚨 [울산 도선중단 감지]'||chr(10)||'기준: 중단 계열 2척 이상 · 2회 연속'||chr(10)
   ||public.pilot_suspension_summary(s)||chr(10)||'중단 시작 감지: '||public.pilot_kst_label(coalesce((s->>'started_at')::timestamptz,p_at))
   ||chr(10)||'※ 도선예보현황 자동감지 기준';
 end if;
 duration:=greatest(0,extract(epoch from p_at-(s->>'started_at')::timestamptz)::bigint);
 if ev->>'method'='HYOPU_TRANSITION' then
  prior:=coalesce(ev->>'previous_status',ev#>>'{vessel,previous_status}');
  message:='🟢 [울산 도선재개 감지]'||chr(10)||'선박: '||coalesce(ev#>>'{vessel,vessel_name}','미확인')
   ||chr(10)||'상태: '||case when public.pilot_is_suspension(prior) then public.pilot_operational_label(prior) else '중단상태' end||' → PROCESSING (동일 일정)'
   ||chr(10)||'일시: '||public.pilot_date_label(ev#>>'{vessel,pilot_date}',ev#>>'{vessel,pilot_time}')
   ||chr(10)||'구간: '||coalesce(ev#>>'{vessel,from_location}','미확인')||' → '||coalesce(ev#>>'{vessel,to_location}','미확인');
  if nullif(btrim(ev#>>'{vessel,remarks}'),'') is not null then
   message:=message||chr(10)||'비고: '||left(ev#>>'{vessel,remarks}',800)||case when length(ev#>>'{vessel,remarks}')>800 then '… (일부 생략)' else '' end;
  end if;
 else
  message:='🟢 [울산 도선재개 추정]'||chr(10)||'BAD WEATHER · DENSE FOG · PORT CLOSE 모두 0척 · 30분 연속'
   ||chr(10)||'동일 일정의 중단상태 → PROCESSING 전환은 직접 확인되지 않았습니다.';
 end if;
 return message||chr(10)||public.pilot_suspension_summary(s)
  ||chr(10)||'중단 감지: '||public.pilot_kst_label((s->>'started_at')::timestamptz)
  ||chr(10)||'재개 감지: '||public.pilot_kst_label(p_at)
  ||chr(10)||'중단 지속시간: 약 '||(duration/3600)||'시간 '||((duration%3600)/60)||'분'||chr(10)||'※ 도선예보현황 자동감지 기준';
end $$;

-- Retain all merging/settings behavior, replacing only the obsolete evidence label.
do $$ declare def text;needle text;begin
 def:=pg_get_functiondef('public.hpbot_notification_batches(jsonb,jsonb,jsonb,timestamptz)'::regprocedure);
 needle:=$old$'재개 근거: 동일 일정 BAD WEATHER → PROCESSING'$old$;
 if position(needle in def)=0 then raise exception 'SUSPENSION_NOTIFICATION_BATCH_CONTRACT';end if;
 execute replace(def,needle,$new$'재개 근거: 동일 일정 '||case when public.pilot_is_suspension(coalesce(ev->>'previous_status',ev#>>'{vessel,previous_status}')) then public.pilot_operational_label(coalesce(ev->>'previous_status',ev#>>'{vessel,previous_status}')) else '중단상태' end||' → PROCESSING'$new$);
end $$;

alter function public.hpbot_read(text,integer,text,text) rename to hpbot_read_before_suspension;
create function public.hpbot_read(p_command text,p_page int default 0,p_search text default '',p_chat text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;data jsonb;w public.pilot_weather_state;
begin
 result:=public.hpbot_read_before_suspension(p_command,p_page,p_search,p_chat);
 select * into w from public.pilot_weather_state where id;
 result:=result||jsonb_build_object('bad_weather_count',w.bad_weather_count,'dense_fog_count',w.dense_fog_count,
  'port_close_count',w.port_close_count,'suspension_total_count',w.suspension_total_count,'suspension_reasons',w.suspension_reasons,
  'hpbot_dense_fog',(select count(*) from public.hpbot_pilot_queue q where public.pilot_status_canonical(q.forecast_status)='DENSE_FOG'),
  'hpbot_port_close',(select count(*) from public.hpbot_pilot_queue q where public.pilot_status_canonical(q.forecast_status)='PORT_CLOSE'),
  'hpbot_suspension_total',(select count(*) from public.hpbot_pilot_queue q where public.pilot_is_suspension(q.forecast_status)));
 if p_command='weather' then
  select coalesce(jsonb_agg(x order by x.pilot_date,x.pilot_time,x.vessel_name),'[]') into data from (
   select v->>'vessel_name' vessel_name,v->>'pilot_date' pilot_date,v->>'pilot_time' pilot_time,
    v->>'from_location' from_location,v->>'to_location' to_location,v->>'agent' agent,public.pilot_status_canonical(v->>'status') status
   from (
    select distinct on(coalesce(nullif(upper(public.pilot_remark_normalize(r->>'callsign')),''),nullif(upper(public.pilot_remark_normalize(r->>'vessel_name')),''))) r v
    from public.hpbot_control d join public.hpbot_source_snapshots s on s.id=d.forecast_snapshot
     cross join lateral jsonb_array_elements(s.rows) r
    where public.pilot_is_suspension(r->>'status') and not coalesce((r->>'cancelled')::boolean,false)
    order by coalesce(nullif(upper(public.pilot_remark_normalize(r->>'callsign')),''),nullif(upper(public.pilot_remark_normalize(r->>'vessel_name')),'')),
     case public.pilot_status_canonical(r->>'status') when 'PORT_CLOSE' then 1 when 'DENSE_FOG' then 2 else 3 end,
     r->>'pilot_date',r->>'pilot_time',r->>'identity'
   ) selected order by v->>'pilot_date',v->>'pilot_time',v->>'vessel_name' offset p_page*10 limit 10
  ) x;
  result:=result||jsonb_build_object('rows',data,'total',w.suspension_total_count,'page',p_page);
 elsif p_command='events' then
  select coalesce(jsonb_agg(x order by x.started_at desc),'[]') into data from (
   select started_at,resume_detected_at,duration_seconds,resume_vessel_name,resume_method,resume_previous_status,
    bad_weather_count,dense_fog_count,port_close_count,suspension_total_count,suspension_reasons,max_suspension_total_count
   from public.pilot_weather_events order by started_at desc limit 10) x;
  result:=result||jsonb_build_object('rows',data);
 end if;
 return result;
end $$;

-- Reformat only never-attempted schedule families. A resume is reconstructed
-- from its saved actual transition, never from today's current vessel state.
do $$
declare e record;n record;ids uuid[];messages text[];visible jsonb;w public.pilot_weather_events;
 typ text;ref text;body text;i int;unsafe boolean;prior text;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 for e in select * from public.pilot_schedule_notification_events s where exists(
  select 1 from public.pilot_notifications pn where pn.notification_key=any(s.notification_keys)
   and pn.status='PENDING' and pn.attempts=0 and pn.notification_type in('SCHEDULE_CHANGE','WEATHER_RESUME'))
  order by created_at,external_key,revision loop
  ids:='{}';unsafe:=false;typ:=null;ref:=null;
  for n in select pn.* from unnest(e.notification_keys) with ordinality k(key,ord)
   join public.pilot_notifications pn on pn.notification_key=k.key order by k.ord for update of pn loop
   if n.status<>'PENDING' or n.attempts<>0 or exists(select 1 from public.pilot_notification_attempts a where a.notification_id=n.id) then unsafe:=true;end if;
   if typ is not null and (typ<>n.notification_type or ref<>n.reference_id) then unsafe:=true;end if;
   typ:=n.notification_type;ref:=n.reference_id;ids:=array_append(ids,n.id);
  end loop;
  if unsafe or cardinality(ids)<>cardinality(e.notification_keys) then continue;end if;
  visible:=public.hpbot_filter_notifications(e.changes);messages:='{}';
  if typ='SCHEDULE_CHANGE' then messages:=public.hpbot_schedule_messages(visible);
  elsif typ='WEATHER_RESUME' then
   select * into w from public.pilot_weather_events where id::text=ref and resume_schedule_key=e.external_key and resume_method='HYOPU_TRANSITION';
   if not found or w.resume_detected_at is null or jsonb_array_length(visible)=0 then continue;end if;
   select coalesce(w.resume_previous_status,c->>'operational_old') into prior from jsonb_array_elements(visible)c
    where c->>'type'='OPERATIONAL_STATUS_CHANGED' and c->>'operational_new'='PROCESSING' limit 1;
   if not public.pilot_is_suspension(prior) then continue;end if;
   body:='재개 근거: 동일 일정 '||public.pilot_operational_label(prior)||' → PROCESSING'||chr(10)||public.hpbot_change_block(visible)
    ||chr(10)||'중단 감지: '||public.pilot_kst_label(w.started_at)
    ||chr(10)||'재개 감지: '||public.pilot_kst_label(w.resume_detected_at)||chr(10)||'※ 도선예보현황 자동감지 기준';
   messages:=public.pilot_notification_parts('🟢 [울산 도선재개 감지]',body);
  else continue;end if;
  if cardinality(messages)<>cardinality(ids) then
   update public.pilot_notifications set status='FAILED',error='PRESENTATION_PARTS_REVIEW_REQUIRED' where id=any(ids) and status='PENDING' and attempts=0;
   continue;
  end if;
  for i in 1..cardinality(ids) loop
   update public.pilot_notifications set message=messages[i] where id=ids[i] and status='PENDING' and attempts=0;
  end loop;
 end loop;
end $$;

do $$ declare f record;begin
 for f in select p.oid::regprocedure name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in('pilot_suspension_summary','hpbot_read','hpbot_read_before_suspension') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.name);
  execute format('grant execute on function %s to service_role',f.name);
 end loop;
end $$;
commit;
