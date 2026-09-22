/** Single-page input only: no chat messages or automatic source submission. */
import { formatPilotPhone } from './phone.js';
import { formatPilotTime } from './time.js';
export function mountMiniApp(root,api,entry={}){
 let state={},busy=false,error='',notice='',queue=null,confirming=false,reviewing=false;
 const dirty=new Map(),searches=new Map(); // Memory only. Never localStorage.
 const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 const button=(text,fn,cls='button')=>{const b=node('button',text,cls);b.type='button';b.disabled=busy;b.addEventListener('click',fn);return b;};
 async function call(op,args={}){
  if(busy)return;busy=true;error='';notice='';confirming=false;render();
  try{const result=await api({op,...(state.id?{id:state.id,revision:state.revision}:{}),...args});
   if(op==='queue'||op==='copyList')queue={...result,copy:op==='copyList',search:args.search??''};else{if(result.id&&state.id!==result.id){dirty.clear();searches.clear();}state=result;queue=null;}
   if(op==='save'){dirty.clear();reviewing=args.review===true;}
   if(['start','copyStart','cancel'].includes(op)){dirty.clear();reviewing=false;}
   if(op==='pick')reviewing=false;
   notice=result.notice??result.message??'';
  }catch(e){error=e.message||'연결을 확인하지 못했습니다. 입력은 유지됩니다.';}
  finally{busy=false;render();}
 }
 function displayValue(f,value){return f.kind==='select'?f.options?.find(o=>o.index===value)?.label??'미선택':String(value??'')||'없음';}
 function decorateOriginal(wrap,f,value){
  const old=state.originalFields?.find(x=>x.key===f.key);if(!old)return;
  const oldValue=old.kind==='select'?old.selected:old.value,changed=displayValue(old,oldValue)!==displayValue(f,value);
  wrap.classList.toggle('is-changed',changed);let line=wrap.querySelector('.original-value');if(!line){line=node('div',undefined,'original-value');wrap.append(line);}line.textContent=`수정 전: ${displayValue(old,oldValue)}${changed?' → '+displayValue(f,value):' (유지)'}`;
 }
 function changed(key,value){dirty.set(key,value);confirming=false;reviewing=false;root.querySelector('[data-review]')?.remove();const badge=root.querySelector('[data-save-status]');if(badge)badge.textContent='입력 중 · 마지막에 한 번 저장/검토하세요';const f=state.formFields?.find(f=>f.key===key),wrap=root.querySelector(`[data-field="${key}"]`);if(f&&wrap)decorateOriginal(wrap,f,value);}
 function fieldControl(f){
  const wrap=node('div',undefined,'form-field');wrap.dataset.field=f.key;
  const label=node('label',f.label);label.htmlFor='field-'+f.key;wrap.append(label);
  if(f.readonly){wrap.append(node('div',displayValue(f,f.kind==='select'?f.selected:f.value),'selected-value'),node('small',state.mode==='COPY'?'원본값 유지 · 복사모드에서 변경 불가':'기존 신청의 선박은 변경할 수 없습니다.','muted'));decorateOriginal(wrap,f,f.kind==='select'?f.selected:f.value);return wrap;}
  if(f.kind==='lookup'){
   wrap.append(node('div',f.value||'선택하지 않음','selected-value'));
   if(f.readonly){wrap.append(node('small','기존 신청의 선박은 변경할 수 없습니다.','muted'));decorateOriginal(wrap,f,f.value);return wrap;}
   const row=node('div',undefined,'lookup-row'),i=node('input');i.id='field-'+f.key;i.placeholder=f.key==='vessel'?'선박명 / 호출부호 검색':'정확한 명칭 검색';i.value=searches.get(f.key)??f.value??'';i.maxLength=80;i.disabled=busy;i.autocomplete='off';i.addEventListener('input',()=>searches.set(f.key,i.value));
   const search=()=>{if(i.value.trim())void call('search',{field:f.key,text:i.value.trim()});};i.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();search();}});
   row.append(i,button('검색',search,'button compact'));wrap.append(row,node('small','변경하려면 검색 결과에서 정확한 항목을 선택하세요.','muted'));
   if(state.step===f.key&&state.choices?.length){const list=node('div',undefined,'search-results');for(const c of state.choices)list.append(button(c.label,()=>call('pick',{field:f.key,index:c.index}),'choice'));wrap.append(list);}
   decorateOriginal(wrap,f,f.value);return wrap;
  }
  let control;
  if(f.kind==='select'){
   control=node('select');const placeholder=node('option','선택해주세요');placeholder.value='';placeholder.disabled=true;control.append(placeholder);for(const o of f.options??[]){const option=node('option',o.label);option.value=String(o.index);control.append(option);}
   const selected=dirty.has(f.key)?dirty.get(f.key):f.selected;control.value=selected>=0?String(selected):'';
   control.addEventListener('change',()=>{if(control.value===''){dirty.delete(f.key);return;}changed(f.key,Number(control.value));});
  }else{
   control=node(f.kind==='textarea'?'textarea':'input');if(f.kind!=='textarea')control.type=f.kind==='date'?'date':f.key==='no_hpemp_partner'?'tel':'text';
   control.value=dirty.has(f.key)?dirty.get(f.key):f.value??'';
   control.placeholder=f.saved?'기존 값 저장됨 · 변경할 때만 입력':f.key==='nm_text'?'비고 (사이트 안내: 20자 이내 권장)':'입력';
   control.maxLength=f.key==='nm_text'?f.maxLength??1200:1200;control.autocomplete='off';
   if(f.kind==='time'){control.inputMode='numeric';control.maxLength=5;control.placeholder='0615 또는 06:15 (24시간)';control.pattern='(?:[01][0-9]|2[0-3]):?[0-5][0-9]';}
   if(['num_draft','num_length'].includes(f.key))control.inputMode='decimal';
   control.addEventListener('input',()=>{
    if(f.kind==='time')control.value=formatPilotTime(control.value);
    if(f.key==='no_hpemp_partner'){
     const pos=control.selectionStart??control.value.length,n=control.value.slice(0,pos).replace(/\D/g,'').length,formatted=formatPilotPhone(control.value);
     if(formatted!==control.value){control.value=formatted;let at=0,count=0;while(at<formatted.length&&count<n){if(/\d/.test(formatted[at]))count++;at++;}control.setSelectionRange(at,at);}
    }
    changed(f.key,control.value);
   });
  }
  control.id='field-'+f.key;control.disabled=busy;wrap.append(control);
  if(f.key==='dt_ship'&&state.mode==='COPY'){const row=node('div',undefined,'row');for(const [i,text] of ['오늘','내일','모레'].entries())row.append(button(text,()=>{control.value=new Date(Date.now()+9*3600000+i*86400000).toISOString().slice(0,10);changed(f.key,control.value);},'button compact'));wrap.append(row);}
  if(f.saved)wrap.append(node('small','기존 값은 보안상 표시하지 않으며, 미입력 시 유지됩니다.','muted'));
  decorateOriginal(wrap,f,dirty.has(f.key)?dirty.get(f.key):f.kind==='select'?f.selected:f.value);return wrap;
 }
 function render(){
  root.replaceChildren();const header=node('header');header.append(node('div','HYOPU · PILOT','eyebrow'),node('h1','도선신청서'),node('p','한 페이지에서 입력 · 마지막에 한 번 확인','subtitle'));root.append(header);
  root.append(node('div',state.enabled?'최종 확인 전에는 실제 신청하지 않습니다.':'작성·검증 모드 · 실제 등록/수정은 비활성화','safety'));
  if(error){const box=node('div',error,'error');box.setAttribute('role','alert');box.append(button('저장 상태 확인',()=>call('load')));root.append(box);}
  if(notice)root.append(node('div',notice,'notice'));
  if(busy){const loading=node('p','확인하고 있습니다…','loading');loading.setAttribute('role','status');root.append(loading);}
  const card=node('section',undefined,'card');root.append(card);
  if(queue){card.append(node('h2',queue.copy?'복사할 도선 선택':'수정할 신청 선택'));
   if(queue.copy){const search=node('input');search.placeholder='선박명 / 호출부호 검색';search.value=queue.search;card.append(search,button('🔍 검색',()=>call('copyList',{page:0,search:search.value.trim()})));}
   let group='';for(const row of queue.rows){if(queue.copy){const m=row.metadata,g=m.completion_status==='ACTIVE'?'현재 미완료':'최근 완료·청구';if(group!==g){card.append(node('h3',g));group=g;}const b=button(`${m.vessel_name} / ${m.callsign}\n${m.pilot_date} ${m.pilot_time}\n${m.from_location} → ${m.to_location}${row.available?'':'\n원본 상세 부족 — 복사 불가'}`,()=>call('copyStart',{sourceId:row.id}),'choice');b.disabled=busy||!row.available;card.append(b);}else card.append(button(row.label,()=>call('start',{action:'UPDATE',application:row.id}),'choice'));}
   if(!queue.rows.length)card.append(node('p','조회된 도선이 없습니다.'));
   const page=n=>call(queue.copy?'copyList':'queue',{page:n,search:queue.search});
   const nav=node('div',undefined,'row');if(queue.page>0)nav.append(button('이전 목록',()=>page(queue.page-1)));if((queue.page+1)*10<queue.total)nav.append(button('다음 목록',()=>page(queue.page+1)));card.append(nav,button('돌아가기',()=>{queue=null;render();}));return;}
  if(state.status!=='DRAFT'||state.expired){
   if(state.status&&state.status!=='EMPTY')card.append(node('p',`처리상태: ${state.status}${state.expired?' · 초안 만료':''}`));
   if(['CONFIRMED','SUBMITTING','VERIFYING','UNKNOWN'].includes(state.status)){card.append(node('h2','처리 결과 확인'),node('p','자동 재제출하지 않습니다. 검증된 결과만 그룹에 알립니다.'),button('신청처리상태 확인',()=>call('load')));return;}
   card.append(node('h2','도선업무 선택'),node('p','모든 항목을 한 화면에서 작성합니다. 중간 입력은 채팅으로 전송하지 않습니다.'),button('➕ 새로 등록',()=>call('start',{action:'CREATE'}),'button primary'),button('📋 기존 도선 복사',()=>call('copyList')),button('✏️ 접수된 도선 수정',()=>call('queue')));return;
  }
  card.append(node('h2',state.mode==='COPY'?'기존 도선 복사 → 신규 등록':state.action==='UPDATE'?'접수된 도선 수정':'신규 도선등록'));
  if(state.copySource)card.append(node('p',`${state.copySource.archived?'보관된 원본 사용':'최신 원본 확인'} · ${state.copySource.date}\n원본 수집: ${new Date(state.copySource.observedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}\n날짜·시간·FROM·TO만 변경합니다. 원본 신청은 수정하지 않습니다.`,'notice'));
  if(state.applicationId)card.append(node('p','신청번호: '+state.applicationId,'muted'));
  const status=node('p',dirty.size?'입력 중 · 마지막에 한 번 저장/검토하세요':'저장된 초안 · 항목 순서와 상관없이 입력하세요','muted');status.dataset.saveStatus='';card.append(status);
  const groups=[['선박 · 도선일시',['vessel','fg_inoutport','dt_ship','time']],['도선구간 · 흘수',['from','to','num_draft','fg_side']],['예선 · 강취',['tugboat_1','tugboat_a','tugboat_2','tugboat_b','mooring']],['선박 · 업무 정보',['tp_vessel','tp_cargo','num_bt_yn','tp_q','final_confirm_1','etryptyear','etryptco','cd_cargo','num_length','yn_dispilot']],['업체 · 담당자',['shipcompany','billing','fg_tax','cd_emp_partner','no_hpemp_partner','e_mail']],['비고',['nm_text']]];
  for(const [title,keys] of groups){const section=node('fieldset');section.append(node('legend',title));const grid=node('div',undefined,'form-grid');for(const key of keys){const f=state.formFields?.find(f=>f.key===key);if(f)grid.append(fieldControl(f));}section.append(grid);card.append(section);}
  card.append(node('p','연락처는 암호화해 저장합니다. 검색·선택 후에도 아직 저장하지 않은 다른 입력은 유지됩니다.','muted'));
  const footer=node('footer',undefined,'form-actions');footer.append(button('초안 저장',()=>call('save',{values:Object.fromEntries(dirty)})),button('전체 내용 검토',()=>call('save',{values:Object.fromEntries(dirty),review:true}),'button primary'));card.append(footer);
  if(reviewing&&state.step==='review'&&!dirty.size){
   const review=node('section',undefined,'review-panel');review.dataset.review='';review.append(node('h2','최종 확인'),node('pre',state.summary,'summary'));
   if(state.eligibilityPolicy==='official-ui-advisory-v1'){
    const warning=node('div',undefined,'notice');warning.dataset.eligibilityWarning='';warning.setAttribute('role','note');warning.append(node('p','도선사회 선사·청구처/시간 보조검사가 응답하지 않으면 경고 후 진행합니다. 연체 여부는 확인되지 않을 수 있으며 최종 접수는 도선사회 서버가 판정합니다.'));
    for(const message of state.eligibilityWarnings??[])if(typeof message==='string'&&message.trim())warning.append(node('p',message));
    review.append(warning);
   }
   if(confirming){review.append(node('p',`이 내용으로 실제 ${state.action==='UPDATE'?'수정':'도선신청'}을 승인하시겠습니까?`),button(state.mode==='COPY'?'✅ 신규등록 확정':state.action==='UPDATE'?'✅ 수정확정':'✅ 등록확정',()=>call('confirm',state.eligibilityPolicy===undefined?{}:{eligibilityPolicy:state.eligibilityPolicy}),'button primary'),button('다시 검토',()=>{confirming=false;render();}));}
   else{review.append(button('🧪 전송 없이 검사',()=>call('dry')));const submit=button(state.action==='UPDATE'?'수정 내용 승인하기':'최종 도선신청',()=>{confirming=true;render();},'button primary');submit.disabled=busy||!state.enabled;review.append(submit);}
   card.append(review);
  }
  card.append(button('초안 취소',()=>{const dialog=node('div',undefined,'notice');dialog.append(node('p','이 초안만 취소합니다. 실제 접수된 도선은 취소하지 않습니다.'),button('초안 취소 확인',()=>call('cancel')));card.append(dialog);},'button quiet'));
 }
 render();void call('load').then(()=>{if(entry.sourceId&&(state.status!=='DRAFT'||state.expired)&&!['CONFIRMED','SUBMITTING','VERIFYING','UNKNOWN'].includes(state.status))return call('copyStart',{sourceId:entry.sourceId});if(entry.copyList&&(state.status!=='DRAFT'||state.expired)&&!['CONFIRMED','SUBMITTING','VERIFYING','UNKNOWN'].includes(state.status))return call('copyList');});return{reload:()=>call('load')};
}
