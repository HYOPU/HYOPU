import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../sof-parser.mjs';

test('departure report keeps a berthed maximum draft for workspace learning', () => {
  const report=parseReport(`TEST VESSEL / 1 / ULSAN / DEP.REPORT\nSEP' 2026\n15/0700 : BERTHED AT P#63(MAX DRAFT 11.0M, PORT SIDE A/S)\n(DISCH)\n#150 PRODUCT / 100 M/T (1P)`);
  assert.equal(report.calls[0].berth,'P#63');
  assert.equal(report.calls[0].maxDraft,'11.00M');
  assert.equal(report.groups[0].maxDraft,'11.00M');
});
