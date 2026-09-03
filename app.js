import { read } from 'xlsx';
import { parseReport, displayTime, resolveEditedTime, applyNorTenderedRule } from './sof-parser.mjs';
import { importWorkbook } from './sof-workbook.mjs';
import { exportSof } from './sof-export.mjs';

const $ = selector => document.querySelector(selector);
let state = null;
let workspaceContext = null;
function applyWorkspaceFields(report) {
  const context = workspaceContext?.fields;
  if (!context) return report;
  for (const key of ['vessel', 'voyage', 'port']) if (context[key]) report.fields[key] = context[key];
  return report;
}
function publishSof() {
  if (workspaceContext && typeof window !== 'undefined') window.parent.postMessage({type:'hyopu:sof-state',callId:workspaceContext.callId,report:state,raw:$('#report-text').value},location.origin);
}
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const fields = [['vessel', 'VESSEL'], ['voyage', 'VOYAGE'], ['port', 'PORT'], ['charterer', 'CHARTERER']];
const facts = [
  ['arrival', 'ARRIVAL'], ['pilotIn', 'PILOT IN'], ['berthAt', 'BERTHED'],
  ['norTendered', 'NOR TENDERED'], ['norAccepted', 'NOR ACCEPTED'],
  ['tanksInspected', 'TANKS INSPECTED'], ['tanksAccepted', 'TANKS ACCEPTED'],
  ['pilotOut', 'PILOT OUT'], ['leftBerth', 'LEFT BERTH'],
  ['cargoCalculationStart', 'CALCULATION START'], ['cargoCalculationEnd', 'CALCULATION END'], ['papersOnBoard', 'PAPERS ON BOARD'],
];
const cargoFields = [
  ['number', 'CGO#'], ['name', 'CARGO'], ['party', 'SHIPPER / CONSIGNEE'], ['tank', 'STOWAGE'], ['line', 'LINE NO.'],
  ['hoseOn', 'HOSE ON'], ['commenced', 'COMM.'], ['completed', 'COMP.'], ['hoseOff', 'HOSE OFF'],
  ['bl', 'B/L FIG M/T'], ['ship', 'SHIP FIG M/T'],
];
const timeFields = new Set([...facts.map(([key]) => key), 'hoseOn', 'commenced', 'completed', 'hoseOff']);
const hasCargo = () => Boolean(state?.groups.some(group => group.cargo.length));
const status = message => { $('#status').textContent = message; };

function showReport(report, name) {
  state = applyWorkspaceFields(report);
  $('#file-name').textContent = name;
  $('#upload-panel').classList.add('hidden');
  $('#review-panel').classList.remove('hidden');
  const norCount = report.groups.filter(group => group.norTendered).length;
  status(report.groups.length ? `분석 완료 · NOR TENDERED ${norCount}/${report.groups.length}개 확인. 각 작업 시트의 NOR 필드에서 시간과 근거를 확인하세요. NOR ACCEPTED는 별도 항목이며 원문 미기재 시 빈칸입니다.` : '화물을 찾지 못했습니다. 리포트 수정으로 돌아가 입력 내용을 확인해 주세요.');
  render();
}

