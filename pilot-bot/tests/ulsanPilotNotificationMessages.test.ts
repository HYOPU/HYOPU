// @vitest-environment node
import { describe,it,expect } from 'vitest';
import { registrationSuccessMessage,registrationFailureMessage } from '../supabase/functions/ulsan-pilot-registration/lib/messages';
import type { PilotDraft } from '../supabase/functions/_shared/pilot-registration/wizard';
import type { ApplicationObservation } from '../supabase/functions/ulsan-pilot-watcher/lib/hyopuSource';
const fields={nm_callsign:'TEST VESSEL',cd_callsign:'TEST1',dt_ship:'20260921',tm_ship_h:'09',tm_ship_i:'30',nm_point_f:'P/S',nm_point_t:'OTK(S)',sn_partner:'글로',num_draft:'6.20',nm_text:'접안 전 연락',no_hpemp_partner:'PRIVATE_PHONE',cd_emp_partner:'PRIVATE_PERSON',e_mail:'PRIVATE_EMAIL',seq_log:'PRIVATE_TOKEN'};
const draft: PilotDraft={action:'CREATE',dryRun:false,step:'review',fields,form:{action:'CREATE',fields,hidden:[],options:{}}};
const row:ApplicationObservation={application_id:'123',vessel_name:'TEST VESSEL',callsign:'TEST1',pilot_date:'2026-09-21',pilot_time:'09:30',from_location:'P/S',to_location:'OTK(S)',agent:'협운',application_status:'010',completion_status:'ACTIVE',raw_application_status:'요청',remarks:fields.nm_text,association_remark:'',draft:'6.20'};
describe('concise registration notification presentation only',()=>{
 it('includes vessel, date, route, mooring, draft, remarks and verified ID without personal/token fields',()=>{
  const text=registrationSuccessMessage(draft,fields,row);
  for(const expected of ['도선등록 완료','TEST VESSEL / TEST1','09/21(월) 0930','P/S → OTK(S)','강취: 글로','최대흘수: 6.20 m','비고: 접안 전 연락','신청번호: 123','재조회: 확인 완료'])expect(text).toContain(expected);
  expect(text).not.toContain('PRIVATE_');expect(text.length).toBeLessThan(600);
 });
 it('shows changes and remark removal for a verified update, without leaking changed contacts',()=>{
  const f={...fields,tm_ship_h:'10',nm_point_t:'JSTT',nm_text:'',no_hpemp_partner:'PRIVATE_NEW'};
  const text=registrationSuccessMessage({...draft,action:'UPDATE',original:fields},f,row);
  expect(text).toContain('0930 → 09/21(월) 1030');expect(text).toContain('P/S → OTK(S) ⇒ P/S → JSTT');
  expect(text).toContain('비고: 접안 전 연락 → 없음');expect(text).toContain('담당자·연락 정보: 변경 반영');expect(text).not.toContain('PRIVATE_');
 });
 it('keeps uncertain result distinct from never-sent failure and identifies the affected request',()=>{
  const unknown=registrationFailureMessage('request-id','REG_VERIFICATION_REQUIRED',true,draft);
  expect(unknown).toContain('TEST VESSEL');expect(unknown).toContain('접수 여부 불확실');expect(unknown).toContain('자동 재제출하지 않음');expect(unknown).not.toContain('POST 없음');expect(unknown).not.toContain('완료]');
  const failed=registrationFailureMessage('request-id','REG_BILLING_AUTH_REQUIRED',false,draft);
  expect(failed).toContain('청구처 인증 실패');expect(failed).toContain('외부 신청 POST 없음');expect(failed).toContain('요청: request-id');
  expect(registrationFailureMessage('request-id','REG_CHAT_REVOKED',false)).not.toContain('undefined');
 });
});
