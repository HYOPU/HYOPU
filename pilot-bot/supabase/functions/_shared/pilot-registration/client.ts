import { UlsanReadClient, updateCookies } from '../../ulsan-pilot-watcher/lib/hyopuSource.ts';
import type { ApplicationObservation, SessionCookie, SourceTransport } from '../../ulsan-pilot-watcher/lib/hyopuSource.ts';
import { readBounded, sha256 } from '../../ulsan-pilot-watcher/lib/source.ts';
import { parsePilotForm, parsePilotChoices, pilotBusinessHash, pilotBusinessFields, pilotPayload, validatePilotFields, REG_FORM_PATH, REG_POST_PATH, REG_LOOKUPS, REG_VESSEL } from './contract.ts';
import type { PilotAction, PilotFields, PilotForm, PilotLookup } from './contract.ts';

export const OFFICIAL_UI_ADVISORY_POLICY='official-ui-advisory-v1' as const;
export type PilotEligibilityPolicy='strict'|typeof OFFICIAL_UI_ADVISORY_POLICY;
export interface PilotEligibilityWarning {
  code:'REG_PARTNER_CHECK_ADVISORY'|'REG_TIME_CHECK_ADVISORY';
  purpose:'shipcompany'|'billing'|'time';
  endpoint:'get_check_cd_partner.php'|'cal_data.php';
  policy:typeof OFFICIAL_UI_ADVISORY_POLICY;
  partnerCode?:'1002';
}
type PilotCheckResult='Y'|'N'|'T'|PilotEligibilityWarning;
export interface RegistrationSourceConfig { username:string; password:string; transport:SourceTransport; createEnabled:boolean; updateEnabled:boolean; copyEnabled?:boolean; copyHistoryDays?:number; eligibilityPolicy?:PilotEligibilityPolicy }
export interface PreparedPilot { form:PilotForm; fields:PilotFields; baseline:ApplicationObservation[]; warnings:ApplicationObservation[]; businessHash:string; eligibilityWarnings?:PilotEligibilityWarning[] }
// Exact authenticated helper response observed 2026-09-21: 97 UTF-16 code units,
// 121 UTF-8 bytes. Never accept another login/error page as this advisory.
const KNOWN_PARTNER_RESPONSE_SHA256='99d8f41af1b135f95e4f499dba6b4f536498f79a5e71fbd81f7c1fc6fe18df51';
export const pilotDate = (f:PilotFields) => `${f.dt_ship.slice(0,4)}-${f.dt_ship.slice(4,6)}-${f.dt_ship.slice(6,8)}`;
export const matchesPilot = (row:ApplicationObservation,f:PilotFields) => row.callsign===f.cd_callsign && row.vessel_name.trim().toUpperCase()===f.nm_callsign.trim().toUpperCase()
  && row.pilot_date===pilotDate(f) && row.pilot_time===`${f.tm_ship_h}:${f.tm_ship_i}` && row.from_location===f.nm_point_f && row.to_location===f.nm_point_t;
