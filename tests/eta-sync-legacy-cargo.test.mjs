import test from 'node:test';
import assert from 'node:assert/strict';
import { syncEtaRows } from '../lib/eta-sync.js';

const legacyCargo={operation:'DISCH',number:'150',name:'METHYL CARBITOL',bl:'787.998',ship:'',tanks:'5P',party:'THE DOW CHEMICAL COMPANY',note:'VCR · ULSAN / P-63'};
const source=[{vessel:'S.FOCUS',voyage:'TPW 94',port:'ULSAN',etaRaw:'09/15 1700',remark:'',etdRaw:'',pic:'JAE LEE'}];

test('ETA clipboard sync preserves legacy VCR cargo that predates the MAX DRAFT field', async () => {
  let written=[];
  const request=async (path, options={}) => {
    if(!options.method) return { ok:true, json:async()=>[{id:'eta-2026-021',revision:3,data:{...source[0],id:'eta-2026-021',year:2026,status:'PRE-ARRIVAL',notes:'',activityNotes:'',proformaNotes:'',vcrFileName:'',latestReport:'',reportType:'DEP.REPORT',reportReceived:'',reportChecked:false,etaActive:true,activities:[],cargo:[legacyCargo],crew:[],tasks:[],sof:null,highlight:[]}}] };
    written=JSON.parse(options.body); return {ok:true,json:async()=>[]};
  };
  const result=await syncEtaRows(source,request,'2026-09-04T00:00:00.000Z');
  assert.equal(result.sourceRows,1);
  assert.equal(result.changed,0);
  assert.deepEqual(written,[]);
});
