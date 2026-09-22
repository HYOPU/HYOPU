// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';

let db: PGlite;
let hash = 0;
const json = JSON.stringify;
const at = (minute: number) => new Date(Date.UTC(2026, 8, 22) + minute * 60_000).toISOString();
const ranges = [{ start: '1900-01-01', end: '9999-12-31' }];
const app = (id = '1', extra: Record<string, unknown> = {}) => ({
  application_id: id, vessel_name: `SHIP ${id}`, callsign: `CALL${id}`,
  pilot_date: '2026-09-22', pilot_time: '12:00', from_location: 'P/S',
  to_location: 'OTK(S)', application_status: '020', agent: '협운', remarks: '', ...extra,
});
const forecast = (id = '1', status = 'DENSE_FOG', extra: Record<string, unknown> = {}) => ({
  identity: `public${id}`, vessel_name: `SHIP ${id}`, callsign: `CALL${id}`,
  pilot_date: '2026-09-22', pilot_time: '12:00', from_location: 'P/S',
  to_location: 'OTK(S)', agent: '협운', status, raw_status: status, remarks: '', cancelled: false, ...extra,
});
async function rpc(name: string, args: unknown[] = []) {
  return (await db.query<{ v: any }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) v`, args)).rows[0].v;
}
async function tick(minute: number, applications: any[] | null, forecasts: any[] | null, manual = false) {
  const timestamp = at(minute);
  const lease = await rpc('hpbot_begin', [timestamp, manual]);
  if (!lease.token) return lease;
  const digest = () => (++hash).toString(16).padStart(64, '0');
  return rpc('hpbot_commit', [lease.token, lease.version,
    applications ? digest() : lease.application_hash,
    forecasts ? digest() : lease.forecast_hash,
    applications ? json(applications) : null, forecasts ? json(forecasts) : null,
    json(ranges), null, null, 1000, timestamp]);
}
async function state() { return (await db.query<any>('select * from pilot_weather_state')).rows[0]; }
async function notices(type?: string) {
  return (await db.query<any>(`select * from pilot_notifications ${type ? 'where notification_type=$1' : ''} order by created_at,id`, type ? [type] : [])).rows;
}
async function settings(value: Record<string, boolean>) {
  await db.query("insert into pilot_telegram_chats(chat_id,settings) values('-1',$1)", [json(value)]);
  await db.exec("update hpbot_control set primary_chat_id='-1'");
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  const files = [
    '20260920000000_ulsan_pilot_watcher', '20260920000300_hpbot_operations',
    '20260920000400_hpbot_telegram', '20260920000500_hpbot_query_context',
    '20260920000600_hpbot_mooring', '20260920001000_pilot_registration_status',
    '20260920001300_pilot_pob_date_labels', '20260921001500_pilot_pob_identity',
    '20260921001600_pilot_concise_notifications', '20260922002400_pilot_notification_policy',
    '20260922002500_pilot_event_titles', '20260922002700_hpbot_bounded_bootstrap',
    '20260922002800_hpbot_bootstrap_notifications', '20260922003400_pilot_event_presentation',
    '20260922003500_pilot_query_presentation',
  ];
  for (const file of files) await db.exec(readFileSync(`supabase/migrations/${file}.sql`, 'utf8'));
  for (const version of ['20260922003600', '20260922003700']) {
    const matches = readdirSync('supabase/migrations').filter(name => name.startsWith(`${version}_`) && name.endsWith('.sql'));
    expect(matches, `one migration for ${version}`).toHaveLength(1);
    await db.exec(readFileSync(`supabase/migrations/${matches[0]}`, 'utf8'));
  }
}, 30_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`truncate pilot_schedule_notification_events,pilot_schedule_notification_revisions,
    pilot_telegram_updates,pilot_telegram_confirmations,pilot_telegram_chats,hpbot_pilot_current,
    hpbot_pilot_history,hpbot_source_snapshots,hpbot_collection_ranges,pilot_monitor_logs,
    pilot_notifications,pilot_notification_attempts,pilot_weather_events,pilot_snapshots,pilot_runs,pilot_usage;
    delete from pilot_watcher_control;
    insert into pilot_watcher_control(id,enabled,billing_verified_at,cycle_start,cycle_end)
      values(true,true,'2026-09-01','2000-01-01','2100-01-01');
    delete from pilot_weather_state;insert into pilot_weather_state(id) values(true);
    delete from hpbot_control;insert into hpbot_control(id,alerts_enabled,bootstrap_done) values(true,true,true);`);
  hash = 0;
});

describe('multi-reason suspension database integration', () => {
  it('retains the HYOPU historical-baseline notification fence after the latest migrations', async () => {
    await db.exec('update hpbot_control set bootstrap_done=false');
    const changes=[{type:'NEW',old:null,new:app('201905766',{pilot_date:'2019-01-17'})},
      {type:'NEW',old:null,new:app('future',{pilot_date:'2099-01-01'})}];
    const filtered=await rpc('hpbot_filter_notifications',[json(changes)]);
    expect(filtered.map((c:any)=>c.new.application_id)).toEqual(['future']);
    expect((await rpc('hpbot_context')).bootstrap).not.toBeNull();
  });
  it('counts distinct vessels across mixed reasons, not movements or cancelled rows', async () => {
    const rows = [forecast('1', 'BAD_WEATHER'), forecast('1', 'DENSE_FOG', { identity: 'movement2' }),
      forecast('1', 'PORT_CLOSE', { identity: 'movement3' }), forecast('2', 'DENSE_FOG'),
      forecast('3', 'BAD_WEATHER'), forecast('4', 'PORT_CLOSE', { cancelled: true }), forecast('5', 'PROCESSING')];
    const counts = await rpc('pilot_suspension_counts', [json(rows)]);
    expect(counts).toMatchObject({
      bad_weather_count: 1, dense_fog_count: 1, port_close_count: 1, suspension_total_count: 3,
    });
    expect(counts.suspension_reasons).toHaveLength(3);
    expect(counts.suspension_reasons).toEqual(expect.arrayContaining(['PORT_CLOSE', 'DENSE_FOG', 'BAD_WEATHER']));
  });
  it('falls back to exact normalized vessel identity when callsign is missing', async () => {
    const rows = [forecast('1', 'BAD_WEATHER', { callsign: '', vessel_name: '  SAME   SHIP ' }),
      forecast('2', 'DENSE_FOG', { callsign: '', vessel_name: 'SAME SHIP' }),
      forecast('3', 'PORT_CLOSE', { callsign: '', vessel_name: 'OTHER SHIP' })];
    const counts = await rpc('pilot_suspension_counts', [json(rows)]);
    expect(counts).toMatchObject({ suspension_total_count: 2, bad_weather_count: 0, dense_fog_count: 1, port_close_count: 1 });
  });
  it.each(['DENSE_FOG', 'PORT_CLOSE'])('%s spelling normalization does not manufacture a transition', async status => {
    const canonical = forecast('1', status);
    const spaced = forecast('1', ` ${status.replace('_', ' ').toLowerCase()} `);
    await tick(0, [app()], [spaced]);
    await tick(1, null, [canonical]);
    expect(await notices()).toEqual([]);
    expect((await db.query('select count(*)::int n from pilot_schedule_notification_events')).rows[0].n).toBe(0);
  });
  it('two different reasons on two ships suspend after two distinct healthy minutes', async () => {
    await tick(0, [app(), app('2')], [forecast('1', 'BAD_WEATHER'), forecast('2', 'DENSE_FOG')]);
    expect((await state()).status).toBe('NORMAL');
    await tick(1, null, null);
    expect((await state()).status).toBe('SUSPENDED');
    expect(await notices('WEATHER_SUSPEND')).toHaveLength(1);
    await tick(2, null, null);await tick(3, null, null);
    expect(await notices('WEATHER_SUSPEND')).toHaveLength(1);
  });
  it('persists measured reason counts in state, runs, source logs and the active incident', async () => {
    await tick(0, [app(), app('2')], [forecast('1', 'DENSE_FOG'), forecast('2', 'PORT_CLOSE')]);await tick(1, null, null);
    const expected = { bad_weather_count: 0, dense_fog_count: 1, port_close_count: 1, suspension_total_count: 2 };
    expect(await state()).toMatchObject(expected);
    for (const table of ['pilot_runs', 'pilot_monitor_logs', 'pilot_weather_events']) {
      const rows = (await db.query<any>(`select * from ${table}`)).rows;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toMatchObject(expected);
    }
    const response = await rpc('hpbot_read', ['weather']);
    expect(response).toMatchObject({ ...expected, total: 2 });
    expect(response.rows.map((r: any) => r.status).sort()).toEqual(['DENSE_FOG', 'PORT_CLOSE']);
  });
  it.each([['DENSE_FOG', '🌫️ [DENSE FOG]'], ['PORT_CLOSE', '⛔ [PORT CLOSE]']])('entry %s has one explicit event title', async (status, title) => {
    await tick(0, [app()], [forecast('1', 'UNSPECIFIED')]);
    await tick(1, null, [forecast('1', status)]);
    const messages = await notices('SCHEDULE_CHANGE');
    expect(messages).toHaveLength(1);expect(messages[0].message.split('\n')[0]).toBe(title);
    expect(messages[0].message).not.toContain('공개:');expect(messages[0].message).not.toContain('신청:');
    await tick(2, null, null);expect(await notices('SCHEDULE_CHANGE')).toHaveLength(1);
  });
  it.each(['DENSE_FOG', 'PORT_CLOSE'])('first %s -> PROCESSING resumes with source evidence and merged edits only once', async status => {
    const applications = [app(), app('2')];
    await tick(0, applications, [forecast('1', status), forecast('2', status)]);await tick(1, null, null);
    await tick(2, [{ ...applications[0], pilot_time: '14:00', remarks: '확정' }, applications[1]], [forecast('1', 'PROCESSING'), forecast('2', status)]);
    const resumes = await notices('WEATHER_RESUME');expect(resumes).toHaveLength(1);
    expect(resumes[0].message).toContain(`${status.replace('_', ' ')} → PROCESSING`);
    expect(resumes[0].message).toContain('1400');expect(resumes[0].message).toContain('비고: 없음 → 확정');
    expect(await notices('SCHEDULE_CHANGE')).toHaveLength(0);
    await tick(3, null, [forecast('1', 'PROCESSING'), forecast('2', 'PROCESSING')]);
    expect(await notices('WEATHER_RESUME')).toHaveLength(1);
    expect((await state()).status).toBe('RESUMED');
  });
  it.each(['failure', 'gap'])('does not resume across a %s in source continuity', async kind => {
    await tick(0, [app(), app('2')], [forecast('1', 'DENSE_FOG'), forecast('2', 'PORT_CLOSE')]);await tick(1, null, null);
    if (kind === 'failure') {
      const lease = await rpc('hpbot_begin', [at(2)]);await rpc('pilot_fail', [lease.token, 'TIMEOUT', at(2)]);
    }
    await tick(3, null, [forecast('1', 'PROCESSING'), forecast('2', 'PORT_CLOSE')]);
    expect(await notices('WEATHER_RESUME')).toHaveLength(0);expect((await state()).status).toBe('SUSPENDED');
  });
  it.each(['other agency', 'new processing', 'cancelled processing'])('does not treat %s as proven direct resume', async kind => {
    await tick(0, [app(), app('2')], [forecast('1', 'DENSE_FOG'), forecast('2', 'PORT_CLOSE')]);await tick(1, null, null);
    const candidate = kind === 'other agency' ? forecast('1', 'PROCESSING', { agent: 'OTHER' })
      : kind === 'new processing' ? forecast('3', 'PROCESSING')
      : forecast('1', 'PROCESSING', { cancelled: true });
    await tick(2, null, [candidate, forecast('2', 'PORT_CLOSE')]);
    expect(await notices('WEATHER_RESUME')).toHaveLength(0);expect((await state()).status).toBe('SUSPENDED');
  });
  it('manual refresh in the same minute cannot accelerate suspension or re-arm', async () => {
    const high = [forecast('1', 'DENSE_FOG'), forecast('2', 'PORT_CLOSE')];
    await tick(0, [app(), app('2')], high);await tick(35 / 60, null, null, true);
    expect(await state()).toMatchObject({ status: 'NORMAL', candidate_count: 1 });
    await tick(1, null, null);expect((await state()).status).toBe('SUSPENDED');
    await tick(2, null, [forecast('1', 'PROCESSING'), forecast('2', 'PORT_CLOSE')]);
    await tick(2 + 35 / 60, null, null, true);expect((await state()).status).toBe('RESUMED');
    await tick(3, null, null);await tick(3 + 35 / 60, null, null, true);
    expect((await state()).status).toBe('RESUMED');
    await tick(4, null, null);expect((await state()).status).toBe('NORMAL');
  });
  it('repeated real transitions receive revisions but retries and UNKNOWN never resend', async () => {
    await tick(0, [app()], [forecast('1', 'DENSE_FOG')]);await tick(1, null, [forecast('1', 'PROCESSING')]);
    const claimed = await rpc('pilot_claim_notification');expect(claimed).not.toBeNull();
    await rpc('pilot_finish_notification', [claimed.id, 'UNKNOWN', null, 'TIMEOUT']);
    await tick(2, null, [forecast('1', 'DENSE_FOG')]);await tick(3, null, [forecast('1', 'PROCESSING')]);
    await tick(3, null, null);await tick(4, null, null);
    const messages = await notices('SCHEDULE_CHANGE');expect(messages).toHaveLength(3);
    expect(new Set(messages.map(n => n.notification_key)).size).toBe(3);
    expect(messages.find(n => n.id === claimed.id).status).toBe('UNKNOWN');
    const events = (await db.query<any>('select revision::int,change_hash from pilot_schedule_notification_events order by revision')).rows;
    expect(events.map(e => e.revision)).toEqual([1, 2, 3]);expect(events[0].change_hash).toBe(events[2].change_hash);
  });
  it('weather notification OFF preserves state and enabled individual operational notices', async () => {
    await settings({ WEATHER_SUSPEND: false, WEATHER_RESUME: false });
    await tick(0, [app(), app('2')], [forecast('1', 'DENSE_FOG'), forecast('2', 'PORT_CLOSE')]);await tick(1, null, null);
    expect((await state()).status).toBe('SUSPENDED');expect(await notices('WEATHER_SUSPEND')).toHaveLength(0);
    await tick(2, null, [forecast('1', 'PROCESSING'), forecast('2', 'PORT_CLOSE')]);
    expect((await state()).status).toBe('RESUMED');expect(await notices('WEATHER_RESUME')).toHaveLength(0);
    const messages = await notices('SCHEDULE_CHANGE');expect(messages).toHaveLength(1);
    expect(messages[0].message.split('\n')[0]).toBe('🔄 [PROCESSING]');
  });
  it('individual operational setting OFF suppresses entry messages, not history or global incident', async () => {
    await settings({ STATUS_CHANGED: false });
    await tick(0, [app(), app('2')], [forecast('1', 'UNSPECIFIED'), forecast('2', 'UNSPECIFIED')]);
    await tick(1, null, [forecast('1', 'DENSE_FOG'), forecast('2', 'PORT_CLOSE')]);await tick(2, null, null);
    expect(await notices('SCHEDULE_CHANGE')).toHaveLength(0);expect(await notices('WEATHER_SUSPEND')).toHaveLength(1);
    const entered = (await db.query<any>("select event_type from hpbot_pilot_history where event_type like 'PILOT_ENTERED_%' order by event_type")).rows;
    expect(entered.map(r => r.event_type)).toEqual(['PILOT_ENTERED_DENSE_FOG', 'PILOT_ENTERED_PORT_CLOSE']);
  });
  it('remaining fog/port restrictions prevent premature re-suspension after direct resume', async () => {
    const high = [forecast('1', 'DENSE_FOG'), forecast('2', 'PORT_CLOSE'), forecast('3', 'DENSE_FOG')];
    await tick(0, [app(), app('2'), app('3')], high);await tick(1, null, null);
    await tick(2, null, [forecast('1', 'PROCESSING'), high[1], high[2]]);
    for (let minute = 3; minute <= 5; minute++) await tick(minute, null, null);
    expect((await state()).status).toBe('RESUMED');expect(await notices('WEATHER_SUSPEND')).toHaveLength(1);
    await tick(6, null, [forecast('1', 'PROCESSING'), forecast('2', 'PROCESSING'), high[2]]);
    await tick(7, null, null);expect((await state()).status).toBe('NORMAL');
    await tick(8, null, high);await tick(9, null, null);
    expect((await state()).status).toBe('SUSPENDED');expect(await notices('WEATHER_SUSPEND')).toHaveLength(2);
  });
  it('fallback requires all suspension reasons to remain zero for 30 uninterrupted minutes', async () => {
    await tick(0, [app(), app('2')], [forecast('1', 'DENSE_FOG'), forecast('2', 'PORT_CLOSE')]);await tick(1, null, null);
    await tick(2, null, [forecast('1', 'UNSPECIFIED'), forecast('2', 'PORT_CLOSE')]);
    for (let minute = 3; minute <= 33; minute++) await tick(minute, null, null);
    expect((await state()).status).toBe('SUSPENDED');expect(await notices('WEATHER_RESUME')).toHaveLength(0);
    await tick(34, null, [forecast('1', 'UNSPECIFIED'), forecast('2', 'UNSPECIFIED')]);
    for (let minute = 35; minute <= 63; minute++) await tick(minute, null, null);
    expect((await state()).status).toBe('SUSPENDED');
    await tick(64, null, null);expect((await state()).status).toBe('RESUMED');
    const resumes = await notices('WEATHER_RESUME');expect(resumes).toHaveLength(1);expect(resumes[0].message).toContain('추정');
  });
  it.each(['050', '060', '090'])('terminal %s wins over weather status and hides public state', async terminal => {
    await settings({ COMPLETED: true });
    await tick(0, [app()], [forecast('1', 'PROCESSING')]);
    // The submitted application must retain its stable ID; public data does not decide completion.
    await tick(1, [app('1', { application_status: terminal })], [forecast('1', 'DENSE_FOG')]);
    const messages = await notices('SCHEDULE_CHANGE');expect(messages).toHaveLength(1);
    expect(messages[0].message.split('\n')[0]).toBe(terminal === '090' ? '❌ [도선취소]' : '✅ [도선완료]');
    expect(messages[0].message).not.toContain('공개:');expect(messages[0].message).not.toContain('신청:');
    expect((await db.query('select count(*)::int n from hpbot_pilot_queue')).rows[0].n).toBe(0);
  });
});
