import type { PilotPoint, PointCatalog } from './catalog.ts';
import { assertFreshCatalog, parseRouteText, pointKey, resolvePoint } from './resolver.ts';

export interface Actor { chatId: string; userId: string }
export interface RouteSlot { input: string; candidates: string[]; selected: string | null; match: string }
export interface RouteDraft {
  id: string;
  revision: number;
  actor: Actor;
  catalogVersion: string;
  expiresAt: number;
  status: 'SELECTING' | 'CONFIRMED_DRAFT';
  from: RouteSlot;
  to: RouteSlot;
  confirmedAt: number | null;
}
export const DRAFT_TTL_MS = 20 * 60 * 1000;
export type RouteAction = { draftId: string; revision: number } & (
  { type: 'SELECT'; side: 'from' | 'to'; key: string } | { type: 'CONFIRM' }
);

function validateActor(actor: Actor): void {
  if (!/^-?\d{1,20}$/.test(actor.chatId) || !/^\d{1,20}$/.test(actor.userId)) throw new Error('INVALID_ACTOR');
}

export function createRouteDraft(id: string, actor: Actor, text: string, catalog: PointCatalog, now: number): RouteDraft {
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) throw new Error('INVALID_DRAFT_ID');
  validateActor(actor);
  assertFreshCatalog(catalog, now);
  const route = parseRouteText(text);
  const slot = (input: string): RouteSlot => {
    const resolution = resolvePoint(input, catalog);
    return { input, candidates: resolution.candidates.map(pointKey),
      selected: resolution.kind === 'EXACT' ? pointKey(resolution.candidates[0]) : null,
      match: resolution.reason };
  };
  return { id, revision: 0, actor: { ...actor }, catalogVersion: catalog.version,
    expiresAt: now + DRAFT_TTL_MS, status: 'SELECTING', from: slot(route.from), to: slot(route.to), confirmedAt: null };
}

export function assertDraftAccess(draft: RouteDraft, actor: Actor, catalog: PointCatalog, now: number): void {
  validateActor(actor);
  if (actor.chatId !== draft.actor.chatId || actor.userId !== draft.actor.userId) throw new Error('DRAFT_OWNER_ONLY');
  if (now >= draft.expiresAt) throw new Error('DRAFT_EXPIRED');
  assertFreshCatalog(catalog, now);
  if (catalog.version !== draft.catalogVersion) throw new Error('CATALOG_CHANGED');
}

export function applyRouteAction(draft: RouteDraft, actor: Actor, action: RouteAction, catalog: PointCatalog, now: number): RouteDraft {
  assertDraftAccess(draft, actor, catalog, now);
  if (action.draftId !== draft.id || action.revision !== draft.revision) throw new Error('STALE_DRAFT_BUTTON');
  if (draft.status !== 'SELECTING') throw new Error('DRAFT_ALREADY_CONFIRMED');
  const next = structuredClone(draft);
  if (action.type === 'SELECT') {
    if (!next[action.side].candidates.includes(action.key) || !catalog.points.some(p => pointKey(p) === action.key))
      throw new Error('POINT_NOT_OFFERED');
    next[action.side].selected = action.key;
    next[action.side].match = 'USER_SELECTED';
  } else {
    if (!next.from.selected || !next.to.selected) throw new Error('BOTH_POINTS_REQUIRED');
    if (next.from.selected === next.to.selected) throw new Error('SAME_FROM_TO');
    for (const side of ['from', 'to'] as const)
      if (!next[side].candidates.includes(next[side].selected!) || !catalog.points.some(p => pointKey(p) === next[side].selected))
        throw new Error('INVALID_SELECTED_POINT');
    next.status = 'CONFIRMED_DRAFT';
    next.confirmedAt = now;
  }
  next.revision++;
  return next;
}

/** Route-only preview. This is not an application, submission payload or portal client. */
export function confirmedRoutePreview(draft: RouteDraft, actor: Actor, catalog: PointCatalog, now: number): {
  submissionAllowed: false; from: PilotPoint; to: PilotPoint; catalogVersion: string;
} {
  assertDraftAccess(draft, actor, catalog, now);
  if (draft.status !== 'CONFIRMED_DRAFT' || draft.from.selected === draft.to.selected) throw new Error('ROUTE_NOT_CONFIRMED');
  const from = catalog.points.find(p => pointKey(p) === draft.from.selected);
  const to = catalog.points.find(p => pointKey(p) === draft.to.selected);
  if (!from || !to) throw new Error('INVALID_SELECTED_POINT');
  return { submissionAllowed: false, from: { ...from }, to: { ...to }, catalogVersion: catalog.version };
}
