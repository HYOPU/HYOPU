import seedRows from './eta-seed.json';
import { PICS, PORTS, hydrateSeed, parseEta, calendarDays, shiftMonth, matchesFilters, callsOnDay, inMonth } from './operations-model.mjs';
import { createVesselWorkspace } from './vessel-workspace.mjs';
const $ = selector => document.querySelector(selector);
export const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
let calls = hydrateSeed(seedRows), month = '2026-09', view = 'calendar', listAll = true;
let session = {configured:false,ready:false,shared:true,member:{role:'editor'}};
let filters = { pic: '', port: '', query: '' };
function portClass(port) { return port.toLowerCase().replace(/[^a-z]/g, ''); }
function portTag(call) { return `<span class="port-tag port-${portClass(call.port)} ${call.highlight?.includes('port') ? 'highlight' : ''}">${esc(call.port)}</span>`; }
function statusTag(call) { return `<span class="status-tag ${call.status.toLowerCase()}">${call.status === 'INPORT' ? '● IN PORT' : call.status === 'DEPARTED' ? 'DEPARTED' : 'PRE-ARRIVAL'}</span>`; }
function card(call, day) {
  const eta = parseEta(call.etaRaw, call.year), continuing = day !== eta.date;
  return `<button class="vessel-card ${call.status === 'INPORT' ? 'inport' : ''} ${eta.uncertain ? 'uncertain' : ''}" data-call="${esc(call.id)}" aria-label="${esc(call.vessel)} ${esc(call.voyage)} ${esc(call.port)} 상세"><span class="card-heading"><span class="card-vessel ${call.highlight?.includes('vessel') ? 'highlight' : ''}">${esc(call.vessel)}</span><span class="card-time">${continuing ? 'IN PORT' : esc(eta.time || eta.period || 'TBC')}${eta.uncertain ? ' ?' : ''}</span></span><span class="card-voyage">${esc(call.voyage)}</span><span class="card-footer">${portTag(call)}<span class="pic-dot">${esc(call.pic)}</span></span>${continuing ? `<span class="date-note">ETD ${esc(call.etdRaw)}</span>` : ''}</button>`;
}
function render() {
  const filtered = calls.filter(call => matchesFilters(call, filters));
  const visible = view === 'list' && listAll ? filtered : filtered.filter(call => inMonth(call, month));
  const title = view === 'list' ? 'Korea ETA 리스트' : view === 'tasks' ? '업무 체크리스트' : '선박 운항 캘린더';
  $('#page-title').innerHTML = `${title}<span class="title-dot">.</span>`;
  $('#breadcrumb').textContent = title;
  $('#month-title').textContent = view === 'list' && listAll ? '전체 ETA 일정' : `${month.slice(0, 4)}년 ${Number(month.slice(5))}월`;
  $('#all-dates').hidden = view !== 'list';
  $('#all-dates').classList.toggle('selected',listAll);
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  const taskCount = visible.flatMap(call => call.tasks).filter(task => !task.done).length;
  $('#metrics').innerHTML = [['PORT CALLS',visible.length,'건','선택한 월 기준'],['IN PORT',visible.filter(call=>call.status==='INPORT').length,'척','원문 입항 상태'],['PRE-ARRIVAL',visible.filter(call=>call.status==='PRE-ARRIVAL').length,'건','입항 예정'],['OPEN TASKS',taskCount,'건','미완료 업무']].map(([label,count,unit,note])=>`<article class="metric"><span class="metric-label">${label}</span><strong class="metric-value">${count}<span class="metric-unit">${unit}</span></strong><span class="metric-note">${note}</span></article>`).join('');
  $('#result-label').textContent = `${filters.pic || '전체 담당자'} · ${visible.length} port calls`;
  if (view === 'calendar') $('#board-content').innerHTML = `<div class="calendar">${['MON','TUE','WED','THU','FRI','SAT','SUN'].map(day=>`<div class="weekday">${day}</div>`).join('')}${calendarDays(month).map(day=>`<div class="calendar-day ${!day.startsWith(month)?'outside':''} ${day===today?'today-cell':''}" data-date="${day}"><div class="day-number ${day===today?'today':''}"><span>${Number(day.slice(8))}</span></div>${callsOnDay(filtered,day).map(call=>card(call,day)).join('')}</div>`).join('')}</div>`;
  else if (view === 'list') $('#board-content').innerHTML = `<div class="table-scroll"><table class="eta-table"><thead><tr><th>VESSEL</th><th>VOYAGE</th><th>PORT</th><th>ETA / ARRIVED · LT</th><th>STATUS</th><th>ETD · LT</th><th>PIC</th><th></th></tr></thead><tbody>${visible.map(call=>`<tr><td><button class="vessel-link ${call.highlight?.includes('vessel')?'highlight':''}" data-call="${esc(call.id)}">${esc(call.vessel)}</button></td><td>${esc(call.voyage)}</td><td>${portTag(call)}</td><td>${esc(call.etaRaw)}</td><td>${statusTag(call)}</td><td>${esc(call.etdRaw)||'—'}</td><td>${esc(call.pic)||'미배정'}</td><td><button class="icon-button" data-call="${esc(call.id)}" aria-label="${esc(call.vessel)} 업무 열기">↗</button></td></tr>`).join('')}</tbody></table>${!visible.length?'<div class="empty"><strong>조회된 선박이 없습니다</strong>검색어·항만·담당자 또는 월을 변경해 주세요.</div>':''}</div>`;
  else {
    const tasks=visible.flatMap(call=>call.tasks.map(task=>({call,task})));
    $('#board-content').innerHTML = tasks.length ? `<div class="task-list">${tasks.map(({call,task})=>`<div class="task-entry ${task.done?'done':''}"><span>${task.done?'☑':'☐'}</span><button data-call="${esc(call.id)}"><strong>${esc(task.text)||'제목 없음'}</strong><small>${esc(call.vessel)} · ${esc(call.port)} · ${esc(call.pic)} ${task.due?' / '+esc(task.due):''}</small></button></div>`).join('')}</div>` : '<div class="empty"><strong>등록된 할 일이 없습니다</strong>선박 상세의 TO DO 탭에서 업무를 추가하고 공유 저장해 주세요.</div>';
  }
}
$('#pic-filter').insertAdjacentHTML('beforeend', PICS.map(pic=>`<option>${pic}</option>`).join(''));
$('#port-filter').insertAdjacentHTML('beforeend', PORTS.map(port=>`<option>${esc(port)}</option>`).join(''));
document.addEventListener('click', event => { const mode = event.target.closest('[data-view]'); if(mode) {view=mode.dataset.view;render();} const call = event.target.closest('[data-call]'); if(call) openCall(call.dataset.call); });
$('#previous-month').onclick=()=>{month=shiftMonth(month,-1);listAll=false;render();};
$('#next-month').onclick=()=>{month=shiftMonth(month,1);listAll=false;render();};
$('#today').onclick=()=>{month=today.slice(0,7);listAll=false;render();};
$('#today').insertAdjacentHTML('afterend','<button id="all-dates" class="subtle" hidden>전체 일정</button>');
$('#all-dates').onclick=()=>{listAll=!listAll;render();};
$('#pic-filter').onchange=event=>{filters.pic=event.target.value;render();};
$('#port-filter').onchange=event=>{filters.port=event.target.value;render();};
$('#search').oninput=event=>{filters.query=event.target.value;render();};
async function api(path, options={}) {
  let result;try{result=await fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers}});}catch{throw new Error('서버 응답을 확인하지 못했습니다. 초안을 백업하고 최신 기록을 확인해 주세요.');}
  let body;try{body=await result.json();}catch{throw new Error('공유 저장 API를 사용할 수 없습니다.');}
  if(!result.ok)throw new Error(body.error||'요청을 완료하지 못했습니다.');
  return body;
}
function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('파일을 읽지 못했습니다. 다시 선택해 주세요.'));
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
    reader.readAsDataURL(file);
  });
}
async function importEtaWorkbook(file) {
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name) || file.size > 10 * 1024 * 1024) throw new Error('10MB 이하의 KOREA ETA UPDATE .xlsx 파일을 선택해 주세요.');
  const control = $('#eta-upload-file');
  control.disabled = true;
  try {
    showToast('ETA 원본을 확인하고 공유 일정에 반영하는 중입니다…');
    const result = await api('/api/eta-upload', { method: 'POST', body: JSON.stringify({ $content: await fileAsBase64(file) }) });
    await loadCalls();
    showToast(`ETA 반영 완료 · 원본 ${result.sourceRows ?? 0}건 / 변경 ${result.changed ?? 0}건`);
  } finally {
    control.disabled = false;
    control.value = '';
  }
}
function connectionStatus() {
  const banner=$('#connection-banner');
  banner.classList.toggle('good',Boolean(session.ready));
  banner.textContent=session.ready?'공유 업무 공간 연결됨 · 선박 상세의 변경사항은 자동 저장됩니다. PIC 필터는 조회 범위만 변경합니다.':`${session.error||'공유 저장 연결이 필요합니다.'} 연결 전에는 첨부 ETA 원본만 표시됩니다.`;
  $('#source-label').textContent=session.ready?'SOURCE · SHARED WORKSPACE':'SOURCE · KOREA ETA UPDATE / 2026';
}
async function loadCalls() {const result=await api('/api/port-calls');calls=result.calls;render();}
const workspace=createVesselWorkspace({
  getCall:(id,refresh=false)=>refresh?api(`/api/port-calls?id=${encodeURIComponent(id)}`).then(result=>result.calls[0]):calls.find(call=>call.id===id),
  getSession:()=>session,
  saveCall:async(call,creating)=>{const response=await api('/api/port-calls',{method:creating?'POST':'PATCH',body:JSON.stringify({call,revision:call.revision})});if(!response.saved)throw new Error('공유 저장을 확인하지 못했습니다.');return response.call;},
  onSaved:call=>{const index=calls.findIndex(item=>item.id===call.id);if(index<0)calls.push(call);else calls[index]=call;render();},
});
function openCall(id) { workspace.open(id); }
$('#new-call').onclick=()=>workspace.open();
$('#eta-upload-file').onchange=event=>importEtaWorkbook(event.target.files?.[0]).catch(error=>showToast(error.message));
let toastTimer;
function showToast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('#toast').hidden=true;},5000);}
render();
api('/api/workspace').then(async result=>{session=result;if(session.ready)await loadCalls();connectionStatus();workspace.refreshStatus();}).catch(error=>{session.error=error.message;connectionStatus();});
