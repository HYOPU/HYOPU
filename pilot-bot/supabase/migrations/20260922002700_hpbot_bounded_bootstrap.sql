begin;
-- HYOPU historical years exceed the source request deadline. Read bounded months
-- without skipping coverage or treating unfinished responses as valid snapshots.
create or replace function public.hpbot_context() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare d public.hpbot_control; today date:=(now() at time zone 'Asia/Seoul')::date; old_dates jsonb; boot_end date;
begin
 select * into d from public.hpbot_control where id;
 select coalesce(jsonb_agg(pilot_date),'[]') into old_dates from (select distinct pilot_date from public.hpbot_pilot_current where completion_status not in('COMPLETED','CANCELLED') and pilot_date<(today-30)::text order by pilot_date limit 61) a;
 if jsonb_array_length(old_dates)>60 then raise exception 'OLD_RANGE_LIMIT'; end if;
 boot_end:=least(case when d.bootstrap_next<'2018-01-01' then date '2017-12-31' else (d.bootstrap_next+interval '1 month'-interval '1 day')::date end,today-31);
 return jsonb_build_object('application_hash',d.application_hash,'forecast_hash',d.forecast_hash,'sealed_session',d.sealed_session,
 'ranges',jsonb_build_array(jsonb_build_object('start',today-30,'end','9999-12-31')),'old_dates',old_dates,
 'bootstrap',case when d.bootstrap_done or d.bootstrap_next>today-31 then null else jsonb_build_object('start',d.bootstrap_next,'end',boot_end) end,
 'initialized',d.initialized,'paused',d.paused,'bootstrap_done',d.bootstrap_done);
end $$;
revoke all on function public.hpbot_context() from public,anon,authenticated;
grant execute on function public.hpbot_context() to service_role;
commit;
