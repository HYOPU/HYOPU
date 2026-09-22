// @vitest-environment node
import {it,expect} from 'vitest';
import {JSTT_HEADERS,jsttWindow,parseJsttGrid,normalizeJsttName} from '../api/_jstt_berth_core.mjs';
const window={start:'2026-09-21',end:'2026-09-28'};
// Captured read-only 2026-09-21 from the exact VesselSchedule/List grid.
const cells=['202609140008','계획','2026-09-23 07:00','2026-09-21 06:00','ARGENT IRIS','2026-09-24 03:00','대기','협운해운(주)'];
const grid=()=>({authenticated:true,complete:true,headers:JSTT_HEADERS,start:window.start,end:window.end,selectedWindow:window,basis:'접안일시',rows:[cells],rowCount:1});
it('uses ETB, real hidden identity and real unassigned value',()=>{const r=parseJsttGrid(grid(),window);expect(r.rows[0]).toMatchObject({schedule_key:'202609140008',normalized_berth:'UNASSIGNED',schedule_datetime:'2026-09-23 07:00'});});
it('accepts live-observed 요청 but rejects unknown statuses',()=>{
 const requested=[...cells];requested[1]='요청';expect(parseJsttGrid({...grid(),rows:[requested]},window).rows[0].source_status).toBe('요청');
 requested[1]='unknown';expect(()=>parseJsttGrid({...grid(),rows:[requested]},window)).toThrow('JSTT_ID_OR_STATUS_INVALID');
});
it('accepts live-observed STOLT FOCUS 수정요청 without discarding the complete range',()=>{
 const modified=['202609140009','수정요청','2026-09-22 07:00','2026-09-16 17:00','STOLT FOCUS','2026-09-23 08:00','대기','협운해운(주)'];
 expect(parseJsttGrid({...grid(),rows:[cells,modified],rowCount:2},window).rows).toHaveLength(2);
});
it('eight calendar days respect KST midnight/month/year',()=>{expect(jsttWindow(new Date('2026-12-31T15:00Z'))).toEqual({start:'2027-01-01',end:'2027-01-08'});});
it('safe names do not fuzzily collapse prefixes or punctuation',()=>{expect(normalizeJsttName(' mv  ship ')).toBe('MV SHIP');expect(normalizeJsttName('MV SHIP')).not.toBe(normalizeJsttName('SHIP'));});
it.each(['','TBA','T.B.A','-','J3','미정','N99'])('unverified berth %s is quarantined, not assigned or released',berth=>{
 const result=parseJsttGrid({...grid(),rows:[[...cells.slice(0,6),berth,cells[7]]]},window);
 expect(result.rows[0]).toMatchObject({schedule_key:cells[0],raw_berth:berth,normalized_berth:'UNKNOWN',berth_verified:false});
 expect(result.quality).toMatchObject({status:'DEGRADED',unknown_count:1});
});
it('accepts actual FIRST LION 4부두 without blocking the other ships',()=>{
 const actual=['202609110004','계획','2026-09-23 07:00','2026-09-14 18:00','FIRST LION','2026-09-24 07:00','4부두','새한해운(주)'];
 const result=parseJsttGrid({...grid(),rows:[cells,actual],rowCount:2},window);
 expect(result.rows.find(r=>r.vessel_name==='FIRST LION')).toMatchObject({normalized_berth:'4부두',berth_verified:true});
 expect(result.quality.status).toBe('HEALTHY');
});
it('cell line breaks remain quarantinable without inventing a known berth',()=>{
 const row=[...cells];row[6]=' N\n4\t';
 const result=parseJsttGrid({...grid(),rows:[row]},window);
 expect(result.rows[0]).toMatchObject({raw_berth:'N 4',normalized_berth:'UNKNOWN',berth_verified:false});
});
it('retains unknown IDs and healthy rows; rejects malformed identity even with unknown berth',()=>{
 const unknown=[...cells];unknown[0]='202609220099';unknown[6]='NEW BERTH';
 const result=parseJsttGrid({...grid(),rows:[cells,unknown],rowCount:2},window);
 expect(result.rows).toHaveLength(2);expect(result.rows[0].normalized_berth).toBe('UNASSIGNED');
 unknown[0]=cells[0];expect(()=>parseJsttGrid({...grid(),rows:[cells,unknown],rowCount:2},window)).toThrow('JSTT_ID_OR_STATUS_INVALID');
});
it('hash includes quality and exact new value; row order stays stable',()=>{
 const unknown=[...cells];unknown[0]='202609220099';unknown[6]='NEW BERTH';
 const a=parseJsttGrid({...grid(),rows:[cells,unknown],rowCount:2},window);
 expect(parseJsttGrid({...grid(),rows:[unknown,cells],rowCount:2},window).hash).toBe(a.hash);
 unknown[6]='N3';expect(parseJsttGrid({...grid(),rows:[cells,unknown],rowCount:2},window).hash).not.toBe(a.hash);
});
it('archived unknown berth does not degrade active monitoring; diagnostic samples are bounded',()=>{
 const row=[...cells];row[1]='이안';row[6]='NEW';
 expect(parseJsttGrid({...grid(),rows:[row]},window).quality.unknown_count).toBe(0);
 const rows=Array.from({length:12},(_,i)=>{const r=[...cells];r[0]='2026092200'+String(i).padStart(2,'0');r[6]='NEW';return r;});
 expect(parseJsttGrid({...grid(),rows,rowCount:rows.length},window).quality.samples).toHaveLength(5);
});
it('rejects auth, virtual/paged/partial grids, duplicate/missing IDs and wrong dates',()=>{
 for(const patch of [{authenticated:false},{complete:false},{virtual:true},{paged:true},{rowCount:2},{start:'2026-09-01'},{selectedWindow:undefined},{selectedWindow:{...window,end:'2026-09-22'}},{rows:[cells,cells],rowCount:2},{rows:[['',...cells.slice(1)]]}])expect(()=>parseJsttGrid({...grid(),...patch},window)).toThrow();
 expect(()=>parseJsttGrid({...grid(),rows:[[cells[0],cells[1],'2026-09-29 00:00',...cells.slice(3)]]},window)).toThrow('JSTT_RANGE_INVALID');
});
