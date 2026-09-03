import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { read } from 'xlsx';
import { unzipSync } from 'fflate';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parseReport, displayTime } from '../sof-parser.mjs';
import * as parser from '../sof-parser.mjs';
import { importWorkbook } from '../sof-workbook.mjs';
import { exportSof } from '../sof-export.mjs';

const template = fs.readFileSync(new URL('../templates/agent-sof.xlsx', import.meta.url));
const fixture = name => fs.readFileSync(new URL(`fixtures/${name}.txt`, import.meta.url), 'utf8');
const reportText = lines => ['NOR TEST / TEST 1 / ULSAN / DEP.REPORT', "JAN' 2026", ...lines].join('\n');
const cargo = (number, hoseOff, operation = 'LOAD') => [
  `(${operation}) CGO#${number} METHANOL / 5,000MT(1P,1S)`,
  `H/ON 05/1000 COMM 05/1030 COMP 05/1500${hoseOff ? ` H/OFF ${hoseOff}` : ''}`,
  '*B/L FIG: 5,000 MT',
  '*SHIP FIG: 4,999.250 MT',
];
function assertNor(report, expected) {
  assert.deepEqual(report.groups.map(group => group.norTendered || ''), expected);
  const workbook = read(exportSof(template, report, { DOMParser, XMLSerializer }), { type: 'array' });
  assert.equal(workbook.SheetNames.length, report.groups.length);
  for (let index = 0; index < expected.length; index++) {
    assert.equal(workbook.Sheets[workbook.SheetNames[index]].B15?.v ?? '', displayTime(expected[index]), `NOR TENDERED on ${workbook.SheetNames[index]}`);
  }
  return workbook;
}

test('BETULA skips its cargo-free layby and CTK uses the last cargo berth HOSE OFF', () => {
  const report = parseReport(fixture('betula'));
  assertNor(report, ['2026-06-28T11:42', '2026-06-29T04:00', '2026-06-30T05:15', '2026-06-30T23:55']);
  assert.ok(report.calls.some(call => call.berth === 'P#64'), 'The layby remains in the source timeline');
  assert.ok(report.groups[3].norTenderedExplanation.includes('OTK(S)'));
  assert.ok(!report.warnings.some(warning => warning.includes('CTK') && /NOR TENDERED/i.test(warning)));
});

test('KASHI first cargo berth retains its arrival NOR even with an earlier non-cargo layby', () => {
  const report = parseReport(fixture('kashi'));
  assert.equal(report.groups[0].berth, 'P#42');
  assertNor(report, ['2026-08-05T00:48']);
});

test('LARIX coasters share their physical call NOR and the next berth uses all coasters last HOSE OFF', () => {
  const report = parseReport(fixture('larix'));
  assertNor(report, [
    '2026-03-19T07:35', '2026-03-20T16:00',
    '2026-03-21T13:20', '2026-03-21T13:20', '2026-03-21T13:20',
    '2026-03-25T14:45', '2026-03-26T04:40', '2026-03-27T07:40',
  ]);
  assert.equal(new Set(report.groups.slice(2, 5).map(group => group.callId)).size, 1);
});

test('the latest HOSE OFF is selected by timestamp, not the last cargo row or operation group', () => {
  for (const reverse of [false, true]) {
    const previousCargo = [cargo(1, '05/1730', 'LOAD'), cargo(2, '05/1630', 'DISCH')];
    if (reverse) previousCargo.reverse();
    const report = parseReport(reportText([
      '05/0800 : EOSP & NOR TENDERED',
      '05/0900 : BERTHED AT ALPHA',
      ...previousCargo.flat(),
      '05/1800 : LEFT FM ALPHA',
      '05/1900 : BERTHED AT BETA',
      '05/1910 : NOR TENDERED',
      ...cargo(3, '05/2330'),
      ...cargo(4, '05/2300', 'DISCH'),
    ]));
    assert.equal(report.groups.length, 4);
    assertNor(report, ['2026-01-05T08:00', '2026-01-05T08:00', '2026-01-05T17:30', '2026-01-05T17:30']);
  }
});

test('a first cargo berth preserves an explicit source NOR and otherwise stays blank for review', () => {
  for (const sourceNor of ['', '05/0830 : NOR TENDERED']) {
    const report = parseReport(reportText([
      '05/0800 : EOSP', sourceNor,
      '05/0900 : BERTHED AT FIRST BERTH',
      ...cargo(1, '05/1730'),
    ]));
    assertNor(report, [sourceNor ? '2026-01-05T08:30' : '']);
  }
});

