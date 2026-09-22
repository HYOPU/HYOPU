// @vitest-environment node
import {describe,it,expect,vi,afterEach} from 'vitest';
import {REG_EDITABLE,REG_VESSEL} from '../supabase/functions/_shared/pilot-registration/contract';
import {copyFields,copyHash,makeCopyDraft,assertCopyDraft,assertRecentCopyCompletion,readCopySource,prepareCopy} from '../supabase/functions/_shared/pilot-registration/copy';
import {pilotSeal} from '../supabase/functions/_shared/pilot-registration/crypto';
import {PilotRegistrationClient} from '../supabase/functions/_shared/pilot-registration/client';
import {createRegistrationHandler} from '../supabase/functions/ulsan-pilot-registration/lib/runtime';
import {applyMiniFields,miniFormFields} from '../supabase/functions/pilot-miniapp/lib/runtime';
// @ts-ignore static frontend utility
import {formatPilotPhone} from '../pilot-miniapp/phone.js';
const key='ab'.repeat(32);
afterEach(()=>vi.restoreAllMocks());
const fields=()=>({...Object.fromEntries([...REG_EDITABLE,...REG_VESSEL].map(k=>[k,''])),cd_partner:'1002',ln_partner:'협운해운',nm_callsign:'SHIP A',cd_callsign:'CALL1',dt_ship:'20990101',tm_ship_h:'06',tm_ship_i:'15',nm_point_f:'P/S',nm_point_t:'OTK(S)',num_draft:'9.20',fg_inoutport:'010',no_hpemp_partner:'010-1234-5678'});
async function draft(){const f=fields();return makeCopyDraft({action:'CREATE',fields:{...f,no_forecast:'',seq_log:'FRESH',xxr:'FRESH',fg_status:'010'},options:{},hidden:[]},{sourceId:crypto.randomUUID(),applicationId:'123',date:'2099-01-01',observedAt:new Date().toISOString(),hash:await copyHash(f),archived:false,fields:f});}
describe('copy business contract',()=>{
 it('copies only business controls and uses fresh new application identity',async()=>{const d=await draft();expect(d.action).toBe('CREATE');expect(d.fields.no_forecast).toBe('');expect(d.fields.seq_log).toBe('FRESH');expect(copyFields({...fields(),xxr:'SECRET',no_forecast:'123'})).not.toHaveProperty('xxr');expect(copyFields({...fields(),no_forecast:'123'})).not.toHaveProperty('no_forecast');expect(()=>copyFields({cd_callsign:'A'})).toThrow('COPY_INCOMPLETE');});
 it.each(['num_draft','fg_inoutport','cd_callsign','no_hpemp_partner','tugboat_1'])('locks %s on server',async k=>{const d=await draft();d.fields[k]='MUTATED';expect(()=>assertCopyDraft(d)).toThrow('COPY_LOCKED_FIELD');});
 it('allows date/time/route only and displays frozen contact without making it editable',async()=>{const d=await draft();applyMiniFields(d,{dt_ship:'2099-01-03',time:'08:00'});d.fields.nm_point_t='JSTT';expect(()=>assertCopyDraft(d)).not.toThrow();expect(()=>applyMiniFields(d,{num_draft:'8.00'})).toThrow('MINI_FIELD');const f=miniFormFields(d);expect(f.filter(x=>!x.readonly).map(x=>x.key).sort()).toEqual(['dt_ship','from','time','to']);expect(f.find(x=>x.key==='no_hpemp_partner')).toMatchObject({value:'010-1234-5678',readonly:true,saved:false});});
 it('does not use archive on failed read or unconfirmed disappearance',async()=>{const s:any={id:crypto.randomUUID(),metadata:{pilot_date:'2099-01-01'},complete:true};await expect(readCopySource({reader:{applications:async()=>{throw Error('SESSION_EXPIRED');}}} as any,s,key)).rejects.toThrow('SESSION_EXPIRED');await expect(readCopySource({reader:{applications:async()=>[]}} as any,s,key)).rejects.toThrow('COPY_SOURCE_UNCONFIRMED');});
 it('verified completed rows can use full encrypted archive, incomplete cannot',async()=>{const d=await draft(),today=new Date(Date.now()+9*3600000).toISOString().slice(0,10),f={...d.copy!.fields,dt_ship:today.replaceAll('-','')},m={callsign:f.cd_callsign,vessel_name:f.nm_callsign,pilot_date:today,pilot_time:'06:15',from_location:f.nm_point_f,to_location:f.nm_point_t,completion_status:'COMPLETED'};const s:any={id:d.copy!.sourceId,metadata:m,application_id:'123',business_hash:await copyHash(f),observed_at:d.copy!.observedAt,complete:true,sealed_data:await pilotSeal({version:1,fields:f},key,'copy:'+d.copy!.sourceId)};const client:any={reader:{applications:async()=>[m]}};expect((await readCopySource(client,s,key)).archived).toBe(true);await expect(readCopySource(client,{...s,complete:false},key)).rejects.toThrow('COPY_INCOMPLETE');});
 it('history limits also reject a forged older source reference',()=>{const now=Date.parse('2026-09-20T10:00:00+09:00');expect(()=>assertRecentCopyCompletion('2026-08-22',30,now)).not.toThrow();expect(()=>assertRecentCopyCompletion('2026-08-21',30,now)).toThrow('COPY_HISTORY_RANGE');expect(()=>assertRecentCopyCompletion('2026-09-21',30,now)).toThrow('COPY_HISTORY_RANGE');});
 it('original changed blocks CREATE preparation',async()=>{const d=await draft(),f={...fields(),num_draft:'10.00'},client:any={reader:{applications:async()=>[{application_id:'123',pilot_date:'2099-01-01',completion_status:'ACTIVE'}]},readOriginal:async()=>({fields:f}),prepare:vi.fn()};await expect(prepareCopy(client,d,{id:d.copy!.sourceId,application_id:'123',metadata:{pilot_date:'2099-01-01'},fingerprint:'f'},key)).rejects.toThrow('COPY_ORIGINAL_CHANGED');expect(client.prepare).not.toHaveBeenCalled();});
});
it.each([['01012345678','010-1234-5678'],['0521234567','052-123-4567'],['0212345678','02-1234-5678'],['021234567','02-123-4567'],['010-1234-5678','010-1234-5678'],['+82 10 1234 5678','+82 10 1234 5678'],['','']])('phone %s formats without defaults', (v,expected)=>expect(formatPilotPhone(v)).toBe(expected));

