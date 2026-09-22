// @vitest-environment node
import {it,expect} from 'vitest';
import {JSTT_HEADERS,jsttWindow,parseJsttGrid,normalizeJsttName} from '../api/_jstt_berth_core.mjs';
const window={start:'2026-09-21',end:'2026-09-28'};
// Grid shape captured 2026-09-21; agency is adapted for isolated HYOPU tests.
const cells=['202609140008','계획','2026-09-23 07:00','2026-09-21 06:00','ARGENT IRIS','2026-09-24 03:00','대기','협운해운(주)'];
const grid=()=>({authenticated:true,complete:true,headers:JSTT_HEADERS,start:window.start,end:window.end,selectedWindow:window,basis:'접안일시',rows:[cells],rowCount:1});
it('uses ETB, real hidden identity and real unassigned value',()=>{const r=parseJsttGrid(grid(),window);expect(r.rows[0]).toMatchObject({schedule_key:'202609140008',normalized_berth:'UNASSIGNED',schedule_datetime:'2026-09-23 07:00'});});
it('accepts 4부두 observed in the HYOPU cloud full-grid probe on 2026-09-22',()=>{
 const sample=[...cells];sample[6]='4부두';
 expect(parseJsttGrid({...grid(),rows:[sample]},window).rows[0].normalized_berth).toBe('4부두');
});
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
it.each(['','TBA','T.B.A','-','J3','미정'])('unverified berth %s is not release',berth=>{expect(()=>parseJsttGrid({...grid(),rows:[[...cells.slice(0,6),berth,cells[7]]]},window)).toThrow('JSTT_BERTH_UNKNOWN');});
it('rejects auth, virtual/paged/partial grids, duplicate/missing IDs and wrong dates',()=>{
 for(const patch of [{authenticated:false},{complete:false},{virtual:true},{paged:true},{rowCount:2},{start:'2026-09-01'},{selectedWindow:undefined},{selectedWindow:{...window,end:'2026-09-22'}},{rows:[cells,cells],rowCount:2},{rows:[['',...cells.slice(1)]]}])expect(()=>parseJsttGrid({...grid(),...patch},window)).toThrow();
 expect(()=>parseJsttGrid({...grid(),rows:[[cells[0],cells[1],'2026-09-29 00:00',...cells.slice(3)]]},window)).toThrow('JSTT_RANGE_INVALID');
});
