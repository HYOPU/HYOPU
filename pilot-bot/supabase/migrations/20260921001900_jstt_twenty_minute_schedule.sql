begin;
-- Keep the existing pilot Cron every minute. Only JSTT's dispatcher is gated.
-- Manual refresh/watchlist addition retain the existing lease and 30s cooldown.
create function public.jstt_collection_due(p_manual boolean default false,p_at timestamptz default now())
returns boolean language sql stable set search_path=pg_catalog,public as $$
 select p_manual or mod(extract(minute from p_at at time zone 'Asia/Seoul')::integer,20)=0;
$$;
alter function public.jstt_dispatch(boolean) rename to jstt_dispatch_before_twenty_minutes;
create function public.jstt_dispatch(p_manual boolean default false) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if not public.jstt_collection_due(p_manual) then return 'NOT_DUE';end if;
 return public.jstt_dispatch_before_twenty_minutes(p_manual);
end $$;
revoke all on function public.jstt_collection_due(boolean,timestamptz),public.jstt_dispatch(boolean),public.jstt_dispatch_before_twenty_minutes(boolean) from public,anon,authenticated;
grant execute on function public.jstt_collection_due(boolean,timestamptz),public.jstt_dispatch(boolean),public.jstt_dispatch_before_twenty_minutes(boolean) to service_role;
commit;
