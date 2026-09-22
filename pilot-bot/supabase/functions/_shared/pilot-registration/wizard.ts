import { REG_MOVEMENTS, pilotBusinessFields, pilotRemarkLimit, validatePilotRemark } from './contract.ts';
import type { PilotAction, PilotChoice, PilotFields, PilotForm, PilotLookup } from './contract.ts';
import type { CopyReference } from './copy.ts';
import type { PilotEligibilityWarning } from './client.ts';
import { pilotDateTimeLabel } from '../pilotDateTime.ts';
export interface PilotDraft {
 action:PilotAction; dryRun:boolean; step:string; fields:PilotFields; form:PilotForm;
 mode?:'COPY'; copy?:CopyReference; copyChangedFields?:string[];
 original?:PilotFields; originalHash?:string; returnToReview?:boolean; choices?:PilotChoice[]; page?:number;
 eligibilityPolicy?:'strict'|'official-ui-advisory-v1';
 prepared?:{ fields:PilotFields; baselineIds:string[]; eligibilityPolicy?:string; eligibilityWarnings?:PilotEligibilityWarning[] };
}
export const PILOT_STEPS=['vessel','fg_inoutport','dt_ship','time','from','to','num_draft','tp_vessel','tp_cargo',
 'tugboat_1','tugboat_a','tugboat_2','tugboat_b','mooring','fg_side','num_bt_yn','tp_q','final_confirm_1',
 'shipcompany','billing','etryptyear','etryptco','cd_cargo','num_length','cd_emp_partner','no_hpemp_partner','fg_tax','e_mail','yn_dispilot','nm_text'];
