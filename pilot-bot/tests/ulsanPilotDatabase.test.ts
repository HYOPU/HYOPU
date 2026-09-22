// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';

let db: PGlite;
const migration = readFileSync('supabase/migrations/20260920000000_ulsan_pilot_watcher.sql','utf8');
const at = (minute:number) => new Date(Date.UTC(2026,8,20,0,minute)).toISOString();
const row = (id:string,status='BAD_WEATHER',agent='협운',extra={}) => ({identity:id,vessel_name:id,callsign:id,pilot_date:'2026-09-20',pilot_time:'12:00',from_location:'P/S',to_location:'OTK',agent,status,raw_status:status,remarks:'',cancelled:false,...extra});
async function rpc(name:string,args:unknown[]=[]) {
  return (await db.query<{result:any}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) as result`,args)).rows[0].result;
}
async function scalar(sql:string) { return Object.values((await db.query(sql)).rows[0] as object)[0]; }
let lastHash:string|null, counter:number;
async function tick(minute:number,rows:any[]|null) {
  const b=await rpc('pilot_begin',[at(minute)]);
  if(!b.token) return b;
  const hash=rows ? (++counter).toString(16).padStart(64,'0') : lastHash;
  const r=await rpc('pilot_commit',[b.token,b.version,hash,rows===null?null:JSON.stringify(rows),1000,at(minute)]);
  if(r.accepted) lastHash=hash;
  return r;
}
beforeAll(async()=>{
  db=new PGlite(); await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(migration);
  await db.exec(readFileSync('supabase/migrations/20260920000200_ulsan_pilot_delivery_test.sql','utf8'));
  // pg_net/pg_cron are not supported by PGlite. These explicit adapters test
  // scheduler gating/parameters only, NOT a real Supabase network invocation.
  await db.exec(`create schema vault; create schema net; create schema cron;
    create table vault.decrypted_secrets(name text,decrypted_secret text);
    insert into vault.decrypted_secrets values('ulsan_watcher_url','https://example.supabase.co/functions/v1/ulsan-pilot-watcher'),('ulsan_watcher_key',repeat('w',40)),('ulsan_gateway_anon_jwt','eyJtest.payload.signature');
    create table public.test_http_calls(id bigint generated always as identity,url text,headers jsonb,body jsonb);
    create table public.test_cron_jobs(name text primary key,schedule text,command text);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds int) returns bigint language sql as $$insert into public.test_http_calls(url,headers,body) values(url,headers,body) returning id$$;
    create function cron.schedule(n text,s text,c text) returns bigint language plpgsql as $$begin insert into public.test_cron_jobs values(n,s,c) on conflict(name) do update set schedule=s,command=c;return 1;end$$;`);
  await db.exec(readFileSync('supabase/migrations/20260920000100_ulsan_pilot_cron.sql','utf8').replace(/^create extension.*$/gm,''));
},30000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
  await db.exec(`truncate pilot_current,pilot_history,pilot_snapshots,pilot_weather_events,pilot_notifications,pilot_notification_attempts,pilot_runs,pilot_usage,test_http_calls,test_cron_jobs;
    delete from pilot_watcher_control; insert into pilot_watcher_control(id,enabled,billing_verified_at,cycle_start,cycle_end) values(true,true,'2026-09-01','2000-01-01','2100-01-01');
    delete from pilot_weather_state; insert into pilot_weather_state(id) values(true);`);
  lastHash=null;counter=0;
});
describe('PostgreSQL watcher transactions',()=>{
  it('cloud delivery preflight reserves once while disabled, never resends, and preserves observations',async()=>{
    await db.exec(`update pilot_watcher_control set enabled=false,cycle_start=now()-interval '1 day',cycle_end=now()+interval '1 day',billing_evidence='{"plan":"Free"}'`);
    const a=await rpc('pilot_claim_delivery_test');expect(a.message).toContain('전송 테스트');
    const b=await rpc('pilot_claim_delivery_test');expect(b.id).toBe(a.id);expect(b.message).toBeUndefined();
    expect(await scalar("select estimated_bytes::int from pilot_usage where scope like 'cycle:%'")).toBe(16384);
    expect(await scalar('select count(*)::int from pilot_runs')).toBe(0);
    expect(await scalar('select enabled from pilot_watcher_control')).toBe(false);
    await rpc('pilot_finish_notification',[a.id,'SENT',99]);
    expect((await rpc('pilot_claim_delivery_test')).status).toBe('SENT');
  });
  it('cloud delivery preflight rejects enabled watcher or insufficient budget',async()=>{
    await expect(rpc('pilot_claim_delivery_test')).rejects.toThrow('DELIVERY_TEST_NOT_APPROVED');
    await db.exec(`update pilot_watcher_control set enabled=false,day_limit=16384,cycle_start=now()-interval '1 day',cycle_end=now()+interval '1 day',billing_evidence='{"plan":"Free"}'`);
    await expect(rpc('pilot_claim_delivery_test')).rejects.toThrow('DELIVERY_TEST_BUDGET');
    expect(await scalar('select count(*)::int from pilot_notifications')).toBe(0);
  });
  it('1 → 2 → 3, one suspension; first baseline is silent',async()=>{
    await tick(0,[row('A')]);await tick(1,[row('A'),row('B')]);await tick(2,[row('A'),row('B'),row('C')]);
    expect(await scalar('select status from pilot_weather_state')).toBe('SUSPENDED');
    expect(await scalar("select count(*)::int from pilot_notifications where notification_type='WEATHER_SUSPEND'")).toBe(1);
  });
  it('same Hyopu operation resumes once, lingering bad rows do not suspend; rearm creates next event',async()=>{
    await tick(0,[row('A'),row('B'),row('C'),row('D')]);await tick(1,null);
    await tick(2,[row('A','PROCESSING'),row('B'),row('C'),row('D')]);
    expect(await scalar('select status from pilot_weather_state')).toBe('RESUMED');
    await tick(3,[row('A','PROCESSING'),row('B','PROCESSING'),row('C'),row('D')]);await tick(4,null);
    expect(await scalar('select status from pilot_weather_state')).toBe('RESUMED');
    expect(await scalar("select count(*)::int from pilot_notifications where notification_type='WEATHER_RESUME'")).toBe(1);
    await tick(5,[row('C')]);await tick(6,null);
    expect(await scalar('select status from pilot_weather_state')).toBe('NORMAL');
    await tick(7,[row('C'),row('D')]);await tick(8,null);
    expect(await scalar("select count(*)::int from pilot_weather_events")).toBe(2);
  });
  it.each(['other_agent','new','cancel','duplicate','route','day','gap','failure'])('does not infer resume for %s',async kind=>{
    const base=[row('A','BAD_WEATHER',kind==='other_agent'?'기타':'협운'),row('B')];
    await tick(0,base);await tick(1,null);
    let rows=[row('A','PROCESSING',kind==='other_agent'?'기타':'협운'),row('B')];let minute=2;
    if(kind==='new') rows=[...base,row('NEW','PROCESSING')];
    if(kind==='cancel') rows=[row('A','CANCELLED','협운',{cancelled:true,raw_status:'PROCESSING'}),row('B')];
    if(kind==='duplicate') rows.push(row('A','PROCESSING'));
    if(kind==='route') rows=[row('A-ROUTE','PROCESSING','협운',{callsign:'A',vessel_name:'A',to_location:'NEW'}),row('B')];
    if(kind==='day') rows=[row('A-DAY','PROCESSING','협운',{callsign:'A',vessel_name:'A',pilot_date:'2026-09-21'}),row('B')];
    if(kind==='gap') minute=3;
    if(kind==='failure') {const b=await rpc('pilot_begin',[at(2)]);await rpc('pilot_fail',[b.token,'HTTP_TIMEOUT',at(2)]);minute=3;}
    await tick(minute,rows);
    expect(await scalar('select status from pilot_weather_state')).toBe('SUSPENDED');
    expect(await scalar("select count(*)::int from pilot_notifications where notification_type='WEATHER_RESUME'")).toBe(0);
  });
  it('zero for 30 minutes is fallback; an error resets the full timer',async()=>{
    await tick(0,[row('A'),row('B')]);await tick(1,null);
    await tick(2,[row('A','UNSPECIFIED'),row('B','UNSPECIFIED')]);
    for(let i=3;i<20;i++)await tick(i,null);
    const b=await rpc('pilot_begin',[at(20)]);await rpc('pilot_fail',[b.token,'TIMEOUT',at(20)]);
    for(let i=21;i<51;i++)await tick(i,null);
    expect(await scalar('select status from pilot_weather_state')).toBe('SUSPENDED');await tick(51,null);
    expect(await scalar('select resume_method from pilot_weather_events')).toBe('ZERO_30_MINUTES');
  });
  it('serializes overlapping leases, refuses duplicate minute and stale commit',async()=>{
    const b=await rpc('pilot_begin',[at(0)]);
    expect((await rpc('pilot_begin',[at(0)])).skip).toBe('BUSY');
    await rpc('pilot_fail',[b.token,'TEST',at(0)]);
    expect((await rpc('pilot_begin',[at(0)])).skip).toBe('DUPLICATE_SLOT');
    await expect(rpc('pilot_commit',[b.token,b.version,'a'.repeat(64),JSON.stringify([row('A')]),0,at(0)])).rejects.toThrow('STALE_EXECUTION');
  });
  it('5 failures emit one outage and recovery; no schedule comparison across outage',async()=>{
    await tick(0,[row('A'),row('B')]);await tick(1,null);
    for(let i=2;i<9;i++){const b=await rpc('pilot_begin',[at(i)]);await rpc('pilot_fail',[b.token,'TIMEOUT',at(i)]);}
    await tick(9,[row('A','PROCESSING'),row('B')]);
    expect(await scalar("select count(*)::int from pilot_notifications where notification_type='SOURCE_ERROR'")).toBe(1);
    expect(await scalar("select count(*)::int from pilot_notifications where notification_type='SOURCE_RECOVERY'")).toBe(1);
    expect(await scalar("select count(*)::int from pilot_history")).toBe(0);
  });
  it('read-only preview leaves all state unchanged',async()=>{
    await tick(0,[row('A'),row('B')]);
    const before=await scalar('select row_to_json(c)::text from pilot_watcher_control c');
    const preview=await rpc('pilot_preview',[JSON.stringify([row('A'),row('B')]),at(1)]);
    expect(preview.next_state.status).toBe('SUSPENDED');
    expect(await scalar('select row_to_json(c)::text from pilot_watcher_control c')).toBe(before);
    await tick(1,null);
    expect(preview.expected_telegram_messages[0]).toBe(await scalar("select message from pilot_notifications where notification_type='WEATHER_SUSPEND'"));
  });
  it('atomic budget stop only disables watcher, cannot mint events while stopped',async()=>{
    await db.exec('update pilot_watcher_control set day_limit=24576;');
    await tick(0,[row('A')]);await tick(1,null);expect((await tick(2,[row('A'),row('B')])).skip).toBe('DISABLED_OR_BUDGET');
    expect(await scalar('select enabled from pilot_watcher_control')).toBe(false);
    expect(await scalar("select count(*)::int from pilot_notifications where notification_type='COST_STOP'")).toBe(1);
    expect(await scalar('select count(*)::int from pilot_weather_events')).toBe(0);
    await tick(3,[row('A'),row('B')]);
    expect(await scalar("select count(*)::int from pilot_notifications where notification_type='COST_STOP'")).toBe(1);
  });
  it('31 days unchanged: one stored snapshot, 44,640 observations; no repeated suspension',async()=>{
    await tick(0,[row('A'),row('B')]);
    // Commit in hourly batches. One 31-day transaction is not representative
    // of cron and causes quadratic MVCC tuple chains in an embedded engine.
    for(let first=1;first<44640;first+=60) await db.exec(`do $$ declare b jsonb; t timestamptz; i int; begin
      for i in ${first}..${Math.min(first+59,44639)} loop
        t:='2026-09-20T00:00:00Z'::timestamptz+make_interval(mins=>i);
        b:=public.pilot_begin(t);
        if b->>'token' is null then raise exception 'UNEXPECTED_STOP % %',i,b; end if;
        perform public.pilot_commit((b->>'token')::uuid,(b->>'version')::bigint,b->>'hash',null,1000,t);
      end loop; end $$;`);
    expect(await scalar('select count(*)::int from pilot_snapshots')).toBe(1);
    expect(await scalar('select count(*)::int from pilot_runs')).toBe(44640);
    expect(await scalar('select count(*)::int from pilot_history')).toBe(0);
    expect(await scalar("select count(*)::int from pilot_notifications where notification_type='WEATHER_SUSPEND'")).toBe(1);
    expect(await scalar("select estimated_bytes::float8 from pilot_usage where scope like 'cycle:%'")).toBe(44640*8192);
    expect(await scalar('select status from pilot_weather_state')).toBe('SUSPENDED');
  },180000);
  it('missing rows are not cancelled, confirmed cancellation is; date roll-over never resumes',async()=>{
    await tick(0,[row('A'),row('B')]);await tick(1,[row('B')]);
    expect(await scalar('select count(*)::int from pilot_history')).toBe(0);
    await tick(2,[row('B','CANCELLED','협운',{cancelled:true,raw_status:'PROCESSING'})]);
    expect(await scalar("select count(*)::int from pilot_history where event_type='CANCELLED'")).toBe(1);
  });
  it('notification claims persist across deployments, UNKNOWN never retried, sent timestamp stored',async()=>{
    await tick(0,[row('A'),row('B')]);await tick(1,null);
    await db.exec("update pilot_notifications set next_attempt_at='2026-09-20';");
    const n=await rpc('pilot_claim_notification',[at(2)]);expect(n.message).toContain('도선중단');
    await rpc('pilot_finish_notification',[n.id,'UNKNOWN',null,'TIMEOUT',null,at(2)]);
    await tick(2,null);
    expect(await rpc('pilot_claim_notification',[at(3)])).toBeNull();
    expect(await scalar('select status from pilot_notification_attempts')).toBe('UNKNOWN');
    await tick(3,[row('A','PROCESSING'),row('B')]);
    await db.exec("update pilot_notifications set next_attempt_at='2026-09-20';");
    const resume=await rpc('pilot_claim_notification',[at(4)]);
    await rpc('pilot_finish_notification',[resume.id,'SENT',123,null,null,at(4)]);
    expect(await scalar('select resume_alert_sent from pilot_weather_state')).toBe(true);
    expect(await scalar('select telegram_message_id::int from pilot_notifications where id=\''+resume.id+'\'')).toBe(123);
  });
  it('retains attempt history across bounded 429 retries and expires interrupted send as UNKNOWN',async()=>{
    await rpc('pilot_queue',['test','TEST','test','test']);
    await db.exec("update pilot_notifications set next_attempt_at='2026-09-20';");
    const n=await rpc('pilot_claim_notification',[at(0)]);
    await rpc('pilot_finish_notification',[n.id,'RATE_LIMITED',null,'429',120,at(0)]);
    expect(await rpc('pilot_claim_notification',[at(1)])).toBeNull();
    expect((await rpc('pilot_claim_notification',[at(2)])).id).toBe(n.id);
    expect(await rpc('pilot_claim_notification',[at(5)])).toBeNull();
    expect(await scalar('select status from pilot_notifications')).toBe('UNKNOWN');
    expect(await scalar('select count(*)::int from pilot_notification_attempts')).toBe(2);
  });
  it('manual enable requires provider evidence; resets continuity without clearing event/deduplication',async()=>{
    await tick(0,[row('A'),row('B')]);await tick(1,null);await rpc('pilot_disable');
    await expect(rpc('pilot_enable',[JSON.stringify({plan:'Pro',spend_cap_enabled:false}),at(0),at(60)])).rejects.toThrow('BILLING_OR_DELIVERY_NOT_VERIFIED');
    const start=new Date(Date.now()-3600000).toISOString(),end=new Date(Date.now()+86400000).toISOString();
    await rpc('pilot_enable',[JSON.stringify({plan:'Pro',spend_cap_enabled:true,organization_remaining_bytes:536870912,project_ref:'test',verified_by:'test',telegram_verified:true}),start,end]);
    expect(await scalar('select continuous from pilot_watcher_control')).toBe(false);
    expect(await scalar('select count(*)::int from pilot_weather_events')).toBe(1);
  });
  it('browser roles cannot read watcher tables or call reducers',async()=>{
    await db.exec('set role anon');
    await expect(db.query('select * from pilot_weather_state')).rejects.toThrow('permission denied');
    await expect(rpc('pilot_begin')).rejects.toThrow('permission denied');
    await db.exec('reset role');
  });
  it('reserves alert bursts atomically and claims the emergency stop before cron is disabled',async()=>{
    await db.exec('update pilot_watcher_control set day_limit=24576');
    await tick(0,[row('A')]);
    await rpc('pilot_queue',['burst','TEST','burst','가'.repeat(2000)]);
    await db.exec("update pilot_notifications set next_attempt_at='2026-09-20'");
    const n=await rpc('pilot_claim_notification',[at(1)]);
    expect(n.message).toContain('비용 보호 중지');
    expect(await scalar('select enabled from pilot_watcher_control')).toBe(false);
    expect(await scalar("select estimated_bytes::int from pilot_usage where scope like 'day:%'")).toBe(16384);
    await rpc('pilot_finish_notification',[n.id,'SENT',1,null,null,at(1)]);
    expect(await rpc('pilot_claim_notification',[at(2)])).toBeNull();
  });
  it('large changed payload is reserved before commit; failed reservation keeps the old snapshot',async()=>{
    await db.exec('update pilot_watcher_control set day_limit=32768');
    await tick(0,[row('A')]); const b=await rpc('pilot_begin',[at(1)]);
    expect(await rpc('pilot_reserve_extra',[b.token,30000,at(1)])).toBe(false);
    await expect(rpc('pilot_commit',[b.token,b.version,'e'.repeat(64),JSON.stringify([row('A'),row('B')]),1000,at(1)])).rejects.toThrow('STALE_EXECUTION');
    expect(await scalar('select count(*)::int from pilot_snapshots')).toBe(1);
  });
  it('abnormal row drop cannot manufacture recovery, even on repeated truncated responses',async()=>{
    await tick(0,Array.from({length:10},(_,i)=>row(String(i))));await tick(1,null);
    const few=[row('0','PROCESSING'),row('1')];
    expect((await rpc('pilot_preview',[JSON.stringify(few),at(2)])).reason).toBe('ABNORMAL_ROW_DROP');
    expect((await tick(2,few)).accepted).toBe(false);expect((await tick(3,few)).accepted).toBe(false);
    expect(await scalar('select status from pilot_weather_state')).toBe('SUSPENDED');
  });
  it('warning emitted once per billing cycle, without changing weather state',async()=>{
    await db.exec('update pilot_watcher_control set warning_limit=16384,cycle_limit=65536');
    for(let i=0;i<4;i++)await tick(i,i===0?[row('A')]:null);
    expect(await scalar("select count(*)::int from pilot_notifications where notification_type='COST_WARNING'")).toBe(1);
  });
  it('cron gate invokes once per minute, reserves dispatch, disabled invokes nothing',async()=>{
    await rpc('pilot_cron_tick');await rpc('pilot_cron_tick');
    expect(await scalar('select count(*)::int from test_http_calls')).toBe(1);
    expect(await scalar("select headers->>'Authorization' from test_http_calls")).toBe('Bearer eyJtest.payload.signature');
    expect(await scalar("select estimated_bytes::int from pilot_usage where scope like 'cycle:%'")).toBe(1024);
    await rpc('pilot_disable');await rpc('pilot_cron_tick');
    expect(await scalar('select count(*)::int from test_http_calls')).toBe(1);
  });
  it('cron budget stop reserves emergency and invokes only once more for its stop alert',async()=>{
    await db.exec('update pilot_watcher_control set day_limit=16384');
    await rpc('pilot_reserve',[8192]);await rpc('pilot_cron_tick');await rpc('pilot_cron_tick');
    expect(await scalar('select count(*)::int from test_http_calls')).toBe(1);
    expect(await scalar('select enabled from pilot_watcher_control')).toBe(false);
    expect(await scalar("select estimated_bytes::int from pilot_usage where scope like 'day:%'")).toBe(16384);
  });
  it('cron install is gated and idempotent; no jobs are installed by migration',async()=>{
    expect(await scalar('select count(*)::int from test_cron_jobs')).toBe(0);
    await rpc('pilot_install_cron');await rpc('pilot_install_cron');
    expect(await scalar('select count(*)::int from test_cron_jobs')).toBe(2);
    await rpc('pilot_disable');await expect(rpc('pilot_install_cron')).rejects.toThrow('WATCHER_NOT_APPROVED');
  });
  it('billing cycle reservation is timezone-independent',async()=>{
    await rpc('pilot_reserve',[1024,at(0)]);
    await db.exec("set timezone='Asia/Seoul'");
    await rpc('pilot_reserve',[1024,at(0)]);
    expect(await scalar("select count(*)::int from pilot_usage where scope like 'cycle:%'")).toBe(1);
    expect(await scalar("select estimated_bytes::int from pilot_usage where scope like 'cycle:%'")).toBe(2048);
    await db.exec("set timezone='UTC'");
  });
  it('more than 90 seconds breaks continuity even in the next minute slot',async()=>{
    await tick(0,[row('A'),row('B')]);await tick(1,null);
    const time='2026-09-20T00:02:59Z',b=await rpc('pilot_begin',[time]);
    await rpc('pilot_commit',[b.token,b.version,'e'.repeat(64),JSON.stringify([row('A','PROCESSING'),row('B')]),1000,time]);
    expect(await scalar('select status from pilot_weather_state')).toBe('SUSPENDED');
  });
});