it.each(['success','timeout','verify','receipt','disabled','recovery'])('copy worker %s uses CREATE only and never retries a POST',async outcome=>{
 const d=await draft(),id=crypto.randomUUID(),f=d.fields,finishes:any[]=[];d.step='review';
 const cfg={url:'https://test.supabase.co',serviceKey:'service',watcherKey:'w'.repeat(40),operatorKey:'o'.repeat(40),botToken:'test',chatId:'-1',adminChats:['-1'],registration:{username:'test',password:'test',transport:'http-approved' as const,createEnabled:true,updateEnabled:true,copyEnabled:outcome!=='disabled',sessionKey:key}};
 if(outcome==='recovery')d.prepared={fields:f,baselineIds:[]};
 const fetcher=(async(url:any,init:any)=>{const name=String(url).split('/').at(-1);
  if(name==='pilot_reg_claim')return Response.json({id,token:'token',chat:'-1',user:123,recovery:outcome==='recovery',sealed_data:await pilotSeal(d,key,id)});
  if(name==='pilot_reg_context')return Response.json({});
  if(name==='getChatMember')return Response.json({ok:true,result:{status:'member'}});
  if(name==='pilot_copy_get')return Response.json({id:d.copy!.sourceId,application_id:'123',metadata:{pilot_date:d.copy!.date},fingerprint:'f'});
  if(['pilot_reg_submitting','pilot_reg_verifying'].includes(name))return Response.json(true);
  if(name==='pilot_reg_finish'){const p=JSON.parse(init.body);finishes.push(p);if(outcome==='receipt'&&p.p_status==='SUCCESS')throw Error('DB_TIMEOUT');return Response.json(true);}
  if(name==='pilot_claim_notification')return Response.json(null);throw Error('UNEXPECTED');
 }) as typeof fetch;
 vi.spyOn(PilotRegistrationClient.prototype,'authenticate').mockImplementation(async function(this:PilotRegistrationClient){vi.spyOn(this.reader,'applications').mockResolvedValue([{application_id:'123',pilot_date:d.copy!.date,completion_status:'ACTIVE'}] as any);});
 vi.spyOn(PilotRegistrationClient.prototype,'readOriginal').mockResolvedValue({...d.form,fields:d.copy!.fields});
 const prepare=vi.spyOn(PilotRegistrationClient.prototype,'prepare').mockResolvedValue({form:d.form,fields:f,baseline:[],warnings:[],businessHash:'hash'});
 const submit=vi.spyOn(PilotRegistrationClient.prototype,'submit');if(outcome==='timeout')submit.mockRejectedValue(Error('TIMEOUT'));else submit.mockResolvedValue();
 const verify=vi.spyOn(PilotRegistrationClient.prototype,'verify');if(outcome==='verify')verify.mockRejectedValue(Error('REG_DETAIL_MISMATCH'));else verify.mockResolvedValue({application_id:'999',vessel_name:f.nm_callsign,callsign:f.cd_callsign,pilot_date:d.copy!.date,pilot_time:'06:15',from_location:f.nm_point_f,to_location:f.nm_point_t} as any);
 await createRegistrationHandler(cfg,fetcher)(new Request('https://test',{method:'POST',headers:{'x-watcher-key':cfg.watcherKey},body:JSON.stringify({request_id:id})}));
 expect(submit).toHaveBeenCalledTimes(['disabled','recovery'].includes(outcome)?0:1);
 if(prepare.mock.calls.length)expect(prepare.mock.calls[0][0]).toBe('CREATE');
 expect(finishes.at(-1).p_status).toBe(['success','recovery'].includes(outcome)?'SUCCESS':outcome==='disabled'?'FAILED':'UNKNOWN');
 if(outcome==='success'){expect(finishes.at(-1).p_message).toContain('복사등록 완료');expect(finishes.at(-1).p_message).toContain('원본:');}
});
