import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../sof-parser.mjs';

const report = `STOLT TEST / HBR 99 / ULSAN / DEP.REPORT
SEP' 2026
05/2330 : EOSP & COMMENCED DRIFTING 10. OUT PORT LIMIT AWAITING BERTH FREE, NORT
06/0110 : E-2 ANCH
06/0240 : POB
06/0310 : ANCHOR AWEIGH
06/0410 : LEFT PREVIOUS BERTH
06/0600 : BERTHED AT 10. JSTT SP#5
(LOAD)
#1 TEST PRODUCT / 1,000 M/T (1P) H/ON 06/0700 COMM 06/0710 COMP 06/0810 H/OFF 06/0820 1000 999 1P
06/0900 : PROCEED TO H/SEA FOR TANK CLEANING
07/1000 : H/SEA FOR TANK CLEANING
08/1000~08/1500 : 3RD LAYBY BERTH FOR BUNKER OPERATION AWAITING BERTH FREE
09/1000 : SAILED FM ULSAN`;

test('keeps item-10 pre-berth times separate from cargo work and retains intermediate schedules', () => {
  const parsed = parseReport(report);
  assert.deepEqual(parsed.preBerth, {
    eosp: '2026-09-05T23:30', outPortLimit: '2026-09-05T23:30', e2Anch: '2026-09-06T01:10', nort: '2026-09-05T23:30',
    pob: '2026-09-06T02:40', anchorAweigh: '2026-09-06T03:10', leftPreviousBerth: '2026-09-06T04:10',
  });
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0].berth, 'JSTT SP#5');
  assert.equal(parsed.intermediateSchedules.length, 2);
  assert.match(parsed.intermediateSchedules[0].text, /H\/SEA FOR TANK CLEANING/);
  assert.match(parsed.intermediateSchedules[1].text, /LAYBY BERTH/);
});
