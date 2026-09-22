begin;
-- Presentation-only window. Keep the complete operational queue and watcher intact.
create function public.hpbot_registration_status(p_page int default 0,p_at timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb; data jsonb; total int; first_day date:=(p_at at time zone 'Asia/Seoul')::date;
begin
 if p_page<0 or p_page>999 or p_at is null then raise exception 'QUERY_LIMIT'; end if;
 result:=public.hpbot_read('status');
 select count(*) into total from public.hpbot_pilot_queue q
 where q.pilot_date between first_day::text and (first_day+7)::text
 and coalesce(q.application_status,'') not in('050','060','090');
 select coalesce(jsonb_agg(to_jsonb(x) order by x.sequence_no),'[]') into data from (
  select q.sequence_no,q.application_id,q.vessel_name,q.pilot_date,q.pilot_time,q.from_location,q.to_location,
   q.application_status,q.forecast_status,q.forecast_time,q.is_overdue,q.needs_review,c.data->>'mooring_name' mooring_name
  from public.hpbot_pilot_queue q left join public.hpbot_pilot_current c on c.application_id=q.application_id
  where q.pilot_date between first_day::text and (first_day+7)::text
   and coalesce(q.application_status,'') not in('050','060','090')
  order by q.sequence_no offset p_page*10 limit 10
 ) x;
 return result||jsonb_build_object('rows',data,'total',total,'page',p_page,'date_from',first_day,'date_to',first_day+7);
end $$;
revoke all on function public.hpbot_registration_status(int,timestamptz) from public,anon,authenticated;
grant execute on function public.hpbot_registration_status(int,timestamptz) to service_role;
commit;
