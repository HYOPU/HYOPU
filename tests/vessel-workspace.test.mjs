// No browser, HTTP request, file output, or backend write is performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { utils, write } from 'xlsx';
import { createVesselWorkspace } from '../vessel-workspace.mjs';
import { blankCall } from '../operations-model.mjs';

function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
}

function harness(reload) {
  const callbacks = {};
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, innerHTML: '', textContent: '', dataset: {},
      classList: { toggle() {} },
      insertAdjacentHTML() {},
      querySelector: selector => node(selector),
      querySelectorAll: () => [],
      addEventListener: (name, callback) => { callbacks[name] = callback; },
      showModal() { this.open = true; },
      close() { this.open = false; },
    });
    return nodes.get(id);
  };
  const previousGlobals = Object.fromEntries(['document', 'window', 'location'].map(key => [key, globalThis[key]]));
  const dialog = node('#vessel-dialog');
  globalThis.document = { querySelector: selector => node(selector), activeElement: null };
  globalThis.window = { confirm: () => true, addEventListener(name,callback) {callbacks[`window:${name}`]=callback;} };
  globalThis.location = { origin: 'https://review.invalid' };
  const calls = {
    A: { ...blankCall('A'), vessel: 'ALPHA', voyage: 'V1', etaRaw: '09/03', revision: 1 },
    B: { ...blankCall('B'), vessel: 'BETA', voyage: 'V2', etaRaw: '09/04', revision: 1 },
  };
  let saved;
  const messages=[];
  const frame=node('#sof-frame');frame.contentWindow={postMessage(message){messages.push(message);}};
  const workspace = createVesselWorkspace({
    confirmDiscard:async()=>true,
    getCall: (id, refresh) => refresh ? reload.promise : calls[id],
    getSession: () => ({ authenticated: true, member: { role: 'editor' } }),
    saveCall: async call => { saved = structuredClone(call); return call; },
    onSaved() {},
  });
  return {
    workspace, calls, dialog, callbacks, messages,
    click: (id,dataset={},classes=[]) => callbacks.click({ target: { closest: () => ({ id, dataset, classList:{contains:name=>classes.includes(name)} }) } }),
    ready: () => callbacks['window:message']({origin:'https://review.invalid',source:frame.contentWindow,data:{type:'hyopu:sof-ready'}}),
    raw: text => callbacks['window:message']({origin:'https://review.invalid',source:frame.contentWindow,data:{type:'hyopu:sof-raw',callId:'A',raw:text}}),
    editNotes: value => callbacks.input({ target: { dataset: { field: 'notes' }, value, type: 'text' } }),
    editCargo: (key, value) => callbacks.input({ target: { dataset: { list: 'cargo', index: '0', key }, value, type: 'text' } }),
    changeFile: file => {
      const target={id:'vcr-file',files:[file],value:file.name};
      return Promise.resolve(callbacks.change({target})).then(()=>target);
    },
    get saved() { return saved; },
    restore() {
      for (const [key, value] of Object.entries(previousGlobals)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

test('a delayed reload of A cannot turn the visible B editor into an A draft', async () => {
  const reload = deferred();
  const app = harness(reload);
  try {
    await app.workspace.open('A');
    const pending = app.click('reload-call');
    await app.workspace.open('B');
    const switchedImmediately = app.dialog.innerHTML.includes('BETA');
    reload.resolve({ ...app.calls.A, notes: 'Response for A only' });
    await pending;
    // Both safe implementations are accepted: lock navigation while loading,
    // or allow navigation but reject the obsolete A response by generation/id.
    if (!switchedImmediately) await app.workspace.open('B');
    assert.ok(app.dialog.innerHTML.includes('BETA'));
    app.editNotes('Intended for B');
    await app.click('save-call');
    assert.equal(app.saved.id, 'B');
    assert.equal(app.saved.vessel, 'BETA');
    assert.equal(app.saved.notes, 'Intended for B');
  } finally { app.restore(); }
});

test('new raw report from the single SOF workspace replaces an old SOF snapshot',async()=>{
  const app=harness(deferred());
  try{
    app.calls.A.sof={fields:{vessel:'ALPHA',voyage:'V1',port:'ULSAN',charterer:''},groups:[],warnings:[]};
    app.calls.A.latestReport='old report';app.workspace.open('A');
    await app.click('sof',{tab:'sof'});app.ready();assert.equal(app.messages.at(-1).report.fields.vessel,'ALPHA');
    app.raw('new report');app.ready();
    assert.equal(app.messages.at(-1).report,null);assert.equal(app.messages.at(-1).raw,'new report');
  }finally{app.restore();}
});
test('SOF context expands an S. vessel name and retains the current voyage',async()=>{
  const app=harness(deferred());
  try{
    app.calls.A.vessel='S.PERSEVERANCE';app.calls.A.voyage='HBR 131';
    await app.workspace.open('A');await app.click('sof',{tab:'sof'});app.ready();
    assert.equal(app.messages.at(-1).fields.vessel,'STOLT PERSEVERANCE');
    assert.equal(app.messages.at(-1).fields.voyage,'HBR 131');
  }finally{app.restore();}
});
test('raw text typed inside SOF survives a tab change without prematurely overwriting old analysis',async()=>{
  const app=harness(deferred());
  try{app.workspace.open('A');await app.click('sof',{tab:'sof'});app.raw('typed draft');await app.click('overview',{tab:'overview'});await app.click('sof',{tab:'sof'});app.ready();assert.equal(app.messages.at(-1).raw,'typed draft');assert.equal(app.messages.at(-1).report,null);}finally{app.restore();}
});
test('vessel changes are automatically saved after a short idle delay',async()=>{
  const app=harness(deferred());
  try{
    await app.workspace.open('A');app.editNotes('Saved without a login step');
    await new Promise(resolve=>setTimeout(resolve,850));
    assert.equal(app.saved?.notes,'Saved without a login step');
  }finally{app.restore();}
});

test('changing a proforma berth refreshes its known maximum draft before auto-save', async () => {
  const app=harness(deferred());
  try {
    app.calls.A.cargo=[{operation:'DISCH',number:'150',name:'METHANOL',bl:'100.000',ship:'',tanks:'1P',party:'RECEIVER',berth:'P#42',maxDraft:'',coaster:'',note:''}];
    await app.workspace.open('A');
    await app.click('proforma',{tab:'proforma'});
    assert.match(app.dialog.querySelector('#detail-panel').innerHTML,/MAX DRAFT/);
    assert.match(app.dialog.querySelector('#detail-panel').innerHTML,/10\.20M/);
    app.editCargo('berth','JSTT SP#5');
    await new Promise(resolve=>setTimeout(resolve,850));
    assert.equal(app.saved?.cargo[0].berth,'JSTT SP#5');
    assert.equal(app.saved?.cargo[0].maxDraft,'12.35M');
  } finally { app.restore(); }
});

test('a Discharging VCR XLSX file is parsed in the vessel cargo workspace', async () => {
  const app=harness(deferred());
  try {
    const rows=[
      ['Voyage Cargo Report - Discharging'],[],
      ['Discharge Port','Discharge Berth','Port ETA','Code','Cargo Name','Discharge Qty (MT)','Charterer','Tanks','Load Port - Berth(s)'],
      ['ULSAN','P-62','10-Aug-2026','cs (13)','CARBITOL SOLVENT LOW G',208.928,'THE DOW CHEMICAL COMPANY','5C','BATON ROUGE - VPK PLAQ 1'],
      ['ULSAN','JSTT2','10-Aug-2026','po (134)','PROPYLENE OXIDE',1503.829,'LYONDELL','8P, 8S','FREEPORT - BASF'],
      ['YOKOHAMA','ANCHORAGE','12-Aug-2026','115','OTHER CARGO',500,'OTHER','1P','ULSAN - P-62'],
    ];
    const workbook=utils.book_new();
    utils.book_append_sheet(workbook,utils.aoa_to_sheet(rows),'Discharge-Schedule');
    const buffer=write(workbook,{bookType:'xlsx',type:'buffer'});
    const file={
      name:'VCR_STOLT CONFIDENCE_196_Discharging_10-Aug-2026.xlsx',
      size:buffer.byteLength,
      arrayBuffer:async()=>buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength),
    };
    await app.workspace.open('A');
    await app.click('cargo',{tab:'cargo'});
    const input=await app.changeFile(file);
    assert.equal(input.value,'');
    await new Promise(resolve=>setTimeout(resolve,850));
    assert.equal(app.saved?.vcrFileName,file.name);
    assert.deepEqual(app.saved?.cargo.map(item=>[item.operation,item.number,item.bl,item.ship,item.berth]),[
      ['DISCH','cs (13)','208.928','','P-62'],
      ['DISCH','po (134)','1503.829','','JSTT2'],
    ]);
  } finally { app.restore(); }
});
