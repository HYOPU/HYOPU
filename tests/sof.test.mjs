import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { read, utils } from 'xlsx';
import { unzipSync,strFromU8 } from 'fflate';
import { DOMParser,XMLSerializer } from '@xmldom/xmldom';
import { parseReport,normalizeReport,resolveEditedTime } from '../sof-parser.mjs';
import { exportSof } from '../sof-export.mjs';
import { importWorkbook } from '../sof-workbook.mjs';
const fixture=name=>fs.readFileSync(new URL(`fixtures/${name}.txt`,import.meta.url),'utf8');
const template=fs.readFileSync(new URL('../templates/agent-sof.xlsx',import.meta.url));
const parse=name=>parseReport(fixture(name));
test('BETULA: four cargo berths, seven cargos, source values take priority',()=>{
 const r=parse('betula');assert.equal(r.fields.voyage,'HBR 190');assert.deepEqual(r.groups.map(g=>g.sheetName),['OP6','JSTT3','OTK(S)','CTK']);assert.equal(r.cargo.length,7);
 assert.equal(r.cargo.find(c=>c.number==='390').completed,'2026-06-29T18:45');assert.equal(r.cargo.find(c=>c.number==='310').bl,1000.278);assert.equal(r.cargo.find(c=>c.number==='315').name,'NORMAL PARAFFIN C10-13');
 assert.equal(r.groups[2].leftBerth,'2026-07-01T02:44');assert.equal(r.groups[3].pilotIn,'2026-07-02T02:15');assert.equal(r.groups[3].cargo[0].hoseOn,'2026-07-02T06:00');
 assert.equal(r.groups[0].norTendered,'2026-06-28T11:42');assert.ok(r.groups.every(g=>g.norAccepted===''));assert.equal(r.groups[1].norTendered,'');
 assert.equal(r.groups[1].tanksInspected,'SEE REMARK');assert.ok(r.groups[3].remarks.some(x=>x.includes('30/2355~02/0215')));
});
test('KASHI: PACS voyage, discharge table without slash or SHIP FIG, layby excluded',()=>{
 const r=parse('kashi'),g=r.groups[0];assert.equal(r.fields.vessel,'STOLT KASHI');assert.equal(r.fields.voyage,'PACS 183');assert.equal(r.groups.length,1);assert.equal(g.berth,'P#42');assert.equal(g.operation,'DISCH');assert.equal(g.cargo.length,2);
 assert.equal(g.pilotIn,'2026-08-06T05:55');assert.equal(g.pilotOut,'2026-08-07T00:45');assert.equal(g.leftBerth,'2026-08-07T01:09');assert.equal(g.norTendered,'2026-08-05T00:48');assert.equal(g.cargo[0].bl,1899.979);assert.equal(g.cargo[0].ship,null);assert.equal(g.cargo[0].tank,'5P,5S');assert.equal(g.cargo[1].hoseOff,'2026-08-06T15:40');
 assert.ok(g.remarks.some(x=>x.includes('05/1000 : GRANTED FREE PRATIQUE')));assert.ok(g.remarks.some(x=>x.includes('CGO#602&#605')));assert.ok(!JSON.stringify(r).includes('HOTEL'));assert.ok(!r.events.some(e=>e.text.includes('ETA JIANGYIN')));
});
test('LARIX: eight sheets, ten cargoes, three distinct coasters at one berth',()=>{
 const r=parse('larix');assert.equal(r.fields.voyage,'AG-NE 72');assert.equal(r.groups.length,8);assert.equal(r.cargo.length,10);
 assert.deepEqual(r.groups.map(g=>g.sheetName),['P63','JSTT SP5','OCEAN ACE 11','YUE DAN','WOORI HANA','UTT','SK3','P22']);
 const [first,second,ace,yue,woori,utt,sk,p22]=r.groups;
 assert.equal(first.operation,'DISCH');assert.equal(second.operation,'DISCH');assert.equal(first.cargo[0].bl,5000);assert.equal(second.cargo[0].bl,5000);assert.equal(first.cargo[0].ship,null);assert.equal(first.cargo[0].plannedQuantity,5000);
 assert.ok(second.remarks.some(x=>x.includes('19/1900~19/2130')&&x.includes('CGO#117')));assert.ok(!first.remarks.some(x=>x.includes('CGO#117')));
 for(const g of [ace,yue,woori]){assert.equal(g.berth,'SBTS#1');assert.equal(g.arrival,'2026-03-23T06:20');assert.equal(g.pilotOut,'2026-03-25T16:35');assert.equal(g.leftBerth,'2026-03-25T17:02');}
 assert.equal(ace.tanksInspected,'ATIP');assert.equal(yue.tanksInspected,'2026-03-24T09:10');assert.equal(woori.tanksInspected,'2026-03-25T05:10');assert.equal(woori.cargo[0].tank,'3P');
 assert.equal(sk.pilotOut,'2026-03-27T09:41');assert.ok(sk.remarks.some(x=>x.includes('ENGINE SYSTEM TROUBLE')));assert.ok(p22.remarks.some(x=>x.includes('17 SSANGYONG')));assert.ok(p22.remarks.some(x=>x.includes('BUENA SUERTE')));
});
test('HTML entities, escaped markdown and zero-width whitespace normalize safely',()=>{
 const source=fixture('betula').replaceAll('*','\\*').replaceAll('~','\\~').replaceAll(' : ','&#x20;: ').replace('STOLT BETULA','STOLT\u200BBETULA');
 const r=parseReport(source);assert.equal(r.groups.length,4);assert.equal(r.cargo.length,7);assert.equal(normalizeReport('&lt;x&gt; &amp; &#32;'),'<x> &  ');
});
test('monthly rollover does not advance on a retrospective tank inspection',()=>{
 const r=parse('betula');const e=r.events.find(e=>e.text.includes('CGO#375'));assert.equal(e.at,'2026-06-29T18:00');assert.equal(r.groups[2].cargo[0].hoseOn,'2026-06-30T14:25');
});
for(const name of ['betula','kashi','larix'])test(`${name}: XLSX round trip, layout, typed figures and blank signatures`,()=>{
 const report=parse(name),bytes=exportSof(template,report,{DOMParser,XMLSerializer});const wb=read(bytes,{type:'array',cellStyles:true});const zip=unzipSync(bytes);
 assert.equal(wb.SheetNames.length,report.groups.length);
 for(let i=0;i<report.groups.length;i++){
  const s=wb.Sheets[wb.SheetNames[i]],g=report.groups[i];assert.equal(s.B6.v,`M/T ${report.fields.vessel}`);assert.equal(s.G6.v,report.fields.voyage);assert.equal(s.G14.v,g.berth);assert.equal(s.G21.v,g.operation);assert.equal(s.B16.v,'REVIEW');assert.ok(s['!merges'].some(m=>utils.encode_range(m)==='A2:P3'));
  g.cargo.forEach((c,j)=>{const row=22+j*2;assert.equal(s[`A${row}`].v,Number(c.number));assert.equal(s[`A${row+1}`].v,c.name);assert.equal(s[`N${row}`]?.v??null,c.bl);if(c.bl!==null)assert.equal(s[`N${row}`].t,'n');});
  assert.match(strFromU8(zip[`xl/worksheets/sheet${i+1}.xml`]),/fitToPage="1"/);
  assert.ok(zip[`xl/worksheets/_rels/sheet${i+1}.xml.rels`]);
  assert.equal(s.A2.v.trim(),'HYOP WOON SHIPPING LTD.');assert.equal(s.O20.v,'SHIP');assert.equal(s.O21.v,'FIG M/T');
 }
 assert.deepEqual(Object.keys(zip).filter(x=>/^xl\/media\//.test(x)),['xl/media/image1.png']);
 assert.ok(!Object.keys(zip).some(x=>/vbaProject|externalLink/i.test(x)));assert.equal(importWorkbook(wb).groups.length,report.groups.length);
});
test('overflow cargoes and remarks continue without truncation or name collisions',()=>{
 const r=parse('kashi');r.groups[0].cargo=Array.from({length:7},(_,i)=>({...r.groups[0].cargo[0],number:String(600+i)}));r.groups[0].remarks=Array.from({length:19},(_,i)=>`Remark ${i}`);
 const wb=read(exportSof(template,r,{DOMParser,XMLSerializer}),{type:'array'});assert.equal(wb.SheetNames.length,2);assert.equal(wb.Sheets[wb.SheetNames[1]].A24.v,606);assert.equal(wb.Sheets[wb.SheetNames[1]].B42.v,'Remark 18');
});
test('source content starting with = remains literal text, not a formula',()=>{
 const r=parse('kashi');r.fields.vessel='=WEBSERVICE("https://example.invalid")';const wb=read(exportSof(template,r,{DOMParser,XMLSerializer}),{type:'array'});assert.equal(wb.Sheets.P42.B6.f,undefined);assert.equal(wb.Sheets.P42.B6.t,'s');
});
test('empty or malformed inputs show review warnings',()=>{assert.ok(parseReport('').warnings.length);assert.throws(()=>exportSof(template,parseReport(''),{DOMParser,XMLSerializer}));});
test('edited times preserve month and year and workbook re-import preserves headers',()=>{
 assert.equal(resolveEditedTime('01/0250','2026-07-01T02:44'),'2026-07-01T02:50');
 const bytes=exportSof(template,parse('betula'),{DOMParser,XMLSerializer});const original=read(bytes,{type:'array'});
 const second=read(exportSof(template,importWorkbook(original),{DOMParser,XMLSerializer}),{type:'array'});
 for(const name of original.SheetNames){assert.equal(second.Sheets[name].N6.v,original.Sheets[name].N6.v);assert.equal(second.Sheets[name].A12.v,original.Sheets[name].A12.v);assert.equal(second.Sheets[name].B35.v,original.Sheets[name].B35.v);}
});
test('invalid edited quantities fail explicitly',()=>{const r=parse('kashi');r.groups[0].cargo[0].bl=NaN;assert.throws(()=>exportSof(template,r,{DOMParser,XMLSerializer}),/숫자/);});
