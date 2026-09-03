import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVcrRows, vesselNameForSof } from '../vcr-parser.mjs';

const rows = [
  ['Voyage Cargo Report - Loading'], [],
  ['Load Port','Load Berth','Code','Cargo Name','Quantity (MT)','Charterer','Tanks','Discharge Port - Berth(s)'],
  ['ULSAN','SBTS 1','110','MMA',2000,'OXYDE','12CA','ALTAMIRA - QUAY'],
  ['ULSAN','SP5','145','VAM',2500.2,'HELM','1P, 1S','ALTAMIRA - OTM 1'],
  ['SINGAPORE','SERAYA 2','140','MONOPROPYLENE GLYCOL',980.09,'HELM','5P, 5S','HOUSTON - VOPAK1'],
];

test('VCR loading schedule updates only the current port cargo rows', () => {
  const cargo = parseVcrRows(rows, { port: 'ULSAN' });
  assert.deepEqual(cargo.map(item => [item.number,item.name,item.bl,item.tanks,item.party]), [['110','MMA','2000','12CA','OXYDE'],['145','VAM','2500.2','1P, 1S','HELM']]);
  assert.ok(cargo.every(item => item.operation === 'LOAD' && item.ship === ''));
});

test('short vessel names are expanded for an embedded SOF context', () => {
  assert.equal(vesselNameForSof('S.PERSEVERANCE'), 'STOLT PERSEVERANCE');
  assert.equal(vesselNameForSof('STOLT PERSEVERANCE'), 'STOLT PERSEVERANCE');
});
