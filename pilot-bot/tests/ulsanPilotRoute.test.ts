// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_CATALOG as catalog, OFFICIAL_POINT_ROWS, parsePointRows } from '../supabase/functions/_shared/pilot-route/catalog';
import { CATALOG_MAX_AGE_MS, assertFreshCatalog, parseRouteText, pointKey, resolvePoint } from '../supabase/functions/_shared/pilot-route/resolver';
import { applyRouteAction, assertDraftAccess, confirmedRoutePreview, createRouteDraft, DRAFT_TTL_MS } from '../supabase/functions/_shared/pilot-route/draft';
import { advanceRouteConversation, decodeRouteCallback, renderRouteDraft } from '../supabase/functions/_shared/pilot-route/telegram';

const now = Date.parse('2026-09-20T04:00:00Z');
const actor = { chatId: '-5553003194', userId: '123456789' };
const make = (text = '/route P/S → OTK') => createRouteDraft('testdraft01', actor, text, catalog, now);
const confirm = (d: ReturnType<typeof make>) => applyRouteAction(d, actor,
  { type: 'CONFIRM', draftId: d.id, revision: d.revision }, catalog, now);

describe('official pilot point catalog evidence', () => {
  it('matches all 226 distinct live popup values byte for byte', () => {
    expect(catalog.points).toHaveLength(226);
    expect(createHash('sha256').update(OFFICIAL_POINT_ROWS).digest('hex'))
      .toBe('1078fff47275f69784f82b23c336beefc046f27238bcca222527d33eed2c6fc4');
    expect(new Set(catalog.points.map(pointKey)).size).toBe(226);
  });
  it('deduplicates repeated popup DOM values, not differing records', () => {
    const row = OFFICIAL_POINT_ROWS.split('\n')[0];
    expect(parsePointRows([row, row])).toHaveLength(1);
    expect(() => parsePointRows([row, row.replace('P/S', 'OTHER')])).toThrow('CONFLICTING_POINT_CODE');
  });
  it.each(['21|21002|P/S|울산항', '21|fake|P/S|울산항|station', '21|21002||울산항|station',
    '21|21002|P/S\n|울산항|station'])('rejects invalid source row %s', row => {
    expect(() => parsePointRows([row])).toThrow('INVALID_POINT_ROW');
  });
  it('rejects empty, stale, future and invalid catalog timestamps', () => {
    expect(() => parsePointRows([])).toThrow();
    expect(() => assertFreshCatalog(catalog, Date.parse(catalog.observedAt) + CATALOG_MAX_AGE_MS)).toThrow('CATALOG_REFRESH_REQUIRED');
    expect(() => assertFreshCatalog({ ...catalog, observedAt: 'invalid' }, now)).toThrow();
    expect(() => assertFreshCatalog(catalog, 0)).toThrow();
  });
});

describe('code-based matching never guesses ambiguous geography', () => {
  it.each([
    ['P/S', '21:21002'], ['p / s', '21:21002'], ['Ｐ／Ｓ', '21:21002'],
    ['P/S(E-2)', '21:21004'], ['E-2', '21:21011'], ['JSTT 2', '22:22211'],
    ['OTK(N)', '22:22243'], ['OTK N', '22:22243'], ['OTK/N(T/S)', '22:22245'],
    ['22243', '22:22243'], ['22:22244', '22:22244'],
  ])('%s proposes only verified code %s', (input, key) => {
    const result = resolvePoint(input, catalog);
    expect(result.kind).toBe('EXACT');
    expect(result.candidates.map(pointKey)).toEqual([key]);
  });
  it('OTK requires N/S and normal/T/S selection', () => {
    const result = resolvePoint('OTK', catalog);
    expect(result.kind).toBe('CHOOSE');
    expect(result.candidates.map(pointKey)).toEqual(['22:22243', '22:22244', '22:22245', '22:22246']);
  });
  it('JSTT includes numbered and T/S variants without first-result selection', () => {
    const result = resolvePoint('JSTT', catalog);
    expect(result.kind).toBe('CHOOSE');
    expect(result.candidates).toHaveLength(6);
    expect(result.candidates.some(p => p.name === 'JSTT2(T/S)')).toBe(true);
  });
  it.each(['YJ#2', 'M-6', 'M-4', 'HMD-5'])('blocks automatic legacy/current alias collision: %s', input => {
    const result = resolvePoint(input, catalog);
    expect(result.kind).toBe('CHOOSE');
    expect(result.reason).toBe('LEGACY_OR_COLLISION');
    expect(result.candidates.length).toBeGreaterThan(1);
  });
  it('known explicit code can disambiguate an old name collision', () => {
    expect(resolvePoint('21025', catalog).kind).toBe('EXACT');
  });
  it('retains numeric separators and never aliases UTK to OTK', () => {
    const result = resolvePoint('UTK#1', catalog);
    expect(result.kind).toBe('EXACT');
    expect(result.candidates[0].pointCode).toBe('22274');
    expect(resolvePoint('SK11', catalog).kind).not.toBe('EXACT');
    expect(resolvePoint('P/SE2', catalog).kind).not.toBe('EXACT');
  });
  it('offers typo suggestions but never automatically selects even one', () => {
    const result = resolvePoint('JSTT5', catalog);
    expect(result.kind).toBe('CHOOSE');
    expect(result.candidates.length).toBeGreaterThan(0);
  });
  it.each(['99999', '21:22243', 'completely-unknown', 'X'])('unknown input %s stays unresolved', input => {
    expect(resolvePoint(input, catalog).kind).toBe('UNKNOWN');
  });
  it('rejects control characters and oversized input', () => {
    expect(() => resolvePoint('P/S\n', catalog)).toThrow();
    expect(() => resolvePoint('A'.repeat(101), catalog)).toThrow();
  });
});

