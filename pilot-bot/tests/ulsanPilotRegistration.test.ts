// @vitest-environment node
// Synthetic protocol tests. These do not create applications on the real site.
import { describe,it,expect,vi,afterEach } from 'vitest';
import { parsePilotForm,parsePilotChoices,pilotPayload,pilotBusinessHash,validatePilotFields,pilotRemarkLimit,validatePilotRemark } from '../supabase/functions/_shared/pilot-registration/contract';
import type { PilotForm } from '../supabase/functions/_shared/pilot-registration/contract';
import { PilotRegistrationClient,matchesPilot,OFFICIAL_UI_ADVISORY_POLICY } from '../supabase/functions/_shared/pilot-registration/client';
import { pilotOpen,pilotSeal } from '../supabase/functions/_shared/pilot-registration/crypto';
import { PILOT_STEPS,pilotCallback,parsePilotCallback,applyPilotText,applyPilotChoice,pilotStepChoices,renderPilotDraft,pilotSummary } from '../supabase/functions/_shared/pilot-registration/wizard';
import type { PilotDraft } from '../supabase/functions/_shared/pilot-registration/wizard';
import { createRegistrationHandler } from '../supabase/functions/ulsan-pilot-registration/lib/runtime';
import { createWebhook } from '../supabase/functions/telegram-webhook/lib/runtime';
const fields={no_forecast:'123',seq_log:'opaque',xxr:'opaque',fg_status:'020',etryptyear:'2099',etryptco:'',nm_callsign:'TEST VESSEL',cd_callsign:'TEST1',cd_imo:'',cd_nation:'SG',nm_nation:'Singapore',num_ton:'100',num_length:'100',cd_cargo:'4',cd_partner:'1002',ln_partner:'협운해운',dt_ship:'20990101',tm_ship_h:'12',tm_ship_i:'00',cd_pointrep_f:'21',cd_pointend_f:'21002',nm_point_f:'P/S',cd_pointrep_t:'22',cd_pointend_t:'22244',nm_point_t:'OTK(S)',num_draft:'6.20',fg_inoutport:'010',ln_partner_ship:'협운해운',cd_partner_ship:'1002',ln_partner_chg:'협운해운',cd_partner_chg:'1002',cd_emp_partner:'PRIVATE_PERSON',no_hpemp_partner:'010-1234-5678',fg_tax:'020',e_mail:'private@example.test',sn_partner:'진산',nm_text:'',yn_dispilot:''};
const form:PilotForm={action:'CREATE',fields,hidden:['no_forecast','seq_log','xxr'],options:{fg_inoutport:[{value:'010',label:'최초입항'}]}};
const draft=():PilotDraft=>({action:'CREATE',dryRun:false,step:'review',fields:{...fields},form:structuredClone(form)});
const row={application_id:'900',vessel_name:'TEST VESSEL',callsign:'TEST1',pilot_date:'2099-01-01',pilot_time:'12:00',from_location:'P/S',to_location:'OTK(S)',application_status:'010',completion_status:'ACTIVE',agent:'협운',association_remark:'',remarks:'',raw_application_status:'요청',draft:'6.20'};
const sourceConfig={username:'test',password:'test',transport:'http-approved' as const,createEnabled:true,updateEnabled:true};
// Exact observed helper body; intentionally not shortened to an alert regex.
const knownPartnerHelper="\r\n\t\t  <script language='javascript'>\r\n\t\t     alert('로그인 후 사용이 가능합니다.');\r\n\t\t  </script>\r\n\t\t  error";
const html=(action='CREATE',patch={})=>`<html><body>협운해운 ON<form name="ship_frm" method="post" action="${action==='CREATE'?'sub01_01':'sub02_03'}_ok.php">${Object.entries({...fields,...(action==='UPDATE'?{s_cd_partner:'1002'}:{}),...patch}).filter(([k])=>action!=='UPDATE'||k!=='xxr').map(([k,v])=>`<input name="${k}" value="${v}" type="${['xxr','seq_log','no_forecast','fg_status'].includes(k)?'hidden':'text'}">`).join('')}<input type="radio" name="tp_q" value="Y"><input type="radio" name="tp_q" value="N" checked></form></body></html>`;
afterEach(()=>vi.restoreAllMocks());
describe('actual form contract represented by redacted fixtures',()=>{
 it('edit form uses s_cd_partner and has no invented xxr',()=>{const f=parsePilotForm(html('UPDATE'),'UPDATE');expect(f.fields.s_cd_partner).toBe('1002');expect(f.fields).not.toHaveProperty('xxr');});
 it('parses fresh hidden controls and actual single draft',()=>{const f=parsePilotForm(html(),'CREATE');expect(f.fields.num_draft).toBe('6.20');expect(f.fields.tp_q).toBe('N');expect(f.hidden).toContain('xxr');expect(f.fields).not.toHaveProperty('aft_draft');});
 it.each(['050','060','090'])('rejects terminal edit %s',status=>expect(()=>parsePilotForm(html('UPDATE',{fg_status:status}),'UPDATE')).toThrow('REG_NOT_EDITABLE'));
 it('rejects changed action, wrong agency, truncated HTML',()=>{
   expect(()=>parsePilotForm(html().replace('sub01_01_ok.php','sub01_01_callsign_ok.php'),'CREATE')).toThrow();
   expect(()=>parsePilotForm(html('CREATE',{cd_partner:'OTHER'}),'CREATE')).toThrow('REG_ACCOUNT');
   expect(()=>parsePilotForm(html().replace('</html>',''),'CREATE')).toThrow('REG_FORM_TRUNCATED');
 });
 it('preserves latest opaque values and fixes edit identity',()=>{const f={...form,action:'UPDATE' as const};const p=pilotPayload(f,{...fields,xxr:'ATTACK',no_forecast:'456',cd_partner:'other',cd_callsign:'OTHER',fg_status:'090',tm_ship_i:'30'});expect(p).toMatchObject({xxr:'opaque',no_forecast:'123',cd_partner:'1002',cd_callsign:'TEST1',fg_status:'020',tm_ship_i:'30'});});
 it('new blank agency is explicitly bound to authenticated Hyopu',()=>expect(pilotPayload({...form,fields:{...fields,cd_partner:'',ln_partner:''}},fields).cd_partner).toBe('1002'));
 it('does not silently discard an intended value when the fresh form changes',()=>{const f=structuredClone(form);delete f.fields.num_draft;expect(()=>pilotPayload(f,fields)).toThrow('REG_FORM_FIELDS_CHANGED');});
 it('opaque rotations do not hide business conflicts',async()=>{expect(await pilotBusinessHash(fields)).toBe(await pilotBusinessHash({...fields,xxr:'new'}));expect(await pilotBusinessHash(fields)).not.toBe(await pilotBusinessHash({...fields,num_draft:'7'}));});
 it('validates future time, impossible dates, numeric draft and required contact',()=>{
   expect(()=>validatePilotFields(form,fields)).not.toThrow();
   for(const patch of [{dt_ship:'20200230'},{tm_ship_h:'24'},{num_draft:'abc'},{cd_emp_partner:''},{fg_inoutport:'999'}])expect(()=>validatePilotFields(form,{...fields,...patch})).toThrow();
 });
 const remarkHtml=(text:string,attributes='')=>html('UPDATE').replace('<input name="nm_text" value="" type="text">',`<textarea name="nm_text" id="nm_text" placeholder="20자 이내로 입력하세요." ${attributes}>${text}</textarea>`);
 it('does not invent a maximum length from the real remark placeholder',()=>{
   const original='가'.repeat(23),f=parsePilotForm(remarkHtml(original),'UPDATE');
   expect(f.remarkMaxLength).toBeUndefined();expect(pilotRemarkLimit(f)).toBe(1200);
   const unchanged=pilotPayload(f,{}),changed=pilotPayload(f,{nm_text:'나'.repeat(23)});
   expect(()=>validatePilotFields(f,unchanged)).not.toThrow();expect(unchanged.nm_text).toBe(original);
   expect(()=>validatePilotFields(f,changed)).not.toThrow();expect(changed.nm_text).toBe('나'.repeat(23));
 });
 it('preserves the entire original remark including whitespace',()=>{
   const text='  원본 비고\n두번째 줄  ',f=parsePilotForm(remarkHtml(text),'UPDATE');
   expect(f.fields.nm_text).toBe(text);expect(pilotPayload(f,{}).nm_text).toBe(text);
 });
 it('enforces an actual declared maxlength instead of placeholder guidance',()=>{
   const f=parsePilotForm(remarkHtml('원본','maxlength="25"'),'UPDATE');
   expect(f.remarkMaxLength).toBe(25);expect(pilotRemarkLimit(f)).toBe(25);
   expect(()=>validatePilotFields(f,pilotPayload(f,{nm_text:'가'.repeat(25)}))).not.toThrow();
   expect(()=>validatePilotFields(f,pilotPayload(f,{nm_text:'가'.repeat(26)}))).toThrow('REG_REMARK_LIMIT');
   const empty=parsePilotForm(remarkHtml('','maxlength="0"'),'UPDATE');
   expect(()=>validatePilotRemark(empty,'')).not.toThrow();expect(()=>validatePilotRemark(empty,'가')).toThrow('REG_REMARK_LIMIT');
 });
 it.each(['','-1','1.5','twenty','9007199254740992'])('rejects invalid declared remark maxlength %s',value=>{
   expect(()=>parsePilotForm(remarkHtml('',`maxlength="${value}"`),'UPDATE')).toThrow('REG_REMARK_CONTRACT');
 });
 it('caps remark input at1200 and rejects unsafe controls without truncation',()=>{
   expect(()=>validatePilotRemark(form,'가'.repeat(1200))).not.toThrow();
   expect(()=>validatePilotFields(form,{...fields,nm_text:'가'.repeat(1201)})).toThrow('REG_REMARK_LIMIT');
   expect(pilotRemarkLimit({...form,remarkMaxLength:2000})).toBe(1200);
   for(const value of ['bad\x00value','bad\x1fvalue','bad\x7fvalue'])expect(()=>validatePilotRemark(form,value)).toThrow('REG_REMARK_INPUT');
   expect(()=>validatePilotRemark(form,'line1\nline2\tvalue')).not.toThrow();
 });
 it('disambiguates vessels and ignores old voyage draft/contact defaults',()=>{
   const choices=parsePilotChoices('<input name="cb_cd_callsign" value="AA|SAME|IMO|4|100|200|9.9|SG|old voyage|Singapore"><input name="cb_cd_callsign" value="BB|SAME|IMO|4|100|200|8.8|PA||Panama">','vessel');
   expect(choices).toHaveLength(2);expect(choices[0].values).not.toHaveProperty('num_draft');expect(choices[0].label).toContain('AA');
   expect(parsePilotChoices('<input name="cb_cd_partner_chg" value="1002|협운해운|PRIVATE|PHONE|EMAIL">','billing')[0].values).toEqual({cd_partner_chg:'1002',ln_partner_chg:'협운해운'});
 });
 it('uses actual five-part point shape, preserves N/S/T/S and deduplicates DOM clones',()=>{const p='<input name="cb_cd_point" value="22|22244|OTK(S)|온산항|온산오드펠">';const v=parsePilotChoices(p+p,'point');expect(v).toHaveLength(1);expect(v[0].values).toMatchObject({cd_pointrep:'22',cd_pointend:'22244',nm_point:'OTK(S)',nm_pointend:'온산오드펠'});});
});
describe('write-once source client',()=>{
 const prepared=()=>({form,fields:{...fields},baseline:[],warnings:[],businessHash:'test'});
 it.each(['CREATE','UPDATE'] as const)('flag off prevents %s POST',async action=>{const fetcher=vi.fn();const c=new PilotRegistrationClient({...sourceConfig,createEnabled:false,updateEnabled:false},fetcher);const p=prepared();p.form={...form,action};await expect(c.submit(p,{requestId:crypto.randomUUID(),status:'SUBMITTING'})).rejects.toThrow('REG_FEATURE_DISABLED');expect(fetcher).not.toHaveBeenCalled();});
 it('double click and timeout never retry the POST',async()=>{const fetcher=vi.fn(async()=>{throw Error('timeout');});const c=new PilotRegistrationClient(sourceConfig,fetcher);const permit={requestId:crypto.randomUUID(),status:'SUBMITTING' as const};await expect(c.submit(prepared(),permit)).rejects.toThrow();await expect(c.submit(prepared(),permit)).rejects.toThrow('REG_SUBMIT_ONCE');expect(fetcher).toHaveBeenCalledTimes(1);});
 it('HTTP 200 alone is not success',async()=>{const c=new PilotRegistrationClient(sourceConfig,vi.fn(async()=>new Response('OK')));await c.submit(prepared(),{requestId:crypto.randomUUID(),status:'SUBMITTING'});vi.spyOn(c.reader,'applications').mockResolvedValue([]);await expect(c.verify('CREATE',fields,[])).rejects.toThrow('REG_VERIFICATION_REQUIRED');});
 it('requires a new unique ID and full detail value verification',async()=>{const c=new PilotRegistrationClient(sourceConfig);vi.spyOn(c.reader,'applications').mockResolvedValue([row]);vi.spyOn(c,'form').mockResolvedValue({...form,action:'UPDATE',fields:{...fields,no_forecast:'900'}});expect((await c.verify('CREATE',fields,[])).application_id).toBe('900');await expect(c.verify('CREATE',fields,['900'])).rejects.toThrow();vi.spyOn(c,'form').mockResolvedValue({...form,fields:{...fields,num_draft:'8'}});await expect(c.verify('CREATE',fields,[])).rejects.toThrow('REG_DETAIL_MISMATCH');});
 it('update must verify same ID, new processing or other movement is not evidence',async()=>{const c=new PilotRegistrationClient(sourceConfig);vi.spyOn(c.reader,'applications').mockResolvedValue([row]);await expect(c.verify('UPDATE',fields,[])).rejects.toThrow();expect(matchesPilot({...row,pilot_time:'13:00'},fields)).toBe(false);});
 it('a missing detail field cannot verify an application',async()=>{const c=new PilotRegistrationClient(sourceConfig);vi.spyOn(c.reader,'applications').mockResolvedValue([row]);const f=structuredClone(form);delete f.fields.num_draft;vi.spyOn(c,'form').mockResolvedValue(f);await expect(c.verify('CREATE',fields,[])).rejects.toThrow('REG_DETAIL_MISMATCH');});
 it('an authenticated billing rejection or unexpected eligibility response blocks preflight',async()=>{const c=new PilotRegistrationClient(sourceConfig,vi.fn(async()=>new Response("<script>alert('로그인 후 사용이 가능합니다.');</script>")));await expect(c.check('get_check_cd_partner.php',{cd_partner:'1002'})).rejects.toThrow('REG_BILLING_AUTH_REQUIRED');const unexpected=new PilotRegistrationClient(sourceConfig,vi.fn(async()=>new Response('OK')));await expect(unexpected.check('get_check_misu_test.php',{cd_partner:'1002'})).rejects.toThrow('REG_ELIGIBILITY_RESPONSE');});
});
describe('complete read-only preparation protocol',()=>{
 type Action='CREATE'|'UPDATE';
 type Call={path:string;method:string;body:Record<string,string>;headers:Headers};
 async function protocol(action:Action,options:{baseline?:typeof row[];eligibilityPolicy?:'strict'|typeof OFFICIAL_UI_ADVISORY_POLICY;response?:(path:string,occurrence:number)=>string|Response|undefined}={}){
   const draftFields={...fields,cd_partner_line:'3000'};
   const formHtml=html(action,{cd_partner_line:'3000'});
   const calls:Call[]=[];
   const fetcher=vi.fn(async(input:any,init?:RequestInit)=>{
     const path=new URL(String(input)).pathname.split('/').at(-1)!;
     const body=Object.fromEntries(new URLSearchParams(String(init?.body??'')));
     calls.push({path,method:init?.method??'GET',body,headers:new Headers(init?.headers)});
     if(path.endsWith('_ok.php'))throw Error('TEST_EXTERNAL_WRITE_FORBIDDEN');
     const override=options.response?.(path,calls.filter(c=>c.path===path).length);
     if(override!==undefined)return override instanceof Response?override:new Response(override);
     if(path===(action==='CREATE'?'sub01_01.php':'sub02_03.php'))return new Response(formHtml);
     if(path==='get_data_callsign.php')return new Response('<input name="cb_cd_callsign" value="TEST1|TEST VESSEL||4|100|100|6.20|SG||Singapore">');
     if(path==='get_data_bs_point.php')return new Response(body.cd_point==='P/S'
       ?'<input name="cb_cd_point" value="21|21002|P/S|울산항|도선점">'
       :'<input name="cb_cd_point" value="22|22244|OTK(S)|온산항|온산오드펠">');
     if(path==='get_data_partner_ship.php')return new Response('<input name="cb_cd_partner" value="1002|협운해운">');
     if(path==='get_data_partner_chg.php')return new Response('<input name="cb_cd_partner_chg" value="1002|협운해운|IGNORED_CONTACT|IGNORED_PHONE|IGNORED_EMAIL">');
     if(path==='get_data_partner_line.php')return new Response('<input name="cb_cd_partner" value="3000|진산|IGNORED_PHONE">');
     if(['get_check_callsign.php','get_check_misu_test.php','get_check_cd_partner.php'].includes(path))return new Response('N');
     if(path==='cal_data.php')return new Response('Y');
     throw Error('TEST_UNEXPECTED_PATH_'+path);
   });
   const client=new PilotRegistrationClient({...sourceConfig,eligibilityPolicy:options.eligibilityPolicy},fetcher,[{name:'PHPSESSID',value:'synthetic-only',domain:'www.ulsanpilot.co.kr',path:'/crew/',secure:false,expires:null}]);
   // Only the separately tested login/list reader is replaced. Real prepare(),
   // form/lookup parsing, cookie/header construction and eligibility requests run.
   const auth=vi.spyOn(client.reader,'authenticatedApplications').mockResolvedValue([]);
   const applications=vi.spyOn(client.reader,'applications').mockResolvedValue(options.baseline??[]);
   const originalHash=await pilotBusinessHash(parsePilotForm(formHtml,action).fields);
   return {client,calls,auth,applications,draftFields,run:()=>client.prepare(action,draftFields,action==='UPDATE'?originalHash:undefined)};
 }
 it.each(['CREATE','UPDATE'] as const)('%s performs all lookups and its actual eligibility contract without submission',async action=>{
   const p=await protocol(action),prepared=await p.run();
   expect(p.auth).toHaveBeenCalledWith({start:'2099-01-01',end:'2099-01-01'});
   expect(p.applications).toHaveBeenCalledWith({start:'2099-01-01',end:'2099-01-01'});
   expect(p.calls.map(c=>c.path)).toEqual([
     action==='CREATE'?'sub01_01.php':'sub02_03.php',
     'get_data_callsign.php','get_data_bs_point.php','get_data_bs_point.php',
     'get_data_partner_ship.php','get_data_partner_chg.php','get_data_partner_line.php',
     'get_check_callsign.php',action==='CREATE'?'get_check_misu_test.php':'get_check_cd_partner.php',
     'get_check_cd_partner.php','cal_data.php',
   ]);
   expect(p.calls.slice(7).map(c=>c.body)).toEqual([
     {cd_callsign:'TEST1'},{cd_partner:'1002'},{cd_partner:'1002'},
     {dt_ship:'20990101',tm_ship_h:'12',tm_ship_i:'00'},
   ]);
   for(const call of p.calls.slice(1)){
     expect(call.method).toBe('POST');
     expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
     expect(call.headers.get('origin')).toBe('http://www.ulsanpilot.co.kr');
     expect(call.headers.get('referer')).toContain(action==='CREATE'?'/crew/sub01/sub01_01.php':'/crew/sub01/sub02_03.php?no_forecast=123');
     expect(call.headers.get('cookie')).toBe('PHPSESSID=synthetic-only');
   }
   expect(prepared.fields).toMatchObject({cd_partner_ship:'1002',cd_partner_chg:'1002',cd_emp_partner:'PRIVATE_PERSON',no_hpemp_partner:'010-1234-5678'});
   expect(p.calls.some(c=>c.path.endsWith('_ok.php'))).toBe(false);
 });
 it.each(['CREATE','UPDATE'] as const)('%s rejects a real duplicate after the full read-only preflight',async action=>{
   const p=await protocol(action,{baseline:[row]});
   await expect(p.run()).rejects.toThrow('REG_DUPLICATE');
   expect(p.calls.at(-1)?.path).toBe('cal_data.php');
   expect(p.calls.some(c=>c.path.endsWith('_ok.php'))).toBe(false);
 });
 it('UPDATE excludes only its own application from duplicate detection',async()=>{
   const p=await protocol('UPDATE',{baseline:[{...row,application_id:'123'}]});
   expect((await p.run()).baseline).toHaveLength(1);
 });
 it.each([
   ['CREATE','get_check_misu_test.php',1,'REG_COMPANY_AUTH_REQUIRED'],
   ['CREATE','get_check_cd_partner.php',1,'REG_BILLING_AUTH_REQUIRED'],
   ['UPDATE','get_check_cd_partner.php',1,'REG_COMPANY_AUTH_REQUIRED'],
   ['UPDATE','get_check_cd_partner.php',2,'REG_BILLING_AUTH_REQUIRED'],
 ] as const)('%s %s call %s reports the correct authentication purpose',async(action,path,occurrence,error)=>{
   const p=await protocol(action,{response:(candidate,count)=>candidate===path&&count===occurrence?"<script>alert('로그인 후 사용이 가능합니다.');</script>":undefined});
   await expect(p.run()).rejects.toThrow(error);
   expect(p.applications).not.toHaveBeenCalled();
   expect(p.calls.some(c=>c.path.endsWith('_ok.php'))).toBe(false);
 });
 it.each(['CREATE','UPDATE'] as const)('%s never treats an empty time check as permission',async action=>{
   const p=await protocol(action,{response:path=>path==='cal_data.php'?'':undefined});
   await expect(p.run()).rejects.toThrow('REG_TIME_CHECK_EMPTY');
   expect(p.applications).not.toHaveBeenCalled();
   expect(p.calls.some(c=>c.path.endsWith('_ok.php'))).toBe(false);
 });
 it('a login failure stops before form, lookup or write requests',async()=>{
   const p=await protocol('CREATE');p.auth.mockRejectedValue(Error('SESSION_EXPIRED'));
   await expect(p.run()).rejects.toThrow('SESSION_EXPIRED');expect(p.calls).toHaveLength(0);
 });
 const advisoryResponse=(path:string)=>path==='get_check_cd_partner.php'?knownPartnerHelper:path==='cal_data.php'?'':undefined;
 it.each(['CREATE','UPDATE'] as const)('%s labels only the known helper failures as advisories under explicit operator policy',async action=>{
   const p=await protocol(action,{eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,response:advisoryResponse}),prepared=await p.run();
   expect(prepared.eligibilityWarnings).toEqual([
     ...(action==='UPDATE'?[{code:'REG_PARTNER_CHECK_ADVISORY',purpose:'shipcompany',endpoint:'get_check_cd_partner.php',partnerCode:'1002',policy:OFFICIAL_UI_ADVISORY_POLICY}]:[]),
     {code:'REG_PARTNER_CHECK_ADVISORY',purpose:'billing',endpoint:'get_check_cd_partner.php',partnerCode:'1002',policy:OFFICIAL_UI_ADVISORY_POLICY},
     {code:'REG_TIME_CHECK_ADVISORY',purpose:'time',endpoint:'cal_data.php',policy:OFFICIAL_UI_ADVISORY_POLICY},
   ]);
   expect(p.auth).toHaveBeenCalledOnce();expect(p.applications).toHaveBeenCalledOnce();
   expect(prepared.fields.cd_partner_chg).toBe('1002');expect(prepared).not.toHaveProperty('status');
   expect(p.calls.some(c=>c.path.endsWith('_ok.php'))).toBe(false);
 });
 it.each([undefined,'strict'] as const)('strict/default policy %s never permits the exact known helper response',async eligibilityPolicy=>{
   const p=await protocol('CREATE',{eligibilityPolicy,response:advisoryResponse});
   await expect(p.run()).rejects.toThrow('REG_BILLING_AUTH_REQUIRED');expect(p.applications).not.toHaveBeenCalled();
 });
 it.each([
   knownPartnerHelper+'\n',
   knownPartnerHelper.replace('language=', 'Language='),
   "<script>alert('로그인 후 사용이 가능합니다.');</script>",
   '<form name="login_frm"></form>',
   '<div>cf-chl-challenge</div>',
 ])('rejects another or altered login/challenge response under advisory policy',async response=>{
   const p=await protocol('CREATE',{eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,response:path=>path==='get_check_cd_partner.php'?response:undefined});
   await expect(p.run()).rejects.toThrow('REG_BILLING_AUTH_REQUIRED');expect(p.applications).not.toHaveBeenCalled();
 });
 it('does not authorize another company, another endpoint or extra parameters with the pinned response',async()=>{
   const client=new PilotRegistrationClient({...sourceConfig,eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY},vi.fn(async()=>new Response(knownPartnerHelper)));
   await expect(client.check('get_check_cd_partner.php',{cd_partner:'2106'},'billing')).rejects.toThrow('REG_BILLING_AUTH_REQUIRED');
   await expect(client.check('get_check_cd_partner.php',{cd_partner:'1002',extra:'1'},'billing')).rejects.toThrow('REG_BILLING_AUTH_REQUIRED');
   await expect(client.check('get_check_misu_test.php',{cd_partner:'1002'},'shipcompany')).rejects.toThrow('REG_COMPANY_AUTH_REQUIRED');
 });
 it.each(['<html>unexpected response</html>','OK','error'])('unknown helper response remains fatal: %s',async response=>{
   const p=await protocol('CREATE',{eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,response:path=>path==='get_check_cd_partner.php'?response:undefined});
   await expect(p.run()).rejects.toThrow('REG_ELIGIBILITY_RESPONSE');
 });
 it.each([' ','\r\n','\t'])('only a zero-length time response is advisory, not whitespace %j',async response=>{
   const p=await protocol('CREATE',{eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,response:path=>path==='cal_data.php'?response:undefined});
   await expect(p.run()).rejects.toThrow('REG_TIME_CHECK_EMPTY');
 });
 it.each([204,302,500])('helper HTTP%s is not converted into an advisory',async status=>{
   const p=await protocol('CREATE',{eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,response:path=>path==='cal_data.php'?new Response(null,{status}):undefined});
   await expect(p.run()).rejects.toThrow('REG_READ_HTTP');
 });
 it('helper timeout is fatal and performs no submit',async()=>{
   const p=await protocol('CREATE',{eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,response:path=>{if(path==='cal_data.php')throw Error('SOURCE_TIMEOUT');return undefined;}});
   await expect(p.run()).rejects.toThrow('SOURCE_TIMEOUT');expect(p.calls.some(c=>c.path.endsWith('_ok.php'))).toBe(false);
 });
 it.each([
   ['get_check_callsign.php','T','REG_VESSEL_BLOCKED'],
   ['get_check_callsign.php','Y','REG_VESSEL_BLOCKED'],
   ['get_check_misu_test.php','Y','REG_COMPANY_BLOCKED'],
   ['get_check_cd_partner.php','Y','REG_BILLING_BLOCKED'],
   ['cal_data.php','N','REG_SITE_TIME_BLOCKED'],
 ] as const)('explicit denial %s=%s always blocks advisory policy',async(path,response,error)=>{
   const p=await protocol('CREATE',{eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,response:candidate=>candidate===path?response:undefined});
   await expect(p.run()).rejects.toThrow(error);expect(p.applications).not.toHaveBeenCalled();
 });
 it('advisories never replace final authenticated list, duplication or time validation',async()=>{
   const expired=await protocol('CREATE',{eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,response:advisoryResponse});
   expired.applications.mockRejectedValue(Error('SESSION_EXPIRED'));await expect(expired.run()).rejects.toThrow('SESSION_EXPIRED');
   const duplicate=await protocol('CREATE',{eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,response:advisoryResponse,baseline:[row]});
   await expect(duplicate.run()).rejects.toThrow('REG_DUPLICATE');
   const past=await protocol('CREATE',{eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,response:advisoryResponse});
   past.draftFields.dt_ship='20000101';await expect(past.run()).rejects.toThrow('REG_PAST_OR_INVALID_TIME');
   const disabled=new PilotRegistrationClient({...sourceConfig,eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,createEnabled:false},vi.fn());
   const allowed=await protocol('CREATE',{eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,response:advisoryResponse});
   await expect(disabled.submit(await allowed.run(),{requestId:crypto.randomUUID(),status:'SUBMITTING'})).rejects.toThrow('REG_FEATURE_DISABLED');
 });
});
describe('encrypted, revision-bound wizard',()=>{
 it('allows a23-character remark without invented20-character rejection',()=>{
   const d=draft();d.step='nm_text';applyPilotText(d,'가'.repeat(23));
   expect(d.fields.nm_text).toBe('가'.repeat(23));expect(d.step).toBe('review');
 });
 it('wizard respects the fresh form remark limit and marks a shortened preview without changing data',()=>{
   const d=draft();d.step='nm_text';d.form.remarkMaxLength=25;
   expect(()=>applyPilotText(d,'가'.repeat(26))).toThrow('REG_REMARK_LIMIT');
   expect(d.fields.nm_text).toBe('');
   delete d.form.remarkMaxLength;applyPilotText(d,'가'.repeat(1200));
   expect(d.fields.nm_text).toHaveLength(1200);expect(pilotSummary(d)).toContain('가'.repeat(500));
   expect(pilotSummary(d)).toContain('미리보기 생략, 전체 값은 인앱에서 확인');expect(d.fields.nm_text).toHaveLength(1200);
   const tooLong=draft();tooLong.step='nm_text';expect(()=>applyPilotText(tooLong,'가'.repeat(1201))).toThrow('REG_INPUT');
 });
 it.each([['0615','06','15'],['06:15','06','15'],['0000','00','00'],['2359','23','59']])('normalizes time %s without changing its meaning',(input,h,m)=>{const d=draft();d.step='time';applyPilotText(d,input);expect(d.fields).toMatchObject({tm_ship_h:h,tm_ship_i:m});});
 it.each(['2460','2400','2360','615','06:1','6:15','06150','6pm'])('rejects invalid/ambiguous time %s',input=>{const d=draft();d.step='time';expect(()=>applyPilotText(d,input)).toThrow('REG_TIME_FORMAT');});
 it('bounds saved ciphertext within the reserved round-trip budget',async()=>{await expect(pilotSeal({text:'x'.repeat(30000)},'ab'.repeat(32),crypto.randomUUID())).rejects.toThrow('REG_DRAFT_TOO_LARGE_NARROW_SEARCH');});
 it('all create questions end at explicit review, with no external request',()=>{
   const d=draft();d.step='vessel';const id=crypto.randomUUID();
   const text:Record<string,string>={dt_ship:'2099-01-01',time:'06:15',num_draft:'6.20',num_length:'160',etryptyear:'2099',etryptco:'1',cd_emp_partner:'Tester',no_hpemp_partner:'010-0000-0000',e_mail:'없음',nm_text:'없음'};
   const options:Record<string,string>={fg_inoutport:'010',tp_vessel:'N',tp_cargo:'B',tugboat_1:'',tugboat_a:'0',tugboat_2:'',tugboat_b:'0',fg_side:'010',num_bt_yn:'N',tp_q:'N',final_confirm_1:'N',cd_cargo:'4',fg_tax:'020',yn_dispilot:''};
   for(const step of PILOT_STEPS){expect(d.step).toBe(step);const question=renderPilotDraft(d,id,1);expect(question.text).not.toContain('등록 완료');
     if(step in text)applyPilotText(d,text[step]);
     else if(step==='from'||step==='to')applyPilotChoice(d,{label:step,values:step==='from'?{nm_point:'P/S',cd_pointrep:'21',cd_pointend:'21002'}:{nm_point:'OTK(S)',cd_pointrep:'22',cd_pointend:'22244'}});
     else if(step==='vessel')applyPilotChoice(d,{label:'TEST VESSEL / TEST1',values:{nm_callsign:'TEST VESSEL',cd_callsign:'TEST1'}});
     else if(['shipcompany','billing','mooring'].includes(step))applyPilotChoice(d,pilotStepChoices(d)[0]);
     else applyPilotChoice(d,{label:options[step],values:{[step]:options[step]}});
   }
   expect(d.step).toBe('review');expect(renderPilotDraft(d,id,31).markup.inline_keyboard[0][0].text).toBe('✅ 등록확정');expect(d.prepared).toBeUndefined();
 });
 it('encrypts contacts and authenticates request ID',async()=>{const key='ab'.repeat(32),id=crypto.randomUUID(),s=await pilotSeal(draft(),key,id);expect(s).not.toContain('PRIVATE');expect(await pilotOpen(s,key,id)).toEqual(draft());await expect(pilotOpen(s,key,crypto.randomUUID())).rejects.toThrow();});
 it('callback fits Telegram and has no payload',()=>{const id=crypto.randomUUID(),cb=pilotCallback(id,345,'pick',99);expect(cb.length).toBeLessThanOrEqual(64);expect(parsePilotCallback(cb)).toEqual({id,revision:345,action:'pick',index:99});expect(parsePilotCallback(cb+':evil')).toBeNull();});
 it('time edit returns to explicit review, not submission',()=>{const d=draft();d.step='time';d.returnToReview=true;applyPilotText(d,'06:15');expect(d.step).toBe('review');expect(d.fields.tm_ship_h).toBe('06');expect(renderPilotDraft(d,crypto.randomUUID(),2).text).toContain('명시적 확정');});
 it('preserves exact location pair and never copies billing contact',()=>{const d=draft();d.step='from';applyPilotChoice(d,{label:'OTK(S)',values:{nm_point:'OTK(S)',cd_pointrep:'22',cd_pointend:'22244'}});expect(d.fields.cd_pointend_f).toBe('22244');d.step='billing';applyPilotChoice(d,{label:'협운해운',values:{cd_partner_chg:'1002',ln_partner_chg:'협운해운'}});expect(d.fields.cd_emp_partner).toBe('PRIVATE_PERSON');});
 it('masks contact in review while showing mooring',()=>{const s=pilotSummary(draft());expect(s).toContain('강취: 진산');expect(s).not.toContain('PRIVATE_PERSON');expect(s).not.toContain('010-1234-5678');});
 it('does not invent cargo/side choices and requires valid HH:mm',()=>{const d=draft();d.step='fg_inoutport';expect(pilotStepChoices(d)).toHaveLength(1);d.step='time';expect(()=>applyPilotText(d,'24:00')).toThrow();});
});
const base={url:'https://test.supabase.co',serviceKey:'service',watcherKey:'w'.repeat(40),operatorKey:'o'.repeat(40),botToken:'test',chatId:'-1',adminChats:['-1'],registration:{...sourceConfig,sessionKey:'ab'.repeat(32)}};
describe('worker recovery and authorization',()=>{
 it.each(['login','submit','verify','receipt','success'] as const)('worker %s outcome never lies about success or resubmits',async failure=>{
   const id=crypto.randomUUID(),finishes:any[]=[];
   const fetcher=(async(url:any,init:any)=>{const name=String(url).split('/').at(-1);
     if(name==='pilot_reg_claim')return Response.json({id,token:'token',action:'CREATE',chat:'-1',user:123,recovery:false,sealed_data:await pilotSeal(draft(),base.registration.sessionKey,id)});
     if(name==='pilot_reg_context')return Response.json({});
     if(name==='getChatMember')return Response.json({ok:true,result:{status:'member'}});
     if(name==='pilot_reg_submitting'||name==='pilot_reg_verifying')return Response.json(true);
     if(name==='pilot_reg_finish'){const body=JSON.parse(init.body);finishes.push(body);if(failure==='receipt'&&body.p_status==='SUCCESS')throw Error('DB_TIMEOUT');return Response.json(true);}
     if(name==='pilot_claim_notification')return Response.json(null);throw Error('UNEXPECTED');}) as typeof fetch;
   const prepare=vi.spyOn(PilotRegistrationClient.prototype,'prepare');if(failure==='login')prepare.mockRejectedValue(Error('REG_SESSION_EXPIRED'));else prepare.mockResolvedValue({form,fields,baseline:[],warnings:[],businessHash:'h'});
   const submit=vi.spyOn(PilotRegistrationClient.prototype,'submit');if(failure==='submit')submit.mockRejectedValue(Error('TIMEOUT'));else submit.mockResolvedValue();
   const verify=vi.spyOn(PilotRegistrationClient.prototype,'verify');if(failure==='verify')verify.mockRejectedValue(Error('REG_VERIFICATION_REQUIRED'));else verify.mockResolvedValue(row);
   await createRegistrationHandler(base,fetcher)(new Request('https://test',{method:'POST',headers:{'x-watcher-key':base.watcherKey},body:JSON.stringify({request_id:id})}));
   expect(submit).toHaveBeenCalledTimes(failure==='login'?0:1);
   expect(finishes.at(-1).p_status).toBe(failure==='success'?'SUCCESS':failure==='login'?'FAILED':'UNKNOWN');
   if(failure==='submit'||failure==='verify')expect(finishes.some(f=>f.p_status==='SUCCESS')).toBe(false);
 });
 it('rejects arbitrary caller payload before DB',async()=>{const fetcher=vi.fn();const h=createRegistrationHandler(base,fetcher);expect((await h(new Request('https://test',{method:'POST',headers:{'x-watcher-key':base.watcherKey},body:JSON.stringify({request_id:crypto.randomUUID(),fields})}))).status).toBe(400);expect(fetcher).not.toHaveBeenCalled();});
 it('recovery reads only, even when flags enabled',async()=>{
   const id=crypto.randomUUID(),d=draft();d.prepared={fields,baselineIds:[]};const calls:any[]=[];
   const fetcher=(async(url:any,init:any)=>{const name=String(url).split('/').at(-1);calls.push(name);
     if(name==='pilot_reg_claim')return Response.json({id,token:'token',action:'CREATE',chat:'-1',user:123,recovery:true,sealed_data:await pilotSeal(d,base.registration.sessionKey,id)});
     if(name==='pilot_reg_context')return Response.json({});if(name==='pilot_reg_finish')return Response.json(true);if(name==='pilot_claim_notification')return Response.json(null);throw Error('UNEXPECTED');}) as typeof fetch;
   const submit=vi.spyOn(PilotRegistrationClient.prototype,'submit');vi.spyOn(PilotRegistrationClient.prototype,'authenticate').mockResolvedValue();vi.spyOn(PilotRegistrationClient.prototype,'verify').mockResolvedValue(row);
   await createRegistrationHandler(base,fetcher)(new Request('https://test',{method:'POST',headers:{'x-watcher-key':base.watcherKey},body:JSON.stringify({request_id:id})}));
   expect(submit).not.toHaveBeenCalled();expect(calls).not.toContain('pilot_reg_submitting');expect(calls).toContain('pilot_reg_finish');
 });
 it('departed participant cannot register, general conversation is ignored',async()=>{
   const calls:any[]=[];const fetcher=(async(url:any,init:any)=>{const name=String(url).split('/').at(-1);calls.push(name);
     if(name==='hpbot_accept_update')return Response.json(true);if(name==='getChatMember')return Response.json({ok:true,result:{status:'left'}});if(name==='pilot_claim_notification')return Response.json(null);return new Response(null,{status:204});}) as typeof fetch;
   const config={...base,webhookSecret:'s'.repeat(40),botUsername:'test_bot',gatewayJwt:'gateway'};
   const h=createWebhook(config,fetcher);const send=(text:string)=>h(new Request('https://test',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':config.webhookSecret},body:JSON.stringify({update_id:1,message:{message_id:1,text,chat:{id:-1},from:{id:123}}})}));
   await send('오늘 점심 먹자');expect(calls).toHaveLength(0);await send('/도선등록');expect(calls).toContain('pilot_reg_reply');expect(calls).not.toContain('pilot_reg_start');
 });
});
