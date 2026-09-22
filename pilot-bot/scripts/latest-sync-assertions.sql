-- Pure assertions: no collection, external submission, queue or Telegram send.
do $$
declare counts jsonb;rows jsonb;first jsonb;second jsonb;resumed jsonb;s jsonb;messages text[];a jsonb;changes jsonb;before_state jsonb;
begin
 rows:='[{"identity":"a","callsign":"A","vessel_name":"CHECK A","pilot_date":"2026-09-22","pilot_time":"07:00","from_location":"P/S","to_location":"OTK(S)","agent":"협운","status":"DENSE FOG","cancelled":false,"application_id":"1"},
 {"identity":"b","callsign":"B","vessel_name":"CHECK B","pilot_date":"2026-09-22","pilot_time":"08:00","from_location":"P/S","to_location":"JSTT","agent":"타대리점","status":"PORT CLOSE","cancelled":false}]';
 counts:=public.pilot_suspension_counts(rows);
 if counts->>'suspension_total_count'<>'2' or counts->>'bad_weather_count'<>'0' or counts->>'dense_fog_count'<>'1' or counts->>'port_close_count'<>'1' then raise exception 'COUNTS_MISMATCH';end if;
 counts:=public.pilot_suspension_counts(rows||jsonb_build_array((rows->0)||'{"status":"PORT_CLOSE"}'));
 if counts->>'suspension_total_count'<>'2' or counts->>'port_close_count'<>'2' or counts->>'dense_fog_count'<>'0' then raise exception 'REPRESENTATIVE_DUPLICATE';end if;
 s:='{"status":"NORMAL","candidate_count":0,"rearm_count":0,"recovery_started_at":null}';
 first:=public.pilot_plan('[]',rows,s,false,'2026-09-22 00:00:00Z');
 second:=public.pilot_plan(first->'rows',rows,first->'state',true,'2026-09-22 00:01:00Z');
 if second#>>'{state,status}'<>'SUSPENDED' or jsonb_array_length(second->'events')<>1 then raise exception 'SUSPEND_TRANSITION';end if;
 resumed:=public.pilot_plan(second->'rows',jsonb_build_array((rows->0)||'{"status":"PROCESSING"}',rows->1),second->'state',true,'2026-09-22 00:02:00Z');
 if resumed#>>'{state,status}'<>'RESUMED' or resumed#>>'{events,0,previous_status}'<>'DENSE_FOG' then raise exception 'RESUME_EVIDENCE';end if;
 if position('DENSE FOG → PROCESSING' in public.pilot_weather_message(resumed#>'{events,0}',resumed->'state','2026-09-22 00:02:00Z'))=0 then raise exception 'RESUME_MESSAGE';end if;
 a:='{"application_id":"CHECK","vessel_name":"PREVIEW","application_status":"020","completion_status":"ACTIVE","pilot_date":"2026-09-22","pilot_time":"07:30","from_location":"P/S","to_location":"OTK(S)","match_basis":"UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE","forecast_status":"UNSPECIFIED","display_sequence":1}';
 changes:=jsonb_build_array(jsonb_build_object('type','TIME_CHANGED','old',a,'new',a||'{"pilot_time":"07:35"}','operational_continuous',true));
 if public.hpbot_notification_title(changes)<>'⏰ [도선시간 변경]' then raise exception 'TIME_TITLE';end if;
 changes:=jsonb_build_array(jsonb_build_object('type','TIME_CHANGED','old',a,'new',a||'{"pilot_date":"2026-09-23"}','operational_continuous',true));
 if public.hpbot_notification_title(changes)<>'📅 [도선일자 변경]' then raise exception 'DATE_TITLE';end if;
 changes:=jsonb_build_array(jsonb_build_object('type','STATUS_CHANGED','old',a,'new',a||'{"forecast_status":"DENSE_FOG"}','operational_continuous',true));
 messages:=public.hpbot_schedule_messages(changes);
 if cardinality(messages)<>1 or split_part(messages[1],chr(10),1)<>'🌫️ [DENSE FOG]' or position('공개:' in messages[1])>0 or position('신청:' in messages[1])>0 then raise exception 'FOG_PRESENTATION';end if;
 changes:=jsonb_build_array(jsonb_build_object('type','STATUS_CHANGED','old',a||'{"forecast_status":"DENSE FOG"}','new',a||'{"forecast_status":"DENSE_FOG"}','operational_continuous',true));
 if cardinality(public.hpbot_schedule_messages(changes))<>0 then raise exception 'CANONICAL_NOISE';end if;
 if to_regclass('pg_temp.suspension_cutover_before') is not null then
  select state into before_state from suspension_cutover_before;
  if exists(select 1 from public.pilot_weather_state w where to_jsonb(w)->'event_id' is distinct from before_state->'event_id'
   or to_jsonb(w)->'started_at' is distinct from before_state->'started_at' or w.status is distinct from before_state->>'status') then raise exception 'ACTIVE_INCIDENT_CHANGED';end if;
  if (select receipts from suspension_cutover_before) is distinct from
   (select md5(coalesce(jsonb_agg(to_jsonb(n) order by n.id)::text,'[]')) from public.pilot_notifications n where status in('SENT','SENDING','UNKNOWN')) then raise exception 'ATTEMPTED_RECEIPT_CHANGED';end if;
 end if;
end $$;
