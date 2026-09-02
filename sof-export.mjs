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
  if(!cell){cell=doc.createElementNS(NS,'c');cell.setAttribute('r',address);const colIndex=a=>a.replace(/\d/g,'').split('').reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);const source=elements(row,'c').find(x=>x.hasAttribute('s'));if(source)cell.setAttribute('s',source.getAttribute('s'));row.insertBefore(cell,elements(row,'c').find(x=>colIndex(x.getAttribute('r'))>colIndex(address))||null);}
  while(cell.firstChild)cell.removeChild(cell.firstChild);
  if(value===null||value===undefined||value===''){cell.removeAttribute('t');return;}
  if(typeof value==='number'&&Number.isFinite(value)){cell.setAttribute('t','n');const v=doc.createElementNS(NS,'v');v.textContent=String(value);cell.appendChild(v);}
  else{cell.setAttribute('t','inlineStr');const is=doc.createElementNS(NS,'is'),t=doc.createElementNS(NS,'t');t.setAttribute('xml:space','preserve');t.textContent=String(value);is.appendChild(t);cell.appendChild(is);}
}
function dateSerial(iso){const value=/^\d{4}-\d{2}-\d{2}/.test(iso||'')?(Date.parse(iso.slice(0,10)+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000:null;return Number.isFinite(value)?value:null;}
function sheetDate(group){const dates=group.cargo.map(c=>dateSerial(c.hoseOff)).filter(x=>x!==null);return dates.length?Math.max(...dates):group.sheetDate??null;}
function uniqueName(name,used){const base=(name||'SOF').replace(/[\\/?*\[\]:]/g,' ').slice(0,31);let value=base,n=2;while(used.has(value.toLowerCase())){const suffix=` (${n++})`;value=base.slice(0,31-suffix.length)+suffix;}used.add(value.toLowerCase());return value;}
function resolvePart(source,target){const out=[];for(const item of (target.startsWith('/')?target.slice(1):source.slice(0,source.lastIndexOf('/')+1)+target).split('/')){if(item==='..')out.pop();else if(item&&item!=='.')out.push(item);}return out.join('/');}
function relsPart(part){const slash=part.lastIndexOf('/');return `${part.slice(0,slash)}/_rels/${part.slice(slash+1)}.rels`;}
function addContentType(doc,partName,contentType){if(elements(doc,'Override').some(x=>x.getAttribute('PartName')===partName))return;const type=doc.createElementNS(TYPE,'Override');type.setAttribute('PartName',partName);type.setAttribute('ContentType',contentType);doc.documentElement.appendChild(type);}
function clearReportSlots(doc){for(const cell of elements(doc,'c')){const address=cell.getAttribute('r'),row=Number(address.match(/\d+$/)?.[0]),col=address.replace(/\d/g,'').split('').reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);if((row>=22&&row<=31&&col<=16)||(row>=38&&row<=57&&col>=2&&col<=16)){while(cell.firstChild)cell.removeChild(cell.firstChild);cell.removeAttribute('t');}}}
function remarkLines(remarks){const out=[];for(const remark of remarks)for(let line of String(remark??'').split(/\r?\n/)){while(line.length>140){let end=line.lastIndexOf(' ',140);if(end<70)end=140;out.push(line.slice(0,end));line=line.slice(end).replace(/^ /,'');}out.push(line);}return out;}
// Only values are changed in the sanitized reference template. Preserve the
// company letterhead/logo, native styles, dimensions, merges and print setup.
// Signed uploaded workbooks are never used as templates: signatures and seals
// are excluded from the built-in asset, independently of the company logo.
export function exportSof(templateBytes,report,xml={DOMParser,XMLSerializer}) {
  if(!report.groups.length)throw new Error('내보낼 화물이 없습니다.');
  if(report.groups.some(g=>g.cargo.some(c=>['bl','ship'].some(k=>c[k]!=null&&!Number.isFinite(c[k])))))throw new Error('B/L 또는 SHIP 수량은 숫자로 입력해 주세요.');
  const files=unzipSync(new Uint8Array(templateBytes));
  const parse=value=>new xml.DOMParser().parseFromString(value,'application/xml');
  const serialize=doc=>strToU8(new xml.XMLSerializer().serializeToString(doc));
  const master=strFromU8(files['xl/worksheets/sheet1.xml']);
  const masterRels=files['xl/worksheets/_rels/sheet1.xml.rels'];
  const wb=parse(strFromU8(files['xl/workbook.xml']));
  const sheets=elements(wb,'sheets')[0];while(sheets.firstChild)sheets.removeChild(sheets.firstChild);
  const names=elements(wb,'definedNames')[0];
  const printNames=names?elements(names,'definedName').filter(x=>x.getAttribute('localSheetId')==='0'&&/^_xlnm\.Print_(Area|Titles)$/.test(x.getAttribute('name'))).map(x=>({name:x.getAttribute('name'),value:x.textContent})):[];
  if(!printNames.some(x=>x.name==='_xlnm.Print_Area'))printNames.push({name:'_xlnm.Print_Area',value:"'SOF'!$A$1:$P$58"});
  if(names)names.parentNode.removeChild(names);
  const defined=wb.createElementNS(NS,'definedNames');
  const calc=elements(wb,'calcPr')[0];wb.documentElement.insertBefore(defined,calc||null);
  for(const view of elements(wb,'workbookView')){view.setAttribute('activeTab','0');view.setAttribute('firstSheet','0');}
  const rels=parse(strFromU8(files['xl/_rels/workbook.xml.rels']));
  for(const rel of elements(rels,'Relationship'))if(/\/(?:worksheet|calcChain)$/.test(rel.getAttribute('Type')))rel.parentNode.removeChild(rel);
  const types=parse(strFromU8(files['[Content_Types].xml']));
  for(const item of elements(types,'Override'))if(/\/worksheets\/|calcChain/.test(item.getAttribute('PartName')))item.parentNode.removeChild(item);
  for(const key of Object.keys(files))if(/^xl\/worksheets\//.test(key)||/calcChain/.test(key))delete files[key];
  const used=new Set();let count=0;
  for(const group of report.groups){
    // More than five cargoes or fourteen remarks continue on another sheet;
    // never silently truncate a report to fit the reference form.
    const longTanks=group.cargo.filter(c=>String(c.tank||'').length>32).map(c=>`CGO#${c.number} STOWAGE: ${c.tank}`);
    // The native form merges B:E for cargo details. Preserve optional editor
    // fields visibly in remarks instead of hiding values in merged child cells.
    const details=group.cargo.flatMap(c=>[c.party?`CGO#${c.number} SHIPPER/CONSIGNEE: ${c.party}`:'',c.line?`CGO#${c.number} LINE NO: ${c.line}`:''].filter(Boolean));
    const remarks=remarkLines([...(group.remarks||[]),...longTanks,...details]);
    const pages=Math.max(1,Math.ceil(group.cargo.length/5),Math.ceil(remarks.length/14));
    for(let page=0;page<pages;page++){
      const doc=parse(master),name=uniqueName(group.sheetName+(page?` cont ${page+1}`:''),used);
      count++;
      // Clear unused slots too, so sample values cannot survive a short page.
      clearReportSlots(doc);
      const values={B6:/^M\/T\s/i.test(report.fields.vessel)?report.fields.vessel:`M/T ${report.fields.vessel}`,G6:report.fields.voyage,C7:`ING : ${report.fields.port}${report.fields.port==='ULSAN'?', KOREA':''}`,B7:group.operation,D8:report.fields.charterer,
        N6:sheetDate(group),A12:monthLabel(group.arrival)||group.arrivalMonth||'',A13:monthLabel(group.pilotIn)!==monthLabel(group.arrival)?monthLabel(group.pilotIn):group.pilotMonth||'',
        B12:displayTime(group.arrival),B13:displayTime(group.pilotIn),B14:displayTime(group.berthAt),G14:group.berth,
        B15:displayTime(group.norTendered)||'REVIEW',B16:displayTime(group.norAccepted)||'REVIEW',B17:displayTime(group.tanksInspected),B18:displayTime(group.tanksAccepted),
        G21:group.operation,I21:group.operation,O20:'SHIP',O21:'FIG M/T',B32:displayTime(group.cargoCalculationStart),B33:displayTime(group.cargoCalculationEnd),B34:displayTime(group.papersOnBoard),B35:displayTime(group.pilotOut),B36:displayTime(group.leftBerth)};
      // DISCH always retains the SHIP FIG column. Unknown SHIP remains blank;
      // a B/L quantity is never reused as an invented ship measurement.
      group.cargo.slice(page*5,page*5+5).forEach((c,i)=>{const r=22+i*2,tank=String(c.tank||'');Object.assign(values,{[`A${r}`]:/^\d+$/.test(c.number)?Number(c.number):'#'+c.number,[`A${r+1}`]:c.name,[`B${r}`]:tank.length>32?'SEE REMARK':tank,[`F${r}`]:displayTime(c.hoseOn),[`G${r}`]:displayTime(c.commenced),[`I${r}`]:displayTime(c.completed),[`L${r}`]:displayTime(c.hoseOff),[`N${r}`]:c.bl,[`O${r}`]:c.ship});});
      remarks.slice(page*14,page*14+14).forEach((r,i)=>values[`B${38+i}`]=r);
      for(const [address,value]of Object.entries(values))setCell(doc,address,value);
      files[`xl/worksheets/sheet${count}.xml`]=serialize(doc);
      if(masterRels){
        const sheetRels=parse(strFromU8(masterRels));
        for(const relationship of elements(sheetRels,'Relationship')){
          if(!/\/drawing$/.test(relationship.getAttribute('Type'))||relationship.getAttribute('TargetMode')==='External')continue;
          const source=resolvePart('xl/worksheets/sheet1.xml',relationship.getAttribute('Target'));
          if(!files[source])throw new Error('SOF 양식의 회사 로고 drawing 파일을 찾을 수 없습니다.');
          // Keep relationship IDs and the original image bytes. Each worksheet
          // gets its own drawing part so Excel does not share mutable anchors.
          if(count>1){const target=`xl/drawings/sofDrawing${count}.xml`;files[target]=files[source];if(files[relsPart(source)])files[relsPart(target)]=files[relsPart(source)];relationship.setAttribute('Target',`../drawings/sofDrawing${count}.xml`);addContentType(types,'/'+target,'application/vnd.openxmlformats-officedocument.drawing+xml');}
        }
        files[`xl/worksheets/_rels/sheet${count}.xml.rels`]=count===1?masterRels:serialize(sheetRels);
      }
      const sheet=wb.createElementNS(NS,'sheet');sheet.setAttribute('name',name);sheet.setAttribute('sheetId',String(count));sheet.setAttributeNS(REL,'r:id',`sofSheet${count}`);sheets.appendChild(sheet);
      for(const original of printNames){const area=wb.createElementNS(NS,'definedName');area.setAttribute('name',original.name);area.setAttribute('localSheetId',String(count-1));area.textContent=original.value.replace(/(?:'(?:[^']|'')*'|[^!,]+)!/g,`'${name.replaceAll("'","''")}'!`);defined.appendChild(area);}
      const rel=rels.createElementNS(PKG,'Relationship');rel.setAttribute('Id',`sofSheet${count}`);rel.setAttribute('Type',REL+'/worksheet');rel.setAttribute('Target',`worksheets/sheet${count}.xml`);rels.documentElement.appendChild(rel);
      const type=types.createElementNS(TYPE,'Override');type.setAttribute('PartName',`/xl/worksheets/sheet${count}.xml`);type.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');types.documentElement.appendChild(type);
    }
  }
  files['xl/workbook.xml']=serialize(wb);files['xl/_rels/workbook.xml.rels']=serialize(rels);files['[Content_Types].xml']=serialize(types);
  // Company logo only; no macros, external links, source data, signatures/seals.
  return zipSync(files,{level:6});
}
