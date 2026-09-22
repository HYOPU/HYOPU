begin;
-- Presentation only. The semantic projection, source evidence, change revision,
-- settings, weather reducer and delivery state machine remain unchanged.
create function public.hpbot_notification_title(changes jsonb) returns text
language plpgsql immutable set search_path=pg_catalog,public as $$
declare types text[]; c jsonb;
begin
 changes:=public.hpbot_notification_projection(changes);
 if jsonb_array_length(changes)=0 then return '';end if;
 select array_agg(distinct value->>'type') into types from jsonb_array_elements(changes);
 if 'COMPLETED'=any(types) then return '✅ [도선완료]';end if;
 if 'CANCELLED'=any(types) then return '❌ [도선취소]';end if;
 if 'NEW'=any(types) then return '🆕 [신규 도선등록]';end if;
 -- Only actual transitions compete for the title. A persisted POB state must
 -- not take the title from a time-only edit.
 for c in select value from jsonb_array_elements(changes)
  where value->>'type'='OPERATIONAL_STATUS_CHANGED'
  order by case value->>'operational_new' when 'POB' then 1 when 'BAD_WEATHER' then 2 when 'PROCESSING' then 3 else 4 end
 loop
  if c->>'operational_new'='POB' then return '🚢 [POB · 도선사 승선]';end if;
  if c->>'operational_new'='BAD_WEATHER' then return '⚠️ [BAD WEATHER]';end if;
  if c->>'operational_new'='PROCESSING' then return '🔄 [PROCESSING]';end if;
 end loop;
 if 'PILOT_DATETIME_CHANGED'=any(types) then
  if exists(select 1 from jsonb_array_elements(changes) value where value->>'type'='PILOT_DATETIME_CHANGED'
   and value#>>'{old,pilot_date}' is distinct from value#>>'{new,pilot_date}') then
   return '📅 [도선일자 변경]';
  end if;
  return '⏰ [도선시간 변경]';
 end if;
 if 'ROUTE_CHANGED'=any(types) then return '🧭 [도선구간 변경]';end if;
 if 'REMARK_CHANGED'=any(types) then return '📝 [비고 변경]';end if;
 return '🔄 [도선상태 변경]';
end $$;

create or replace function public.hpbot_change_block(changes jsonb) returns text
language plpgsql immutable set search_path=pg_catalog,public as $$
declare o jsonb; n jsonb; types text[]; line text; before_value text; after_value text; status_change jsonb; op text; terminal boolean;
begin
 changes:=public.hpbot_notification_projection(changes);
 if jsonb_array_length(changes)=0 then return '';end if;
 o:=changes->0->'old';n:=changes->0->'new';
 select array_agg(distinct c->>'type') into types from jsonb_array_elements(changes)c;
 terminal:=types && array['COMPLETED','CANCELLED']
  or public.hpbot_lifecycle(n->>'application_status') in('COMPLETED','CANCELLED');
 line:=coalesce(n->>'vessel_name',o->>'vessel_name','선박 미확인');
 if not terminal and n->>'display_sequence' is not null then line:=line||chr(10)||'현재 순번: '||(n->>'display_sequence')||'번';end if;
 before_value:=public.pilot_date_label(o->>'pilot_date',o->>'pilot_time');after_value:=public.pilot_date_label(n->>'pilot_date',n->>'pilot_time');
 line:=line||chr(10)||'일시: '||case when 'PILOT_DATETIME_CHANGED'=any(types) then before_value||' → ' else '' end||after_value;
 before_value:=public.pilot_display_value(o->>'from_location')||' → '||public.pilot_display_value(o->>'to_location');
 after_value:=public.pilot_display_value(n->>'from_location')||' → '||public.pilot_display_value(n->>'to_location');
 line:=line||chr(10)||'구간: '||case when 'ROUTE_CHANGED'=any(types) then before_value||' ⇒ ' else '' end||after_value;
 if nullif(btrim(n->>'mooring_name'),'') is not null then line:=line||chr(10)||'강취: '||(n->>'mooring_name');end if;
 if 'REMARK_CHANGED'=any(types) then
  line:=line||chr(10)||'비고: '||public.pilot_display_value(public.pilot_remark_normalize(o->>'remarks'))||' → '||public.pilot_display_value(public.pilot_remark_normalize(n->>'remarks'));
 elsif nullif(public.pilot_remark_normalize(n->>'remarks'),'') is not null then
  line:=line||chr(10)||'비고: '||public.pilot_remark_normalize(n->>'remarks');
 end if;
 select c into status_change from jsonb_array_elements(changes)c where c->>'type'='OPERATIONAL_STATUS_CHANGED' limit 1;
 if not terminal and status_change is not null then
  line:=line||chr(10)||'상태: '||public.pilot_operational_label(status_change->>'operational_old')||' → '||public.pilot_operational_label(status_change->>'operational_new',true);
 end if;
 op:=public.pilot_operational_status(n);
 if not terminal and op in('PROCESSING','POB') then line:=line||chr(10)||'공개: '||op;end if;
 return line;
end $$;

create or replace function public.hpbot_schedule_messages(changes jsonb) returns text[]
language plpgsql immutable set search_path=pg_catalog,public as $$
declare g record; block text; result text[]:='{}';
begin
 changes:=public.hpbot_notification_projection(changes);
 -- The event heading belongs to one application, not a mixed polling batch.
 -- The existing queue already groups by application; keep direct/dry-run calls
 -- equally deterministic and never merge separate jobs sharing a vessel name.
 for g in select jsonb_agg(c order by c->>'type') changes
  from jsonb_array_elements(changes)c
  group by coalesce(c#>>'{new,application_id}',c#>>'{old,application_id}')
  order by coalesce(c#>>'{new,application_id}',c#>>'{old,application_id}') loop
  block:=public.hpbot_change_block(g.changes);
  if block<>'' then result:=result||public.pilot_notification_parts(public.hpbot_notification_title(g.changes),block);end if;
 end loop;
 return result;
end $$;

revoke all on function public.hpbot_notification_title(jsonb) from public,anon,authenticated;
grant execute on function public.hpbot_notification_title(jsonb) to service_role;
-- CREATE OR REPLACE preserves the existing service-only privileges on the two
-- formatters. No historical message or notification key is changed here.
commit;
