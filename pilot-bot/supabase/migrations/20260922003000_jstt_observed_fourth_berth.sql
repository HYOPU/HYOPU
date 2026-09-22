begin;
-- HYOPU cloud probe 2026-09-22, exact VesselSchedule/List, full 30-row range:
-- distinct berth labels: 대기, 3부두, 4부두, N4, 2부두, N3.
-- 4부두 is a concrete berth, never an unassigned fallback.
do $$declare body text; old_clause text:='not in(''UNASSIGNED'',''2부두'',''3부두'',''N3'',''N4'',''N5'')';begin
 body:=pg_get_functiondef('public.jstt_apply(uuid,bigint,text,jsonb,bigint,integer,timestamptz)'::regprocedure);
 if position(old_clause in body)=0 then raise exception 'JSTT_APPLY_CONTRACT_REVIEW_REQUIRED';end if;
 execute replace(body,old_clause,'not in(''UNASSIGNED'',''2부두'',''3부두'',''4부두'',''N3'',''N4'',''N5'')');
end $$;
commit;
