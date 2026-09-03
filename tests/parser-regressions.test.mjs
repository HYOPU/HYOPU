import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseReport } from '../sof-parser.mjs';

const fixture = name => fs.readFileSync(new URL(`fixtures/${name}.txt`, import.meta.url), 'utf8');
const report = cargo => parseReport([
  'STOLT LARIX / AG-NE 72 / ULSAN / DEP.REPORT',
  "MAR' 2026",
  '20/1700 : EOSP',
  '20/1810 : POB FOR BERTHING',
  '20/1854 : BERTHED AT 30. JSTT SP#5(MAX DRAFT 12.35M)',
  cargo,
].join('\n'));
const discharge = '(DISCH) CGO#117 METHANOL / 5,000MT(1W,2W,3W,4W,5W,6W,7W,8W,9W,10S,11P,11CP,12P,12S)';

test('discharge header quantity is B/L and is not copied to SHIP FIG', () => {
  const result = report(discharge);
  const cargo = result.cargo[0];
  assert.equal(cargo.bl, 5000);
  assert.equal(cargo.ship, null);
  assert.equal(cargo.operation, 'DISCH');
  assert.equal(cargo.tank, '1W,2W,3W,4W,5W,6W,7W,8W,9W,10S,11P,11CP,12P,12S');
  assert.ok(!result.warnings.some(value => value.includes('B/L FIG')));
});

test('LARIX discharge B/L fix preserves all berth, coaster, and date boundaries', () => {
  const result = parseReport(fixture('larix'));
  assert.deepEqual(result.groups.map(group => group.sheetName), ['P63', 'JSTT SP5', 'OCEAN ACE 11', 'YUE DAN', 'WOORI HANA', 'UTT', 'SK3', 'P22']);
  assert.equal(result.cargo.length, 10);
  for (const number of ['115', '117']) {
    const cargo = result.cargo.find(value => value.number === number);
    assert.equal(cargo.bl, 5000);
    assert.equal(cargo.ship, null);
  }
  assert.equal(result.cargo.find(value => value.number === '117').completed, '2026-03-21T12:35');
  assert.equal(result.cargo.find(value => value.number === '245').bl, 955.443);
  assert.equal(result.cargo.find(value => value.number === '245').ship, 954.873);
  assert.equal(result.groups[6].pilotOut, '2026-03-27T09:41');
});

for (const [blLine, shipLine] of [
  ['*B/L FIG : 5,001.250MT', '*SHIP FIG: 4,998.750MT'],
  ['b/l fig m/t : 5,001.250', 'ship fig m/t: 4,998.750'],
  ['* B / L   FIG  M / T ： 5,001.250 M / T', '* ship   fig (M/T) : 4,998.750 MT'],
  ['*B&#47;L&nbsp;FIG&#32;M/T&#58; 5,001.250&nbsp;MT', '*SHIP&#32;FIG&nbsp;M/T: 4,998.750&#x20;M/T'],
]) {
  test(`explicit B/L and SHIP labels remain independent: ${blLine}`, () => {
    const cargo = report(`${discharge}\n${blLine}\n${shipLine}`).cargo[0];
    assert.equal(cargo.bl, 5001.25);
    assert.equal(cargo.ship, 4998.75);
  });
}

test('explicit SHIP FIG changes only SHIP, and is not inherited by the next cargo', () => {
  const result = report(`${discharge}\n*SHIP FIG M/T: 4,999.321 MT\nCGO#118 ETHANOL / 750 MT(6P)`);
  assert.equal(result.cargo[0].bl, 5000);
  assert.equal(result.cargo[0].ship, 4999.321);
  assert.equal(result.cargo[1].bl, 750);
  assert.equal(result.cargo[1].ship, null);
});

test('LOAD header remains nominated quantity until an explicit B/L figure is supplied', () => {
  const header = '(LOAD) CGO#245 PIPERYLENE MIXTURE / 1,000 M/T(6P,6S)';
  const empty = report(header).cargo[0];
  assert.equal(empty.plannedQuantity, 1000);
  assert.equal(empty.bl, null);
  assert.equal(empty.ship, null);
  const measured = report(`${header}\n*B/L FIG M/T: 955.443 MT\n*SHIP FIG M/T: 954.873 MT`).cargo[0];
  assert.equal(measured.bl, 955.443);
  assert.equal(measured.ship, 954.873);
});

