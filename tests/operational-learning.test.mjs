import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationalLearning, learnedMaxDraft } from '../operational-learning.mjs';

test('learning combines saved PROFORMA checks and parsed departure reports by port', () => {
  const learning=buildOperationalLearning([
    {port:'ULSAN',vessel:'OLDER',voyage:'1',updatedAt:'2026-09-01T00:00:00Z',cargo:[{berth:'P-63',maxDraft:'10.8M'}],sof:null},
    {port:'ULSAN',vessel:'NEWER',voyage:'2',updatedAt:'2026-09-03T00:00:00Z',cargo:[],sof:{groups:[{berth:'P#63',maxDraft:'11.00M'}]}},
    {port:'DAESAN',vessel:'OTHER',voyage:'3',updatedAt:'2026-09-04T00:00:00Z',cargo:[{berth:'P#63',maxDraft:'9.00M'}],sof:null},
  ],'ULSAN');
  assert.deepEqual(learning,[{berth:'P#63',maxDraft:'11.00M',source:'SOF · 출항 리포트 분석',vessel:'NEWER',voyage:'2',updatedAt:'2026-09-03T00:00:00Z'}]);
  assert.equal(learnedMaxDraft('P-63',learning),'11.00M');
});
