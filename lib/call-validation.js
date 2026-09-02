const plain = value => Boolean(value && typeof value==='object' && !Array.isArray(value));
const strings = value => Array.isArray(value) && value.length<=1000 && value.every(item=>typeof item==='string');
function validSof(report) {
  if(!plain(report)||!plain(report.fields)||!['vessel','voyage','port','charterer'].every(key=>typeof report.fields[key]==='string')||!strings(report.warnings)||!Array.isArray(report.groups)||report.groups.length>100)return false;
  const validCargo=cargo=>plain(cargo)&&['number','name','tank','hoseOn','commenced','completed','hoseOff'].every(key=>typeof cargo[key]==='string')&&['bl','ship'].every(key=>cargo[key]===null||typeof cargo[key]==='number'&&Number.isFinite(cargo[key]));
  const validTimes=item=>Object.entries(item).every(([key,value])=>!['arrival','pilotIn','berthAt','pilotOut','leftBerth','norTendered','norAccepted','tanksInspected','tanksAccepted','cargoCalculationStart','cargoCalculationEnd','papersOnBoard','reportedNorTendered'].includes(key)||typeof value==='string');
  if(!report.groups.every(group=>plain(group)&&['sheetName','operation','berth'].every(key=>typeof group[key]==='string')&&strings(group.remarks)&&(!group.norRemarks||strings(group.norRemarks))&&validTimes(group)&&Array.isArray(group.cargo)&&group.cargo.length<=500&&group.cargo.every(validCargo)))return false;
  if(report.calls!==undefined&&(!Array.isArray(report.calls)||!report.calls.every(call=>plain(call)&&typeof call.id==='string'&&typeof call.berth==='string'&&validTimes(call))))return false;
  if(report.norWarnings!==undefined&&!strings(report.norWarnings))return false;
  return true;
}
function validateCall(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '선박 정보가 필요합니다.';
  if (JSON.stringify(data).length>450000) return '선박 기록은 450KB 이하로 저장해 주세요.';
  if (typeof data.id!=='string' || !/^[a-zA-Z0-9-]{1,80}$/.test(data.id)) return '잘못된 입항 식별자입니다.';
  for (const field of ['vessel','voyage','port','etaRaw','etdRaw','pic','status','notes','latestReport','reportType','reportReceived']) {
    if (typeof data[field]!=='string' || data[field].length>(['notes','latestReport'].includes(field)?50000:200)) return `${field} 항목을 확인해 주세요.`;
  }
  if (!data.vessel.trim() || !data.voyage.trim() || !data.etaRaw.trim()) return '선박명·항차·ETA는 필수입니다.';
  if (!['ULSAN',"P'TAEK",'YOSU','DAESAN','DONGHAE'].includes(data.port)) return '항만을 확인해 주세요.';
  if (!['','DENNIS','JAE LEE','JACK','RICK'].includes(data.pic)) return '담당자를 확인해 주세요.';
  if (!['INPORT','PRE-ARRIVAL','DEPARTED'].includes(data.status)) return '입항 상태를 확인해 주세요.';
  if (!Number.isInteger(data.year) || data.year<2000 || data.year>2100) return '기준 연도를 확인해 주세요.';
  for (const key of ['etaRaw','etdRaw']) {
    if (!data[key] && key==='etdRaw') continue;
    const m=data[key].match(/^(\d{2})\/(\d{2})(?:\s+(\d{4}|AM|PM))?(\?\?)?$/i);
    if (!m) return 'ETA/ETD 형식: MM/DD, MM/DD HHmm, AM/PM 또는 ??';
    const date=new Date(Date.UTC(data.year,Number(m[1])-1,Number(m[2])));
    if (date.getUTCMonth()!==Number(m[1])-1 || date.getUTCDate()!==Number(m[2]) || (/^\d/.test(m[3]||'')&&(Number(m[3].slice(0,2))>23||Number(m[3].slice(2))>59))) return 'ETA/ETD 날짜나 시간이 올바르지 않습니다.';
  }
  const schemas={activities:['done','time','activity','company','note'],cargo:['operation','number','name','bl','ship','tanks','party','note'],crew:['kind','name','schedule','status','note'],tasks:['done','text','due']};
  for (const [key,fields] of Object.entries(schemas)) {
    if (!Array.isArray(data[key]) || data[key].length>200) return `${key} 항목은 최대 200개입니다.`;
    for (const row of data[key]) { if (!row || typeof row!=='object' || Array.isArray(row)) return `${key} 행이 올바르지 않습니다.`; for (const field of fields) { if (field==='done' ? typeof row[field]!=='boolean' : typeof row[field]!=='string'||row[field].length>10000) return `${key}.${field} 값을 확인해 주세요.`; } }
  }
  if (typeof data.reportChecked!=='boolean') return '리포트 확인 상태가 올바르지 않습니다.';
  if (data.highlight!==undefined && (!Array.isArray(data.highlight)||!data.highlight.every(field=>['vessel','port'].includes(field)))) return '강조 표시가 올바르지 않습니다.';
  if (data.sof!==null && !validSof(data.sof)) return 'SOF 분석 데이터가 올바르지 않습니다.';
  return null;
}
module.exports={validateCall,validSof};
