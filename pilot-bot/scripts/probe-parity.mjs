// Live read-only account-specific verification. This harness blocks both write URLs.
import {UlsanReadClient} from '../supabase/functions/ulsan-pilot-watcher/lib/hyopuSource.ts';
import {PilotRegistrationClient} from '../supabase/functions/_shared/pilot-registration/client.ts';
import {fetchForecast} from '../supabase/functions/ulsan-pilot-watcher/lib/source.ts';
let input='';if(process.stdin.isTTY)process.stdin.setRawMode(true);
for await(const chunk of process.stdin){input+=chunk;if(/[\r\n]/.test(input))break;}
if(process.stdin.isTTY)process.stdin.setRawMode(false);
const cfg=JSON.parse(input);input='';
let writeAttempts=0;const trace=[];
const readFetch=async(url,init)=>{
 const u=new URL(url);
 if(u.hostname!=='www.ulsanpilot.co.kr'||/_ok\.php$/.test(u.pathname)||/delete|cancel|logout/i.test(u.pathname)) {writeAttempts++;throw Error('PROBE_WRITE_FORBIDDEN');}
 const r=await fetch(url,init);trace.push({path:u.pathname,method:init?.method??'GET',status:r.status});return r;
};
try{
 const reader=new UlsanReadClient(cfg,readFetch,[],cfg.transport);
 const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 const start=new Date(Date.now()+9*3600000-29*86400000).toISOString().slice(0,10);
 const rows=await reader.authenticatedApplications({start,end:'9999-12-31'});
 const publicData=await fetchForecast(readFetch);
 const client=new PilotRegistrationClient({...cfg,createEnabled:false,updateEnabled:false,copyEnabled:false},readFetch,reader.cookies);
 const form=await client.form('CREATE');
 const active=rows.filter(r=>r.completion_status==='ACTIVE');
 const sample=active.find(r=>r.application_id&&r.pilot_date>=today);
 const detail=sample?await client.form('UPDATE',sample.application_id,sample.pilot_date):null;
 const companies=await client.search('shipcompany','협운');
 const billing=await client.search('billing','협운');
 console.log(JSON.stringify({ok:true,observedAt:new Date().toISOString(),range:{start,end:'9999-12-31'},total:rows.length,active:active.length,statusCounts:rows.reduce((a,r)=>(a[r.raw_application_status]=(a[r.raw_application_status]??0)+1,a),{}),
  activeRows:active.map(r=>({id:r.application_id,vessel:r.vessel_name,agency:r.agent,status:r.application_status,date:r.pilot_date,time:r.pilot_time,from:r.from_location,to:r.to_location,mooring:r.mooring_name})),
  forecast:{total:publicData.rows.length,hyopu:publicData.rows.filter(r=>r.agent==='협운').map(r=>({vessel:r.vessel_name,date:r.pilot_date,time:r.pilot_time,from:r.from_location,to:r.to_location,status:r.status,cancelled:r.cancelled}))},
  create:{fields:Object.keys(form.fields),hiddenNames:form.hidden,movements:form.options.fg_inoutport},
  update:detail?{id:detail.fields.no_forecast,agency:detail.fields.ln_partner,agencyCode:detail.fields.cd_partner,state:detail.fields.fg_status,fields:Object.keys(detail.fields)}:null,
  companies,billing,writeAttempts,trace}));
}catch(e){console.log(JSON.stringify({ok:false,error:/^[A-Z_0-9]+$/.test(e.message)?e.message:'PROBE_FAILED',writeAttempts,trace}));process.exitCode=1;}
