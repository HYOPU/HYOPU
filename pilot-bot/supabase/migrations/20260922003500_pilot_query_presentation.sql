begin;
-- Add presentation evidence without changing source identities, queue ordering,
-- date filters, access boundaries or the existing response fields.
create or replace function public.hpbot_read(p_command text,p_page int default 0,p_search text default '',p_chat text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb; rows jsonb;
begin
 result:=public.hpbot_read_v1(p_command,p_page,p_search,p_chat);
 if p_command in('queue','today','tomorrow','three','search') then
  select coalesce(jsonb_agg(r||jsonb_build_object(
    'mooring_name',c.data->>'mooring_name',
    'operational_status',case when c.completion_status in('COMPLETED','CANCELLED') then null else public.pilot_operational_status(c.data) end
   ) order by ord),'[]') into rows
  from jsonb_array_elements(result->'rows') with ordinality t(r,ord)
  left join public.hpbot_pilot_current c on c.application_id=r->>'application_id';
  result:=result||jsonb_build_object('rows',rows);
 elsif p_command='changes' then
  -- The semantic ledger retains meaningful changes even when delivery is OFF.
  -- Never relabel raw administrative STATUS_CHANGED history as vessel activity.
  select coalesce(jsonb_agg(jsonb_build_object(
    'application_id',e.changes#>>'{0,new,application_id}',
    'vessel_name',e.changes#>>'{0,new,vessel_name}',
    'detected_at',e.created_at,
    'title',public.hpbot_notification_title(e.changes),
    'summary',left(public.hpbot_change_block(e.changes),650)
   ) order by e.created_at desc,e.external_key,e.revision desc),'[]') into rows
  from (select external_key,revision,created_at,changes from public.pilot_schedule_notification_events
   where jsonb_array_length(public.hpbot_notification_projection(changes))>0
   order by created_at desc,external_key,revision desc limit 10) e;
  result:=result||jsonb_build_object('rows',rows);
 end if;
 return result;
end $$;
create index if not exists pilot_schedule_notification_recent on public.pilot_schedule_notification_events(created_at desc,external_key,revision desc);
revoke all on function public.hpbot_read(text,integer,text,text) from public,anon,authenticated;
grant execute on function public.hpbot_read(text,integer,text,text) to service_role;

-- Only wholly unattempted families can be reformatted. Preserve receipt IDs,
-- notification keys, revisions and delivery states. A different chunk count
-- requires review, not new keys or replay of partially delivered text.
do $$
declare e record;n record;ids uuid[];keys text[];messages text[];visible jsonb;w public.pilot_weather_events;
 typ text;ref text;body text;i int;unsafe boolean;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 for e in select * from public.pilot_schedule_notification_events s where exists(
  select 1 from public.pilot_notifications pn where pn.notification_key=any(s.notification_keys)
   and pn.status='PENDING' and pn.attempts=0 and pn.notification_type in('SCHEDULE_CHANGE','WEATHER_RESUME'))
  order by created_at,external_key,revision loop
  ids:='{}';keys:='{}';unsafe:=false;typ:=null;ref:=null;
  for n in select pn.* from unnest(e.notification_keys) with ordinality k(key,ord)
   join public.pilot_notifications pn on pn.notification_key=k.key order by k.ord for update of pn loop
   if n.status<>'PENDING' or n.attempts<>0 or exists(select 1 from public.pilot_notification_attempts a where a.notification_id=n.id) then unsafe:=true;end if;
   if typ is not null and (typ<>n.notification_type or ref<>n.reference_id) then unsafe:=true;end if;
   typ:=n.notification_type;ref:=n.reference_id;ids:=array_append(ids,n.id);keys:=array_append(keys,n.notification_key);
  end loop;
  if unsafe or cardinality(ids)<>cardinality(e.notification_keys) then continue;end if;
  visible:=public.hpbot_filter_notifications(e.changes);
  messages:='{}';
  if typ='SCHEDULE_CHANGE' then messages:=public.hpbot_schedule_messages(visible);
  elsif typ='WEATHER_RESUME' then
   select * into w from public.pilot_weather_events where id::text=ref and resume_schedule_key=e.external_key and resume_method='HYOPU_TRANSITION';
   if not found or w.resume_detected_at is null or jsonb_array_length(visible)=0 then continue;end if;
   body:='재개 근거: 동일 일정 BAD WEATHER → PROCESSING'||chr(10)||public.hpbot_change_block(visible)
    ||chr(10)||'중단 감지: '||public.pilot_kst_label(w.started_at)
    ||chr(10)||'재개 감지: '||public.pilot_kst_label(w.resume_detected_at)||chr(10)||'※ 도선예보현황 자동감지 기준';
   messages:=public.pilot_notification_parts('🟢 [울산 도선재개 감지]',body);
  else continue;end if;
  if cardinality(messages)<>cardinality(ids) then
   update public.pilot_notifications set status='FAILED',error='PRESENTATION_PARTS_REVIEW_REQUIRED'
    where id=any(ids) and status='PENDING' and attempts=0;
   continue;
  end if;
  for i in 1..cardinality(ids) loop
   update public.pilot_notifications set message=messages[i] where id=ids[i] and status='PENDING' and attempts=0;
  end loop;
 end loop;
end $$;
commit;
