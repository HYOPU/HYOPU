import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {hydrateSeed,parseEta,calendarDays,shiftMonth,callsOnDay,inMonth,matchesFilters} from '../operations-model.mjs';
import {parseReport} from '../sof-parser.mjs';
import validation from '../lib/call-validation.js';
import callsHandler from '../api/port-calls.js';
import sessionHandler from '../api/workspace.js';
const seed=JSON.parse(fs.readFileSync(new URL('../eta-seed.json',import.meta.url),'utf8'));
const calls=hydrateSeed(seed);
test('ETA source contains 42 distinct port calls, exact PIC counts and uncertainty',()=>{
  assert.equal(calls.length,42);assert.equal(new Set(calls.map(c=>c.id)).size,42);
  for(const [pic,count] of Object.entries({'DENNIS':9,'JAE LEE':15,'JACK':13,'RICK':5}))assert.equal(calls.filter(c=>matchesFilters(c,{pic})).length,count);
  assert.equal(calls.filter(c=>c.vessel==='S.RENGE'&&c.voyage==='92').length,3);
  assert.equal(calls[8].etaRaw,'09/05 0500');assert.equal(calls[10].etaRaw,'09/06 2000');assert.equal(calls[14].etaRaw,'09/09 PM');
  assert.equal(calls[15].etaRaw,'09/12');assert.equal(calls[16].etaRaw,'09/11');
  assert.deepEqual(calls[13].highlight,['vessel']);assert.deepEqual(calls[17].highlight,['port']);
});
test('calendar is Monday-first, rolls years, retains AM/PM and never invents a clock',()=>{
  assert.equal(calendarDays('2026-09')[0],'2026-08-31');assert.equal(calendarDays('2026-09').length,35);
  assert.equal(calendarDays('2026-08').length,42);assert.equal(shiftMonth('2026-12',1),'2027-01');
  assert.deepEqual(parseEta('09/05 1200??'),{date:'2026-09-05',time:'12:00',period:'',uncertain:true});
  assert.equal(parseEta('09/09 PM').time,'');assert.equal(parseEta('09/09 PM').period,'PM');
  assert.equal(parseEta('02/30').date,'');assert.equal(parseEta('09/09 2500').time,'');
});
test('in-port carries from August through ETD; other vessel visits stay separate',()=>{
  assert.equal(calls.filter(c=>inMonth(c,'2026-09')).length,30);
  assert.ok(callsOnDay(calls,'2026-09-01').some(c=>c.id===calls[0].id));
  assert.ok(callsOnDay(calls,'2026-09-03').some(c=>c.id===calls[0].id));
  assert.ok(!callsOnDay(calls,'2026-09-04').some(c=>c.id===calls[0].id));
  assert.equal(calls.filter(c=>matchesFilters(c,{pic:'JAE LEE',port:'DAESAN',query:'renge'})).length,1);
});
test('all reference calls and genuine parser snapshots pass server validation',()=>{
  for(const call of calls)assert.equal(validation.validateCall(call),null);
  for(const name of ['betula','kashi','larix']){const report=parseReport(fs.readFileSync(new URL(`fixtures/${name}.txt`,import.meta.url),'utf8'));assert.ok(validation.validSof(report),name);}
});
test('INPORT with unknown ETD remains visible through today without inventing future dates',()=>{
  const call={...calls[0],etaRaw:'08/30',etdRaw:'',status:'INPORT'};
  assert.equal(callsOnDay([call],'2026-09-03','2026-09-03').length,1);
  assert.equal(callsOnDay([call],'2026-09-04','2026-09-03').length,0);
  assert.equal(inMonth(call,'2026-09','2026-09-03'),true);
  assert.equal(inMonth(call,'2026-10','2026-09-03'),false);
});
test('editing vessel identity cannot save or import a mismatched old SOF',()=>{
  const sof=parseReport(fs.readFileSync(new URL('fixtures/kashi.txt',import.meta.url),'utf8'));
  const call={...calls[0],vessel:sof.fields.vessel,voyage:sof.fields.voyage,port:sof.fields.port,sof};
  assert.equal(validation.validateCall(call),null);
  for(const patch of [{vessel:'OTHER'},{voyage:'OTHER'},{port:'YOSU'}]){assert.equal(validation.sofMatchesCall(sof,{...call,...patch}),false);assert.match(validation.validateCall({...call,...patch}),/선박·항차·항만/);}
});
test('malformed highlights, report shapes, ETA values and nested rows are rejected',()=>{
  for(const patch of [{highlight:{}},{sof:{fields:'broken',groups:[{}],warnings:[]}},{etaRaw:'02/30'},{etaRaw:'09/01 2560'},{tasks:[{done:'true',text:'x',due:''}]},{activities:new Array(201).fill({})}])assert.ok(validation.validateCall({...calls[0],...patch}));
});
const request=(method='GET',body,query={})=>({method,body,query,headers:{host:'hyopu.example',origin:'https://hyopu.example','content-type':'application/json',cookie:'hyopu_session=test-token'}});
async function run(handler,req){const result={headers:{}};await handler(req,{setHeader(k,v){result.headers[k]=v;},status(n){result.status=n;return this;},json(body){result.body=body;return this;}});return result;}
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
async function withBackend(work,overrides={}){
  const original={fetch:global.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://backend.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='secret-test-key';
  const requests=[];let stored={id:calls[0].id,data:structuredClone(calls[0]),revision:1};
  global.fetch=async(url,options={})=>{
    requests.push({url,options});
    if(overrides.fetch)return overrides.fetch(url,options);
    if(url.endsWith('/auth/v1/user'))return response({id:'user-test',email:'member@example.invalid'},overrides.invalidToken?401:200);
    if(url.includes('/auth/v1/token'))return response({access_token:'secret-session-token',expires_in:3600});
    if(url.includes('/hyopu_members'))return response(overrides.nonMember?[]:[{user_id:'user-test',pic:'JACK',role:overrides.role||'editor'}]);
    if(options.method==='POST')return response(JSON.parse(options.body));
    if(options.method==='PATCH'){const expected=Number(new URL(url).searchParams.get('revision')?.slice(3));if(stored.revision!==expected)return response([]);stored={...JSON.parse(options.body)};return response([stored]);}
    return response([stored]);
  };
  try{await work({requests,getStored:()=>stored});}finally{global.fetch=original.fetch;for(const [key,value] of [['SUPABASE_URL',original.url],['SUPABASE_SERVICE_ROLE_KEY',original.key]])if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
test('missing backend is honest and never saves',()=>withBackend(async()=>{delete process.env.SUPABASE_URL;const status=await run(sessionHandler,request());assert.equal(status.body.configured,false);const save=await run(callsHandler,request('POST',{call:calls[0],revision:0}));assert.equal(save.status,503);assert.equal(save.body.saved,false);}));
test('shared workspace reads do not require a login session',()=>withBackend(async({requests})=>{const req=request();req.headers.cookie='';const result=await run(callsHandler,req);assert.equal(result.status,200);assert.equal(result.body.calls.length,42);assert.equal(requests.length,2);assert.ok(!requests.some(item=>item.url.includes('/auth/v1/user')));}));
test('shared saves skip auth and membership lookups while retaining server-side revision checks',()=>withBackend(async({requests,getStored})=>{
  const changed={...calls[0],notes:'Autosaved without sign-in'};
  const result=await run(callsHandler,request('PATCH',{call:changed,revision:1}));
  assert.equal(result.status,200);assert.equal(getStored().data.notes,'Autosaved without sign-in');
  assert.ok(!requests.some(item=>item.url.includes('/auth/v1/user')||item.url.includes('hyopu_members')));
}));
test('cross-origin and non-JSON writes never reach Supabase',()=>withBackend(async({requests})=>{
  const req=request('PATCH',{call:calls[0],revision:1});req.headers.origin='https://evil.invalid';assert.equal((await run(callsHandler,req)).status,403);
  req.headers.origin='https://hyopu.example';req.headers['content-type']='text/plain';assert.equal((await run(callsHandler,req)).status,403);assert.equal(requests.length,0);
}));
test('authenticated save is persisted and re-read; simultaneous stale edit gets 409',()=>withBackend(async({getStored})=>{
  const changed={...calls[0],notes:'QA persist',tasks:[{done:false,text:'Confirm berth',due:'2026-09-04'}]};
  const first=await run(callsHandler,request('PATCH',{call:changed,revision:1}));assert.equal(first.body.saved,true);assert.equal(getStored().revision,2);
  const stale=await run(callsHandler,request('PATCH',{call:{...changed,notes:'stale'},revision:1}));assert.equal(stale.status,409);assert.equal(getStored().data.notes,'QA persist');
  const reload=await run(callsHandler,request());assert.equal(reload.body.calls[0].notes,'QA persist');assert.equal(reload.headers['Cache-Control'],'no-store');assert.ok(!JSON.stringify(reload).includes('secret-test-key'));
}));
test('workspace readiness is shared and does not read membership records',()=>withBackend(async({requests})=>{
  const req=request();req.headers.cookie='';const result=await run(sessionHandler,req);assert.equal(result.body.ready,true);assert.equal(result.body.shared,true);assert.ok(!requests.some(item=>item.url.includes('hyopu_members')));
}));
test('workspace readiness requires the port-call schema',()=>withBackend(async()=>{
  const result=await run(sessionHandler,request());assert.equal(result.body.ready,false);
},{fetch:async()=>response([],404)}));
test('network ambiguity never falsely claims a failed commit',()=>withBackend(async()=>{
  const result=await run(callsHandler,request('PATCH',{call:calls[0],revision:1}));assert.equal(result.status,502);assert.equal(result.body.saved,null);assert.match(result.body.error,/결과를 확인하지/);
},{fetch:async()=>{throw new Error('response lost after commit');}}));
