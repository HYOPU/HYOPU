const weekdays = ['일', '월', '화', '수', '목', '금', '토'];

/** Source calendar dates are already KST; never interpret them in host local time. */
export function pilotDateLabel(value: string | null | undefined): string {
  const date = (value ?? '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date || '날짜 미정';
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return '날짜 확인 필요';
  return `${date.slice(5).replace('-', '/')}(${weekdays[parsed.getUTCDay()]})`;
}

export function pilotTimeLabel(value: string | null | undefined): string {
  if (!value) return '시간 미정';
  const match = value.match(/^([01]\d|2[0-3]):?([0-5]\d)(?::[0-5]\d)?$/);
  return match ? match[1] + match[2] : value;
}

export const pilotDateTimeLabel = (date: string | null | undefined, time: string | null | undefined) =>
  `${pilotDateLabel(date)} ${pilotTimeLabel(time)}`;

export function pilotKstLabel(value: string | null | undefined): string {
  if (!value) return '확인 기록 없음';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '확인 기록 없음';
  const kst = new Date(parsed + 9 * 3600_000).toISOString();
  return pilotDateTimeLabel(kst.slice(0, 10), kst.slice(11, 16));
}
