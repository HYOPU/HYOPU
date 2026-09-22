begin;
-- Presentation only: preserve source comparison, weather decisions, outbox
-- keys, settings, budgets and already-sent messages.
create function public.pilot_display_value(v text,empty_label text default '없음') returns text
language sql immutable set search_path=pg_catalog,public as $$
 select case when v is null then '미확인' else coalesce(nullif(btrim(v),''),empty_label) end
$$;
create function public.pilot_status_label(v text) returns text
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce('{"010":"요청","020":"확인","030":"변경","040":"POB (도선사 승선)","050":"완료","060":"청구","090":"취소","BAD_WEATHER":"BAD WEATHER","P.O.B":"POB","UNSPECIFIED":"표시 없음"}'::jsonb->>v,nullif(v,''),'미확인')
$$;
create function public.hpbot_change_block(changes jsonb) returns text
language plpgsql immutable set search_path=pg_catalog,public as $$
declare o jsonb:=changes->0->'old'; n jsonb:=changes->0->'new'; types text[]; labels text[];
 line text; before_value text; after_value text; pob boolean;
begin
 select array_agg(distinct c->>'type'),bool_or(public.hpbot_is_pob_change(c)) into types,pob from jsonb_array_elements(changes) c;
 select array_agg(label order by ord) into labels from (values
  ('NEW','신규 도선 등록',1),('TIME_CHANGED','시간 변경',2),('ROUTE_CHANGED','구간 변경',3),
  ('STATUS_CHANGED',case when pob then '🚢 POB (도선사 승선)' else '상태 변경' end,4),
  ('REMARK_CHANGED','비고 변경',5),('CANCELLED','취소',6),('COMPLETED','완료',7),('BAD_WEATHER_TO_PROCESSING','도선재개 전환',8)
 ) t(typ,label,ord) where typ=any(types);
 line:=coalesce(n->>'vessel_name',o->>'vessel_name','선박 미확인')||' — '||coalesce(array_to_string(labels,' · '),'변경');
 if n->>'display_sequence' is not null then line:=line||chr(10)||'현재 순번: '||(n->>'display_sequence')||'번'; end if;
 before_value:=public.pilot_date_label(o->>'pilot_date',o->>'pilot_time');
 after_value:=public.pilot_date_label(n->>'pilot_date',n->>'pilot_time');
 line:=line||chr(10)||'일시: '||case when 'TIME_CHANGED'=any(types) then before_value||' → ' else '' end||after_value;
 before_value:=public.pilot_display_value(o->>'from_location')||' → '||public.pilot_display_value(o->>'to_location');
 after_value:=public.pilot_display_value(n->>'from_location')||' → '||public.pilot_display_value(n->>'to_location');
 line:=line||chr(10)||'구간: '||case when 'ROUTE_CHANGED'=any(types) then before_value||' ⇒ ' else '' end||after_value;
 line:=line||chr(10)||'강취: '||case when o->>'mooring_name' is not null and o->>'mooring_name' is distinct from n->>'mooring_name'
  then public.pilot_display_value(o->>'mooring_name')||' → ' else '' end||public.pilot_display_value(n->>'mooring_name','미확인');
 line:=line||chr(10)||'신청: '||case when o->>'application_status' is not null and o->>'application_status' is distinct from n->>'application_status'
  then public.pilot_status_label(o->>'application_status')||' → ' else '' end||public.pilot_status_label(n->>'application_status');
 line:=line||' / 공개: '||case when 'STATUS_CHANGED'=any(types) and o->>'forecast_status' is not null and n->>'forecast_status' is not null and o->>'forecast_status'<>n->>'forecast_status'
  then public.pilot_status_label(o->>'forecast_status')||' → ' else '' end||case when n->>'forecast_status' is null then '미확인' else public.pilot_status_label(n->>'forecast_status') end;
 -- Empty is known absence; null is unavailable evidence. Preserve additions,
 -- deletions and the full old/new contents rather than just naming the event.
 if 'REMARK_CHANGED'=any(types) or (o is not null and o<>'null'::jsonb and o->>'remarks' is distinct from n->>'remarks') then
  line:=line||chr(10)||'비고: '||public.pilot_display_value(o->>'remarks')||' → '||public.pilot_display_value(n->>'remarks');
 elsif nullif(btrim(n->>'remarks'),'') is not null then line:=line||chr(10)||'비고: '||(n->>'remarks'); end if;
 return line;
end $$;

