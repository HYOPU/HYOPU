begin;
create table public.pilot_copy_sources (
 id uuid primary key default gen_random_uuid(), source_key text not null unique,
 application_id text, metadata jsonb not null, fingerprint text not null,
 sealed_data text check(octet_length(sealed_data)<=30000), business_hash text,
 contract_version int, observed_at timestamptz, complete boolean not null default false,
 last_seen_at timestamptz not null default now(), error_code text
);
create index on public.pilot_copy_sources(application_id);
create table public.pilot_copy_jobs (
 source_id uuid primary key references public.pilot_copy_sources(id) on delete cascade,
 fingerprint text not null, attempts int not null default 0, retry_at timestamptz not null default now(),
 token uuid, lease_until timestamptz, dispatched_at timestamptz
);
alter table public.pilot_registration_control add column copy_enabled boolean not null default false;
alter table public.pilot_registration_control add column copy_history_days int not null default 30 check(copy_history_days between 1 and 90);
alter table public.pilot_registration_control add column copy_catalog_synced_at timestamptz;
alter table public.pilot_registration_control add column copy_catalog_lease_until timestamptz;
alter table public.pilot_registration_requests add column copy_source_id uuid references public.pilot_copy_sources(id);
alter table public.pilot_registration_requests add column copy_source_hash text;
alter table public.pilot_registration_requests add column copy_audit_sealed text check(octet_length(copy_audit_sealed)<=30000);
alter table public.pilot_action_logs add column copy_source_id uuid;
alter table public.pilot_action_logs add column copy_audit_sealed text;

-- An index of safe list metadata, not an application identity guessed from a name.
create function public.pilot_copy_index(p_rows jsonb,p_at timestamptz default now()) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r jsonb; m jsonb; fp text; ky text; sid uuid; oldfp text; days int;
begin
 select copy_history_days into days from public.pilot_registration_control where id;
 for r in select value from jsonb_array_elements(p_rows) loop
  if r->>'agent'<>'협운' or r->>'completion_status' not in('ACTIVE','COMPLETED','CANCELLED') then continue; end if;
  if r->>'completion_status'<>'ACTIVE' and r->>'pilot_date'<((p_at at time zone 'Asia/Seoul')::date-days+1)::text then continue; end if;
  m:=jsonb_build_object('application_id',r->>'application_id','vessel_name',r->>'vessel_name','callsign',r->>'callsign',
   'pilot_date',r->>'pilot_date','pilot_time',r->>'pilot_time','from_location',r->>'from_location','to_location',r->>'to_location',
   'completion_status',r->>'completion_status','application_status',r->>'application_status','draft',r->>'draft','mooring_name',r->>'mooring_name','remarks',r->>'remarks');
  ky:=case when r->>'application_id' is not null then 'app:'||(r->>'application_id') else 'row:'||md5((m-array['application_id','application_status','completion_status','draft','remarks','mooring_name'])::text) end;
  fp:=md5(m::text);select fingerprint into oldfp from public.pilot_copy_sources where source_key=ky;
  insert into public.pilot_copy_sources(source_key,application_id,metadata,fingerprint,last_seen_at)
   values(ky,r->>'application_id',m,fp,p_at) on conflict(source_key) do update set metadata=excluded.metadata,fingerprint=excluded.fingerprint,last_seen_at=p_at returning id into sid;
  if r->>'application_id' is not null and r->>'completion_status'='ACTIVE' and fp is distinct from oldfp then
   insert into public.pilot_copy_jobs(source_id,fingerprint) values(sid,fp) on conflict(source_id) do update
    set fingerprint=excluded.fingerprint,attempts=0,retry_at=p_at,token=null,lease_until=null,dispatched_at=null;
  elsif r->>'completion_status'='CANCELLED' then delete from public.pilot_copy_jobs where source_id=sid;
  end if;
 end loop;
end $$;
create function public.pilot_copy_index_trigger() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_table_name='hpbot_pilot_current' then perform public.pilot_copy_index(jsonb_build_array(new.data));
 elsif new.source='applications' then perform public.pilot_copy_index(new.rows,new.observed_at);end if;
 return new;
end $$;
create trigger pilot_copy_current after insert or update on public.hpbot_pilot_current for each row execute function public.pilot_copy_index_trigger();
create trigger pilot_copy_snapshot after insert on public.hpbot_source_snapshots for each row execute function public.pilot_copy_index_trigger();
select public.pilot_copy_index(rows,observed_at) from public.hpbot_source_snapshots where source='applications' order by observed_at desc limit 1;
select public.pilot_copy_index(coalesce(jsonb_agg(data),'[]')) from public.hpbot_pilot_current;

