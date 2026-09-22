// @vitest-environment node
import {it,expect} from 'vitest';
import {jsttCalendarTitle,selectJsttDate} from '../api/_jstt_berth_dates.mjs';

// Models the observed server-rendered popup, including stale input.value while
// the selected calendar day is still the old server value.
function calendarPage({stale=false,month=9,year=2026}={}){
 let open=false,selected='2026년 9월 22일 화요일',value='2026-09-22',clicks=0;
 const log:string[]=[];
 const span=(title:string)=>({count:async()=>month===Number(/년 (\d+)월/.exec(title)![1])?1:0,click:async()=>{log.push('day:'+title);clicks++;if(!stale||clicks>1)selected=title;value='2026-09-28';open=false;}});
 const cal:any={waitFor:async()=>{expect(open).toBe(true);},locator:(selector:string)=>selector.includes('aria-selected')?{getAttribute:async()=>selected}:span(/title="([^"]+)"/.exec(selector)![1])};
 const dialog:any={waitFor:async()=>{expect(open).toBe(false);},getByRole:(_r:string,o:any)=>o.name instanceof RegExp?{innerText:async()=>`${month}월 ${year}`}:{click:async()=>{log.push(o.name);month+=o.name==='next month'?1:-1;}}};
 const icon={click:async()=>{log.push('open');open=true;}};
 const input:any={locator:()=>({locator:()=>icon}),inputValue:async()=>value,getAttribute:async()=> 'false'};
 const page:any={locator:()=>({nth:()=>input}),getByRole:(role:string)=>role==='dialog'?dialog:cal,waitForFunction:async()=>{log.push('month-ack');}};
 return {page,log};
}
it('uses exact Korean calendar labels over month/year/leap boundaries',()=>{
 expect(jsttCalendarTitle('2026-09-28')).toBe('2026년 9월 28일 월요일');
 expect(jsttCalendarTitle('2027-01-01')).toBe('2027년 1월 1일 금요일');
 expect(jsttCalendarTitle('2028-02-29')).toBe('2028년 2월 29일 화요일');
 expect(()=>jsttCalendarTitle('2026-02-29')).toThrow('JSTT_DATE_INVALID');
});
it('selects, reopens, verifies committed selection, then closes before returning',async()=>{
 const {page,log}=calendarPage();expect(await selectJsttDate(page,1,'2026-09-28')).toBe('2026-09-28');
 expect(log).toEqual(['open','day:2026년 9월 28일 월요일','open','day:2026년 9월 28일 월요일']);
});
it('fails closed when input text changes but server selected date remains stale',async()=>{
 const {page,log}=calendarPage({stale:true});await expect(selectJsttDate(page,1,'2026-09-28')).rejects.toThrow('JSTT_DATE_NOT_COMMITTED');
 expect(log.filter(x=>x.startsWith('day:'))).toHaveLength(1);
});
it('bounded real calendar month navigation waits for acknowledgement',async()=>{
 const {page,log}=calendarPage({month:8});await selectJsttDate(page,1,'2026-09-28');
 expect(log.slice(0,3)).toEqual(['open','next month','month-ack']);
});
it('does not loop indefinitely on an unexpected calendar month',async()=>{
 const {page}=calendarPage({month:1});await expect(selectJsttDate(page,1,'2026-09-28')).rejects.toThrow('JSTT_CALENDAR_RANGE_INVALID');
});
