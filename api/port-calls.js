const { json, backend, configured, sameOrigin } = require('../lib/workspace-auth');
const { validateCall } = require('../lib/call-validation');
const etaSeed = require('../eta-seed.json');

function defaultCalls() {
  return etaSeed.map((row, index) => ({
    id: `eta-2026-${String(index + 1).padStart(3, '0')}`,
    vessel: row.vessel,
    voyage: row.voyage,
    port: row.port,
    etaRaw: row.etaRaw,
    etdRaw: row.etdRaw,
    pic: row.pic,
    highlight: row.highlight || [],
    year: 2026,
    status: row.remark === 'INPORT' ? 'INPORT' : 'PRE-ARRIVAL',
    activities: [], activityNotes: '', cargo: [], crew: [], tasks: [], notes: '', proformaNotes: '',
    vcrFileName: '', latestReport: '', reportType: 'DEP.REPORT', reportReceived: '',
    reportChecked: false, sof: null,
  }));
}

async function seedMissingWorkspaceCalls(rows) {
  const present = new Set(rows.map(row => row.id));
  const missing = defaultCalls().filter(call => !present.has(call.id));
  if (!missing.length) return rows;
  const now = new Date().toISOString();
  const seed = await backend('/rest/v1/hyopu_port_calls?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(missing.map(data => ({ id: data.id, data, revision: 1, updated_at: now }))),
  });
  if (!seed.ok) throw new Error('기본 ETA 데이터를 저장하지 못했습니다.');
  return [...rows, ...await seed.json()];
}
module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (!['GET','POST','PATCH'].includes(req.method)) return json(res,405,{error:'Method not allowed'});
  try {
    if(!configured())return json(res,503,{configured:false,saved:false,error:'공유 저장 설정이 필요합니다.'});
    if(req.method!=='GET'&&!sameOrigin(req))return json(res,403,{error:'다른 사이트에서 보낸 저장 요청은 허용하지 않습니다.'});
    if(req.method==='GET') {
      const id=req.query?.id;
      if(id && !/^[a-zA-Z0-9-]{1,80}$/.test(id))return json(res,400,{error:'잘못된 식별자입니다.'});
      const result=await backend(`/rest/v1/hyopu_port_calls?select=id,data,revision,updated_at${id?`&id=eq.${encodeURIComponent(id)}`:'&order=id.asc&limit=1000'}`);
      if(!result.ok)return json(res,502,{error:'선박 목록을 불러오지 못했습니다.'});
      let rows=await result.json();
      if (!id) rows=await seedMissingWorkspaceCalls(rows);
      return json(res,200,{calls:rows.map(row=>({...row.data,id:row.id,revision:row.revision,updatedAt:row.updated_at}))});
    }
    const {call,revision}=req.body||{};
    const error=validateCall(call);if(error)return json(res,400,{saved:false,error});
    if(!Number.isInteger(revision)||revision<0)return json(res,400,{error:'저장 버전을 확인해 주세요.'});
    const data={};
    for(const key of ['id','vessel','voyage','port','etaRaw','etdRaw','pic','status','year','notes','activityNotes','proformaNotes','vcrFileName','latestReport','reportType','reportReceived','reportChecked','activities','cargo','crew','tasks','sof','highlight'])if(call[key]!==undefined)data[key]=call[key];
    const creating=req.method==='POST';
    if(creating && revision!==0)return json(res,400,{error:'신규 기록 버전이 올바르지 않습니다.'});
    const result=await backend(`/rest/v1/hyopu_port_calls${creating?'':`?id=eq.${encodeURIComponent(call.id)}&revision=eq.${revision}`}`,{
      method:creating?'POST':'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({id:call.id,data,revision:revision+1,updated_at:new Date().toISOString()})
    });
    if(result.status===409)return json(res,409,{saved:false,error:'다른 담당자가 먼저 저장했습니다. 최신 내용을 확인한 뒤 다시 저장해 주세요.'});
    if(!result.ok)return json(res,502,{saved:false,error:'서버 저장에 실패했습니다. 입력 내용은 이 화면에 남아 있습니다.'});
    const row=(await result.json())[0];
    if(!row)return json(res,409,{saved:false,error:'다른 담당자가 수정했거나 기록이 변경되었습니다. 새로 불러온 뒤 다시 저장해 주세요.'});
    return json(res,creating?201:200,{saved:true,call:{...row.data,id:row.id,revision:row.revision,updatedAt:row.updated_at}});
  } catch { return json(res,502,{saved:null,error:'저장 결과를 확인하지 못했습니다. 초안을 백업하고 최신 기록을 확인한 뒤 다시 시도해 주세요.'}); }
};
