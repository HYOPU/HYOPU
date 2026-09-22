begin;
-- Presentation and notification routing only. No source rows, weather state,
-- event history, billing controls or execution leases are changed.
create function public.pilot_date_label(p_date text,p_time text) returns text
language plpgsql immutable set search_path=pg_catalog,public as $$
declare d date; label text; t text:=coalesce(nullif(p_time,''),'시간 미정');
begin
 if p_time ~ '^([01][0-9]|2[0-3]):?([0-5][0-9])(:[0-5][0-9])?$' then
  t:=left(replace(p_time,':',''),4);
 end if;
 if coalesce(p_date,'') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
  return coalesce(nullif(p_date,''),'날짜 미정')||' '||t;
 end if;
 begin d:=p_date::date; exception when others then return '날짜 확인 필요 '||t; end;
 label:=to_char(d,'MM/DD')||'('||(array['일','월','화','수','목','금','토'])[extract(dow from d)::int+1]||')';
 return label||' '||t;
end $$;
create function public.pilot_kst_label(p_at timestamptz) returns text
language sql immutable set search_path=pg_catalog,public as $$
 select case when p_at is null then '확인 기록 없음' else public.pilot_date_label(
  to_char(p_at at time zone 'Asia/Seoul','YYYY-MM-DD'),to_char(p_at at time zone 'Asia/Seoul','HH24:MI')) end
$$;
create function public.hpbot_is_pob_change(ch jsonb) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(ch->>'type'='STATUS_CHANGED'
  and ch#>>'{old,application_status}' is not null
  and ch#>>'{old,application_status}'<>'040'
  and ch#>>'{new,application_status}'='040',false)
$$;

-- POB is an independently selectable alert; the recorded history event remains
-- STATUS_CHANGED, retaining the existing atomic commit/dedupe path.
update public.pilot_telegram_chats set settings=settings||'{"POB":true}'::jsonb
 where not settings ? 'POB';
alter table public.pilot_telegram_chats alter column settings set default
 '{"NEW":true,"TIME_CHANGED":true,"ROUTE_CHANGED":true,"STATUS_CHANGED":true,"POB":true,"REMARK_CHANGED":true,"CANCELLED":true,"COMPLETED":false,"WEATHER_SUSPEND":true,"WEATHER_RESUME":true,"SOURCE_ERROR":true,"SOURCE_RECOVERY":true}';
create or replace function public.hpbot_filter_notifications(changes jsonb) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(c order by ord),'[]') from jsonb_array_elements(changes) with ordinality t(c,ord)
 where coalesce((select (ch.settings->>(case when public.hpbot_is_pob_change(c) then 'POB' else c->>'type' end))::boolean
  from public.pilot_telegram_chats ch join public.hpbot_control d on d.primary_chat_id=ch.chat_id),c->>'type'<>'COMPLETED')
