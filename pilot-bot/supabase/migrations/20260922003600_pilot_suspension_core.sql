begin;
-- Extend the existing global incident, never start a replacement incident on
-- deployment. Source matching, delivery keys and account-write fences remain.
create function public.pilot_status_canonical(v text) returns text
language sql immutable set search_path=pg_catalog,public as $$
 select case s when 'BAD WEATHER' then 'BAD_WEATHER' when 'DENSE FOG' then 'DENSE_FOG'
  when 'PORT CLOSE' then 'PORT_CLOSE' else s end
 from (select upper(btrim(regexp_replace(replace(v,chr(160),' '),'[[:space:]]+',' ','g'))) s) t
$$;
create function public.pilot_is_suspension(v text) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(public.pilot_status_canonical(v) in('BAD_WEATHER','DENSE_FOG','PORT_CLOSE'),false)
$$;
create function public.pilot_canonical_rows(p_rows jsonb,p_field text default 'status') returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(case when r ? p_field then r||jsonb_build_object(p_field,public.pilot_status_canonical(r->>p_field)) else r end order by ord),'[]')
 from jsonb_array_elements(p_rows) with ordinality t(r,ord)
$$;
create function public.pilot_suspension_counts(p_rows jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 -- One ship, one representative reason even when both days/movements are in
 -- the feed. Exact callsign is primary; only absent callsign falls back to name.
 with candidates as (
  select coalesce(nullif(upper(btrim(regexp_replace(r->>'callsign','[[:space:]]+',' ','g'))),''),
   nullif(upper(btrim(regexp_replace(r->>'vessel_name','[[:space:]]+',' ','g'))),'')) vessel_key,
   public.pilot_status_canonical(r->>'status') status
  from jsonb_array_elements(p_rows) r
  where not coalesce((r->>'cancelled')::boolean,false) and public.pilot_is_suspension(r->>'status')
 ), ships as (
  select distinct on(vessel_key) vessel_key,status from candidates where vessel_key is not null
  order by vessel_key,case status when 'PORT_CLOSE' then 1 when 'DENSE_FOG' then 2 else 3 end
 ), counts as (
  select count(*) filter(where status='BAD_WEATHER')::int bad,
   count(*) filter(where status='DENSE_FOG')::int fog,
   count(*) filter(where status='PORT_CLOSE')::int closed,count(*)::int total from ships
 ) select jsonb_build_object('bad_weather_count',bad,'dense_fog_count',fog,'port_close_count',closed,
   'suspension_total_count',total,'suspension_reasons',to_jsonb(array_remove(array[
    case when closed>0 then 'PORT_CLOSE' end,case when fog>0 then 'DENSE_FOG' end,case when bad>0 then 'BAD_WEATHER' end],null))) from counts
$$;

alter table public.pilot_weather_state
 add column dense_fog_count int not null default 0 check(dense_fog_count>=0),
 add column port_close_count int not null default 0 check(port_close_count>=0),
 add column suspension_total_count int not null default 0 check(suspension_total_count>=0),
 add column suspension_reasons jsonb not null default '[]' check(jsonb_typeof(suspension_reasons)='array');
-- NULL on historical observations means the three-status contract was not yet
-- measured. Do not invent zero counts for old logs or old completed incidents.
alter table public.pilot_monitor_logs add column dense_fog_count int check(dense_fog_count>=0),
 add column port_close_count int check(port_close_count>=0),
 add column suspension_total_count int check(suspension_total_count>=0),add column suspension_reasons jsonb;
alter table public.pilot_runs add column bad_weather_count int check(bad_weather_count>=0),
 add column dense_fog_count int check(dense_fog_count>=0),add column port_close_count int check(port_close_count>=0),
 add column suspension_total_count int check(suspension_total_count>=0),add column suspension_reasons jsonb;
alter table public.pilot_weather_events add column bad_weather_count int check(bad_weather_count>=0),
 add column dense_fog_count int check(dense_fog_count>=0),add column port_close_count int check(port_close_count>=0),
 add column suspension_total_count int check(suspension_total_count>=0),add column suspension_reasons jsonb,
 add column max_dense_fog_count int check(max_dense_fog_count>=0),add column max_port_close_count int check(max_port_close_count>=0),
 add column max_suspension_total_count int check(max_suspension_total_count>=0),
 add column initial_suspension_counts jsonb,add column resume_previous_status text;

alter table public.pilot_history drop constraint pilot_history_event_type_check;
alter table public.pilot_history add constraint pilot_history_event_type_check check(event_type in
 ('NEW','TIME_CHANGED','ROUTE_CHANGED','STATUS_CHANGED','REMARK_CHANGED','CANCELLED','BAD_WEATHER_TO_PROCESSING',
 'SUSPENSION_TO_PROCESSING','PILOT_ENTERED_BAD_WEATHER','PILOT_ENTERED_DENSE_FOG','PILOT_ENTERED_PORT_CLOSE'));
alter table public.hpbot_pilot_history drop constraint hpbot_pilot_history_event_type_check;
alter table public.hpbot_pilot_history add constraint hpbot_pilot_history_event_type_check check(event_type in
 ('NEW','TIME_CHANGED','ROUTE_CHANGED','STATUS_CHANGED','REMARK_CHANGED','CANCELLED','COMPLETED','BAD_WEATHER_TO_PROCESSING',
 'SUSPENSION_TO_PROCESSING','PILOT_ENTERED_BAD_WEATHER','PILOT_ENTERED_DENSE_FOG','PILOT_ENTERED_PORT_CLOSE'));

-- Normalize both sides before the existing matching/POB/ranking/notification
-- wrapper chain. Old "DENSE FOG" snapshots are not new semantic transitions.
alter function public.hpbot_plan(jsonb,jsonb,jsonb,jsonb,boolean,boolean,timestamptz) rename to hpbot_plan_before_suspension_statuses;
create function public.hpbot_plan(p_old jsonb,p_apps jsonb,p_forecast jsonb,p_ranges jsonb,p_continuous boolean,p_baseline boolean,p_at timestamptz)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
begin
 return public.hpbot_plan_before_suspension_statuses(
  public.pilot_canonical_rows(p_old,'forecast_status'),p_apps,public.pilot_canonical_rows(p_forecast),
  p_ranges,p_continuous,p_baseline,p_at);
end $$;

create or replace function public.pilot_plan(p_old jsonb,p_rows jsonb,p_state jsonb,p_continuous boolean,p_at timestamptz)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare
 r jsonb;o jsonb;x jsonb;s jsonb:=p_state;mapped jsonb:='[]';changes jsonb:='[]';
 resumes jsonb:='[]';events jsonb:='[]';n int;old_n int;cur_n int;k text;typ text;
 strict_match boolean;unambiguous boolean;candidate int;rearm int;recovery timestamptz;counts jsonb;
begin
 p_old:=public.pilot_canonical_rows(p_old);p_rows:=public.pilot_canonical_rows(p_rows);
 for r in select value from jsonb_array_elements(p_rows) loop
  o:=null;strict_match:=false;
  select count(*) into cur_n from jsonb_array_elements(p_rows)a where a->>'identity'=r->>'identity';
  select count(*) into old_n from jsonb_array_elements(p_old)a where a->>'identity'=r->>'identity';
  unambiguous:=cur_n=1 and coalesce(r->>'callsign','')<>'';
  if unambiguous and old_n=1 then
   select value into o from jsonb_array_elements(p_old) where value->>'identity'=r->>'identity';
   strict_match:=coalesce((o->>'unambiguous')::boolean,false);
  elsif unambiguous and old_n=0 then
   select count(*) into old_n from jsonb_array_elements(p_old)a where a->>'callsign'=r->>'callsign' and a->>'vessel_name'=r->>'vessel_name' and a->>'pilot_date'=r->>'pilot_date' and a->>'agent'=r->>'agent';
   select count(*) into n from jsonb_array_elements(p_rows)a where a->>'callsign'=r->>'callsign' and a->>'vessel_name'=r->>'vessel_name' and a->>'pilot_date'=r->>'pilot_date' and a->>'agent'=r->>'agent';
   if old_n=1 and n=1 then
    select value into o from jsonb_array_elements(p_old)a where a->>'callsign'=r->>'callsign' and a->>'vessel_name'=r->>'vessel_name' and a->>'pilot_date'=r->>'pilot_date' and a->>'agent'=r->>'agent'
     and (a->>'from_location'=r->>'from_location' or a->>'to_location'=r->>'to_location');
   end if;
  end if;
  k:=coalesce(o->>'external_key',r->>'identity');
  r:=r||jsonb_build_object('external_key',k,'unambiguous',unambiguous);
  mapped:=mapped||jsonb_build_array(r);
  if not p_continuous or not unambiguous or r->>'agent'<>'협운' or jsonb_array_length(p_old)=0 then continue;end if;
  if o is null then
   if not (r->>'cancelled')::boolean then changes:=changes||jsonb_build_array(jsonb_build_object('type','NEW','key',k,'old',null,'new',r));end if;
  else
   for typ in select unnest(array['TIME_CHANGED','ROUTE_CHANGED','STATUS_CHANGED','REMARK_CHANGED']) loop
    if (typ='TIME_CHANGED' and o->>'pilot_time' is distinct from r->>'pilot_time') or
     (typ='ROUTE_CHANGED' and (o->>'from_location' is distinct from r->>'from_location' or o->>'to_location' is distinct from r->>'to_location')) or
     (typ='STATUS_CHANGED' and o->>'status' is distinct from r->>'status') or
     (typ='REMARK_CHANGED' and o->>'remarks' is distinct from r->>'remarks') then
     changes:=changes||jsonb_build_array(jsonb_build_object('type',case when typ='STATUS_CHANGED' and (r->>'cancelled')::boolean then 'CANCELLED' else typ end,'key',k,'old',o,'new',r));
    end if;
   end loop;
   if p_continuous and strict_match and o->>'agent'='협운' and public.pilot_is_suspension(o->>'status')
    and r->>'status'='PROCESSING' and not (o->>'cancelled')::boolean and not (r->>'cancelled')::boolean then
    resumes:=resumes||jsonb_build_array(r||jsonb_build_object('previous_status',o->>'status'));
    changes:=changes||jsonb_build_array(jsonb_build_object('type',case when o->>'status'='BAD_WEATHER' then 'BAD_WEATHER_TO_PROCESSING' else 'SUSPENSION_TO_PROCESSING' end,'key',k,'old',o,'new',r));
   end if;
  end if;
 end loop;
 counts:=public.pilot_suspension_counts(p_rows);n:=(counts->>'suspension_total_count')::int;
 candidate:=case when p_continuous then coalesce((s->>'candidate_count')::int,0) else 0 end;
 rearm:=case when p_continuous then coalesce((s->>'rearm_count')::int,0) else 0 end;
 recovery:=case when p_continuous then (s->>'recovery_started_at')::timestamptz else null end;
 if s->>'status'='NORMAL' then
  candidate:=case when n>=2 then candidate+1 else 0 end;
  if candidate>=2 then
   s:=s||jsonb_build_object('status','SUSPENDED','started_at',p_at,'resumed_at',null,'resume_alert_sent',false);
   events:=jsonb_build_array(jsonb_build_object('type','SUSPEND'));candidate:=0;
  end if;
 elsif s->>'status'='SUSPENDED' then
  if n=0 then recovery:=coalesce(recovery,p_at);else recovery:=null;end if;
  if jsonb_array_length(resumes)>0 or (recovery is not null and p_at-recovery>=interval '30 minutes') then
   s:=s||jsonb_build_object('status','RESUMED','resumed_at',p_at);
   events:=jsonb_build_array(jsonb_build_object('type','RESUME','method',case when jsonb_array_length(resumes)>0 then 'HYOPU_TRANSITION' else 'ZERO_30_MINUTES' end,
    'vessel',resumes->0,'previous_status',resumes#>>'{0,previous_status}'));
   rearm:=0;recovery:=null;
  end if;
 elsif s->>'status'='RESUMED' then
  rearm:=case when n<2 then rearm+1 else 0 end;
  if rearm>=2 then s:=s||jsonb_build_object('status','NORMAL','event_id',null);rearm:=0;candidate:=0;end if;
 end if;
 s:=s||counts||jsonb_build_object('candidate_count',candidate,'rearm_count',rearm,'recovery_started_at',recovery,'last_seen_at',p_at,'updated_at',p_at);
 return jsonb_build_object('state',s,'rows',mapped,'changes',changes,'resumes',resumes,'events',events);
end $$;

create function public.pilot_sync_suspension_metadata(s jsonb,p_event uuid,p_events jsonb,p_run uuid) returns void
language plpgsql set search_path=pg_catalog,public as $$
declare counts jsonb:=jsonb_build_object('bad_weather_count',s->'bad_weather_count','dense_fog_count',s->'dense_fog_count',
 'port_close_count',s->'port_close_count','suspension_total_count',s->'suspension_total_count','suspension_reasons',s->'suspension_reasons');
begin
 update public.pilot_weather_state set dense_fog_count=(s->>'dense_fog_count')::int,port_close_count=(s->>'port_close_count')::int,
  suspension_total_count=(s->>'suspension_total_count')::int,suspension_reasons=s->'suspension_reasons' where id;
 if p_event is not null then
  update public.pilot_weather_events set bad_weather_count=(s->>'bad_weather_count')::int,dense_fog_count=(s->>'dense_fog_count')::int,
   port_close_count=(s->>'port_close_count')::int,suspension_total_count=(s->>'suspension_total_count')::int,suspension_reasons=s->'suspension_reasons',
   max_dense_fog_count=greatest(coalesce(max_dense_fog_count,0),(s->>'dense_fog_count')::int),
   max_port_close_count=greatest(coalesce(max_port_close_count,0),(s->>'port_close_count')::int),
   max_suspension_total_count=greatest(coalesce(max_suspension_total_count,max_bad_weather_count,0),(s->>'suspension_total_count')::int),
   initial_suspension_counts=case when exists(select 1 from jsonb_array_elements(p_events)e where e->>'type'='SUSPEND') then counts else initial_suspension_counts end,
   resume_previous_status=coalesce((select e->>'previous_status' from jsonb_array_elements(p_events)e where e->>'type'='RESUME' and e->>'method'='HYOPU_TRANSITION' limit 1),resume_previous_status)
   where id=p_event;
 end if;
 update public.pilot_runs set bad_weather_count=(s->>'bad_weather_count')::int,dense_fog_count=(s->>'dense_fog_count')::int,
  port_close_count=(s->>'port_close_count')::int,suspension_total_count=(s->>'suspension_total_count')::int,suspension_reasons=s->'suspension_reasons' where id=p_run;
 update public.pilot_monitor_logs set dense_fog_count=(s->>'dense_fog_count')::int,port_close_count=(s->>'port_close_count')::int,
  suspension_total_count=(s->>'suspension_total_count')::int,suspension_reasons=s->'suspension_reasons' where id=p_run;
end $$;

-- Change only the metadata tail of both established commit paths. This preserves
-- live writer fences, budget settlement, outbox merging and same-minute guards.
do $$ declare def text;needle text;begin
 def:=replace(pg_get_functiondef('public.hpbot_commit(uuid,bigint,text,text,jsonb,jsonb,jsonb,text,date,bigint,timestamptz)'::regprocedure),chr(13),'');
 needle:=' return jsonb_build_object(''accepted'',true,''active''';
 if position(needle in def)=0 then raise exception 'SUSPENSION_DUAL_COMMIT_CONTRACT';end if;
 def:=replace(def,needle,' perform public.pilot_sync_suspension_metadata(s,eid,wp->''events'',p_token);'||chr(10)||needle);
 needle:='   values(''1002:''||(ch#>>''{new,application_id}''),ch#>>''{new,vessel_name}'',ch->>''type'',ch->''old'',ch->''new'',p_at,p_token);';
 if position(needle in def)=0 then raise exception 'SUSPENSION_DUAL_HISTORY_CONTRACT';end if;
 def:=replace(def,needle,needle||E'\n   insert into public.hpbot_pilot_history(external_key,vessel_name,event_type,old_data,new_data,detected_at,run_id)\n   select ''1002:''||(ch#>>''{new,application_id}''),ch#>>''{new,vessel_name}'',''PILOT_ENTERED_''||(p->>''operational_new''),ch->''old'',ch->''new'',p_at,p_token\n   from jsonb_array_elements(public.hpbot_notification_projection(jsonb_build_array(ch)))p\n   where p->>''type''=''OPERATIONAL_STATUS_CHANGED'' and public.pilot_is_suspension(p->>''operational_new'');');
 execute def;
 def:=replace(pg_get_functiondef('public.pilot_commit(uuid,bigint,text,jsonb,bigint,timestamptz)'::regprocedure),chr(13),'');
 needle:='  return jsonb_build_object(''accepted'',true,''state''';
 if position(needle in def)=0 then raise exception 'SUSPENSION_LEGACY_COMMIT_CONTRACT';end if;
 def:=replace(def,needle,'  perform public.pilot_sync_suspension_metadata(s,eid,plan->''events'',p_token);'||chr(10)||needle);
 needle:='    insert into public.pilot_history(external_key,vessel_name,event_type,old_data,new_data,detected_at) values(ch->>''key'',ch#>>''{new,vessel_name}'',ch->>''type'',ch->''old'',ch->''new'',p_at);';
 if position(needle in def)=0 then raise exception 'SUSPENSION_LEGACY_HISTORY_CONTRACT';end if;
 def:=replace(def,needle,needle||E'\n    if ch->>''type''=''STATUS_CHANGED'' and public.pilot_is_suspension(ch#>>''{new,status}'') then\n     insert into public.pilot_history(external_key,vessel_name,event_type,old_data,new_data,detected_at) values(ch->>''key'',ch#>>''{new,vessel_name}'',''PILOT_ENTERED_''||(ch#>>''{new,status}''),ch->''old'',ch->''new'',p_at);\n    end if;');
 execute def;
 -- Legacy formatters must not emit the new direct-resume marker as a second
 -- generic schedule alert. Their strict transition has already been handled.
 def:=replace(pg_get_functiondef('public.pilot_schedule_messages(jsonb,jsonb)'::regprocedure),chr(13),'');
 needle:='ch->>''type''=''BAD_WEATHER_TO_PROCESSING''';
 if position(needle in def)=0 then raise exception 'SUSPENSION_LEGACY_MESSAGE_CONTRACT';end if;
 def:=replace(def,needle,'ch->>''type'' in(''BAD_WEATHER_TO_PROCESSING'',''SUSPENSION_TO_PROCESSING'')');
 def:=replace(def,'ch#>>''{old,status}''=''BAD_WEATHER''','public.pilot_is_suspension(ch#>>''{old,status}'')');
 execute def;
end $$;

-- Read-only previews retain old keys and add the measured contract. The pure
-- reducer is shared with commit; wrappers do not reserve, mutate or send.
alter function public.hpbot_preview(jsonb,jsonb,jsonb,timestamptz) rename to hpbot_preview_before_suspension_statuses;
create function public.hpbot_preview(p_applications jsonb,p_forecast jsonb,p_ranges jsonb,p_at timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;counts jsonb;begin
 result:=public.hpbot_preview_before_suspension_statuses(p_applications,p_forecast,p_ranges,p_at);
 if result->'counts' is not null then
  counts:=public.pilot_suspension_counts(p_forecast);result:=jsonb_set(result,'{counts}',result->'counts'||counts);
 end if;return result;
end $$;
alter function public.pilot_preview(jsonb,timestamptz) rename to pilot_preview_before_suspension_statuses;
create function public.pilot_preview(p_rows jsonb,p_at timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;begin
 result:=public.pilot_preview_before_suspension_statuses(p_rows,p_at);
 if result->'counts' is not null then result:=jsonb_set(result,'{counts}',result->'counts'||public.pilot_suspension_counts(p_rows));end if;
 return result;
end $$;

-- One cutover fence: preserve active incident and all delivery receipts, but
-- never trust BAD-WEATHER-only low-count/zero-duration candidates for the new
-- three-status policy. Do not rebase records or generate deployment alerts.
do $$ declare counts jsonb;begin
 perform 1 from public.pilot_watcher_control where id for update;
 select public.pilot_suspension_counts(coalesce(s.rows,'[]')) into counts
 from public.pilot_watcher_control c left join public.pilot_snapshots s on s.id=c.snapshot_id where c.id;
 update public.pilot_weather_state set bad_weather_count=(counts->>'bad_weather_count')::int,
  dense_fog_count=(counts->>'dense_fog_count')::int,port_close_count=(counts->>'port_close_count')::int,
  suspension_total_count=(counts->>'suspension_total_count')::int,suspension_reasons=counts->'suspension_reasons',
  candidate_count=0,rearm_count=0,recovery_started_at=null where id;
 update public.pilot_watcher_control set continuous=false,version=version+1 where id;
end $$;

do $$ declare f record;begin
 for f in select p.oid::regprocedure name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in('pilot_status_canonical','pilot_is_suspension','pilot_canonical_rows','pilot_suspension_counts',
   'hpbot_plan','hpbot_plan_before_suspension_statuses','pilot_sync_suspension_metadata',
   'hpbot_preview','hpbot_preview_before_suspension_statuses','pilot_preview','pilot_preview_before_suspension_statuses') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.name);
  execute format('grant execute on function %s to service_role',f.name);
 end loop;
end $$;
commit;