function render() {
  $('#summary-grid').innerHTML = fields.map(([key, label]) => `<label><span>${label}</span><input data-field="${key}" value="${esc(state.fields[key])}"></label>`).join('');
  $('#warnings').textContent = state.warnings.join('\n');
  $('#sheet-count').textContent = `${state.groups.length}개 작업 시트 · ${state.groups.reduce((sum, group) => sum + group.cargo.length, 0)}개 화물`;
  $('#download').disabled = !hasCargo();
  $('#sheets').innerHTML = state.groups.map((group, index) => `<article class="sof-sheet" data-group="${index}">
    <div class="section-heading"><h2>${esc(group.sheetName)}</h2><span>${esc(group.operation)} · ${esc(group.berth)}</span></div>
    <div class="summary-grid">
      <label><span>SHEET NAME</span><input data-g="${index}" data-key="sheetName" value="${esc(group.sheetName)}"></label>
      <label><span>BERTH</span><input data-g="${index}" data-key="berth" value="${esc(group.berth)}"></label>
      <label><span>OPERATION</span><select data-g="${index}" data-key="operation"><option value="LOAD" ${group.operation === 'LOAD' ? 'selected' : ''}>LOAD</option><option value="DISCH" ${/^DISCH/i.test(group.operation) ? 'selected' : ''}>DISCH</option></select></label>
    </div>
    <div class="summary-grid facts">${facts.map(([key, label]) => `<label><span>${label}</span><input aria-label="${label}" data-g="${index}" data-key="${key}" value="${esc(displayTime(group[key]))}" placeholder="${/^nor/.test(key) ? '확인 필요 (원문 미기재)' : ''}" title="${esc(group[key])}" ${key === 'norTendered' && group.norTenderedAuto ? 'readonly' : ''}>${key === 'norTendered' ? `<small data-nor-note="${index}">${esc(group.norTenderedExplanation || '기존 SOF의 NOR 값 · 부두 이동 원문 대조 필요')}</small>` : ''}</label>`).join('')}</div>
    <div class="table-wrap"><table><thead><tr>${cargoFields.map(([, label]) => `<th>${label}</th>`).join('')}<th></th></tr></thead><tbody>${group.cargo.map((cargo, cargoIndex) => `<tr>${cargoFields.map(([key]) => `<td><input aria-label="${key}" data-g="${index}" data-c="${cargoIndex}" data-key="${key}" value="${esc(timeFields.has(key) ? displayTime(cargo[key]) : cargo[key])}" ${['bl', 'ship'].includes(key) ? 'inputmode="decimal" placeholder="미기재"' : ''}></td>`).join('')}<td><button data-remove="${cargoIndex}" data-g="${index}" class="delete" aria-label="화물 삭제">×</button></td></tr>`).join('')}</tbody></table></div>
    <button class="secondary add-cargo" data-add="${index}">+ 화물 추가</button>
    <label class="remarks-label">REMARKS (한 줄에 한 항목)<textarea data-g="${index}" data-key="remarks" rows="${Math.min(12, Math.max(3, group.remarks.length + 1))}">${esc(group.remarks.join('\n'))}</textarea></label>
  </article>`).join('');
  publishSof();
}

// Updating only dependent fields keeps the user's cursor in the HOSE OFF input.
function refreshNorFields() {
  applyNorTenderedRule(state);
  $('#warnings').textContent = state.warnings.join('\n');
  for (const input of document.querySelectorAll('input[data-key="norTendered"]')) {
    const group = state.groups[input.dataset.g];
    input.value = displayTime(group.norTendered);
    input.title = group.norTendered || '';
    input.readOnly = Boolean(group.norTenderedAuto);
  }
  for (const note of document.querySelectorAll('[data-nor-note]')) note.textContent = state.groups[note.dataset.norNote].norTenderedExplanation || '기존 SOF의 NOR 값 · 부두 이동 원문 대조 필요';
  for (const input of document.querySelectorAll('textarea[data-key="remarks"]')) input.value = state.groups[input.dataset.g].remarks.join('\n');
}

async function readFile(file) {
  if (file.size > 20 * 1024 * 1024) { status('20MB 이하의 파일을 올려 주세요.'); return; }
  try {
    const raw = /\.txt$/i.test(file.name) ? await file.text() : '';
    $('#report-text').value = raw;
    const report = /\.txt$/i.test(file.name)
      ? parseReport(raw)
      : importWorkbook(read(await file.arrayBuffer(), { type: 'array', cellDates: false, sheetRows: 10000 }));
    showReport(report, file.name);
  } catch (error) {
    console.error('[sof:import] failed', error.message);
    status(`파일을 읽지 못했습니다: ${error.message}`);
  } finally { $('#report-file').value = ''; }
}

function analyzeText() {
  const input = $('#report-text').value;
  if (!input.trim()) { status('분석할 리포트를 붙여넣어 주세요.'); return; }
  try { showReport(parseReport(input), '붙여넣은 운항 리포트'); }
  catch (error) {
    console.error('[sof:parse] failed', error.message);
    status(`리포트를 분석하지 못했습니다: ${error.message}`);
  }
}

function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function download() {
  if (!hasCargo()) { status('내보낼 화물이 없습니다.'); return; }
  $('#download').disabled = true;
  status('원본 서식 SOF 생성 중…');
  let downloaded = false;
  try {
    const response = await fetch('./templates/agent-sof.xlsx');
    if (!response.ok) throw new Error(`원본 SOF 양식을 불러오지 못했습니다 (${response.status}).`);
    const bytes = exportSof(await response.arrayBuffer(), state);
    const filename = `SOF_${(state.fields.vessel || 'Draft').replace(/[^a-z0-9가-힣_-]+/gi, '_')}.xlsx`;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    downloaded = true;
    status('엑셀 다운로드 완료. 회사명·로고와 원본 서식이 포함됩니다. 미기재 값은 임의로 채우지 않습니다.');
    if ($('#save-history').checked) {
      const saved = await fetch('/api/documents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, fileBase64: toBase64(bytes), metadata: state.fields }),
      });
      const body = await saved.json();
      if (!saved.ok || body.saved !== true) throw new Error(body.error || 'Supabase 저장을 확인하지 못했습니다.');
      status('엑셀 다운로드 및 Supabase 저장 완료.');
    }
  } catch (error) {
    console.error(downloaded ? '[sof:save] failed' : '[sof:export] failed', error.message);
    status(`${downloaded ? '엑셀 다운로드는 완료되었지만 클라우드 저장에 실패했습니다: ' : '엑셀 생성에 실패했습니다: '}${error.message}`);
  } finally { $('#download').disabled = !hasCargo(); }
}

