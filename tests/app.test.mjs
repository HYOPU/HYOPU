import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { read } from 'xlsx';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const fixture = name => fs.readFileSync(new URL(`fixtures/${name}.txt`, import.meta.url), 'utf8');
const bundle = await build({
  absWorkingDir: root, entryPoints: ['app.js'], bundle: true,
  platform: 'browser', format: 'iife', write: false, metafile: true,
});
const appScript = new vm.Script(bundle.outputFiles[0].text, { filename: 'app.browser.bundle.js' });
const template = fs.readFileSync(path.join(root, 'templates/agent-sof.xlsx'));
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

function createApp({ templateStatus = 200, saveResponse = { ok: true, body: { saved: true } } } = {}) {
  const ids = new Map();
  const requests = [];
  const downloads = [];
  const blobs = new Map();
  const errors = [];
  const timers = [];
  const bodyChildren = new Set();
  let reloads = 0;

  function element(tagName, attributes = '') {
    const listeners = new Map();
    const classes = new Set(attributes.match(/\bclass="([^"]*)"/)?.[1].split(/\s+/).filter(Boolean) || []);
    return {
      tagName, value: '', textContent: '', innerHTML: '', dataset: {}, files: [],
      checked: /(?:^|\s)checked(?:\s|=|$)/.test(attributes),
      disabled: /(?:^|\s)disabled(?:\s|=|$)/.test(attributes),
      classList: {
        add(...values) { values.forEach(value => classes.add(value)); },
        remove(...values) { values.forEach(value => classes.delete(value)); },
        contains(value) { return classes.has(value); },
      },
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      async dispatch(type, event = {}) {
        const value = { target: this, preventDefault() {}, ...event };
        for (const handler of listeners.get(type) || []) await handler(value);
      },
      click() {
        if (this.tagName === 'a') downloads.push({ filename: this.download, blob: blobs.get(this.href) });
        return this.onclick?.({ target: this });
      },
      remove() { bodyChildren.delete(this); },
    };
  }

  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    assert.ok(!ids.has(match[3]), `Duplicate HTML id: ${match[3]}`);
    ids.set(match[3], element(match[1].toLowerCase(), match[2]));
  }
  const document = {
    querySelector(selector) {
      assert.match(selector, /^#[\w-]+$/, 'The test DOM only permits actual HTML IDs');
      assert.ok(ids.has(selector.slice(1)), `Application references missing HTML element ${selector}`);
      return ids.get(selector.slice(1));
    },
    createElement(tagName) {
      assert.equal(tagName, 'a');
      return element(tagName);
    },
    body: { append(node) { bodyChildren.add(node); } },
  };
  const context = vm.createContext({
    document, DOMParser, XMLSerializer, Blob, TextEncoder, TextDecoder,
    Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array,
    ArrayBuffer, DataView,
    console: { error(...args) { errors.push(args); }, log() {}, info() {}, warn() {} },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {},
    location: { reload() { reloads++; } },
    URL: {
      createObjectURL(blob) { const url = `blob:sof-test-${blobs.size}`; blobs.set(url, blob); return url; },
      revokeObjectURL(url) { blobs.delete(url); },
    },
    async fetch(url, options = {}) {
      requests.push({ url, ...options });
      if (url === './templates/agent-sof.xlsx') return {
        ok: templateStatus >= 200 && templateStatus < 300, status: templateStatus,
        arrayBuffer: async () => arrayBuffer(template),
      };
      assert.equal(url, '/api/documents', 'Unexpected network request from app bundle');
      return { ...saveResponse, json: async () => saveResponse.body };
    },
  });
  context.window = context;
  context.self = context;
  appScript.runInContext(context);
  return {
    get: id => document.querySelector(`#${id}`), context, requests, downloads, errors, timers, bodyChildren,
    get reloads() { return reloads; },
    async paste(text) { ids.get('report-text').value = text; await ids.get('parse-text').click(); },
  };
}

function cargoInput(app, group, cargo, key) {
  const rendered = new DOMParser().parseFromString(`<main>${app.get('sheets').innerHTML}</main>`, 'text/html');
  const input = Array.from(rendered.getElementsByTagName('input')).find(node =>
    node.getAttribute('data-g') === String(group) && node.getAttribute('data-c') === String(cargo) && node.getAttribute('data-key') === key);
  assert.ok(input, `Missing rendered cargo field ${group}/${cargo}/${key}`);
  return input.getAttribute('value');
}

