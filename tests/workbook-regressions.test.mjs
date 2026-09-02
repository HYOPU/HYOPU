import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { read } from 'xlsx';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parseReport } from '../sof-parser.mjs';
import { importWorkbook } from '../sof-workbook.mjs';
import { exportSof } from '../sof-export.mjs';

const template = fs.readFileSync(new URL('../templates/agent-sof.xlsx', import.meta.url));
const fixture = name => parseReport(fs.readFileSync(new URL(`fixtures/${name}.txt`, import.meta.url), 'utf8'));
const exportWorkbook = report => read(exportSof(template, report, { DOMParser, XMLSerializer }), { type: 'array' });
const remarks = workbook => workbook.SheetNames.flatMap(name => Array.from({ length: 14 }, (_, i) => workbook.Sheets[name][`B${38 + i}`]?.v).filter(Boolean));

test('remarks-only continuation sheets survive upload/download with all party and line annotations', () => {
  const source = fixture('kashi');
  const group = source.groups[0];
  group.cargo = group.cargo.slice(0, 1);
  group.cargo[0].party = 'TEST PARTY';
  group.cargo[0].line = 'TEST LINE';
  group.remarks = Array.from({ length: 19 }, (_, i) => `Important remark ${i}`);
  const original = exportWorkbook(source);
  assert.deepEqual(original.SheetNames, ['P42', 'P42 cont 2']);
  const imported = importWorkbook(original);
  assert.deepEqual(imported.groups.map(item => item.sheetName), original.SheetNames);
  assert.deepEqual(imported.groups.map(item => item.cargo.length), [1, 0]);
  assert.equal(imported.groups[1].remarks.length, 7);
  const second = exportWorkbook(imported);
  assert.deepEqual(second.SheetNames, original.SheetNames);
  assert.deepEqual(remarks(second), remarks(original));
  assert.equal(remarks(second).length, 21);
  assert.ok(remarks(second).includes('CGO#602 SHIPPER/CONSIGNEE: TEST PARTY'));
  assert.ok(remarks(second).includes('CGO#602 LINE NO: TEST LINE'));
  for (const name of original.SheetNames) {
    assert.equal(second.Sheets[name].N6.v, original.Sheets[name].N6.v, `DATE on ${name}`);
    assert.equal(second.Sheets[name].B6.v, original.Sheets[name].B6.v, `VESSEL on ${name}`);
    assert.equal(second.Sheets[name].G14.v, original.Sheets[name].G14.v, `BERTH on ${name}`);
  }
});

test('meaningful remarks-only sheets keep their own names without inferring a berth merge', () => {
  const source = fixture('kashi');
  source.groups.push({ ...source.groups[0], sheetName: 'Separate berth record', cargo: [], remarks: ['Independent port-call note'], sheetDate: 46240 });
  const original = exportWorkbook(source);
  const imported = importWorkbook(original);
  assert.deepEqual(imported.groups.map(group => group.sheetName), ['P42', 'Separate berth record']);
  assert.deepEqual(imported.groups[1].cargo, []);
  assert.deepEqual(imported.groups[1].remarks, ['Independent port-call note']);
  assert.deepEqual(exportWorkbook(imported).SheetNames, original.SheetNames);
});

test('empty template worksheets are still ignored', () => {
  const empty = importWorkbook(read(template, { type: 'buffer' }));
  assert.equal(empty.groups.length, 0);
  assert.equal(empty.cargo.length, 0);
});

for (const [name, groups, cargo] of [['betula', 4, 7], ['kashi', 1, 2], ['larix', 8, 10]]) {
  test(`${name}: existing normal-sheet group and cargo counts remain unchanged`, () => {
    const imported = importWorkbook(exportWorkbook(fixture(name)));
    assert.equal(imported.groups.length, groups);
    assert.equal(imported.cargo.length, cargo);
  });
}