export const PILOT_LABELS:Record<string,string>={vessel:'선박',application:'수정할 신청번호',fg_inoutport:'도선 종류',dt_ship:'도선 날짜',time:'도선 시간',from:'FROM',to:'TO',num_draft:'최대흘수 (m)',tp_vessel:'Tanker/LPG 여부',tp_cargo:'적재 여부',tugboat_1:'예선 I 업체',tugboat_a:'예선 I 척수',tugboat_2:'예선 II 업체',tugboat_b:'예선 II 척수',mooring:'강취',fg_side:'접안현',num_bt_yn:'Bow Thruster',tp_q:'승선검역',final_confirm_1:'시간 최종 확정',shipcompany:'선사',billing:'청구처',etryptyear:'입항년도',etryptco:'항차',cd_cargo:'선박 종류',cd_emp_partner:'담당자',no_hpemp_partner:'연락처',fg_tax:'VAT',e_mail:'청구 이메일',yn_dispilot:'강제도선면제',nm_text:'비고'};
export const pilotLookupStep=(step:string):PilotLookup|null=>step==='from'||step==='to'?'point':['vessel','mooring','shipcompany','billing'].includes(step)?step as PilotLookup:null;
PILOT_LABELS.num_length='LOA / 전장 (m)';
export function pilotCallback(id:string,revision:number,action:string,index?:number){
 const result=`pr:${id.replaceAll('-','')}:${revision}:${action}${index===undefined?'':':'+index}`;
 if(new TextEncoder().encode(result).length>64)throw Error('REG_CALLBACK_LIMIT');return result;
}
export function parsePilotCallback(value:string):{id:string;revision:number;action:string;index?:number}|null{
 const m=value.match(/^pr:([a-f0-9]{32}):(\d{1,6}):(pick|page|edit|field|review|confirm|dry|cancel|recheck|retry|attest)(?::(\d{1,3}))?$/);
 if(!m||value.length>64)return null;const s=m[1];
 return {id:`${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`,revision:Number(m[2]),action:m[3],index:m[4]===undefined?undefined:Number(m[4])};
}
const pilotOptionLabel=(key:string,value:string,fallback:string)=>{
 if(key==='fg_inoutport')return REG_MOVEMENTS[value as keyof typeof REG_MOVEMENTS]??fallback;
 if(key==='tp_cargo')return value==='L'?'적재':'공선';
 if(key==='fg_tax')return ({'020':'외국적','010':'국적(영세)','090':'국적(부가세)'} as Record<string,string>)[value]??fallback;
 if(['tp_vessel','num_bt_yn','final_confirm_1','yn_dispilot'].includes(key))return value==='Y'?'예':'아니오';
 if(key==='tp_q')return value==='Y'?'승검':'미승검';
 return fallback;
};
export function pilotStepChoices(d:PilotDraft,now=Date.now()):PilotChoice[]{
  if(d.choices)return d.choices;
 if(d.step==='shipcompany'&&d.fields.cd_partner_ship)return [{label:d.fields.ln_partner_ship+' (현재 선택)',values:{ln_partner_ship:d.fields.ln_partner_ship,cd_partner_ship:d.fields.cd_partner_ship}}];
 if(d.step==='billing'&&d.fields.cd_partner_chg)return [{label:d.fields.ln_partner_chg+' (현재 선택)',values:{ln_partner_chg:d.fields.ln_partner_chg,cd_partner_chg:d.fields.cd_partner_chg}}];
 if(d.step==='mooring')return [{label:'강취 없음',values:{sn_partner:'',cd_partner_line:'',tel_partner_line:''}}];
 if(d.step==='dt_ship')return [0,1,2].map((n)=>({label:['오늘','내일','모레'][n],values:{dt_ship:new Date(now+9*3600000+n*86400000).toISOString().slice(0,10).replaceAll('-','')}}));
 const options=d.form.options[d.step];
 if(options){const list=options.filter(o=>!['fg_inoutport','cd_cargo','fg_tax'].includes(d.step)||o.value).map(o=>({label:o.value?pilotOptionLabel(d.step,o.value,o.label):'없음 / 미선택',values:{[d.step]:o.value}}));
   if(d.step==='yn_dispilot')list.push({label:'아니오',values:{yn_dispilot:''}});return list;}
 return [];
}
export function applyPilotChoice(d:PilotDraft,c:PilotChoice):void{
 if(['from','to'].includes(d.step))for(const [k,v] of Object.entries(c.values))d.fields[k+'_'+(d.step==='from'?'f':'t')]=v;
 else Object.assign(d.fields,c.values);
 advancePilotDraft(d);
}
export function advancePilotDraft(d:PilotDraft){
 d.choices=undefined;d.page=0;
 if(d.returnToReview){d.step='review';d.returnToReview=false;return;}
 const next=PILOT_STEPS[PILOT_STEPS.indexOf(d.step)+1];d.step=next??'review';
}
export function applyPilotText(d:PilotDraft,input:string){
 const v=input.trim();if(!v||v.length>1200||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v))throw Error('REG_INPUT');
 if(d.step==='dt_ship'){
   if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)throw Error('REG_DATE_FORMAT');d.fields.dt_ship=v.replaceAll('-','');
 }else if(d.step==='time'){
   const time=v.match(/^([01]\d|2[0-3]):?([0-5]\d)$/);
   if(!time)throw Error('REG_TIME_FORMAT');[d.fields.tm_ship_h,d.fields.tm_ship_i]=time.slice(1);
 }else if(d.step==='num_draft'||d.step==='num_length'){
   if(!(d.step==='num_draft'?/^\d{1,2}(?:\.\d{1,2})?$/:/^\d{1,3}(?:\.\d{1,2})?$/).test(v))throw Error('REG_DRAFT_OR_LOA_NUMBER');d.fields[d.step]=v;
 }else if(d.step==='etryptyear'){
   if(!/^\d{4}$/.test(v))throw Error('REG_YEAR_FORMAT');d.fields.etryptyear=v;
 }else if(['etryptco','cd_emp_partner','no_hpemp_partner','e_mail','nm_text'].includes(d.step)){
   if(['cd_emp_partner','no_hpemp_partner'].includes(d.step)&&(v==='없음'||v.length>80))throw Error('REG_CONTACT_REQUIRED');
   if(d.step==='no_hpemp_partner'&&!/^[+()\d -]{7,40}$/.test(v))throw Error('REG_PHONE_FORMAT');
   if(d.step==='e_mail'&&v!=='없음'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))throw Error('REG_EMAIL_FORMAT');
   if(d.step==='nm_text')validatePilotRemark(d.form,v==='없음'?'':v);
   d.fields[d.step]=v==='없음'?'':v;
 }else throw Error('REG_SELECT_BUTTON');
 advancePilotDraft(d);
}
export function pilotSummary(d:PilotDraft,options:{revealContacts?:boolean}={}):string{
 const f=d.fields,option=(k:string)=>pilotOptionLabel(k,f[k],d.form.options[k]?.find(o=>o.value===f[k])?.label??f[k]??'-');
 const mask=(v:string)=>v?(options.revealContacts?v:`${v.slice(0,1)}***${v.length>3?v.slice(-2):''}`):'-';
 const lines=[`${d.action==='UPDATE'?'✏️ 도선수정':'📝 도선등록'} ${d.dryRun?'[테스트]':'최종 확인'}`,`선박: ${f.nm_callsign||'-'} / ${f.cd_callsign||'-'} / ${f.nm_nation||'-'}`,
   ...(d.action==='UPDATE'?[`신청번호: ${f.no_forecast}`]:[]),`구분: ${option('fg_inoutport')}`,`일시(KST): ${pilotDateTimeLabel(f.dt_ship,`${f.tm_ship_h}:${f.tm_ship_i}`)}`,
   `FROM: ${f.nm_point_f} (${f.cd_pointrep_f}:${f.cd_pointend_f})`,`TO: ${f.nm_point_t} (${f.cd_pointrep_t}:${f.cd_pointend_t})`,
   `최대흘수: ${f.num_draft} m`,`예선 I: ${option('tugboat_1')} / ${f.tugboat_a}척`,`예선 II: ${option('tugboat_2')} / ${f.tugboat_b}척`,
   `강취: ${f.sn_partner||'없음'}`,`접안현: ${option('fg_side')}`,`Tanker/LPG: ${option('tp_vessel')} / 적재: ${option('tp_cargo')}`,
   `Bow Thruster: ${option('num_bt_yn')} / 검역: ${option('tp_q')}`,`시간 확정: ${option('final_confirm_1')} / 면제: ${option('yn_dispilot')}`,
   `선사: ${f.ln_partner_ship} / 청구처: ${f.ln_partner_chg}`,`대리점: 협운해운`, `입항년도/항차: ${f.etryptyear} / ${f.etryptco||'-'}`,
   `선종: ${option('cd_cargo')} / GT ${f.num_ton} / LOA ${f.num_length}`,`VAT: ${option('fg_tax')}`,
   `담당자: ${mask(f.cd_emp_partner)} / 연락처: ${mask(f.no_hpemp_partner)}`,`청구 이메일: ${mask(f.e_mail)}`,`비고: ${(f.nm_text||'-').slice(0,500)}${f.nm_text?.length>500?' … (미리보기 생략, 전체 값은 인앱에서 확인)':''}`];
 if(d.original){const old=pilotBusinessFields(d.original);const changes=Object.entries(pilotBusinessFields(f)).filter(([k,v])=>old[k]!==v&&k!=='fg_status');
   lines.push('\n변경 전 → 후',...changes.map(([k,v])=>`${PILOT_LABELS[k]??k}: ${['cd_emp_partner','no_hpemp_partner','e_mail','tel_partner_line'].includes(k)?`${mask(old[k])} → ${mask(v)}`:`${old[k]||'-'} → ${v||'-'}`}`));}
 return lines.join('\n');
}
export function renderPilotDraft(d:PilotDraft,id:string,revision:number):{text:string;markup:any}{
 const cb=(a:string,i?:number)=>pilotCallback(id,revision,a,i);
 const cancel={text:'❌ 초안 취소 (외부 신청 취소 아님)',callback_data:cb('cancel')};
 if(d.step==='review')return {text:pilotSummary(d)+'\n\n명시적 확정 전에는 신청/수정하지 않습니다. 서버 필수값·실제 접수 응답은 실거래 검증 전입니다.',markup:{inline_keyboard:[[{text:d.dryRun?'🧪 전송 없는 검증':d.action==='CREATE'?'✅ 등록확정':'✅ 수정확정',callback_data:cb(d.dryRun?'dry':'confirm')}],[{text:'🧪 Dry Run',callback_data:cb('dry')},{text:'✏️ 초안 수정',callback_data:cb('edit')}],[cancel]]}};
 if(d.step==='edit')return {text:'수정할 항목을 선택하세요. 수정하면 이전 확인 버튼은 무효입니다.',markup:{inline_keyboard:PILOT_STEPS.filter(k=>d.action==='CREATE'||k!=='vessel').map(k=>[{text:PILOT_LABELS[k],callback_data:cb('field',PILOT_STEPS.indexOf(k))}]).concat([[{text:'전체 내용 확인',callback_data:cb('review')}],[cancel]])}};
 const choices=pilotStepChoices(d),page=d.page??0;
 const prompt=`${d.action==='CREATE'?'➕ 도선등록':'✏️ 도선수정'}${d.dryRun?' [테스트]':''}\n${PILOT_LABELS[d.step]??d.step} ${pilotLookupStep(d.step)?'검색어를 이 질문에 답장으로 입력하세요.':'값을 선택하거나 이 질문에 답장으로 입력하세요.'}`+
   (d.step==='time'?'\nHHmm 또는 HH:mm (예: 0615 / 06:15)':d.step==='dt_ship'?'\nYYYY-MM-DD':d.step==='nm_text'?`\n사이트 안내 문구: 20자 이내 권장. 입력 한도: ${pilotRemarkLimit(d.form)}자. 없으면 없음`:d.step==='application'?'\n협운일정의 신청번호 (완료·청구·취소 건 제외)':d.step==='num_draft'?'\n현재 업무의 실제 최대흘수, m':
   ['cd_emp_partner','no_hpemp_partner','e_mail'].includes(d.step)?'\n⚠️ 그룹에 입력한 원문은 참여자에게 보입니다. 저장은 암호화하며 알림에는 마스킹합니다.':'' )+
   '\n기존 조회 명령은 계속 사용할 수 있습니다. 초안은 20분 후 만료됩니다.';
 if(choices.length){const keyboard=choices.slice(page*8,page*8+8).map((c,i)=>[{text:c.label.slice(0,64),callback_data:cb('pick',page*8+i)}]);
   const nav=[];if(page>0)nav.push({text:'이전',callback_data:cb('page',page-1)});if((page+1)*8<choices.length)nav.push({text:'다음',callback_data:cb('page',page+1)});if(nav.length)keyboard.push(nav);
   keyboard.push([cancel]);return {text:prompt,markup:{inline_keyboard:keyboard}};}
 return {text:prompt+'\n초안 취소: /도선초안취소',markup:{force_reply:true,selective:true,input_field_placeholder:PILOT_LABELS[d.step]??'입력'}};
}
