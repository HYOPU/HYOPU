import { pilotDateTimeLabel,pilotKstLabel } from './pilotDateTime.ts';
export const JSTT_MINI_OPS=new Set(['jsttCurrent','jsttWatchlist','jsttSearch','jsttChanges','jsttAdd','jsttRemove','jsttRefresh']);
export const jsttMenu={inline_keyboard:[
 [{text:'📋 현재 배정현황',callback_data:'v1:jstt:current:0'}],
 [{text:'👀 감시목록',callback_data:'v1:jstt:watchlist:0'},{text:'🕐 최근 변경',callback_data:'v1:jstt:changes:0'}],
 [{text:'🔄 즉시 확인',callback_data:'v1:menu:jstt_refresh'},{text:'◀ 돌아가기',callback_data:'v1:menu:help'}],
]};
export function jsttMiniUrl(username:string,reference?:string){return `https://t.me/${username}?startapp=${reference&&/^\d+$/.test(reference)?'jstt_'+reference:'jstt'}&mode=compact`;}
export function formatJstt(data:any,view='current') {
 const berth=(v:string)=>v==='UNASSIGNED'?'부두 미정':v??'미확인';
 let text=view==='watchlist'?'👀 [JSTT 특정선박 감시]\n협운 대리점 전체 자동감시':view==='changes'?'🕐 [JSTT 부두 변경 기록]':'⚓ [JSTT 감시대상 부두현황]';
 for(const [i,r]of(data.rows??[]).entries()){
  text+=`\n\n${(data.page??0)*10+i+1}. ${r.vessel_name} / ${r.agency_name??'대리점 무관'}`;
  if(view==='watchlist')text+=r.matched?'':'\n현재 일정 없음 · 정확한 이름 일치 시 감시';
  else if(view==='changes')text+=`\n${berth(r.old_berth??'UNASSIGNED')} → ${berth(r.new_berth)}\n감지: ${pilotKstLabel(r.detected_at)}`;
  else text+=`\n${pilotDateTimeLabel(r.schedule_datetime.slice(0,10),r.schedule_datetime.slice(11,16))}\n${berth(r.normalized_berth)}${r.missing_count?' · 조회 누락 확인 중':''}`;
 }
 if(!data.rows?.length)text+='\n\n해당 일정/기록이 없습니다.';
 text+=`\n\n마지막 정상확인: ${pilotKstLabel(data.last_success)}`;
 if(!data.enabled)text+='\n⏸ JSTT 감시 중지: '+(data.disabled_reason??'활성화 대기');
 else if(!data.last_success||Date.now()-Date.parse(data.last_success)>25*60000)text+='\n⚠️ 최신 자료가 아닙니다.';
 text+='\n자동 수집: 20분 간격';
 return text;
}