test('a later NOR re-notice within the first call does not replace the initial arrival NOR', () => {
  const report = parseReport(reportText([
    '05/0800 : EOSP & NOR TENDERED',
    '05/0900 : BERTHED AT ALPHA',
    '05/1100 : NOR TENDERED',
    ...cargo(1, '05/1730'),
  ]));
  assertNor(report, ['2026-01-05T08:00']);
  assert.ok(report.warnings.some(warning => /05\/1100/.test(warning) && /NOR/i.test(warning)));
  assert.ok(!report.groups[0].remarks.some(remark => /REPORTED NOR TENDERED/i.test(remark)));
});

for (const statement of [
  '05/0830 : NOR TENDER',
  '05/0830 : N.O.R. TENDERED',
  '05/0830 : N O R TENDER',
  '05/0830 : EOSP\n          & NOR TENDERED',
  'NOR TENDER: 05/0830',
  'N.O.R. TENDERED : 05/0830',
]) {
  test(`arrival NOR recognition preserves ${JSON.stringify(statement)}`, () => {
    const report = parseReport(reportText([
      '05/0800 : EOSP', statement,
      '05/0900 : BERTHED AT FIRST BERTH', ...cargo(1, '05/1730'),
    ]));
    assertNor(report, ['2026-01-05T08:30']);
  });
}

test('LARIX arrival 19/0735 is exported and its later explicit NOR remains as source evidence', () => {
  const report = parseReport(fixture('larix'));
  const workbook = read(exportSof(template, report, { DOMParser, XMLSerializer }), { type: 'array' });
  assert.equal(report.groups[0].norTendered, '2026-03-19T07:35');
  assert.equal(workbook.Sheets.P63.B15.v, '19/0735');
  assert.equal(workbook.Sheets['OCEAN ACE 11'].B15.v, '21/1320');
  assert.ok(report.warnings.some(warning => /23\/1700/.test(warning) && /NOR/i.test(warning)));
  assert.ok(report.groups.slice(2, 5).every(group => group.reportedNorTendered === '2026-03-23T17:00'));
  assert.ok(!report.groups.flatMap(group => group.remarks).some(remark => /REPORTED NOR TENDERED/i.test(remark)));
});

test('a first-call coaster NORT never substitutes for an absent vessel arrival NOR', () => {
  const report = parseReport(reportText([
    '05/0800 : EOSP',
    '05/0900 : BERTHED AT ALPHA',
    "SBTS SIDE - 1ST COASTER 'TEST COASTER'(NORT 05/0830)",
    ...cargo(1, '05/1730'),
  ]));
  assert.equal(report.groups[0].coaster.norTendered, '2026-01-05T08:30');
  assertNor(report, ['']);
  assert.ok(report.warnings.some(warning => /NOR TENDERED/.test(warning)));
});

test('missing or invalid previous HOSE OFF never falls back to coaster NORT or a later vessel notice', () => {
  for (const hoseOff of ['', '2026-03-21T25:00']) {
    const report = parseReport(fixture('larix'));
    report.groups[1].cargo[0].hoseOff = hoseOff;
    parser.applyNorTenderedRule(report);
    assert.ok(report.groups.slice(2, 5).every(group => group.coaster.norTendered));
    assertNor(report, [
      '2026-03-19T07:35', '2026-03-20T16:00', '', '', '',
      '2026-03-25T14:45', '2026-03-26T04:40', '2026-03-27T07:40',
    ]);
    for (const group of report.groups.slice(2, 5)) {
      assert.equal(group.reportedNorTendered, '2026-03-23T17:00');
      assert.ok(report.warnings.some(warning => warning.includes(group.sheetName) && /HOSE OFF/.test(warning)));
    }
  }
});

test('an immediate previous berth with unknown HOSE OFF never falls back to an older cargo berth', () => {
  const report = parseReport(reportText([
    '05/0800 : EOSP & NOR TENDERED',
    '05/0900 : BERTHED AT ALPHA', ...cargo(1, '05/1730'),
    '05/1800 : LEFT FM ALPHA',
    '05/1900 : BERTHED AT BETA', ...cargo(2, ''),
    '05/2000 : LEFT FM BETA',
    '05/2100 : BERTHED AT GAMMA', '05/2110 : NOR TENDERED', ...cargo(3, '05/2330'),
  ]));
  assertNor(report, ['2026-01-05T08:00', '2026-01-05T17:30', '']);
  assert.ok(report.warnings.some(warning => warning.includes('GAMMA') && /NOR/i.test(warning)));
});

test('a partly missing previous-call HOSE OFF is reviewed rather than assumed earlier than known cargoes', () => {
  const report = parseReport(reportText([
    '05/0800 : EOSP & NOR TENDERED',
    '05/0900 : BERTHED AT ALPHA', ...cargo(1, '05/1730'), ...cargo(2, ''),
    '05/1800 : LEFT FM ALPHA',
    '05/1900 : BERTHED AT BETA', ...cargo(3, '05/2330'),
  ]));
  assertNor(report, ['2026-01-05T08:00', '']);
});

