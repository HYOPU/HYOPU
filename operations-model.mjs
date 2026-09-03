export const PICS = ['DENNIS', 'JAE LEE', 'JACK', 'RICK'];
export const PORTS = ['ULSAN', "P'TAEK", 'YOSU', 'DAESAN', 'DONGHAE', 'INCHEON', 'KUNSAN'];
export const STATUSES = ['PRE-ARRIVAL', 'INPORT', 'DEPARTED'];
export function parseEta(raw, year = 2026) {
  const match = String(raw || '').match(/^(\d{1,2})\/(\d{1,2})(?:\s+(\d{4}|AM|PM))?(\?\?)?$/i);
  if (!match) return { date: '', time: '', uncertain: Boolean(raw), period: '' };
  const month = Number(match[1]), day = Number(match[2]);
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (stamp.getUTCMonth() !== month - 1 || stamp.getUTCDate() !== day) return { date: '', time: '', uncertain: true, period: '' };
  const clock = match[3] || '';
  const invalidTime = /^\d/.test(clock) && (Number(clock.slice(0, 2)) > 23 || Number(clock.slice(2)) > 59);
  return { date: stamp.toISOString().slice(0, 10), time: /^\d/.test(clock) && !invalidTime ? `${clock.slice(0, 2)}:${clock.slice(2)}` : '', period: /AM|PM/i.test(clock) ? clock.toUpperCase() : '', uncertain: Boolean(match[4] || invalidTime) };
}
export function hydrateSeed(rows) {
  return rows.map((row, i) => ({ ...row, id: `eta-2026-${String(i + 1).padStart(3, '0')}`, year: 2026, status: row.remark === 'INPORT' ? 'INPORT' : 'PRE-ARRIVAL', activities: [], activityNotes: '', cargo: [], crew: [], tasks: [], notes: '', proformaNotes: '', vcrFileName: '', latestReport: '', reportType: 'DEP.REPORT', reportReceived: '', reportChecked: false, sof: null, revision: 0 }));
}
export function calendarDays(month) {
  const first = new Date(`${month}-01T00:00:00Z`), start = new Date(first);
  start.setUTCDate(1 - (first.getUTCDay() + 6) % 7);
  const last = new Date(first); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
  const count = Math.ceil(((first.getUTCDay() + 6) % 7 + last.getUTCDate()) / 7) * 7;
  return Array.from({ length: count }, (_, i) => { const day = new Date(start); day.setUTCDate(start.getUTCDate() + i); return day.toISOString().slice(0, 10); });
}
export function shiftMonth(month, offset) { const day = new Date(`${month}-01T00:00:00Z`); day.setUTCMonth(day.getUTCMonth() + offset); return day.toISOString().slice(0, 7); }
export function matchesFilters(call, { pic = '', port = '', query = '' } = {}) {
  return (!pic || call.pic === pic) && (!port || call.port === port) && (!query || `${call.vessel} ${call.voyage}`.toLowerCase().includes(query.toLowerCase()));
}
const koreaToday = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function callsOnDay(calls, day, today = koreaToday()) {
  const timeValue = call => {
    const eta = parseEta(call.etaRaw, call.year);
    if (eta.time) return Number(eta.time.replace(':', ''));
    if (eta.period === 'AM') return 900;
    if (eta.period === 'PM') return 1700;
    return 9999;
  };
  return calls.filter(call => {
    const eta = parseEta(call.etaRaw, call.year).date, etd = parseEta(call.etdRaw, call.year).date;
    return eta === day || Boolean(call.status === 'INPORT' && eta && eta < day && day <= (etd || today));
  }).sort((left, right) => {
    const leftEta = parseEta(left.etaRaw, left.year).date;
    const rightEta = parseEta(right.etaRaw, right.year).date;
    return leftEta.localeCompare(rightEta) || timeValue(left) - timeValue(right) || left.vessel.localeCompare(right.vessel) || left.voyage.localeCompare(right.voyage);
  });
}
export function inMonth(call, month, today = koreaToday()) {
  const eta = parseEta(call.etaRaw, call.year).date, etd = parseEta(call.etdRaw, call.year).date;
  return eta.startsWith(month) || Boolean(call.status === 'INPORT' && eta && eta < `${month}-01` && (etd || today) >= `${month}-01`);
}
export function blankCall(id) { return { ...hydrateSeed([{ vessel: '', voyage: '', port: 'ULSAN', etaRaw: '', etdRaw: '', pic: '', remark: '' }])[0], id, year: new Date().getFullYear() }; }
