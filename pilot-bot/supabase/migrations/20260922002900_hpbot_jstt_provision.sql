begin;
create or replace function public.hpbot_jstt_provision(p_key text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_key !~ '^[a-f0-9]{64}$' then raise exception 'KEY_INVALID'; end if;
 if exists(select 1 from vault.secrets where name in ('jstt_berth_url','jstt_berth_key')) then raise exception 'ALREADY_PROVISIONED'; end if;
 perform vault.create_secret('https://hyopu-ten.vercel.app/api/hpbot-jstt','jstt_berth_url');
 perform vault.create_secret(p_key,'jstt_berth_key');
end $$;
revoke all on function public.hpbot_jstt_provision(text) from public,anon,authenticated;
grant execute on function public.hpbot_jstt_provision(text) to service_role;
commit;
