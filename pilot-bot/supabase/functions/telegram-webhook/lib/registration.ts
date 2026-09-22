import { database, Meter } from '../../ulsan-pilot-watcher/lib/runtime.ts';
import type { Config } from '../../ulsan-pilot-watcher/lib/runtime.ts';
import { drainPilotNotifications } from '../../ulsan-pilot-watcher/lib/hyopuRuntime.ts';
import { openSession } from '../../ulsan-pilot-watcher/lib/hyopuSource.ts';
import { PilotRegistrationClient } from '../../_shared/pilot-registration/client.ts';
import { ADVISORY_POLICY, eligibilityPolicyNotice, eligibilityWarningMessages } from '../../_shared/pilot-registration/eligibility.ts';
import type { RegistrationSourceConfig } from '../../_shared/pilot-registration/client.ts';
import { pilotBusinessHash } from '../../_shared/pilot-registration/contract.ts';
import { pilotOpen, pilotSeal } from '../../_shared/pilot-registration/crypto.ts';
import { PILOT_STEPS, parsePilotCallback, pilotCallback, pilotLookupStep, pilotStepChoices, applyPilotChoice, applyPilotText, renderPilotDraft, pilotSummary } from '../../_shared/pilot-registration/wizard.ts';
import type { PilotDraft } from '../../_shared/pilot-registration/wizard.ts';
import { parseCommand } from './commands.ts';

