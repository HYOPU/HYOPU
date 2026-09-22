begin;
-- Observed on 2026-09-21: STOLT FOCUS 202609140009 is 수정요청.
-- This source validation addition does not alter berth event semantics.
do $$declare body text;old_clause text:='not in(''계획'',''요청'',''확정'',''접안'',''이안'')';begin
 body:=pg_get_functiondef('public.jstt_apply(uuid,bigint,text,jsonb,bigint,integer,timestamptz)'::regprocedure);
 if position(old_clause in body)=0 then raise exception 'JSTT_APPLY_CONTRACT_REVIEW_REQUIRED';end if;
 execute replace(body,old_clause,'not in(''계획'',''요청'',''수정요청'',''확정'',''접안'',''이안'')');
end $$;
commit;
