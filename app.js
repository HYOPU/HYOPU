const $ = (s) => document.querySelector(s);
const state = { statements: [], cargo: [], fields: { vessel: '', voyage: '', port: '', charterer: '' } };
const labels = [['vessel','VESSEL'],['voyage','VOYAGE'],['port','PORT OF LOAD / DISCHARGE'],['charterer','CHARTERER']];
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const parseDate = (v) => { const s=clean(v); const m=s.match(/(?:\d{4}[,./ -]+[A-Z]{3}[,./ -]+)?\s*(\d{1,2})\s*[/.-]\s*(\d{3,4})/i); return m ? `${m[1].padStart(2,'0')}/${m[2].padStart(4,'0')}` : s; };

function render() {
  const grid=$('#summary-grid'); grid.innerHTML='';
  labels.forEach(([key,label])=>{ const node=$('#summary-template').content.cloneNode(true); const input=node.querySelector('input'); node.querySelector('span').textContent=label; input.value=state.fields[key]; input.oninput=e=>state.fields[key]=e.target.value; grid.append(node); });
  $('#statement-rows').innerHTML=state.statements.map((r,i)=>`<tr><td><input aria-label="날짜와 시간" data-i="${i}" data-k="date" value="${esc(r.date)}"></td><td><input aria-label="Statement" data-i="${i}" data-k="text" value="${esc(r.text)}"></td><td><button class="delete" data-delete="${i}" aria-label="항목 삭제">×</button></td></tr>`).join('') || '<tr><td colspan="3">추출된 Statement가 없습니다. 항목 추가로 입력해 주세요.</td></tr>';
  $('#cargo-rows').innerHTML=state.cargo.map((r,i)=>`<tr>${['cargo','party','tank','line','hoseOn','commLoad','compLoad','hoseOff'].map(k=>`<td><input aria-label="${k}" data-c="${i}" data-k="${k}" value="${esc(r[k])}"></td>`).join('')}</tr>`).join('') || '<tr><td colspan="8">화물 정보가 없습니다.</td></tr>';
}
function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')}
function readWorkbook(file) {
  if(file.size>20*1024*1024){alert('20MB 이하의 파일을 올려 주세요.');return;}
  const reader=new FileReader(); reader.onload=e=>{try {
    if(/\.txt$/i.test(file.name)) extractText(String(e.target.result));
    else { const wb=XLSX.read(e.target.result,{type:'array',cellDates:true}); extract(wb); }
    $('#file-name').textContent=file.name; $('#upload-panel').classList.add('hidden'); $('#review-panel').classList.remove('hidden'); render();
  } catch(err){alert('파일을 읽지 못했습니다. XLSX, XLS, CSV, TXT 형식을 확인해 주세요.'); console.error(err);} };
  if(/\.txt$/i.test(file.name)) reader.readAsText(file); else reader.readAsArrayBuffer(file);
}
function extract(wb) {
  const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:'',raw:false}); const flat=rows.map(r=>r.map(clean));
  const all=flat.map(r=>r.join(' '));
  const valAfter=(pattern)=>{const line=all.find(x=>pattern.test(x)); return line?clean(line.replace(pattern,'').replace(/^[:\s-]+/,'')):''};
  state.fields.vessel=valAfter(/VESSEL\s*[:：]?/i); state.fields.voyage=valAfter(/VOY\s*[:：]?/i); state.fields.port=valAfter(/PORT\s*(?:OF\s*)?(?:LOAD|DISCHARGE)(?:ING)?\s*[:：]?/i); state.fields.charterer=valAfter(/CHARTERER\s*[:：]?/i);
  state.statements=[]; flat.forEach(r=>{const line=r.join(' '); const hit=line.match(/(?:\d{1,2}\s*[/.-]\s*\d{3,4})/); const text=clean(line.replace(/.*?(?:\d{1,2}\s*[/.-]\s*\d{3,4})\s*-?\s*/,'')); if(hit && text && !/HOSE|COMM|COMP|LINE/i.test(text)) state.statements.push({date:parseDate(hit[0]),text});});
  state.statements=[...new Map(state.statements.map(x=>[x.date+x.text,x])).values()]; state.cargo=[];
  const cargoRow=flat.find(r=>r.some(x=>/CARGO/i.test(x)) && r.some(x=>/TANK/i.test(x))); const start=cargoRow?flat.indexOf(cargoRow)+1:-1;
  if(start>0){for(let i=start;i<Math.min(start+5,flat.length);i++){const r=flat[i]; if(r.some(Boolean)&&!r.join(' ').match(/START CARGO/i)) state.cargo.push({cargo:r[0],party:r[1],tank:r[2],line:r[3],hoseOn:r[4],commLoad:r[5],compLoad:r[6],hoseOff:r[7]});}}
}
function extractText(text){
  const lines=text.split(/\r?\n/).map(clean).filter(Boolean);
  state.fields={vessel:'',voyage:'',port:'',charterer:''};
  const heading=lines.find(x=>/^\([A-Z ]+\)$/.test(x));
  state.fields.port=heading?heading.replace(/[()]/g,''):'';
  const title=lines.find(x=>/\bHBR\s*\d+/i.test(x));
  if(title){const parts=title.split('/').map(clean);state.fields.vessel=parts[0]||'';state.fields.voyage=parts[1]||'';state.fields.port=parts[2]||state.fields.port;}
  state.statements=[]; let activeDay='';
  lines.forEach(line=>{
    let m=line.match(/^\*?(\d{1,2})\/(\d{4})(?:\s*~\s*(\d{1,2})\/(\d{4}))?\s*:\s*(.+)$/);
    if(m){activeDay=m[1];state.statements.push({date:m[3]?`${m[1].padStart(2,'0')}/${m[2]} - ${m[3].padStart(2,'0')}/${m[4]}`:`${m[1].padStart(2,'0')}/${m[2]}`,text:m[5]});return;}
    m=line.match(/^(\d{4})\s*:\s*(.+)$/);
    if(m&&activeDay)state.statements.push({date:`${activeDay.padStart(2,'0')}/${m[1]}`,text:m[2]});
  });
  state.statements=[...new Map(state.statements.map(x=>[x.date+x.text,x])).values()];
  state.cargo=[];
  lines.forEach((line,i)=>{
    const m=line.match(/^(?:\(LOAD\)\s*)?(?:CGO)?#(\d+[A-Z\/]*)\s+([A-Z][A-Z0-9 ]*?)\s*\/\s*[\d,.]+MT\(([^)]*)\)/i);
    if(!m)return;
    const schedule=line.slice(m.index+m[0].length)+' '+(lines[i+1]||'');
    const times=[...schedule.matchAll(/\b(?:H\/ON|COMM|COMP|H\/OFF)\s+(\d{1,2}\/\d{4})/gi)];
    const byLabel={}; times.forEach(x=>byLabel[x[0].split(/\s+/)[0].toUpperCase()]=x[1]);
    if(!times.length){const dates=[...schedule.matchAll(/\b\d{1,2}\/\d{4}\b/g)].map(x=>x[0]);[byLabel['H/ON'],byLabel.COMM,byLabel.COMP,byLabel['H/OFF']]=dates;}
    state.cargo.push({cargo:`CGO#${m[1]} ${clean(m[2])}`,party:'LOAD',tank:m[3],line:'',hoseOn:byLabel['H/ON']||'',commLoad:byLabel.COMM||'',compLoad:byLabel.COMP||'',hoseOff:byLabel['H/OFF']||''});
  });
}
function download(){ const title='STATEMENT OF FACTS'; const data=[[title],[],['VESSEL',state.fields.vessel,'VOYAGE',state.fields.voyage],['PORT OF LOAD / DISCHARGE',state.fields.port,'CHARTERER',state.fields.charterer],[],['DATE / HOUR','STATEMENT'],...state.statements.map(x=>[x.date,x.text]),[],['CARGO','SHIPPER / CONSIGNEE','TANK NO.','LINE NO.','HOSE ON','COMM. LOAD','COMP. LOAD','HOSE OFF'],...state.cargo.map(x=>[x.cargo,x.party,x.tank,x.line,x.hoseOn,x.commLoad,x.compLoad,x.hoseOff])]; const ws=XLSX.utils.aoa_to_sheet(data); ws['!cols']=[{wch:19},{wch:56},{wch:14},{wch:14},{wch:14},{wch:14},{wch:14},{wch:14}]; ws['!merges']=[XLSX.utils.decode_range('A1:H1')]; const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'SOF'); const filename=`SOF_${(state.fields.vessel||'Draft').replace(/\W+/g,'_')}.xlsx`; XLSX.writeFile(wb,filename); saveToSupabase(wb,filename); }
async function saveToSupabase(wb,filename){ try { const bytes=XLSX.write(wb,{bookType:'xlsx',type:'base64'}); const r=await fetch('/api/documents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename,fileBase64:bytes,metadata:state.fields})}); if(r.ok) console.info('SOF saved to workspace'); } catch { /* Local/preview mode: downloads still work without a database. */ } }
$('#report-file').onchange=e=>e.target.files[0]&&readWorkbook(e.target.files[0]); ['dragenter','dragover'].forEach(ev=>$('#dropzone').addEventListener(ev,e=>{e.preventDefault();$('#dropzone').classList.add('drag')})); ['dragleave','drop'].forEach(ev=>$('#dropzone').addEventListener(ev,e=>{e.preventDefault();$('#dropzone').classList.remove('drag')})); $('#dropzone').addEventListener('drop',e=>e.dataTransfer.files[0]&&readWorkbook(e.dataTransfer.files[0])); $('#replace-file').onclick=()=>$('#report-file').click(); $('#add-row').onclick=()=>{state.statements.push({date:'',text:''});render()}; $('#statement-rows').addEventListener('input',e=>{if(e.target.dataset.i!==undefined)state.statements[e.target.dataset.i][e.target.dataset.k]=e.target.value}); $('#statement-rows').addEventListener('click',e=>{if(e.target.dataset.delete!==undefined){state.statements.splice(e.target.dataset.delete,1);render()}}); $('#cargo-rows').addEventListener('input',e=>{if(e.target.dataset.c!==undefined)state.cargo[e.target.dataset.c][e.target.dataset.k]=e.target.value}); $('#download').onclick=download; $('#reset').onclick=()=>location.reload();
