// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { calculateHyopuQueue, classifyApplicationStatus, isNewCompletion, sequenceLabel,
  type HyopuApplication } from '../supabase/functions/ulsan-pilot-watcher/lib/hyopuQueue';

const now = Date.parse('2026-09-20T15:00:00+09:00');
const row = (id: string, status = '요청', time: string | null = '14:00', date = '2026-09-20'): HyopuApplication => ({
  application_id: id, application_status: status, vessel_name: 'SAMPLE VESSEL', callsign: 'SAMPLE',
  pilot_date: date, pilot_time: time, from_location: 'P/S', to_location: 'JSTT2', forecast_status: null,
});

describe('operator-confirmed login completion rules', () => {
  it.each(['050', '완료', '060', '청구', '  청구  ', '０６０'])('%s is completed pilotage', input => {
    expect(classifyApplicationStatus(input).lifecycle).toBe('COMPLETED');
  });
  it.each(['010', '020', '030', '040', '요청', '확인', '변경', 'POB'])('%s stays active', input => {
    expect(classifyApplicationStatus(input).lifecycle).toBe('ACTIVE');
  });
  it.each(['090', '취소'])('%s is cancelled, not completed', input => {
    expect(classifyApplicationStatus(input).lifecycle).toBe('CANCELLED');
  });
  it.each(['', 'UNKNOWN', 'PROCESSING', 'BAD WEATHER', '완료 예정', '999'])('%s cannot prove completion', input => {
    expect(classifyApplicationStatus(input).lifecycle).toBe('UNKNOWN');
  });
  it('retains the original status, distinguishes completion from billing', () => {
    expect(classifyApplicationStatus(' 청구 ')).toEqual({ code: '060', lifecycle: 'COMPLETED', rawStatus: ' 청구 ' });
    expect(classifyApplicationStatus('완료').code).toBe('050');
  });
  it('does not generate a second completion when billing follows completion', () => {
    expect(isNewCompletion('040', '050')).toBe(true);
    expect(isNewCompletion('030', '060')).toBe(true);
    expect(isNewCompletion('050', '060')).toBe(false);
    expect(isNewCompletion('청구', '완료')).toBe(false);
    expect(isNewCompletion(null, '060')).toBe(false);
    expect(isNewCompletion('030', '090')).toBe(false);
  });
});

describe('derived unfinished movement queue', () => {
  it('excludes completed, billed and cancelled without deleting or mutating original records', () => {
    const rows = [row('1', '050'), row('2', '060'), row('3', '090'), row('4', '030')];
    const before = JSON.stringify(rows);
    expect(calculateHyopuQueue(rows, now).map(r => r.application_id)).toEqual(['4']);
    expect(JSON.stringify(rows)).toBe(before);
    expect(rows).toHaveLength(4);
  });
  it('retains overdue unfinished work and all registered future dates', () => {
    const result = calculateHyopuQueue([row('2', '010', '10:00', '2026-10-01'), row('1')], now);
    expect(result.map(r => [r.application_id, r.is_overdue])).toEqual([['1', true], ['2', false]]);
  });
  it('does not let public PROCESSING or BAD_WEATHER override completion', () => {
    const result = calculateHyopuQueue([
      { ...row('1', '060'), forecast_status: 'PROCESSING' },
      { ...row('2', '050'), forecast_status: 'BAD_WEATHER' },
      { ...row('3', '010'), forecast_status: 'PROCESSING' },
    ], now);
    expect(result.map(r => r.application_id)).toEqual(['3']);
  });
  it('retains unknown status with a review warning', () => {
    expect(calculateHyopuQueue([row('1', 'NEW_UNKNOWN_STATE')], now)[0])
      .toMatchObject({ completion_status: 'UNKNOWN', needs_status_review: true, is_overdue: true });
  });
  it('retains multiple movements for the same vessel; sorts ties by numeric application ID', () => {
    const input = [row('10'), row('2'), row('9999999999999999999999'), row('9999999999999999999998')];
    const forward = calculateHyopuQueue(input, now);
    expect(forward.map(r => r.application_id)).toEqual(['2', '10', '9999999999999999999998', '9999999999999999999999']);
    expect(calculateHyopuQueue([...input].reverse(), now)).toEqual(forward);
    expect(forward.map(r => r.sequence_label)).toEqual(['①', '②', '③', '④']);
  });
  it('recalculates ranks after insertion, completion, cancellation and time changes; preserves identity', () => {
    const a = row('100', '010', '13:00'), b = row('200', '010', '14:00'), c = row('300', '010', '16:00');
    expect(calculateHyopuQueue([a, b, c], now).find(r => r.application_id === '200')?.sequence_no).toBe(2);
    expect(calculateHyopuQueue([a, b, c, row('150', '010', '13:30')], now).find(r => r.application_id === '200')?.sequence_no).toBe(3);
    expect(calculateHyopuQueue([{ ...a, application_status: '060' }, b, c], now)[0].application_id).toBe('200');
    expect(calculateHyopuQueue([a, { ...b, application_status: '090' }, c], now)[1].application_id).toBe('300');
    expect(calculateHyopuQueue([a, b, { ...c, pilot_time: '12:00' }], now)[0].application_id).toBe('300');
    // This read model has no event/notification side effects and cannot notify on a rank change.
    expect(a.application_id).toBe('100');
  });
  it('does not invent a time or an overdue flag when a time is not specified', () => {
    const result = calculateHyopuQueue([row('1', '010', null), row('2', '010', '16:00')], now);
    expect(result[1]).toMatchObject({ application_id: '1', is_overdue: false, pilot_time: null });
  });
  it('uses KST and a strict elapsed-time comparison', () => {
    expect(calculateHyopuQueue([row('1', '010', '15:00')], now)[0].is_overdue).toBe(false);
    expect(calculateHyopuQueue([row('1', '010', '14:59')], now)[0].is_overdue).toBe(true);
  });
  it('rejects duplicate or malformed IDs instead of merging jobs by ship name', () => {
    expect(() => calculateHyopuQueue([row('1'), row('1')], now)).toThrow('INVALID_OR_DUPLICATE_APPLICATION_ID');
    expect(() => calculateHyopuQueue([row('not-an-id')], now)).toThrow('INVALID_OR_DUPLICATE_APPLICATION_ID');
  });
  it('rejects invalid dates and times rather than silently rolling them over', () => {
    expect(() => calculateHyopuQueue([row('1', '010', '14:00', '2026-02-30')], now)).toThrow('INVALID_APPLICATION_DATE');
    expect(() => calculateHyopuQueue([row('1', '010', '24:00')], now)).toThrow('INVALID_APPLICATION_TIME');
  });
  it('uses readable labels after twenty movements', () => {
    expect(sequenceLabel(20)).toBe('⑳');
    expect(sequenceLabel(21)).toBe('21번');
  });
});
