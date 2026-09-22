import { createHash } from 'node:crypto';

export const JSTT_URL = 'https://www.jstt.co.kr:5440/TW/VesselSchedule/List';
export const JSTT_ORIGIN = new URL(JSTT_URL).origin;
export const JSTT_HEADERS = ['BERTH_SCHEDULE_NO','상태','접안일시','입항일시','선명','이안일시','부두','대리점'];
// Only values observed in the authoritative grid. Unknown is NOT unassigned.
// FIRST LION / 202609110004 was observed at 4부두 on 2026-09-22.
export const JSTT_BERTHS = new Set(['2부두','3부두','4부두','N3','N4','N5']);
export const JSTT_BERTH_CONTRACT = '2026-09-22-quarantine-v1';
export const normalizeJsttName = value => String(value ?? '').trim().replace(/\s+/gu,' ').toUpperCase();
export function jsttWindow(now = new Date()) {
  const start = new Date(now.getTime()+9*3600000).toISOString().slice(0,10);
  return {start,end:new Date(Date.parse(start+'T00:00:00Z')+7*86400000).toISOString().slice(0,10)};
}
function dateTime(value, optional=false) {
  const s=String(value??'').trim();
  if (!s && optional) return null;
  if (!/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(s)
    || new Date(s.replace(' ','T')+':00Z').toISOString().slice(0,16)!==s.replace(' ','T')) throw Error('JSTT_DATE_INVALID');
  return s;
}
export function parseJsttGrid(grid, window) {
  if (!grid || grid.authenticated!==true || grid.complete!==true || grid.virtual || grid.paged
    || JSON.stringify(grid.headers)!==JSON.stringify(JSTT_HEADERS)
    || grid.start!==window.start || grid.end!==window.end || grid.basis!=='접안일시'
    || grid.selectedWindow?.start!==window.start || grid.selectedWindow?.end!==window.end
    || !Array.isArray(grid.rows) || grid.rows.length>2000 || grid.rows.length!==grid.rowCount) throw Error('JSTT_GRID_INVALID');
  const ids=new Set();
  const rows=grid.rows.map(c=>{
    if(!Array.isArray(c)||c.length!==8||c.some(x=>typeof x!=='string'||x.length>160)) throw Error('JSTT_ROW_INVALID');
    const [id,status,etb,eta,vessel,departure,berthCell,agency]=c.map(x=>x.trim());
    // Rendered cell whitespace is presentation, not a new code. Keep a space
    // inside unknown codes ("N\n4" must not silently become verified "N4").
    const rawBerth=berthCell.replace(/[\s\u0000-\u001f\u007f]+/gu,' ').trim();
    if(!/^\d{8,24}$/.test(id)||ids.has(id)||!vessel||!agency||!['계획','요청','수정요청','확정','접안','이안'].includes(status)) throw Error('JSTT_ID_OR_STATUS_INVALID');
    ids.add(id);
    // Unknown berth is a row-level quality issue, not an empty/missing row or
    // a release. Keep its ID so DB absence detection never cancels that row.
    const berth=rawBerth==='대기'?'UNASSIGNED':JSTT_BERTHS.has(rawBerth)?rawBerth:'UNKNOWN';
    return {schedule_key:id,vessel_name:vessel,normalized_vessel_name:normalizeJsttName(vessel),agency_name:agency,
      schedule_datetime:dateTime(etb),port_in_datetime:dateTime(eta,true),departure_datetime:dateTime(departure,true),
      source_status:status,raw_berth:rawBerth,normalized_berth:berth,berth_verified:berth!=='UNKNOWN'};
  });
  if(rows.some(r=>r.schedule_datetime.slice(0,10)<window.start||r.schedule_datetime.slice(0,10)>window.end)) throw Error('JSTT_RANGE_INVALID');
  rows.sort((a,b)=>a.schedule_key.localeCompare(b.schedule_key));
  const unknown=rows.filter(r=>!r.berth_verified&&r.source_status!=='이안');
  return {rows,hash:createHash('sha256').update(JSON.stringify({contract:JSTT_BERTH_CONTRACT,window,rows})).digest('hex'),window,
    quality:{status:unknown.length?'DEGRADED':'HEALTHY',unknown_count:unknown.length,
      samples:unknown.slice(0,5).map(r=>({schedule_key:r.schedule_key,raw_berth:r.raw_berth}))}};
}
export function safeJsttError(error) {
  return error instanceof Error && /^JSTT_[A-Z_]+$/.test(error.message) ? error.message : 'JSTT_COLLECTION_FAILED';
}
