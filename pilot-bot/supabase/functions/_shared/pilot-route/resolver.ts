import type { PilotPoint, PointCatalog } from './catalog.ts';

export const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const pointKey = (point: PilotPoint): string => `${point.portCode}:${point.pointCode}`;
// Preserve digits, hyphens, direction and T/S. Never collapse E-2 into P/S(E-2).
export const normalizePointName = (value: string): string => value.normalize('NFKC').toUpperCase()
  .trim().replace(/[\s#()./]/g, '');
const currentName = (point: PilotPoint): string => point.name.replace(/\s*\(구\s+[^)]+\)/g, '').trim();
const legacyNames = (point: PilotPoint): string[] => [...`${point.name} ${point.description}`
  .matchAll(/\(구\s+([^)]+)\)/g)].map(match => match[1].trim());

export interface PointResolution {
  input: string;
  kind: 'EXACT' | 'CHOOSE' | 'UNKNOWN';
  reason: 'CODE' | 'CURRENT_NAME' | 'LEGACY_OR_COLLISION' | 'SEARCH' | 'NO_MATCH';
  candidates: PilotPoint[];
}

export function assertFreshCatalog(catalog: PointCatalog, now: number): void {
  const observed = Date.parse(catalog.observedAt);
  if (!Number.isFinite(now) || !Number.isFinite(observed) || observed > now || now - observed >= CATALOG_MAX_AGE_MS)
    throw new Error('CATALOG_REFRESH_REQUIRED');
  if (!catalog.version || !catalog.points.length) throw new Error('INVALID_POINT_CATALOG');
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = next;
  }
  return previous[b.length];
}

export function resolvePoint(input: string, catalog: PointCatalog): PointResolution {
  if (!input.trim() || input.length > 100 || /[\x00-\x1f\x7f]/.test(input)) throw new Error('INVALID_POINT_INPUT');
  const query = normalizePointName(input);
  const base = { input };
  const code = input.trim().match(/^(?:(\d{2}):)?(\d{5})$/);
  if (code) {
    const candidates = catalog.points.filter(p => p.pointCode === code[2] && (!code[1] || p.portCode === code[1]));
    return { ...base, kind: candidates.length === 1 ? 'EXACT' : candidates.length ? 'CHOOSE' : 'UNKNOWN',
      reason: candidates.length ? 'CODE' : 'NO_MATCH', candidates };
  }
  if (query.length < 2) return { ...base, kind: 'UNKNOWN', reason: 'NO_MATCH', candidates: [] };
  const exact = catalog.points.filter(p => normalizePointName(p.name) === query || normalizePointName(currentName(p)) === query);
  const legacy = catalog.points.filter(p => legacyNames(p).some(alias => normalizePointName(alias) === query));
  const candidates = [...new Map([...exact, ...legacy].map(p => [pointKey(p), p])).values()];
  if (candidates.length) return { ...base,
    kind: exact.length === 1 && candidates.length === 1 && !legacy.length ? 'EXACT' : 'CHOOSE',
    reason: legacy.length || candidates.length > 1 ? 'LEGACY_OR_COLLISION' : 'CURRENT_NAME', candidates };

  const scored = catalog.points.map(point => {
    const name = normalizePointName(currentName(point));
    const description = normalizePointName(point.description);
    const score = name.startsWith(query) ? 0 : name.includes(query) ? 1
      : description.includes(query) || normalizePointName(point.portName).includes(query) ? 2
      : query.length >= 4 && distance(query, name) <= 1 ? 3 : 99;
    return { point, score };
  }).filter(p => p.score !== 99).sort((a, b) => a.score - b.score || pointKey(a.point).localeCompare(pointKey(b.point)));
  return { ...base, kind: scored.length ? 'CHOOSE' : 'UNKNOWN', reason: scored.length ? 'SEARCH' : 'NO_MATCH',
    candidates: scored.map(p => p.point) };
}

export interface RouteInput { from: string; to: string }
// A route line is deliberately explicit; arbitrary prose is never guessed into a port code.
export function parseRouteText(text: string): RouteInput {
  if (text.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('INVALID_ROUTE_TEXT');
  const lines = text.normalize('NFKC').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const labelled: Partial<RouteInput> = {};
  const arrowRoutes: RouteInput[] = [];
  for (const raw of lines) {
    const line = raw.replace(/^\/route(?:@[A-Za-z0-9_]+)?\s+/i, '').replace(/^구간\s*[:：]?\s*/, '');
    const label = line.match(/^(FROM|TO|출발|도착)\s*[:：]\s*(.+)$/i);
    if (label) {
      const side = /^(FROM|출발)$/i.test(label[1]) ? 'from' : 'to';
      if (labelled[side] !== undefined || /(?:->|→|=>)/.test(label[2])) throw new Error('AMBIGUOUS_ROUTE_TEXT');
      labelled[side] = label[2].trim();
    } else if (/(?:->|→|=>)/.test(line)) {
      const pair = line.split(/\s*(?:->|→|=>)\s*/);
      if (pair.length !== 2 || pair.some(s => !s.trim())) throw new Error('AMBIGUOUS_ROUTE_TEXT');
      arrowRoutes.push({ from: pair[0].trim(), to: pair[1].trim() });
    }
  }
  if (arrowRoutes.length > 1 || (arrowRoutes.length && Object.keys(labelled).length)) throw new Error('AMBIGUOUS_ROUTE_TEXT');
  const route = arrowRoutes[0] ?? labelled;
  if (!route.from || !route.to) throw new Error('FROM_TO_REQUIRED');
  if ([route.from, route.to].some(s => s.length > 100)) throw new Error('INVALID_POINT_INPUT');
  return { from: route.from, to: route.to };
}