test('a cargo-free physical layby is skipped without losing the prior cargo berth NOR source', () => {
  const report = parseReport(reportText([
    '05/0800 : EOSP & NOR TENDERED',
    '05/0900 : BERTHED AT ALPHA', ...cargo(1, '05/1730'),
    '05/1800 : LEFT FM ALPHA',
    '05/1900 : BERTHED AT LAYBY BERTH(BETA)',
    '05/2000 : LEFT FM BETA',
    '05/2100 : BERTHED AT GAMMA', ...cargo(3, '05/2330'),
  ]));
  assert.equal(report.groups.length, 2);
  assert.equal(report.calls.length, 3);
  assertNor(report, ['2026-01-05T08:00', '2026-01-05T17:30']);
});

test('revisiting the same berth remains a separate physical call', () => {
  const report = parseReport(reportText([
    '05/0800 : EOSP & NOR TENDERED',
    '05/0900 : BERTHED AT ALPHA', ...cargo(1, '05/1730'),
    '05/1800 : LEFT FM ALPHA',
    '05/1900 : BERTHED AT BETA', ...cargo(2, '05/2030'),
    '05/2100 : LEFT FM BETA',
    '05/2200 : BERTHED AT ALPHA', ...cargo(3, '05/2330'),
  ]));
  assert.notEqual(report.groups[0].callId, report.groups[2].callId);
  const workbook = assertNor(report, ['2026-01-05T08:00', '2026-01-05T17:30', '2026-01-05T20:30']);
  assert.deepEqual(workbook.SheetNames, ['ALPHA', 'BETA', 'ALPHA (2)']);
});

test('previous-berth HOSE OFF keeps the correct year when cargo work crosses December into January', () => {
  const report = parseReport([
    'NOR TEST / TEST 1 / ULSAN / DEP.REPORT', "DEC' 2026",
    '31/0800 : EOSP & NOR TENDERED',
    '31/0900 : BERTHED AT ALPHA',
    '(LOAD) H/ON COMM COMP H/OFF B/L FIG SHIP FIG STOWAGE',
    'CGO#1 FIRST / 31/1000 31/1100 01/0240 01/0300 100 99.5 1P',
    'CGO#2 SECOND / 31/1000 31/1100 31/2300 31/2355 200 199.5 2P',
    '01/0400 : LEFT FM ALPHA',
    '01/0500 : BERTHED AT BETA',
    'CGO#3 THIRD / 01/0600 01/0610 01/0800 01/0830 300 299.5 3P',
  ].join('\n'));
  assertNor(report, ['2026-12-31T08:00', '2027-01-01T03:00']);
});

test('NOR derivation leaves DISCH B/L, source-only SHIP, native fonts and logo parts unchanged', () => {
  const report = parseReport(fixture('larix'));
  const before = report.groups.flatMap(group => group.cargo.map(c => [c.number, c.bl, c.ship]));
  const bytes = exportSof(template, report, { DOMParser, XMLSerializer });
  const workbook = read(bytes, { type: 'array' });
  assert.deepEqual(before.slice(0, 2), [['115', 5000, null], ['117', 5000, null]]);
  assert.equal(workbook.Sheets.P63.N22.v, 5000);
  assert.equal(workbook.Sheets.P63.O22?.v ?? null, null);
  assert.equal(workbook.Sheets.P63.O20.v, 'SHIP');
  assert.equal(workbook.Sheets['JSTT SP5'].N22.v, 5000);
  assert.equal(workbook.Sheets['OCEAN ACE 11'].O22.v, 954.873);
  const native = unzipSync(template), actual = unzipSync(bytes);
  for (const part of ['xl/styles.xml', 'xl/theme/theme1.xml', 'xl/media/image1.png', 'xl/drawings/drawing1.xml']) assert.deepEqual(actual[part], native[part], part);
});

test('review edits, cargo additions/deletions and row order recompute NOR from the current previous-call data', () => {
  const report = parseReport(fixture('betula'));
  const previous = report.groups[0];
  previous.cargo[0].hoseOff = '2026-06-29T04:15';
  parser.applyNorTenderedRule(report);
  assert.equal(report.groups[1].norTendered, '2026-06-29T04:15');
  previous.cargo.push({ ...previous.cargo[0], id: 'added-test-cargo', number: '999', hoseOff: '2026-06-29T05:00' });
  parser.applyNorTenderedRule(report);
  assert.equal(report.groups[1].norTendered, '2026-06-29T05:00');
  previous.cargo.reverse();
  parser.applyNorTenderedRule(report);
  assert.equal(report.groups[1].norTendered, '2026-06-29T05:00');
  previous.cargo.splice(previous.cargo.findIndex(c => c.id === 'added-test-cargo'), 1);
  parser.applyNorTenderedRule(report);
  assertNor(report, ['2026-06-28T11:42', '2026-06-29T04:15', '2026-06-30T05:15', '2026-06-30T23:55']);
});