create function public.pilot_copy_list(p_page int default 0,p_search text default '',p_at timestamptz default now()) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
 with eligible as (
  select s.* from public.pilot_copy_sources s,public.pilot_registration_control c where c.id
   and (s.metadata->>'completion_status'='ACTIVE' or (s.metadata->>'completion_status'='COMPLETED'
    and s.metadata->>'pilot_date'>=((p_at at time zone 'Asia/Seoul')::date-c.copy_history_days+1)::text
    and s.metadata->>'pilot_date'<=(p_at at time zone 'Asia/Seoul')::date::text))
   and (p_search='' or position(upper(left(p_search,80)) in upper((s.metadata->>'vessel_name')||' '||(s.metadata->>'callsign')))>0)
   and (s.application_id is not null or not exists(select 1 from public.pilot_copy_sources a where a.application_id is not null
     and a.metadata->>'callsign'=s.metadata->>'callsign' and a.metadata->>'vessel_name'=s.metadata->>'vessel_name'
     and a.metadata->>'pilot_date'=s.metadata->>'pilot_date' and a.metadata->>'pilot_time'=s.metadata->>'pilot_time'
     and a.metadata->>'from_location'=s.metadata->>'from_location' and a.metadata->>'to_location'=s.metadata->>'to_location'
     and a.metadata->>'completion_status'=s.metadata->>'completion_status'))
 ), page as (
  select id,application_id,metadata,complete,observed_at,
   (complete or application_id is not null and metadata->>'completion_status'='ACTIVE') as available
  from eligible order by (metadata->>'completion_status'='ACTIVE') desc,
   case when metadata->>'completion_status'='ACTIVE' then (metadata->>'pilot_date')||coalesce(nullif(metadata->>'pilot_time',''),'99:99') end asc,
   case when metadata->>'completion_status'='COMPLETED' then (metadata->>'pilot_date')||(metadata->>'pilot_time') end desc,id
  limit 10 offset least(999,greatest(0,p_page))*10
 ) select jsonb_build_object('page',p_page,'total',(select count(*) from eligible),'rows',coalesce((select jsonb_agg(page) from page),'[]'))
$$;
create function public.pilot_copy_get(p_id uuid default null,p_application text default null) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
 select to_jsonb(s) from public.pilot_copy_sources s where (p_id is not null and id=p_id) or (p_id is null and application_id=p_application) limit 1
$$;
create function public.pilot_copy_catalog_claim(p_days int default null) returns int language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.pilot_registration_control;
begin
 select * into c from public.pilot_registration_control where id for update;
 if p_days is not null then
  if p_days not between 1 and 90 then raise exception 'COPY_HISTORY_RANGE';end if;
  update public.pilot_registration_control set copy_history_days=p_days where id;c.copy_history_days:=p_days;
 end if;
 if c.copy_catalog_synced_at>now()-interval '15 minutes' or c.copy_catalog_lease_until>now() then return 0;end if;
 if not public.pilot_reserve(262144) then return 0;end if;
 update public.pilot_registration_control set copy_catalog_lease_until=now()+interval '60 seconds' where id;
 return c.copy_history_days;
end $$;
create function public.pilot_copy_catalog_complete(p_rows jsonb) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if octet_length(p_rows::text)>200000 or jsonb_array_length(p_rows)>1000 then raise exception 'COPY_CATALOG_LIMIT';end if;
 perform public.pilot_copy_index(p_rows);
 update public.pilot_registration_control set copy_catalog_synced_at=now(),copy_catalog_lease_until=null where id;
end $$;
create function public.pilot_copy_links(p_applications text[]) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce(jsonb_object_agg(application_id,id),'{}') from public.pilot_copy_sources where application_id=any(p_applications[1:10])
$$;
create function public.pilot_copy_claim() returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb:='[]'; j public.pilot_copy_jobs; t uuid;
begin
 if not (select enabled from public.pilot_watcher_control where id) then return result;end if;
 for j in select * from public.pilot_copy_jobs where attempts<3 and retry_at<=now() and (lease_until is null or lease_until<now()) order by retry_at limit 2 for update skip locked loop
  if not public.pilot_reserve(65536) then exit;end if;
  t:=gen_random_uuid();update public.pilot_copy_jobs set token=t,lease_until=now()+interval '90 seconds',attempts=attempts+1 where source_id=j.source_id;
  result:=result||jsonb_build_array((select jsonb_build_object('id',s.id,'application_id',s.application_id,'metadata',s.metadata,'fingerprint',s.fingerprint,'token',t) from public.pilot_copy_sources s where id=j.source_id));
 end loop;return result;
