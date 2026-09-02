import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { read } from 'xlsx';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { exportSof } from '../sof-export.mjs';

const template = fs.readFileSync(new URL('../templates/agent-sof.xlsx', import.meta.url));
const xml = { DOMParser, XMLSerializer };
const parse = value => new DOMParser().parseFromString(value, 'application/xml');
const all = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
const text = (zip, path) => strFromU8(zip[path]);
const doc = (zip, path) => parse(text(zip, path));
const cell = (document, address) => all(document, 'c').find(item => item.getAttribute('r') === address);
const attributes = element => Array.from(element?.attributes || []).map(item => [item.name, item.value]).sort();
const templateZip = unzipSync(template);
const templateSheet = doc(templateZip, 'xl/worksheets/sheet1.xml');
const report = () => ({
  fields: { vessel: 'TEST SHIP', voyage: 'TEST 1', port: 'ULSAN', charterer: 'TEST CHARTERER' },
  groups: [{
    sheetName: 'P42', berth: 'P#42', operation: 'DISCH',
    arrival: '2026-03-18T20:00', pilotIn: '2026-03-19T12:00', berthAt: '2026-03-19T13:00',
    pilotOut: '2026-03-22T06:00', leftBerth: '2026-03-22T07:00', remarks: [],
    cargo: [{ number: '117', name: 'METHANOL', tank: '1W,2W', bl: 5000, ship: null,
      hoseOn: '2026-03-19T18:30', commenced: '2026-03-19T20:30', completed: '2026-03-20T15:25', hoseOff: '2026-03-20T16:00' }],
  }],
});
const exported = (value = report(), source = template) => {
  const bytes = exportSof(source, value, xml);
  return { bytes, zip: unzipSync(bytes), workbook: read(bytes, { type: 'array', cellStyles: true }) };
};
const serial = value => (Date.parse(value + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000;
function resolvePart(source, target) {
  const result = [];
  for (const component of (target.startsWith('/') ? target.slice(1) : source.slice(0, source.lastIndexOf('/') + 1) + target).split('/')) {
    if (component === '..') result.pop();
    else if (component && component !== '.') result.push(component);
  }
  return result.join('/');
}

test('reference company name, Arial Black 23pt and original logo bytes are retained', () => {
  const { zip, workbook } = exported();
  assert.equal(workbook.Sheets.P42.A2.v, '      HYOP WOON SHIPPING LTD.');
  assert.deepEqual(zip['xl/styles.xml'], templateZip['xl/styles.xml']);
  assert.deepEqual(zip['xl/theme/theme1.xml'], templateZip['xl/theme/theme1.xml']);
  const styles = doc(zip, 'xl/styles.xml');
  const styleIndex = Number(cell(templateSheet, 'A2').getAttribute('s'));
  const xf = all(all(styles, 'cellXfs')[0], 'xf')[styleIndex];
  const font = all(all(styles, 'fonts')[0], 'font')[Number(xf.getAttribute('fontId'))];
  assert.equal(all(font, 'name')[0].getAttribute('val'), 'Arial Black');
  assert.equal(all(font, 'sz')[0].getAttribute('val'), '23');
  const media = Object.keys(zip).filter(path => /^xl\/media\//.test(path));
  assert.equal(media.length, 1, 'only the company logo, never a seal or signature');
  assert.equal(createHash('sha256').update(zip[media[0]]).digest('hex'), 'ff5713f0cf0c2f6ed2e1686b59f44126046a0bcde2735380606703389119ab91');
  assert.ok(!Object.keys(zip).some(path => /vbaProject|externalLink|comments|printerSettings/i.test(path)));
});

test('native fonts/style IDs, row heights, column widths, merges and print setup are unchanged', () => {
  const { zip } = exported();
  const sheet = doc(zip, 'xl/worksheets/sheet1.xml');
  for (const tag of ['cols', 'sheetFormatPr', 'sheetPr', 'pageMargins', 'pageSetup', 'mergeCells']) {
    const baseline = all(templateSheet, tag)[0];
    const actual = all(sheet, tag)[0];
    assert.equal(new XMLSerializer().serializeToString(actual), new XMLSerializer().serializeToString(baseline), tag);
  }
  assert.deepEqual(all(sheet, 'row').map(attributes), all(templateSheet, 'row').map(attributes));
  for (const original of all(templateSheet, 'c')) {
    assert.equal(cell(sheet, original.getAttribute('r'))?.getAttribute('s'), original.getAttribute('s'), original.getAttribute('r'));
  }
  for (const merge of all(sheet, 'mergeCell')) {
    const [anchor, end = anchor] = merge.getAttribute('ref').split(':');
    const index = address => address.replace(/\d/g, '').split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
    for (const entry of all(sheet, 'c')) {
      const address = entry.getAttribute('r');
      const row = Number(address.match(/\d+$/)[0]);
      if (address === anchor || index(address) < index(anchor) || index(address) > index(end) || row < Number(anchor.match(/\d+$/)[0]) || row > Number(end.match(/\d+$/)[0])) continue;
      assert.equal(entry.textContent, '', `value hidden in merged child ${address}`);
    }
  }
});

test('DISCH B/L 5,000 is typed numeric and absent SHIP stays blank with its heading visible', () => {
  const { workbook } = exported();
  const sheet = workbook.Sheets.P42;
  assert.equal(sheet.G21.v, 'DISCH');
  assert.equal(sheet.I21.v, 'DISCH');
  assert.equal(sheet.O20.v, 'SHIP');
  assert.equal(sheet.O21.v, 'FIG M/T');
  assert.equal(sheet.N22.v, 5000);
  assert.equal(sheet.N22.t, 'n');
  assert.equal(sheet.O22?.v ?? null, null);
  const source = report();
  source.groups[0].cargo[0].ship = 4999.25;
  const withShip = exported(source).workbook.Sheets.P42;
  assert.equal(withShip.O22.v, 4999.25);
  assert.equal(withShip.O22.t, 'n');
});

test('DATE uses the latest group HOSE OFF, not departure or reference sample dates', () => {
  const source = report();
  source.groups[0].sheetDate = serial('2026-01-01');
  source.groups[0].cargo.push({ ...source.groups[0].cargo[0], number: '118', hoseOff: '2026-03-21T02:30' });
  assert.equal(exported(source).workbook.Sheets.P42.N6.v, serial('2026-03-21'));
  source.groups[0].cargo.reverse();
  assert.equal(exported(source).workbook.Sheets.P42.N6.v, serial('2026-03-21'));
});

test('missing HOSE OFF leaves DATE empty unless the imported workbook supplied an explicit DATE', () => {
  const source = report();
  source.groups[0].cargo[0].hoseOff = '';
  assert.equal(exported(source).workbook.Sheets.P42.N6?.v ?? null, null);
  source.groups[0].sheetDate = serial('2026-03-17');
  assert.equal(exported(source).workbook.Sheets.P42.N6.v, serial('2026-03-17'));
});

test('optional shipper/consignee and line fields remain visible without writing into merged children', () => {
  const source = report();
  source.groups[0].cargo[0].party = 'EXAMPLE CONSIGNEE';
  source.groups[0].cargo[0].line = 'LINE 3';
  const sheet = exported(source).workbook.Sheets.P42;
  assert.equal(sheet.B38.v, 'CGO#117 SHIPPER/CONSIGNEE: EXAMPLE CONSIGNEE');
  assert.equal(sheet.B39.v, 'CGO#117 LINE NO: LINE 3');
  assert.equal(sheet.D22?.v ?? null, null);
  assert.equal(sheet.E22?.v ?? null, null);
});

test('every normal and continuation sheet retains a working independent logo drawing', () => {
  const source = report();
  source.groups[0].cargo = Array.from({ length: 7 }, (_, i) => ({ ...source.groups[0].cargo[0], number: String(117 + i) }));
  source.groups[0].remarks = Array.from({ length: 19 }, (_, i) => `Remark ${i}`);
  const { zip, workbook } = exported(source);
  assert.deepEqual(workbook.SheetNames, ['P42', 'P42 cont 2']);
  assert.equal(workbook.Sheets['P42 cont 2'].A24.v, 123);
  assert.equal(workbook.Sheets['P42 cont 2'].B42.v, 'Remark 18');
  assert.equal(workbook.Sheets['P42 cont 2'].A26?.v ?? null, null);
  const drawingParts = new Set();
  for (let i = 1; i <= 2; i++) {
    const sheetPath = `xl/worksheets/sheet${i}.xml`;
    const sheet = doc(zip, sheetPath);
    const relationships = doc(zip, `xl/worksheets/_rels/sheet${i}.xml.rels`);
    const id = all(sheet, 'drawing')[0].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const relationship = all(relationships, 'Relationship').find(item => item.getAttribute('Id') === id);
    assert.ok(relationship, `drawing r:id resolves on sheet ${i}`);
    const part = resolvePart(sheetPath, relationship.getAttribute('Target'));
    assert.ok(zip[part]);
    drawingParts.add(part);
    assert.deepEqual(zip[part], templateZip['xl/drawings/drawing1.xml']);
    const slash = part.lastIndexOf('/');
    const drawingRels = doc(zip, `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`);
    const drawing = doc(zip, part);
    const blips = all(drawing, 'blip');
    assert.equal(blips.length, 1);
    for (const blip of blips) {
      const imageId = blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
      const imageRel = all(drawingRels, 'Relationship').find(item => item.getAttribute('Id') === imageId);
      assert.ok(zip[resolvePart(part, imageRel.getAttribute('Target'))]);
    }
    const defined = all(doc(zip, 'xl/workbook.xml'), 'definedName').find(item => item.getAttribute('localSheetId') === String(i - 1));
    assert.equal(defined.textContent, `'${workbook.SheetNames[i - 1]}'!$A$1:$P$58`);
  }
  assert.equal(drawingParts.size, 2);
});

test('unused cargo/remark cells are cleared without deleting their native styles', () => {
  const dirty = unzipSync(template);
  const sheet = doc(dirty, 'xl/worksheets/sheet1.xml');
  for (const address of ['A30', 'A31', 'N30', 'B50', 'B56']) {
    const entry = cell(sheet, address);
    entry.setAttribute('t', 'inlineStr');
    const value = sheet.createElementNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'is');
    const run = sheet.createElementNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 't');
    run.textContent = 'STALE SAMPLE DATA';
    value.appendChild(run);
    entry.appendChild(value);
  }
  dirty['xl/worksheets/sheet1.xml'] = strToU8(new XMLSerializer().serializeToString(sheet));
  const { zip } = exported(report(), zipSync(dirty));
  assert.ok(!text(zip, 'xl/worksheets/sheet1.xml').includes('STALE SAMPLE DATA'));
  const clean = doc(zip, 'xl/worksheets/sheet1.xml');
  assert.equal(cell(clean, 'N30').getAttribute('s'), cell(templateSheet, 'N30').getAttribute('s'));
});

test('long remark text continues through additional rows/pages without truncation or font shrinkage', () => {
  const source = report();
  source.groups[0].remarks = Array.from({ length: 15 }, (_, i) => `${i}: ${'LONG REMARK '.repeat(25).trim()}`);
  const { workbook, zip } = exported(source);
  const lines = workbook.SheetNames.flatMap(name => Array.from({ length: 14 }, (_, i) => workbook.Sheets[name][`B${38 + i}`]?.v).filter(Boolean));
  assert.equal(lines.join(' '), source.groups[0].remarks.join(' '));
  assert.ok(lines.every(line => line.length <= 140));
  assert.ok(workbook.SheetNames.length > 1);
  assert.deepEqual(zip['xl/styles.xml'], templateZip['xl/styles.xml']);
});
