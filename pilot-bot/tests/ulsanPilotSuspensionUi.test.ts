// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PILOT_SUSPENSION_STATUSES, normalizePilotSuspensionStatus, pilotSuspensionCounts, pilotSuspensionSummary, pilotSuspensionDisplay } from '../supabase/functions/_shared/pilotSuspension';
import { formatReply } from '../supabase/functions/telegram-webhook/lib/formatters';
import { createWebhook } from '../supabase/functions/telegram-webhook/lib/runtime';

const data={last_success:new Date().toISOString(),bootstrap_done:true,enabled:true,weather:'SUSPENDED',active:3,processing:0,
  bad_weather_count:2,dense_fog_count:1,port_close_count:1,suspension_total_count:3,suspension_reasons:['BAD_WEATHER','DENSE_FOG','PORT_CLOSE'],total:3,rows:[]};
const row=(status:string,i=0)=>({sequence_no:i+1,application_id:String(i+1),vessel_name:`SHIP ${i+1}`,pilot_date:'2026-09-22',pilot_time:'12:00',from_location:'P/S',to_location:'OTK(S)',application_status:'020',status,operational_status:status});

describe('shared suspension status and Telegram read models',()=>{
 it('has exactly the three confirmed suspension statuses and no inferred aliases',()=>{
  expect([...PILOT_SUSPENSION_STATUSES]).toEqual(['BAD_WEATHER','DENSE_FOG','PORT_CLOSE']);
  for(const status of PILOT_SUSPENSION_STATUSES)expect(normalizePilotSuspensionStatus(status)).toBe(status);
  expect(normalizePilotSuspensionStatus('  dense\n fog  ')).toBe('DENSE_FOG');
  expect(normalizePilotSuspensionStatus(' port\u00a0close ')).toBe('PORT_CLOSE');
  for(const status of ['FOG','PORT CLOSED','DENSE-FOG','DENSEFOG','CLOSE PORT','PROCESSING',null])expect(normalizePilotSuspensionStatus(status)).toBeNull();
  expect(pilotSuspensionDisplay('BAD_WEATHER')).toBe('⚠️ BAD WEATHER');
  expect(pilotSuspensionDisplay('DENSE_FOG')).toBe('🌫️ DENSE FOG');
  expect(pilotSuspensionDisplay('PORT_CLOSE')).toBe('⛔ PORT CLOSE');
 });
 it('uses authoritative distinct vessel total instead of adding reason counts',()=>{
  const counts=pilotSuspensionCounts(data);
  expect(counts.total).toBe(3);expect(counts.badWeather+counts.denseFog+counts.portClose).toBe(4);
  expect(pilotSuspensionSummary(data)).toContain('중단 표시 합계: 3척');
  expect(pilotSuspensionSummary(data)).toContain('BAD WEATHER: 2척 / DENSE FOG: 1척 / PORT CLOSE: 1척');
  expect(pilotSuspensionSummary(data)).toContain('중단 사유: BAD WEATHER · DENSE FOG · PORT CLOSE');
 });
 it('falls back to old BAD WEATHER count without breaking pre-migration replies',()=>{
  expect(pilotSuspensionCounts({bad_weather_count:4})).toEqual({badWeather:4,denseFog:0,portClose:0,total:4,reasons:['BAD_WEATHER']});
  expect(pilotSuspensionSummary({bad_weather_count:0})).not.toContain('중단 사유:');
  expect(pilotSuspensionCounts({bad_weather_count:2,suspension_total_count:0,suspension_reasons:[]})).toMatchObject({total:0,reasons:[]});
 });
 it('renders bounded zero defaults for missing/invalid counts and never displays unknown reason codes',()=>{
  const invalid={bad_weather_count:-1,dense_fog_count:NaN,port_close_count:'many',suspension_total_count:Infinity,suspension_reasons:['FOG','unknown',null]};
  expect(pilotSuspensionCounts(invalid)).toEqual({badWeather:0,denseFog:0,portClose:0,total:0,reasons:[]});
  expect(pilotSuspensionCounts({})).toEqual({badWeather:0,denseFog:0,portClose:0,total:0,reasons:[]});
  const text=formatReply({name:'weather'},{...data,...invalid,rows:[]}).text;
  expect(text).toContain('중단 표시 합계: 0척');expect(text).not.toMatch(/NaN|Infinity|undefined|unknown/);
 });
 it('current state displays mixed suspension reasons without renaming them BAD WEATHER',()=>{
  const text=formatReply({name:'status'},data).text;
  expect(text).toContain('중단 표시 합계: 3척');expect(text).toContain('DENSE FOG: 1척');expect(text).toContain('PORT CLOSE: 1척');
  expect(text).toContain('중단 사유: BAD WEATHER · DENSE FOG · PORT CLOSE');expect(text).not.toContain('BAD WEATHER: 3척');
 });
 it('weather rows show each actual suspension reason and keep pagination and stale protection',()=>{
  const text=formatReply({name:'weather'},{...data,last_success:'2020-01-01',rows:[...PILOT_SUSPENSION_STATUSES].map(row)}).text;
  for(const status of PILOT_SUSPENSION_STATUSES)expect(text).toContain(pilotSuspensionDisplay(status));
  expect(text).not.toContain('공개:');expect(text).toContain('최신 자료가 아닙니다');
  const reply=formatReply({name:'weather',page:1},{...data,total:21,rows:[row('DENSE_FOG')]});
  expect(reply.markup.inline_keyboard[0]).toEqual([{text:'◀ 이전',callback_data:'v1:q:weather:0'},{text:'다음 ▶',callback_data:'v1:q:weather:2'}]);
 });
 it('weather combines multiple verified reasons per vessel without inventing unknown states',()=>{
  const text=formatReply({name:'weather'},{...data,rows:[{...row('BAD_WEATHER'),suspension_reasons:['DENSE_FOG','PORT_CLOSE','DENSE_FOG','FOG']}]}).text;
  expect(text).toContain('🌫️ DENSE FOG · ⛔ PORT CLOSE');expect(text).not.toContain('⚠️ BAD WEATHER');expect(text).not.toContain('· FOG');
 });
 it.each(['queue','today','tomorrow','three','search'])('%s displays all suspension labels but reserves public rows for POB/PROCESSING',name=>{
  const text=formatReply({name},{...data,rows:[...PILOT_SUSPENSION_STATUSES].map(row)}).text;
  for(const status of PILOT_SUSPENSION_STATUSES)expect(text).toContain(pilotSuspensionDisplay(status));
  expect(text).not.toContain('공개:');expect(text).not.toContain('신청:');
  expect(formatReply({name},{...data,rows:[row('POB'),row('PROCESSING',1)]}).text).toContain('공개: POB');
  expect(formatReply({name},{...data,rows:[row('POB'),row('PROCESSING',1)]}).text).toContain('공개: PROCESSING');
 });
 it('refresh response includes the combined total and reason counts even during cooldown',async()=>{
  const config={url:'https://test.supabase.co',serviceKey:'service',watcherKey:'w'.repeat(40),operatorKey:'o'.repeat(40),botToken:'test',chatId:'-1',webhookSecret:'s'.repeat(40),adminChats:['-1'],botUsername:'test_bot',gatewayJwt:'gateway'};
  const calls:{name:string;body:any}[]=[];
  const fetcher=(async(url:unknown,init:RequestInit)=>{
   const name=String(url).split('/').at(-1)!;const body=JSON.parse(String(init.body));calls.push({name,body});
   if(name==='hpbot_accept_update')return Response.json(true);
   if(name==='getChatMember')return Response.json({ok:true,result:{status:'member'}});
   if(name==='hpbot_request_refresh')return Response.json('COOLDOWN');
   if(name==='hpbot_read')return Response.json(data);
   if(name==='pilot_claim_notification')return Response.json(null);
   return new Response(null,{status:204});
  }) as typeof fetch;
  const request=new Request('https://test/functions/v1/telegram-webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':config.webhookSecret},body:JSON.stringify({update_id:22,message:{text:'새로고침',chat:{id:-1},from:{id:123}}})});
  expect((await createWebhook(config,fetcher)(request)).status).toBe(200);
  const text=calls.find(c=>c.name==='hpbot_reply')?.body.p_message;
  expect(text).toContain('30초 제한');expect(text).toContain('중단 표시 합계: 3척');expect(text).toContain('DENSE FOG: 1척');expect(text).toContain('PORT CLOSE: 1척');
  expect(text).toContain('중단 사유: BAD WEATHER · DENSE FOG · PORT CLOSE');
 });
});
