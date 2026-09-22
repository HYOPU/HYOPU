import { database, Meter, bytes } from '../../ulsan-pilot-watcher/lib/runtime.ts';
import type { Config } from '../../ulsan-pilot-watcher/lib/runtime.ts';
import { readBounded } from '../../ulsan-pilot-watcher/lib/source.ts';
import { openSession } from '../../ulsan-pilot-watcher/lib/hyopuSource.ts';
import { PilotRegistrationClient } from '../../_shared/pilot-registration/client.ts';
import { ADVISORY_POLICY, eligibilityWarningMessages } from '../../_shared/pilot-registration/eligibility.ts';
import { pilotBusinessHash, pilotRemarkLimit } from '../../_shared/pilot-registration/contract.ts';
import { pilotSeal, pilotOpen } from '../../_shared/pilot-registration/crypto.ts';
import { PILOT_STEPS, PILOT_LABELS, pilotLookupStep, pilotStepChoices, applyPilotChoice, applyPilotText, pilotSummary } from '../../_shared/pilot-registration/wizard.ts';
import type { PilotDraft } from '../../_shared/pilot-registration/wizard.ts';
import type { PilotRegistrationSettings } from '../../telegram-webhook/lib/registration.ts';
import { verifyMiniApp } from './auth.ts';
import { JSTT_MINI_OPS } from '../../_shared/jstt.ts';
import { handleJsttMini } from './jstt.ts';
import { isPilotRoomParticipant } from '../../_shared/pilotRoomAccess.ts';
import { COPY_CONTROLS, assertCopyDraft, copyFields, makeCopyDraft, readCopySource, prepareCopy } from '../../_shared/pilot-registration/copy.ts';