end $$;
create function public.pilot_copy_store(p_id uuid,p_fingerprint text,p_hash text,p_sealed text,p_at timestamptz default now(),p_token uuid default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_hash !~ '^[a-f0-9]{64}$' or octet_length(p_sealed)>30000 then raise exception 'COPY_ENVELOPE';end if;
 if p_token is not null and not exists(select 1 from public.pilot_copy_jobs where source_id=p_id and token=p_token and lease_until>now()) then return false;end if;
 update public.pilot_copy_sources set sealed_data=p_sealed,business_hash=p_hash,observed_at=p_at,contract_version=1,complete=true,error_code=null
 where id=p_id and fingerprint=p_fingerprint;
 if not found then return false;end if;
 delete from public.pilot_copy_jobs where source_id=p_id and fingerprint=p_fingerprint;return true;
end $$;
create function public.pilot_copy_fail(p_id uuid,p_token uuid,p_error text) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_error !~ '^[A-Z_0-9]{1,80}$' then p_error:='COPY_READ_FAILED';end if;
 update public.pilot_copy_jobs set lease_until=null,token=null,retry_at=now()+interval '15 minutes' where source_id=p_id and token=p_token;
 if found then update public.pilot_copy_sources set error_code=p_error where id=p_id;end if;
end $$;

alter function public.pilot_mini_save(text,bigint,uuid,int,text,text,text,text) rename to pilot_mini_save_before_copy;
create function public.pilot_mini_save(p_chat text,p_user bigint,p_id uuid,p_revision int,p_action text,p_sealed text,p_original_hash text default null,p_application text default null,p_copy_source uuid default null,p_copy_hash text default null,p_copy_audit text default null) returns int
language plpgsql security definer set search_path=pg_catalog,public as $$
declare rev int; old_source uuid;
begin
 select copy_source_id into old_source from public.pilot_registration_requests where id=p_id;
 if p_revision>0 and old_source is distinct from p_copy_source then raise exception 'COPY_MODE_IMMUTABLE';end if;
 if p_copy_source is not null and (p_action<>'CREATE' or p_application is not null or p_copy_hash is null or p_copy_hash!~'^[a-f0-9]{64}$'
  or not exists(select 1 from public.pilot_copy_sources where id=p_copy_source)) then raise exception 'COPY_SOURCE_INVALID';end if;
 rev:=public.pilot_mini_save_before_copy(p_chat,p_user,p_id,p_revision,p_action,p_sealed,p_original_hash,p_application);
 if p_copy_source is not null then update public.pilot_registration_requests set copy_source_id=p_copy_source,copy_source_hash=p_copy_hash,copy_audit_sealed=p_copy_audit,expires_at=now()+interval '30 minutes' where id=p_id;end if;
 return rev;
end $$;
create function public.pilot_copy_guard() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.copy_source_id is not null then
  if new.action<>'CREATE' then raise exception 'COPY_CREATE_ONLY';end if;
  if new.status in('CONFIRMED','SUBMITTING') and new.status is distinct from old.status
   and not exists(select 1 from public.pilot_registration_control where id and create_enabled and copy_enabled) then raise exception 'COPY_FEATURE_DISABLED';end if;
 end if;return new;
end $$;
create trigger pilot_copy_guard before update on public.pilot_registration_requests for each row execute function public.pilot_copy_guard();
alter function public.pilot_mini_decide(text,bigint,uuid,int,text) rename to pilot_mini_decide_before_copy;
create function public.pilot_mini_decide(p_chat text,p_user bigint,p_id uuid,p_revision int,p_action text) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_action='CONFIRM' and exists(select 1 from public.pilot_registration_requests where id=p_id and telegram_chat_id=p_chat and telegram_user_id=p_user and copy_source_id is not null)
 and not (select copy_enabled from public.pilot_registration_control where id) then return 'DISABLED';end if;
 return public.pilot_mini_decide_before_copy(p_chat,p_user,p_id,p_revision,p_action);
end $$;
create function public.pilot_copy_audit() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 select copy_source_id,copy_audit_sealed into new.copy_source_id,new.copy_audit_sealed from public.pilot_registration_requests where id=new.request_id;
 return new;
end $$;
create trigger pilot_copy_audit before insert on public.pilot_action_logs for each row execute function public.pilot_copy_audit();

-- Derive the displayed queue number after the verified row is committed inside
-- the same transaction. Do not generate a second notification for rank changes.
alter function public.pilot_reg_finish(uuid,uuid,text,text,jsonb,text) rename to pilot_reg_finish_before_copy;
create function public.pilot_reg_finish(p_id uuid,p_token uuid,p_status text,p_error text default null,p_row jsonb default null,p_message text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare ok boolean; seq bigint;
begin
 ok:=public.pilot_reg_finish_before_copy(p_id,p_token,p_status,p_error,p_row,p_message);
 if ok and p_status='SUCCESS' and exists(select 1 from public.pilot_registration_requests where id=p_id and copy_source_id is not null) then
  select sequence_no into seq from public.hpbot_pilot_queue where application_id=p_row->>'application_id';
  if seq is not null then update public.pilot_notifications set message=message||E'\n현재 협운 순번: '||seq||'번'
   where notification_key='pilot_registration:'||p_id||':SUCCESS' and status='PENDING';end if;
 end if;return ok;
end $$;

create function public.pilot_copy_dispatch() returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare endpoint text; secret text; gateway text;
begin
 if not (select enabled from public.pilot_watcher_control where id) or not exists(select 1 from public.pilot_copy_jobs where attempts<3 and retry_at<=now() and (lease_until is null or lease_until<now()) and (dispatched_at is null or dispatched_at<now()-interval '2 minutes')) then return;end if;
 select replace(decrypted_secret,'/ulsan-pilot-watcher','/ulsan-pilot-copy-source') into endpoint from vault.decrypted_secrets where name='ulsan_watcher_url';
 select decrypted_secret into secret from vault.decrypted_secrets where name='ulsan_watcher_key';
 select decrypted_secret into gateway from vault.decrypted_secrets where name='ulsan_gateway_anon_jwt';
 if endpoint is null or endpoint!~'^https://[a-z0-9]+\.supabase\.co/functions/v1/ulsan-pilot-copy-source$' or secret is null or gateway is null then return;end if;
 if not public.pilot_reserve(2048) then return;end if;
 update public.pilot_copy_jobs set dispatched_at=now() where source_id in(select source_id from public.pilot_copy_jobs where attempts<3 and retry_at<=now() and (lease_until is null or lease_until<now()) order by retry_at limit 2);
 perform net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||gateway,'x-watcher-key',secret),body:='{}'::jsonb,timeout_milliseconds:=55000);
