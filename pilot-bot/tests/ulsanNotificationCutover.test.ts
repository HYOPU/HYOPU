// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
it('cutover suppresses unsent admin noise, reformats allowed work and preserves sent/unknown receipts',async()=>{
 const db=new PGlite();try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for(const f of ['20260920000000_ulsan_pilot_watcher','20260920000300_hpbot_operations','20260920000400_hpbot_telegram','20260920000500_hpbot_query_context','20260920000600_hpbot_mooring','20260920001300_pilot_pob_date_labels','20260921001500_pilot_pob_identity','20260921001600_pilot_concise_notifications'])await db.exec(readFileSync('supabase/migrations/'+f+'.sql','utf8'));
  const old={application_id:'1',vessel_name:'SHIP',callsign:'CALL1',pilot_date:'2026-09-22',pilot_time:'07:30',from_location:'P/S',to_location:'OTK(S)',application_status:'030',forecast_status:'UNSPECIFIED',match_basis:'UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE'};
  const ids=Array.from({length:6},()=>crypto.randomUUID());
  for(const [i,status] of ['PENDING','PENDING','SENT','UNKNOWN','SENDING','PENDING'].entries()){
   const type=i===0?'STATUS_CHANGED':'TIME_CHANGED';
   await db.query('insert into hpbot_pilot_history(external_key,vessel_name,event_type,old_data,new_data,detected_at,run_id) values($1,$2,$3,$4,$5,now(),$6)',
    ['1002:1','SHIP',type,old,{...old,application_status:'020',pilot_time:i===0?'07:30':'07:35'},ids[i]]);
   await db.query('insert into pilot_notifications(notification_key,notification_type,reference_id,message,status,attempts) values($1,$2,$3,$4,$5,$6)',
    ['hpbot_change:'+ids[i]+':0','SCHEDULE_CHANGE',ids[i],'old receipt '+i,status,status==='PENDING'?0:1]);
  }
  // A partially delivered group must never replay its other chunks.
  await db.query("insert into pilot_notifications(notification_key,notification_type,reference_id,message,status) values($1,'SCHEDULE_CHANGE',$2,'delivered chunk','SENT')",['hpbot_change:'+ids[5]+':1',ids[5]]);
  await db.exec(readFileSync('supabase/migrations/20260922002400_pilot_notification_policy.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/20260922002500_pilot_event_titles.sql','utf8'));
  const ns=(await db.query<any>('select reference_id,status,message,error from pilot_notifications')).rows;
  expect(ns.find(n=>n.reference_id===ids[0])).toMatchObject({status:'FAILED',error:'NOTIFICATION_POLICY_SUPPRESSED'});
  expect(ns.find(n=>n.reference_id===ids[1])).toMatchObject({status:'PENDING'});
  expect(ns.find(n=>n.reference_id===ids[1]).message).toContain('⏰ [도선시간 변경]');
  for(const i of [2,3,4])expect(ns.find(n=>n.reference_id===ids[i]).message).toBe('old receipt '+i);
  expect(ns.find(n=>n.reference_id===ids[5]&&n.message==='old receipt 5')).toMatchObject({status:'FAILED',error:'POLICY_REVIEW_PARTIAL_DELIVERY'});
  expect(ns).toHaveLength(7);
  expect((await db.query<any>('select count(*)::int n from hpbot_pilot_history')).rows[0].n).toBe(6);
 }finally{await db.close();}
},30000);
