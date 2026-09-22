begin;
alter table public.pilot_telegram_updates add column search_query text check(length(search_query)<=120);
create function public.hpbot_search_context(p_update bigint,p_previous bigint default null,p_query text default null) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.pilot_telegram_updates; q text;
begin
 select * into u from public.pilot_telegram_updates where update_id=p_update and status='RECEIVED';
 if not found then raise exception 'UPDATE_NOT_ACCEPTED'; end if;
 if p_previous is not null then
   select search_query into q from public.pilot_telegram_updates where update_id=p_previous and chat_id=u.chat_id and created_at>now()-interval '1 day';
 else q:=p_query; end if;
 if q is null or length(q) not between 1 and 120 then return null; end if;
 update public.pilot_telegram_updates set search_query=q where update_id=p_update;
 return q;
end $$;

-- Derive presentation order from the full active queue, never from a filtered
-- page or as an identity. The reducer still ignores order-only changes.
alter function public.hpbot_plan(jsonb,jsonb,jsonb,jsonb,boolean,boolean,timestamptz) rename to hpbot_plan_v1;
create function public.hpbot_plan(p_old jsonb,p_apps jsonb,p_forecast jsonb,p_ranges jsonb,p_continuous boolean,p_baseline boolean,p_at timestamptz)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare plan jsonb; ranked jsonb; enriched jsonb; changes jsonb; weather jsonb;
begin
 plan:=public.hpbot_plan_v1(p_old,p_apps,p_forecast,p_ranges,p_continuous,p_baseline,p_at);
 select coalesce(jsonb_agg(x),'[]') into ranked from (
   select r->>'application_id' application_id,row_number() over(order by case when nullif(r->>'pilot_time','') is null then 1 else 0 end,r->>'pilot_date',r->>'pilot_time',(r->>'application_id')::numeric) sequence_no
   from jsonb_array_elements(plan->'rows') r where public.hpbot_lifecycle(r->>'application_status') not in('COMPLETED','CANCELLED')) x;
 select coalesce(jsonb_agg(r||jsonb_build_object('display_sequence',(select x->'sequence_no' from jsonb_array_elements(ranked)x where x->>'application_id'=r->>'application_id'))),'[]') into enriched from jsonb_array_elements(plan->'rows')r;
 select coalesce(jsonb_agg(ch||jsonb_build_object('new',(select r from jsonb_array_elements(enriched)r where r->>'application_id'=ch#>>'{new,application_id}'))),'[]') into changes from jsonb_array_elements(plan->'changes')ch;
 select coalesce(jsonb_agg(f||jsonb_build_object('sequence_no',(select x->'sequence_no' from jsonb_array_elements(ranked)x where x->>'application_id'=f->>'application_id'))),'[]') into weather from jsonb_array_elements(plan->'weather_rows')f;
 return plan||jsonb_build_object('rows',enriched,'changes',changes,'weather_rows',weather);
end $$;
alter function public.pilot_weather_message(jsonb,jsonb,timestamptz) rename to pilot_weather_message_v1;
create function public.pilot_weather_message(ev jsonb,s jsonb,p_at timestamptz) returns text language sql immutable set search_path=pg_catalog,public as $$
 select public.pilot_weather_message_v1(ev,s,p_at)||case when ev#>>'{vessel,sequence_no}' is null then '' else chr(10)||'현재 협운 순번: '||(ev#>>'{vessel,sequence_no}')||'번' end
$$;
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
   if ch->>'type'='STATUS_CHANGED' then label:=label||chr(10)||coalesce(labels->>(ch#>>'{old,application_status}'),ch#>>'{old,application_status}','미확인')||' / '||coalesce(ch#>>'{old,forecast_status}','공개 미확인')||' → '||coalesce(labels->>(ch#>>'{new,application_status}'),ch#>>'{new,application_status}','미확인')||' / '||coalesce(ch#>>'{new,forecast_status}','공개 미확인'); end if;
   if length(message)+length(label)>2300 then messages:=array_append(messages,'🔔 [협운 도선일정 변경]'||chr(10)||message); message:=''; end if;
   message:=message||case when message='' then '' else chr(10)||chr(10) end||label;
 end loop;
 if message<>'' then messages:=array_append(messages,'🔔 [협운 도선일정 변경]'||chr(10)||message); end if;
 return messages;
end $$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('hpbot_search_context','hpbot_plan','hpbot_plan_v1','pilot_weather_message','pilot_weather_message_v1','hpbot_schedule_messages') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.name);execute format('grant execute on function %s to service_role',f.name);
 end loop;
end $$;
commit;
