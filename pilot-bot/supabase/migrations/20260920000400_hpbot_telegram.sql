begin;
alter table public.hpbot_control add column primary_chat_id text;
alter table public.pilot_notifications add column telegram_chat_id text;
alter table public.pilot_notifications add column reply_markup jsonb;
create table public.pilot_telegram_chats (
 chat_id text primary key, enabled boolean not null default true,
 settings jsonb not null default '{"NEW":true,"TIME_CHANGED":true,"ROUTE_CHANGED":true,"STATUS_CHANGED":true,"REMARK_CHANGED":true,"CANCELLED":true,"COMPLETED":false,"WEATHER_SUSPEND":true,"WEATHER_RESUME":true,"SOURCE_ERROR":true,"SOURCE_RECOVERY":true}',
 updated_at timestamptz not null default now()
);
create table public.pilot_telegram_updates (
 update_id bigint primary key, chat_id text not null, user_id bigint not null, command text not null,
 status text not null default 'RECEIVED', created_at timestamptz not null default now(), finished_at timestamptz
);
create or replace function public.hpbot_filter_notifications(changes jsonb) returns jsonb language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(c),'[]') from jsonb_array_elements(changes) c
 where coalesce((select (ch.settings->>(c->>'type'))::boolean from public.pilot_telegram_chats ch
 join public.hpbot_control d on d.primary_chat_id=ch.chat_id),c->>'type'<>'COMPLETED')
$$;
create index on public.pilot_telegram_updates(chat_id,created_at);
create table public.pilot_telegram_confirmations (
 token uuid primary key default gen_random_uuid(), chat_id text not null, user_id bigint not null,
 action text not null check(action in('stop','resume')), expires_at timestamptz not null, used_at timestamptz
);
create function public.hpbot_accept_update(p_update bigint,p_chat text,p_user bigint,p_command text,p_search text default null,p_at timestamptz default now())
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform 1 from public.pilot_watcher_control where id for update;
 if not exists(select 1 from public.pilot_telegram_chats where chat_id=p_chat and enabled)
   or exists(select 1 from public.pilot_telegram_updates where update_id=p_update) then return false; end if;
 if (select count(*) from public.pilot_telegram_updates where chat_id=p_chat and created_at>p_at-interval '1 minute')>=20
   or (select count(*) from public.pilot_telegram_updates where user_id=p_user and created_at>p_at-interval '1 minute')>=8 then return false; end if;
 if not public.pilot_reserve(12288,p_at) then return false; end if;
 if p_search is not null and not exists(select 1 from public.hpbot_pilot_queue where position(public.hpbot_vessel(p_search) in public.hpbot_vessel(vessel_name))>0) then return false; end if;
 insert into public.pilot_telegram_updates(update_id,chat_id,user_id,command,created_at) values(p_update,p_chat,p_user,left(p_command,24),p_at);
 return true;
end $$;
create function public.hpbot_reply(p_update bigint,p_message text,p_markup jsonb default null) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.pilot_telegram_updates;
begin
 select * into u from public.pilot_telegram_updates where update_id=p_update for update;
 if not found or u.status<>'RECEIVED' then return; end if;
 if octet_length(p_message)>12000 or char_length(p_message)>3500 or octet_length(coalesce(p_markup,'{}')::text)>6000 then raise exception 'REPLY_LIMIT'; end if;
 if not (select enabled from public.pilot_watcher_control where id) then return; end if;
 insert into public.pilot_notifications(notification_key,notification_type,reference_id,message,telegram_chat_id,reply_markup)
 values('telegram_update:'||p_update,'COMMAND_REPLY',p_update::text,p_message,u.chat_id,p_markup) on conflict do nothing;
 update public.pilot_telegram_updates set status='QUEUED',finished_at=now() where update_id=p_update;
end $$;