export class PilotRegistrationClient {
  readonly reader:UlsanReadClient;
  private origin:string;
  private formReferer=REG_FORM_PATH.CREATE;
  private submitted=false;
  private config:RegistrationSourceConfig;
  private fetcher:typeof fetch;
  ingress=0;
  get copyHistoryDays(){return Math.max(1,Math.min(90,this.config.copyHistoryDays??30));}
  constructor(config:RegistrationSourceConfig,fetcher:typeof fetch=fetch,cookies:SessionCookie[]=[]){
    this.config=config;this.fetcher=fetcher;
    if(!['https','http-approved'].includes(config.transport))throw Error('REG_TRANSPORT');
    if(config.eligibilityPolicy!==undefined&&!['strict',OFFICIAL_UI_ADVISORY_POLICY].includes(config.eligibilityPolicy))throw Error('REG_ELIGIBILITY_POLICY');
    this.origin=config.transport==='http-approved'?'http://www.ulsanpilot.co.kr':'https://www.ulsanpilot.co.kr';
    // Reuse established authentication and cookie rules; cap every request at 15s.
    this.reader=new UlsanReadClient(config,(url,init)=>fetcher(url,{...init,signal:AbortSignal.timeout(15000)}),cookies,config.transport);
  }
  async authenticate(date:string){await this.reader.authenticatedApplications({start:date,end:date});}
  private async knownPartnerAdvisory(html:string,path:string,body:URLSearchParams|undefined,purpose?:PilotEligibilityWarning['purpose']):Promise<boolean>{
    return this.config.eligibilityPolicy===OFFICIAL_UI_ADVISORY_POLICY
      &&['shipcompany','billing'].includes(purpose??'')
      &&path==='/crew/sub01/get_check_cd_partner.php'
      &&body?.toString()==='cd_partner=1002'
      &&html.length===97
      &&await sha256(html)===KNOWN_PARTNER_RESPONSE_SHA256;
  }
  private async request(path:string,body?:URLSearchParams,write=false,helperPurpose?:PilotEligibilityWarning['purpose']):Promise<string>{
    const u=new URL(path,this.origin);
    const reads=[...Object.values(REG_FORM_PATH),...Object.values(REG_LOOKUPS).map(x=>'/crew/sub01/'+x.path),
      '/crew/sub01/get_check_callsign.php','/crew/sub01/get_check_misu_test.php','/crew/sub01/get_check_cd_partner.php','/crew/sub01/cal_data.php'];
    if(u.origin!==this.origin || !(write?Object.values(REG_POST_PATH):reads).includes(u.pathname))throw Error('REG_ENDPOINT_FORBIDDEN');
    const cookies=this.reader.cookies.filter(c=>(c.expires===null||c.expires>Date.now())&&(!c.secure||u.protocol==='https:')
      &&(u.hostname===c.domain||u.hostname.endsWith('.'+c.domain))&&(u.pathname===c.path||u.pathname.startsWith(c.path.endsWith('/')?c.path:c.path+'/')));
    const headers:Record<string,string>={Accept:'text/html',Referer:this.origin+this.formReferer,Cookie:cookies.map(c=>c.name+'='+c.value).join('; ')};
    if(body){headers['Content-Type']='application/x-www-form-urlencoded';headers.Origin=this.origin;}
    const r=await this.fetcher(u,{method:body?'POST':'GET',headers,body,redirect:'manual',signal:AbortSignal.timeout(15000)});
    // Reject redirects, including same-host POST replay. They are not success evidence.
    if(r.status>=300)throw Error(write?'REG_SUBMIT_UNCERTAIN':'REG_READ_HTTP');
    if(helperPurpose&&r.status!==200)throw Error('REG_READ_HTTP');
    this.reader.cookies=updateCookies(this.reader.cookies,r.headers,u);
    const b=await readBounded(r,2_000_000);this.ingress+=b.length;
    const html=new TextDecoder('utf-8',{fatal:true}).decode(b);
    if(/로그인 후 사용|name\s*=\s*["']login_frm|cf-chl-|captcha/i.test(html)
      &&!(await this.knownPartnerAdvisory(html,u.pathname,body,helperPurpose)))throw Error('REG_SESSION_EXPIRED');
    return html;
  }
  async form(action:PilotAction,id?:string,date?:string,readOnly=false):Promise<PilotForm>{
    if(action==='UPDATE'&&(!/^\d{1,30}$/.test(id??'')||!/^\d{4}-\d{2}-\d{2}$/.test(date??'')))throw Error('REG_APPLICATION_ID');
    const path=REG_FORM_PATH[action]+(action==='UPDATE'?'?'+new URLSearchParams({no_forecast:id!,s_dt_ship:date!.replaceAll('-',''),s_cd_partner:'1002'}):'');
    const form=parsePilotForm(await this.request(path),action,readOnly);
    if(action==='UPDATE'&&form.fields.no_forecast!==id)throw Error('REG_APPLICATION_MISMATCH');
    this.formReferer=path;
    return form;
  }
  async readOriginal(id:string,date:string){return this.form('UPDATE',id,date,true);}
  async search(kind:PilotLookup,query:string){
    if(query.length<1||query.length>80||/[\x00-\x1f]/.test(query))throw Error('REG_SEARCH_INPUT');
    const lookup=REG_LOOKUPS[kind];
    return parsePilotChoices(await this.request('/crew/sub01/'+lookup.path,new URLSearchParams({[lookup.parameter]:query})),kind);
  }
  async check(path:string,body:PilotFields,purpose?:'shipcompany'|'billing'):Promise<PilotCheckResult>{
    const helperPurpose=path==='cal_data.php'?'time':purpose??(path==='get_check_cd_partner.php'?'billing':undefined);
    const params=new URLSearchParams(body);
    try {const raw=await this.request('/crew/sub01/'+path,params,false,helperPurpose),result=raw.trim();
      if(await this.knownPartnerAdvisory(raw,'/crew/sub01/'+path,params,helperPurpose))
        return {code:'REG_PARTNER_CHECK_ADVISORY',purpose:helperPurpose as 'shipcompany'|'billing',endpoint:'get_check_cd_partner.php',policy:OFFICIAL_UI_ADVISORY_POLICY,partnerCode:'1002'};
      if(this.config.eligibilityPolicy===OFFICIAL_UI_ADVISORY_POLICY&&path==='cal_data.php'&&raw===''
        &&Object.keys(body).sort().join(',')==='dt_ship,tm_ship_h,tm_ship_i'
        &&/^\d{8}$/.test(body.dt_ship)&&/^(?:[01]\d|2[0-3])$/.test(body.tm_ship_h)&&/^[0-5]\d$/.test(body.tm_ship_i))
        return {code:'REG_TIME_CHECK_ADVISORY',purpose:'time',endpoint:'cal_data.php',policy:OFFICIAL_UI_ADVISORY_POLICY};
      if(path==='cal_data.php'&&result==='')throw Error('REG_TIME_CHECK_EMPTY');
      if(!['Y','N',...(path==='get_check_callsign.php'?['T']:[])].includes(result))throw Error('REG_ELIGIBILITY_RESPONSE');
      return result as 'Y'|'N'|'T';
    }catch(e){
      if(e instanceof Error&&e.message==='REG_SESSION_EXPIRED'){
        if(purpose==='shipcompany')throw Error('REG_COMPANY_AUTH_REQUIRED');
        if(purpose==='billing'||path==='get_check_cd_partner.php')throw Error('REG_BILLING_AUTH_REQUIRED');
      }
      throw e;
    }
  }
  async prepare(action:PilotAction,draft:PilotFields,originalHash?:string):Promise<PreparedPilot>{
    const date=pilotDate(draft);
    // Reauthentication permitted BEFORE submit only. None of the verification methods log in.
    await this.authenticate(date);
    const form=await this.form(action,draft.no_forecast,date);
    const hash=await pilotBusinessHash(form.fields);
    if(action==='UPDATE'&&hash!==originalHash)throw Error('REG_ORIGINAL_CHANGED');
    const f=pilotPayload(form,draft);validatePilotFields(form,f);
    const vessels=await this.search('vessel',f.nm_callsign);
    const vessel=vessels.filter(v=>v.values.cd_callsign===f.cd_callsign&&v.values.nm_callsign===f.nm_callsign);
    if(vessel.length!==1)throw Error('REG_VESSEL_NOT_UNIQUE');
    for(const key of REG_VESSEL.filter(k=>!['cd_cargo','num_length'].includes(k))) if(key in f&&f[key]!==vessel[0].values[key])throw Error('REG_VESSEL_CHANGED');
    for(const side of ['f','t']){
      const points=await this.search('point',f['nm_point_'+side]);
      if(points.filter(p=>['cd_pointrep','cd_pointend','nm_point'].every(k=>p.values[k]===f[k+'_'+side])).length!==1)throw Error('REG_POINT_CHANGED');
    }
    for(const kind of ['shipcompany','billing','mooring'] as const){
      const key=kind==='shipcompany'?'ln_partner_ship':kind==='billing'?'ln_partner_chg':'sn_partner';
      if(!f[key]&&kind==='mooring'&&!f.cd_partner_line)continue;
      const list=await this.search(kind,f[key]);
      if(list.filter(c=>Object.entries(c.values).filter(([k])=>k!=='tel_partner_line').every(([k,v])=>f[k]===v)).length!==1)throw Error('REG_COMPANY_CHANGED');
    }
    const eligibilityWarnings:PilotEligibilityWarning[]=[];
    const record=(result:PilotCheckResult)=>{if(typeof result==='object')eligibilityWarnings.push(result);return result;};
    const vesselCheck=record(await this.check('get_check_callsign.php',{cd_callsign:f.cd_callsign}));
    if(vesselCheck==='T'||vesselCheck==='Y')throw Error('REG_VESSEL_BLOCKED');
    // The observed CREATE and UPDATE forms use different shipcompany checks.
    const companyCheck=action==='CREATE'?'get_check_misu_test.php':'get_check_cd_partner.php';
    if(record(await this.check(companyCheck,{cd_partner:f.cd_partner_ship},'shipcompany'))==='Y')throw Error('REG_COMPANY_BLOCKED');
    if(record(await this.check('get_check_cd_partner.php',{cd_partner:f.cd_partner_chg},'billing'))==='Y')throw Error('REG_BILLING_BLOCKED');
    if(record(await this.check('cal_data.php',{dt_ship:f.dt_ship,tm_ship_h:f.tm_ship_h,tm_ship_i:f.tm_ship_i}))==='N')throw Error('REG_SITE_TIME_BLOCKED');
    const baseline=await this.reader.applications({start:date,end:date});
    const active=baseline.filter(r=>!['COMPLETED','CANCELLED'].includes(r.completion_status)&&r.application_id!==(action==='UPDATE'?f.no_forecast:null));
    if(active.some(r=>r.callsign===f.cd_callsign&&r.pilot_date===date&&r.pilot_time===`${f.tm_ship_h}:${f.tm_ship_i}`&&r.from_location===f.nm_point_f&&r.to_location===f.nm_point_t))throw Error('REG_DUPLICATE');
    return {form,fields:f,baseline,businessHash:hash,warnings:active.filter(r=>r.callsign===f.cd_callsign&&r.from_location===f.nm_point_f&&r.to_location===f.nm_point_t),eligibilityWarnings};
  }
  async submit(prepared:PreparedPilot,permit:{requestId:string;status:'SUBMITTING'}):Promise<void>{
    if(this.submitted||permit.status!=='SUBMITTING'||!/^[a-f\d-]{36}$/.test(permit.requestId))throw Error('REG_SUBMIT_ONCE');
    if(!(prepared.form.action==='CREATE'?this.config.createEnabled:this.config.updateEnabled))throw Error('REG_FEATURE_DISABLED');
    validatePilotFields(prepared.form,prepared.fields);
    this.submitted=true; // Set BEFORE awaiting network; never clear, even on failure.
    await this.request(REG_POST_PATH[prepared.form.action],new URLSearchParams(Object.entries(prepared.fields).filter(([k,v])=>v!==''||!(k in prepared.form.options))),true);
  }
  async verify(action:PilotAction,f:PilotFields,baselineIds:string[]):Promise<ApplicationObservation>{
    const rows=await this.reader.applications({start:pilotDate(f),end:pilotDate(f)});
    const matches=rows.filter(r=>matchesPilot(r,f)&&r.application_id&&r.completion_status==='ACTIVE'&&
      (action==='CREATE'?!baselineIds.includes(r.application_id):r.application_id===f.no_forecast));
    if(matches.length!==1)throw Error('REG_VERIFICATION_REQUIRED');
    const row=matches[0],detail=await this.form('UPDATE',row.application_id!,row.pilot_date);
    // Compare every requested business value, including fields absent from the list.
    for(const [k,v] of Object.entries(pilotBusinessFields(f)))
      if(!['no_forecast','fg_status'].includes(k)&&(!(k in detail.fields)||detail.fields[k]!==v))throw Error('REG_DETAIL_MISMATCH');
    return row;
  }
}
