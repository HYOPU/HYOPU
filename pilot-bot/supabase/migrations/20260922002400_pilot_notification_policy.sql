begin;
-- Notification projection only: preserve the source reducer, lifecycle history,
-- weather decisions, writer fences, budgets and delivery uncertainty handling.
create table public.pilot_schedule_notification_revisions (
 external_key text primary key,
 revision bigint not null check(revision>0)
);
create table public.pilot_schedule_notification_events (
 external_key text not null,
 revision bigint not null,
 run_id uuid not null,
 change_hash text not null,
 changes jsonb not null,
 notification_keys text[] not null default '{}',
 created_at timestamptz not null,
 primary key(external_key,revision),
 unique(run_id,external_key)
);

create function public.pilot_remark_normalize(v text) returns text
language sql immutable set search_path=pg_catalog,public as $$
 -- HTML entities are decoded ONCE by parse5 before persistence. Never decode
 -- literal business text twice. Include NBSP for old/imported observations.
 select btrim(regexp_replace(replace(v,chr(160),' '),'[[:space:]]+',' ','g'))
$$;
create function public.pilot_operational_status(r jsonb) returns text
language sql immutable set search_path=pg_catalog,public as $$
 select case
  when coalesce((r->>'needs_review')::boolean,false) then null
  when r->>'application_status'='040' then 'POB'
  when r->>'match_basis'='UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE' and r->>'forecast_status' is not null then
   case upper(public.pilot_remark_normalize(r->>'forecast_status'))
    when 'UNSPECIFIED' then '' when 'P.O.B' then 'POB' when 'BAD WEATHER' then 'BAD_WEATHER'
    else upper(public.pilot_remark_normalize(r->>'forecast_status')) end
  else null end
$$;
create function public.pilot_operational_label(v text,p_end boolean default false) returns text
language sql immutable set search_path=pg_catalog,public as $$
 select case when v is null then '미확인' when v='' then case when p_end then '표시 종료' else '표시 없음' end
  when v='BAD_WEATHER' then 'BAD WEATHER' else v end
$$;