end $$;
-- Install only where the existing cloud dispatcher is present (unit DB has no pg_net).
do $$ begin
 if to_regprocedure('public.pilot_cron_tick()') is not null then
  alter function public.pilot_cron_tick() rename to pilot_cron_tick_before_copy;
  execute 'create function public.pilot_cron_tick() returns void language plpgsql security definer set search_path=pg_catalog,public as $f$ begin perform public.pilot_cron_tick_before_copy();perform public.pilot_copy_dispatch();if extract(hour from now() at time zone ''Asia/Seoul'')=3 and extract(minute from now() at time zone ''Asia/Seoul'')=0 then perform public.pilot_copy_cleanup();end if;end $f$';
 end if;
end $$;
create function public.pilot_copy_cleanup() returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update public.pilot_copy_sources s set sealed_data=null,complete=false,business_hash=null
 from public.pilot_registration_control c where c.id and s.metadata->>'completion_status'<>'ACTIVE'
 and s.metadata->>'pilot_date'<((now() at time zone 'Asia/Seoul')::date-c.copy_history_days+1)::text
 and not exists(select 1 from public.pilot_registration_requests r where r.copy_source_id=s.id and r.status in('DRAFT','CONFIRMED','SUBMITTING','VERIFYING','UNKNOWN'));
 update public.pilot_action_logs set copy_audit_sealed=null where created_at<now()-interval '365 days' and copy_audit_sealed is not null;
 update public.pilot_registration_requests set copy_audit_sealed=null where created_at<now()-interval '365 days' and status in('SUCCESS','FAILED','CANCELLED') and copy_audit_sealed is not null;
 delete from public.pilot_copy_sources s using public.pilot_registration_control c where c.id and s.metadata->>'completion_status'<>'ACTIVE'
 and s.metadata->>'pilot_date'<((now() at time zone 'Asia/Seoul')::date-c.copy_history_days+1)::text
 and not exists(select 1 from public.pilot_registration_requests r where r.copy_source_id=s.id);
end $$;
do $$ declare t text; f record; begin
 foreach t in array array['pilot_copy_sources','pilot_copy_jobs'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
 for f in select p.oid::regprocedure name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and (p.proname like 'pilot_copy_%' or p.proname like 'pilot_mini_%' or p.proname in('pilot_cron_tick','pilot_cron_tick_before_copy','pilot_reg_finish','pilot_reg_finish_before_copy')) loop
  execute format('revoke all on function %s from public,anon,authenticated',f.name);
  execute format('grant execute on function %s to service_role',f.name);
 end loop;
end $$;
commit;
