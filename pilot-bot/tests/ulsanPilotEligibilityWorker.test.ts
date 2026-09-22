// @vitest-environment node
// Worker boundary tests: all network/DB/source responses are synthetic.
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createRegistrationHandler} from '../supabase/functions/ulsan-pilot-registration/lib/runtime';
import {PilotRegistrationClient,OFFICIAL_UI_ADVISORY_POLICY} from '../supabase/functions/_shared/pilot-registration/client';
import type {PilotEligibilityWarning,PreparedPilot} from '../supabase/functions/_shared/pilot-registration/client';
import {pilotOpen,pilotSeal} from '../supabase/functions/_shared/pilot-registration/crypto';
import type {PilotDraft} from '../supabase/functions/_shared/pilot-registration/wizard';
import type {PilotAction,PilotFields} from '../supabase/functions/_shared/pilot-registration/contract';

const fields:PilotFields={no_forecast:'123',cd_callsign:'TEST1',nm_callsign:'TEST VESSEL',dt_ship:'20990101',tm_ship_h:'12',tm_ship_i:'00',nm_point_f:'P/S',nm_point_t:'OTK(S)',sn_partner:'진산',num_draft:'6.20',nm_text:'existing remark'};
const row={application_id:'900',vessel_name:'TEST VESSEL',callsign:'TEST1',pilot_date:'2099-01-01',pilot_time:'12:00',from_location:'P/S',to_location:'OTK(S)',application_status:'010',completion_status:'ACTIVE',agent:'협운',association_remark:'',remarks:'existing remark',raw_application_status:'요청',draft:'6.20'};
const warnings:PilotEligibilityWarning[]=[
  {code:'REG_PARTNER_CHECK_ADVISORY',purpose:'billing',endpoint:'get_check_cd_partner.php',policy:OFFICIAL_UI_ADVISORY_POLICY,partnerCode:'1002'},
  {code:'REG_TIME_CHECK_ADVISORY',purpose:'time',endpoint:'cal_data.php',policy:OFFICIAL_UI_ADVISORY_POLICY},
];
const config={url:'https://test.supabase.co',serviceKey:'service',watcherKey:'w'.repeat(40),operatorKey:'o'.repeat(40),botToken:'synthetic-token',chatId:'-1',adminChats:['-1'],registration:{username:'test',password:'test',transport:'http-approved' as const,createEnabled:true,updateEnabled:true,sessionKey:'ab'.repeat(32),eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY}};
const draft=(action:PilotAction,ack=true):PilotDraft=>({action,dryRun:false,step:'review',fields:{...fields},form:{action,fields:{...fields},options:{},hidden:[]},...(ack?{eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY}:{})});

async function harness(d:PilotDraft,recovery=false){
  const id=crypto.randomUUID(),calls:string[]=[],finishes:Record<string,any>[]=[],sealed:string[]=[];
  const fetcher=(async(url:any,init:any)=>{
    const name=String(url).split('/').at(-1)!;calls.push(name);
    if(name==='pilot_reg_claim')return Response.json({id,token:'synthetic-token',action:d.action,chat:'-1',user:123,recovery,sealed_data:await pilotSeal(d,config.registration.sessionKey,id)});
    if(name==='pilot_reg_context')return Response.json({});
    if(name==='getChatMember')return Response.json({ok:true,result:{status:'member'}});
    if(name==='pilot_reg_submitting'){sealed.push(JSON.parse(init.body).p_sealed);return Response.json(true);}
    if(name==='pilot_reg_verifying')return Response.json(true);
    if(name==='pilot_reg_finish'){finishes.push(JSON.parse(init.body));return Response.json(true);}
    if(name==='pilot_claim_notification')return Response.json(null);
    throw Error('TEST_UNEXPECTED_NETWORK_CALL');
  }) as typeof fetch;
  const prepared:PreparedPilot={form:d.form,fields:{...fields},baseline:[{...row,application_id:'prior-id'}],warnings:[],businessHash:'synthetic-hash',eligibilityWarnings:structuredClone(warnings)};
  const prepare=vi.spyOn(PilotRegistrationClient.prototype,'prepare').mockImplementation(async()=>{calls.push('source.prepare');return prepared;});
  const submit=vi.spyOn(PilotRegistrationClient.prototype,'submit').mockImplementation(async()=>{calls.push('source.submit');});
  const authenticate=vi.spyOn(PilotRegistrationClient.prototype,'authenticate').mockImplementation(async()=>{calls.push('source.authenticate');});
  const verify=vi.spyOn(PilotRegistrationClient.prototype,'verify').mockImplementation(async()=>{calls.push('source.verify');return {...row,application_id:d.action==='UPDATE'?'123':'900'};});
  const run=()=>createRegistrationHandler(recovery?{...config,registration:{...config.registration,createEnabled:false,updateEnabled:false}}:config,fetcher)(new Request('https://test',{method:'POST',headers:{'x-watcher-key':config.watcherKey},body:JSON.stringify({request_id:id})}));
  return {id,calls,finishes,sealed,prepared,prepare,submit,authenticate,verify,run};
}
afterEach(()=>vi.restoreAllMocks());

