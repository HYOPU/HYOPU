const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const dateLabel=s=>{if(!s)return '미확인';const d=new Date(s.replace(' ','T')+':00+09:00');return `${s.slice(5,10).replace('-','/')}(${['일','월','화','수','목','금','토'][new Date(d.getTime()+9*3600000).getUTCDay()]}) ${s.slice(11,16).replace(':','')}`;};
const berthLabel=value=>value==='UNASSIGNED'?'부두 미정':typeof value==='string'&&value&&value!=='UNKNOWN'?value:'확인 필요';
const isUnverified=row=>row.berth_verified===false||row.normalized_berth==='UNKNOWN';
const observedLabel=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'확인 기록 없음';
const qualityWarning=data=>{
 const count=Math.max(Number(data.unknown_count)||0,(data.rows??[]).filter(isUnverified).length);
 return count||data.quality_status==='DEGRADED'?`⚠️ 부분 확인: ${count?`부두 미검증 ${count}건`:'일부 부두값 확인 필요'} · 마지막 검증값을 유지합니다.`:'';
};
const berthDetail=row=>{
 if(!isUnverified(row))return berthLabel(row.normalized_berth);
 const raw=String(row.observed_raw_berth??row.raw_berth??'').trim()||'(빈 값)';
 const prior=typeof row.normalized_berth==='string'&&row.normalized_berth&&row.normalized_berth!=='UNKNOWN';
 return `⚠️ 부두 확인 필요 · 원문: ${raw}\n마지막 검증 부두: ${prior?berthLabel(row.normalized_berth):'확인 기록 없음'}${row.last_verified_at?`\n마지막 검증 시각: ${observedLabel(row.last_verified_at)}`:''}`;
};
export function mountJstt(root,api,{reference,onBack}={}){
 let state={rows:[],total:0,page:0},view='current',busy=false,error='',notice='',search='',vessel='',agency='',anyAgency=true,confirmation=null;
 const button=(label,fn)=>{const b=el('button',label,'button');b.type='button';b.disabled=busy;b.addEventListener('click',fn);return b;};
 const clearConfirmation=()=>{confirmation=null;root.querySelector('.review')?.remove();};
 function reviewAdd(){
  vessel=vessel.trim();agency=agency.trim();
  if(!vessel||(!anyAgency&&!agency)){error='선박명을 입력하세요. 대리점을 제한한 경우 대리점명도 입력하세요.';render();return;}
  error='';confirmation={action:'add',vessel,agency:anyAgency?null:agency};render();
 }
 async function call(op,args={}){
  if(busy)return;busy=true;error='';render();
  try{const result=await api({op,requestId:crypto.randomUUID(),...args});
   if(['jsttAdd','jsttRemove'].includes(op)){notice=result.changed?(op==='jsttAdd'?'감시목록에 추가했습니다. 최초 배정 여부는 정상 조회 후 확인합니다.':'감시목록에서 삭제했습니다. 이력은 보존됩니다.'):'이미 반영된 상태입니다.';confirmation=null;
    view='watchlist';state=await api({op:'jsttWatchlist',requestId:crypto.randomUUID(),page:0});}
   else if(op==='jsttRefresh'){notice=['RUN','JOINED'].includes(result.refresh)?'조회 중입니다. 잠시 후 현재 배정현황을 눌러 확인하세요.':result.refresh==='RECENT'?'방금 조회한 자료가 있습니다. 현재 배정현황에서 확인하세요.':result.refresh==='COOLDOWN'?'30초 간격으로 확인할 수 있습니다.':'JSTT 감시가 중지되어 있습니다. 기존 도선 기능과는 별개입니다.';}
   else{state=result;if(result.search)search=result.search;view=['current','watchlist','changes','search'].includes(result.view)?result.view:op==='jsttWatchlist'?'watchlist':op==='jsttChanges'?'changes':op==='jsttSearch'?'search':'current';}
  }catch(e){error=e.message??'처리 결과를 확인하지 못했습니다.';}finally{busy=false;render();}
 }
 function render(){
  root.replaceChildren(el('h1','⚓ JSTT 부두 감시'),el('p','20분마다 자동 수집 · 접안 예정일 오늘~7일 후 · 협운 자동감시','muted'));
  const nav=el('div',undefined,'row');for(const [label,op]of[['현재 배정현황','jsttCurrent'],['감시목록','jsttWatchlist'],['최근 변경','jsttChanges'],['즉시 확인','jsttRefresh']])nav.append(button(label,()=>call(op,{page:0})));root.append(nav);
  if(error)root.append(el('p',error,'error'));if(notice)root.append(el('p',notice,'notice'));
  root.append(el('p',`마지막 수집: ${observedLabel(state.last_success)}${!state.enabled?' · 감시 중지':''}${state.last_success&&Date.now()-Date.parse(state.last_success)>25*60000?' · 최신 자료 아님':''}`,'muted'));
  const warning=qualityWarning(state);if(warning)root.append(el('p',warning,'notice'));
  const section=el('section');section.append(el('h2','감시선박 등록'),el('p','선박명만 입력하세요. 대리점과 관계없이 감시합니다.','muted'));
  const form=el('div',undefined,'form-grid');
  const field=(label,value,change)=>{const wrap=el('div',undefined,'form-field'),l=el('label',label),input=el('input');input.id='jstt-'+(label.startsWith('선박')?'vessel':'agency');l.htmlFor=input.id;input.value=value;input.maxLength=120;input.disabled=busy;input.addEventListener('input',()=>{change(input.value);clearConfirmation();});wrap.append(l,input);return {wrap,input};};
  const vf=field('선박명 (정확한 이름)',vessel,x=>vessel=x);vf.input.placeholder='선박명 검색 또는 직접 입력';form.append(vf.wrap);
  const af=field('대리점',agency,x=>agency=x);af.input.disabled=busy||anyAgency;af.input.placeholder='JSTT의 실제 대리점명';
  const cb=el('input');cb.type='checkbox';cb.checked=anyAgency;cb.disabled=busy;cb.addEventListener('change',()=>{vessel=vf.input.value;agency=af.input.value;anyAgency=cb.checked;confirmation=null;render();});const label=el('label','대리점 무관 (기본)');label.prepend(cb);af.wrap.append(label);
  const advanced=el('details');advanced.open=!anyAgency;advanced.append(el('summary','대리점 제한 (선택)'),af.wrap);form.append(advanced);section.append(form);
  const actions=el('div',undefined,'row');actions.append(button('➕ 감시선박 등록',()=>{vessel=vf.input.value;agency=af.input.value;reviewAdd();}),button('현재 일정에서 검색',()=>{search=vf.input.value.trim();void call('jsttSearch',{search,page:0});}));section.append(actions,el('small','검색 결과가 없어도 선박명으로 바로 등록할 수 있습니다. 이후 일정에 정확한 이름이 나타나면 감시합니다.','muted'));root.append(section);
  if(confirmation){const box=el('section',undefined,'review');box.append(el('h2',confirmation.action==='add'?'감시 추가 확인':'감시 삭제 확인'),el('p',`${confirmation.vessel} / ${confirmation.agency??'대리점 무관'}`));box.append(button('✅ 확정',()=>call(confirmation.action==='add'?'jsttAdd':'jsttRemove',{confirm:true,vessel:confirmation.vessel,agency:confirmation.agency,watchId:confirmation.id})),button('취소',()=>{confirmation=null;render();}));root.append(box);}
  root.append(el('h2',view==='watchlist'?'특정선박 감시목록':view==='changes'?'최근 부두 변경':view==='search'?'JSTT 선박 검색 결과':'현재 감시대상 부두현황'));
  for(const r of state.rows??[]){const card=el('section');card.append(el('h3',r.vessel_name),el('p',r.agency_name??'대리점 무관'));
   if(view==='watchlist'){card.append(el('p',r.matched?'현재 일정 확인됨':'현재 일정 없음 / 사이트 일치 확인 전'),button('감시삭제',()=>{confirmation={action:'remove',id:r.id,vessel:r.vessel_name,agency:r.agency_name};render();}));}
   else if(view==='changes')card.append(el('p',`${berthLabel(r.old_berth??'UNASSIGNED')} → ${berthLabel(r.new_berth)}`));
   else{const detail=el('p',`${berthDetail(r)}${r.missing_count?' · 조회 누락 확인 중':''}`);detail.style.whiteSpace='pre-line';card.append(el('p',dateLabel(r.schedule_datetime)),detail);if(view==='search')card.append(button('이 선박 선택',()=>{vessel=r.vessel_name;confirmation=null;render();}));}
   root.append(card);
  }
  if(!state.rows?.length){
   root.append(el('p',view==='search'?'수집된 일정에 검색 결과가 없습니다. 선박명만 알면 미리 감시등록할 수 있습니다.':view==='watchlist'?'등록된 감시선박이 없습니다. 위에 선박명을 입력하고 감시선박 등록을 누르세요.':'해당 일정/기록이 없습니다.'));
   if(view==='search'&&search)root.append(button(`➕ ${search} 감시등록`,()=>{vessel=search;reviewAdd();}));
  }
  if(view!=='changes'){const paging=el('div',undefined,'row'),op=({current:'jsttCurrent',watchlist:'jsttWatchlist',search:'jsttSearch'})[view];if(state.page>0)paging.append(button('◀ 이전',()=>call(op,{page:state.page-1,search})));if((state.page+1)*10<state.total)paging.append(button('다음 ▶',()=>call(op,{page:state.page+1,search})));root.append(paging);}
  if(onBack)root.append(button('도선등록 화면으로',onBack));
 }
 render();void call('jsttCurrent',reference?{reference}:{});
 return {refresh:()=>call('jsttCurrent')};
}
