import { REG_EDITABLE, REG_VESSEL, pilotPayload } from './contract.ts';
import type { PilotFields, PilotForm } from './contract.ts';
import type { PilotRegistrationClient } from './client.ts';
import type { PilotDraft } from './wizard.ts';
import { pilotOpen } from './crypto.ts';
import { sha256 } from '../../ulsan-pilot-watcher/lib/source.ts';

export const COPY_CONTROLS = new Set(['dt_ship','time','from','to']);
export const COPY_CHANGED = new Set(['dt_ship','tm_ship_h','tm_ship_i',
  ...['f','t'].flatMap(s=>['nm_point','cd_pointrep','cd_pointend','nm_pointrep','nm_pointend'].map(k=>k+'_'+s))]);
const businessKeys=[...new Set([...REG_EDITABLE,...REG_VESSEL,'cd_partner','ln_partner'])].sort();
export interface CopyReference { sourceId:string; applicationId:string|null; date:string; observedAt:string; hash:string; archived:boolean; fields:PilotFields }
export interface CopySource { id:string; application_id:string|null; metadata:any; fingerprint:string; sealed_data?:string; observed_at?:string; business_hash?:string; complete?:boolean }
export function copyFields(fields:PilotFields):PilotFields {
  if(businessKeys.some(k=>!(k in fields)||typeof fields[k]!=='string'))throw Error('COPY_INCOMPLETE');
  if(fields.cd_partner!=='1002'||!fields.cd_callsign||!fields.nm_callsign)throw Error('COPY_IDENTITY');
  return Object.fromEntries(businessKeys.map(k=>[k,fields[k]]));
}
export const copyHash=(fields:PilotFields)=>sha256(JSON.stringify(copyFields(fields)));
export function assertRecentCopyCompletion(date:string,days=30,now=Date.now()){
  const today=new Date(now+9*3600000).toISOString().slice(0,10);
  const first=new Date(Date.parse(today+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);
  if(date<first||date>today)throw Error('COPY_HISTORY_RANGE');
}
export function assertCopyDraft(d:PilotDraft){
  if(!d.copy||d.mode!=='COPY'||d.action!=='CREATE')throw Error('COPY_MODE');
  const original=copyFields(d.copy.fields),next=copyFields(d.fields);
  for(const key of businessKeys)if(!COPY_CHANGED.has(key)&&original[key]!==next[key])throw Error('COPY_LOCKED_FIELD');
}
export function makeCopyDraft(form:PilotForm,ref:CopyReference):PilotDraft {
  if(form.action!=='CREATE')throw Error('COPY_CREATE_ONLY');
  const fields=pilotPayload(form,copyFields(ref.fields));
  return {action:'CREATE',mode:'COPY',dryRun:false,step:'edit',form,fields,copy:ref,original:{...ref.fields}};
}
/** Authenticate before calling. Only verified completed rows may use an archive;
 * network/authentication errors never become proof of deletion or completion. */
export async function readCopySource(client:PilotRegistrationClient,row:CopySource,key:string):Promise<CopyReference>{
  if(!row?.id)throw Error('COPY_SOURCE_MISSING');
  const m=row.metadata;
  const rows=await client.reader.applications({start:m.pilot_date,end:m.pilot_date});
  const identified=row.application_id?rows.filter(r=>r.application_id===row.application_id):[];
  if(identified.length===1){
    const current=identified[0];
    if(current.completion_status==='CANCELLED')throw Error('COPY_CANCELLED');
    if(current.completion_status==='COMPLETED')assertRecentCopyCompletion(current.pilot_date,client.copyHistoryDays);
    const form=await client.readOriginal(row.application_id!,current.pilot_date);
    const fields=copyFields(form.fields);
    return {sourceId:row.id,applicationId:row.application_id,date:current.pilot_date,observedAt:new Date().toISOString(),hash:await copyHash(fields),archived:false,fields};
  }
  const terminal=rows.filter(r=>r.callsign===m.callsign&&r.vessel_name===m.vessel_name&&r.pilot_date===m.pilot_date
    &&r.pilot_time===m.pilot_time&&r.from_location===m.from_location&&r.to_location===m.to_location);
  if(terminal.length!==1||terminal[0].completion_status!=='COMPLETED')throw Error('COPY_SOURCE_UNCONFIRMED');
  assertRecentCopyCompletion(terminal[0].pilot_date,client.copyHistoryDays);
  if(!row.complete||!row.sealed_data||!row.observed_at)throw Error('COPY_INCOMPLETE');
  const saved=await pilotOpen<{version:number;fields:PilotFields}>(row.sealed_data,key,'copy:'+row.id);
  if(saved.version!==1)throw Error('COPY_CONTRACT_VERSION');
  const fields=copyFields(saved.fields),hash=await copyHash(fields);
  if(hash!==row.business_hash)throw Error('COPY_ARCHIVE_HASH');
  if(fields.cd_callsign!==m.callsign||fields.nm_callsign!==m.vessel_name||fields.dt_ship!==m.pilot_date.replaceAll('-','')
    ||`${fields.tm_ship_h}:${fields.tm_ship_i}`!==m.pilot_time||fields.nm_point_f!==m.from_location||fields.nm_point_t!==m.to_location)throw Error('COPY_ARCHIVE_IDENTITY');
  const current=terminal[0];
  if(current.draft&&Number(current.draft)!==Number(fields.num_draft)||current.mooring_name&&current.mooring_name.trim()!==fields.sn_partner.trim()
    ||current.remarks!==undefined&&current.remarks.trim()!==fields.nm_text.trim())throw Error('COPY_ARCHIVE_STALE');
  return {sourceId:row.id,applicationId:row.application_id,date:m.pilot_date,observedAt:row.observed_at,hash,archived:true,fields};
}
export async function prepareCopy(client:PilotRegistrationClient,d:PilotDraft,row:CopySource,key:string){
  assertCopyDraft(d);
  const latest=await readCopySource(client,row,key);
  if(latest.hash!==d.copy!.hash)throw Error('COPY_ORIGINAL_CHANGED');
  const prepared=await client.prepare('CREATE',d.fields);
  // Fresh system controls may change; no unreviewed business change is allowed.
  assertCopyDraft({...d,fields:prepared.fields});
  return prepared;
}
