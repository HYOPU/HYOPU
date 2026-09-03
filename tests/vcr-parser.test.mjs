import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVcrClipboard, parseVcrRows, vesselNameForSof } from '../vcr-parser.mjs';

const rows = [
  ['Voyage Cargo Report - Loading'], [],
  ['Load Port','Load Berth','Code','Cargo Name','Quantity (MT)','Charterer','Tanks','Discharge Port - Berth(s)'],
  ['ULSAN','SBTS 1','110','MMA',2000,'OXYDE','12CA','ALTAMIRA - QUAY'],
  ['ULSAN','SP5','145','VAM',2500.2,'HELM','1P, 1S','ALTAMIRA - OTM 1'],
  ['SINGAPORE','SERAYA 2','140','MONOPROPYLENE GLYCOL',980.09,'HELM','5P, 5S','HOUSTON - VOPAK1'],
];
const dischargingRows = [
  ['Voyage Cargo Report - Discharging'], [],
  ['Discharge Port','Discharge Berth','Total Discharge Qty. Port (MT)','Port ETA','Code','Cargo Name','Discharge Quantity (MT)','Charterer','Tanks','Load Port - Berth(s)'],
  ['YOKOHAMA','ANCHORAGE',1573.531,'11-Sept-2026','115','HYPRENE 100',257.001,'ERGON','12S, 4P','NEW ORLEANS - BWC GRETNA'],
  ['ULSAN','P-63',10832.576,'15-Sept-2026','150','METHYL CARBITOL',787.998,'THE DOW CHEMICAL COMPANY','5P','NEW ORLEANS - VOPAK ST. CHARLES'],
  ['ULSAN','JSTT2',10832.576,'15-Sept-2026','230','MDEA HP',603.194,'THE DOW CHEMICAL COMPANY','13S','TEXAS CITY - TC-66'],
];

test('VCR loading schedule updates only the current port cargo rows', () => {
  const cargo = parseVcrRows(rows, { port: 'ULSAN' });
  assert.deepEqual(cargo.map(item => [item.number,item.name,item.bl,item.tanks,item.party]), [['110','MMA','2000','12CA','OXYDE'],['145','VAM','2500.2','1P, 1S','HELM']]);
  assert.ok(cargo.every(item => item.operation === 'LOAD' && item.ship === ''));
  assert.equal(cargo[0].berth, 'SBTS 1');
});

test('short vessel names are expanded for an embedded SOF context', () => {
  assert.equal(vesselNameForSof('S.PERSEVERANCE'), 'STOLT PERSEVERANCE');
  assert.equal(vesselNameForSof('STOLT PERSEVERANCE'), 'STOLT PERSEVERANCE');
});

test('a copied Excel VCR table uses the same port-specific parser', () => {
  const clipboard = rows.map(row => row.join('\t')).join('\n');
  const cargo = parseVcrClipboard(clipboard, { port: 'ULSAN' });
  assert.deepEqual(cargo.map(item => [item.number, item.name, item.bl]), [['110', 'MMA', '2000'], ['145', 'VAM', '2500.2']]);
});
test('a copied Discharging VCR filters the current port and creates DISCH cargo rows', () => {
  const clipboard = dischargingRows.map(row => row.join('\t')).join('\n');
  const cargo = parseVcrClipboard(clipboard, { port: 'ULSAN' });
  assert.deepEqual(cargo.map(item => [item.operation, item.number, item.name, item.bl, item.berth]), [
    ['DISCH', '150', 'METHYL CARBITOL', '787.998', 'P-63'],
    ['DISCH', '230', 'MDEA HP', '603.194', 'JSTT2'],
  ]);
  assert.ok(cargo.every(item => item.note.includes('←')));
});
