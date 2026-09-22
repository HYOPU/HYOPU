import type { PointCatalog } from './catalog.ts';
import { applyRouteAction, assertDraftAccess, type Actor, type RouteAction, type RouteDraft } from './draft.ts';
import { pointKey } from './resolver.ts';

export interface InlineButton { text: string; callback_data: string }
export interface RouteMessage { text: string; reply_markup: { inline_keyboard: InlineButton[][] } }
export type RouteCallback = RouteAction | { type: 'PAGE'; draftId: string; revision: number; page: number };
export const PAGE_SIZE = 6;

/** Persist changed drafts using compare-and-swap on the old revision before sending this message.
 * PAGE is read-only but still checks owner, expiration, catalog and revision.
 */
export function advanceRouteConversation(draft: RouteDraft, actor: Actor, data: string, catalog: PointCatalog, now: number): {
  draft: RouteDraft; changed: boolean; message: RouteMessage;
} {
  assertDraftAccess(draft, actor, catalog, now);
  const action = decodeRouteCallback(data);
  if (action.draftId !== draft.id || action.revision !== draft.revision) throw new Error('STALE_DRAFT_BUTTON');
  if (action.type === 'PAGE') {
    if (draft.status !== 'SELECTING' || (draft.from.selected && draft.to.selected)) throw new Error('INVALID_PAGE');
    return { draft, changed: false, message: renderRouteDraft(draft, catalog, action.page) };
  }
  const next = applyRouteAction(draft, actor, action, catalog, now);
  return { draft: next, changed: true, message: renderRouteDraft(next, catalog) };
}

export function decodeRouteCallback(data: string): RouteCallback {
  if (new TextEncoder().encode(data).length > 64) throw new Error('INVALID_CALLBACK');
  const match = data.match(/^pr:([A-Za-z0-9_-]{8,32}):(\d{1,6}):(f|t|c|p)(?::(.+))?$/);
  if (!match) throw new Error('INVALID_CALLBACK');
  const common = { draftId: match[1], revision: Number(match[2]) };
  if (match[3] === 'c' && !match[4]) return { ...common, type: 'CONFIRM' };
  if (match[3] === 'p' && /^\d{1,3}$/.test(match[4] ?? '')) return { ...common, type: 'PAGE', page: Number(match[4]) };
  if ((match[3] === 'f' || match[3] === 't') && /^\d{2}:\d{5}$/.test(match[4] ?? ''))
    return { ...common, type: 'SELECT', side: match[3] === 'f' ? 'from' : 'to', key: match[4] };
  throw new Error('INVALID_CALLBACK');
}

/** No parse_mode: user input and official names must remain literal text, never HTML/Markdown. */
export function renderRouteDraft(draft: RouteDraft, catalog: PointCatalog, page = 0): RouteMessage {
  if (catalog.version !== draft.catalogVersion) throw new Error('CATALOG_CHANGED');
  const points = new Map(catalog.points.map(p => [pointKey(p), p]));
  const label = (key: string | null): string => {
    const p = key ? points.get(key) : undefined;
    return p ? `${p.name} · ${p.portName} [${pointKey(p)}]` : '선택 필요';
  };
  const lines = ['📝 [도선구간 초안 — 실제 신청 아님]',
    `FROM: ${label(draft.from.selected)}`, `TO: ${label(draft.to.selected)}`,
    `입력: ${draft.from.input} → ${draft.to.input}`];
  const buttons: InlineButton[][] = [];
  const callback = (suffix: string): string => `pr:${draft.id}:${draft.revision}:${suffix}`;
  const side = !draft.from.selected ? 'from' : !draft.to.selected ? 'to' : null;
  if (draft.status === 'CONFIRMED_DRAFT') {
    lines.push('✅ 구간 초안 확정. 도선신청은 제출되지 않았습니다.');
  } else if (side) {
    const keys = draft[side].candidates;
    if (!keys.length) {
      lines.push(`${side.toUpperCase()} 일치 항목이 없습니다. 공식 이름 또는 5자리 코드로 /route를 다시 입력하세요.`);
    } else {
      const pages = Math.ceil(keys.length / PAGE_SIZE);
      if (!Number.isInteger(page) || page < 0 || page >= pages) throw new Error('INVALID_PAGE');
      lines.push(`${side.toUpperCase()}를 선택하세요 (${page + 1}/${pages}). 방향·부두 번호·T/S를 확인하세요.`);
      for (const key of keys.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
        const point = points.get(key);
        if (!point) throw new Error('INVALID_SELECTED_POINT');
        lines.push(`• ${point.name} · ${point.portName} [${key}] — ${point.description}`);
        buttons.push([{ text: `${point.name} [${key}]`, callback_data: callback(`${side === 'from' ? 'f' : 't'}:${key}`) }]);
      }
      const navigation: InlineButton[] = [];
      if (page > 0) navigation.push({ text: '이전', callback_data: callback(`p:${page - 1}`) });
      if (page + 1 < pages) navigation.push({ text: '다음', callback_data: callback(`p:${page + 1}`) });
      if (navigation.length) buttons.push(navigation);
    }
  } else if (draft.from.selected === draft.to.selected) {
    lines.push('⚠️ FROM과 TO가 같습니다. 서로 다른 도선점으로 /route를 다시 입력하세요.');
  } else {
    lines.push('출발/도착 순서와 공식 코드를 확인한 뒤 구간 초안만 확정하세요.');
    buttons.push([{ text: '구간 초안 확정 (신청 아님)', callback_data: callback('c') }]);
  }
  lines.push('변경: /route FROM → TO · 20분 후 만료 · 실제 제출 기능 없음');
  const result = { text: lines.join('\n'), reply_markup: { inline_keyboard: buttons } };
  if (result.text.length > 4096 || buttons.flat().some(b => new TextEncoder().encode(b.callback_data).length > 64))
    throw new Error('TELEGRAM_MESSAGE_LIMIT');
  return result;
}