export interface MiniConfig extends Config { origin:string; adminChats:string[]; registration:PilotRegistrationSettings }
const miniOps = new Set(['load','start','queue','copyList','copyStart','search','pick','text','field','review','save','dry','confirm','cancel']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function miniFormFields(d:PilotDraft){
 return PILOT_STEPS.map(key=>{
  const f=d.fields,lookup=pilotLookupStep(key),options=lookup||key==='dt_ship'?[]:pilotStepChoices({...d,step:key,choices:undefined});
  let value=key==='time'?(f.tm_ship_h&&f.tm_ship_i?`${f.tm_ship_h}:${f.tm_ship_i}`:''):key==='dt_ship'?(f.dt_ship??'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'):f[key]??'';
  if(lookup)value=key==='vessel'?[f.nm_callsign,f.cd_callsign,f.nm_nation].filter(Boolean).join(' / '):key==='from'||key==='to'?`${f['nm_point_'+(key==='from'?'f':'t')]??''}`:key==='mooring'?f.sn_partner??'':f['ln_partner_'+(key==='billing'?'chg':'ship')]??'';
  const selected=options.findIndex(c=>c.values[key]===f[key]);
  return {key,label:PILOT_LABELS[key],kind:lookup?'lookup':options.length?'select':key==='dt_ship'?'date':key==='time'?'time':key==='nm_text'?'textarea':'text',
   // The signed, owner-scoped Mini App shows the actual business values.
   // Telegram messages still use the masked summary by default.
   value,saved:false,...(key==='nm_text'?{maxLength:pilotRemarkLimit(d.form)}:{}),readonly:d.mode==='COPY'?!COPY_CONTROLS.has(key):key==='vessel'&&d.action==='UPDATE',
   ...(options.length?{options:options.map((c,index)=>({index,label:c.label})),selected}: {})};
 });
}
export function applyMiniFields(d:PilotDraft,values:unknown){
 if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).length>30)throw Error('MINI_INPUT');
 for(const [key,value] of Object.entries(values)){
  if(!PILOT_STEPS.includes(key)||pilotLookupStep(key)||(d.mode==='COPY'&&!COPY_CONTROLS.has(key)))throw Error('MINI_FIELD');
  d.step=key;d.choices=undefined;
  const options=key==='dt_ship'?[]:pilotStepChoices(d);
  if(options.length){if(!Number.isInteger(value)||!options[value as number])throw Error('MINI_CHOICE');applyPilotChoice(d,options[value as number]);}
  else{if(typeof value!=='string')throw Error('MINI_INPUT');
   if(value===''&&['num_draft','num_length'].includes(key))d.fields[key]='';
   else applyPilotText(d,value===''&&['etryptco','e_mail','nm_text'].includes(key)?'없음':value);
  }
 }
 d.step='edit';d.choices=undefined;d.returnToReview=false;
}
// Explicit DTO: never expose the source form, cookies, opaque fields or lookup values.
export function miniView(r:any,d:PilotDraft|undefined,enabled:boolean){
  const active=r?.status==='DRAFT'&&!r.expired;
  return {id:r?.id,revision:r?.revision,status:r?.status??'EMPTY',expired:r?.expired??false,
    applicationId:r?.application_id,error:r?.error_code,enabled,action:d?.action,mode:d?.mode,
    ...(d?.copy?{copySource:{id:d.copy.sourceId,applicationId:d.copy.applicationId,date:d.copy.date,observedAt:d.copy.observedAt,archived:d.copy.archived}}:{}),
    ...(active&&d?{step:d.step,label:PILOT_LABELS[d.step]??'전체 내용 확인',
      progress:Math.max(0,PILOT_STEPS.indexOf(d.step)),total:PILOT_STEPS.length,
      search:!!pilotLookupStep(d.step),choices:pilotStepChoices(d).map((c,index)=>({index,label:c.label})),
      summary:pilotSummary(d,{revealContacts:true}),formFields:miniFormFields(d),...(d.original?{originalFields:miniFormFields({...d,fields:d.original})}:{}),fields:PILOT_STEPS.filter(s=>d.action==='CREATE'||s!=='vessel').map((s)=>({key:s,label:PILOT_LABELS[s]}))}: {})};
}
export function createMiniApp(config:MiniConfig,fetcher:typeof fetch=fetch){
 return async(request:Request):Promise<Response>=>{
  const origin=request.headers.get('origin');
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin',
    'Access-Control-Allow-Origin':config.origin,'Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST, OPTIONS'};
  let responseBytes=0;
  const respond=(v:unknown,status=200)=>{let text=JSON.stringify(v);if(bytes(text)>32768)text='{"error":"MINI_RESPONSE_LIMIT"}';responseBytes=bytes(text)+512;return new Response(text,{status,headers});};
  if(!config.origin.startsWith('https://')||origin!==config.origin)return new Response(null,{status:403});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(request.method!=='POST')return respond({error:'MINI_METHOD'},405);
  let body:any,user:number;
  try{
    body=JSON.parse(new TextDecoder().decode(await readBounded(new Response(request.body),12288)));
    if(!body||(!miniOps.has(body.op)&&!JSTT_MINI_OPS.has(body.op))|| (body.id!==undefined&&!uuid.test(body.id)) || (body.revision!==undefined&&(!Number.isInteger(body.revision)||body.revision<1)))throw Error('MINI_INPUT');
    user=await verifyMiniApp(body.initData,config.botToken);
  }catch{return respond({error:'MINI_AUTH_OR_INPUT',message:'Telegram에서 신청서를 다시 열어 주세요. 인증은 20분간 유효합니다.'},401);}
  // A configured fixed room is the destination. Never trust chat_instance as chat_id.
  const chat=config.chatId;if(!config.adminChats.includes(chat))return respond({error:'MINI_ROOM'},403);
  if(JSTT_MINI_OPS.has(body.op))return handleJsttMini(config,body,user,fetcher,respond);
  const meter=new Meter(),rpc=database(config,meter,fetcher);
  let budgetId:string|undefined;
  const measured:typeof fetch=async(url,init)=>{
    const body=String(init?.body??''),h=(init?.headers??{}) as Record<string,string>;
    // HTML received from Ulsan is ingress, not Supabase egress. Leave room for
    // the bounded app response and settlement before starting another request.
    meter.checkRequest(body,h,32768);meter.addRequest(body,h);
    try{return await fetcher(url,init);}catch(error){meter.uncertain=true;throw error;}
  };
  try{
    let r=await rpc<any>('pilot_mini_open',{p_chat:chat,p_user:user,p_id:body.id??null,p_bytes:['start','copyStart','search','dry','confirm'].includes(body.op)?262144:131072,p_reservation:crypto.randomUUID()},33000);
    if(r.error)return respond({error:r.error,message:'요청 한도 또는 도선봇 비용 보호로 중지되었습니다.'},429);
    budgetId=r.budget_id;if(budgetId)meter.limit=r.reserved_bytes;
    const member=await measured(`https://api.telegram.org/bot${config.botToken}/getChatMember`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chat,user_id:user}),redirect:'error',signal:AbortSignal.timeout(6000)});
    const role=JSON.parse(new TextDecoder().decode(await readBounded(member,8192)));
    if(!member.ok||!role.ok||!isPilotRoomParticipant(role.result))return respond({error:'MINI_MEMBER',message:'전용 방의 현재 참여자만 신청할 수 있습니다.'},403);
    const settings=config.registration;
    let d:PilotDraft|undefined=r.sealed_data?await pilotOpen<PilotDraft>(r.sealed_data,settings.sessionKey,r.id):undefined;
    const view=()=>({...miniView(r,d,d?.action==='UPDATE'?settings.updateEnabled:settings.createEnabled&&(d?.mode!=='COPY'||settings.copyEnabled===true)),eligibilityPolicy:settings.eligibilityPolicy??'strict'});
    if(body.op==='load')return respond(view());
    if(body.op==='queue'){
      const page=Number(body.page??0);if(!Number.isInteger(page)||page<0||page>999)throw Error('MINI_PAGE');
      const queue=await rpc<any>('hpbot_read',{p_command:'queue',p_page:page},24000);
      return respond({rows:queue.rows.map((x:any)=>({id:x.application_id,label:`${x.application_id} · ${x.vessel_name} · ${x.pilot_date} ${x.pilot_time}`})),page,total:queue.total});
    }
    let source:PilotRegistrationClient|undefined;
    const getSource=async()=>{
      if(!source){const ctx=await rpc<any>('pilot_reg_context',{},14000);
        source=new PilotRegistrationClient(settings,measured,ctx.sealed_session?await openSession(ctx.sealed_session,settings.sessionKey):[]);
        await source.authenticate(new Date(Date.now()+9*3600000).toISOString().slice(0,10));}
      return source;
    };
    if(body.op==='copyList'){
      const page=Number(body.page??0),search=body.search??'';
      if(!Number.isInteger(page)||page<0||page>999||typeof search!=='string'||search.length>80)throw Error('MINI_PAGE');
      let warning='';
      const days=page===0?await rpc<number>('pilot_copy_catalog_claim',{p_days:settings.copyHistoryDays??30}):0;
      if(days)try{
        const client=await getSource(),today=new Date(Date.now()+9*3600000).toISOString().slice(0,10),end=Date.parse(today+'T00:00:00Z');
        const rows=[];
        for(let i=days-1;i>=0;i-=7){const start=new Date(end-i*86400000).toISOString().slice(0,10),finish=new Date(end-Math.max(0,i-6)*86400000).toISOString().slice(0,10);
          rows.push(...await client.reader.applications({start,end:finish}));
          if(rows.length>1000||new TextEncoder().encode(JSON.stringify(rows)).length>180000)throw Error('COPY_CATALOG_LIMIT');
        }
        await rpc('pilot_copy_catalog_complete',{p_rows:rows});
      }catch{warning='최근 완료 이력을 새로 확인하지 못했습니다. 마지막 수집 목록을 표시합니다.';}
      return respond({...await rpc<any>('pilot_copy_list',{p_page:page,p_search:search},24000),notice:warning});
    }
    if(body.op==='copyStart'){
      if(r.status==='DRAFT'&&!r.expired)throw Error('MINI_EXISTING_DRAFT');
      if(typeof body.sourceId!=='string'||!uuid.test(body.sourceId))throw Error('COPY_SOURCE_INVALID');
      const row=await rpc<any>('pilot_copy_get',{p_id:body.sourceId},34000);
      const client=await getSource(),ref=await readCopySource(client,row,settings.sessionKey);
      if(!ref.archived)await rpc('pilot_copy_store',{p_id:row.id,p_fingerprint:row.fingerprint,p_hash:ref.hash,p_sealed:await pilotSeal({version:1,fields:ref.fields},settings.sessionKey,'copy:'+row.id),p_at:ref.observedAt});
      d=makeCopyDraft(await client.form('CREATE'),ref);
      r={id:crypto.randomUUID(),revision:0,status:'DRAFT'};
    }else if(body.op==='start'){
      if(r.status==='DRAFT'&&!r.expired)throw Error('MINI_EXISTING_DRAFT');
      const action=body.action;if(!['CREATE','UPDATE'].includes(action))throw Error('MINI_ACTION');
      let form;
      if(action==='UPDATE'){
        if(typeof body.application!=='string'||!/^\d{1,30}$/.test(body.application))throw Error('MINI_APPLICATION');
        const row=await rpc<any>('pilot_reg_application',{p_id:body.application});
        if(!row||['050','060','090'].includes(row.status))throw Error('REG_NOT_EDITABLE');
        form=await (await getSource()).form('UPDATE',row.id,row.date);
      }else form=await (await getSource()).form('CREATE');
      d={action,dryRun:false,step:action==='CREATE'?'vessel':'edit',fields:{...form.fields},form};
      if(action==='UPDATE'){d.original={...form.fields};d.originalHash=await pilotBusinessHash(form.fields);}
      else{
        Object.assign(d.fields,{cd_partner:'1002',ln_partner:'협운해운',cd_emp_partner:'',no_hpemp_partner:'',e_mail:'',num_draft:'',nm_text:'',tp_q:'',tp_cargo:'',final_confirm_1:''});
        for(const kind of ['shipcompany','billing'] as const){const choices=await (await getSource()).search(kind,'협운해운');
          const exact=choices.filter(c=>Object.values(c.values).includes('1002')&&Object.values(c.values).includes('협운해운'));
          if(exact.length!==1)throw Error('REG_DEFAULT_COMPANY');Object.assign(d.fields,exact[0].values);}
      }
      r={id:crypto.randomUUID(),revision:0,status:'DRAFT'};
    }else{
      if(!d||!body.id||body.id!==r.id||body.revision!==r.revision)throw Error('MINI_STALE');
      if(r.status!=='DRAFT'||r.expired)throw Error('MINI_NOT_DRAFT');
      if(body.op==='cancel'){
        const status=await rpc('pilot_mini_decide',{p_chat:chat,p_user:user,p_id:r.id,p_revision:r.revision,p_action:'CANCEL'});
        return respond({status,message:'작성 중인 초안만 취소했습니다. 실제 도선신청은 취소하지 않았습니다.'});
      }
      if(body.op==='dry'||body.op==='confirm'){
        if(d.step!=='review')throw Error('REG_REVIEW_REQUIRED');
        if(d.mode==='COPY')assertCopyDraft(d);
        if(body.op==='dry'){
          const client=await getSource();
          const p=d.mode==='COPY'?await prepareCopy(client,d,await rpc('pilot_copy_get',{p_id:d.copy!.sourceId},34000),settings.sessionKey):await client.prepare(d.action,d.fields,d.originalHash);
          const warnings=eligibilityWarningMessages(p.eligibilityWarnings);
          return respond({...view(),eligibilityWarnings:warnings,notice:`로그인·최신 자료·필수값·미래 일시·중복 검사 통과. 동일 구간 다른 시간 ${p.warnings.length}건.${warnings.length?'\n⚠️ '+warnings.join('\n⚠️ '):' 보조검사 정상.'}\n실제 등록·수정 POST 및 그룹 전송: 0회.`});
        }
        if(!(d.action==='CREATE'?settings.createEnabled:settings.updateEnabled))throw Error('REG_FEATURE_DISABLED');
        if(settings.eligibilityPolicy===ADVISORY_POLICY){
          if(body.eligibilityPolicy!==ADVISORY_POLICY)throw Error('REG_POLICY_REVIEW_REQUIRED');
          // Durable policy acknowledgement belongs to this owner/revision, never
          // to arbitrary client business fields. Save before atomic approval.
          d.eligibilityPolicy=ADVISORY_POLICY;
          r.revision=await rpc<number>('pilot_mini_save',{p_chat:chat,p_user:user,p_id:r.id,p_revision:r.revision,p_action:d.action,
            p_sealed:await pilotSeal(d,settings.sessionKey,r.id),p_original_hash:d.originalHash??null,p_application:d.action==='UPDATE'?d.fields.no_forecast:null,
            ...(d.copy?{p_copy_source:d.copy.sourceId,p_copy_hash:d.copy.hash,p_copy_audit:await pilotSeal({source:d.copy,after:copyFields(d.fields),changedFields:d.copyChangedFields},settings.sessionKey,'audit:'+r.id)}:{})});
        }
        if(d.mode==='COPY'){
          if(!settings.copyEnabled)throw Error('COPY_FEATURE_DISABLED');
          await prepareCopy(await getSource(),d,await rpc('pilot_copy_get',{p_id:d.copy!.sourceId},34000),settings.sessionKey);
        }
        const status=await rpc<string>('pilot_mini_decide',{p_chat:chat,p_user:user,p_id:r.id,p_revision:r.revision,p_action:'CONFIRM'});
        return respond({id:r.id,revision:r.revision,status,message:status==='CONFIRMED'?'최종 승인되었습니다. 클라우드에서 최신 자료를 검사한 후 처리 결과만 전용 그룹에 보냅니다. 중복 제출하지 마세요.':'제출하지 않았습니다. 처리상태를 다시 확인해 주세요.'});
      }
      if(body.op==='search'){
        if(d.mode==='COPY'&&!['from','to'].includes(body.field??d.step))throw Error('COPY_LOCKED_FIELD');
        if(body.field!==undefined){if(!PILOT_STEPS.includes(body.field)||!pilotLookupStep(body.field)||(body.field==='vessel'&&d.action==='UPDATE'))throw Error('MINI_FIELD');d.step=body.field;d.choices=undefined;}
        const lookup=pilotLookupStep(d.step);
        if(!lookup||typeof body.text!=='string'||body.text.trim().length<1||body.text.length>80)throw Error('MINI_SEARCH');
        d.choices=await (await getSource()).search(lookup,body.text.trim());d.page=0;
        if(d.choices.length>40)throw Error('REG_DRAFT_TOO_LARGE_NARROW_SEARCH');
        if(!d.choices.length)throw Error('REG_SEARCH_NO_RESULTS');
      }else if(body.op==='pick'){
        if(d.mode==='COPY'&&!['from','to'].includes(d.step))throw Error('COPY_LOCKED_FIELD');
        if(body.field!==undefined&&body.field!==d.step)throw Error('MINI_STALE');
        if(!Number.isInteger(body.index))throw Error('MINI_CHOICE');
        const choice=pilotStepChoices(d)[body.index];if(!choice)throw Error('MINI_CHOICE');applyPilotChoice(d,choice);
      }else if(body.op==='save'){
        applyMiniFields(d,body.values);
        if(body.review===true)d.step='review';
      }else if(body.op==='text'){
        if(d.mode==='COPY'&&!['dt_ship','time'].includes(d.step))throw Error('COPY_LOCKED_FIELD');
        if(typeof body.text!=='string')throw Error('MINI_INPUT');applyPilotText(d,body.text);
      }else if(body.op==='field'){
        if(d.mode==='COPY'&&!COPY_CONTROLS.has(body.field))throw Error('COPY_LOCKED_FIELD');
        if(!PILOT_STEPS.includes(body.field)||(d.action==='UPDATE'&&body.field==='vessel')||!['edit','review'].includes(d.step))throw Error('MINI_FIELD');
        d.step=body.field;d.returnToReview=true;d.choices=undefined;
      }else if(body.op==='review'){
        if(d.step!=='edit')throw Error('REG_REVIEW_REQUIRED');d.step='review';d.choices=undefined;
      }
    }
    if(d.mode==='COPY'){
      assertCopyDraft(d);
      d.copyChangedFields=Object.keys(d.copy!.fields).filter(k=>d.copy!.fields[k]!==d.fields[k]);
    }
    r.revision=await rpc<number>('pilot_mini_save',{p_chat:chat,p_user:user,p_id:r.id,p_revision:r.revision,p_action:d.action,
      p_sealed:await pilotSeal(d,settings.sessionKey,r.id),p_original_hash:d.originalHash??null,p_application:d.action==='UPDATE'?d.fields.no_forecast:null,
      ...(d.copy?{p_copy_source:d.copy.sourceId,p_copy_hash:d.copy.hash,
        p_copy_audit:await pilotSeal({source:d.copy,after:copyFields(d.fields),changedFields:d.copyChangedFields},settings.sessionKey,'audit:'+r.id)}:{})});
    return respond(view());
  }catch(error){
    const raw=error instanceof Error?error.message:'';
    const code=/^[A-Z_0-9]{1,80}$/.test(raw)?raw:'MINI_UNCERTAIN';
    const messages:Record<string,string>={COPY_INCOMPLETE:'원본 상세 부족 — 복사 불가. 확인되지 않은 값은 임의로 채우지 않습니다.',COPY_ORIGINAL_CHANGED:'원본 도선정보가 변경되었습니다. 초안을 취소하고 최신 원본으로 다시 확인하세요.',COPY_LOCKED_FIELD:'복사모드에서는 날짜·시간·FROM·TO만 변경할 수 있습니다.',COPY_FEATURE_DISABLED:'복사등록은 작성·검증 모드입니다. 실제 제출은 아직 활성화하지 않았습니다.',COPY_SOURCE_UNCONFIRMED:'최신 원본을 확인하지 못했습니다. 저장된 값만으로 임의 제출하지 않습니다.',REG_FEATURE_DISABLED:'실제 등록·수정은 안전 검증 대기 중입니다. 아직 전송하지 않았습니다.',
      REG_BILLING_AUTH_REQUIRED:'선택한 청구처가 잘못됐다는 뜻이 아닙니다. 도선사회 청구처 보조검사가 인증 오류를 반환해 중단했습니다. 초안은 유지되며 실제 신청은 전송하지 않았습니다.',
      REG_COMPANY_AUTH_REQUIRED:'도선사회 수정 신청의 선사 보조검사가 인증 오류를 반환해 중단했습니다. 초안은 유지되며 실제 수정은 전송하지 않았습니다.',
      REG_TIME_CHECK_EMPTY:'도선사회 시간 보조검사가 빈 응답을 반환해 허용 여부를 확인하지 못했습니다. 초안은 유지되며 실제 신청은 전송하지 않았습니다.',
      REG_POLICY_REVIEW_REQUIRED:'신청서를 다시 열어 최신 보조검사 안내를 확인한 뒤 최종 확정해 주세요. 아직 전송하지 않았습니다.',
      REG_REMARK_LIMIT:'비고가 현재 입력 길이 제한을 넘었습니다. 내용을 임의로 자르지 않았으니 길이를 확인해 주세요.',
      MINI_STALE:'다른 화면에서 초안이 변경되었습니다. 상태를 새로 확인하세요.',MINI_EXISTING_DRAFT:'작성 중인 초안이 있습니다. 이어서 작성하거나 초안을 먼저 취소하세요.',
      REG_SEARCH_NO_RESULTS:'검색 결과가 없습니다. 다른 검색어를 입력하세요.'};
    return respond({error:code,message:messages[code]??'처리를 완료하지 못했습니다. 자동 재제출하지 않습니다. 상태를 다시 확인하세요.'},409);
  }finally{
    // Crash/uncertain transport: retain the full reservation, never guess a refund.
    // The margin covers this final RPC, its authenticated headers and reply.
    if(budgetId&&!meter.uncertain){
      const estimate=meter.total+responseBytes+4096;
      meter.limit=Infinity;
      await rpc('pilot_budget_settle',{p_id:budgetId,p_bytes:estimate}).catch(()=>{});
    }
  }
 };
}
