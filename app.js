import { read } from 'xlsx';
import { parseReport, displayTime } from './sof-parser.mjs';
import { importWorkbook } from './sof-workbook.mjs';
import { exportSof } from './sof-export.mjs';
const $=s=>document.querySelector(s);
let state=null;
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const fields=[['vessel','VESSEL'],['voyage','VOYAGE'],['port','PORT'],['charterer','CHARTERER']];
const facts=[['arrival','ARRIVAL'],['pilotIn','PILOT IN'],['berthAt','BERTHED'],['norTendered','NOR TENDERED'],['norAccepted','NOR ACCEPTED'],['tanksInspected','TANKS INSPECTED'],['tanksAccepted','TANKS ACCEPTED'],['pilotOut','PILOT OUT'],['leftBerth','LEFT BERTH'],['cargoCalculationStart','CALCULATION START'],['cargoCalculationEnd','CALCULATION END'],['papersOnBoard','PAPERS ON BOARD']];
const cargoFields=[['number','CGO#'],['name','CARGO'],['tank','STOWAGE'],['hoseOn','HOSE ON'],['commenced','COMM'],['completed','COMP'],['hoseOff','HOSE OFF'],['bl','B/L MT'],['ship','SHIP MT']];
function showReport(report,name){state=report;$('#file-name').textContent=name;$('#upload-panel').classList.add('hidden');$('#review-panel').classList.remove('hidden');render();}
function render(){
  $('#summary-grid').innerHTML=fields.map(([key,label])=>`<label><span>${label}</span><input data-field="${key}" value="${esc(state.fields[key])}"></label>`).join('');
  $('#warnings').textContent=state.warnings.join('\n');
  $('#sheet-count').textContent=`${state.groups.length}개 작업 시트 · ${state.groups.reduce((n,g)=>n+g.cargo.length,0)}개 화물`;
  $('#download').disabled=!state.groups.length;
  $('#sheets').innerHTML=state.groups.map((g,i)=>`<article class="sof-sheet" data-group="${i}">
    <div class="section-heading"><h2>${esc(g.sheetName)}</h2><span>${esc(g.operation)} · ${esc(g.berth)}</span></div>
    <div class="summary-grid"><label><span>SHEET NAME</span><input data-g="${i}" data-key="sheetName" value="${esc(g.sheetName)}"></label><label><span>BERTH</span><input data-g="${i}" data-key="berth" value="${esc(g.berth)}"></label><label><span>OPERATION</span><select data-g="${i}" data-key="operation"><option ${g.operation==='LOAD'?'selected':''}>LOAD</option><option ${g.operation==='DISCH'?'selected':''}>DISCH</option></select></label></div>
    <div class="summary-grid facts">${facts.map(([key,label])=>`<label><span>${label}</span><input data-g="${i}" data-key="${key}" value="${esc(displayTime(g[key]))}" placeholder="${/nor/.test(key)?'확인 필요 (원문 미기재)':''}" title="${esc(g[key])}"></label>`).join('')}</div>
    <div class="table-wrap"><table><thead><tr>${cargoFields.map(([,label])=>`<th>${label}</th>`).join('')}<th></th></tr></thead><tbody>${g.cargo.map((c,j)=>`<tr>${cargoFields.map(([key])=>`<td><input aria-label="${key}" data-g="${i}" data-c="${j}" data-key="${key}" value="${esc(displayTime(c[key]))}" ${['bl','ship'].includes(key)?'inputmode="decimal"':''}></td>`).join('')}<td><button data-remove="${j}" data-g="${i}" class="delete" aria-label="화물 삭제">×</button></td></tr>`).join('')}</tbody></table></div>
    <button class="secondary add-cargo" data-add="${i}">+ 화물 추가</button>
    <label class="remarks-label">REMARKS (한 줄에 한 항목)<textarea data-g="${i}" data-key="remarks" rows="${Math.min(12,Math.max(3,g.remarks.length+1))}">${esc(g.remarks.join('\n'))}</textarea></label>
  </article>`).join('');
}
async function readFile(file){
  if(file.size>20*1024*1024){alert('20MB 이하의 파일을 올려 주세요.');return;}
  try{const report=/\.txt$/i.test(file.name)?parseReport(await file.text()):importWorkbook(read(await file.arrayBuffer(),{type:'array',cellDates:false,sheetRows:10000}));showReport(report,file.name);}
  catch(error){$('#status').textContent='파일을 읽지 못했습니다: '+error.message;}
}
async function download(){
  $('#download').disabled=true;$('#status').textContent='SOF 생성 중…';
  try{
    const response=await fetch('./templates/agent-sof.xlsx');if(!response.ok)throw new Error('SOF 양식을 불러오지 못했습니다.');
    const bytes=exportSof(await response.arrayBuffer(),state);
    const filename=`SOF_${(state.fields.vessel||'Draft').replace(/[^\w-]+/g,'_')}.xlsx`;
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
    const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    $('#status').textContent='다운로드 완료. 확인 필요 항목은 REVIEW로 표시됩니다.';
    if($('#save-history').checked){
      const binary=Array.from(bytes,b=>String.fromCharCode(b)).join('');
      const saved=await fetch('/api/documents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename,fileBase64:btoa(binary),metadata:state.fields})});
      const body=saved.status===204?{saved:false}:await saved.json();
      if(!saved.ok||body.saved!==true)throw new Error(body.error||'클라우드 저장을 확인하지 못했습니다 (다운로드 파일은 유지됩니다).');
      $('#status').textContent='다운로드 및 Supabase 저장 완료.';
    }
  }catch(error){$('#status').textContent=error.message;}finally{$('#download').disabled=!state.groups.length;}
}
$('#report-file').onchange=e=>e.target.files[0]&&readFile(e.target.files[0]);
$('#parse-text').onclick=()=>showReport(parseReport($('#report-text').value),'붙여넣은 운항 리포트');
for(const type of ['dragenter','dragover'])$('#dropzone').addEventListener(type,e=>{e.preventDefault();$('#dropzone').classList.add('drag');});
for(const type of ['dragleave','drop'])$('#dropzone').addEventListener(type,e=>{e.preventDefault();$('#dropzone').classList.remove('drag');});
$('#dropzone').addEventListener('drop',e=>e.dataTransfer.files[0]&&readFile(e.dataTransfer.files[0]));
$('#replace-file').onclick=()=>$('#report-file').click();
$('#edit-report').onclick=()=>{$('#upload-panel').classList.remove('hidden');$('#review-panel').classList.add('hidden');};
$('#review-panel').addEventListener('input',e=>{
  const {field,g,c,key}=e.target.dataset;
  if(field){state.fields[field]=e.target.value;return;}
  if(g===undefined||!key)return;
  const target=c===undefined?state.groups[g]:state.groups[g].cargo[c];
  let value=key==='remarks'?e.target.value.split('\n').filter(Boolean):e.target.value;
  if(['bl','ship'].includes(key))value=value.trim()===''?null:Number(value.replace(/,/g,''));
  target[key]=value;
});
$('#sheets').addEventListener('click',e=>{
  const {add,remove,g}=e.target.dataset;
  if(add!==undefined){state.groups[add].cargo.push({number:'',name:'',tank:'',hoseOn:'',commenced:'',completed:'',hoseOff:'',bl:null,ship:null});render();}
  if(remove!==undefined){state.groups[g].cargo.splice(Number(remove),1);render();}
});
$('#download').onclick=download;$('#reset').onclick=()=>location.reload();
