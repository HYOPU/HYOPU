/** Login-system business status. Never pass public BAD WEATHER/PROCESSING here.
 * Confirmed by the operator: both 완료(050) and 청구(060) mean pilotage is finished.
 */
export const APPLICATION_STATUSES = {
  '010': { label: '요청', lifecycle: 'ACTIVE' },
  '020': { label: '확인', lifecycle: 'ACTIVE' },
  '030': { label: '변경', lifecycle: 'ACTIVE' },
  '040': { label: 'POB', lifecycle: 'ACTIVE' },
  '050': { label: '완료', lifecycle: 'COMPLETED' },
  '060': { label: '청구', lifecycle: 'COMPLETED' },
  '090': { label: '취소', lifecycle: 'CANCELLED' },
} as const;

export type ApplicationCode = keyof typeof APPLICATION_STATUSES;
export type ApplicationLifecycle = 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'UNKNOWN';
export interface ApplicationStatus {
  code: ApplicationCode | null;
  lifecycle: ApplicationLifecycle;
  rawStatus: string;
}

export function classifyApplicationStatus(rawStatus: string): ApplicationStatus {
  const normalized = rawStatus.normalize('NFKC').replace(/\s+/gu, ' ').trim().toUpperCase();
  const code = (Object.keys(APPLICATION_STATUSES) as ApplicationCode[])
    .find(key => key === normalized || APPLICATION_STATUSES[key].label === normalized) ?? null;
  return { code, lifecycle: code ? APPLICATION_STATUSES[code].lifecycle : 'UNKNOWN', rawStatus };
}

export interface HyopuApplication {
  application_id: string;
  vessel_name: string;
  callsign: string;
  pilot_date: string;
  pilot_time: string | null;
  from_location: string;
  to_location: string;
  application_status: string;
  forecast_status: string | null;
}
export interface HyopuQueueEntry extends HyopuApplication {
  sequence_no: number;
  sequence_label: string;
  is_overdue: boolean;
  completion_status: 'ACTIVE' | 'UNKNOWN';
  needs_status_review: boolean;
}

function scheduledAt(row: HyopuApplication): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.pilot_date)) throw new Error('INVALID_APPLICATION_DATE');
  const date = new Date(`${row.pilot_date}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== row.pilot_date)
    throw new Error('INVALID_APPLICATION_DATE');
  if (row.pilot_time === null) return Number.POSITIVE_INFINITY;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.pilot_time)) throw new Error('INVALID_APPLICATION_TIME');
  return Date.parse(`${row.pilot_date}T${row.pilot_time}:00+09:00`);
}

// IDs, not source row positions, provide deterministic ordering on a time tie.
// Compare arbitrary-length numeric IDs without Number precision loss.
function compareIds(left: string, right: string): number {
  const a = left.replace(/^0+(?=\d)/, ''), b = right.replace(/^0+(?=\d)/, '');
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0);
}

export function sequenceLabel(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('INVALID_SEQUENCE');
  return sequence <= 20 ? String.fromCodePoint(0x2460 + sequence - 1) : `${sequence}번`;
}

/** Derived read model only: completed/cancelled source records remain intact.
 * Unknown status is retained with a review flag; elapsed time never completes a job.
 * One row means one application/movement, not one unique vessel.
 */
export function calculateHyopuQueue(rows: readonly HyopuApplication[], now: number): HyopuQueueEntry[] {
  if (!Number.isFinite(now)) throw new Error('INVALID_OBSERVATION_TIME');
  const ids = new Set<string>();
  const entries: { row: HyopuApplication; status: ApplicationStatus; timestamp: number }[] = [];
  for (const row of rows) {
    if (!/^\d{1,30}$/.test(row.application_id) || ids.has(row.application_id)) throw new Error('INVALID_OR_DUPLICATE_APPLICATION_ID');
    ids.add(row.application_id);
    const status = classifyApplicationStatus(row.application_status);
    const timestamp = scheduledAt(row);
    if (status.lifecycle === 'COMPLETED' || status.lifecycle === 'CANCELLED') continue;
    entries.push({ row, status, timestamp });
  }
  entries.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    // Missing times are listed at the end, then by date and application ID.
    return a.row.pilot_date.localeCompare(b.row.pilot_date) || compareIds(a.row.application_id, b.row.application_id);
  });
  return entries.map(({ row, status, timestamp }, index) => ({ ...row,
    sequence_no: index + 1, sequence_label: sequenceLabel(index + 1),
    is_overdue: Number.isFinite(timestamp) && timestamp < now,
    completion_status: status.lifecycle === 'UNKNOWN' ? 'UNKNOWN' : 'ACTIVE',
    needs_status_review: status.lifecycle === 'UNKNOWN',
  }));
}

/** Emit at most one completion transition when 050 later becomes 060 (or vice versa).
 * Other login-state changes may be retained separately in history.
 */
export function isNewCompletion(previous: string | null, current: string): boolean {
  return previous !== null && classifyApplicationStatus(previous).lifecycle !== 'COMPLETED'
    && classifyApplicationStatus(current).lifecycle === 'COMPLETED';
}