test('discharge tables preserve independently stated B/L and SHIP with spaced units', () => {
  const cargo = report('(DISCH) H/ON COMM COMP H/OFF B/L FIG M/T SHIP FIG M/T STOWAGE\nCGO#117 METHANOL / 20/2110 20/2136 21/1235 21/1320 5,000.000 MT 4,999.125 M/T 1W,2W').cargo[0];
  assert.equal(cargo.bl, 5000);
  assert.equal(cargo.ship, 4999.125);
  assert.equal(cargo.tank, '1W,2W');
});

test('single-figure discharge table and a zero SHIP figure are not conflated', () => {
  const result = parseReport(fixture('kashi'));
  assert.equal(result.groups.length, 1);
  assert.equal(result.cargo.length, 2);
  assert.equal(result.cargo[0].bl, 1899.979);
  assert.equal(result.cargo[0].ship, null);
  const cargo = report(`${discharge}\n*SHIP FIG M/T: 0.000 MT`).cargo[0];
  assert.equal(cargo.bl, 5000);
  assert.equal(cargo.ship, 0);
});

test('BETULA typed figures and June-to-July rollover remain unchanged', () => {
  const result = parseReport(fixture('betula'));
  assert.deepEqual(result.groups.map(group => group.sheetName), ['OP6', 'JSTT3', 'OTK(S)', 'CTK']);
  assert.equal(result.cargo.length, 7);
  assert.equal(result.cargo.find(value => value.number === '310').bl, 1000.278);
  assert.equal(result.cargo.find(value => value.number === '310').ship, 998.664);
  assert.equal(result.cargo.find(value => value.number === '310').hoseOn, '2026-07-02T06:00');
  assert.equal(result.groups[2].leftBerth, '2026-07-01T02:44');
});

test('cargo-free layby is skipped for NOR and cargo table names contain only products', () => {
  const result = parseReport([
    'STOLT PERSEVERANCE / HBR 117 / ULSAN / DEP.REPORT',
    "AUG' 2026",
    '28/0700 : BERTHED AT P#42',
    '(LOAD)',
    'CGO#155 TOLUENE / 28/0710 28/0720 28/0840 28/0850 1,000 MT 999 MT 1P',
    '29/0800 : LEFT FM P#42',
    '29/0830 : BERTHED AT NLB#1 (LAYBY BERTH)',
    '30/0800 : LEFT FM NLB#1',
    '31/0905 : BERTHED AT JSTT SP#5',
    "SBTS SIDE ALONGSIDE COASTER 'ZI DING XIANG' (NORT 24/1600)",
    '(DISCH)',
    'CGO#160 ISOPRENE / 31/0910 31/0920 31/0930 31/0940 1,000 MT 999 MT 2P',
    '01/0800 : BERTHED AT JSTT SP#5',
    "SBTS SIDE ALONGSIDE COASTER 'JSTT SP5'",
    '(DISCH)',
    'CGO#145 VAM / 2,500MT(DT2S)(WWT) 01/0810 01/0820 01/0830 01/0840 2,500 MT 2,499 MT DT2S',
    '02/0800 : BERTHED AT P#63',
    "SBTS SIDE ALONGSIDE COASTER 'KEOYOUNG MASTER'",
    '(DISCH)',
    'CGO#110 MMA / 1,500MT(1P)(WWT) 02/0810 02/0820 02/0830 02/0840 1,500 MT 1,499 MT 1P',
    '03/0800 : BERTHED AT P#22',
    "SBTS SIDE ALONGSIDE COASTER 'WOORI HANA'",
    '(DISCH)',
    'CGO#165C ISOPRENE / 800MT(2S)(WWT) 03/0810 03/0820 03/0830 03/0840 800 MT 799 MT 2S',
  ].join('\n'));
  const bySheet = Object.fromEntries(result.groups.map(group => [group.sheetName, group]));
  assert.equal(bySheet['ZI DING XIANG'].norTendered, '2026-08-28T08:50');
  assert.equal(bySheet['JSTT SP5'].cargo[0].name, 'VAM');
  assert.equal(bySheet['KEOYOUNG MASTER'].cargo[0].name, 'MMA');
  assert.equal(bySheet['WOORI HANA'].cargo[0].name, 'ISOPRENE');
  assert.ok(!result.groups.flatMap(group => group.remarks).some(remark => /REVIEW REQUIRED|B\/L FIG not stated|REPORTED NOR TENDERED/i.test(remark)));
});