create function public.hpbot_read(p_command text,p_page int default 0,p_search text default '',p_chat text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb; data jsonb; total int; today date:=(now() at time zone 'Asia/Seoul')::date;
begin
 if p_page<0 or p_page>999 or length(p_search)>120 then raise exception 'QUERY_LIMIT'; end if;
 select jsonb_build_object('last_success',c.last_success,'enabled',c.enabled,'disabled_reason',c.disabled_reason,'failure_count',c.failure_count,
   'weather',w.status,'bad_weather_count',w.bad_weather_count,'started_at',w.started_at,'paused',d.paused,'bootstrap_done',d.bootstrap_done,
   'login_ok',d.last_login_ok,'forecast_ok',d.last_forecast_ok,'error',d.last_error,
   'active',(select count(*) from public.hpbot_pilot_queue),'processing',(select count(*) from public.hpbot_pilot_queue where forecast_status='PROCESSING'),
   'hpbot_bad_weather',(select count(*) from public.hpbot_pilot_queue where forecast_status='BAD_WEATHER')) into result
 from public.pilot_watcher_control c cross join public.pilot_weather_state w cross join public.hpbot_control d;
 if p_command in('queue','today','tomorrow','three','search') then
   select count(*) into total from public.hpbot_pilot_queue q where
     (p_command not in('today','tomorrow','three') or (p_command='today' and q.pilot_date=today::text)
       or (p_command='tomorrow' and q.pilot_date=(today+1)::text) or (p_command='three' and q.pilot_date between today::text and (today+2)::text))
     and (p_command<>'search' or position(public.hpbot_vessel(p_search) in public.hpbot_vessel(q.vessel_name))>0);
   select coalesce(jsonb_agg(to_jsonb(x) order by x.sequence_no),'[]') into data from (
     select q.sequence_no,q.application_id,q.vessel_name,q.pilot_date,q.pilot_time,q.from_location,q.to_location,q.application_status,q.forecast_status,
       q.forecast_time,q.is_overdue,q.needs_review from public.hpbot_pilot_queue q where
     (p_command not in('today','tomorrow','three') or (p_command='today' and q.pilot_date=today::text)
       or (p_command='tomorrow' and q.pilot_date=(today+1)::text) or (p_command='three' and q.pilot_date between today::text and (today+2)::text))
     and (p_command<>'search' or position(public.hpbot_vessel(p_search) in public.hpbot_vessel(q.vessel_name))>0)
     order by q.sequence_no offset p_page*10 limit 10) x;
   result:=result||jsonb_build_object('rows',data,'total',total,'page',p_page);
 elsif p_command='weather' then
   select coalesce(jsonb_agg(x),'[]') into data from (select distinct on(coalesce(nullif(r->>'callsign',''),r->>'vessel_name')) r->>'vessel_name' vessel_name,r->>'pilot_date' pilot_date,r->>'pilot_time' pilot_time,r->>'from_location' from_location,r->>'to_location' to_location,r->>'agent' agent
     from public.hpbot_control d join public.hpbot_source_snapshots s on s.id=d.forecast_snapshot,
     lateral jsonb_array_elements(s.rows) r where r->>'status'='BAD_WEATHER' and not (r->>'cancelled')::boolean order by coalesce(nullif(r->>'callsign',''),r->>'vessel_name') offset p_page*10 limit 10) x;
   result:=result||jsonb_build_object('rows',data,'total',result->'bad_weather_count','page',p_page);
 elsif p_command='changes' then
   select coalesce(jsonb_agg(x),'[]') into data from (select vessel_name,event_type,detected_at,new_data->>'pilot_date' pilot_date,new_data->>'pilot_time' pilot_time,
     old_data->>'pilot_time' old_time,new_data->>'from_location' from_location,new_data->>'to_location' to_location,
     old_data->>'forecast_status' old_status,new_data->>'forecast_status' forecast_status
     from public.hpbot_pilot_history order by detected_at desc,id desc limit 10) x;
   result:=result||jsonb_build_object('rows',data);
 elsif p_command='events' then
   select coalesce(jsonb_agg(x),'[]') into data from (select started_at,resume_detected_at,duration_seconds,resume_vessel_name,resume_method
     from public.pilot_weather_events order by started_at desc limit 10) x;
   result:=result||jsonb_build_object('rows',data);
 elsif p_command='settings' then
   result:=result||jsonb_build_object('settings',(select settings from public.pilot_telegram_chats where chat_id=p_chat));
 elsif p_command in('health','debug') then
   result:=result||jsonb_build_object('estimated_cycle_bytes',(select max(estimated_bytes) from public.pilot_usage where scope like 'cycle:%'),
     'estimated_day_bytes',(select estimated_bytes from public.pilot_usage where scope='day:'||today::text),
     'telegram_last_sent',(select max(sent_at) from public.pilot_notifications),'lease_until',(select lease_until from public.pilot_watcher_control));
 end if;
 return result;
end $$;

-- Runtime must first verify the actual Telegram sender as creator/administrator.
-- These RPCs are service-role-only, never browser/user callable.
create function public.hpbot_prepare_confirmation(p_update bigint,p_action text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.pilot_telegram_updates; token uuid;
begin
 select * into u from public.pilot_telegram_updates where update_id=p_update and status='RECEIVED';
 if not found or p_action not in('stop','resume') then raise exception 'CONFIRMATION_INVALID'; end if;
 insert into public.pilot_telegram_confirmations(chat_id,user_id,action,expires_at) values(u.chat_id,u.user_id,p_action,now()+interval '2 minutes') returning pilot_telegram_confirmations.token into token;
 return token;
end $$;
create function public.hpbot_confirm(p_update bigint,p_token uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.pilot_telegram_updates; t public.pilot_telegram_confirmations; c public.pilot_watcher_control;
begin
 select * into c from public.pilot_watcher_control where id for update;
 select * into u from public.pilot_telegram_updates where update_id=p_update and status='RECEIVED';
 if not found then return 'INVALID'; end if;
 select * into t from public.pilot_telegram_confirmations where token=p_token and chat_id=u.chat_id and user_id=u.user_id and used_at is null and expires_at>now() for update;
 if not found then return 'EXPIRED'; end if;
 if not c.enabled or c.disabled_reason in('EGRESS_BUDGET','BILLING_REVIEW_REQUIRED') then return 'COST_BLOCKED'; end if;
 update public.pilot_telegram_confirmations set used_at=now() where token=p_token;
 update public.hpbot_control set paused=(t.action='stop') where id;
 update public.pilot_watcher_control set continuous=false,lease_token=null,lease_until=null where id;
 update public.pilot_weather_state set candidate_count=0,rearm_count=0,recovery_started_at=null where id;
 return upper(t.action);
end $$;
create function public.hpbot_toggle_setting(p_update bigint,p_setting text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.pilot_telegram_updates; v boolean;
begin
 select * into u from public.pilot_telegram_updates where update_id=p_update and status='RECEIVED';
 if not found or p_setting not in('NEW','TIME_CHANGED','ROUTE_CHANGED','STATUS_CHANGED','CANCELLED','WEATHER_SUSPEND','WEATHER_RESUME','SOURCE_ERROR','COMPLETED') then raise exception 'SETTING_INVALID'; end if;
 select not coalesce((settings->>p_setting)::boolean,true) into v from public.pilot_telegram_chats where chat_id=u.chat_id for update;
 update public.pilot_telegram_chats set settings=settings||jsonb_build_object(p_setting,v),updated_at=now() where chat_id=u.chat_id;
 return v;
end $$;
create function public.hpbot_request_refresh(p_update bigint) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control; d public.hpbot_control;
begin
 select * into c from public.pilot_watcher_control where id for update;
 select * into d from public.hpbot_control where id for update;
 if not c.enabled or d.paused then return 'STOPPED'; end if;
 if c.lease_until>now() then return 'JOINED'; end if;
 if d.last_refresh_at>now()-interval '30 seconds' then return 'COOLDOWN'; end if;
 if not public.pilot_reserve(16384) then return 'STOPPED'; end if;
 update public.hpbot_control set last_refresh_at=now() where id;
 return 'RUN';
end $$;

-- Extend the existing outbox, preserving old notification IDs and receipts.
create or replace function public.pilot_claim_notification(p_at timestamptz default now()) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare n public.pilot_notifications; c public.pilot_watcher_control; chat text;
begin
 select * into c from public.pilot_watcher_control where id for update;
 select primary_chat_id into chat from public.hpbot_control where id;
 update public.pilot_notification_attempts a set status='UNKNOWN',error='SENDER_INTERRUPTED',finished_at=p_at from public.pilot_notifications pn where pn.id=a.notification_id and a.attempt=pn.attempts and pn.status='SENDING' and pn.claimed_at<p_at-interval '2 minutes';
 update public.pilot_notifications set status='UNKNOWN',error='SENDER_INTERRUPTED' where status='SENDING' and claimed_at<p_at-interval '2 minutes';
 update public.pilot_notifications pn set status='FAILED',error='CHAT_SETTING_DISABLED' where pn.status='PENDING' and pn.notification_type not in('COST_STOP','COST_WARNING','COMMAND_REPLY')
   and exists(select 1 from public.pilot_telegram_chats ch where ch.chat_id=coalesce(pn.telegram_chat_id,chat) and (not ch.enabled or (ch.settings->>pn.notification_type)::boolean=false));
 select * into n from public.pilot_notifications where status='PENDING' and next_attempt_at<=p_at and (c.enabled or notification_type='COST_STOP') order by case notification_type when 'COST_STOP' then 0 when 'WEATHER_SUSPEND' then 1 when 'WEATHER_RESUME' then 2 when 'COMMAND_REPLY' then 3 else 4 end,created_at,id limit 1 for update skip locked;
 if n.id is null then return null; end if;
 if n.notification_type<>'COST_STOP' and not public.pilot_reserve(2*octet_length(n.message)+coalesce(octet_length(n.reply_markup::text),0)+6144,p_at) then
   select * into n from public.pilot_notifications where status='PENDING' and notification_type='COST_STOP' order by created_at,id limit 1 for update skip locked;
   if n.id is null then return null; end if;
 end if;
 update public.pilot_notifications set status='SENDING',claimed_at=p_at,attempts=attempts+1 where id=n.id;
 insert into public.pilot_notification_attempts(notification_id,attempt,started_at,status) values(n.id,n.attempts+1,p_at,'SENDING');
 return jsonb_build_object('id',n.id,'message',n.message,'chat_id',coalesce(n.telegram_chat_id,chat),'reply_markup',n.reply_markup);
end $$;

alter function public.pilot_cleanup(timestamptz) rename to pilot_cleanup_v1;
create function public.pilot_cleanup(p_at timestamptz default now()) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform public.pilot_cleanup_v1(p_at);
 delete from public.hpbot_source_snapshots where observed_at<p_at-interval '7 days' and id not in(select application_snapshot from public.hpbot_control union select forecast_snapshot from public.hpbot_control);
 delete from public.pilot_monitor_logs where created_at<p_at-interval '30 days';
 delete from public.hpbot_pilot_history where detected_at<p_at-interval '365 days';
 delete from public.pilot_telegram_updates where created_at<p_at-interval '30 days';
 delete from public.pilot_telegram_confirmations where expires_at<p_at-interval '1 day';
end $$;
do $$ declare t text; f record; begin
 foreach t in array array['pilot_telegram_chats','pilot_telegram_updates','pilot_telegram_confirmations'] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from public,anon,authenticated',t);
   execute format('grant all on public.%I to service_role',t);
 end loop;
 for f in select p.oid::regprocedure as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'hpbot_%' or p.proname in('pilot_cleanup','pilot_cleanup_v1')) loop
   execute format('revoke all on function %s from public,anon,authenticated',f.name);
   execute format('grant execute on function %s to service_role',f.name);
 end loop;
end $$;
commit;
