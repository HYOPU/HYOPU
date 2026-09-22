begin;
-- Service-only one-time installation, fixed destinations, never return secrets.
create function public.hpbot_provision_vault(p_key text,p_gateway text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare entry record;
begin
 if not exists(select 1 from public.hpbot_control where id) or length(p_key)<32 or length(p_key)>256
 or p_gateway !~ '^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then raise exception 'PROVISION_INVALID';end if;
 if exists(select 1 from vault.secrets where name in('ulsan_watcher_key','ulsan_watcher_url','ulsan_gateway_anon_jwt')) then raise exception 'PROVISION_EXISTS';end if;
 for entry in select * from (values
 ('ulsan_watcher_url','https://nhujqbqygnhbnvmfmodi.supabase.co/functions/v1/ulsan-pilot-watcher'),
 ('ulsan_watcher_key',p_key),('ulsan_gateway_anon_jwt',p_gateway)) v(name,value) loop
 perform vault.create_secret(entry.value,entry.name,'HYOPU pilot bot internal dispatcher');
 end loop;
end $$;
revoke all on function public.hpbot_provision_vault(text,text) from public,anon,authenticated;
grant execute on function public.hpbot_provision_vault(text,text) to service_role;
commit;
