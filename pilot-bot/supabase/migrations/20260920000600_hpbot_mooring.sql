begin;
-- Preserve the source L column verbatim, without full-name guessing or extra
-- per-vessel HTTP calls. Missing historical data remains unknown.
alter function public.hpbot_plan(jsonb,jsonb,jsonb,jsonb,boolean,boolean,timestamptz) rename to hpbot_plan_v2;
create function public.hpbot_plan(p_old jsonb,p_apps jsonb,p_forecast jsonb,p_ranges jsonb,p_continuous boolean,p_baseline boolean,p_at timestamptz)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare p jsonb; weather jsonb;
begin
 p:=public.hpbot_plan_v2(p_old,p_apps,p_forecast,p_ranges,p_continuous,p_baseline,p_at);
 select coalesce(jsonb_agg(f||jsonb_build_object('mooring_name',(select r->>'mooring_name' from jsonb_array_elements(p->'rows') r where r->>'application_id'=f->>'application_id'))),'[]')
 into weather from jsonb_array_elements(p->'weather_rows') f;
 return p||jsonb_build_object('weather_rows',weather);
end $$;
create or replace function public.hpbot_schedule_messages(changes jsonb) returns text[] language plpgsql immutable set search_path=pg_catalog,public as $$
declare ch jsonb; label text; message text:=''; messages text[]:='{}'; labels jsonb:='{"010":"요청","020":"확인","030":"변경","040":"POB","050":"완료","060":"청구","090":"취소"}';
begin
 for ch in select value from jsonb_array_elements(changes) loop
   if ch->>'type'='BAD_WEATHER_TO_PROCESSING' or (ch->>'type'='STATUS_CHANGED' and ch#>>'{old,forecast_status}'='BAD_WEATHER' and ch#>>'{new,forecast_status}'='PROCESSING') then continue; end if;
   label:=coalesce(ch#>>'{new,vessel_name}','')||' — '||case ch->>'type' when 'NEW' then '신규 도선 등록' when 'TIME_CHANGED' then '도선시간 변경' when 'ROUTE_CHANGED' then '구간 변경' when 'CANCELLED' then '취소' when 'COMPLETED' then '완료' when 'REMARK_CHANGED' then '비고 변경' else '상태 변경' end||chr(10);
   if ch#>>'{new,display_sequence}' is not null then label:=label||'현재 순번: '||(ch#>>'{new,display_sequence}')||'번'||chr(10); end if;
   if ch->>'type'='TIME_CHANGED' then label:=label||coalesce(ch#>>'{old,pilot_date}','')||' '||coalesce(nullif(ch#>>'{old,pilot_time}',''),'시간 미정')||' → '; end if;
   label:=label||coalesce(ch#>>'{new,pilot_date}','')||' '||coalesce(nullif(ch#>>'{new,pilot_time}',''),'시간 미정')||chr(10);
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
create or replace function public.pilot_weather_message(ev jsonb,s jsonb,p_at timestamptz) returns text language sql immutable set search_path=pg_catalog,public as $$
 select public.pilot_weather_message_v1(ev,s,p_at)
 ||case when ev#>>'{vessel,sequence_no}' is null then '' else chr(10)||'현재 협운 순번: '||(ev#>>'{vessel,sequence_no}')||'번' end
 ||case when ev->'vessel' is null or ev->'vessel'='null'::jsonb then '' else chr(10)||'강취: '||coalesce(nullif(btrim(ev#>>'{vessel,mooring_name}'),''),'미확인') end
$$;
alter function public.hpbot_read(text,int,text,text) rename to hpbot_read_v1;
create function public.hpbot_read(p_command text,p_page int default 0,p_search text default '',p_chat text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb; rows jsonb;
begin
 result:=public.hpbot_read_v1(p_command,p_page,p_search,p_chat);
 if p_command in('queue','today','tomorrow','three','search') then
  select coalesce(jsonb_agg(r||jsonb_build_object('mooring_name',c.data->>'mooring_name') order by ord),'[]')
  into rows from jsonb_array_elements(result->'rows') with ordinality t(r,ord)
  left join public.hpbot_pilot_current c on c.application_id=r->>'application_id';
  result:=result||jsonb_build_object('rows',rows);
 end if;
 return result;
end $$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in('hpbot_plan','hpbot_plan_v2','hpbot_read','hpbot_read_v1','pilot_weather_message','hpbot_schedule_messages') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.name);
 execute format('grant execute on function %s to service_role',f.name);
 end loop;
end $$;
commit;
