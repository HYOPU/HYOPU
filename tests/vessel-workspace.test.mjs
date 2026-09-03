// No browser, HTTP request, file output, or backend write is performed.
import test from 'node:test';
import assert from 'node:assert/strict';
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
