import { utils } from 'xlsx';
import { parseReport, resolveEditedTime, MONTHS } from './sof-parser.mjs';
const text=v=>String(v??'').trim();
// Preserve column positions and read every worksheet, including later berths.
export function importWorkbook(workbook) {
  const result={fields:{vessel:'',voyage:'',port:'',charterer:''},groups:[],warnings:[]};
  const reportLines=[];
  for(const name of workbook.SheetNames){
    const rows=utils.sheet_to_json(workbook.Sheets[name],{header:1,defval:'',raw:true});
    if(!/VESSEL/i.test(text(rows[5]?.[0]))||!/^CGO/i.test(text(rows[19]?.[0]))){reportLines.push(...rows.map(r=>r.map(text).join(' ')));continue;}
    const get=(r,c)=>text(rows[r-1]?.[c-1]);
    if(!result.fields.vessel)result.fields={vessel:get(6,2).replace(/^M\/T\s*/i,''),voyage:get(6,7),port:get(7,3).replace(/^ING\s*:\s*/i,'').replace(/,\s*KOREA/i,''),charterer:get(8,4)};
    const group={id:`sheet-${name}`,sheetName:name,berth:get(14,7),operation:get(7,2)||'LOAD',arrival:get(12,2),pilotIn:get(13,2),berthAt:get(14,2),norTendered:get(15,2),norAccepted:get(16,2),tanksInspected:get(17,2),tanksAccepted:get(18,2),cargo:[],remarks:[]};
    group.sheetDate=typeof rows[5]?.[13]==='number'?rows[5][13]:null;
    group.arrivalMonth=get(12,1);group.pilotMonth=get(13,1);
    const serialDate=group.sheetDate===null?'':new Date(Date.UTC(1899,11,30)+group.sheetDate*86400000).toISOString().slice(0,16);
    for(let i=21;i<rows.length;i++){
      const row=rows[i];
      if(/^#?\d+[A-Z]?$/.test(text(row[0])))group.cargo.push({number:text(row[0]).replace('#',''),name:text(rows[i+1]?.[0]),tank:text(row[1]),hoseOn:text(row[5]),commenced:text(row[6]),completed:text(row[8]),hoseOff:text(row[11]),bl:typeof row[13]==='number'?row[13]:null,ship:typeof row[14]==='number'?row[14]:null,operation:group.operation});
      const label=text(row[5]);
      if(/START CARGO CALCULATION/.test(label))group.cargoCalculationStart=text(row[1]);
      if(/COMPLETED CARGO CALCULATION/.test(label))group.cargoCalculationEnd=text(row[1]);
      if(/CARGO PAPERS ON BOARD/.test(label))group.papersOnBoard=text(row[1]);
      if(/^PILOT ON BOARD/.test(label))group.pilotOut=text(row[1]);
      if(/^LEFT FM BERTH/.test(label))group.leftBerth=text(row[1]);
    }
    const remarkRow=rows.findIndex(r=>/REMARK/.test(text(r[0])));
    if(remarkRow>=0)for(let i=remarkRow;i<rows.length;i++){if(/SHORE REPRESENTATIVE/.test(text(rows[i][0])))break;const remark=text(rows[i][1]);if(remark)group.remarks.push(remark);}
    // Overflow remarks can have their own printed sheet without cargo rows.
    // Retain that sheet by its actual name; never infer shared berth identity
    // from a "cont" suffix or drop its remarks on upload/download round trips.
    if(group.cargo.length||group.remarks.length)result.groups.push(group);
    for(const key of ['arrival','pilotIn','berthAt','norTendered','norAccepted','tanksInspected','tanksAccepted','pilotOut','leftBerth','cargoCalculationStart','cargoCalculationEnd','papersOnBoard']){
      const label=key==='arrival'?group.arrivalMonth:key==='pilotIn'?group.pilotMonth:'';
      const m=label.match(/(20\d{2}),?\s*(\w{3})/);
      const reference=m&&MONTHS.includes(m[2])?`${m[1]}-${String(MONTHS.indexOf(m[2])+1).padStart(2,'0')}-${group[key]?.slice(0,2)||'01'}T00:00`:serialDate;
      group[key]=resolveEditedTime(group[key],reference);
    }
    for(const c of group.cargo)for(const key of ['hoseOn','commenced','completed','hoseOff'])c[key]=resolveEditedTime(c[key],group.berthAt||serialDate);
  }
  if(!result.groups.length)return parseReport(reportLines.join('\n'));
  result.warnings.push('기존 Time Sheet에서 읽은 값입니다. 새 리포트와 일치하는지 확인해 주세요. 기존 서명·도장은 복제하지 않습니다.');
  result.cargo=result.groups.flatMap(g=>g.cargo);return result;
}