$$;
create or replace function public.hpbot_toggle_setting(p_update bigint,p_setting text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.pilot_telegram_updates; v boolean;
begin
 select * into u from public.pilot_telegram_updates where update_id=p_update and status='RECEIVED';
 if not found or p_setting not in('NEW','TIME_CHANGED','ROUTE_CHANGED','STATUS_CHANGED','POB','CANCELLED','WEATHER_SUSPEND','WEATHER_RESUME','SOURCE_ERROR','COMPLETED') then raise exception 'SETTING_INVALID'; end if;
 select not coalesce((settings->>p_setting)::boolean,true) into v from public.pilot_telegram_chats where chat_id=u.chat_id for update;
 update public.pilot_telegram_chats set settings=settings||jsonb_build_object(p_setting,v),updated_at=now() where chat_id=u.chat_id;
 return v;
end $$;
create or replace function public.hpbot_schedule_messages(changes jsonb) returns text[]
language plpgsql immutable set search_path=pg_catalog,public as $$
declare ch jsonb; label text; message text:=''; messages text[]:='{}'; pob boolean;
 labels jsonb:='{"010":"요청","020":"확인","030":"변경","040":"POB","050":"완료","060":"청구","090":"취소"}';
begin
 for ch in select value from jsonb_array_elements(changes) loop
   pob:=public.hpbot_is_pob_change(ch);
   -- A concurrent POB is separate, real login evidence. Do not suppress it along
   -- with the public BAD_WEATHER -> PROCESSING summary handled by weather alerts.
   if ch->>'type'='BAD_WEATHER_TO_PROCESSING' or (not pob and ch->>'type'='STATUS_CHANGED' and ch#>>'{old,forecast_status}'='BAD_WEATHER' and ch#>>'{new,forecast_status}'='PROCESSING') then continue; end if;
   label:=coalesce(ch#>>'{new,vessel_name}','')||' — '||case when pob then '🚢 POB (도선사 승선)' else
    case ch->>'type' when 'NEW' then '신규 도선 등록' when 'TIME_CHANGED' then '도선시간 변경' when 'ROUTE_CHANGED' then '구간 변경' when 'CANCELLED' then '취소' when 'COMPLETED' then '완료' when 'REMARK_CHANGED' then '비고 변경' else '상태 변경' end end||chr(10);
   if ch#>>'{new,display_sequence}' is not null then label:=label||'현재 순번: '||(ch#>>'{new,display_sequence}')||'번'||chr(10); end if;
   if ch->>'type'='TIME_CHANGED' then label:=label||public.pilot_date_label(ch#>>'{old,pilot_date}',ch#>>'{old,pilot_time}')||' → '; end if;
   label:=label||public.pilot_date_label(ch#>>'{new,pilot_date}',ch#>>'{new,pilot_time}')||chr(10);
   if ch->>'type'='ROUTE_CHANGED' then label:=label||coalesce(ch#>>'{old,from_location}','')||' → '||coalesce(ch#>>'{old,to_location}','')||' 변경 후 '; end if;
   label:=label||coalesce(ch#>>'{new,from_location}','')||' → '||coalesce(ch#>>'{new,to_location}','');
   label:=label||chr(10)||'강취: '||coalesce(nullif(btrim(ch#>>'{new,mooring_name}'),''),'미확인');
   if ch->>'type'='STATUS_CHANGED' then label:=label||chr(10)||coalesce(labels->>(ch#>>'{old,application_status}'),ch#>>'{old,application_status}','미확인')||' / '||coalesce(ch#>>'{old,forecast_status}','공개 미확인')||' → '||coalesce(labels->>(ch#>>'{new,application_status}'),ch#>>'{new,application_status}','미확인')||' / '||coalesce(ch#>>'{new,forecast_status}','공개 미확인'); end if;
   if length(message)+length(label)>2300 then messages:=array_append(messages,'🔔 [협운 도선일정 변경]'||chr(10)||message); message:=''; end if;
   message:=message||case when message='' then '' else chr(10)||chr(10) end||label;
 end loop;
 if message<>'' then messages:=array_append(messages,'🔔 [협운 도선일정 변경]'||chr(10)||message); end if;
 return messages;
end $$;
-- Replace the base message only; the current wrapper keeps sequence/강취.
create or replace function public.pilot_weather_message_v1(ev jsonb,s jsonb,p_at timestamptz)
returns text language plpgsql immutable set search_path=pg_catalog,public as $$
declare message text; duration bigint;
begin
 if ev->>'type'='SUSPEND' then
  return '🚨 [울산 도선중단 감지]'||chr(10)||'BAD WEATHER 표시 선박이 2척 이상 연속 확인되었습니다.'||chr(10)||'현재 BAD WEATHER: '||(s->>'bad_weather_count')||'척'||chr(10)||'중단 시작 감지: '||public.pilot_kst_label(p_at)||chr(10)||'※ 도선예보현황 자동감지 기준';
 end if;
 duration:=greatest(0,extract(epoch from p_at-(s->>'started_at')::timestamptz)::bigint);
 if ev->>'method'='HYOPU_TRANSITION' then
  message:='🟢 [울산 도선재개 감지]'||chr(10)||'협운 대리점 선박의 상태가 BAD WEATHER → PROCESSING으로 변경되었습니다.'||chr(10)||'선박: '||(ev#>>'{vessel,vessel_name}')||chr(10)||'시간: '||public.pilot_date_label(ev#>>'{vessel,pilot_date}',ev#>>'{vessel,pilot_time}')||chr(10)||'구간: '||(ev#>>'{vessel,from_location}')||' → '||(ev#>>'{vessel,to_location}');
 else message:='🟢 [울산 도선재개 추정]'||chr(10)||'BAD WEATHER 표시가 30분 이상 확인되지 않습니다.'||chr(10)||'협운 선박의 BAD WEATHER → PROCESSING 전환은 직접 확인되지 않았습니다.'; end if;
 return message||chr(10)||'중단 감지: '||public.pilot_kst_label((s->>'started_at')::timestamptz)||chr(10)||'재개 감지: '||public.pilot_kst_label(p_at)||chr(10)||'중단 지속시간: 약 '||(duration/3600)||'시간 '||((duration%3600)/60)||'분'||chr(10)||'※ 울산도선사회 도선예보현황 자동감지 기준';
end $$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in('pilot_date_label','pilot_kst_label','hpbot_is_pob_change','hpbot_filter_notifications','hpbot_toggle_setting','hpbot_schedule_messages','pilot_weather_message_v1') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.name);
 execute format('grant execute on function %s to service_role',f.name);
 end loop;
end $$;
commit;
