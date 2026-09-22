-- A complete collection can include quarantined berth values. Do not label
-- last_success as a fully verified berth observation in subsequent errors.
begin;
do $$declare body text;begin
 body:=pg_get_functiondef('public.jstt_fail(uuid,text,timestamptz)'::regprocedure);
 if position('마지막 정상확인: ' in body)=0 then raise exception 'JSTT_FAILURE_LABEL_CONTRACT_CHANGED';end if;
 execute replace(body,'마지막 정상확인: ','마지막 수집: ');
end $$;
commit;
