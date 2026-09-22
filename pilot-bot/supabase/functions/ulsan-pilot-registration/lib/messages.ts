import { pilotDateTimeLabel } from '../../_shared/pilotDateTime.ts';
import type { PilotDraft } from '../../_shared/pilot-registration/wizard.ts';
import type { PilotFields } from '../../_shared/pilot-registration/contract.ts';
import type { ApplicationObservation } from '../../ulsan-pilot-watcher/lib/hyopuSource.ts';
import { eligibilityWarningMessages } from '../../_shared/pilot-registration/eligibility.ts';

const value=(v:string|undefined)=>v===undefined?'미확인':v.trim()||'없음';
const when=(f:PilotFields)=>pilotDateTimeLabel(f.dt_ship,`${f.tm_ship_h}:${f.tm_ship_i}`);
const route=(f:PilotFields)=>`${value(f.nm_point_f)} → ${value(f.nm_point_t)}`;
const changed=(before:string|undefined,after:string)=>before!==undefined&&before!==after?`${before} → ${after}`:after;
export function registrationSuccessMessage(d:PilotDraft,f:PilotFields,row:ApplicationObservation):string{
 const old=d.action==='UPDATE'?d.original:undefined;
 const lines=[`✅ [도선${d.mode==='COPY'?'복사등록':d.action==='CREATE'?'등록':'수정'} 완료]`,`${row.vessel_name} / ${row.callsign}`,
  `일시: ${changed(old?when(old):undefined,when(f))}`,
  `구간: ${old&&route(old)!==route(f)?`${route(old)} ⇒ `:''}${route(f)}`,
  `강취: ${changed(old?value(old.sn_partner):undefined,value(f.sn_partner))}`,
  `최대흘수: ${changed(old?value(old.num_draft):undefined,value(f.num_draft))} m`,
  `비고: ${changed(old?value(old.nm_text):undefined,value(f.nm_text))}`,
  `신청번호: ${row.application_id}`];
 if(d.copy)lines.push(`복사 원본: ${when(d.copy.fields)} / ${route(d.copy.fields)}`);
 // Contact edits are acknowledged without repeating personal details in a group.
 if(old&&['cd_emp_partner','no_hpemp_partner','e_mail'].some(k=>old[k]!==f[k]))lines.push('담당자·연락 정보: 변경 반영 (상세는 인앱 확인)');
 lines.push('신청목록·상세 재조회: 확인 완료 / 등록현황 반영');
 if(d.prepared?.eligibilityWarnings?.length)lines.push('보조검사 경고 확인 후 제출 · 실제 접수는 재조회로 검증');
 return lines.join('\n');
}
export function registrationFailureMessage(id:string,code:string,uncertain:boolean,d?:PilotDraft):string{
 const reason:Record<string,string>={REG_BILLING_AUTH_REQUIRED:'사이트 청구처 인증 실패 (청구처 선택값 오류 아님)',REG_COMPANY_AUTH_REQUIRED:'사이트 수정 신청 선사 인증 실패',REG_TIME_CHECK_EMPTY:'사이트 시간 보조검사 빈 응답',REG_ELIGIBILITY_RESPONSE:'사이트 사전검사 응답 확인 불가',REG_FEATURE_DISABLED:'실제 제출 기능 비활성',COPY_FEATURE_DISABLED:'복사 제출 기능 비활성',REG_MEMBER_REVOKED:'현재 방 참여 권한 확인 실패',REG_DUPLICATE:'동일한 신청 존재',REG_DETAIL_MISMATCH:'신청 상세 재조회 불일치',REG_VERIFICATION_REQUIRED:'신청목록 등록 결과 확인 불가'};
 const lines=[uncertain?'⚠️ [도선신청 결과 확인 필요]':'❌ [도선신청 전송 안 됨]'];
 if(d)lines.push(`${value(d.fields.nm_callsign)} / ${value(d.fields.cd_callsign)}`,`일시: ${when(d.fields)}`,`구간: ${route(d.fields)}`);
 if(d?.prepared?.eligibilityWarnings?.length)lines.push(...eligibilityWarningMessages(d.prepared.eligibilityWarnings));
 lines.push(`사유: ${reason[code]??'처리 확인 필요'} (${code})`,`요청: ${id}`,
  uncertain?'접수 여부 불확실 / 자동 재제출하지 않음\n신청처리상태에서 읽기 전용 재확인 필요':'외부 신청 POST 없음 / 입력·사이트 상태 확인 후 다시 진행');
 return lines.join('\n');
}