test('editing one coaster HOSE OFF updates only the next physical berth NOR, not sibling coasters', () => {
  const report = parseReport(fixture('larix'));
  report.groups.find(group => group.sheetName === 'WOORI HANA').cargo[0].hoseOff = '2026-03-25T15:00';
  parser.applyNorTenderedRule(report);
  assert.deepEqual(report.groups.slice(2, 5).map(group => group.norTendered), Array(3).fill('2026-03-21T13:20'));
  assert.equal(report.groups.find(group => group.sheetName === 'UTT').norTendered, '2026-03-25T15:00');
});

test('fixing an incomplete HOSE OFF removes stale derived NOR review warnings and remarks', () => {
  const report = parseReport(fixture('betula'));
  report.groups[1].cargo[0].hoseOff = '';
  parser.applyNorTenderedRule(report);
  assert.equal(report.groups[2].norTendered, '');
  assert.ok(report.warnings.some(warning => warning.includes('OTK(S)') && /NOR TENDERED/.test(warning)));
  report.groups[1].cargo[0].hoseOff = '2026-06-30T05:00';
  parser.applyNorTenderedRule(report);
  assert.equal(report.groups[2].norTendered, '2026-06-30T05:00');
  assert.ok(!report.warnings.some(warning => warning.includes('OTK(S)') && /NOR TENDERED/.test(warning)));
  assert.ok(!report.groups[2].remarks.some(remark => /REVIEW REQUIRED: NOR TENDERED/.test(remark)));
});

test('invalid or chronologically impossible edited HOSE OFF stays blank for review', () => {
  for (const value of ['not a time', '2026-06-31T04:00', '29/2461', '2026-06-29T08:00']) {
    const report = parseReport(fixture('betula'));
    report.groups[0].cargo[0].hoseOff = value;
    parser.applyNorTenderedRule(report);
    assert.equal(report.groups[1].norTendered, '', value);
    assert.ok(report.warnings.some(warning => warning.includes('JSTT3') && /NOR TENDERED/.test(warning)), value);
    const workbook = read(exportSof(template, report, { DOMParser, XMLSerializer }), { type: 'array' });
    assert.equal(workbook.Sheets.JSTT3.B15?.v ?? '', '', value);
  }
});

test('an unanchored HOSE OFF after current berthing and mixed raw/full dates require review', () => {
  for (const currentBerth of ['05/1700', '2026-01-05T17:00']) {
    const report = parseReport([
      'NOR TEST / TEST 1 / ULSAN / DEP.REPORT',
      '05/0800 : EOSP & NOR TENDERED',
      '05/0900 : BERTHED AT ALPHA', ...cargo(1, '05/1800'),
      '05/1600 : LEFT FM ALPHA',
      '05/1700 : BERTHED AT BETA', ...cargo(2, '05/2330'),
    ].join('\n'));
    assert.equal(report.groups[0].cargo[0].hoseOff, '05/1800');
    report.groups[1].berthAt = currentBerth;
    parser.applyNorTenderedRule(report);
    assertNor(report, ['05/0800', '']);
    assert.ok(report.warnings.some(warning => warning.includes('BETA') && /NOR TENDERED/.test(warning)), currentBerth);
  }
});

test('the chronology check uses the corrected current berth time instead of its stale original timestamp', () => {
  const report = parseReport(fixture('betula'));
  report.groups[0].cargo[0].hoseOff = '2026-06-29T08:00';
  parser.applyNorTenderedRule(report);
  assert.equal(report.groups[1].norTendered, '');
  report.groups[1].berthAt = '2026-06-29T09:00';
  parser.applyNorTenderedRule(report);
  assert.equal(report.groups[1].norTendered, '2026-06-29T08:00');
});

test('workbook import keeps explicit B15 values instead of inventing physical-call chronology from sheet order', () => {
  const original = parseReport(fixture('betula'));
  const workbook = read(exportSof(template, original, { DOMParser, XMLSerializer }), { type: 'array' });
  workbook.Sheets.JSTT3.B15 = { t: 's', v: '29/2222' };
  const imported = importWorkbook(workbook);
  assert.equal(displayTime(imported.groups[1].norTendered), '29/2222');
  parser.applyNorTenderedRule(imported);
  const output = read(exportSof(template, imported, { DOMParser, XMLSerializer }), { type: 'array' });
  assert.equal(output.Sheets.JSTT3.B15.v, '29/2222');
  assert.deepEqual(output.SheetNames, workbook.SheetNames);
});
