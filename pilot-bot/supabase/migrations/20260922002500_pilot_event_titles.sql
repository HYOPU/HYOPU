begin;
-- Display only. Preserve all source, transition and outbox logic.
do $$ declare def text;fn text;needle text;begin
 foreach fn in array array['public.pilot_weather_message(jsonb,jsonb,timestamptz)','public.pilot_weather_message_v1(jsonb,jsonb,timestamptz)'] loop
  def:=pg_get_functiondef(fn::regprocedure);
  def:=replace(replace(replace(def,'현재 협운 순번:','현재 순번:'),'(협운 동일 일정)','(동일 일정)'),
   '협운 BAD WEATHER → PROCESSING 전환','BAD WEATHER → PROCESSING 전환');
  execute def;
 end loop;
 -- These modules are optional in focused migration tests; present in production.
 if to_regprocedure('public.pilot_reg_finish(uuid,uuid,text,text,jsonb,text)') is not null then
  def:=pg_get_functiondef('public.pilot_reg_finish(uuid,uuid,text,text,jsonb,text)'::regprocedure);
  execute replace(def,'현재 협운 순번:','현재 순번:');
 end if;
 if to_regprocedure('public.jstt_queue_events(jsonb,text,timestamptz)') is not null then
  def:=pg_get_functiondef('public.jstt_queue_events(jsonb,text,timestamptz)'::regprocedure);
  needle:=$old$(e->>'vessel_name')||' / '||(e->>'agency_name')||case when e->>'agency_name'<>'협운해운(주)' then ' · 지정선박' else '' end$old$;
  if position(needle in def)=0 then raise exception 'JSTT_AGENCY_DISPLAY_CONTRACT';end if;
  execute replace(def,needle,$new$(e->>'vessel_name')||case when e->>'agency_name'<>'협운해운(주)' then chr(10)||'대리점: '||(e->>'agency_name')||' · 지정선박' else '' end$new$);
 end if;
end $$;
commit;
