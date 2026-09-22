// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, it, expect } from 'vitest';

let db: PGlite;
const json = JSON.stringify;
const at = (minute: number) => new Date(Date.UTC(2026, 8, 22) + minute * 60_000).toISOString();
const ranges = [{ start: '1900-01-01', end: '9999-12-31' }];
const app = (id = '1') => ({ application_id: id, vessel_name: `SHIP ${id}`, callsign: `CALL${id}`,
  pilot_date: '2026-09-22', pilot_time: '12:00', from_location: 'P/S', to_location: 'OTK(S)',
  application_status: '020', completion_status: 'ACTIVE', agent: '협운', remarks: '',
  forecast_status: 'DENSE FOG', match_basis: 'UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE' });
const forecast = (id = '1', status = 'DENSE FOG') => ({ identity: `public${id}`, ...app(id), status, raw_status: status, cancelled: false });
const migration = (suffix: string) => readFileSync(`supabase/migrations/${suffix}.sql`, 'utf8');
const core = () => db.exec(migration('20260922003600_pilot_suspension_core'));
const presentation = () => db.exec(migration('20260922003700_pilot_suspension_presentation'));
async function rpc(name: string, args: any[] = []) {
  return (await db.query<any>(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) v`, args)).rows[0].v;
}
async function tick(minute: number, applications: any[] | null, forecasts: any[] | null) {
  const lease = await rpc('hpbot_begin', [at(minute)]);expect(lease.token).toBeTruthy();
  return rpc('hpbot_commit', [lease.token, lease.version,
    applications ? `${minute + 1}`.padStart(64, '0') : lease.application_hash,
    forecasts ? `${minute + 101}`.padStart(64, '0') : lease.forecast_hash,
    applications ? json(applications) : null, forecasts ? json(forecasts) : null,
    json(ranges), null, null, 1000, at(minute)]);
}
async function ledger(id: string, keys: string[], oldStatus = 'UNSPECIFIED', nextStatus = 'DENSE FOG') {
  const old = { ...app(id), forecast_status: oldStatus };
  const changes = [{ type: 'STATUS_CHANGED', old, new: { ...old, forecast_status: nextStatus }, operational_continuous: true }];
  await db.query('insert into pilot_schedule_notification_events(external_key,revision,run_id,change_hash,changes,notification_keys,created_at) values($1,1,$2,$3,$4,$5,$6)',
    [`1002:${id}`, crypto.randomUUID(), `hash-${id}`, json(changes), keys, at(0)]);
}
async function receipt(key: string, status = 'PENDING', attempts = 0, type = 'SCHEDULE_CHANGE', reference = 'run') {
  return (await db.query<any>('insert into pilot_notifications(notification_key,notification_type,reference_id,message,status,attempts,telegram_message_id) values($1,$2,$3,$4,$5,$6,$7) returning id',
    [key, type, reference, `original ${key}`, status, attempts, status === 'SENT' ? 777 : null])).rows[0].id;
}
beforeEach(async () => {
  db = new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for (const name of ['20260920000000_ulsan_pilot_watcher', '20260920000300_hpbot_operations',
    '20260920000400_hpbot_telegram', '20260920000500_hpbot_query_context', '20260920000600_hpbot_mooring',
    '20260920001000_pilot_registration_status', '20260920001300_pilot_pob_date_labels', '20260921001500_pilot_pob_identity',
    '20260921001600_pilot_concise_notifications', '20260922002400_pilot_notification_policy',
    '20260922002500_pilot_event_titles', '20260922003400_pilot_event_presentation', '20260922003500_pilot_query_presentation']) {
    await db.exec(migration(name));
  }
  await db.exec(`update pilot_watcher_control set enabled=true,billing_verified_at='2026-09-01',cycle_start='2000-01-01',cycle_end='2100-01-01';
    update hpbot_control set alerts_enabled=true,bootstrap_done=true,primary_chat_id='-1';
    insert into pilot_telegram_chats(chat_id)values('-1');`);
}, 30_000);
afterEach(async () => { await db?.close(); });

it('core cutover preserves active incident, snapshots and attempted receipts while fencing old candidates once', async () => {
  await tick(0, [app(), app('2')], [forecast(), forecast('2', 'PORT CLOSE')]);
  const event = crypto.randomUUID();
  await db.query(`insert into pilot_weather_events(id,started_at,max_bad_weather_count,suspension_notification_sent_at)
    values($1,$2,5,$3)`, [event, at(-100), at(-99)]);
  await db.query(`update pilot_weather_state set status='SUSPENDED',event_id=$1,started_at=$2,candidate_count=7,
    rearm_count=1,recovery_started_at=$3`, [event, at(-100), at(-25)]);
  await receipt('weather_suspend:old', 'SENT', 1, 'WEATHER_SUSPEND', event);
  await receipt('unknown:old', 'UNKNOWN', 1);
  const beforeState = (await db.query<any>('select * from pilot_weather_state')).rows[0];
  const beforeControl = (await db.query<any>('select * from pilot_watcher_control')).rows[0];
  const beforeEvent = (await db.query<any>('select id,started_at,suspension_notification_sent_at,max_bad_weather_count from pilot_weather_events')).rows[0];
  const beforeReceipts = (await db.query<any>('select * from pilot_notifications order by notification_key')).rows;
  const snapshots = (await db.query<any>('select id,content_hash,rows from pilot_snapshots')).rows;
  await core();
  const afterState = (await db.query<any>('select * from pilot_weather_state')).rows[0];
  expect(afterState).toMatchObject({ status: 'SUSPENDED', event_id: event, started_at: beforeState.started_at,
    candidate_count: 0, rearm_count: 0, recovery_started_at: null, suspension_total_count: 2, dense_fog_count: 1, port_close_count: 1 });
  expect((await db.query<any>('select id,started_at,suspension_notification_sent_at,max_bad_weather_count from pilot_weather_events')).rows[0]).toEqual(beforeEvent);
  const afterControl = (await db.query<any>('select * from pilot_watcher_control')).rows[0];
  expect(afterControl.snapshot_id).toBe(beforeControl.snapshot_id);expect(afterControl.version).toBe(Number(beforeControl.version) + 1);
  expect(afterControl.continuous).toBe(false);
  expect((await db.query<any>('select * from pilot_notifications order by notification_key')).rows).toEqual(beforeReceipts);
  expect((await db.query<any>('select id,content_hash,rows from pilot_snapshots')).rows).toEqual(snapshots);
  // First healthy canonical feed after deployment is a new continuity baseline,
  // not two new entry messages or a duplicate suspension notification.
  await tick(1, null, [forecast('1', 'DENSE_FOG'), forecast('2', 'PORT_CLOSE')]);
  expect((await db.query<any>('select * from pilot_notifications order by notification_key')).rows).toEqual(beforeReceipts);
  expect((await db.query('select count(*)::int n from pilot_schedule_notification_events')).rows[0].n).toBe(0);
  // Runtime progress after the one-time fence must survive the presentation
  // migration and subsequent source observations.
  await db.query("update pilot_weather_state set recovery_started_at=$1,candidate_count=1,rearm_count=1", [at(1)]);
  await presentation();
  expect((await db.query<any>('select candidate_count,rearm_count,recovery_started_at from pilot_weather_state')).rows[0])
    .toEqual({ candidate_count: 1, rearm_count: 1, recovery_started_at: new Date(at(1)) });
});

it('presentation rewrites only wholly unattempted families and preserves their keys, IDs and revisions', async () => {
  for (const [index, status] of ['PENDING', 'SENT', 'UNKNOWN', 'SENDING', 'PENDING'].entries()) {
    const key = `status-${index}`;await ledger(String(index + 1), [key]);await receipt(key, status, index ? 1 : 0);
  }
  const before = (await db.query<any>('select * from pilot_notifications order by notification_key')).rows;
  const events = (await db.query<any>('select * from pilot_schedule_notification_events order by external_key')).rows;
  await core();await presentation();
  const after = (await db.query<any>('select * from pilot_notifications order by notification_key')).rows;
  expect(after).toHaveLength(before.length);
  expect(after[0].message.split('\n')[0]).toBe('🌫️ [DENSE FOG]');
  expect({ ...after[0], message: before[0].message }).toEqual(before[0]);
  for (let index = 1; index < before.length; index++) expect(after[index]).toEqual(before[index]);
  expect((await db.query<any>('select * from pilot_schedule_notification_events order by external_key')).rows).toEqual(events);
});

it('partial delivery and persisted attempt evidence prevent rewriting or creating replacement keys', async () => {
  await ledger('1', ['part-0', 'part-1']);await receipt('part-0', 'SENT', 1);await receipt('part-1');
  await ledger('2', ['attempted']);const id = await receipt('attempted');
  await db.query("insert into pilot_notification_attempts(notification_id,attempt,started_at,status)values($1,1,$2,'UNKNOWN')", [id, at(0)]);
  const before = (await db.query<any>('select * from pilot_notifications order by notification_key')).rows;
  await core();await presentation();
  expect((await db.query<any>('select * from pilot_notifications order by notification_key')).rows).toEqual(before);
  expect((await db.query('select count(*)::int n from pilot_notification_attempts')).rows[0].n).toBe(1);
});

it.each(['DENSE_FOG', 'PORT_CLOSE'])('pending resume reconstruction uses saved actual %s reason, not current global status', async prior => {
  await core();
  const event = crypto.randomUUID();
  await db.query(`insert into pilot_weather_events(id,started_at,resume_detected_at,resume_schedule_key,resume_method,max_bad_weather_count,resume_previous_status)
    values($1,$2,$3,'1002:1','HYOPU_TRANSITION',9,$4)`, [event, at(-60), at(0), prior]);
  await ledger('1', ['resume'], prior, 'PROCESSING');const id = await receipt('resume', 'PENDING', 0, 'WEATHER_RESUME', event);
  // Current aggregate is deliberately unrelated to the saved vessel transition.
  await db.exec("update pilot_weather_state set status='SUSPENDED',bad_weather_count=9,suspension_total_count=9");
  const before = (await db.query<any>('select * from pilot_notifications')).rows[0];
  await presentation();
  const after = (await db.query<any>('select * from pilot_notifications')).rows[0];
  expect(after.id).toBe(id);expect(after.notification_type).toBe('WEATHER_RESUME');
  expect(after.message).toContain(`재개 근거: 동일 일정 ${prior.replace('_', ' ')} → PROCESSING`);
  expect(after.message).not.toContain('BAD WEATHER → PROCESSING');
  expect(after.message).toContain('공개: PROCESSING');
  expect({ ...after, message: before.message }).toEqual(before);
  expect((await db.query('select count(*)::int n from pilot_notifications')).rows[0].n).toBe(1);
});
