// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {armJsttQuery,waitJsttQuery} from '../api/_jstt_berth_query.mjs';
const html=(id='row-1')=>`<div role="grid"><input aria-label="VESSEL_NM_Filter"><table><tbody><tr class="e-row" data-uid="${id}"><td>SHIP</td></tr></tbody></table><div class="e-spinner-pane e-spin-hide"></div></div>`;
const state=()=> (window as any).__jsttQueryStatus();
const page={evaluate:async(fn:any)=>fn()};
const flush=()=>new Promise(r=>setTimeout(r,0));
afterEach(()=>{vi.restoreAllMocks();document.body.innerHTML='';});
it('detects an entirely replaced grid even when row IDs are reused',async()=>{
 document.body.innerHTML=html();await armJsttQuery(page);
 document.body.innerHTML=html();await flush();
 expect(state()).toMatchObject({changed:true,loaded:true,busy:false});
});
it('detects row rebinding in the same grid and requires a quiet period',async()=>{
 document.body.innerHTML=html();await armJsttQuery(page);
 document.querySelector('tr')!.setAttribute('data-uid','row-2');await flush();
 expect(state()).toMatchObject({changed:true,quiet:false});
 const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+800);
 expect(state().quiet).toBe(true);
});
it('does not treat unrelated page changes or calendar grids as completion',async()=>{
 document.body.innerHTML='<div role="grid" aria-label="calendar"></div>'+html();await armJsttQuery(page);
 document.body.insertAdjacentHTML('beforeend','<p>unrelated clock</p>');await flush();
 expect(state().changed).toBe(false);
});
it.each([
 [{changed:false,loaded:true,quiet:true,busy:false},'JSTT_QUERY_NOT_REBOUND'],
 [{changed:true,loaded:true,quiet:true,busy:true},'JSTT_QUERY_BUSY'],
 [{changed:true,loaded:true,quiet:false,busy:false},'JSTT_QUERY_NOT_SETTLED'],
])('fails closed with safe diagnostics',async(s,code)=>{
 await expect(waitJsttQuery({waitForFunction:async()=>{throw Error('timeout')},evaluate:async()=>s})).rejects.toThrow(code);
});
