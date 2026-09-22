import { parseFragment } from "parse5";
import { normalizePilotSuspensionStatus } from '../../_shared/pilotSuspension.ts';

export const SOURCES = [
  { day: 0, cancelled: false, path: "get_cz_or_assign_s.php" },
  { day: 1, cancelled: false, path: "get_cz_or_assign_s02.php" },
  { day: 0, cancelled: true, path: "get_cz_or_assign_s.php" },
  { day: 1, cancelled: true, path: "get_cz_or_assign_s02.php" },
] as const;
export interface PilotRow {
  identity: string;
  vessel_name: string;
  callsign: string;
  pilot_date: string;
  pilot_time: string;
  from_location: string;
  to_location: string;
  agent: string;
  status: string;
  raw_status: string;
  remarks: string;
  cancelled: boolean;
  draft: string;
  pilot: string;
  tug: string;
}
export const clean = (s: string) => s.normalize("NFKC").replace(/\s+/gu, " ").trim();
export function normalizeStatus(s: string): string {
  const value = clean(s).toUpperCase();
  const suspension = normalizePilotSuspensionStatus(value);
  if (suspension) return suspension;
  if (value === "PROCESSING") return "PROCESSING";
  return value || "UNSPECIFIED";
}
export const kstDate = (date: Date) => new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
export async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
type HtmlNode = { nodeName: string; value?: string; childNodes?: HtmlNode[] };
function text(node: HtmlNode): string {
  if (node.nodeName === "#comment") return "";
  return node.value ?? (node.childNodes ?? []).map(text).join(" ");
}
function find(node: HtmlNode, name: string): HtmlNode[] {
  return [...(node.nodeName === name ? [node] : []), ...(node.childNodes ?? []).flatMap(n => find(n, name))];
}
export async function parseForecast(html: string, date: string, cancelled: boolean): Promise<PilotRow[]> {
  if (html.length > 1_000_000 || /<\s*(?:html|script|iframe)\b|cloudflare|captcha|access denied/i.test(html)) throw new Error("SOURCE_BLOCKED_OR_OVERSIZE");
  // A fragment alone cannot establish an empty-list contract. The collector
  // handles the verified cancellation sentinel only with a valid paired base feed.
  if (!html.trim()) throw new Error("EMPTY_SOURCE_UNVERIFIED");
  const root = parseFragment(`<table><tbody>${html}</tbody></table>`) as HtmlNode;
  const trs = find(root, "tr");
  if (!trs.length || trs.length > 2000) throw new Error("SOURCE_SHAPE");
  return Promise.all(trs.map(async tr => {
    const c = (tr.childNodes ?? []).filter(n => n.nodeName === "td").map(n => clean(text(n)));
    if (c.length !== 20 || !/^\d+$/.test(c[0]) || !/^\d{2}:\d{2}$/.test(c[3]) || Number(c[3].slice(0, 2)) > 23 || Number(c[3].slice(3)) > 59 || !c[4] || !c[10] || !c[11] || !c[12]) throw new Error("SOURCE_SHAPE");
    if (c.some(v => v.length > 2000)) throw new Error("SOURCE_FIELD_LIMIT");
    if ([4,10,11,12].some(i=>c[i].length>160) || c[1].length>80 || c[6].length>40) throw new Error("SOURCE_FIELD_LIMIT");
    const vessel = c[4].toUpperCase(), callsign = c[6].toUpperCase();
    const identity = await sha256(JSON.stringify([callsign, vessel, date, c[10].toUpperCase(), c[11].toUpperCase()]));
    return { identity, vessel_name: vessel, callsign, pilot_date: date, pilot_time: c[3], from_location: c[10], to_location: c[11], agent: c[12], status: cancelled ? "CANCELLED" : normalizeStatus(c[1]), raw_status: c[1], remarks: c[19], cancelled, draft: c[9], pilot: c[5], tug: c[16] };
  }));
}
export async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > maximum) throw new Error("RESPONSE_LIMIT");
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
export async function fetchForecast(fetcher: typeof fetch = fetch) {
  const started = new Date();
  // All four must succeed. No retry, redirect, asset fetch or browser rendering.
  const responses = await Promise.all(SOURCES.map(async source => {
    const params = new URLSearchParams(Object.fromEntries([1,2,3,4,5,6].map(n => [`s_fg_status${n}`, source.cancelled && n === 6 ? "090" : ""])));
    const response = await fetcher(`http://www.ulsanpilot.co.kr/main/${source.path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params, redirect: "error", signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error("SOURCE_HTTP");
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) throw new Error("SOURCE_CONTENT_TYPE");
    const serverDate = new Date(response.headers.get("date") ?? "");
    if (!Number.isFinite(serverDate.getTime()) || Math.abs(serverDate.getTime() - Date.now()) > 180_000 || kstDate(serverDate) !== kstDate(started)) throw new Error("SOURCE_DATE");
    const bytes = await readBounded(response, 1_000_000);
    const date = kstDate(new Date(serverDate.getTime() + source.day * 86400_000));
    return { html: new TextDecoder("utf-8", { fatal: true }).decode(bytes), date, source, ingress: bytes.length };
  }));
  const parsed = await Promise.all(responses.map(async response => {
    // Live page + HTTP verified 2026-09-21: a cancellation filter with zero
    // results returns exactly CRLF. Do not accept a zero-byte body, arbitrary
    // whitespace/error markup, or an empty base feed as normal data.
    if (response.source.cancelled && response.html === "\r\n") return null;
    return parseForecast(response.html, response.date, response.source.cancelled);
  }));
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i] !== null) continue;
    const paired = responses.findIndex(r => !r.source.cancelled && r.date === responses[i].date);
    if (paired < 0 || !parsed[paired]?.length) throw new Error("EMPTY_SOURCE_UNVERIFIED");
    parsed[i] = [];
  }
  if (kstDate(new Date()) !== kstDate(started)) throw new Error("MIDNIGHT_BOUNDARY");
  const rows = parsed.flatMap(r => r ?? []).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const serialized = JSON.stringify(rows);
  if (new TextEncoder().encode(serialized).length > 512_000) throw new Error("SNAPSHOT_LIMIT");
  return { rows, hash: await sha256(serialized), ingress: responses.reduce((sum,r) => sum+r.ingress,0) };
}
