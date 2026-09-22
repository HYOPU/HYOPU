begin;
-- Approved separation from the unrelated HYOPU operations portal. No new Cron,
-- credential rotation, observation reset, budget or delivery-state changes.
do $$declare body text;old_url text:='https://hyopu-ten.vercel.app/api/hpbot-jstt';
 new_url text:='https://hyopu-pilot-bot.vercel.app/api/hpbot-jstt'; sid uuid;current_url text;
begin
 body:=pg_get_functiondef('public.jstt_dispatch_before_twenty_minutes(boolean)'::regprocedure);
 if position('endpoint<>'''||old_url||'''' in body)=0 then
  raise exception 'JSTT_HOST_CONTRACT_REVIEW_REQUIRED';
 end if;
 execute replace(body,'endpoint<>'''||old_url||'''','endpoint<>'''||new_url||'''');
 -- Unit fixtures may not have Vault. Live execution validates the stored URL.
 if to_regclass('vault.decrypted_secrets') is not null then
  select id,decrypted_secret into strict sid,current_url from vault.decrypted_secrets where name='jstt_berth_url';
  if current_url<>old_url then raise exception 'UNEXPECTED_JSTT_HOST';end if;
  perform vault.update_secret(sid,new_url);
 end if;
end $$;
commit;
