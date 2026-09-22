begin;
-- Initial historical coverage is a baseline, not a newly submitted application.
-- Keep its source row/history and still notify real current/future changes.
alter function public.hpbot_filter_notifications(jsonb) rename to hpbot_filter_notifications_before_bootstrap;
create function public.hpbot_filter_notifications(changes jsonb) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(c order by ord),'[]')
 from jsonb_array_elements(public.hpbot_filter_notifications_before_bootstrap(changes)) with ordinality t(c,ord)
 where not (c->>'type'='NEW' and not (select bootstrap_done from public.hpbot_control where id)
  and c#>>'{new,pilot_date}'<((now() at time zone 'Asia/Seoul')::date-30)::text)
$$;
revoke all on function public.hpbot_filter_notifications(jsonb),public.hpbot_filter_notifications_before_bootstrap(jsonb) from public,anon,authenticated;
grant execute on function public.hpbot_filter_notifications(jsonb),public.hpbot_filter_notifications_before_bootstrap(jsonb) to service_role;
commit;
