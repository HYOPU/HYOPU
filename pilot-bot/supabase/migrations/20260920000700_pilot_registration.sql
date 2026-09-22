begin;
create table public.pilot_registration_requests (
 id uuid primary key, action text not null check(action in('CREATE','UPDATE')),
 telegram_chat_id text not null, telegram_user_id bigint not null,
 revision integer not null default 1 check(revision>0), status text not null default 'DRAFT'
 check(status in('DRAFT','CONFIRMED','SUBMITTING','VERIFYING','SUCCESS','FAILED','UNKNOWN','CANCELLED')),
 sealed_data text not null check(octet_length(sealed_data)<=120000),
 application_id text, original_hash text, last_update_id bigint not null,
 confirmed_at timestamptz, submitted_at timestamptz, verified_at timestamptz,
 error_code text, worker_token uuid, worker_until timestamptz, reconcile_after timestamptz, reconcile_attempts int not null default 0,
 expires_at timestamptz not null default now()+interval '20 minutes', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on public.pilot_registration_requests(telegram_chat_id,telegram_user_id,updated_at desc);
create unique index pilot_registration_one_draft on public.pilot_registration_requests(telegram_chat_id,telegram_user_id) where status='DRAFT';
create table public.pilot_action_logs (
 id bigint generated always as identity primary key, request_id uuid not null unique references public.pilot_registration_requests(id),
 actor_telegram_id bigint not null, action text not null check(action in('PILOT_REGISTER','PILOT_UPDATE')),
 application_id text not null, before_data jsonb, after_data jsonb not null, created_at timestamptz not null default now()
);
create table public.pilot_registration_control (
 id boolean primary key default true check(id), writer_id uuid, writer_until timestamptz,
 create_enabled boolean not null default false, update_enabled boolean not null default false
);
insert into public.pilot_registration_control(id) values(true);
alter table public.pilot_notifications add column registration_id uuid;
alter table public.pilot_notifications add column registration_revision int;
alter table public.pilot_notifications add column reply_parameters jsonb;

-- Small owner-bound encrypted envelope only; never returns another admin's draft.
create function public.pilot_reg_get(p_update bigint,p_id uuid default null,p_reply bigint default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.pilot_telegram_updates; r public.pilot_registration_requests;
begin
 select * into u from public.pilot_telegram_updates where update_id=p_update and status='RECEIVED';
 if not found then return null; end if;
 if not public.pilot_reserve(65536) then return null; end if;
 select * into r from public.pilot_registration_requests where telegram_chat_id=u.chat_id and telegram_user_id=u.user_id
 and (p_id is null or id=p_id) order by updated_at desc limit 1;
 if r.id is null then return null; end if;
 if p_reply is not null and not exists(select 1 from public.pilot_notifications where registration_id=r.id and registration_revision=r.revision
   and telegram_message_id=p_reply and status='SENT' and telegram_chat_id=u.chat_id) then return null; end if;
 return jsonb_build_object('id',r.id,'action',r.action,'revision',r.revision,'status',r.status,'sealed_data',r.sealed_data,
   'expired',r.expires_at<=now(),'application_id',r.application_id,'error_code',r.error_code);
end $$;
create function public.pilot_reg_start(p_update bigint,p_id uuid,p_action text,p_sealed text) returns int
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.pilot_telegram_updates;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 select * into u from public.pilot_telegram_updates where update_id=p_update and status='RECEIVED';
 if not found or p_action not in('CREATE','UPDATE') then raise exception 'REG_UPDATE_INVALID'; end if;
 if not public.pilot_reserve(65536) then raise exception 'REG_BUDGET'; end if;
 update public.pilot_registration_requests set status='CANCELLED',error_code='DRAFT_REPLACED',updated_at=now()
 where telegram_chat_id=u.chat_id and telegram_user_id=u.user_id and status='DRAFT';
 insert into public.pilot_registration_requests(id,action,telegram_chat_id,telegram_user_id,sealed_data,last_update_id)
 values(p_id,p_action,u.chat_id,u.user_id,p_sealed,p_update);
 return 1;
end $$;
create function public.pilot_reg_save(p_update bigint,p_id uuid,p_revision int,p_sealed text,p_original_hash text default null,p_application text default null) returns int
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.pilot_telegram_updates; rev int;
begin
 select * into u from public.pilot_telegram_updates where update_id=p_update and status='RECEIVED';
 if not found then raise exception 'REG_UPDATE_INVALID'; end if;
 update public.pilot_registration_requests set sealed_data=p_sealed,revision=revision+1,last_update_id=p_update,
 original_hash=coalesce(p_original_hash,original_hash),application_id=coalesce(p_application,application_id),updated_at=now(),expires_at=now()+interval '20 minutes'
 where id=p_id and telegram_chat_id=u.chat_id and telegram_user_id=u.user_id and status='DRAFT' and revision=p_revision and expires_at>now() and last_update_id<>p_update returning revision into rev;
 if rev is null then raise exception 'REG_STALE_DRAFT'; end if; return rev;
end $$;
create function public.pilot_reg_decide(p_update bigint,p_id uuid,p_revision int,p_action text) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.pilot_telegram_updates; r public.pilot_registration_requests; c public.pilot_registration_control;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 select * into u from public.pilot_telegram_updates where update_id=p_update and status='RECEIVED';
 select * into r from public.pilot_registration_requests where id=p_id and telegram_chat_id=u.chat_id and telegram_user_id=u.user_id for update;
 if r.id is null or r.status<>'DRAFT' or r.revision<>p_revision or r.expires_at<=now() then return 'STALE'; end if;
 if p_action='CANCEL' then
   update public.pilot_registration_requests set status='CANCELLED',updated_at=now(),last_update_id=p_update where id=r.id;return 'CANCELLED';
 end if;
 if p_action<>'CONFIRM' then raise exception 'REG_ACTION'; end if;
 select * into c from public.pilot_registration_control where id;
 if not (case when r.action='CREATE' then c.create_enabled else c.update_enabled end) then return 'DISABLED'; end if;
 if not public.pilot_reserve(262144) then return 'BUDGET'; end if;
 update public.pilot_registration_requests set status='CONFIRMED',confirmed_at=now(),last_update_id=p_update,updated_at=now() where id=r.id;
 return 'CONFIRMED';
end $$;
create function public.pilot_reg_context() returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('sealed_session',sealed_session) from public.hpbot_control where id
$$;
create function public.pilot_reg_is_reply(p_chat text,p_user bigint,p_message bigint) returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from public.pilot_registration_requests r join public.pilot_notifications n on n.registration_id=r.id and n.registration_revision=r.revision
 where r.telegram_chat_id=p_chat and r.telegram_user_id=p_user and r.status='DRAFT' and r.expires_at>now() and n.status='SENT' and n.telegram_message_id=p_message and n.telegram_chat_id=p_chat)
$$;
create function public.pilot_reg_application(p_id text) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',application_id,'date',pilot_date,'status',application_status) from public.hpbot_pilot_current where application_id=p_id
$$;
create function public.pilot_reg_reply(p_update bigint,p_id uuid,p_revision int,p_message text,p_markup jsonb,p_reply bigint) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform public.hpbot_reply(p_update,p_message,p_markup);
 update public.pilot_notifications set registration_id=p_id,registration_revision=p_revision,reply_parameters=jsonb_build_object('message_id',p_reply,'allow_sending_without_reply',true)
 where notification_key='telegram_update:'||p_update;
end $$;
alter function public.pilot_claim_notification(timestamptz) rename to pilot_claim_notification_before_registration;
create function public.pilot_claim_notification(p_at timestamptz default now()) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare n jsonb; begin
 n:=public.pilot_claim_notification_before_registration(p_at);
 if n is null then return null; end if;
 return n||jsonb_build_object('reply_parameters',(select reply_parameters from public.pilot_notifications where id=(n->>'id')::uuid));
end $$;

-- Shared account write lease and watcher version fence. Never reuse a POST permit.
create function public.pilot_reg_claim(p_id uuid,p_at timestamptz default now()) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.pilot_registration_requests; c public.pilot_watcher_control; g public.pilot_registration_control; token uuid; recovery boolean;
begin
 select * into c from public.pilot_watcher_control where id for update;
 select * into g from public.pilot_registration_control where id for update;
 select * into r from public.pilot_registration_requests where id=p_id for update;
 if r.id is null or not c.enabled or c.lease_until>p_at or g.writer_until>p_at or r.worker_until>p_at then return null; end if;
 recovery:=r.status in('SUBMITTING','VERIFYING','UNKNOWN');
 if r.status<>'CONFIRMED' and not recovery then return null; end if;
 if not recovery and (r.confirmed_at<p_at-interval '2 minutes' or not (case when r.action='CREATE' then g.create_enabled else g.update_enabled end)) then
   update public.pilot_registration_requests set status='FAILED',error_code='REG_CONFIRMATION_EXPIRED_OR_DISABLED',updated_at=p_at where id=p_id;return null;
 end if;
 if not public.pilot_reserve(262144,p_at) then return null; end if;
 token:=gen_random_uuid();
 update public.pilot_registration_control set writer_id=p_id,writer_until=p_at+interval '3 minutes' where id;
 update public.pilot_watcher_control set version=version+1,lease_token=null,lease_until=null,continuous=false where id;
 update public.pilot_registration_requests set worker_token=token,worker_until=p_at+interval '3 minutes',updated_at=p_at,
   reconcile_attempts=reconcile_attempts+case when recovery then 1 else 0 end where id=p_id;
 return jsonb_build_object('id',r.id,'action',r.action,'chat',r.telegram_chat_id,'user',r.telegram_user_id,'revision',r.revision,
   'sealed_data',r.sealed_data,'token',token,'recovery',recovery,'original_hash',r.original_hash);
end $$;
create function public.pilot_reg_submitting(p_id uuid,p_token uuid,p_sealed text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.pilot_registration_requests; g public.pilot_registration_control;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 select * into g from public.pilot_registration_control where id for update;
 select * into r from public.pilot_registration_requests where id=p_id for update;
 if not (select enabled from public.pilot_watcher_control where id) or r.status<>'CONFIRMED' or r.worker_token is distinct from p_token
 or r.worker_until<=now() or g.writer_id is distinct from p_id or g.writer_until<=now() or r.confirmed_at<now()-interval '2 minutes'
 or not (case when r.action='CREATE' then g.create_enabled else g.update_enabled end) then return false; end if;
 update public.pilot_registration_requests set sealed_data=p_sealed,status='SUBMITTING',submitted_at=now(),updated_at=now() where id=p_id;
 return true;
end $$;
create function public.pilot_reg_verifying(p_id uuid,p_token uuid) returns void language sql security definer set search_path=pg_catalog,public as $$
 update public.pilot_registration_requests set status='VERIFYING',updated_at=now() where id=p_id and worker_token=p_token and status='SUBMITTING'
$$;
create function public.pilot_reg_finish(p_id uuid,p_token uuid,p_status text,p_error text default null,p_row jsonb default null,p_message text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.pilot_registration_requests; old jsonb; pl jsonb; data jsonb; ch jsonb;
begin
 perform 1 from public.pilot_watcher_control where id for update;
 perform 1 from public.pilot_registration_control where id for update;
 select * into r from public.pilot_registration_requests where id=p_id for update;
 if r.worker_token is distinct from p_token or r.id is null or r.status not in('CONFIRMED','SUBMITTING','VERIFYING','UNKNOWN') then return false; end if;
 if p_status not in('SUCCESS','FAILED','UNKNOWN') or (p_status='FAILED' and r.submitted_at is not null) then raise exception 'REG_UNCERTAIN_STATUS'; end if;
 if p_error is not null and p_error !~ '^[A-Z_0-9]{1,80}$' then raise exception 'REG_ERROR_CODE'; end if;
 if p_status='SUCCESS' then
   if r.submitted_at is null or p_row->>'application_id' !~ '^[0-9]{1,30}$' or p_row->>'agent'<>'협운' or p_row->>'completion_status'<>'ACTIVE'
     or (r.action='UPDATE' and r.application_id is distinct from p_row->>'application_id') then raise exception 'REG_VERIFIED_ROW'; end if;
   if r.worker_until<=now() or not exists(select 1 from public.pilot_registration_control where id and writer_id=p_id and writer_until>now()) then raise exception 'REG_EXPIRED_WORKER'; end if;
   select c.data into old from public.hpbot_pilot_current c where c.application_id=p_row->>'application_id';
   pl:=public.hpbot_plan(case when old is null then '[]'::jsonb else jsonb_build_array(old) end,jsonb_build_array(p_row),'[]','[]',false,false,now());
   data:=pl->'rows'->0;
   insert into public.hpbot_pilot_current(application_id,data,first_seen_at,last_seen_at,updated_at)
     values(p_row->>'application_id',data,now(),now(),now()) on conflict(application_id) do update set data=excluded.data,last_seen_at=now(),updated_at=now(),revision=hpbot_pilot_current.revision+1;
   for ch in select value from jsonb_array_elements(pl->'changes') loop
     insert into public.hpbot_pilot_history(external_key,vessel_name,event_type,old_data,new_data,detected_at,run_id)
       values('1002:'||(p_row->>'application_id'),p_row->>'vessel_name',ch->>'type',ch->'old',ch->'new',now(),p_id);
   end loop;
   insert into public.pilot_action_logs(request_id,actor_telegram_id,action,application_id,before_data,after_data)
     values(p_id,r.telegram_user_id,case when r.action='CREATE' then 'PILOT_REGISTER' else 'PILOT_UPDATE' end,p_row->>'application_id',old,data);
   -- Force the next full observation to send fresh applications, not an old cached snapshot.
   update public.hpbot_control set application_hash=null where id;
   update public.pilot_watcher_control set version=version+1 where id;
 end if;
 update public.pilot_registration_requests set status=p_status,error_code=p_error,application_id=coalesce(p_row->>'application_id',application_id),
 verified_at=case when p_status='SUCCESS' then now() else verified_at end,worker_token=null,worker_until=null,
 reconcile_after=case when p_status='UNKNOWN' and reconcile_attempts<3 then now()+interval '5 minutes' else null end,updated_at=now() where id=p_id;
 update public.pilot_registration_control set writer_id=null,writer_until=null where id and writer_id=p_id;
 if p_message is not null and length(p_message)<=3500 then
   insert into public.pilot_notifications(notification_key,notification_type,reference_id,message,telegram_chat_id)
     values('pilot_registration:'||p_id||':'||p_status,'COMMAND_REPLY',p_id::text,p_message,r.telegram_chat_id) on conflict do nothing;
 end if;
 return true;
end $$;
alter function public.hpbot_begin(timestamptz,boolean) rename to hpbot_begin_before_registration;
create function public.hpbot_begin(p_at timestamptz default now(),p_manual boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform 1 from public.pilot_watcher_control where id for update;
 if exists(select 1 from public.pilot_registration_control where id and writer_until>p_at) then return jsonb_build_object('skip','REGISTRATION_BUSY'); end if;
 return public.hpbot_begin_before_registration(p_at,p_manual);
end $$;
-- Read-only retry requests cannot turn an UNKNOWN into a second POST.
create function public.pilot_reg_recheck(p_update bigint,p_id uuid) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.pilot_telegram_updates;
begin
 select * into u from public.pilot_telegram_updates where update_id=p_update and status='RECEIVED';
 update public.pilot_registration_requests set reconcile_after=now(),reconcile_attempts=0 where id=p_id and telegram_chat_id=u.chat_id and telegram_user_id=u.user_id and status='UNKNOWN';
 return found;
end $$;
do $$ declare t text; f record; begin
 foreach t in array array['pilot_registration_requests','pilot_action_logs','pilot_registration_control'] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from public,anon,authenticated',t);
   execute format('grant all on public.%I to service_role',t);
 end loop;
 for f in select p.oid::regprocedure as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and (p.proname like 'pilot_reg_%' or p.proname in('pilot_claim_notification','pilot_claim_notification_before_registration','hpbot_begin','hpbot_begin_before_registration')) loop
   execute format('revoke all on function %s from public,anon,authenticated',f.name);
   execute format('grant execute on function %s to service_role',f.name);
 end loop;
end $$;
commit;
