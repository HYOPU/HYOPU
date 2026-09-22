import { pilotDateTimeLabel,pilotKstLabel } from './pilotDateTime.ts';
export const JSTT_MINI_OPS=new Set(['jsttCurrent','jsttWatchlist','jsttSearch','jsttChanges','jsttAdd','jsttRemove','jsttRefresh']);
export const jsttMenu={inline_keyboard:[
 [{text:'📋 현재 배정현황',callback_data:'v1:jstt:current:0'}],
 [{text:'👀 감시목록',callback_data:'v1:jstt:watchlist:0'},{text:'🕐 최근 변경',callback_data:'v1:jstt:changes:0'}],
 [{text:'🔄 즉시 확인',callback_data:'v1:menu:jstt_refresh'},{text:'◀ 돌아가기',callback_data:'v1:menu:help'}],
]};
export function jsttMiniUrl(username:string,reference?:string){return `https://t.me/${username}?startapp=${reference&&/^\d+$/.test(reference)?'jstt_'+reference:'jstt'}&mode=compact`;}
const berthLabel=(value:unknown)=>value==='UNASSIGNED'?'부두 미정':typeof value==='string'&&value&&value!=='UNKNOWN'?value:'확인 필요';
const isUnverified=(row:any)=>row.berth_verified===false||row.normalized_berth==='UNKNOWN';
export function jsttQualityWarning(data:any):string {
 const unknownCount=Math.max(Number(data.unknown_count)||0,(data.rows??[]).filter(isUnverified).length);
 if(!unknownCount&&data.quality_status!=='DEGRADED')return '';
 return `⚠️ 부분 확인: ${unknownCount?`부두 미검증 ${unknownCount}건`:'일부 부두값 확인 필요'} · 마지막 검증값을 유지합니다.`;
}
export function jsttBerthDetail(row:any):string {
 if(!isUnverified(row))return berthLabel(row.normalized_berth);
 const raw=String(row.observed_raw_berth??row.raw_berth??'').trim()||'(빈 값)';
 const prior=typeof row.normalized_berth==='string'&&row.normalized_berth&&row.normalized_berth!=='UNKNOWN';
 return `⚠️ 부두 확인 필요 · 원문: ${raw}\n마지막 검증 부두: ${prior?berthLabel(row.normalized_berth):'확인 기록 없음'}${row.last_verified_at?`\n마지막 검증 시각: ${pilotKstLabel(row.last_verified_at)}`:''}`;
}
export function formatJstt(data:any,view='current') {
 let text=view==='watchlist'?'👀 [JSTT 특정선박 감시]\n협운 대리점 전체 자동감시':view==='changes'?'🕐 [JSTT 부두 변경 기록]':'⚓ [JSTT 감시대상 부두현황]';
 const warning=jsttQualityWarning(data);if(warning)text+='\n'+warning;
 for(const [i,r]of(data.rows??[]).entries()){
  text+=`\n\n${(data.page??0)*10+i+1}. ${r.vessel_name}`;
  if(view==='watchlist')text+=` / ${r.agency_name??'대리점 무관'}`;
  else if(r.agency_name&&r.agency_name!=='협운해운(주)')text+=`\n대리점: ${r.agency_name}`;
  if(view==='watchlist')text+=r.matched?'':'\n현재 일정 없음 · 정확한 이름 일치 시 감시';
  else if(view==='changes')text+=`\n${berthLabel(r.old_berth??'UNASSIGNED')} → ${berthLabel(r.new_berth)}\n감지: ${pilotKstLabel(r.detected_at)}`;
  else text+=`\n${pilotDateTimeLabel(r.schedule_datetime.slice(0,10),r.schedule_datetime.slice(11,16))}\n${jsttBerthDetail(r)}${r.missing_count?' · 조회 누락 확인 중':''}`;
 }
 if(!data.rows?.length)text+='\n\n해당 일정/기록이 없습니다.';
 text+=`\n\n마지막 수집: ${pilotKstLabel(data.last_success)}`;
 if(!data.enabled)text+='\n⏸ JSTT 감시 중지: '+(data.disabled_reason??'활성화 대기');
 else if(!data.last_success||Date.now()-Date.parse(data.last_success)>25*60000)text+='\n⚠️ 최신 자료가 아닙니다.';
 text+='\n자동 수집: 20분 간격';
 return text;
}