$('#report-file').onchange = event => event.target.files[0] && readFile(event.target.files[0]);
$('#parse-text').onclick = analyzeText;
for (const type of ['dragenter', 'dragover']) $('#dropzone').addEventListener(type, event => { event.preventDefault(); $('#dropzone').classList.add('drag'); });
for (const type of ['dragleave', 'drop']) $('#dropzone').addEventListener(type, event => { event.preventDefault(); $('#dropzone').classList.remove('drag'); });
$('#dropzone').addEventListener('drop', event => event.dataTransfer.files[0] && readFile(event.dataTransfer.files[0]));
$('#replace-file').onclick = () => $('#report-file').click();
$('#edit-report').onclick = () => { $('#upload-panel').classList.remove('hidden'); $('#review-panel').classList.add('hidden'); status('리포트를 수정한 뒤 다시 분석해 주세요.'); };
$('#review-panel').addEventListener('input', event => {
  const { field, g, c, key } = event.target.dataset;
  if (field) { state.fields[field] = event.target.value; publishSof(); return; }
  if (g === undefined || !key) return;
  const target = c === undefined ? state.groups[g] : state.groups[g].cargo[c];
  if (key === 'norTendered' && target.norTenderedAuto) { refreshNorFields(); return; }
  let value = key === 'remarks' ? event.target.value.split('\n').filter(Boolean) : event.target.value;
  if (['bl', 'ship'].includes(key)) value = value.trim() === '' ? null : Number(value.replace(/,/g, ''));
  else if (timeFields.has(key)) value = resolveEditedTime(value, target[key] || state.groups[g].berthAt);
  target[key] = value;
  if (key === 'hoseOff' || key === 'norTendered' || key === 'berthAt') refreshNorFields();
  publishSof();
});
$('#sheets').addEventListener('click', event => {
  const { add, remove, g } = event.target.dataset;
  if (add !== undefined) {
    state.groups[add].cargo.push({ number: '', name: '', party: '', tank: '', line: '', hoseOn: '', commenced: '', completed: '', hoseOff: '', bl: null, ship: null });
    applyNorTenderedRule(state);
    render();
  }
  if (remove !== undefined) { state.groups[g].cargo.splice(Number(remove), 1); applyNorTenderedRule(state); render(); }
});
$('#download').onclick = download;
$('#reset').onclick = () => {
  if(!workspaceContext){location.reload();return;}
  state=null;$('#upload-panel').classList.remove('hidden');$('#review-panel').classList.add('hidden');status('새 리포트를 분석해 주세요.');publishSof();
};
// Same-origin, per-port-call bridge. No cross-window/global report storage.
if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
  document.body.classList.add('embedded-sof');
  const contextInputs=Array.from($('#upload-panel').querySelectorAll('input,textarea,button'));
  contextInputs.forEach(input=>{input.disabled=true;});
  status('선박 작업 공간에 연결하는 중…');
  $('#report-text').addEventListener('input',()=>{if(workspaceContext)window.parent.postMessage({type:'hyopu:sof-raw',callId:workspaceContext.callId,raw:$('#report-text').value},location.origin);});
  window.addEventListener('message', event => {
    if(event.origin!==location.origin||event.source!==window.parent||event.data?.type!=='hyopu:sof-context')return;
    workspaceContext={callId:event.data.callId,fields:event.data.fields||{}};
    const context=event.data.fields||{};
    const heading=document.querySelector('.hero .lede');
    if(heading)heading.textContent=`${context.vessel||''} / ${context.voyage||''} / ${context.port||''} · 현재 입항 건의 SOF 작업`;
    if(typeof event.data.raw==='string')$('#report-text').value=event.data.raw;
    if(event.data.report)showReport(event.data.report,'저장된 선박 SOF');
    else status('리포트를 입력하거나 파일을 선택해 분석해 주세요.');
    contextInputs.forEach(input=>{input.disabled=false;});
  });
  window.parent.postMessage({type:'hyopu:sof-ready'},location.origin);
}
