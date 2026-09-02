import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { displayTime, monthLabel } from './sof-parser.mjs';
const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG='http://schemas.openxmlformats.org/package/2006/relationships';
const TYPE='http://schemas.openxmlformats.org/package/2006/content-types';
const elements=(node,name)=>Array.from(node.getElementsByTagNameNS('*',name));
function setCell(doc,address,value) {
  const data=elements(doc,'sheetData')[0];
  const rowNo=Number(address.match(/\d+$/)[0]);
  let row=elements(data,'row').find(x=>Number(x.getAttribute('r'))===rowNo);
  if(!row){row=doc.createElementNS(NS,'row');row.setAttribute('r',rowNo);data.insertBefore(row,elements(data,'row').find(x=>Number(x.getAttribute('r'))>rowNo)||null);}
  let cell=elements(row,'c').find(x=>x.getAttribute('r')===address);
  if(!cell){cell=doc.createElementNS(NS,'c');cell.setAttribute('r',address);const colIndex=a=>a.replace(/\d/g,'').split('').reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);row.insertBefore(cell,elements(row,'c').find(x=>colIndex(x.getAttribute('r'))>colIndex(address))||null);}
  while(cell.firstChild)cell.removeChild(cell.firstChild);
  if(value===null||value===undefined||value===''){cell.removeAttribute('t');return;}
  if(typeof value==='number'&&Number.isFinite(value)){cell.setAttribute('t','n');const v=doc.createElementNS(NS,'v');v.textContent=String(value);cell.appendChild(v);}
  else{cell.setAttribute('t','inlineStr');const is=doc.createElementNS(NS,'is'),t=doc.createElementNS(NS,'t');t.setAttribute('xml:space','preserve');t.textContent=String(value);is.appendChild(t);cell.appendChild(is);}
}
function dateSerial(iso){return /^\d{4}-\d{2}-\d{2}/.test(iso||'')?(Date.parse(iso.slice(0,10)+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000:null;}
function uniqueName(name,used){const base=(name||'SOF').replace(/[\\/?*\[\]:]/g,' ').slice(0,31);let value=base,n=2;while(used.has(value.toLowerCase())){const suffix=` (${n++})`;value=base.slice(0,31-suffix.length)+suffix;}used.add(value.toLowerCase());return value;}
// Only values are changed in the clean template. Original signed workbooks are
// never shipped or reused: the built-in template has empty signature lines.
export function exportSof(templateBytes,report,xml={DOMParser,XMLSerializer}) {
  if(!report.groups.length)throw new Error('내보낼 화물이 없습니다.');
  if(report.groups.some(g=>g.cargo.some(c=>['bl','ship'].some(k=>c[k]!==null&&!Number.isFinite(c[k])))))throw new Error('B/L 또는 SHIP 수량은 숫자로 입력해 주세요.');
  const files=unzipSync(new Uint8Array(templateBytes));
  const parse=value=>new xml.DOMParser().parseFromString(value,'application/xml');
  const serialize=doc=>strToU8(new xml.XMLSerializer().serializeToString(doc));
  const master=strFromU8(files['xl/worksheets/sheet1.xml']);
  const wb=parse(strFromU8(files['xl/workbook.xml']));
  const sheets=elements(wb,'sheets')[0];while(sheets.firstChild)sheets.removeChild(sheets.firstChild);
  const names=elements(wb,'definedNames')[0];if(names)names.parentNode.removeChild(names);
  const defined=wb.createElementNS(NS,'definedNames');
  const calc=elements(wb,'calcPr')[0];wb.documentElement.insertBefore(defined,calc||null);
  const rels=parse(strFromU8(files['xl/_rels/workbook.xml.rels']));
  for(const rel of elements(rels,'Relationship'))if(/\/(?:worksheet|calcChain)$/.test(rel.getAttribute('Type')))rel.parentNode.removeChild(rel);
  const types=parse(strFromU8(files['[Content_Types].xml']));
  for(const item of elements(types,'Override'))if(/\/worksheets\/|calcChain/.test(item.getAttribute('PartName')))item.parentNode.removeChild(item);
  for(const key of Object.keys(files))if(/^xl\/worksheets\//.test(key)||/calcChain/.test(key))delete files[key];
  const used=new Set();let count=0;
  for(const group of report.groups){
    // More than five cargoes or fourteen remarks continue on another sheet;
    // never silently truncate a report to fit the reference form.
    const longTanks=group.cargo.filter(c=>c.tank.length>32).map(c=>`CGO#${c.number} STOWAGE: ${c.tank}`);
    const remarks=[...group.remarks,...longTanks];
    const pages=Math.max(1,Math.ceil(group.cargo.length/5),Math.ceil(remarks.length/14));
    for(let page=0;page<pages;page++){
      const doc=parse(master),name=uniqueName(group.sheetName+(page?` cont ${page+1}`:''),used);
      count++;
      const values={B6:/^M\/T\s/i.test(report.fields.vessel)?report.fields.vessel:`M/T ${report.fields.vessel}`,G6:report.fields.voyage,C7:`ING : ${report.fields.port}${report.fields.port==='ULSAN'?', KOREA':''}`,B7:group.operation,D8:report.fields.charterer,
        N6:dateSerial(group.leftBerth||group.berthAt)??group.sheetDate??null,A12:monthLabel(group.arrival)||group.arrivalMonth||'',A13:monthLabel(group.pilotIn)!==monthLabel(group.arrival)?monthLabel(group.pilotIn):group.pilotMonth||'',
        B12:displayTime(group.arrival),B13:displayTime(group.pilotIn),B14:displayTime(group.berthAt),G14:group.berth,
        B15:displayTime(group.norTendered)||'REVIEW',B16:displayTime(group.norAccepted)||'REVIEW',B17:displayTime(group.tanksInspected),B18:displayTime(group.tanksAccepted),
        G21:group.operation,I21:group.operation,B32:displayTime(group.cargoCalculationStart),B33:displayTime(group.cargoCalculationEnd),B34:displayTime(group.papersOnBoard),B35:displayTime(group.pilotOut),B36:displayTime(group.leftBerth)};
      const hasShip=group.cargo.some(c=>c.ship!==null);if(!hasShip){values.O20='';values.O21='';}
      group.cargo.slice(page*5,page*5+5).forEach((c,i)=>{const r=22+i*2;Object.assign(values,{[`A${r}`]:/^\d+$/.test(c.number)?Number(c.number):'#'+c.number,[`A${r+1}`]:c.name,[`B${r}`]:c.tank.length>32?'SEE REMARK':c.tank,[`F${r}`]:displayTime(c.hoseOn),[`G${r}`]:displayTime(c.commenced),[`I${r}`]:displayTime(c.completed),[`L${r}`]:displayTime(c.hoseOff),[`N${r}`]:c.bl,[`O${r}`]:c.ship});});
      remarks.slice(page*14,page*14+14).forEach((r,i)=>values[`B${38+i}`]=r);
      for(const [address,value]of Object.entries(values))setCell(doc,address,value);
      for(const item of elements(doc,'pageSetup'))item.parentNode.removeChild(item);
      const setup=doc.createElementNS(NS,'pageSetup');for(const [k,v]of Object.entries({paperSize:'9',orientation:'portrait',fitToWidth:'1',fitToHeight:'1'}))setup.setAttribute(k,v);
      const margins=elements(doc,'pageMargins')[0];if(margins){for(const k of ['left','right','top','bottom'])margins.setAttribute(k,'0.3');doc.documentElement.insertBefore(setup,margins.nextSibling);}else doc.documentElement.appendChild(setup);
      let pr=elements(doc,'sheetPr')[0];if(!pr){pr=doc.createElementNS(NS,'sheetPr');doc.documentElement.insertBefore(pr,doc.documentElement.firstChild);}
      const fit=doc.createElementNS(NS,'pageSetUpPr');fit.setAttribute('fitToPage','1');pr.appendChild(fit);
      files[`xl/worksheets/sheet${count}.xml`]=serialize(doc);
      const sheet=wb.createElementNS(NS,'sheet');sheet.setAttribute('name',name);sheet.setAttribute('sheetId',String(count));sheet.setAttributeNS(REL,'r:id',`sofSheet${count}`);sheets.appendChild(sheet);
      const area=wb.createElementNS(NS,'definedName');area.setAttribute('name','_xlnm.Print_Area');area.setAttribute('localSheetId',String(count-1));area.textContent=`'${name.replaceAll("'","''")}'!$A$1:$P$58`;defined.appendChild(area);
      const rel=rels.createElementNS(PKG,'Relationship');rel.setAttribute('Id',`sofSheet${count}`);rel.setAttribute('Type',REL+'/worksheet');rel.setAttribute('Target',`worksheets/sheet${count}.xml`);rels.documentElement.appendChild(rel);
      const type=types.createElementNS(TYPE,'Override');type.setAttribute('PartName',`/xl/worksheets/sheet${count}.xml`);type.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');types.documentElement.appendChild(type);
    }
  }
  files['xl/workbook.xml']=serialize(wb);files['xl/_rels/workbook.xml.rels']=serialize(rels);files['[Content_Types].xml']=serialize(types);
  // This template contains no macros, external links, source data, signatures or stamps.
  return zipSync(files,{level:6});
}
