import { UlsanReadClient, openSession, sealSession, applicationHash, checkRange } from './hyopuSource.ts';
import type { DateRange, SourceTransport, ApplicationObservation, SessionCookie } from './hyopuSource.ts';
export interface LoginConfig { username:string; password:string; sessionKey:string; transport:SourceTransport }
export interface CollectionContext { ranges:DateRange[]; old_dates:string[]; bootstrap:DateRange|null; sealed_session?:string|null }
export function mergeRanges(ranges:DateRange[]):DateRange[] {
  ranges.forEach(checkRange);
  const sorted=ranges.map(r=>({...r})).sort((a,b)=>a.start.localeCompare(b.start));const merged:DateRange[]=[];
  for(const r of sorted){const last=merged.at(-1);if(last&&r.start<=last.end){if(r.end>last.end)last.end=r.end;}else merged.push(r);}
  if(merged.length>64)throw new Error('APPLICATION_RANGE_LIMIT');return merged;
}
export async function collectApplications(config:LoginConfig,context:CollectionContext,fetcher:typeof fetch=fetch,reserveSplit?:()=>Promise<void>) {
  if(!config.username||!config.password)throw new Error('LOGIN_NOT_CONFIGURED');
  let cookies:SessionCookie[]=[];
  if(context.sealed_session){try{cookies=await openSession(context.sealed_session,config.sessionKey);}catch{cookies=[];}}
  const before=JSON.stringify(cookies);
  const client=new UlsanReadClient({username:config.username,password:config.password},fetcher,cookies,config.transport);
  const ranges=mergeRanges([...context.ranges,...context.old_dates.map(d=>({start:d,end:d})),...(context.bootstrap?[context.bootstrap]:[])]);
  const rows:ApplicationObservation[]=[];
  const pending=[...ranges];let splits=0;
  while(pending.length){
    const range=pending.shift()!;
    try{rows.push(...await client.authenticatedApplications(range));}
    catch(e){
      if(!(e instanceof Error)||!['RESPONSE_LIMIT','APPLICATION_TOO_LARGE'].includes(e.message)||range.start===range.end||++splits>12)throw e;
      // A failed large range supplies no rows. Both smaller ranges must complete
      // before its coverage can be committed or absence can be considered.
      await reserveSplit?.();
      const start=Date.parse(range.start+'T00:00:00Z'),end=Date.parse(range.end+'T00:00:00Z');
      const middle=start+Math.floor((end-start)/86400000/2)*86400000;
      pending.unshift({start:range.start,end:new Date(middle).toISOString().slice(0,10)},
        {start:new Date(middle+86400000).toISOString().slice(0,10),end:range.end});
    }
    if(rows.length>4000||client.ingress>8_000_000)throw new Error('APPLICATION_TOTAL_LIMIT');
  }
  const ids=rows.map(r=>r.application_id).filter(Boolean);
  if(new Set(ids).size!==ids.length)throw new Error('APPLICATION_DUPLICATE');
  return {rows,ranges,hash:await applicationHash(rows),ingress:client.ingress,
    session:JSON.stringify(client.cookies)===before?null:await sealSession(client.cookies,config.sessionKey),
    bootstrapEnd:context.bootstrap?.end??null};
}
