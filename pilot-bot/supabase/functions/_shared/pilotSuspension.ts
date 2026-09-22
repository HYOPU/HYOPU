/** Only source-confirmed suspension statuses. Do not add fuzzy or shorthand aliases. */
export const PILOT_SUSPENSION_STATUSES: ReadonlySet<string> = new Set([
  'BAD_WEATHER', 'DENSE_FOG', 'PORT_CLOSE',
]);

export function normalizePilotSuspensionStatus(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toUpperCase();
  const status = normalized === 'BAD WEATHER' ? 'BAD_WEATHER'
    : normalized === 'DENSE FOG' ? 'DENSE_FOG'
    : normalized === 'PORT CLOSE' ? 'PORT_CLOSE' : normalized;
  return PILOT_SUSPENSION_STATUSES.has(status) ? status : null;
}

export const pilotSuspensionLabel = (status: string): string => status.replace(/_/gu, ' ');
export const pilotSuspensionIcon = (status: string): string => status === 'DENSE_FOG' ? '🌫️' : status === 'PORT_CLOSE' ? '⛔' : '⚠️';
export const pilotSuspensionDisplay = (status: string): string => `${pilotSuspensionIcon(status)} ${pilotSuspensionLabel(status)}`;

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Total comes from the DB's unique-vessel count, never the sum of reason counts. */
export function pilotSuspensionCounts(data: any) {
  const badWeather = count(data.bad_weather_count);
  const denseFog = count(data.dense_fog_count);
  const portClose = count(data.port_close_count);
  const total = typeof data.suspension_total_count === 'number' && Number.isSafeInteger(data.suspension_total_count) && data.suspension_total_count >= 0
    ? data.suspension_total_count : badWeather;
  const supplied = Array.isArray(data.suspension_reasons) ? data.suspension_reasons : null;
  const present = new Set(supplied ?? [badWeather ? 'BAD_WEATHER' : null, denseFog ? 'DENSE_FOG' : null, portClose ? 'PORT_CLOSE' : null]);
  const reasons = [...PILOT_SUSPENSION_STATUSES].filter(status => present.has(status));
  return { badWeather, denseFog, portClose, total, reasons };
}

export function pilotSuspensionSummary(data: any): string {
  const { badWeather, denseFog, portClose, total, reasons } = pilotSuspensionCounts(data);
  return `중단 표시 합계: ${total}척\nBAD WEATHER: ${badWeather}척 / DENSE FOG: ${denseFog}척 / PORT CLOSE: ${portClose}척`
    + (reasons.length ? `\n중단 사유: ${reasons.map(pilotSuspensionLabel).join(' · ')}` : '');
}
