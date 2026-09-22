begin;
-- HYOPU uses an isolated Vercel route, not the original Dongjin route.
-- Tighten to the exact approved deployment, not a broader arbitrary URL regex.
do $$declare body text; needle text:='endpoint!~''^https://[a-z0-9.-]+/api/jstt_berth_watch$''';begin
 body:=pg_get_functiondef('public.jstt_dispatch_before_twenty_minutes(boolean)'::regprocedure);
 if position(needle in body)=0 then raise exception 'JSTT_DISPATCH_CONTRACT_REVIEW_REQUIRED';end if;
 execute replace(body,needle,'endpoint<>''https://hyopu-ten.vercel.app/api/hpbot-jstt''');
end $$;
commit;
