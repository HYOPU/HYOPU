// @vitest-environment node
import { createHmac } from 'node:crypto';
import { describe,it,expect,vi,afterEach } from 'vitest';
import { verifyMiniApp } from '../supabase/functions/pilot-miniapp/lib/auth';
import { createMiniApp,miniView,applyMiniFields,miniFormFields } from '../supabase/functions/pilot-miniapp/lib/runtime';
import { pilotSeal,pilotOpen } from '../supabase/functions/_shared/pilot-registration/crypto';
import { PilotRegistrationClient } from '../supabase/functions/_shared/pilot-registration/client';
import { handleRegistrationUpdate } from '../supabase/functions/telegram-webhook/lib/registration';
import { pilotSummary } from '../supabase/functions/_shared/pilot-registration/wizard';
const token='test:token',key='ab'.repeat(32),origin='https://mini.example.test',chat='-1';
function sign(user:any={id:123},age=0,extra:Record<string,string>={}){
 const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)+age),user:JSON.stringify(user),...extra});
 const data=[...p].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>`${k}=${v}`).join('\n');
 const secret=createHmac('sha256','WebAppData').update(token).digest();p.set('hash',createHmac('sha256',secret).update(data).digest('hex'));return p.toString();
}
const config={url:'https://db.test',serviceKey:'service',watcherKey:'x'.repeat(64),operatorKey:'y'.repeat(64),botToken:token,chatId:chat,origin,adminChats:[chat],registration:{username:'test',password:'test',transport:'http-approved' as const,sessionKey:key,createEnabled:false,updateEnabled:false}};
const draft=()=>({action:'CREATE' as const,dryRun:false,step:'review',fields:{nm_callsign:'TEST VESSEL',cd_callsign:'TEST1',num_draft:'6.20',seq_log:'NEVER_EXPOSE',xxr:'NEVER_EXPOSE',cd_emp_partner:'PRIVATE_PERSON',no_hpemp_partner:'010-1234-5678'},form:{action:'CREATE' as const,fields:{seq_log:'NEVER_EXPOSE'},options:{},hidden:['seq_log']}});
const request=(op:string,args:any={})=>new Request(origin+'/api',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({initData:sign(),op,...args})});
function backend(record:any={},role='administrator'){
 const calls:any[]=[];const fetcher=vi.fn(async(input:any,init:any)=>{
  const url=String(input),args=JSON.parse(init.body);calls.push({url,args});
  if(url.endsWith('getChatMember'))return Response.json({ok:true,result:{status:role}});
  const name=url.split('/').at(-1);
  if(name==='pilot_mini_open')return Response.json(record);
  if(name==='pilot_budget_settle')return Response.json(true);
  if(name==='pilot_mini_save')return Response.json((args.p_revision??0)+1);
  if(name==='pilot_mini_decide')return Response.json(args.p_action==='CANCEL'?'CANCELLED':'CONFIRMED');
  if(name==='pilot_reg_context')return Response.json({});
  throw Error('UNEXPECTED_EXTERNAL_CALL');
 });return {fetcher,calls};
}
afterEach(()=>vi.restoreAllMocks());
describe('Telegram signed Mini App identity',()=>{
 it('accepts the Telegram HMAC including signed optional fields',async()=>{expect(await verifyMiniApp(sign({id:123},0,{signature:'signed-extra',start_param:'pilot',chat_instance:'not-a-chat-id'}),token)).toBe(123);});
 it.each([-1201,60])('rejects auth date %s',async age=>{await expect(verifyMiniApp(sign({id:123},age),token)).rejects.toThrow();});
 it('rejects tampering, missing/duplicate fields, bots and invalid ids',async()=>{
  for(const raw of [sign().replace('123','456'),sign()+'&user={}',sign({id:-1}),sign({id:123,is_bot:true}),sign({id:'123'}),''])await expect(verifyMiniApp(raw,token)).rejects.toThrow();
 });
});
describe('Mini App API without chat spam',()=>{
 it('settles a measured load with request/response margin, not the full 128 KiB',async()=>{
  const id=crypto.randomUUID(),b=backend({budget_id:id,reserved_bytes:131072});
  expect((await createMiniApp(config,b.fetcher)(request('load'))).status).toBe(200);
  const settled=b.calls.at(-1);expect(settled.url).toContain('pilot_budget_settle');expect(settled.args.p_id).toBe(id);
  expect(settled.args.p_bytes).toBeGreaterThan(4096);expect(settled.args.p_bytes).toBeLessThan(8192);
 });
 it('uncertain member transport retains the reservation without a refund',async()=>{
  const b=backend({budget_id:crypto.randomUUID(),reserved_bytes:131072});
  const network=async(input:any,init:any)=>{if(String(input).endsWith('getChatMember'))throw Error('TIMEOUT');return b.fetcher(input,init);};
  await createMiniApp(config,network)(request('load'));expect(b.calls.some(c=>c.url.includes('pilot_budget_settle'))).toBe(false);
 });
 it('returns original and current editable UPDATE values only to authenticated owner view',()=>{const d:any=draft();d.action='UPDATE';d.original={...d.fields};d.fields={...d.fields,num_draft:'10.00'};const v=miniView({id:'id',status:'DRAFT'},d,false);expect(v.formFields?.find(f=>f.key==='cd_emp_partner')?.value).toBe('PRIVATE_PERSON');expect(v.originalFields?.find(f=>f.key==='num_draft')?.value).toBe('6.20');expect(v.formFields?.find(f=>f.key==='num_draft')?.value).toBe('10.00');expect(JSON.stringify(v)).not.toContain('NEVER_EXPOSE');expect(v.formFields?.find(f=>f.key==='vessel')?.readonly).toBe(true);});
 it('exports all 30 business fields including visible contacts without opaque data',()=>{const fields=miniFormFields(draft());expect(fields).toHaveLength(30);expect(fields.find(f=>f.key==='cd_emp_partner')).toMatchObject({value:'PRIVATE_PERSON',saved:false});expect(fields.find(f=>f.key==='vessel')?.value).toContain('TEST1');expect(JSON.stringify(fields)).not.toContain('NEVER_EXPOSE');});
 it('batch validates text and choices without changing hidden fields',()=>{const d=draft();d.form.options={fg_side:[{value:'S',label:'S'},{value:'P',label:'P'}]} as any;applyMiniFields(d,{time:'14:30',num_draft:'9.20',fg_side:1,nm_text:''});expect(d.fields).toMatchObject({tm_ship_h:'14',tm_ship_i:'30',fg_side:'P',num_draft:'9.20',nm_text:'',seq_log:'NEVER_EXPOSE'});expect(d.step).toBe('edit');});
 it.each([{seq_log:'forged'},{from:'guessed'},{vessel:'forged'},{time:'99:99'},{num_draft:'abc'},{fg_side:99}])('rejects unsafe batch %j',values=>{expect(()=>applyMiniFields(draft(),values)).toThrow();});
 it('saves one batch atomically without external writes',async()=>{const id=crypto.randomUUID(),b=backend({id,revision:1,status:'DRAFT',sealed_data:await pilotSeal(draft(),key,id)});const r=await createMiniApp(config,b.fetcher)(request('save',{id,revision:1,values:{time:'08:20',num_draft:'10.20'},review:true}));expect(r.status).toBe(200);expect((await r.json()).step).toBe('review');expect(b.calls.map(c=>c.url.split('/').at(-1))).toEqual(['pilot_mini_open','getChatMember','pilot_mini_save']);});
 it('opt-in registration entry sends just an app link, not a chat Wizard',async()=>{
  const calls:any[]=[];const fetcher=vi.fn(async(input:any,init:any)=>{const name=String(input).split('/').at(-1);calls.push({name,args:JSON.parse(init.body)});return Response.json(name==='hpbot_accept_update'?true:null);});
  await handleRegistrationUpdate({...config,botUsername:'hpbot_ulsan_pilot_20260920_bot',gatewayJwt:'jwt',miniAppEnabled:true},{update_id:12,message:{chat:{id:-1},from:{id:123},message_id:1,text:'➕ 도선등록'}},fetcher,async()=>true,async()=>{});
  const reply=calls.find(c=>c.name==='pilot_reg_reply');expect(reply.args.p_markup.inline_keyboard[0][0].url).toBe('https://t.me/hpbot_ulsan_pilot_20260920_bot?startapp=pilot&mode=compact');expect(calls.some(c=>c.name==='pilot_reg_start')).toBe(false);
 });
 it('rejects unsigned or foreign-origin calls before any DB/network call',async()=>{const b=backend(),h=createMiniApp(config,b.fetcher);expect((await h(new Request(origin,{method:'POST',headers:{origin},body:'{}'}))).status).toBe(401);expect((await h(new Request('https://evil.test',{method:'POST',headers:{origin:'https://evil.test'}}))).status).toBe(403);expect(b.calls).toEqual([]);});
 it('budget stop happens before member or source requests',async()=>{const b=backend({error:'MINI_BUDGET'});expect((await createMiniApp(config,b.fetcher)(request('load'))).status).toBe(429);expect(b.calls).toHaveLength(1);});
 it('allows ordinary room participants to open the application',async()=>{const b=backend({},'member');expect((await createMiniApp(config,b.fetcher)(request('load'))).status).toBe(200);expect(b.calls).toHaveLength(2);});
 it.each(['left','kicked','restricted'])('rejects nonparticipants %s',async role=>{const b=backend({},role);expect((await createMiniApp(config,b.fetcher)(request('load'))).status).toBe(403);expect(b.calls).toHaveLength(2);});
 it('never uses client chat_id or chat_instance as the destination',async()=>{const b=backend();await createMiniApp(config,b.fetcher)(request('load',{chat_id:'-999',user_id:999}));expect(b.calls[0].args).toMatchObject({p_chat:chat,p_user:123});expect(b.calls[1].args).toEqual({chat_id:chat,user_id:123});});
 it('shows full Mini App contact values but never opaque form or lookup payloads',()=>{const d=draft();d.step='vessel';(d as any).choices=[{label:'TEST',values:{secret:'NEVER_EXPOSE'}}];const text=JSON.stringify(miniView({id:'id',status:'DRAFT'},d,false));expect(text).not.toContain('NEVER_EXPOSE');expect(text).toContain('PRIVATE_PERSON');expect(text).toContain('010-1234-5678');expect(text).not.toContain('hidden');});
 it.each(['CREATE','UPDATE','COPY'])('shows original/current contacts and full review in %s while chat remains masked',mode=>{
  const d:any=draft();d.fields.e_mail='private@example.test';d.original={...d.fields};d.action=mode==='UPDATE'?'UPDATE':'CREATE';if(mode==='COPY')d.mode='COPY';
  const v=miniView({id:'id',status:'DRAFT'},d,false);
  for(const k of ['cd_emp_partner','no_hpemp_partner','e_mail']){expect(v.formFields?.find(f=>f.key===k)?.value).toBe(d.fields[k]);expect(v.originalFields?.find(f=>f.key===k)?.value).toBe(d.original[k]);expect(v.summary).toContain(d.fields[k]);expect(pilotSummary(d)).not.toContain(d.fields[k]);}
 });
 it('returns full values only after signed identity and room membership validation',async()=>{
  const id=crypto.randomUUID(),record={id,revision:1,status:'DRAFT',sealed_data:await pilotSeal(draft(),key,id)};
  const accepted=backend(record,'member'),r=await createMiniApp(config,accepted.fetcher)(request('load',{id}));expect((await r.json()).formFields.find((f:any)=>f.key==='no_hpemp_partner').value).toBe('010-1234-5678');expect(r.headers.get('cache-control')).toBe('no-store');
  const denied=backend(record,'left'),forbidden=await createMiniApp(config,denied.fetcher)(request('load',{id}));expect(forbidden.status).toBe(403);expect(await forbidden.text()).not.toContain('010-1234-5678');
 });
 it('saved selection sends no Telegram message or source write',async()=>{const id=crypto.randomUUID(),d=draft();d.step='num_draft';const b=backend({id,revision:1,status:'DRAFT',sealed_data:await pilotSeal(d,key,id)});const response=await createMiniApp(config,b.fetcher)(request('text',{id,revision:1,text:'9.20'}));expect(response.status).toBe(200);expect((await response.json()).step).toBe('tp_vessel');expect(b.calls.map(c=>c.url.split('/').at(-1))).toEqual(['pilot_mini_open','getChatMember','pilot_mini_save']);});
 it('rejects stale revision before save',async()=>{const id=crypto.randomUUID(),b=backend({id,revision:2,status:'DRAFT',sealed_data:await pilotSeal(draft(),key,id)});expect((await createMiniApp(config,b.fetcher)(request('confirm',{id,revision:1}))).status).toBe(409);expect(b.calls).toHaveLength(2);});
 it('disabled flag blocks approval and never dispatches submit',async()=>{const id=crypto.randomUUID(),b=backend({id,revision:1,status:'DRAFT',sealed_data:await pilotSeal(draft(),key,id)});const r=await createMiniApp(config,b.fetcher)(request('confirm',{id,revision:1}));expect((await r.json()).error).toBe('REG_FEATURE_DISABLED');expect(b.calls).toHaveLength(2);});
 it('confirmation only approves the stored request, no payload or direct submit',async()=>{const id=crypto.randomUUID(),b=backend({id,revision:1,status:'DRAFT',sealed_data:await pilotSeal(draft(),key,id)});const r=await createMiniApp({...config,registration:{...config.registration,createEnabled:true}},b.fetcher)(request('confirm',{id,revision:1,payload:{num_draft:'INJECTED'}}));expect((await r.json()).status).toBe('CONFIRMED');expect(b.calls.at(-1).args).toEqual({p_chat:chat,p_user:123,p_id:id,p_revision:1,p_action:'CONFIRM'});});
 it.each(['CONFIRMED','SUBMITTING','VERIFYING','UNKNOWN','SUCCESS'])('cannot resubmit %s',async status=>{const id=crypto.randomUUID(),b=backend({id,revision:1,status,sealed_data:await pilotSeal(draft(),key,id)});expect((await createMiniApp(config,b.fetcher)(request('confirm',{id,revision:1}))).status).toBe(409);expect(b.calls).toHaveLength(2);});
 it('Dry Run calls prepare only and sends no chat message',async()=>{const id=crypto.randomUUID(),b=backend({id,revision:1,status:'DRAFT',sealed_data:await pilotSeal(draft(),key,id)});
  vi.spyOn(PilotRegistrationClient.prototype,'authenticate').mockResolvedValue(undefined);
  vi.spyOn(PilotRegistrationClient.prototype,'prepare').mockResolvedValue({warnings:[]} as any);
  const submit=vi.spyOn(PilotRegistrationClient.prototype,'submit');
  const r=await createMiniApp(config,b.fetcher)(request('dry',{id,revision:1}));expect(r.status).toBe(200);expect(submit).not.toHaveBeenCalled();expect(b.calls.some(c=>c.url.includes('sendMessage'))).toBe(false);
 });
 it('advisory Dry Run distinguishes unavailable helper checks and never approves',async()=>{
  const id=crypto.randomUUID(),b=backend({id,revision:1,status:'DRAFT',sealed_data:await pilotSeal(draft(),key,id)});
  vi.spyOn(PilotRegistrationClient.prototype,'authenticate').mockResolvedValue(undefined);
  vi.spyOn(PilotRegistrationClient.prototype,'prepare').mockResolvedValue({warnings:[],eligibilityWarnings:[{code:'REG_PARTNER_CHECK_ADVISORY',purpose:'billing',endpoint:'get_check_cd_partner.php',policy:'official-ui-advisory-v1',partnerCode:'1002'},{code:'REG_TIME_CHECK_ADVISORY',purpose:'time',endpoint:'cal_data.php',policy:'official-ui-advisory-v1'}]} as any);
  const r=await createMiniApp({...config,registration:{...config.registration,eligibilityPolicy:'official-ui-advisory-v1'}},b.fetcher)(request('dry',{id,revision:1}));
  const data=await r.json();expect(data.eligibilityWarnings).toHaveLength(2);expect(data.notice).toContain('연체 여부는 확인되지 않았습니다');expect(data.notice).not.toContain('보조검사 정상');
  expect(b.calls.some(c=>/pilot_mini_decide|pilot_mini_save|sendMessage/.test(c.url))).toBe(false);
 });
 it('requires explicit policy acknowledgement then seals it before atomic approval',async()=>{
  const id=crypto.randomUUID(),record={id,revision:1,status:'DRAFT',sealed_data:await pilotSeal(draft(),key,id)};
  const cfg={...config,registration:{...config.registration,createEnabled:true,eligibilityPolicy:'official-ui-advisory-v1' as const}};
  const no=backend(record);expect((await (await createMiniApp(cfg,no.fetcher)(request('confirm',{id,revision:1}))).json()).error).toBe('REG_POLICY_REVIEW_REQUIRED');
  expect(no.calls.some(c=>/pilot_mini_decide|pilot_mini_save/.test(c.url))).toBe(false);
  const yes=backend(record);expect((await (await createMiniApp(cfg,yes.fetcher)(request('confirm',{id,revision:1,eligibilityPolicy:'official-ui-advisory-v1'}))).json()).status).toBe('CONFIRMED');
  const save=yes.calls.find(c=>c.url.endsWith('pilot_mini_save'));expect((await pilotOpen<any>(save.args.p_sealed,key,id)).eligibilityPolicy).toBe('official-ui-advisory-v1');
  expect(yes.calls.at(-1).args.p_revision).toBe(2);
 });
 it.each([['REG_BILLING_AUTH_REQUIRED','청구처가 잘못됐다는 뜻이 아닙니다'],['REG_COMPANY_AUTH_REQUIRED','선사 보조검사'],['REG_TIME_CHECK_EMPTY','시간 보조검사']])('explains %s without losing the draft or approving a write',async(code,message)=>{
  const id=crypto.randomUUID(),b=backend({id,revision:1,status:'DRAFT',sealed_data:await pilotSeal(draft(),key,id)});
  vi.spyOn(PilotRegistrationClient.prototype,'authenticate').mockResolvedValue(undefined);
  vi.spyOn(PilotRegistrationClient.prototype,'prepare').mockRejectedValue(Error(code));
  const submit=vi.spyOn(PilotRegistrationClient.prototype,'submit');
  const response=await createMiniApp(config,b.fetcher)(request('dry',{id,revision:1}));
  expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:code,message:expect.stringContaining(message)});
  expect(submit).not.toHaveBeenCalled();expect(b.calls.some(c=>/pilot_mini_save|pilot_mini_decide|sendMessage/.test(c.url))).toBe(false);
 });
});
