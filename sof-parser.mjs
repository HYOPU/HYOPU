// Report text is data, never instructions. No network or model is used to parse it.
export const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
export function normalizeReport(text) {
  return String(text ?? '').replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)))
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&(?:nbsp|amp|lt|gt|quot);/gi,x=>({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"'})[x.toLowerCase()])
    .replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/\\([_*~<>#-])/g,'$1')
    .replace(/[\u00A0\u2000-\u200A\u202F]/g,' ').replace(/\r\n?/g,'\n');
}
const clean = s => String(s??'').replace(/\s+/g,' ').trim();
const pad = n => String(n).padStart(2,'0');
export const displayTime = v => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v||'') ? `${v.slice(8,10)}/${v.slice(11,13)}${v.slice(14,16)}` : (v||'');
export const monthLabel = v => /^\d{4}-\d{2}/.test(v||'') ? `${v.slice(0,4)}, ${MONTHS[Number(v.slice(5,7))-1]}` : '';
function stamp(token, anchor, warnings, line) {
  const m=token?.match(/^(\d{1,2})\/(\d{4})$/);
  if(!m) return '';
  const day=+m[1], hh=+m[2].slice(0,2), mm=+m[2].slice(2);
  if(day<1||day>31||hh>23||mm>59) {warnings.push(`행 ${line}: 잘못된 날짜/시간 ${token}`);return '';}
  if(!anchor)return `${pad(day)}/${m[2]}`;
  const candidates=[-1,0,1].map(offset=>{
    const date=new Date(Date.UTC(anchor.year,anchor.month+offset,day,hh,mm));
    return date.getUTCDate()===day?date:null;
  }).filter(Boolean);
  const base=Date.UTC(anchor.year,anchor.month,anchor.day||day,12);
  candidates.sort((a,b)=>Math.abs(+a-base)-Math.abs(+b-base));
  return candidates[0]?.toISOString().slice(0,16)||'';
}
// Keep year/month provenance when a review field is edited as DD/HHMM.
export function resolveEditedTime(value, reference) {
  if(!/^\d{1,2}\/\d{4}$/.test(value||'')||!/^\d{4}-\d{2}-\d{2}/.test(reference||''))return value;
  return stamp(value,{year:+reference.slice(0,4),month:+reference.slice(5,7)-1,day:+reference.slice(8,10)},[],0)||value;
}
function parseBerth(text) {
  let name=clean(text.replace(/^.*?BERTHED AT\s+(?:\d+\.\s*)?/i,'').split(/\(MAX\s+DRAFT/i)[0]);
  if(/LAYBY BERTH/i.test(name))name=name.match(/\(([^()]+)\)/)?.[1]||name;
  return name;
}
const sheetName = value => value.replace(/#/g,'').replace(/[\\/?*\[\]:]/g,' ').trim().slice(0,31)||'SOF';
const number = value => {
  const amount=clean(value).replace(/,/g,'').replace(/\s*M\s*\/?\s*T$/i,'').trim();
  return amount ? Number(amount) : null;
};
export function parseReport(input) {
  const lines=normalizeReport(input).split('\n').map(clean).filter(Boolean);
  const warnings=[];
  const title=lines.find(x=>/\/\s*(?:DEP|ARR)\.?\s*REPORT/i.test(x));
  const parts=(title||'').split('/').map(clean);
  const fields={vessel:parts[0]||'',voyage:parts[1]||'',port:parts[2]||lines.find(x=>/^\([A-Z ]+\)$/.test(x))?.slice(1,-1)||'',charterer:''};
  if(!title)warnings.push('선명/항차 제목을 찾지 못했습니다. 직접 확인해 주세요.');
  let anchor=null, arrival='', recentPilot=null, currentCall=null, coaster=null, currentCargo=null, operation='';
  let nextId=1, lineUp=false, departed=false;
  const calls=[], cargos=[], events=[];
  const getStamp=(token,line)=>stamp(token,anchor,warnings,line);
  for(let i=0;i<lines.length;i++) {
    const line=lines[i], sourceLine=i+1;
    const month=line.match(/^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)['’\s,.-]+(20\d{2})$/i);
    if(month){anchor={year:+month[2],month:MONTHS.indexOf(month[1].toUpperCase()),day:1};continue;}
    // Personnel itineraries, vessel conditions and ETA are not port-call facts.
    if(/^(?:ARR\.?CONDITION|DEP\.?CONDITION|<(?:ACTIVITIES|CREW CHANGE|AGENT REQUEST|RESTRICTION|TECHNICIAN|ENGINEER)>)/i.test(line))break;
    if(departed)continue;
    if(/^\*?LINE UP AT /i.test(line)){lineUp=true;events.push({text:line,sourceLine,callId:currentCall?.id,coaster:null,lineUp:true});continue;}
    const co=line.match(/^(?:SBTS|SBTD|PORT|STBD)\s+SIDE.*?COASTER\s+['"]([^'"]+)['"](.*)$/i);
    if(co){coaster={name:co[1],details:clean(co[2]),sourceLine};currentCargo=null;lineUp=false;continue;}
    const op=line.match(/^\((LOAD|DISCH)\)/i);
    if(op)operation=op[1].toUpperCase();
    const cargoMatch=line.replace(/^\((?:LOAD|DISCH)\)\s*/i,'').match(/^(?:CGO)?#(\d+[A-Z]?)\s+(.+)$/i);
    if(cargoMatch){
      const rest=cargoMatch[2];
      const timeMatches=[...rest.matchAll(/\b\d{1,2}\/\d{4}\b/g)];
      let name='',tank='',plannedQuantity=null,times=[],bl=null,ship=null,details='';
      if(timeMatches.length>=4){
        name=clean(rest.slice(0,timeMatches[0].index).replace(/\/\s*$/,''));
        times=timeMatches.slice(0,4).map(x=>getStamp(x[0],sourceLine));
        let tail=rest.slice(timeMatches[3].index+timeMatches[3][0].length).trim();
        const figures=[];
        for(let match;figures.length<2&&(match=tail.match(/^(\d[\d,]*(?:\.\d+)?)(?:\s*M\s*\/?\s*T)?(?=\s|$)/i));){
          figures.push(number(match[1]));tail=tail.slice(match[0].length).trim();
        }
        [bl,ship]=figures; tank=tail.replace(/\s+/g,'');
      }else{
        const detail=rest.match(/^(.*?)\s*\/\s*([\d,.]+)\s*M\s*\/?\s*T\s*\(([^)]*)\)(.*)$/i);
        if(!detail){warnings.push(`행 ${sourceLine}: 화물 #${cargoMatch[1]} 형식을 확인해 주세요.`);continue;}
        [,name,,tank,details]=detail;plannedQuantity=number(detail[2]);
        // Discharge report headers state B/L quantity. SHIP FIG is a separate
        // measurement and must remain empty unless the report supplies it.
        if(operation==='DISCH')bl=plannedQuantity;
      }
      currentCargo={id:`cargo-${nextId++}`,number:cargoMatch[1],name:clean(name),operation:operation||'LOAD',tank,party:'',line:'',plannedQuantity,
        hoseOn:times[0]||'',commenced:times[1]||'',completed:times[2]||'',hoseOff:times[3]||'',bl:bl??null,ship:ship??null,
        details:clean(details),callId:currentCall?.id||null,coaster:coaster?{...coaster}:null,sourceLine};
      cargos.push(currentCargo);if(!currentCall)warnings.push(`행 ${sourceLine}: 화물 #${currentCargo.number}의 접안 장소가 없습니다.`);continue;
    }
    if(currentCargo&&/^H\/ON\b/i.test(line)){
      for(const m of line.matchAll(/\b(H\/ON|COMM|COMP|H\/OFF)\s+(\d{1,2}\/\d{4})/gi)) currentCargo[({'H/ON':'hoseOn',COMM:'commenced',COMP:'completed','H/OFF':'hoseOff'})[m[1].toUpperCase()]]=getStamp(m[2],sourceLine);
      continue;
    }
    const fig=line.match(/^\*?\s*(B\s*\/\s*L\s+FIG|SHIP\s+FIG|STOWAGE|STOWGAE)(?:\s*\(?\s*M\s*\/?\s*T\s*\)?)?\s*[:：]\s*(.+)$/i);
    if(fig&&currentCargo){const key=fig[1].replace(/\s+/g,'').toUpperCase();if(key.startsWith('B/'))currentCargo.bl=number(fig[2]);else if(key.startsWith('SHIP'))currentCargo.ship=number(fig[2]);else currentCargo.tank=clean(fig[2]);continue;}
    let m=line.match(/^\*?(\d{1,2}\/\d{4})(?:\s*[~～–]\s*(\d{1,2}\/\d{4}))?\s*:\s*(.+)$/);
    const inherited=line.match(/^(\d{4})\s*:\s*(.+)$/);
    if(!m&&inherited&&anchor)m=[line,`${pad(anchor.day)}/${inherited[1]}`,undefined,inherited[2]];
    if(m){
      const text=m[3];
      const navigation=!line.startsWith('*')&&!m[2]&&/EOSP|\bPOB\b|BERTHED AT|LEFT FM|SAILED FM|COMMENCE(?:D)? DR[I F]+TING|PROCEED TO|PILOT LEFT|GRANTED FREE PRATIQUE|NOR TENDERED/i.test(text);
      if(navigation&&anchor){
        const day=+m[1].split('/')[0];
        if(anchor.day-day>15){anchor.month++;if(anchor.month===12){anchor.month=0;anchor.year++;}}
        anchor.day=day;lineUp=false;
      }
      const event={at:getStamp(m[1],sourceLine),end:m[2]?getStamp(m[2],sourceLine):'',text,sourceLine,callId:currentCall?.id||null,coaster:coaster?.name||null,lineUp};
      if(/\bEOSP\b|COMPLETED DRIFTING/i.test(text))arrival=event.at;
      if(/PILOT LEFT/i.test(text))recentPilot=null;
      if(/\bPOB\b/i.test(text))recentPilot=event;
      if(/LEFT FM/i.test(text)&&currentCall){currentCall.pilotOut=recentPilot?.at||'';currentCall.leftBerth=event.at;}
      if(/BERTHED AT/i.test(text)){
        currentCall={id:`call-${nextId++}`,berth:parseBerth(text),berthAt:event.at,arrival,pilotIn:recentPilot?.at||'',pilotOut:'',leftBerth:'',sourceLine};
        calls.push(currentCall);event.callId=currentCall.id;coaster=null;currentCargo=null;event.coaster=null;
      }
      if(/PROCEED TO.*H\/SEA/i.test(text)){currentCall=null;coaster=null;currentCargo=null;}
      events.push(event);
      if(/SAILED FM/i.test(text))departed=true;
      continue;
    }
    if(/^&\s*/.test(line)&&events.length){events.at(-1).text+=' '+line;continue;}
    if(line.startsWith('*')&&!/^\*[-=]+$/.test(line))events.push({text:line,sourceLine,callId:currentCall?.id||null,coaster:coaster?.name||null,lineUp});
  }
  if(!anchor)warnings.push('리포트의 월/연도가 없습니다. 날짜를 확인해 주세요.');
  const groups=[];
  for(const cargo of cargos){
    const key=`${cargo.callId}|${cargo.coaster?.name||''}|${cargo.operation}`;
    let group=groups.find(x=>x.id===key);
    if(!group){const call=calls.find(x=>x.id===cargo.callId)||{};group={...call,id:key,callId:cargo.callId,operation:cargo.operation,coaster:cargo.coaster,
      sheetName:sheetName(cargo.coaster?.name||call.berth||'SOF'),cargo:[],remarks:[],norTendered:'',norAccepted:'',tanksInspected:'',tanksAccepted:'',cargoCalculationStart:'',cargoCalculationEnd:'',papersOnBoard:''};groups.push(group);}
    group.cargo.push(cargo);
  }
  const cargoIdsIn = text => [...text.matchAll(/(?:CGO\s*)?#(\d+)(?:\/(\d+))*(?:&#?(\d+))?/gi)].flatMap(m=>m[0].match(/\d+/g)||[]);
  const namedCargo = text => /(?:FOR\s+CGO|FOR\s*#|CGO#)/i.test(text)?cargoIdsIn(text):[];
  for(const event of events){
    const ids=namedCargo(event.text);
    let targets=ids.length?groups.filter(g=>g.cargo.some(c=>ids.includes(c.number))):[];
    if(!targets.length&&/AWAITED|AWAITING/i.test(event.text)) {
      const namedCoaster=groups.filter(g=>g.coaster&&event.text.includes(`'${g.coaster.name}'`));
      const namedBerth=groups.filter(g=>g.berth&&event.text.includes(g.berth));
      targets=namedCoaster.length?namedCoaster:namedBerth;
    }
    if(!targets.length&&event.lineUp)targets=[groups.find(g=>g.sourceLine>event.sourceLine)].filter(Boolean);
    if(!targets.length) targets=groups.filter(g=>g.callId===event.callId&&(!event.coaster||g.coaster?.name===event.coaster));
    if(!targets.length&&/FREE PRATIQUE/i.test(event.text))targets=[groups.find(g=>g.sourceLine>event.sourceLine)||groups[0]].filter(Boolean);
    if(!targets.length&&groups.length&&!event.callId)targets=[groups[0]];
    // The vessel's initial NOR can be at an anchorage/layby before its first cargo berth.
    if(/NOR TENDERED/i.test(event.text)&&event.at){
      const explicit=groups.filter(g=>g.callId===event.callId);
      const norGroups=explicit.length?[explicit[0]]:[groups[0]].filter(Boolean);
      for(const g of norGroups)g.norTendered=event.at;
    }
    for(const g of targets){
      if(/NOR ACCEPTED/i.test(event.text)&&event.at)g.norAccepted=event.at;
      const important=/TANK INSPECTION|SAMPLE ANALYSIS|AWAIT|N2 |FREE PRATIQUE|FSMC INSPECTION|PILOT.*(?:SUSPEND|LEFT)|ENGINE SYSTEM|CANCEL CHARGE|HOSE FOR T\/S|COASTER PROVIDED|T\/S UNDER|LINE UP AT/i.test(event.text)||event.lineUp;
      if(important)g.remarks.push(`${event.at?displayTime(event.at)+(event.end?'~'+displayTime(event.end):'')+' : ':''}${event.text}`);
      if(/TANK INSPECTION/i.test(event.text)){(g.inspections??=[]).push(event);}
    }
  }
  for(const g of groups){
    const inspections=g.inspections||[];
    if(inspections.length===1){g.tanksInspected=inspections[0].at||'';g.tanksAccepted=/PASSED/i.test(inspections[0].text)?inspections[0].end||inspections[0].at||'':'';}
    else if(inspections.length>1){g.tanksInspected='SEE REMARK';g.tanksAccepted='SEE REMARK';}
    else if(g.cargo.every(c=>/\bATIP\b/i.test(c.details))){g.tanksInspected='ATIP';g.tanksAccepted='ATIP';}
    const missing=[];
    if(!g.norTendered)missing.push('NOR TENDERED');
    if(!g.norAccepted)missing.push('NOR ACCEPTED');
    if(missing.length){g.remarks.push(`REVIEW REQUIRED: ${missing.join(' / ')} not stated in source report.`);warnings.push(`${g.sheetName}: ${missing.join(' / ')} 확인 필요 (원문 미기재)`);}
    if(g.coaster)g.remarks.unshift(`CGO#${g.cargo.map(c=>c.number).join('/')} ${g.operation==='LOAD'?'LOADED FROM':'DISCHARGED TO'} COASTER '${g.coaster.name}'${g.coaster.details}`);
    for(const c of g.cargo){
      if(c.bl===null) {g.remarks.push(`CGO#${c.number}: B/L FIG not stated${c.plannedQuantity!==null?`; nominated quantity ${c.plannedQuantity.toLocaleString('en-US')} MT`:''}.`);warnings.push(`${g.sheetName} CGO#${c.number}: B/L FIG 확인 필요`);}
      for(const field of ['hoseOn','commenced','completed','hoseOff'])if(!c[field])warnings.push(`${g.sheetName} CGO#${c.number}: ${field} 확인 필요`);
    }
    g.remarks=[...new Set(g.remarks)];
  }
  if(!groups.length)warnings.push('작업 시트를 만들 화물을 찾지 못했습니다. 입력 형식을 확인해 주세요.');
  return {fields,groups,cargo:cargos,events,warnings:[...new Set(warnings)]};
}
