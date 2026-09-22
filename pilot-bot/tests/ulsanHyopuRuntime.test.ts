// @vitest-environment node
import { describe,it,expect } from 'vitest';
import { createHyopuHandler } from '../supabase/functions/ulsan-pilot-watcher/lib/hyopuRuntime';
import { collectApplications } from '../supabase/functions/ulsan-pilot-watcher/lib/hyopuCollector';
import { sealSession } from '../supabase/functions/ulsan-pilot-watcher/lib/hyopuSource';
import { fetchForecast,kstDate } from '../supabase/functions/ulsan-pilot-watcher/lib/source';
const today=kstDate(new Date()),compact=today.replaceAll('-','');
const headers=['NO','상태','C/F','협회 REMARK','DATE','TIME',"SHIP'S NAME",'PILOT(s)','P','Two.','Co.','C/SIGN','G/T','LOA','DFT','FROM','TO','CA','S/A','B/T','G/A','L/A','T','L','Q','REMARKS','PIC','TEL',"SHIP'S NAME"];
const cells=[`1 <a href="sub02_03.php?no_forecast=1&s_cd_partner=1002">수정</a>`,'확인','','',today.replaceAll('-','/'),'12:00','SHIP','','','','','CALL','1','1','1','P/S','OTK(S)','','','','협운해운','협운','','','','','','','SHIP'];
const applicationHtml=`<html><body>협운해운 ON<input name="s_dt_ships" value="${compact}"><input name="s_dt_shipe" value="99991231"><table><tr>${headers.map(s=>`<th>${s}</th>`).join('')}</tr><tr>${cells.map(s=>`<td>${s}</td>`).join('')}</tr></table></body></html>`;
const publicHtml=`<tr>${['1','Bad weather','','12:00','SHIP','','CALL','1','1','1','P/S','OTK(S)','협운','','','','','','',''].map(s=>`<td>${s}</td>`).join('')}</tr>`;
const config={url:'https://test.supabase.co',serviceKey:'s'.repeat(220),watcherKey:'w'.repeat(40),operatorKey:'o'.repeat(40),botToken:'test',chatId:'-1',login:{username:'TEST',password:'TEST',sessionKey:'ab'.repeat(32),transport:'http-approved' as const}};
async function prepare(){
 const sealed_session=await sealSession([{name:'PHPSESSID',value:'test',domain:'www.ulsanpilot.co.kr',path:'/',secure:false,expires:null}],config.login.sessionKey);
 const context={ranges:[{start:today,end:'9999-12-31'}],old_dates:[],bootstrap:null,sealed_session};
 const source=(async(url:unknown)=>new Response(String(url).includes('/crew/')?applicationHtml:publicHtml,{headers:{date:new Date().toUTCString(),'content-type':'text/html'}})) as typeof fetch;
 const a=await collectApplications(config.login,context,source);const f=await fetchForecast(source);
 return {context,source,a,f};
}
describe('dual-source runtime',()=>{
 it('unchanged run remains under 8 KiB, no snapshot payload or cookie rewrite',async()=>{
   const {context,source,a,f}=await prepare();const calls:{name:string;args:any}[]=[];let metered=0;
   const mock=(async(url:unknown,init:RequestInit)=>{
     if(String(url).startsWith('http:'))return source(url as any,init);
     const name=String(url).split('/').at(-1)!;const args=JSON.parse(String(init.body));calls.push({name,args});
     if(name==='hpbot_begin')return Response.json({...context,token:'t',version:1,application_hash:a.hash,forecast_hash:f.hash});
     if(name==='pilot_reserve_extra')return Response.json(true);
     if(name==='hpbot_commit')return Response.json({accepted:true});
     if(name==='pilot_claim_notification')return Response.json(null);
     throw new Error('UNEXPECTED');
   }) as typeof fetch;
   const result=await createHyopuHandler(config,mock,n=>metered=n)(new Request('https://test',{method:'POST',headers:{'x-watcher-key':config.watcherKey}}));
   expect(result.status).toBe(204);expect(result.headers.get('x-pilot-accepted')).toBe('true');
   const commit=calls.find(c=>c.name==='hpbot_commit')!.args;expect(commit.p_applications).toBeNull();expect(commit.p_forecast).toBeNull();expect(commit.p_session).toBeNull();
   expect(metered).toBeLessThanOrEqual(8192);
 });
 it('login failure cannot commit partial public data or mark completion',async()=>{
   const {context}=await prepare();const names:string[]=[];
   const mock=(async(url:unknown)=>{const name=String(url).split('/').at(-1)!;names.push(name);
     if(name==='hpbot_begin')return Response.json({...context,token:'t',version:1});
     if(name==='sub02_01.php')return new Response('broken',{status:500});
     if(name==='hpbot_fail')return new Response(null,{status:204});
     if(name==='pilot_claim_notification')return Response.json(null);throw new Error('UNEXPECTED');
   }) as typeof fetch;
   await createHyopuHandler(config,mock)(new Request('https://test',{method:'POST',headers:{'x-watcher-key':config.watcherKey}}));
   expect(names).toContain('hpbot_fail');expect(names).not.toContain('hpbot_commit');expect(names).not.toContain('get_cz_or_assign_s.php');
 });
 it('dry run does not persist session, reserve budget or send Telegram',async()=>{
   const {context,source}=await prepare();const names:string[]=[];
   const mock=(async(url:unknown,init:RequestInit)=>{if(String(url).startsWith('http:'))return source(url as any,init);const name=String(url).split('/').at(-1)!;names.push(name);
     if(name==='hpbot_context')return Response.json(context);if(name==='hpbot_preview')return Response.json({counts:{active:1}});throw new Error('UNEXPECTED');
   }) as typeof fetch;
   expect((await createHyopuHandler(config,mock)(new Request('https://test?dryRun=true',{headers:{'x-watcher-key':config.operatorKey}}))).status).toBe(200);
   expect(names).toEqual(['hpbot_context','hpbot_preview']);
 });
});