-- Keep legacy history events, but carry explicit continuity evidence to the
-- notification projection. Admin changes must not smuggle a status comparison
-- across an outage. POB's authenticated 040 evidence remains independently valid.
alter function public.hpbot_plan(jsonb,jsonb,jsonb,jsonb,boolean,boolean,timestamptz) rename to hpbot_plan_before_notification_policy;
create function public.hpbot_plan(p_old jsonb,p_apps jsonb,p_forecast jsonb,p_ranges jsonb,p_continuous boolean,p_baseline boolean,p_at timestamptz)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare p jsonb; c jsonb;
begin
 p:=public.hpbot_plan_before_notification_policy(p_old,p_apps,p_forecast,p_ranges,p_continuous,p_baseline,p_at);
 select coalesce(jsonb_agg(ch||jsonb_build_object('operational_continuous',p_continuous) order by ord),'[]') into c
 from jsonb_array_elements(p->'changes') with ordinality t(ch,ord)
 where ch->>'type'<>'REMARK_CHANGED' or public.pilot_remark_normalize(ch#>>'{old,remarks}') is distinct from public.pilot_remark_normalize(ch#>>'{new,remarks}');
 return p||jsonb_build_object('changes',c);
end $$;

create function public.hpbot_notification_projection(changes jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog,public as $$
declare ch jsonb; o jsonb; n jsonb; typ text; result jsonb:='[]'; a text; b text; pob boolean; evidence boolean; valid boolean;
begin
 for ch in select value from jsonb_array_elements(changes) loop
  o:=ch->'old';n:=ch->'new';typ:=ch->>'type';valid:=false;
  if typ in('NEW','CANCELLED','COMPLETED') then result:=result||jsonb_build_array(ch);continue;end if;
  if typ in('TIME_CHANGED','PILOT_DATETIME_CHANGED') then
   typ:='PILOT_DATETIME_CHANGED';valid:=o->>'pilot_date' is distinct from n->>'pilot_date' or o->>'pilot_time' is distinct from n->>'pilot_time';
  elsif typ='ROUTE_CHANGED' then
   valid:=o->>'from_location' is distinct from n->>'from_location' or o->>'to_location' is distinct from n->>'to_location';
  elsif typ='REMARK_CHANGED' then
   valid:=public.pilot_remark_normalize(o->>'remarks') is distinct from public.pilot_remark_normalize(n->>'remarks');
  elsif typ in('STATUS_CHANGED','OPERATIONAL_STATUS_CHANGED') then
   typ:='OPERATIONAL_STATUS_CHANGED';a:=public.pilot_operational_status(o);b:=public.pilot_operational_status(n);
   pob:=o->>'application_status' is not null and o->>'application_status'<>'040' and n->>'application_status'='040'
    and not coalesce((n->>'needs_review')::boolean,false);
   evidence:=coalesce((ch->>'operational_continuous')::boolean,false)
    and o->>'application_id'=n->>'application_id'
    and n->>'match_basis'='UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE'
    and (o->>'match_basis'='UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE' or o->>'application_status'='040')
    and a is not null and b is not null;
   valid:=(pob or evidence) and a is distinct from b
    and public.hpbot_lifecycle(n->>'application_status') not in('COMPLETED','CANCELLED');
   ch:=ch||jsonb_build_object('operational_old',a,'operational_new',b,'pob_entry',pob);
  end if;
  if valid then result:=result||jsonb_build_array(ch||jsonb_build_object('type',typ));end if;
 end loop;
 -- Canonical order and one category per application/observation.
 select coalesce(jsonb_agg(c order by c#>>'{new,application_id}',c->>'type'),'[]') into result
 from (select distinct value c from jsonb_array_elements(result)) x;
 return result;
end $$;
create function public.hpbot_notification_setting(p_key text) returns boolean
language sql stable set search_path=pg_catalog,public as $$
 select coalesce((select (ch.settings->>p_key)::boolean from public.pilot_telegram_chats ch
 join public.hpbot_control d on d.primary_chat_id=ch.chat_id),p_key<>'COMPLETED')
$$;
create or replace function public.hpbot_filter_notifications(changes jsonb) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(c order by ord),'[]')
 from jsonb_array_elements(public.hpbot_notification_projection(changes)) with ordinality t(c,ord)
 where public.hpbot_notification_setting(case c->>'type'
  when 'PILOT_DATETIME_CHANGED' then 'TIME_CHANGED'
  when 'OPERATIONAL_STATUS_CHANGED' then case when coalesce((c->>'pob_entry')::boolean,false) then 'POB' else 'STATUS_CHANGED' end
  else c->>'type' end)
$$;

create or replace function public.hpbot_change_block(changes jsonb) returns text
language plpgsql immutable set search_path=pg_catalog,public as $$
declare o jsonb; n jsonb; types text[]; label text; line text; before_value text; after_value text; status_change jsonb; op text;
begin
 changes:=public.hpbot_notification_projection(changes);
 if jsonb_array_length(changes)=0 then return '';end if;
 o:=changes->0->'old';n:=changes->0->'new';
 select array_agg(distinct c->>'type') into types from jsonb_array_elements(changes)c;
 label:=case when cardinality(types)>1 then '일정 변경' else case types[1]
  when 'NEW' then '신규 도선 등록' when 'CANCELLED' then '취소' when 'COMPLETED' then '완료'
  when 'PILOT_DATETIME_CHANGED' then '시간 변경' when 'ROUTE_CHANGED' then '구간 변경'
  when 'REMARK_CHANGED' then '비고 변경' when 'OPERATIONAL_STATUS_CHANGED' then '상태 변경' end end;
 line:=coalesce(n->>'vessel_name',o->>'vessel_name','선박 미확인')||' — '||label;
 if n->>'display_sequence' is not null then line:=line||chr(10)||'현재 순번: '||(n->>'display_sequence')||'번';end if;
 before_value:=public.pilot_date_label(o->>'pilot_date',o->>'pilot_time');after_value:=public.pilot_date_label(n->>'pilot_date',n->>'pilot_time');
 line:=line||chr(10)||'일시: '||case when 'PILOT_DATETIME_CHANGED'=any(types) then before_value||' → ' else '' end||after_value;
 before_value:=public.pilot_display_value(o->>'from_location')||' → '||public.pilot_display_value(o->>'to_location');
 after_value:=public.pilot_display_value(n->>'from_location')||' → '||public.pilot_display_value(n->>'to_location');
 line:=line||chr(10)||'구간: '||case when 'ROUTE_CHANGED'=any(types) then before_value||' ⇒ ' else '' end||after_value;
 if nullif(btrim(n->>'mooring_name'),'') is not null then line:=line||chr(10)||'강취: '||(n->>'mooring_name');end if;
 if 'REMARK_CHANGED'=any(types) then
  line:=line||chr(10)||'비고: '||public.pilot_display_value(public.pilot_remark_normalize(o->>'remarks'))||' → '||public.pilot_display_value(public.pilot_remark_normalize(n->>'remarks'));
 elsif types && array['PILOT_DATETIME_CHANGED','NEW','CANCELLED','COMPLETED'] and nullif(public.pilot_remark_normalize(n->>'remarks'),'') is not null then
  line:=line||chr(10)||'비고: '||public.pilot_remark_normalize(n->>'remarks');
 end if;
 select c into status_change from jsonb_array_elements(changes)c where c->>'type'='OPERATIONAL_STATUS_CHANGED' limit 1;
 if status_change is not null then
  line:=line||chr(10)||'상태: '||public.pilot_operational_label(status_change->>'operational_old')||' → '||public.pilot_operational_label(status_change->>'operational_new',true);
 end if;
 op:=public.pilot_operational_status(n);
 if op in('PROCESSING','POB') then line:=line||chr(10)||'공개: '||op;end if;
 return line;
end $$;

create function public.pilot_notification_parts(p_header text,p_body text) returns text[]
language plpgsql immutable set search_path=pg_catalog,public as $$
declare parts text[]:='{}'; total int:=ceil(char_length(p_body)/1700.0)::int;i int;
begin
 for i in 1..total loop
  parts:=array_append(parts,p_header||case when total>1 then ' ('||i||'/'||total||')' else '' end||chr(10)||substr(p_body,(i-1)*1700+1,1700));
 end loop;
 return parts;
end $$;
create or replace function public.hpbot_schedule_messages(changes jsonb) returns text[]
language plpgsql immutable set search_path=pg_catalog,public as $$
declare g record; body text:='';block text;types text[];header text;op text;
begin
 changes:=public.hpbot_notification_projection(changes);
 for g in select jsonb_agg(c order by c->>'type') changes
  from jsonb_array_elements(public.hpbot_notification_projection(changes))c
  group by c#>>'{new,application_id}' order by c#>>'{new,application_id}' loop
  block:=public.hpbot_change_block(g.changes);
  if block<>'' then body:=body||case when body='' then '' else chr(10)||chr(10) end||block;end if;
 end loop;
 select array_agg(distinct c->>'type') into types from jsonb_array_elements(changes)c;
 if cardinality(types)=1 then
  header:=case types[1] when 'NEW' then '🆕 [신규 도선등록]' when 'CANCELLED' then '❌ [도선취소]'
   when 'COMPLETED' then '✅ [도선완료]' when 'PILOT_DATETIME_CHANGED' then '⏰ [도선시간 변경]'
   when 'ROUTE_CHANGED' then '🧭 [도선구간 변경]' when 'REMARK_CHANGED' then '📝 [비고 변경]'
   when 'OPERATIONAL_STATUS_CHANGED' then '🔄 [도선상태 변경]' end;
  if types[1]='OPERATIONAL_STATUS_CHANGED' and (select count(distinct c->>'operational_new') from jsonb_array_elements(changes)c)=1 then
   op:=changes->0->>'operational_new';
   header:=case op when 'PROCESSING' then '🔄 [PROCESSING]' when 'POB' then '🚢 [POB · 도선사 승선]' when 'BAD_WEATHER' then '⚠️ [BAD WEATHER]' else header end;
  end if;
 end if;
 return public.pilot_notification_parts(coalesce(header,'🔔 [도선일정 변경]'),body);
end $$;

-- Shared pure/stable message planning for commit and dry run. A real resume
-- consumes ONLY its matching application's allowed changes, never other jobs.
create function public.hpbot_notification_batches(changes jsonb,events jsonb,s jsonb,p_at timestamptz) returns jsonb
language plpgsql stable set search_path=pg_catalog,public as $$
declare visible jsonb:=public.hpbot_filter_notifications(changes);result jsonb:='[]';ev jsonb;g record;related jsonb;ids text[]:='{}';typ text;messages text[];body text;
begin
 for ev in select value from jsonb_array_elements(events) loop
  typ:=case when ev->>'type'='SUSPEND' then 'WEATHER_SUSPEND' else 'WEATHER_RESUME' end;
  if not public.hpbot_notification_setting(typ) then continue;end if;
  related:='[]';
  if typ='WEATHER_RESUME' and ev->>'method'='HYOPU_TRANSITION' then
   select coalesce(jsonb_agg(c),'[]') into related from jsonb_array_elements(visible)c where c#>>'{new,application_id}'=ev#>>'{vessel,application_id}';
  end if;
  if jsonb_array_length(related)>0 then
   ids:=array_append(ids,ev#>>'{vessel,application_id}');
   body:='재개 근거: 동일 일정 BAD WEATHER → PROCESSING'||chr(10)||public.hpbot_change_block(related)
    ||chr(10)||'중단 감지: '||public.pilot_kst_label((s->>'started_at')::timestamptz)
    ||chr(10)||'재개 감지: '||public.pilot_kst_label(p_at)||chr(10)||'※ 도선예보현황 자동감지 기준';
   messages:=public.pilot_notification_parts('🟢 [울산 도선재개 감지]',body);
  else messages:=array[public.pilot_weather_message(ev,s,p_at)];end if;
  result:=result||jsonb_build_array(jsonb_build_object('notification_type',typ,'application_id',ev#>>'{vessel,application_id}','messages',to_jsonb(messages)));
 end loop;
 for g in select c#>>'{new,application_id}' application_id,jsonb_agg(c order by c->>'type') changes
  from jsonb_array_elements(visible)c where not(c#>>'{new,application_id}'=any(ids)) group by c#>>'{new,application_id}' order by c#>>'{new,application_id}' loop
  result:=result||jsonb_build_array(jsonb_build_object('notification_type','SCHEDULE_CHANGE','application_id',g.application_id,'messages',to_jsonb(public.hpbot_schedule_messages(g.changes))));
 end loop;
 return result;
end $$;

create function public.hpbot_queue_notification_plan(changes jsonb,events jsonb,s jsonb,p_event uuid,p_run uuid,p_at timestamptz) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare canonical jsonb:=public.hpbot_notification_projection(changes);g record;r public.pilot_schedule_notification_events;diff jsonb;h text;rev bigint;b jsonb;m text;k text;base text;i int;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 for g in select c#>>'{new,application_id}' application_id,jsonb_agg(c order by c->>'type') changes
  from jsonb_array_elements(canonical)c group by c#>>'{new,application_id}' order by c#>>'{new,application_id}' loop
  if g.application_id is null then raise exception 'NOTIFICATION_APPLICATION_ID';end if;
  select * into r from public.pilot_schedule_notification_events where run_id=p_run and external_key='1002:'||g.application_id;
  if found then continue;end if;
  -- Hash only the authorized before/after values. Sequence, raw source status,
  -- administrative state, timestamps and parser metadata never enter it.
  select jsonb_agg(jsonb_build_object('type',c->>'type','old',case c->>'type'
    when 'PILOT_DATETIME_CHANGED' then jsonb_build_array(c#>>'{old,pilot_date}',c#>>'{old,pilot_time}')
    when 'ROUTE_CHANGED' then jsonb_build_array(c#>>'{old,from_location}',c#>>'{old,to_location}')
    when 'REMARK_CHANGED' then to_jsonb(public.pilot_remark_normalize(c#>>'{old,remarks}'))
    when 'OPERATIONAL_STATUS_CHANGED' then c->'operational_old' else 'null'::jsonb end,
   'new',case c->>'type'
    when 'PILOT_DATETIME_CHANGED' then jsonb_build_array(c#>>'{new,pilot_date}',c#>>'{new,pilot_time}')
    when 'ROUTE_CHANGED' then jsonb_build_array(c#>>'{new,from_location}',c#>>'{new,to_location}')
    when 'REMARK_CHANGED' then to_jsonb(public.pilot_remark_normalize(c#>>'{new,remarks}'))
    when 'OPERATIONAL_STATUS_CHANGED' then c->'operational_new' else to_jsonb(c->>'type') end) order by c->>'type') into diff
  from jsonb_array_elements(g.changes)c;
  h:=md5(diff::text);
  insert into public.pilot_schedule_notification_revisions values('1002:'||g.application_id,1)
   on conflict(external_key) do update set revision=pilot_schedule_notification_revisions.revision+1 returning revision into rev;
  insert into public.pilot_schedule_notification_events(external_key,revision,run_id,change_hash,changes,created_at)
   values('1002:'||g.application_id,rev,p_run,h,g.changes,p_at);
 end loop;
 for b in select value from jsonb_array_elements(public.hpbot_notification_batches(changes,events,s,p_at)) loop
  if b->>'notification_type'='SCHEDULE_CHANGE' then
   select * into strict r from public.pilot_schedule_notification_events where run_id=p_run and external_key='1002:'||(b->>'application_id');
   base:='pilot_change:'||r.external_key||':'||r.revision||':'||r.change_hash;
  else
   if p_event is null then raise exception 'NOTIFICATION_WEATHER_ID';end if;
   base:=case when b->>'notification_type'='WEATHER_SUSPEND' then 'weather_suspend:' else 'weather_resume:' end||p_event;
  end if;
  i:=0;
  for m in select value from jsonb_array_elements_text(b->'messages') loop
   k:=base||case when i=0 then '' else ':part:'||i end;
   perform public.pilot_queue(k,b->>'notification_type',case when b->>'notification_type'='SCHEDULE_CHANGE' then p_run::text else p_event::text end,m);
   update public.pilot_schedule_notification_events set notification_keys=array_append(notification_keys,k)
    where run_id=p_run and external_key='1002:'||(b->>'application_id') and not k=any(notification_keys);
   i:=i+1;
  end loop;
 end loop;
end $$;

-- Guarded edits avoid replacing unrelated live commit fences/operational logic.
do $$ declare def text;needle text;begin
 def:=replace(pg_get_functiondef('public.hpbot_commit(uuid,bigint,text,text,jsonb,jsonb,jsonb,text,date,bigint,timestamptz)'::regprocedure),chr(13),'');
 foreach needle in array array[
  'perform public.pilot_queue(''weather_suspend:''||eid,''WEATHER_SUSPEND'',eid::text,public.pilot_weather_message(ev,s,p_at));',
  'perform public.pilot_queue(''weather_resume:''||eid,''WEATHER_RESUME'',eid::text,public.pilot_weather_message(ev,s,p_at));'
 ] loop
  if position(needle in def)=0 then raise exception 'COMMIT_POLICY_WEATHER_CONTRACT';end if;
  def:=replace(def,needle,'null; -- queued atomically with schedule notification projection below');
 end loop;
 needle:=E' foreach msg in array public.hpbot_schedule_messages(public.hpbot_filter_notifications(plan->''changes'')) loop\n   perform public.pilot_queue(''hpbot_change:''||p_token||'':''||part,''SCHEDULE_CHANGE'',p_token::text,msg); part:=part+1;\n end loop;';
 if position(needle in def)=0 then raise exception 'COMMIT_POLICY_SCHEDULE_CONTRACT';end if;
 def:=replace(def,needle,' perform public.hpbot_queue_notification_plan(plan->''changes'',wp->''events'',s,eid,p_token,p_at);');
 execute def;
 def:=replace(pg_get_functiondef('public.hpbot_preview(jsonb,jsonb,jsonb,timestamptz)'::regprocedure),chr(13),'');
 needle:=E' messages:=public.hpbot_schedule_messages(public.hpbot_filter_notifications(plan->''changes''));\n for ev in select value from jsonb_array_elements(wp->''events'') loop messages:=array_prepend(public.pilot_weather_message(ev,wp->''state'',p_at),messages); end loop;';
 if position(needle in def)=0 then raise exception 'PREVIEW_POLICY_CONTRACT';end if;
 def:=replace(def,needle,E' select coalesce(array_agg(m.value order by b.ord,m.ord),''{}'') into messages\n from jsonb_array_elements(public.hpbot_notification_batches(plan->''changes'',wp->''events'',wp->''state'',p_at)) with ordinality b(value,ord)\n cross join lateral jsonb_array_elements_text(b.value->''messages'') with ordinality m(value,ord);');
 execute def;
end $$;

-- Preserve existing JSTT/other setting handlers and their authorization path.
alter function public.hpbot_toggle_setting(bigint,text) rename to hpbot_toggle_setting_before_policy;
create function public.hpbot_toggle_setting(p_update bigint,p_setting text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.pilot_telegram_updates;v boolean;
begin
 if p_setting<>'REMARK_CHANGED' then return public.hpbot_toggle_setting_before_policy(p_update,p_setting);end if;
 select * into u from public.pilot_telegram_updates where update_id=p_update and status='RECEIVED';
 if not found then raise exception 'SETTING_INVALID';end if;
 select not coalesce((settings->>p_setting)::boolean,true) into v from public.pilot_telegram_chats where chat_id=u.chat_id for update;
 update public.pilot_telegram_chats set settings=settings||jsonb_build_object(p_setting,v),updated_at=now() where chat_id=u.chat_id;
 return v;
end $$;

alter function public.pilot_cleanup(timestamptz) rename to pilot_cleanup_before_notification_policy;
create function public.pilot_cleanup(p_at timestamptz default now()) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform public.pilot_cleanup_before_notification_policy(p_at);
 -- Keep compact monotonic revision counters; detailed evidence follows history retention.
 delete from public.pilot_schedule_notification_events where created_at<p_at-interval '365 days';
end $$;

-- Re-evaluate only legacy UNSENT groups. Never replay sent/unknown deliveries.
-- Keep suppressed rows as audit receipts instead of deleting notification history.
do $$ declare g record;changes jsonb;messages text[];n record;i int;cont boolean;begin
 perform 1 from public.pilot_watcher_control where id for update;
 for g in select reference_id,min(created_at) created_at from public.pilot_notifications
  where notification_type='SCHEDULE_CHANGE' and notification_key like 'hpbot_change:%' and status='PENDING' group by reference_id loop
  if exists(select 1 from public.pilot_notifications where reference_id=g.reference_id and notification_type='SCHEDULE_CHANGE' and (status<>'PENDING' or attempts>0)) then
   update public.pilot_notifications set status='FAILED',error='POLICY_REVIEW_PARTIAL_DELIVERY' where reference_id=g.reference_id and notification_type='SCHEDULE_CHANGE' and status='PENDING';continue;
  end if;
  select exists(select 1 from public.pilot_runs cur join lateral (select * from public.pilot_runs p where p.started_at<cur.started_at order by p.started_at desc limit 1) prev on true
   where cur.id::text=g.reference_id and prev.success and cur.started_at-prev.started_at<=interval '90 seconds'
   and date_trunc('minute',cur.slot) in(date_trunc('minute',prev.slot),date_trunc('minute',prev.slot)+interval '1 minute')) into cont;
  select coalesce(jsonb_agg(jsonb_build_object('type',event_type,'old',old_data,'new',new_data,'operational_continuous',cont) order by id),'[]') into changes
   from public.hpbot_pilot_history where run_id::text=g.reference_id;
  messages:=public.hpbot_schedule_messages(public.hpbot_filter_notifications(changes));i:=1;
  for n in select id from public.pilot_notifications where reference_id=g.reference_id and notification_type='SCHEDULE_CHANGE' and status='PENDING' order by created_at,notification_key for update loop
   if i<=cardinality(messages) then update public.pilot_notifications set message=messages[i] where id=n.id;
   else update public.pilot_notifications set status='FAILED',error='NOTIFICATION_POLICY_SUPPRESSED' where id=n.id;end if;
   i:=i+1;
  end loop;
  while i<=cardinality(messages) loop
   perform public.pilot_queue('policy_pending:'||g.reference_id||':'||i,'SCHEDULE_CHANGE',g.reference_id,messages[i]);i:=i+1;
  end loop;
 end loop;
end $$;

do $$ declare t text;f record;begin
 foreach t in array array['pilot_schedule_notification_revisions','pilot_schedule_notification_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
 for f in select p.oid::regprocedure name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in(
  'pilot_remark_normalize','pilot_operational_status','pilot_operational_label','hpbot_plan','hpbot_plan_before_notification_policy',
  'hpbot_notification_projection','hpbot_notification_setting','hpbot_filter_notifications','hpbot_change_block','pilot_notification_parts',
  'hpbot_schedule_messages','hpbot_notification_batches','hpbot_queue_notification_plan',
  'hpbot_toggle_setting','hpbot_toggle_setting_before_policy','pilot_cleanup','pilot_cleanup_before_notification_policy') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.name);execute format('grant execute on function %s to service_role',f.name);
 end loop;
end $$;
commit;
