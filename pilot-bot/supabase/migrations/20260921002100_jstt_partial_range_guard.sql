-- Fail closed on a large loss of in-window rows, including repeated bad hashes.
-- Retain the last complete snapshot, missing counters, cursors and berth events.
begin;
do $migration$
declare definition text; original text; replacement text;
begin
 select pg_get_functiondef('public.jstt_apply(uuid,bigint,text,jsonb,bigint,integer,timestamptz)'::regprocedure) into definition;
 original:=$old$ if p_rows is not null and c.candidate_hash is distinct from p_hash then
  select count(*) into previous_count from public.jstt_schedule_state where missing_count=0 and left(schedule_datetime,10) between today and finish;
  if (previous_count>0 and jsonb_array_length(p_rows)=0) or (previous_count>=10 and jsonb_array_length(p_rows)<previous_count/4) then
   perform public.jstt_fail(p_id,'JSTT_COUNT_DROP',p_at);
   update public.jstt_monitor_control set candidate_hash=p_hash where id;
   return jsonb_build_object('accepted',false,'error','JSTT_COUNT_DROP');
  end if;
 end if;$old$;
 replacement:=$new$ if p_rows is not null then
  select count(*) into previous_count from public.jstt_schedule_state
   where source_status<>'이안' and left(schedule_datetime,10) between today and finish;
  if (previous_count>0 and jsonb_array_length(p_rows)=0)
    or (previous_count>=10 and jsonb_array_length(p_rows)*2<previous_count) then
   perform public.jstt_fail(p_id,'JSTT_PARTIAL_RANGE',p_at);
   return jsonb_build_object('accepted',false,'error','JSTT_PARTIAL_RANGE');
  end if;
 end if;$new$;
 if position(original in definition)=0 then raise exception 'JSTT_APPLY_CONTRACT_CHANGED'; end if;
 execute replace(definition,original,replacement);
end $migration$;
commit;
