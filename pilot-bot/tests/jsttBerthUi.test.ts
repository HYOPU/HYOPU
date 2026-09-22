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
