import { PICS, PORTS, STATUSES, blankCall } from './operations-model.mjs';
import validation from './lib/call-validation.js';
const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const definitions = {
  activities: [['done','완료','checkbox'],['time','일시 (LT)','datetime-local'],['activity','ACTIVITY'],['company','업체 · 담당'],['note','메모']],
  cargo: [['operation','작업','operation'],['number','CGO #'],['name','화물명'],['bl','B/L FIG (MT)'],['ship','SHIP FIG (MT)'],['tanks','탱크'],['party','SHIPPER / CONSIGNEE'],['note','메모']],
  crew: [['kind','구분','crew-kind'],['name','성명 · 직책'],['schedule','항공 · 이동 일정'],['status','처리 상태'],['note','메모']],
  tasks: [['done','완료','checkbox'],['text','할 일'],['due','기한','date']],
};
const tabLabels = [['overview','입항 정보'],['activities','ACTIVITY'],['cargo','화물 정보'],['crew','선원 교대'],['tasks','TO DO'],['reports','리포트'],['sof','SOF 자동화']];
const options = (values, selected, empty=false) => `${empty?'<option value="">미배정</option>':''}${values.map(value=>`<option value="${esc(value)}" ${value===selected?'selected':''}>${esc(value)}</option>`).join('')}`;
export function createVesselWorkspace({ getCall, getSession, saveCall, onSaved }) {
  const dialog=document.querySelector('#vessel-dialog');
  let draft=null, dirty=false, tab='overview', original=null, busy=false, opener=null, generation=0, startNewSof=false;
  const $=selector=>dialog.querySelector(selector);
  function field(key,label,type='text',list) {
    return `<label class="detail-field"><span>${label}</span>${list?`<select data-field="${key}">${options(list,draft[key],key==='pic')}</select>`:`<input data-field="${key}" type="${type}" value="${esc(draft[key])}" ${key==='etaRaw'||key==='etdRaw'?'placeholder="09/05 1200??"':''}>`}</label>`;
  }
  function markDirty() {dirty=!original||JSON.stringify(draft)!==JSON.stringify(original); updateSaveStatus();}
  function updateSaveStatus(message='') {
    const session=getSession();
    if(!draft)return;
    $('#save-status').textContent=message||(dirty?'미저장 변경사항':draft.updatedAt?`마지막 저장 ${new Date(draft.updatedAt).toLocaleString('ko-KR')}`:draft.revision?'공유 저장된 기록':'첨부 ETA 원본 · 아직 공유 저장되지 않음');
    $('#save-call').disabled=busy||!dirty||!session.authenticated||session.member?.role!=='editor';
    $('#save-call').textContent=busy?'저장 중…':'변경사항 저장';
    $('#draft-login').hidden=Boolean(session.authenticated);
    $('#save-help').textContent=session.authenticated?session.member.role==='editor'?'이 입항 건에만 저장됩니다.':'현재 계정은 조회 전용입니다.': '메모는 아직 저장되지 않습니다. 팀 로그인 후 저장해 주세요.';
    dialog.querySelectorAll('#detail-panel input,#detail-panel textarea,#detail-panel select,#detail-panel button,[data-tab],#reload-call,#close-vessel').forEach(element=>{element.disabled=busy;});
    if($('#sof-frame'))$('#sof-frame').inert=busy;
    dialog.classList.toggle('is-dirty',dirty);
  }
  function renderRows(key) {
    const fields=definitions[key];
    return `<div class="detail-section-heading"><div><h3>${tabLabels.find(([name])=>name===key)[1]}</h3><p>${key==='cargo'?'BL과 SHIP FIG는 별개입니다. 미기재 값은 빈칸으로 두세요.':key==='crew'?'이 입항 건에 필요한 최소한의 정보만 기록해 주세요.':'추가한 내용은 하단의 변경사항 저장을 눌러 저장합니다.'}</p></div><button class="subtle" data-add-row="${key}">＋ 행 추가</button></div><div class="detail-table-scroll"><table class="detail-table"><thead><tr>${fields.map(([,label])=>`<th>${label}</th>`).join('')}<th></th></tr></thead><tbody>${draft[key].map((row,i)=>`<tr>${fields.map(([name,label,type])=>`<td>${type==='checkbox'?`<input type="checkbox" data-list="${key}" data-index="${i}" data-key="${name}" aria-label="${label} ${i+1}" ${row[name]?'checked':''}>`:type==='operation'||type==='crew-kind'?`<select data-list="${key}" data-index="${i}" data-key="${name}" aria-label="${label} ${i+1}">${options(type==='operation'?['','LOAD','DISCH']:['ON-SIGNER','OFF-SIGNER','승선자 · 감독'],row[name])}</select>`:`<input type="${type||'text'}" data-list="${key}" data-index="${i}" data-key="${name}" aria-label="${label} ${i+1}" value="${esc(row[name])}" ${name==='bl'||name==='ship'?'inputmode="decimal" placeholder="미기재"':''}>`}</td>`).join('')}<td><button class="remove-row" data-remove-row="${key}" data-index="${i}" aria-label="${i+1}행 삭제">×</button></td></tr>`).join('')}</tbody></table></div>${!draft[key].length?'<div class="empty compact"><strong>아직 기록이 없습니다</strong>행 추가를 눌러 첫 기록을 작성하세요.</div>':''}`;
  }
  function renderPanel() {
    let content='';
    if(tab==='overview') content=`<div class="detail-section-heading"><div><h3>Port call details</h3><p>같은 선박·항차라도 항만별 업무 기록은 독립적으로 관리합니다.</p></div></div><div class="detail-grid">${field('vessel','VESSEL')}${field('voyage','VOYAGE')}${field('port','PORT','text',PORTS)}${field('pic','담당자 · PIC','text',PICS)}${field('year','기준 연도','number')}${field('etaRaw','ETA / ARRIVED (LT)')}${field('etdRaw','ETD (LT)')}${field('status','현재 상태','text',STATUSES)}</div><p class="field-hint">일시 표기: MM/DD HHmm · AM/PM · ?? 유지 / 시각 미정은 날짜만 입력</p><div class="note-heading"><h3>업무 메모</h3><span>THIS PORT CALL ONLY</span></div><textarea data-field="notes" rows="8" placeholder="접안 계획, 주의사항, 인계할 내용 등을 자유롭게 기록하세요.">${esc(draft.notes)}</textarea>`;
    else if(definitions[tab]) content=renderRows(tab);
    else if(tab==='reports') content=`<div class="detail-section-heading"><div><h3>최신 리포트</h3><p>수신한 리포트를 붙여넣고, SOF 탭에서 분석을 이어가세요.</p></div><label class="subtle file-label">TXT 불러오기<input id="latest-report-file" type="file" accept=".txt,text/plain" hidden></label></div><div class="detail-grid three">${field('reportType','REPORT 종류')}${field('reportReceived','수신 일시 (LT)','datetime-local')}<label class="report-check"><input type="checkbox" data-field="reportChecked" ${draft.reportChecked?'checked':''}>REPORT 확인 완료</label></div><textarea data-field="latestReport" rows="14" placeholder="운항 리포트 원문을 붙여넣어 주세요. 이메일 수신자·서명 등 불필요한 개인정보는 제거해 주세요.">${esc(draft.latestReport)}</textarea><button class="primary report-to-sof" data-tab="sof">이 리포트로 SOF 작업하기 ↗</button>`;
    else content=`<div class="detail-section-heading"><div><h3>SOF automation</h3><p>협운해운 원본 로고·폰트·서식과 기존 NOR / BL / SHIP 분석을 그대로 사용합니다.</p></div>${draft.sof?'<span class="status-tag inport">분석 기록 연결됨</span>':''}</div><p id="sof-link-status" class="sof-link-status">리포트 분석 후 이 선박·항차·항만과 일치하는 결과만 연결합니다.</p><iframe id="sof-frame" title="선박별 SOF 자동화" src="/sof.html?embedded=1"></iframe>`;
    if(tab==='cargo'&&draft.sof)content=`<button id="import-sof-cargo" class="subtle" style="margin-bottom:16px">SOF 분석 화물 가져오기</button>${content}`;
    $('#detail-panel').innerHTML=content;
    dialog.querySelectorAll('[data-tab]').forEach(button=>button.classList.toggle('active',button.dataset.tab===tab));
  }
  function open(id) {
    if(dialog.open&&!close())return;
    generation++;startNewSof=false;
    opener=document.activeElement;
    original=id?getCall(id):null;
    draft=original?structuredClone(original):blankCall(crypto.randomUUID());
    dirty=!original;tab='overview';
    dialog.innerHTML=`<header class="detail-header"><div><p class="eyebrow">VESSEL WORKSPACE <span> / ${esc(draft.port)}</span></p><h2>${esc(draft.vessel)||'새 선박 일정'} <small>/ ${esc(draft.voyage)||'NEW PORT CALL'}</small></h2><p><span class="detail-pic">${esc(draft.pic)||'PIC 미배정'}</span><span>${esc(draft.etaRaw)||'ETA 입력 필요'}</span><span class="status-tag ${draft.status.toLowerCase()}">${esc(draft.status)}</span></p></div><button id="close-vessel" class="icon-button" aria-label="선박 상세 닫기">×</button></header><nav class="detail-tabs" aria-label="선박 업무 탭">${tabLabels.map(([key,label])=>`<button data-tab="${key}" class="${key===tab?'active':''}">${label}</button>`).join('')}</nav><div id="detail-panel" class="detail-panel"></div><footer class="detail-save"><div><strong id="save-status" role="status"></strong><small id="save-help"></small></div><div class="save-buttons"><button id="backup-draft" class="subtle">초안 백업</button><button id="reload-call" class="subtle">최신 기록</button><button id="save-call" class="primary">변경사항 저장</button></div></footer>`;
    $('#save-call').insertAdjacentHTML('beforebegin','<button id="draft-login" class="subtle">팀 로그인</button>');
    renderPanel();updateSaveStatus();dialog.showModal();
  }
  function close() {
    if(busy)return false;
    if(dirty&&!window.confirm('저장되지 않은 변경사항이 있습니다. 닫으면 사라집니다. 닫을까요?'))return false;
    generation++;dialog.close();draft=null;dirty=false;if(opener?.isConnected)opener.focus();return true;
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('input',event=>{
    const {field,list,index,key}=event.target.dataset;
    if(!draft)return;
    if(field)draft[field]=event.target.type==='checkbox'?event.target.checked:field==='year'?Number(event.target.value):event.target.value;
    if(list)draft[list][Number(index)][key]=event.target.type==='checkbox'?event.target.checked:event.target.value;
    if(field||list)markDirty();
  });
  dialog.addEventListener('change',async event=>{
    if(event.target.id!=='latest-report-file'||!draft||busy)return;
    const file=event.target.files[0];if(!file)return;
    if(file.size>50000){updateSaveStatus('원문은 50KB 이하로 입력해 주세요.');return;}
    const ticket=generation,callId=draft.id;busy=true;updateSaveStatus('원문을 불러오는 중…');
    try{const raw=await file.text();if(ticket!==generation||draft?.id!==callId)return;draft.latestReport=raw;markDirty();renderPanel();}catch{if(ticket===generation)updateSaveStatus('파일을 읽지 못했습니다.');}finally{if(ticket===generation){busy=false;updateSaveStatus();}}
  });
  dialog.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||!draft||busy)return;
    if(button.dataset.tab){if(button.classList.contains('report-to-sof')){if(!draft.latestReport.trim()){updateSaveStatus('먼저 새 리포트 원문을 입력해 주세요.');return;}startNewSof=true;}tab=button.dataset.tab;renderPanel();}
    if(button.dataset.addRow){const key=button.dataset.addRow;draft[key].push(Object.fromEntries(definitions[key].map(([name,,type])=>[name,type==='checkbox'?false:type==='crew-kind'?'ON-SIGNER':''])));markDirty();renderPanel();}
    if(button.id==='import-sof-cargo'&&draft.sof){if(!validation.sofMatchesCall(draft.sof,draft)){updateSaveStatus('SOF와 입항 정보가 다릅니다. 화물을 가져오지 않았습니다.');return;}if(draft.cargo.length&&!window.confirm('현재 화물 표를 SOF 분석 화물로 바꿀까요?'))return;draft.cargo=draft.sof.groups.flatMap(group=>group.cargo.map(cargo=>({operation:group.operation,number:cargo.number,name:cargo.name,bl:cargo.bl==null?'':String(cargo.bl),ship:cargo.ship==null?'':String(cargo.ship),tanks:cargo.tank,party:cargo.party||'',note:group.berth})));markDirty();renderPanel();}
    if(button.dataset.removeRow){draft[button.dataset.removeRow].splice(Number(button.dataset.index),1);markDirty();renderPanel();}
    if(button.id==='close-vessel')close();
    if(button.id==='draft-login')document.querySelector('#login-dialog').showModal();
    if(button.id==='backup-draft') {const url=URL.createObjectURL(new Blob([JSON.stringify(draft,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`HYOPU_DRAFT_${draft.vessel.replace(/[^a-z0-9_-]/gi,'_')||'new'}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);updateSaveStatus('초안 파일을 다운로드했습니다. 공유 저장은 별도로 필요합니다.');}
    if(button.id==='reload-call'){
      if(dirty&&!window.confirm('내 초안을 버리고 최신 공유 기록을 불러올까요? 필요하면 먼저 초안 백업을 눌러 주세요.'))return;
      const ticket=generation,callId=draft.id;busy=true;updateSaveStatus('최신 공유 기록을 불러오는 중…');
      try{const latest=await getCall(callId,true);if(ticket!==generation||draft?.id!==callId)return;if(!latest){updateSaveStatus('아직 공유 저장된 기록이 없습니다.');return;}draft=structuredClone(latest);original=latest;dirty=false;renderPanel();updateSaveStatus();}catch(error){if(ticket===generation)updateSaveStatus(error.message);}finally{if(ticket===generation){busy=false;const message=$('#save-status').textContent;updateSaveStatus(message);}}
    }
    if(button.id==='save-call'){
      const error=validation.validateCall(draft);if(error){updateSaveStatus(error);return;}
      busy=true;updateSaveStatus('공유 저장 중…');
      try{const saved=await saveCall(draft,!original);draft=structuredClone(saved);original=saved;dirty=false;onSaved(saved);updateSaveStatus('공유 저장 완료');}catch(error){updateSaveStatus(error.message);}finally{busy=false;const message=$('#save-status').textContent;updateSaveStatus(message);}
    }
  });
  const normalizeVessel=value=>String(value||'').toUpperCase().replace(/^S\./,'STOLT ').replace(/[^A-Z0-9]/g,'');
  const normalize=value=>String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  window.addEventListener('message',event=>{
    const frame=$('#sof-frame');if(!draft||!frame||busy||event.origin!==location.origin||event.source!==frame.contentWindow)return;
    if(event.data?.type==='hyopu:sof-ready')frame.contentWindow.postMessage({type:'hyopu:sof-context',callId:draft.id,report:startNewSof?null:draft.sof,raw:draft.latestReport,fields:{vessel:draft.vessel,voyage:draft.voyage,port:draft.port}},location.origin);
    if(event.data?.type==='hyopu:sof-raw'&&event.data.callId===draft.id&&typeof event.data.raw==='string'){draft.latestReport=event.data.raw;startNewSof=true;markDirty();}
    if(event.data?.type==='hyopu:sof-state'&&event.data.callId===draft.id){
      const report=event.data.report;
      if(report===null){draft.sof=null;markDirty();$('#sof-link-status').textContent='이 입항 건의 SOF 초안을 초기화했습니다. 새 리포트를 분석해 주세요.';return;}
      if(!validation.validSof(report)){$('#sof-link-status').textContent='SOF 형식을 확인하지 못했습니다. 입력 값과 분석 결과를 확인해 주세요.';return;}
      if(normalizeVessel(report.fields.vessel)!==normalizeVessel(draft.vessel)||normalize(report.fields.voyage)!==normalize(draft.voyage)||normalize(report.fields.port)!==normalize(draft.port)){$('#sof-link-status').textContent='⚠ 분석 결과의 선박·항차·항만이 이 입항 건과 다릅니다. 연결하지 않았습니다. 리포트 또는 입항 정보를 확인해 주세요.';return;}
      startNewSof=false;
      if(JSON.stringify(draft.sof)!==JSON.stringify(report)){draft.sof=report;markDirty();}
      if(typeof event.data.raw==='string'&&event.data.raw!==draft.latestReport){draft.latestReport=event.data.raw;markDirty();}
      $('#sof-link-status').textContent='이 입항 건의 SOF 초안에 연결했습니다. 변경사항 저장을 눌러 공유 기록에 보관하세요.';
    }
  });
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  return {open,refreshStatus:updateSaveStatus,hasDraft:()=>dirty};
}
