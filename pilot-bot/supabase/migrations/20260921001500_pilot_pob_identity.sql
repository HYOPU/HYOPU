begin;
-- Live authenticated list: GINGA TIGER POB has no edit link/no_forecast.
-- Resolve ONLY explicit POB, using the existing exact identity tuple and
-- bidirectional uniqueness. Never generate a new application ID, match only
-- by vessel, or interpret POB as completion. Unresolved evidence fails closed.
alter function public.hpbot_plan(jsonb,jsonb,jsonb,jsonb,boolean,boolean,timestamptz) rename to hpbot_plan_v3;
create function public.hpbot_plan(p_old jsonb,p_apps jsonb,p_forecast jsonb,p_ranges jsonb,p_continuous boolean,p_baseline boolean,p_at timestamptz)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare resolved jsonb:='[]'; r jsonb; o jsonb; k text; old_count int; source_count int;
begin
 if jsonb_typeof(p_apps)<>'array' or jsonb_typeof(p_old)<>'array' then raise exception 'SOURCE_SHAPE'; end if;
 for r in select value from jsonb_array_elements(p_apps) loop
  if r->>'application_id' is null and r->>'application_status'='040' then
   if r->>'agent' is distinct from '협운' or exists (
    select 1 from unnest(array['callsign','vessel_name','pilot_date','from_location','to_location']) f
    where nullif(btrim(r->>f),'') is null
   ) then raise exception 'POB_IDENTITY_INVALID'; end if;
   k:=public.hpbot_match_key(r);
   select count(*),jsonb_agg(a)->0 into old_count,o from jsonb_array_elements(p_old) a
    where public.hpbot_match_key(a)=k;
   select count(*) into source_count from jsonb_array_elements(p_apps) a
    where public.hpbot_match_key(a)=k;
   if old_count<>1 or source_count<>1 then raise exception 'POB_IDENTITY_UNRESOLVED'; end if;
   if o->>'application_id' is null or o->>'application_id' !~ '^[0-9]{1,30}$'
    or o->>'agent' is distinct from '협운'
    or public.hpbot_lifecycle(o->>'application_status')<>'ACTIVE'
    or exists(select 1 from jsonb_array_elements(p_apps) a where a->>'application_id'=o->>'application_id')
   then raise exception 'POB_IDENTITY_UNRESOLVED'; end if;
   r:=r||jsonb_build_object('application_id',o->>'application_id',
    'application_identity_basis','POB_UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE');
  end if;
  resolved:=resolved||jsonb_build_array(r);
 end loop;
 -- The existing reducer retains all notification dedupe, status settings,
 -- sequence rules, and the continuity gate for weather recovery.
 return public.hpbot_plan_v3(p_old,resolved,p_forecast,p_ranges,p_continuous,p_baseline,p_at);
end $$;
revoke all on function public.hpbot_plan(jsonb,jsonb,jsonb,jsonb,boolean,boolean,timestamptz) from public,anon,authenticated;
revoke all on function public.hpbot_plan_v3(jsonb,jsonb,jsonb,jsonb,boolean,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.hpbot_plan(jsonb,jsonb,jsonb,jsonb,boolean,boolean,timestamptz) to service_role;
grant execute on function public.hpbot_plan_v3(jsonb,jsonb,jsonb,jsonb,boolean,boolean,timestamptz) to service_role;
commit;