async function downloadedWorkbook(app) {
  assert.equal(app.downloads.length, 1);
  assert.ok(app.downloads[0].blob instanceof Blob);
  assert.equal(app.downloads[0].blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return read(await app.downloads[0].blob.arrayBuffer(), { type: 'array' });
}

test('actual app bundle binds only existing HTML elements and needs no CDN globals', () => {
  const app = createApp();
  assert.equal(typeof app.get('parse-text').onclick, 'function');
  assert.equal(typeof app.get('report-file').onchange, 'function');
  assert.equal(typeof app.get('download').onclick, 'function');
  assert.equal(app.context.XLSX, undefined);
  assert.equal(app.context.fflate, undefined);
  assert.ok(!/<script[^>]+src=["']https?:/i.test(html));
  assert.match(html, /<script\s+type="module"\s+src="\.\/app\.js"/);
  assert.ok(Object.keys(bundle.metafile.inputs).some(name => name.endsWith('sof-parser.mjs')));
  assert.ok(Object.keys(bundle.metafile.inputs).some(name => name.endsWith('sof-export.mjs')));
  assert.ok(Object.values(bundle.metafile.outputs).every(output => output.imports.length === 0));
  assert.equal(app.requests.length, 0);
  assert.equal(app.errors.length, 0);
});

for (const [name, groups, cargo] of [['betula', 4, 7], ['kashi', 1, 2], ['larix', 8, 10]]) {
  test(`real analyze click renders ${name}: ${groups} groups and ${cargo} cargoes`, async () => {
    const app = createApp();
    assert.ok(app.get('review-panel').classList.contains('hidden'));
    await app.paste(fixture(name));
    assert.ok(app.get('upload-panel').classList.contains('hidden'));
    assert.ok(!app.get('review-panel').classList.contains('hidden'));
    assert.equal(app.get('sheet-count').textContent, `${groups}개 작업 시트 · ${cargo}개 화물`);
    assert.equal((app.get('sheets').innerHTML.match(/class="sof-sheet"/g) || []).length, groups);
    assert.equal(app.get('download').disabled, false);
    assert.match(app.get('status').textContent, /분석 완료/);
    assert.equal(app.errors.length, 0);
    assert.equal(app.requests.length, 0);
  });
}

test('DISCH UI retains B/L 5000 and separate unknown, explicit, and zero SHIP figures', async () => {
  const app = createApp();
  await app.paste(fixture('larix'));
  assert.equal(cargoInput(app, 0, 0, 'bl'), '5000');
  assert.equal(cargoInput(app, 1, 0, 'bl'), '5000');
  assert.equal(cargoInput(app, 0, 0, 'ship'), '');
  assert.equal(cargoInput(app, 1, 0, 'ship'), '');
  assert.equal(cargoInput(app, 2, 0, 'bl'), '955.443');
  assert.equal(cargoInput(app, 2, 0, 'ship'), '954.873');
  const withZero = fixture('larix').replace(/(\(DISCH\) CGO#117[^\n]*)/, '$1\n*SHIP FIG M/T: 0.000 MT');
  await app.paste(withZero);
  assert.equal(cargoInput(app, 1, 0, 'bl'), '5000');
  assert.equal(cargoInput(app, 1, 0, 'ship'), '0');
  assert.equal(cargoInput(app, 0, 0, 'ship'), '');
});

test('empty and unrecognized pasted input produce helpful status instead of a dead button', async () => {
  const app = createApp();
  await app.paste('  \n\t');
  assert.match(app.get('status').textContent, /분석할 리포트를 붙여넣어 주세요/);
  assert.ok(app.get('review-panel').classList.contains('hidden'));
  assert.ok(!app.get('upload-panel').classList.contains('hidden'));
  await app.paste('Unrecognized report');
  assert.match(app.get('status').textContent, /화물을 찾지 못했습니다/);
  assert.equal(app.get('download').disabled, true);
  assert.equal(app.requests.length, 0);
  assert.equal(app.errors.length, 0);
});

test('TXT file onchange uses the real parser and clears the file input for retry', async () => {
  const app = createApp();
  const text = fixture('kashi');
  const input = app.get('report-file');
  input.files = [{ name: 'KASHI.TXT', size: Buffer.byteLength(text), text: async () => text }];
  input.value = 'KASHI.TXT';
  await input.onchange({ target: input });
  assert.equal(app.get('file-name').textContent, 'KASHI.TXT');
  assert.equal(app.get('sheet-count').textContent, '1개 작업 시트 · 2개 화물');
  assert.equal(input.value, '');
  assert.equal(app.errors.length, 0);
});

test('download click fetches the packaged template and exports real XLSX without default cloud POST', async () => {
  const app = createApp();
  await app.paste(fixture('kashi'));
  assert.equal(app.get('save-history').checked, false);
  await app.get('download').click();
  const workbook = await downloadedWorkbook(app);
  assert.deepEqual(workbook.SheetNames, ['P42']);
  const sheet = workbook.Sheets.P42;
  assert.equal(sheet.B6.v, 'M/T STOLT KASHI');
  assert.equal(sheet.N22.v, 1899.979);
  assert.equal(sheet.N22.t, 'n');
  assert.equal(sheet.O20.v, 'SHIP');
  assert.equal(sheet.O22?.v ?? null, null);
  assert.match(app.downloads[0].filename, /^SOF_STOLT_KASHI\.xlsx$/);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].url, './templates/agent-sof.xlsx');
  assert.match(app.get('status').textContent, /엑셀 다운로드 완료/);
  assert.equal(app.get('download').disabled, false);
  assert.equal(app.bodyChildren.size, 0);
  assert.equal(app.errors.length, 0);
});

test('edited B/L and SHIP remain independent, including explicit numeric zero in downloaded XLSX', async () => {
  const app = createApp();
  await app.paste(fixture('larix'));
  await app.get('review-panel').dispatch('input', { target: { dataset: { g: '1', c: '0', key: 'ship' }, value: '0' } });
  await app.get('review-panel').dispatch('input', { target: { dataset: { g: '1', c: '0', key: 'bl' }, value: '5,001.250' } });
  await app.get('download').click();
  const workbook = await downloadedWorkbook(app);
  assert.equal(workbook.Sheets.P63.N22.v, 5000);
  assert.equal(workbook.Sheets.P63.O22?.v ?? null, null);
  assert.equal(workbook.Sheets['JSTT SP5'].N22.v, 5001.25);
  assert.equal(workbook.Sheets['JSTT SP5'].O22.v, 0);
  assert.equal(workbook.Sheets['JSTT SP5'].O22.t, 'n');
});

test('XLSX upload uses bundled SheetJS and preserves every exported berth without CDN globals', async () => {
  const source = createApp();
  await source.paste(fixture('betula'));
  await source.get('download').click();
  const app = createApp();
  const input = app.get('report-file');
  const blob = source.downloads[0].blob;
  input.files = [{ name: 'BETULA.xlsx', size: blob.size, arrayBuffer: () => blob.arrayBuffer() }];
  await input.onchange({ target: input });
  assert.equal(app.context.XLSX, undefined);
  assert.equal(app.get('sheet-count').textContent, '4개 작업 시트 · 7개 화물');
  assert.equal(cargoInput(app, 3, 0, 'bl'), '1000.278');
  assert.equal(cargoInput(app, 3, 0, 'ship'), '998.664');
  assert.equal(app.errors.length, 0);
  assert.equal(app.requests.length, 0);
});

test('opted-in cloud save failure is visible and distinguished from successful local download', async () => {
  const app = createApp({ saveResponse: { ok: false, body: { saved: false, error: 'Supabase is not configured' } } });
  await app.paste(fixture('kashi'));
  app.get('save-history').checked = true;
  await app.get('download').click();
  await downloadedWorkbook(app);
  assert.equal(app.requests.length, 2);
  const request = app.requests[1];
  assert.equal(request.url, '/api/documents');
  assert.equal(request.method, 'POST');
  const body = JSON.parse(request.body);
  assert.equal(body.filename, 'SOF_STOLT_KASHI.xlsx');
  assert.equal(Buffer.from(body.fileBase64, 'base64').subarray(0, 2).toString(), 'PK');
  assert.match(app.get('status').textContent, /다운로드는 완료되었지만 클라우드 저장에 실패/);
  assert.match(app.get('status').textContent, /Supabase is not configured/);
  assert.equal(app.get('download').disabled, false);
  assert.equal(app.errors[0][0], '[sof:save] failed');
});

test('opted-in cloud save requires an explicit saved=true response', async () => {
  for (const saved of [true, false]) {
    const app = createApp({ saveResponse: { ok: true, body: { saved } } });
    await app.paste(fixture('kashi'));
    app.get('save-history').checked = true;
    await app.get('download').click();
    assert.equal(app.downloads.length, 1);
    assert.equal(app.requests.filter(request => request.method === 'POST').length, 1);
    if (saved) {
      assert.equal(app.get('status').textContent, '엑셀 다운로드 및 Supabase 저장 완료.');
      assert.equal(app.errors.length, 0);
    } else {
      assert.match(app.get('status').textContent, /클라우드 저장에 실패/);
      assert.match(app.get('status').textContent, /저장을 확인하지 못했습니다/);
    }
  }
});

test('failed template fetch reports generation failure and does not download or POST', async () => {
  const app = createApp({ templateStatus: 404 });
  await app.paste(fixture('kashi'));
  app.get('save-history').checked = true;
  await app.get('download').click();
  assert.equal(app.downloads.length, 0);
  assert.equal(app.requests.length, 1);
  assert.match(app.get('status').textContent, /엑셀 생성에 실패/);
  assert.match(app.get('status').textContent, /404/);
  assert.equal(app.get('download').disabled, false);
  assert.equal(app.errors[0][0], '[sof:export] failed');
});

test('production build includes every local HTML asset and the actual fetched XLSX template', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
  const builtHtml = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
  for (const match of builtHtml.matchAll(/(?:src|href)="(\.\/[^"?#]+)"/g)) {
    assert.ok(fs.statSync(path.join(root, 'dist', match[1])).size > 0, `Missing built asset ${match[1]}`);
  }
  const builtTemplate = fs.readFileSync(path.join(root, 'dist/templates/agent-sof.xlsx'));
  assert.equal(builtTemplate.subarray(0, 2).toString(), 'PK');
  assert.deepEqual(builtTemplate, fs.readFileSync(path.join(root, 'templates/agent-sof.xlsx')));
  assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(root, 'dist/app.js'), 'utf8')));
});
