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

test('non-cargo layby carries prior hose off to ZI DING XIANG NOR and keeps cargo names clean', () => {
  const result = parseReport([
    'STOLT PERSEVERANCE / HBR 131 / ULSAN / DEP.REPORT', "AUG' 2026",
    '26/1100 : EOSP', '1315 : BERTHED AT 20. P#42',
    '(LOAD) CGO#155 EPICHLOROHYDRIN / 2,000MT(4CA)(WWT)',
    'H/ON 27/1220 COMM 27/1620 COMP 28/0755 H/OFF 28/0850',
    '1126 : LEFT FM P#42', '1245 : BERTHED AT 30. 1ST LAYBY BERTH(NLB#1)',
    '0726 : LEFT FM NLB#1', '0905 : BERTHED AT 40. 2ND LAYBY BERTH(SBTS#1)',
    'PORT SIDE - 1ST COASTER "ZI DING XIANG"(NORT 24/1600, A/S 29/1050)',
    '(LOAD) CGO#160 ISOPRENE / 1,000MT(3CA)(ATIP)',
    'H/ON 29/1315 COMM 29/1415 COMP 29/2130 H/OFF 29/2330',
    '0804 : LEFT FM SBTS#1', '0845 : BERTHED AT 50. JSTT SP#5',
    'CGO#145 VAM / 2,500MT(DT2S)(WWT) 31/1355 31/1540 01/0025 01/0320 2,500.200MT 2,499.872MT',
    '0453 : LEFT FM JSTT SP#5', '0535 : BERTHED AT 60. 3RD LAYBY BERTH(SBTS#1)',
    'PORT SIDE - 2ND COASTER "KEOYOUNG MASTER"(NORT 01/0500, A/S 01/0730)',
    'CGO#110 MMA / 2,000MT(10CA)(WWT) 01/1855 01/1955 02/0215 02/0340 1,998.750MT 1,991.534MT',
    'PORT SIDE - 3RD COASTER "WOORI HANA"(NORT 01/0700, A/S 02/0605)',
    '(LOAD) CGO#165C ISOPRENE / 1,200MT(3P)(ATIP)', 'H/ON 02/0740 COMM 02/0800 ETC 02/1500',
  ].join('\n'));
  const bySheet = Object.fromEntries(result.groups.map(group => [group.sheetName, group]));
  assert.equal(bySheet['ZI DING XIANG'].norTendered, '2026-08-28T08:50');
  assert.equal(bySheet['JSTT SP5'].cargo[0].name, 'VAM');
  assert.equal(bySheet['KEOYOUNG MASTER'].cargo[0].name, 'MMA');
  assert.equal(bySheet['WOORI HANA'].cargo[0].name, 'ISOPRENE');
  assert.ok(!result.groups.flatMap(group => group.remarks).some(value => /REVIEW REQUIRED|B\/L FIG not stated/i.test(value)));
});
