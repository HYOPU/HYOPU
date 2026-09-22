begin;
-- Separate Mini App transport: never invent Telegram update IDs.
alter table public.pilot_registration_requests add column transport text not null default 'telegram'
 check(transport in ('telegram','miniapp'));
alter table public.pilot_registration_requests alter column last_update_id drop not null;
create table public.pilot_miniapp_limits (
 chat_id text not null, user_id bigint not null, minute timestamptz not null,
 requests int not null, primary key(chat_id,user_id)
);
alter table public.pilot_miniapp_limits enable row level security;
revoke all on public.pilot_miniapp_limits from public,anon,authenticated;

-- Caller is service-role only, after verified Telegram initData. Counts are bounded
-- per configured room/user; each call reserves before external member/source calls.
create function public.pilot_mini_open(p_chat text,p_user bigint,p_id uuid default null,p_bytes int default 131072) returns jsonb
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
 and transport='miniapp' and (p_id is null or id=p_id) order by updated_at desc limit 1;
 if r.id is null then return '{}'::jsonb; end if;
 return jsonb_build_object('id',r.id,'revision',r.revision,'status',r.status,'action',r.action,
 'sealed_data',r.sealed_data,'expired',r.expires_at<=now(),'application_id',r.application_id,'error_code',r.error_code);
end $$;

create function public.pilot_mini_save(p_chat text,p_user bigint,p_id uuid,p_revision int,p_action text,p_sealed text,p_original_hash text default null,p_application text default null) returns int
language plpgsql security definer set search_path=pg_catalog,public as $$
declare rev int;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 if not exists(select 1 from public.pilot_telegram_chats where chat_id=p_chat and enabled) or not (select enabled from public.pilot_watcher_control where id) then raise exception 'MINI_STOPPED'; end if;
 if p_user<=0 or p_action not in('CREATE','UPDATE') or octet_length(p_sealed)>30000 then raise exception 'MINI_INPUT'; end if;
 if p_revision=0 then
   -- Never silently replace an active chat Wizard or a different app draft.
   update public.pilot_registration_requests set status='CANCELLED',error_code='DRAFT_EXPIRED',updated_at=now()
   where telegram_chat_id=p_chat and telegram_user_id=p_user and status='DRAFT' and expires_at<=now();
   if exists(select 1 from public.pilot_registration_requests where telegram_chat_id=p_chat and telegram_user_id=p_user and status='DRAFT') then raise exception 'MINI_EXISTING_DRAFT'; end if;
   insert into public.pilot_registration_requests(id,action,telegram_chat_id,telegram_user_id,sealed_data,transport,original_hash,application_id)
   values(p_id,p_action,p_chat,p_user,p_sealed,'miniapp',p_original_hash,p_application);
   return 1;
 end if;
 update public.pilot_registration_requests set sealed_data=p_sealed,revision=revision+1,original_hash=p_original_hash,application_id=p_application,updated_at=now(),expires_at=now()+interval '20 minutes'
 where id=p_id and telegram_chat_id=p_chat and telegram_user_id=p_user and transport='miniapp' and action=p_action and status='DRAFT' and revision=p_revision and expires_at>now() returning revision into rev;
 if rev is null then raise exception 'MINI_STALE'; end if; return rev;
end $$;

create function public.pilot_mini_decide(p_chat text,p_user bigint,p_id uuid,p_revision int,p_action text) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.pilot_registration_requests; c public.pilot_registration_control;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 select * into r from public.pilot_registration_requests where id=p_id and transport='miniapp' and telegram_chat_id=p_chat and telegram_user_id=p_user for update;
 if r.id is null then return 'STALE'; end if;
 if r.status<>'DRAFT' then return r.status; end if;
 if r.revision<>p_revision or r.expires_at<=now() then return 'STALE'; end if;
 if p_action='CANCEL' then update public.pilot_registration_requests set status='CANCELLED',updated_at=now() where id=r.id;return 'CANCELLED';end if;
 if p_action<>'CONFIRM' then return 'STALE'; end if;
 if not exists(select 1 from public.pilot_telegram_chats where chat_id=p_chat and enabled) then return 'DISABLED'; end if;
 select * into c from public.pilot_registration_control where id;
 if not (case when r.action='CREATE' then c.create_enabled else c.update_enabled end) then return 'DISABLED'; end if;
 if not public.pilot_reserve(262144) then return 'BUDGET'; end if;
 update public.pilot_registration_requests set status='CONFIRMED',confirmed_at=now(),updated_at=now() where id=r.id;
 -- Existing cloud dispatcher + worker send only the final receipt, not inputs.
 return 'CONFIRMED';
end $$;
revoke all on function public.pilot_mini_open(text,bigint,uuid,int),public.pilot_mini_save(text,bigint,uuid,int,text,text,text,text),public.pilot_mini_decide(text,bigint,uuid,int,text) from public,anon,authenticated;
grant execute on function public.pilot_mini_open(text,bigint,uuid,int),public.pilot_mini_save(text,bigint,uuid,int,text,text,text,text),public.pilot_mini_decide(text,bigint,uuid,int,text) to service_role;
commit;
