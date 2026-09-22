import type { PilotEligibilityWarning } from './client.ts';

export const ADVISORY_POLICY = 'official-ui-advisory-v1' as const;
export const eligibilityPolicyFromEnv = (value:string) => value===ADVISORY_POLICY?ADVISORY_POLICY:'strict';
export const eligibilityPolicyNotice = '도선사회 선사·청구처/시간 보조검사가 응답하지 않으면 경고 후 진행합니다. 연체 여부는 확인되지 않을 수 있으며 최종 접수는 도선사회 서버가 판정합니다.';
export function eligibilityWarningMessages(warnings:readonly PilotEligibilityWarning[]=[]):string[]{
 return [...new Set(warnings.map(w=>w.purpose==='time'
  ?'시간 보조검사: 빈 응답. 미래 일시 자체 검증은 통과했으며 최종 접수는 도선사회 서버가 판정합니다.'
  :`${w.purpose==='shipcompany'?'선사':'청구처'} 보조검사: 인증 오류. 협운해운(1002) 선택은 확인했으나 연체 여부는 확인되지 않았습니다.`))];
}
