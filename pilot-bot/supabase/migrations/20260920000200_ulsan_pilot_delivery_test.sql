-- Bounded cloud preflight, without enabling observations or cron.
begin;
create function public.pilot_claim_delivery_test() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.pilot_watcher_control; n public.pilot_notifications;
  ck text; dk text; nk text; used_cycle bigint; used_day bigint;
begin
  select * into c from public.pilot_watcher_control where id for update;
  if c.enabled or c.billing_verified_at is null or c.cycle_start is null or c.cycle_end is null
    or now()<c.cycle_start or now()>=c.cycle_end
    or coalesce(c.billing_evidence->>'plan','') not in ('Free','Pro')
    or (c.billing_evidence->>'plan'='Pro' and (c.billing_evidence->>'spend_cap_enabled')::boolean is distinct from true)
    then raise exception 'DELIVERY_TEST_NOT_APPROVED'; end if;
  ck:='cycle:'||to_char(c.cycle_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  dk:='day:'||(now() at time zone 'Asia/Seoul')::date::text;
  nk:='delivery_test:'||ck;
  select * into n from public.pilot_notifications where notification_key=nk;
  if n.id is not null then return jsonb_build_object('id',n.id,'status',n.status); end if;
  insert into public.pilot_usage(scope) values(ck),(dk) on conflict do nothing;
  select estimated_bytes into used_cycle from public.pilot_usage where scope=ck;
  select estimated_bytes into used_day from public.pilot_usage where scope=dk;
  -- 16 KiB reserved for the entire setup request, RPC and one Telegram send.
  -- Never consume the final 8 KiB emergency allowance or cross warning threshold.
  if used_cycle+16384>least(c.cycle_limit-8192,c.warning_limit) or used_day+16384>c.day_limit-8192
    then raise exception 'DELIVERY_TEST_BUDGET'; end if;
  update public.pilot_usage set estimated_bytes=estimated_bytes+16384,updated_at=now() where scope in(ck,dk);
  n.id:=gen_random_uuid();
  n.message:='✅ [울산 도선 감시 클라우드 전송 테스트]'||chr(10)||'Supabase Edge → Telegram 연결 확인입니다.'||chr(10)||'실제 도선중단·재개 알림이 아닙니다. 감시 활성화 전 테스트입니다.'||chr(10)||'검증 ID: '||n.id;
  insert into public.pilot_notifications(id,notification_key,notification_type,reference_id,message,status,attempts,claimed_at)
    values(n.id,nk,'DELIVERY_TEST',n.id::text,n.message,'SENDING',1,now());
  insert into public.pilot_notification_attempts(notification_id,attempt,started_at,status) values(n.id,1,now(),'SENDING');
  return jsonb_build_object('id',n.id,'message',n.message,'status','SENDING');
end $$;
revoke all on function public.pilot_claim_delivery_test() from public,anon,authenticated;
grant execute on function public.pilot_claim_delivery_test() to service_role;
commit;
