import { sequenceLabel } from '../../ulsan-pilot-watcher/lib/hyopuQueue.ts';
import { pilotDateTimeLabel, pilotTimeLabel, pilotKstLabel } from '../../_shared/pilotDateTime.ts';
import { normalizePilotSuspensionStatus, pilotSuspensionDisplay, pilotSuspensionSummary } from '../../_shared/pilotSuspension.ts';
import type { Command } from './commands.ts';
export const mainMenu={keyboard:[['🚢 도선 등록현황','📡 현재 도선상태'],['⚠️ 도선 중단 선박조회','🔄 새로고침'],['🕐 최근변경','📋 중단기록'],['🔍 선박검색','⚙️ 알림설정'],['🖥 감시상태','❔ 도움말'],['⚓ JSTT 부두']],resize_keyboard:true};
export const settingLabels:Record<string,string>={NEW:'신규 도선',TIME_CHANGED:'시간 변경',ROUTE_CHANGED:'구간 변경',STATUS_CHANGED:'운항상태 변경',POB:'POB (도선사 승선)',REMARK_CHANGED:'비고 변경',CANCELLED:'취소',WEATHER_SUSPEND:'도선중단',WEATHER_RESUME:'도선재개',SOURCE_ERROR:'시스템 오류',COMPLETED:'완료'};
export const kst=pilotKstLabel;
Object.assign(settingLabels,{JSTT_ASSIGNED:'JSTT 최초/재배정',JSTT_CHANGED:'JSTT 부두변경',JSTT_UNASSIGNED:'JSTT 배정해제'});
const weatherLabel=(s:string)=>({NORMAL:'정상 관측',SUSPENDED:'🚨 도선중단 감지',RESUMED:'🟢 도선재개 감지'}[s]??'미확인');
// The RPC projection is authoritative, including an explicit null. Never turn
// an unmatched forecast or a retained terminal row into a current public state.
function operationalStatus(row:any):string|null {
 if(row.needs_review||['050','060','090'].includes(row.application_status)||['COMPLETED','CANCELLED'].includes(row.completion_status))return null;
 let value:unknown;
 if(Object.hasOwn(row,'operational_status'))value=row.operational_status;
 else if(row.application_status==='040')value='POB';
 else if(row.match_basis==='UNIQUE_CALLSIGN_VESSEL_DATE_ROUTE')value=row.forecast_status;
 const status=typeof value==='string'?value.trim().replace(/\s+/gu,' ').toUpperCase():'';
 return status==='P.O.B'?'POB':normalizePilotSuspensionStatus(status)??(status||null);
}
function operationalLine(row:any):string {
 const status=operationalStatus(row);
 const suspension=normalizePilotSuspensionStatus(status);
 return status==='PROCESSING'||status==='POB'?`공개: ${status}\n`:suspension?`${pilotSuspensionDisplay(suspension)}\n`:'';
}
export function formatReply(command:Command,data:any,now=Date.now()):{text:string;markup:any}{
 let text='';let markup:any=mainMenu;
 const stale=!data.last_success||now-Date.parse(data.last_success)>90_000;
 const footer=`\n\n마지막 정상확인: ${kst(data.last_success)}${stale?'\n⚠️ 최신 자료가 아닙니다.':''}${!data.bootstrap_done?'\n⏳ 과거 미완료 업무 초기 수집 중':''}`;
 const rows=data.rows??[];
 if(['queue','today','tomorrow','three','search'].includes(command.name)){
   text=command.name==='queue'?'🚢 [도선 등록현황]\n':'🚢 [미완료 도선일정]\n';
   for(const r of rows){
     text+=`\n${sequenceLabel(Number(r.sequence_no))} ${r.vessel_name}\n${pilotDateTimeLabel(r.pilot_date,r.pilot_time)}\n${r.from_location} → ${r.to_location}\n${r.mooring_name?.trim()?`강취: ${r.mooring_name.trim()}\n`:''}${operationalLine(r)}${r.is_overdue?'⚠️ 예정시간 경과 / 미완료\n':''}${r.needs_review?'⚠️ 원본 상태·매칭 확인 필요\n':''}${r.forecast_time&&r.forecast_time!==r.pilot_time?`공개 예보시간: ${pilotTimeLabel(r.forecast_time)}\n`:''}`;
   }
   if(!rows.length)text+='\n해당 미완료 일정이 없습니다.';
   text+=`\n조회 ${data.total??0}건 / 전체 미완료 ${data.active??0}건`+footer;
 }else if(command.name==='weather'){
   text=`⚠️ [도선 중단 선박조회]\n${pilotSuspensionSummary(data)}\n${weatherLabel(data.weather)}\n`;
   rows.forEach((r:any,i:number)=>{
     const reasons=[...new Set((Array.isArray(r.suspension_reasons)?r.suspension_reasons:[r.status??r.forecast_status]).map(normalizePilotSuspensionStatus).filter((s:string|null):s is string=>s!==null))];
     text+=`\n${sequenceLabel((command.page??0)*10+i+1)} ${r.vessel_name}\n${pilotDateTimeLabel(r.pilot_date,r.pilot_time)}\n${r.from_location} → ${r.to_location}\n${reasons.length?`${reasons.map(s=>pilotSuspensionDisplay(String(s))).join(' · ')}\n`:''}`;
   });text+=footer;
 }else if(command.name==='changes'){
   const semantic=rows.filter((r:any)=>typeof r.title==='string'&&r.title.trim()&&typeof r.summary==='string'&&r.summary.trim());
   text='🕐 [최근 변경]\n'+(semantic.length?semantic.map((r:any)=>`${kst(r.detected_at)}\n${r.title}\n${r.summary}`).join('\n\n'):'\n표시할 변경 기록이 없습니다.')+footer;
 }else if(command.name==='events'){
   text='📋 [최근 도선중단 기록]\n'+rows.map((r:any)=>`${kst(r.started_at)} 중단\n${r.resume_detected_at?`${kst(r.resume_detected_at)} 재개${r.resume_method==='ZERO_30_MINUTES'?' 추정':''}`:'진행 중'}${r.duration_seconds?`\n지속 ${Math.floor(r.duration_seconds/3600)}시간 ${Math.floor(r.duration_seconds%3600/60)}분`:''}${r.resume_vessel_name?`\n재개 선박 ${r.resume_vessel_name}`:''}`).join('\n\n')+footer;
 }else if(command.name==='settings'){
   text='⚙️ [알림 설정]\n이 방의 모든 참여자가 설정을 변경할 수 있습니다.';
   markup={inline_keyboard:Object.entries(settingLabels).map(([key,label])=>[{text:`${label} ${data.settings?.[key]!==false?'✅':'❌'}`,callback_data:`v1:setting:${key}`}])};
 }else if(['health','debug'].includes(command.name)){
   text=`🖥 [감시 시스템]\n협운 로그인: ${data.login_ok?'정상':'미확인/오류'}\n공개 도선예보: ${data.forecast_ok?'정상':'미확인/오류'}\n감시: ${!data.enabled?'비용/운영 중지':data.paused?'관리자 중지':stale?'관측 지연':'정상'}\n연속 오류: ${data.failure_count}\n최근 Telegram 성공: ${kst(data.telegram_last_sent)}\n추정 전송량: 주기 ${((data.estimated_cycle_bytes??0)/1048576).toFixed(2)}MiB / 오늘 ${((data.estimated_day_bytes??0)/1048576).toFixed(2)}MiB\n※ 실제 청구량과 다름${data.disabled_reason?`\n중지 사유: ${data.disabled_reason}`:''}${command.name==='debug'?`\n오류 코드: ${data.error??'없음'}`:''}`+footer;
 }else if(command.name==='help'){
   text='🚢 울산 도선 모니터\n\n도선 등록현황: 오늘부터 7일 후까지 (KST, 양 끝 날짜 포함)\n현재 도선상태 · 도선 중단 선박조회 · 최근변경 · 중단기록\n선박검색 선박명 · 감시상태 · 알림설정\n\n방 참여자: 새로고침 · 테스트알림 · 감시중지 · 감시재개 · 디버그\n\n취소·완료·청구는 제외합니다. 오늘 시간이 지난 미완료는 표시합니다. 10건 초과 시 다음 페이지에서 계속 조회합니다. 순번은 전체 미완료 기준입니다.\n외부 신청 취소·삭제는 지원하지 않습니다.';
 }else{
   text=`📡 [현재 도선상태]\n${weatherLabel(data.weather)}\n${pilotSuspensionSummary(data)}\n미완료 도선: ${data.active}건\n미완료 중 PROCESSING: ${data.processing}건\n중단 시작: ${kst(data.started_at)}\n감시: ${!data.enabled||data.paused?'중지':stale?'관측 지연':'정상'}`+footer;
 }
 if(['queue','today','tomorrow','three','weather','search'].includes(command.name)&&(data.total??0)>10){
   const page=command.page??0;const buttons=[];
   const prefix=command.name==='search'?`v1:s:${command.contextId}`:`v1:q:${command.name}`;
   if(page>0)buttons.push({text:'◀ 이전',callback_data:`${prefix}:${page-1}`});
   if((page+1)*10<data.total)buttons.push({text:'다음 ▶',callback_data:`${prefix}:${page+1}`});
   markup={inline_keyboard:[buttons]};
 }
 if(text.length>3400)text=text.slice(0,3300)+'\n… 표시 한도를 넘어 일부 생략했습니다.';
 return {text,markup};
}
