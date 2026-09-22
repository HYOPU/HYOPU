// Scope by the observed schedule filter, never by a calendar's role=grid.
export async function armJsttQuery(page) {
  await page.evaluate(()=>{
    const locate=()=>document.querySelector('input[aria-label="VESSEL_NM_Filter"]')?.closest('[role="grid"]');
    const first=locate();if(!first)throw Error('JSTT_GRID_INVALID');
    const marker=g=>g?[...g.querySelectorAll('tr.e-row')].map(r=>r.getAttribute('data-uid')).join('|')
      ||(g.querySelector('.e-emptyrow')?'EMPTY':'LOADING'):'LOADING';
    const initial=marker(first);let previous=first,previousMarker=initial,activity=0;
    // Blazor may replace the grid root. Observing/capturing only the old root
    // then waits forever even though the new grid has finished loading.
    const observer=new MutationObserver(records=>{
      const current=locate(),next=marker(current);
      if(current!==previous||next!==previousMarker||records.some(r=>current?.contains(r.target))){
        activity=Date.now();previous=current;previousMarker=next;
      }
    });
    observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});
    window.__jsttQueryStatus=()=>{
      const current=locate(),next=marker(current);
      return {changed:!!current&&(current!==first||next!==initial),loaded:next!=='LOADING',
        quiet:activity>0&&Date.now()-activity>=750,
        busy:!!current&&[...current.querySelectorAll('.e-spinner-pane')].some(e=>!e.classList.contains('e-spin-hide')&&getComputedStyle(e).display!=='none')};
    };
  });
}
export async function waitJsttQuery(page) {
  try{
    await page.waitForFunction(()=>{
      const s=window.__jsttQueryStatus();return s.changed&&s.loaded&&s.quiet&&!s.busy;
    });
  }catch{
    const s=await page.evaluate(()=>window.__jsttQueryStatus()).catch(()=>null);
    if(!s)throw Error('JSTT_QUERY_UNAVAILABLE');
    if(!s.changed)throw Error('JSTT_QUERY_NOT_REBOUND');
    if(!s.loaded||s.busy)throw Error('JSTT_QUERY_BUSY');
    throw Error('JSTT_QUERY_NOT_SETTLED');
  }
}