create or replace function public.hpbot_schedule_messages(changes jsonb) returns text[]
language plpgsql immutable set search_path=pg_catalog,public as $$
declare g record; block text; body text:=''; parts text[]:='{}'; result text[]:='{}'; i int;
begin
 -- One block per application per observation, not one repeated vessel block
 -- for every changed field. Retain the existing resume/POB suppression rule.
 for g in select jsonb_agg(c order by ord) changes from jsonb_array_elements(changes) with ordinality t(c,ord)
  where c->>'type'<>'BAD_WEATHER_TO_PROCESSING' and not coalesce((
   c->>'type'='STATUS_CHANGED' and not public.hpbot_is_pob_change(c)
   and c#>>'{old,forecast_status}'='BAD_WEATHER' and c#>>'{new,forecast_status}'='PROCESSING'),false)
  group by coalesce(c#>>'{new,application_id}',c#>>'{old,application_id}',c->>'key',
   jsonb_build_array(c#>>'{new,callsign}',c#>>'{new,vessel_name}',c#>>'{new,pilot_date}',c#>>'{new,from_location}',c#>>'{new,to_location}')::text)
  order by min(ord)
 loop
  block:=public.hpbot_change_block(g.changes);
  if body<>'' and char_length(body)+char_length(block)+2>1700 then parts:=array_append(parts,body);body:='';end if;
  -- 1700 Unicode scalars remain below Telegram's UTF-16 limit even for emoji.
  -- Split exceptionally long remarks; never silently left(...,2800) them away.
  while char_length(block)>1700 loop
   parts:=array_append(parts,left(block,1700));block:=substr(block,1701);
  end loop;
  if block<>'' then body:=body||case when body='' then '' else chr(10)||chr(10) end||block;end if;
 end loop;
 if body<>'' then parts:=array_append(parts,body);end if;
 for i in 1..coalesce(array_length(parts,1),0) loop
  result:=array_append(result,'🔔 [협운 도선일정 변경]'||case when array_length(parts,1)>1 then ' ('||i||'/'||array_length(parts,1)||')' else '' end||chr(10)||parts[i]);
 end loop;
 return result;
end $$;

create or replace function public.pilot_weather_message_v1(ev jsonb,s jsonb,p_at timestamptz) returns text
language plpgsql immutable set search_path=pg_catalog,public as $$
declare message text; duration bigint;
begin
 if ev->>'type'='SUSPEND' then
  return '🚨 [울산 도선중단 감지]'||chr(10)||'기준: 전체 BAD WEATHER 2척 이상 · 2회 연속'||chr(10)||'현재 BAD WEATHER: '||(s->>'bad_weather_count')||'척'||chr(10)||'중단 시작 감지: '||public.pilot_kst_label(p_at)||chr(10)||'※ 도선예보현황 자동감지 기준';
 end if;
 duration:=greatest(0,extract(epoch from p_at-(s->>'started_at')::timestamptz)::bigint);
 if ev->>'method'='HYOPU_TRANSITION' then
  message:='🟢 [울산 도선재개 감지]'||chr(10)||'선박: '||coalesce(ev#>>'{vessel,vessel_name}','미확인')||chr(10)||'상태: BAD WEATHER → PROCESSING (협운 동일 일정)'||chr(10)||'시간: '||public.pilot_date_label(ev#>>'{vessel,pilot_date}',ev#>>'{vessel,pilot_time}')||chr(10)||'구간: '||coalesce(ev#>>'{vessel,from_location}','미확인')||' → '||coalesce(ev#>>'{vessel,to_location}','미확인');
  if nullif(btrim(ev#>>'{vessel,remarks}'),'') is not null then message:=message||chr(10)||'예보 비고: '||left(ev#>>'{vessel,remarks}',800)||case when length(ev#>>'{vessel,remarks}')>800 then '… (일부 생략)' else '' end;end if;
 else
  message:='🟢 [울산 도선재개 추정]'||chr(10)||'기준: BAD WEATHER 0척 · 30분 연속'||chr(10)||'협운 BAD WEATHER → PROCESSING 전환은 직접 확인되지 않았습니다.';
 end if;
 return message||chr(10)||'현재 BAD WEATHER: '||coalesce(s->>'bad_weather_count','미확인')||'척'||chr(10)||'중단 감지: '||public.pilot_kst_label((s->>'started_at')::timestamptz)||chr(10)||'재개 감지: '||public.pilot_kst_label(p_at)||chr(10)||'중단 지속시간: 약 '||(duration/3600)||'시간 '||((duration%3600)/60)||'분'||chr(10)||'※ 도선예보현황 자동감지 기준';
end $$;

-- Small operational context, read from existing DB state (no external fetch).
create function public.pilot_operational_message(p_type text,p_message text) returns text
language plpgsql stable set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control; code text;
begin
 if p_type not in('SOURCE_ERROR','SOURCE_RECOVERY','COST_WARNING','COST_STOP') then return p_message;end if;
 select * into c from public.pilot_watcher_control where id;
 if p_type='SOURCE_ERROR' then
  select error into code from public.pilot_runs where error is not null order by started_at desc limit 1;
  return '⚠️ [울산도선사회 감시 오류]'||chr(10)||'연속 실패: '||c.failure_count||'회'||chr(10)||'마지막 정상: '||public.pilot_kst_label(c.last_success)||chr(10)||'오류: '||case when code ~ '^[A-Z_0-9]{1,80}$' then code else '수집 확인 필요' end||chr(10)||'기존 일정·기상 상태 유지 / 완료·취소·재개 판단 보류';
 elsif p_type='SOURCE_RECOVERY' then
  return '✅ [울산도선사회 감시 복구]'||chr(10)||'협운 신청·공개 예보 정상 수집'||chr(10)||'복구 확인: '||public.pilot_kst_label(now())||chr(10)||'중단 구간의 도선재개는 추정하지 않습니다.';
 end if;
 return p_message||chr(10)||'추정 한도: 하루 '||round(c.day_limit/1048576.0,0)||'MiB / 주기 '||round(c.cycle_limit/1048576.0,0)||'MiB'||chr(10)||case when p_type='COST_STOP' then '사용량 확인 후 수동 재개 필요' else '한도 도달 시 도선봇만 자동 중지' end||chr(10)||'※ 앱 추정량이며 실제 청구 Egress와 다릅니다.';
end $$;
create or replace function public.pilot_queue(p_key text,p_type text,p_ref text,p_message text) returns void
language sql set search_path=pg_catalog,public as $$
 insert into public.pilot_notifications(notification_key,notification_type,reference_id,message)
 values(p_key,p_type,p_ref,left(public.pilot_operational_message(p_type,p_message),2800)) on conflict do nothing
$$;

do $$ declare f record;begin
 for f in select p.oid::regprocedure as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in('pilot_display_value','pilot_status_label','hpbot_change_block','hpbot_schedule_messages','pilot_weather_message_v1','pilot_operational_message','pilot_queue') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.name);
 execute format('grant execute on function %s to service_role',f.name);
 end loop;
end $$;
commit;