describe('explicit FROM/TO text parser', () => {
  it.each(['/route P/S -> JSTT2', '/route@hpbot_ulsan_pilot_20260920_bot P/S → JSTT2',
    '구간: P/S => JSTT2', 'FROM: P/S\nTO: JSTT2', '출발: P/S\n도착: JSTT2',
    '선명: MV TEST\n호출부호: SAMPLE\n구간 P/S → JSTT2\nDRAFT: 6.0'])('parses %s', input => {
    expect(parseRouteText(input)).toEqual({ from: 'P/S', to: 'JSTT2' });
  });
  it('preserves route direction and point-name hyphens', () => {
    expect(parseRouteText('E-2 → SK#1-1')).toEqual({ from: 'E-2', to: 'SK#1-1' });
  });
  it.each(['P/S - JSTT2', 'FROM: P/S', 'P/S → OTK → JSTT2', 'P/S →',
    'FROM: P/S\nFROM: E-2\nTO: JSTT2', 'FROM: P/S\nTO: JSTT2\nP/S → OTK', 'P/S → OTK\nE-2 → JSTT2'])
  ('rejects missing or conflicting route %s', input => { expect(() => parseRouteText(input)).toThrow(); });
});

describe('Telegram route draft interaction (offline, no submission)', () => {
  it('text → candidate button → confirm → official codes, with no application capability', () => {
    let draft = make();
    expect(draft.from.selected).toBe('21:21002');
    expect(draft.to.selected).toBeNull();
    const message = renderRouteDraft(draft, catalog);
    const button = message.reply_markup.inline_keyboard.flat().find(b => b.text.startsWith('OTK(N)'))!;
    const action = decodeRouteCallback(button.callback_data);
    if (action.type === 'PAGE') throw new Error('unexpected page');
    draft = applyRouteAction(draft, actor, action, catalog, now);
    const confirmButton = renderRouteDraft(draft, catalog).reply_markup.inline_keyboard[0][0];
    const confirmation = decodeRouteCallback(confirmButton.callback_data);
    if (confirmation.type === 'PAGE') throw new Error('unexpected page');
    draft = applyRouteAction(draft, actor, confirmation, catalog, now);
    expect(confirmedRoutePreview(draft, actor, catalog, now)).toMatchObject({
      submissionAllowed: false, from: { pointCode: '21002' }, to: { pointCode: '22243' },
    });
    expect(renderRouteDraft(draft, catalog).text).toContain('제출되지 않았습니다');
    expect(renderRouteDraft(draft, catalog).reply_markup.inline_keyboard).toEqual([]);
  });
  it('exact text still requires explicit confirmation', () => {
    const draft = make('P/S → JSTT2');
    expect(draft.status).toBe('SELECTING');
    expect(() => confirmedRoutePreview(draft, actor, catalog, now)).toThrow('ROUTE_NOT_CONFIRMED');
    expect(confirm(draft).status).toBe('CONFIRMED_DRAFT');
  });
  it('blocks identical FROM/TO and missing candidates', () => {
    expect(() => confirm(make('P/S → P/S'))).toThrow('SAME_FROM_TO');
    expect(() => confirm(make())).toThrow('BOTH_POINTS_REQUIRED');
    const draft = make('P/S → nowhere');
    expect(renderRouteDraft(draft, catalog).text).toContain('일치 항목이 없습니다');
    expect(renderRouteDraft(draft, catalog).reply_markup.inline_keyboard).toEqual([]);
  });
  it.each([{ chatId: actor.chatId, userId: '999' }, { chatId: '-1', userId: actor.userId }])
  ('blocks another user or chat %j', outsider => {
    expect(() => assertDraftAccess(make(), outsider, catalog, now)).toThrow('DRAFT_OWNER_ONLY');
  });
  it('blocks expired drafts, changed catalog, reused or stale buttons', () => {
    const draft = make('P/S → JSTT2');
    expect(() => assertDraftAccess(draft, actor, catalog, now + DRAFT_TTL_MS)).toThrow('DRAFT_EXPIRED');
    expect(() => assertDraftAccess(draft, actor, { ...catalog, version: 'changed' }, now)).toThrow('CATALOG_CHANGED');
    expect(() => applyRouteAction(draft, actor, { type: 'CONFIRM', draftId: draft.id, revision: 1 }, catalog, now)).toThrow('STALE_DRAFT_BUTTON');
    const done = confirm(draft);
    expect(() => confirm(done)).toThrow('DRAFT_ALREADY_CONFIRMED');
  });
  it('blocks arbitrary valid but not offered point codes', () => {
    const draft = make();
    expect(() => applyRouteAction(draft, actor, { type: 'SELECT', draftId: draft.id, revision: 0,
      side: 'to', key: '22:22211' }, catalog, now)).toThrow('POINT_NOT_OFFERED');
  });
  it('paginates broad searches without silently truncating catalog choices', () => {
    const draft = make('울산항 → OTK');
    const count = draft.from.candidates.length;
    expect(count).toBeGreaterThan(6);
    const offered = new Set<string>();
    for (let page = 0; page < Math.ceil(count / 6); page++) {
      const message = renderRouteDraft(draft, catalog, page);
      expect(message.text.length).toBeLessThan(4096);
      expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThan(4096);
      for (const button of message.reply_markup.inline_keyboard.flat()) {
        expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64);
        const action = decodeRouteCallback(button.callback_data);
        if (action.type === 'SELECT') offered.add(action.key);
      }
    }
    expect(offered.size).toBe(count);
    expect(() => renderRouteDraft(draft, catalog, 999)).toThrow('INVALID_PAGE');
  });
  it('checks owner and revision even on read-only pagination callbacks', () => {
    const draft = make('울산항 → OTK');
    const data = `pr:${draft.id}:0:p:1`;
    const result = advanceRouteConversation(draft, actor, data, catalog, now);
    expect(result.changed).toBe(false);
    expect(result.draft.revision).toBe(0);
    expect(result.message.text).toContain('(2/');
    expect(() => advanceRouteConversation(draft, { ...actor, userId: '999' }, data, catalog, now)).toThrow('DRAFT_OWNER_ONLY');
    expect(() => advanceRouteConversation(draft, actor, data.replace(':0:p:', ':1:p:'), catalog, now)).toThrow('STALE_DRAFT_BUTTON');
    expect(() => advanceRouteConversation(draft, actor, data, catalog, now + DRAFT_TTL_MS)).toThrow('DRAFT_EXPIRED');
  });
  it('conversation produces a new revision only for a validated state change', () => {
    const draft = make();
    const result = advanceRouteConversation(draft, actor, `pr:${draft.id}:0:t:22:22243`, catalog, now);
    expect(result.changed).toBe(true);
    expect(result.draft.revision).toBe(1);
    expect(draft.to.selected).toBeNull();
    expect(result.message.text).toContain('OTK(N)');
    expect(() => advanceRouteConversation(result.draft, actor, `pr:${draft.id}:0:t:22:22243`, catalog, now)).toThrow('STALE_DRAFT_BUTTON');
  });
  it.each(['pr:fake:0:c', 'pr:testdraft01:0:f:22243', 'pr:testdraft01:0:c:extra',
    'pr:testdraft01:0:p:-1', 'pr:testdraft01:0:t:22:22243:extra', 'x'.repeat(65)])('rejects malformed callback %s', data => {
    expect(() => decodeRouteCallback(data)).toThrow('INVALID_CALLBACK');
  });
});