export interface PilotRegistrationSettings extends RegistrationSourceConfig { sessionKey:string }
export const registrationAliases:Record<string,string>={도선등록:'create',도선수정:'update',도선등록테스트:'dry',신청처리상태:'status',도선초안취소:'cancel'};
export function registrationCommand(text:string){return registrationAliases[text.normalize('NFKC').trim().replace(/^[^\p{L}\p{N}/]+/u,'').replace(/^\//,'').replace(/\s+/g,'')]??null;}
export const registrationMenuRows=[['➕ 도선등록','✏️ 도선수정'],['🧪 도선등록테스트','📄 신청처리상태']];
type RegWebhookConfig=Config & {registration?:PilotRegistrationSettings;botUsername:string;gatewayJwt:string;miniAppEnabled?:boolean};
const regErrorText=(code:string)=>({REG_BILLING_AUTH_REQUIRED:'⚠️ 청구처 선택 오류가 아니라 도선사회 청구처 보조검사의 인증 오류입니다. 초안은 유지되며 실제 등록·수정은 전송하지 않았습니다.',REG_COMPANY_AUTH_REQUIRED:'⚠️ 도선사회 수정 신청의 선사 보조검사가 인증 오류를 반환했습니다. 초안은 유지되며 실제 수정은 전송하지 않았습니다.',REG_TIME_CHECK_EMPTY:'⚠️ 도선사회 시간 보조검사가 빈 응답을 반환했습니다. 초안은 유지되며 실제 등록·수정은 전송하지 않았습니다.',REG_DUPLICATE:'⚠️ 동일 호출부호·일시·정확한 구간의 활성 신청이 이미 있습니다. 전송하지 않았습니다.',REG_ORIGINAL_CHANGED:'⚠️ 작성 이후 사이트 원본이 변경되었습니다. 초안을 취소하고 최신 수정 화면에서 다시 시작해 주세요.',REG_NOT_EDITABLE:'완료·청구·취소 건은 수정하지 않습니다.',REG_PAST_OR_INVALID_TIME:'과거 또는 잘못된 일시입니다. 날짜·시간을 수정하세요.',REG_FEATURE_DISABLED:'실제 제출 기능은 비활성화 상태입니다. Dry Run만 가능합니다.'} as Record<string,string>)[code]??`⚠️ 처리하지 않았습니다. 코드: ${/^[A-Z_0-9]{1,80}$/.test(code)?code:'REG_PROCESSING_ERROR'}\n초안은 보존됩니다. 외부 신청 결과는 신청처리상태에서 확인하세요.`;

/** True when a registration update was consumed. Existing explicit commands
 * always pass through untouched, even while a draft is active. */
export async function handleRegistrationUpdate(config:RegWebhookConfig,update:any,fetcher:typeof fetch,
  memberCheck:(chat:string,user:number)=>Promise<boolean>,answerCallback:(id:string)=>Promise<void>):Promise<boolean>{
 const cb=update.callback_query,m=cb?.message??update.message,from=cb?.from??m?.from,chat=String(m.chat.id);
 const callback=cb?parsePilotCallback(String(cb.data??'')):null;
 const name=!cb?registrationCommand(String(m.text??'')):null;
 const prior=!cb?parseCommand(String(m.text??''),config.botUsername):null;
 if(!callback&&!name&&prior?.explicit)return false;
 if(cb&&!callback)return false;
 const rpc=database(config,new Meter(),fetcher);
 if(!callback&&!name){
   if(!m.reply_to_message?.from?.is_bot||!Number.isSafeInteger(m.reply_to_message?.message_id)||typeof m.text!=='string'||m.text.length>1200)return false;
   if(!await rpc<boolean>('pilot_reg_is_reply',{p_chat:chat,p_user:from.id,p_message:m.reply_to_message.message_id}))return false;
 }
 let accepted=false;let record:any=null;let draft:PilotDraft|undefined;
 const reply=async(text:string,markup:any=null)=>{
   await rpc('pilot_reg_reply',{p_update:update.update_id,p_id:record?.id??null,p_revision:record?.revision??0,p_message:text,p_markup:markup,p_reply:m.message_id});
   await drainPilotNotifications(config,rpc,fetcher);
 };
 try{
   accepted=await rpc<boolean>('hpbot_accept_update',{p_update:update.update_id,p_chat:chat,p_user:from.id,p_command:'registration'});
   if(!accepted){await drainPilotNotifications(config,rpc,fetcher);return true;}
   if(cb?.id)await answerCallback(cb.id).catch(()=>{});
   if(!await memberCheck(chat,from.id)){await reply('⛔ 도선등록·수정 권한이 없습니다. 이 방의 현재 참여자만 사용할 수 있습니다.');return true;}
   // Opt-in only after isolated app/API and BotFather URL verification.
   if(config.miniAppEnabled&&['create','update','dry'].includes(name??'')){
     if(!/^[A-Za-z0-9_]{5,32}$/.test(config.botUsername))throw Error('REG_MINIAPP_CONFIG');
     await reply('🚢 도선신청서\n아래 신청서에서 모든 항목을 선택하세요. 중간 입력은 채팅에 보내지 않으며, 최종 확정 후 처리 결과만 이 방에 알립니다.',
       {inline_keyboard:[[{text:'📋 도선신청서 열기',url:`https://t.me/${config.botUsername}?startapp=pilot&mode=compact`}]]});return true;
   }
   if(!config.registration){await reply('등록 모듈의 서버 설정이 아직 준비되지 않았습니다. 실제 신청은 전송하지 않았습니다.');return true;}
   const settings=config.registration;
   let source:PilotRegistrationClient|undefined;
   const getSource=async()=>{
     if(!source){if(!await rpc<boolean>('pilot_reserve',{p_bytes:65536}))throw Error('REG_BUDGET');
       const context=await rpc<any>('pilot_reg_context',{},14000);
       const cookies=context.sealed_session?await openSession(context.sealed_session,settings.sessionKey):[];
       source=new PilotRegistrationClient(settings,fetcher,cookies);
       await source.authenticate(new Date(Date.now()+9*3600000).toISOString().slice(0,10));
     }return source;
   };
   const loadApplication=async(id:string)=>{
     if(!/^\d{1,30}$/.test(id))throw Error('REG_APPLICATION_ID');
     const row=await rpc<any>('pilot_reg_application',{p_id:id});if(!row||['050','060','090'].includes(row.status))throw Error('REG_NOT_EDITABLE');
     const form=await (await getSource()).form('UPDATE',id,row.date);
     draft!.form=form;draft!.fields={...form.fields};draft!.original={...form.fields};draft!.originalHash=await pilotBusinessHash(form.fields);draft!.step='edit';draft!.choices=undefined;
   };
   if(['create','dry','update'].includes(name??'')){
     const action=name==='update'?'UPDATE':'CREATE',id=crypto.randomUUID();
     // UPDATE starts with an ID prompt; no arbitrary form or write endpoint call.
     const form=action==='CREATE'?await (await getSource()).form('CREATE'):{action,fields:{},options:{},hidden:[]} as any;
     draft={action,dryRun:name==='dry',step:action==='CREATE'?'vessel':'application',fields:{...form.fields},form};
     if(action==='CREATE'){
       Object.assign(draft.fields,{cd_partner:'1002',ln_partner:'협운해운',cd_emp_partner:'',no_hpemp_partner:'',e_mail:'',num_draft:'',nm_text:'',tp_q:'',tp_cargo:'',final_confirm_1:''});
       for(const kind of ['shipcompany','billing'] as const){const candidates=await (await getSource()).search(kind,'협운해운');const matches=candidates.filter(c=>Object.values(c.values).includes('1002')&&Object.values(c.values).includes('협운해운'));if(matches.length!==1)throw Error('REG_DEFAULT_COMPANY');Object.assign(draft.fields,matches[0].values);}
     }else{const queue=await rpc<any>('hpbot_read',{p_command:'queue'},24000);draft.choices=queue.rows.map((r:any)=>({label:`${r.application_id} ${r.vessel_name} ${r.pilot_date} ${r.pilot_time}`,values:{no_forecast:r.application_id}}));}
     const revision=await rpc<number>('pilot_reg_start',{p_update:update.update_id,p_id:id,p_action:action,p_sealed:await pilotSeal(draft,settings.sessionKey,id)});
     record={id,revision,status:'DRAFT'};
   }else{
     record=await rpc<any>('pilot_reg_get',{p_update:update.update_id,p_id:callback?.id??null,p_reply:!name&&!callback?m.reply_to_message.message_id:null},120000);
     if(!record){await reply('활성 신청 초안이 없거나 이 질문의 작성자가 아닙니다. 도선등록 / 도선수정으로 시작하세요.');return true;}
     if(callback&&callback.revision!==record.revision){await reply('이전 버전의 버튼입니다. 최신 질문과 확인 화면을 사용하세요.');return true;}
     if(name==='status'){
       const markup=record.status==='UNKNOWN'?{inline_keyboard:[[{text:'🔎 읽기 전용 재확인',callback_data:pilotCallback(record.id,record.revision,'recheck')}],[{text:'미접수 직접 확인 후 새 초안',callback_data:pilotCallback(record.id,record.revision,'retry')}]]}:null;
       await reply(`📄 [신청처리상태]\n요청: ${record.id}\n${record.action} / ${record.status}\n신청번호: ${record.application_id??'미확인'}\n${record.error_code??''}\nUNKNOWN은 자동 재제출하지 않습니다.`,markup);return true;
     }
     if(callback?.action==='recheck'){
       await rpc('pilot_reg_recheck',{p_update:update.update_id,p_id:record.id});await reply('읽기 전용 재확인을 요청했습니다. 외부 POST는 재전송하지 않습니다.');return true;
     }
     draft=await pilotOpen<PilotDraft>(record.sealed_data,settings.sessionKey,record.id);
     if(callback?.action==='retry'&&record.status==='UNKNOWN'){
       await reply('도선사회 신청목록에서 이 건이 미접수임을 직접 확인했나요? 확인 시 별도 새 초안을 만들며, 다시 최종 확인하기 전에는 전송하지 않습니다.',{inline_keyboard:[[{text:'미접수 직접 확인 · 새 초안 작성',callback_data:pilotCallback(record.id,record.revision,'attest')}]]});return true;
     }
     if(callback?.action==='attest'&&record.status==='UNKNOWN'){
       // New ID, new final confirmation and full duplicate preflight are mandatory.
       const id=crypto.randomUUID();draft.prepared=undefined;draft.step='review';
       record={id,revision:await rpc<number>('pilot_reg_start',{p_update:update.update_id,p_id:id,p_action:draft.action,p_sealed:await pilotSeal(draft,settings.sessionKey,id)}),status:'DRAFT'};
     }else{
       if(record.status!=='DRAFT'||record.expired){await reply(`초안이 만료되었거나 이미 처리 중입니다 (${record.status}). 신청처리상태를 조회하세요.`);return true;}
       if(name==='cancel'||callback?.action==='cancel'){
         await rpc('pilot_reg_decide',{p_update:update.update_id,p_id:record.id,p_revision:record.revision,p_action:'CANCEL'});await reply('초안만 취소했습니다. 도선사회에 등록된 신청은 취소하지 않았습니다.');return true;
       }
       if(callback?.action==='confirm'||callback?.action==='dry'){
         if(draft.step!=='review')throw Error('REG_REVIEW_REQUIRED');
         if(callback.action==='dry'||draft.dryRun){
           const prepared=await (await getSource()).prepare(draft.action,draft.fields,draft.originalHash);
           const warnings=eligibilityWarningMessages(prepared.eligibilityWarnings);
           await reply(`🧪 [도선 ${draft.action==='CREATE'?'등록':'수정'} 테스트]\n${pilotSummary(draft)}\n\n로그인·최신 폼·선박/구간/업체·미래 일시·중복 검사: 통과${warnings.length?'\n⚠️ '+warnings.join('\n⚠️ '):' / 보조검사 정상'}\n동일 구간 다른 시간: ${prepared.warnings.length}건\nPayload 생성: 정상\n실제 등록·수정 POST: 전송하지 않음`,{inline_keyboard:[[{text:'✏️ 초안 수정',callback_data:pilotCallback(record.id,record.revision,'edit')}]]});return true;
         }
         if(!(draft.action==='CREATE'?settings.createEnabled:settings.updateEnabled))throw Error('REG_FEATURE_DISABLED');
         if(settings.eligibilityPolicy===ADVISORY_POLICY&&draft.eligibilityPolicy!==ADVISORY_POLICY)throw Error('REG_POLICY_REVIEW_REQUIRED');
         const decision=await rpc<string>('pilot_reg_decide',{p_update:update.update_id,p_id:record.id,p_revision:record.revision,p_action:'CONFIRM'});
         if(decision!=='CONFIRMED')throw Error('REG_'+decision);
         await reply('⏳ 승인된 요청을 처리합니다. 최신 원본·중복을 다시 검사하고 신청목록/상세 재조회가 확인된 경우에만 완료로 안내합니다.');
         // Cloud recovery dispatches CONFIRMED if this invocation is interrupted.
         await fetcher(`${config.url}/functions/v1/ulsan-pilot-registration`,{method:'POST',headers:{Authorization:`Bearer ${config.gatewayJwt}`,'x-watcher-key':config.watcherKey,'Content-Type':'application/json'},body:JSON.stringify({request_id:record.id}),redirect:'error',signal:AbortSignal.timeout(1000)}).catch(()=>{});
         return true;
       }
       if(callback?.action==='edit'){draft.step='edit';draft.choices=undefined;}
       else if(callback?.action==='review'){if(draft.step!=='edit')throw Error('REG_REVIEW_REQUIRED');draft.step='review';draft.choices=undefined;}
       else if(callback?.action==='field'){
         const step=PILOT_STEPS[callback.index??-1];if(!step||(draft.action==='UPDATE'&&step==='vessel'))throw Error('REG_FIXED_IDENTITY');
         draft.step=step;draft.returnToReview=true;draft.choices=undefined;draft.page=0;
       }else if(callback?.action==='page'){
         if((callback.index??-1)<0||(callback.index??0)*8>=pilotStepChoices(draft).length)throw Error('REG_PAGE');draft.page=callback.index;
       }else if(callback?.action==='pick'){
         const choice=pilotStepChoices(draft)[callback.index??-1];if(!choice)throw Error('REG_CHOICE');
         if(draft.step==='application')await loadApplication(choice.values.no_forecast);else applyPilotChoice(draft,choice);
       }else if(!callback){
         if(draft.step==='application'){
           await loadApplication(String(m.text).trim());
         }else{
           const lookup=pilotLookupStep(draft.step);
           if(lookup){draft.choices=await (await getSource()).search(lookup,String(m.text).trim());draft.page=0;if(!draft.choices.length)throw Error('REG_SEARCH_NO_RESULTS');}
           else applyPilotText(draft,String(m.text));
         }
       }
       if(draft.step==='review')draft.eligibilityPolicy=settings.eligibilityPolicy??'strict';
       record.revision=await rpc<number>('pilot_reg_save',{p_update:update.update_id,p_id:record.id,p_revision:record.revision,p_sealed:await pilotSeal(draft,settings.sessionKey,record.id),p_original_hash:draft.originalHash??null,p_application:draft.action==='UPDATE'?draft.fields.no_forecast??null:null});
     }
   }
   const result=renderPilotDraft(draft!,record.id,record.revision);
   if(draft?.step==='review'&&settings.eligibilityPolicy===ADVISORY_POLICY)result.text+='\n\n⚠️ '+eligibilityPolicyNotice;
   await reply(result.text,result.markup);return true;
 }catch(error){
   if(accepted)await reply(regErrorText(error instanceof Error?error.message:'REG_ERROR')).catch(()=>{});
   return true; // Never make Telegram blindly replay an accepted write command.
 }
}
