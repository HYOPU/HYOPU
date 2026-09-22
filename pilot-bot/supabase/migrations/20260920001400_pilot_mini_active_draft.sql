begin;
-- Starting a replacement draft cancels its expired predecessor in the same
-- transaction, so updated_at alone is tied. Resume active work deterministically.
-- Budget settlement wraps this function and is left unchanged.
create or replace function public.pilot_mini_open_before_budget(p_chat text,p_user bigint,p_id uuid default null,p_bytes int default 131072) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.pilot_registration_requests; n int;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 if p_user<=0 or p_bytes not in(131072,262144) or not exists(select 1 from public.pilot_telegram_chats where chat_id=p_chat and enabled) then return jsonb_build_object('error','MINI_ROOM'); end if;
 insert into public.pilot_miniapp_limits values(p_chat,p_user,date_trunc('minute',now()),1)
 on conflict(chat_id,user_id) do update set minute=excluded.minute,
 requests=case when pilot_miniapp_limits.minute=excluded.minute then pilot_miniapp_limits.requests+1 else 1 end returning requests into n;
 if n>30 then return jsonb_build_object('error','MINI_RATE_LIMIT'); end if;
 if not public.pilot_reserve(p_bytes) then return jsonb_build_object('error','MINI_BUDGET'); end if;
 select * into r from public.pilot_registration_requests where telegram_chat_id=p_chat and telegram_user_id=p_user
 and transport='miniapp' and (p_id is null or id=p_id)
 order by (status in('CONFIRMED','SUBMITTING','VERIFYING','UNKNOWN')) desc,
   (status='DRAFT' and expires_at>now()) desc,updated_at desc,created_at desc,id desc limit 1;
 if r.id is null then return '{}'::jsonb; end if;
 return jsonb_build_object('id',r.id,'revision',r.revision,'status',r.status,'action',r.action,
 'sealed_data',r.sealed_data,'expired',r.expires_at<=now(),'application_id',r.application_id,'error_code',r.error_code);
end $$;
revoke all on function public.pilot_mini_open_before_budget(text,bigint,uuid,int) from public,anon,authenticated;
grant execute on function public.pilot_mini_open_before_budget(text,bigint,uuid,int) to service_role;
commit;
