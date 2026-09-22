// @vitest-environment happy-dom
import {it,expect,vi} from 'vitest';
import {mountJstt} from '../pilot-miniapp/jstt.js';
import {parseCommand,parseCallback} from '../supabase/functions/telegram-webhook/lib/commands';
import {formatJstt} from '../supabase/functions/_shared/jstt';
const flush=()=>new Promise(r=>setTimeout(r,0));
const button=(root:HTMLElement,text:string)=>[...root.querySelectorAll('button')].find(b=>b.textContent===text)!;
it('one page uses explicit confirmation; source lookup and inputs do not send messages or registration operations',async()=>{
 const root=document.createElement('div');const calls:any[]=[];
 const api=vi.fn(async body=>{calls.push(body);return body.op==='jsttAdd'?{changed:true}:{rows:[],total:0,page:0};});
 mountJstt(root,api);await flush();
 const inputs=root.querySelectorAll('input');inputs[0].value='future ship';inputs[0].dispatchEvent(new Event('input'));
 button(root,'➕ 감시선박 등록').click();await flush();expect(calls.map(x=>x.op)).toEqual(['jsttCurrent']);
 expect(root.textContent).toContain('감시 추가 확인');button(root,'✅ 확정').click();button(root,'✅ 확정').click();await flush();
 expect(calls.filter(x=>x.op==='jsttAdd')).toHaveLength(1);expect(calls.find(x=>x.op==='jsttAdd')).toMatchObject({confirm:true,vessel:'future ship',agency:null});
 expect(calls.every(x=>x.op.startsWith('jstt'))).toBe(true);
});
it('search result selection keeps agency-unrestricted default and renders hostile names as text',async()=>{
 const root=document.createElement('div');const api=async body=>({rows:body.op==='jsttSearch'?[{vessel_name:'<img src=x>',agency_name:'협운해운(주)',schedule_datetime:'2026-09-23 07:00',normalized_berth:'N3'}]:[],total:1,page:0});
 mountJstt(root,api);await flush();root.querySelector('input')!.value='SHIP';button(root,'현재 일정에서 검색').click();await flush();
 expect(root.querySelector('img')).toBeNull();button(root,'이 선박 선택').click();expect(root.querySelector('input')!.value).toBe('<img src=x>');
 expect(root.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);
 button(root,'➕ 감시선박 등록').click();expect(root.querySelector('.review')!.textContent).toContain('대리점 무관');
});
it('empty search offers direct name registration; changing input invalidates confirmation',async()=>{
 const root=document.createElement('div'),api=vi.fn(async body=>({rows:[],total:0,page:0,view:body.op==='jsttSearch'?'search':'current'}));
 mountJstt(root,api);await flush();const input=root.querySelector('input')!;input.value='GINGA PUMA';input.dispatchEvent(new Event('input'));
 button(root,'현재 일정에서 검색').click();await flush();expect(root.textContent).toContain('선박명만 알면 미리 감시등록');
 button(root,'➕ GINGA PUMA 감시등록').click();expect(root.querySelector('.review')!.textContent).toContain('GINGA PUMA / 대리점 무관');
 const changed=root.querySelector('input')!;changed.value='OTHER';changed.dispatchEvent(new Event('input'));
 expect(root.querySelector('.review')).toBeNull();expect(api.mock.calls.some(([b])=>b.op==='jsttAdd')).toBe(false);
 button(root,'➕ 감시선박 등록').click();button(root,'✅ 확정').click();await flush();
 expect(api.mock.calls.find(([b])=>b.op==='jsttAdd')![0]).toMatchObject({vessel:'OTHER',agency:null});
});
it('twenty-minute collection is not marked stale after ninety seconds',()=>{
 const data={enabled:true,last_success:new Date(Date.now()-20*60000).toISOString(),rows:[]};
 expect(formatJstt(data)).not.toContain('최신 자료가 아닙니다');
 expect(formatJstt({...data,last_success:new Date(Date.now()-26*60000).toISOString()})).toContain('최신 자료가 아닙니다');
});
it('aliases, paging and concise weekday berth transitions are isolated',()=>{
 expect(parseCommand('⚓ JSTT 부두')?.name).toBe('jstt_menu');expect(parseCommand('/JSTT새로고침')?.name).toBe('jstt_refresh');
 expect(parseCallback('v1:jstt:current:2')).toEqual({name:'jstt_current',page:2});expect(parseCommand('도선 등록현황')?.name).toBe('queue');
 expect(formatJstt({enabled:true,last_success:new Date().toISOString(),rows:[{vessel_name:'SHIP',agency_name:'협운해운(주)',schedule_datetime:'2026-09-23 07:00',normalized_berth:'N4'}]})).toContain('09/23(수) 0700');
});
it('Telegram omits default Hyopu agency from current/change rows but retains other actual agencies',()=>{
 const base={enabled:true,last_success:new Date().toISOString(),rows:[
  {vessel_name:'SHIP A',agency_name:'협운해운(주)',schedule_datetime:'2026-09-23 07:00',normalized_berth:'N4',old_berth:'N3',new_berth:'N4',detected_at:'2026-09-22T00:00:00Z'},
  {vessel_name:'SHIP B',agency_name:'윌헴슨',schedule_datetime:'2026-09-23 07:00',normalized_berth:'N3',old_berth:'N4',new_berth:'N3',detected_at:'2026-09-22T00:00:00Z'},
 ]};
 for(const view of ['current','changes']){
  const text=formatJstt(base,view);expect(text).not.toContain('협운');expect(text).toContain('대리점: 윌헴슨');
 }
 const management=formatJstt({...base,rows:[...base.rows,{vessel_name:'SHIP C',agency_name:null}]},'watchlist');
 expect(management).toContain('SHIP A / 협운해운(주)');expect(management).toContain('SHIP C / 대리점 무관');
});
const qualityRow={vessel_name:'GINGA PUMA',agency_name:'협운해운(주)',schedule_datetime:'2026-09-23 07:00',berth_verified:false,observed_raw_berth:'NEW BERTH',normalized_berth:'N4',last_verified_at:'2026-09-22T00:00:00Z'};
const qualityData={enabled:true,last_success:'2026-09-22T01:00:00Z',unknown_count:1,quality_status:'DEGRADED',last_warning:'JSTT_BERTH_UNKNOWN',rows:[qualityRow],total:1,page:0};
it('Telegram distinguishes current collection from the last verified berth without declaring the row assigned',()=>{
 const text=formatJstt(qualityData);
 expect(text).toContain('부분 확인: 부두 미검증 1건');expect(text).toContain('부두 확인 필요 · 원문: NEW BERTH');
 expect(text).toContain('마지막 검증 부두: N4');expect(text).toContain('마지막 검증 시각: 09/22(화) 0900');
 expect(text).toContain('마지막 수집: 09/22(화) 1000');expect(text).not.toContain('마지막 정상확인');
 expect(text).not.toContain('JSTT_BERTH_UNKNOWN');
});
it('unknown first observations never display UNKNOWN as an assigned berth',()=>{
 const text=formatJstt({...qualityData,rows:[{...qualityRow,normalized_berth:'UNKNOWN',last_verified_at:null,observed_raw_berth:''}]});
 expect(text).toContain('원문: (빈 값)');expect(text).toContain('마지막 검증 부두: 확인 기록 없음');
 expect(text).not.toContain('UNKNOWN');expect(text).not.toContain('마지막 검증 시각:');
});
it('partial collection warning remains visible on pages and views with no unknown rows',()=>{
 for(const view of ['current','watchlist','changes']){
  expect(formatJstt({...qualityData,rows:[]},view)).toContain('부분 확인: 부두 미검증 1건');
  expect(formatJstt({...qualityData,unknown_count:0,rows:[]},view)).toContain('부분 확인: 일부 부두값 확인 필요');
 }
 expect(formatJstt({...qualityData,unknown_count:0,quality_status:'HEALTHY',rows:[qualityRow]})).toContain('부분 확인: 부두 미검증 1건');
});
it('verified unassigned values and legacy known rows retain ordinary display',()=>{
 const text=formatJstt({...qualityData,unknown_count:0,quality_status:'HEALTHY',rows:[{...qualityRow,berth_verified:true,normalized_berth:'UNASSIGNED'},{vessel_name:'SHIP',agency_name:'협운해운(주)',schedule_datetime:'2026-09-23 07:00',normalized_berth:'N3'}]});
 expect(text).toContain('부두 미정');expect(text).toContain('N3');expect(text).not.toContain('부분 확인');expect(text).not.toContain('NEW BERTH');
});
it('miniapp safely renders unverified raw values and distinguishes previous verified state from collection time',async()=>{
 const root=document.createElement('div');mountJstt(root,async()=>({...qualityData,rows:[{...qualityRow,observed_raw_berth:'<img src=x onerror=alert(1)>'}]}));await flush();
 expect(root.querySelector('img')).toBeNull();expect(root.textContent).toContain('원문: <img src=x onerror=alert(1)>');
 expect(root.textContent).toContain('부분 확인: 부두 미검증 1건');expect(root.textContent).toContain('마지막 검증 부두: N4');
 expect(root.textContent).toContain('마지막 검증 시각:');expect(root.textContent).toContain('마지막 수집:');expect(root.textContent).not.toContain('마지막 정상확인');
 const detail=[...root.querySelectorAll('p')].find(p=>p.textContent?.includes('마지막 검증 부두'))!;expect(detail.style.whiteSpace).toBe('pre-line');
});
it('miniapp displays no fake berth for new unknown rows and warns on degraded empty views',async()=>{
 const root=document.createElement('div');mountJstt(root,async()=>({...qualityData,rows:[{...qualityRow,normalized_berth:'UNKNOWN',last_verified_at:null}]}));await flush();
 expect(root.textContent).toContain('마지막 검증 부두: 확인 기록 없음');expect(root.textContent).not.toContain('UNKNOWN');
 const empty=document.createElement('div');mountJstt(empty,async()=>({...qualityData,rows:[]}));await flush();
 expect(empty.textContent).toContain('부분 확인: 부두 미검증 1건');expect(empty.textContent).toContain('해당 일정/기록이 없습니다.');
});
