import test from 'node:test';
import assert from 'node:assert/strict';
import { maxDraftForBerth } from '../berth-drafts.mjs';

test('known berth aliases return their maintained maximum draft', () => {
  assert.equal(maxDraftForBerth('P#63'), '11.00M');
  assert.equal(maxDraftForBerth('P-63'), '11.00M');
  assert.equal(maxDraftForBerth('JSTT SP#5'), '12.35M');
  assert.equal(maxDraftForBerth('SBTS#1'), '14.40M');
});

test('an unregistered berth is left blank for manual confirmation', () => {
  assert.equal(maxDraftForBerth('JSTT2'), '');
});