describe('durable registration eligibility-policy acknowledgement',()=>{
  it.each(['CREATE','UPDATE'] as const)('%s without the current policy acknowledgement is rejected before preparation',async action=>{
    const h=await harness(draft(action,false));expect((await h.run()).status).toBe(204);
    expect(h.prepare).not.toHaveBeenCalled();expect(h.submit).not.toHaveBeenCalled();expect(h.verify).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('pilot_reg_submitting');expect(h.sealed).toHaveLength(0);
    expect(h.finishes).toHaveLength(1);expect(h.finishes[0]).toMatchObject({p_status:'FAILED',p_error:'REG_POLICY_REVIEW_REQUIRED'});
  });
  it.each(['CREATE','UPDATE'] as const)('%s seals acknowledgement and structured warnings before its one submission',async action=>{
    const h=await harness(draft(action));expect((await h.run()).status).toBe(204);
    expect(h.prepare).toHaveBeenCalledOnce();expect(h.submit).toHaveBeenCalledOnce();expect(h.verify).toHaveBeenCalledOnce();
    expect(h.sealed).toHaveLength(1);expect(h.sealed[0]).not.toContain('REG_PARTNER_CHECK_ADVISORY');
    const saved=await pilotOpen<PilotDraft>(h.sealed[0],config.registration.sessionKey,h.id);
    expect(saved.eligibilityPolicy).toBe(OFFICIAL_UI_ADVISORY_POLICY);
    expect(saved.prepared).toEqual({fields,baselineIds:['prior-id'],eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,eligibilityWarnings:warnings});
    expect(h.calls.indexOf('pilot_reg_submitting')).toBeLessThan(h.calls.indexOf('source.submit'));
    expect(h.calls.indexOf('source.verify')).toBeLessThan(h.calls.indexOf('pilot_reg_finish'));
    expect(h.calls.filter(x=>x==='getChatMember')).toHaveLength(2);
    expect(h.finishes).toHaveLength(1);expect(h.finishes[0]).toMatchObject({p_status:'SUCCESS'});
    expect(h.finishes[0].p_message).toContain('보조검사 경고 확인 후 제출');
  });
});

describe('read-only recovery preserves original eligibility evidence',()=>{
  it.each(['verified','unverified'] as const)('%s recovery reuses stored warnings and never prepares or resubmits',async outcome=>{
    const d=draft('CREATE',false);d.prepared={fields:{...fields},baselineIds:['prior-id'],eligibilityPolicy:OFFICIAL_UI_ADVISORY_POLICY,eligibilityWarnings:structuredClone(warnings)};
    const h=await harness(d,true);
    if(outcome==='unverified')h.verify.mockRejectedValue(Error('REG_VERIFICATION_REQUIRED'));
    expect((await h.run()).status).toBe(204);
    expect(h.authenticate).toHaveBeenCalledWith('2099-01-01');
    expect(h.verify).toHaveBeenCalledWith('CREATE',fields,['prior-id']);
    expect(h.prepare).not.toHaveBeenCalled();expect(h.submit).not.toHaveBeenCalled();expect(h.sealed).toHaveLength(0);
    expect(h.calls).not.toContain('pilot_reg_submitting');expect(h.calls).not.toContain('pilot_reg_verifying');
    expect(h.finishes).toHaveLength(1);
    if(outcome==='verified'){
      expect(h.finishes[0].p_status).toBe('SUCCESS');expect(h.finishes[0].p_message).toContain('보조검사 경고 확인 후 제출');
    }else{
      expect(h.finishes[0]).toMatchObject({p_status:'UNKNOWN',p_error:'REG_VERIFICATION_REQUIRED'});
      expect(h.finishes[0].p_message).toContain('청구처 보조검사');expect(h.finishes[0].p_message).toContain('시간 보조검사');
      expect(h.finishes[0].p_message).toContain('자동 재제출하지 않음');
    }
  });
});
