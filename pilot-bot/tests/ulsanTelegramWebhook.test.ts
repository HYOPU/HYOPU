// @vitest-environment node
import { describe,it,expect } from 'vitest';
import { parseCommand,parseCallback } from '../supabase/functions/telegram-webhook/lib/commands';
import { formatReply,mainMenu } from '../supabase/functions/telegram-webhook/lib/formatters';
import { pilotDateTimeLabel,pilotKstLabel } from '../supabase/functions/_shared/pilotDateTime';
import { createWebhook } from '../supabase/functions/telegram-webhook/lib/runtime';
const config={url:'https://test.supabase.co',serviceKey:'service',watcherKey:'w'.repeat(40),operatorKey:'o'.repeat(40),botToken:'test',chatId:'-1',webhookSecret:'s'.repeat(40),adminChats:['-1'],botUsername:'test_bot',gatewayJwt:'gateway'};
const update=(text='협운일정',extra={})=>({update_id:1,message:{text,chat:{id:-1},from:{id:123},...extra}});
const request=(u:any,secret=config.webhookSecret)=>new Request('https://test/functions/v1/telegram-webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(u)});
const state={last_success:new Date().toISOString(),enabled:true,weather:'SUSPENDED',bad_weather_count:3,active:1,processing:0,hpbot_bad_weather:1,bootstrap_done:true,total:1,rows:[{sequence_no:3,application_id:'1',vessel_name:'SHIP A',pilot_date:'2026-09-20',pilot_time:'12:00',from_location:'P/S',to_location:'OTK(S)',application_status:'020',forecast_status:'BAD_WEATHER',is_overdue:true}]};
function fake(role='member',accept=true){const calls:{name:string;body:any}[]=[];const fetcher=(async(url:unknown,init:RequestInit)=>{
 const name=String(url).split('/').at(-1)!;const body=JSON.parse(String(init.body));calls.push({name,body});
 if(name==='getChatMember')return Response.json({ok:true,result:{status:role}});
 if(name==='hpbot_accept_update')return Response.json(accept);
 if(name==='hpbot_read'||name==='hpbot_registration_status')return Response.json(state);
 if(name==='hpbot_prepare_confirmation')return Response.json('00000000-0000-0000-0000-000000000001');
 if(name==='pilot_claim_notification')return Response.json(null);
 if(name==='answerCallbackQuery')return Response.json({ok:true,result:true});
 return new Response(null,{status:204});
 }) as typeof fetch;return {fetcher,calls};}
describe('Korean Telegram commands',()=>{
 it('renders Korean weekday and four-digit time for queue, search and weather',()=>{
   const d={...state,rows:[{...state.rows[0],pilot_date:'2026-09-21',pilot_time:'09:30',forecast_time:'10:15'}]};
   for(const name of ['queue','today','tomorrow','three','search','weather'])expect(formatReply({name},d).text).toContain('09/21(월) 0930');
   expect(formatReply({name:'queue'},d).text).toContain('공개 예보시간: 1015');
   expect(pilotDateTimeLabel('20260921','06:15')).toBe('09/21(월) 0615');
   expect(pilotDateTimeLabel('2026-09-21','')).toBe('09/21(월) 시간 미정');
   expect(pilotKstLabel('2026-09-20T15:00:00Z')).toBe('09/21(월) 0000');
   expect(pilotDateTimeLabel('2026-02-30','09:30')).toBe('날짜 확인 필요 0930');
 });
 it('POB alert toggle is visible, enabled by default and uses existing authenticated setting path',()=>{
   const reply=formatReply({name:'settings'},state);
   expect(reply.markup.inline_keyboard.flat()).toContainEqual({text:'POB (도선사 승선) ✅',callback_data:'v1:setting:POB'});
   expect(parseCallback('v1:setting:POB')).toEqual({name:'setting',setting:'POB'});
 });
 it.each(['도선 중단 선박조회','⚠️ 도선 중단 선박조회','/도선중단선박조회','악천후'])('recognizes weather label %s',text=>{expect(parseCommand(text)?.name).toBe('weather');const r=formatReply({name:'weather'},state);expect(r.text).toContain('[도선 중단 선박조회]');expect(mainMenu.keyboard[1][0]).toBe('⚠️ 도선 중단 선박조회');});
 it.each(['도선 등록현황','/도선등록현황','🚢 도선 등록현황'])('recognizes registration status %s',text=>expect(parseCommand(text)?.name).toBe('queue'));
 it('puts registration status first and removes the three date buttons',()=>{const buttons=mainMenu.keyboard.flat();expect(buttons[0]).toBe('🚢 도선 등록현황');expect(buttons[1]).toBe('📡 현재 도선상태');for(const name of ['협운일정','오늘일정','내일일정','3일일정'])expect(buttons.some(b=>b.includes(name))).toBe(false);});
 it.each(['현재 도선상태','📡 현재 도선상태','/현재도선상태','현재상태','현재 상태'])('recognizes status label %s',text=>{expect(parseCommand(text)?.name).toBe('status');expect(formatReply({name:'status'},state).text).toContain('[현재 도선상태]');});
 it('hides query period and exclusion captions while retaining pagination',()=>{const r=formatReply({name:'queue'},{...state,total:21,date_from:'2026-09-20',date_to:'2026-09-27'});expect(r.text).toContain('[도선 등록현황]');expect(r.text).not.toContain('조회기간');expect(r.text).not.toContain('취소·완료·청구 제외');expect(r.text).not.toContain('2026-09-20 ~ 2026-09-27');expect(r.markup.inline_keyboard[0][0].callback_data).toBe('v1:q:queue:1');});
 it('routes status and pagination through the bounded database query',async()=>{const f=fake();await createWebhook(config,f.fetcher)(request(update('도선 등록현황')));expect(f.calls.find(c=>c.name==='hpbot_registration_status')?.body).toEqual({p_page:0});});
 it('search pagination references chat-bound query context, not a truncated vessel name',()=>{
   const reply=formatReply({name:'search',search:'A VERY LONG SHIP NAME',contextId:424776705},{...state,total:25});
   const callback=reply.markup.inline_keyboard[0][0].callback_data;
   expect(callback).toBe('v1:s:424776705:1');
   expect(parseCallback(callback)).toMatchObject({name:'search',page:1,contextId:424776705});
 });
 it.each(['협운일정','/협운일정','협운 일정','🚢 협운일정','/queue@test_bot'])('recognizes %s',text=>expect(parseCommand(text,'test_bot')?.name).toBe('queue'));
 it('ignores ordinary conversation, wrong bot mention and untrusted callbacks',()=>{expect(parseCommand('오늘 점심 뭐 먹을까요?')).toBeNull();expect(parseCommand('/queue@other','test_bot')).toBeNull();expect(parseCallback('v1:q:queue:-1')).toBeNull();});
 it('retains global sequence and overdue indicator in filtered display',()=>{const r=formatReply({name:'today'},state);expect(r.text).toContain('③ SHIP A');expect(r.text).toContain('예정시간 경과 / 미완료');});
 it('shows actual mooring or explicit unknown, never a guessed provider',()=>{
   expect(formatReply({name:'queue'},state).text).toContain('강취: 미확인');
   expect(formatReply({name:'queue'},{...state,rows:[{...state.rows[0],mooring_name:'진산'}]}).text).toContain('강취: 진산');
 });
 it('marks stale observations explicitly',()=>expect(formatReply({name:'status'},{...state,last_success:'2020-01-01'}).text).toContain('최신 자료가 아닙니다'));
 it('rejects forged secret before any database call',async()=>{const f=fake();expect((await createWebhook(config,f.fetcher)(request(update(),'wrong'))).status).toBe(401);expect(f.calls).toHaveLength(0);});
 it.each([{sender_chat:{id:-1}},{chat:{id:-999}},{from:{id:123,is_bot:true}}])('rejects anonymous/foreign/bot sender %j',async extra=>{const f=fake();await createWebhook(config,f.fetcher)(request(update('새로고침',extra)));expect(f.calls).toHaveLength(0);});
 it('ordinary participant can query without admin check',async()=>{const f=fake();await createWebhook(config,f.fetcher)(request(update()));expect(f.calls.some(c=>c.name==='getChatMember')).toBe(false);expect(f.calls.find(c=>c.name==='hpbot_reply')?.body.p_message).toContain('SHIP A');});
 it('ordinary participant can request monitoring control with confirmation',async()=>{const f=fake();await createWebhook(config,f.fetcher)(request(update('감시중지')));expect(f.calls.some(c=>c.name==='hpbot_prepare_confirmation')).toBe(true);expect(f.calls.some(c=>c.name==='hpbot_confirm')).toBe(false);});
 it.each(['left','kicked','restricted'])('nonparticipants cannot control monitoring: %s',async role=>{const f=fake(role);await createWebhook(config,f.fetcher)(request(update('감시중지')));expect(f.calls.some(c=>c.name==='hpbot_prepare_confirmation')).toBe(false);expect(f.calls.find(c=>c.name==='hpbot_reply')?.body.p_message).toContain('현재 참여자만');});
 it.each(['도선 등록현황','현재 도선상태','도선 중단 선박조회','도움말'])('keeps registration buttons after participant query %s',async text=>{const f=fake();const c={...config,registration:{username:'test',password:'test',transport:'http-approved' as const,sessionKey:'ab'.repeat(32),createEnabled:false,updateEnabled:false}};await createWebhook(c,f.fetcher)(request(update(text,{message_id:99})));const buttons=f.calls.find(c=>c.name==='pilot_reg_reply')?.body.p_markup.keyboard.flat();expect(buttons).toContain('➕ 도선등록');expect(buttons).toContain('✏️ 도선수정');expect(buttons[0]).toBe('🚢 도선 등록현황');});
 it('administrator must confirm before stopping',async()=>{const f=fake('administrator');await createWebhook(config,f.fetcher)(request(update('감시중지')));expect(f.calls.some(c=>c.name==='hpbot_prepare_confirmation')).toBe(true);expect(f.calls.some(c=>c.name==='hpbot_confirm')).toBe(false);});
 it('duplicate update never creates second reply',async()=>{const f=fake('administrator',false);await createWebhook(config,f.fetcher)(request(update()));expect(f.calls.some(c=>c.name==='hpbot_reply')).toBe(false);});
});
