import { parse } from 'parse5';
import { classifyApplicationStatus } from './hyopuQueue.ts';
import { clean, readBounded, sha256 } from './source.ts';

const ORIGIN = 'https://www.ulsanpilot.co.kr';
const LOGIN = '/crew/member/login.php';
const AUTH = '/crew/member/login_check.php';
const LIST = '/crew/sub01/sub02_01.php';
export type SourceTransport = 'https' | 'http-approved';
export interface DateRange { start: string; end: string }
export interface ApplicationObservation {
  application_id: string | null; vessel_name: string; callsign: string; pilot_date: string;
  pilot_time: string; from_location: string; to_location: string; application_status: string;
  completion_status: string; agent: string; association_remark: string; remarks: string; raw_application_status:string; draft:string;
  mooring_name?: string;
}
interface Node { nodeName: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[] }
const attr = (n: Node, name: string) => n.attrs?.find(a => a.name === name)?.value ?? '';
const all = (n: Node, name: string): Node[] => [...(n.nodeName === name ? [n] : []), ...(n.childNodes ?? []).flatMap(c => all(c, name))];
const content = (n: Node): string => n.nodeName === '#comment' || n.nodeName === 'script' || n.nodeName === 'style' ? ''
  : n.value ?? (n.childNodes ?? []).map(content).join(' ');
const cells = (n: Node) => (n.childNodes ?? []).filter(c => ['td', 'th'].includes(c.nodeName));

export function checkRange(range: DateRange): void {
  for (const s of [range.start, range.end]) {
    const d = new Date(`${s}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(+d) || d.toISOString().slice(0, 10) !== s) throw new Error('APPLICATION_RANGE');
  }
  if (range.start > range.end) throw new Error('APPLICATION_RANGE');
}

export function parseApplications(html: string, range: DateRange): ApplicationObservation[] {
  checkRange(range);
  // Observed unauthenticated list response is HTTP 200 with this script and
  // no closing HTML. Treat it as expiry, never as an empty application list.
  if (/<script\b[^>]*>\s*alert\(['"]로그인 후 사용이 가능합니다\.['"]\);?\s*<\/script>/i.test(html)) throw new Error('SESSION_EXPIRED');
  if (!/<\/body\s*>[\s\S]*<\/html\s*>/i.test(html)) throw new Error('APPLICATION_TRUNCATED');
  if (/cloudflare|cf-chl-|g-recaptcha|h-captcha|access denied/i.test(html)) throw new Error('APPLICATION_CHALLENGE');
  const root = parse(html) as Node;
  if (all(root, 'form').some(f => attr(f, 'name') === 'login_frm')) throw new Error('SESSION_EXPIRED');
  if (!clean(content(root)).includes('협운해운 ON')) throw new Error('APPLICATION_ACCOUNT');
  const inputs = all(root, 'input');
  for (const [name, value] of [['s_dt_ships', range.start], ['s_dt_shipe', range.end]])
    if (!inputs.some(n => attr(n, 'name') === name && attr(n, 'value') === value.replaceAll('-', ''))) throw new Error('APPLICATION_RANGE_ECHO');
  const tables = all(root, 'table').filter(t => {
    const header = all(t, 'tr')[0];
    return header && cells(header).length === 29 && clean(content(cells(header)[11])) === 'C/SIGN';
  });
  if (tables.length !== 1) throw new Error('APPLICATION_TABLE');
  const trs = all(tables[0], 'tr');
  const header = cells(trs[0]).map(c => clean(content(c)));
  for (const [index, expected] of [[1, '상태'], [4, 'DATE'], [5, 'TIME'], [6, "SHIP'S NAME"], [15, 'FROM'], [16, 'TO'], [21, 'L/A'], [23, 'L']] as const)
    if (header[index] !== expected) throw new Error('APPLICATION_HEADER');
  if (trs.length > 2001) throw new Error('APPLICATION_TOO_LARGE');
  // Observed on an authenticated, echoed 2099-01-01 query: the legacy
  // 29-column table uses colspan=27 for its single explicit no-results row.
  if (trs.length === 2 && cells(trs[1]).length === 1
    && attr(cells(trs[1])[0], 'colspan') === '27'
    && clean(content(cells(trs[1])[0])) === '검색된 자료가 없습니다.') return [];
  if (trs.length === 1) throw new Error('APPLICATION_EMPTY_UNVERIFIED');
  const ids = new Set<string>();
  return trs.slice(1).map(tr => {
    const c = cells(tr).map(n => clean(content(n)));
    if (c.length !== 29 || !/^\d+$/.test(c[0].split(' ')[0])) throw new Error('APPLICATION_ROW');
    if (c[21] !== '협운') throw new Error('APPLICATION_AGENCY');
    const date = c[4].replaceAll('/', '-');
    checkRange({ start: date, end: date });
    if (date < range.start || date > range.end || (c[5] !== '' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(c[5]))) throw new Error('APPLICATION_DATE');
    const status = classifyApplicationStatus(c[1]);
    // Observed HYOPU July 2019 cancellations retain the callsign/route but have
    // an empty vessel master cell. Preserve this explicit terminal evidence;
    // never invent a vessel name or use it as an active application's identity.
    if ((!c[6] && status.lifecycle !== 'CANCELLED') || c[6].length > 160
      || [c[11], c[15], c[16]].some(v => !v || v.length > 160) || c[25].length > 2000) throw new Error('APPLICATION_FIELDS');
    if (c[23].length > 80) throw new Error('APPLICATION_MOORING');
    const links = all(tr, 'a').map(a => attr(a, 'href')).filter(h => h.includes('sub02_03.php?'));
    if (links.length > 1) throw new Error('APPLICATION_ID');
    let id: string | null = null;
    if (links.length) {
      const url = new URL(links[0], `${ORIGIN}${LIST}`);
      id = url.searchParams.get('no_forecast');
      if (url.origin !== ORIGIN || url.pathname !== '/crew/sub01/sub02_03.php' || !/^\d{1,30}$/.test(id ?? '')
        || url.searchParams.get('s_cd_partner') !== '1002' || ids.has(id!)) throw new Error('APPLICATION_ID');
      ids.add(id!);
    }
    if (!c[6] && id !== null) throw new Error('APPLICATION_FIELDS');
    // Live contract (2026-09-21): POB removes the edit link/no_forecast, too.
    // Keep the explicit POB observation without inventing an ID. The DB must
    // uniquely reconcile it to an existing job before accepting the snapshot.
    if (!id && status.code !== '040' && !['COMPLETED', 'CANCELLED'].includes(status.lifecycle)) throw new Error('ACTIVE_APPLICATION_ID_MISSING');
    return { application_id: id, vessel_name: c[6], callsign: c[11].toUpperCase(), pilot_date: date, pilot_time: c[5],
      from_location: c[15], to_location: c[16], application_status: status.code ?? c[1], completion_status: status.lifecycle,
      // L verified against read-only edit fields sn_partner/cd_partner_line.
      // Preserve the site's abbreviation; never guess a full name or company code.
      agent: c[21], association_remark: c[3], remarks: c[25], raw_application_status:c[1], draft:c[14], mooring_name:c[23] };
  });
}

export interface SessionCookie { name: string; value: string; domain: string; path: string; secure: boolean; expires: number | null }
export function updateCookies(jar: SessionCookie[], headers: Headers, url: URL, now = Date.now()): SessionCookie[] {
  let result = jar.filter(c => c.expires === null || c.expires > now);
  for (const raw of headers.getSetCookie()) {
    const [pair, ...parts] = raw.split(';'); const equals = pair.indexOf('=');
    if (equals < 1) throw new Error('SESSION_COOKIE_INVALID');
    const name = pair.slice(0, equals).trim(), value = pair.slice(equals + 1).trim();
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\r\n;]/.test(value)) throw new Error('SESSION_COOKIE_INVALID');
    const props = new Map(parts.map(p => { const i = p.indexOf('='); return [p.slice(0, i < 0 ? undefined : i).trim().toLowerCase(), i < 0 ? '' : p.slice(i + 1).trim()]; }));
    const domain = (props.get('domain') ?? url.hostname).replace(/^\./, '').toLowerCase();
    if (domain !== 'ulsanpilot.co.kr' && domain !== url.hostname) throw new Error('SESSION_COOKIE_DOMAIN');
    const path = props.get('path')?.startsWith('/') ? props.get('path')! : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
    const expires = props.has('max-age') ? now + Number(props.get('max-age')) * 1000
      : props.has('expires') ? Date.parse(props.get('expires')!) : null;
    if (expires !== null && !Number.isFinite(expires)) throw new Error('SESSION_COOKIE_EXPIRY');
    result = result.filter(c => !(c.name === name && c.domain === domain && c.path === path));
    if (expires === null || expires > now) result.push({ name, value, domain, path, secure: props.has('secure'), expires });
  }
  if (JSON.stringify(result).length > 8192) throw new Error('SESSION_COOKIE_LIMIT');
  return result;
}

export class UlsanReadClient {
  cookies: SessionCookie[];
  ingress = 0;
  requestCount = 0;
  private credentials: { username: string; password: string };
  private fetcher: typeof fetch;
  private origin: string;
  private loginAttempts = 0;
  constructor(credentials: { username: string; password: string }, fetcher: typeof fetch = fetch, cookies: SessionCookie[] = [], transport: SourceTransport = 'https') {
    if (!['https', 'http-approved'].includes(transport)) throw new Error('SOURCE_TRANSPORT');
    // HTTP is explicit operator opt-in, never an automatic TLS-error fallback.
    this.origin = transport === 'http-approved' ? 'http://www.ulsanpilot.co.kr' : ORIGIN;
    this.credentials = credentials; this.fetcher = fetcher;
    this.cookies = cookies;
  }
  private async request(path: string, body?: URLSearchParams): Promise<{ html: string; status: number; location: string | null }> {
    // Exact read/login allowlist: application creation, amendment and deletion cannot be called.
    if (![LOGIN, AUTH, LIST].includes(path)) throw new Error('SOURCE_PATH_FORBIDDEN');
    const url = new URL(path, this.origin);
    const headers: Record<string, string> = { Accept: 'text/html' };
    const cookie = this.cookies.filter(c => (c.expires === null || c.expires > Date.now())
      && (!c.secure || url.protocol === 'https:')
      && (url.hostname === c.domain || url.hostname.endsWith(`.${c.domain}`))
      && (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`)))
      .map(c => `${c.name}=${c.value}`).join('; ');
    if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const response = await this.fetcher(url, { method: body ? 'POST' : 'GET', headers, body,
      redirect: 'manual', signal: AbortSignal.timeout(20_000) }).catch((error: unknown) => {
      const detail = error as { name?: string; cause?: { code?: string } };
      if (detail.cause?.code === 'ERR_TLS_CERT_ALTNAME_INVALID') throw new Error('SOURCE_TLS_HOSTNAME_MISMATCH');
      if (detail.name === 'TimeoutError' || detail.name === 'AbortError') throw new Error('SOURCE_TIMEOUT');
      // Never expose raw fetch errors (which can include URLs or credentials).
      throw new Error('SOURCE_NETWORK_ERROR');
    });
    this.requestCount++;
    this.cookies = updateCookies(this.cookies, response.headers, url);
    const bytes = await readBounded(response, 2_000_000).catch((error:unknown)=>{
      const detail=error as {name?:string;message?:string};
      if(detail.message==='RESPONSE_LIMIT')throw error;
      if(detail.name==='TimeoutError'||detail.name==='AbortError')throw Error('SOURCE_BODY_TIMEOUT');
      throw Error('SOURCE_BODY_FAILED');
    }); this.ingress += bytes.length;
    if (response.status >= 400) throw new Error('APPLICATION_HTTP');
    return { html: new TextDecoder('utf-8', { fatal: true }).decode(bytes), status: response.status, location: response.headers.get('location') };
  }
  async login(): Promise<void> {
    this.loginAttempts++;
    const page = await this.request(LOGIN);
    if (/g-recaptcha|h-captcha|cf-chl-/i.test(page.html)) throw new Error('LOGIN_CHALLENGE');
    const root = parse(page.html) as Node;
    const forms = all(root, 'form').filter(f => attr(f, 'name') === 'login_frm');
    if (forms.length !== 1 || attr(forms[0], 'method').toLowerCase() !== 'post'
      || new URL(attr(forms[0], 'action'), `${this.origin}${LOGIN}`).href !== `${this.origin}${AUTH}`) throw new Error('LOGIN_FORM_CHANGED');
    const fields = all(forms[0], 'input');
    if (!fields.some(n => attr(n, 'name') === 'l_id') || !fields.some(n => attr(n, 'name') === 'l_pw')) throw new Error('LOGIN_FORM_CHANGED');
    const body = new URLSearchParams(fields.filter(n => attr(n, 'type') === 'hidden').map(n => [attr(n, 'name'), attr(n, 'value')]));
    body.set('l_id', this.credentials.username); body.set('l_pw', this.credentials.password);
    const result = await this.request(AUTH, body);
    if (result.location) {
      const destination = new URL(result.location, `${this.origin}${AUTH}`);
      if (destination.origin !== this.origin || !destination.pathname.startsWith('/crew/')) throw new Error('LOGIN_REDIRECT_REJECTED');
    }
    // The response itself is not success evidence. Only authenticated list parsing proves success.
    if (!this.cookies.length || /alert\s*\(/i.test(result.html)) throw new Error('LOGIN_REJECTED');
  }
  async applications(range: DateRange): Promise<ApplicationObservation[]> {
    checkRange(range);
    const body = new URLSearchParams({ s_dt_ships: range.start.replaceAll('-', ''), s_dt_shipe: range.end.replaceAll('-', ''),
      s_tm_ship_f: '00', s_tm_ship_t: '23', s_cd_pointend_pipe: '', cd_partner: '1002', ln_partner: '협운해운' });
    const response = await this.request(LIST, body);
    if (response.status >= 300 || response.location) throw new Error('SESSION_EXPIRED');
    return parseApplications(response.html, range);
  }
  /** One client per watcher execution. Reused sessions are tried first; at most
   * one login is allowed across all ranges in that execution. */
  async authenticatedApplications(range: DateRange): Promise<ApplicationObservation[]> {
    checkRange(range);
    if (!this.cookies.length && this.loginAttempts === 0) await this.login();
    try { return await this.applications(range); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'SESSION_EXPIRED' || this.loginAttempts > 0) throw error;
      this.cookies = [];
      await this.login();
      return this.applications(range);
    }
  }
}

export async function sealSession(cookies: SessionCookie[], keyHex: string): Promise<string> {
  const key = await sessionKey(keyHex); const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('ulsan-session-v1') }, key, new TextEncoder().encode(JSON.stringify(cookies))));
  return JSON.stringify({ v: 2, iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...encrypted)) });
}
async function sessionKey(hex: string): Promise<CryptoKey> {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('SESSION_KEY_INVALID');
  return crypto.subtle.importKey('raw', Uint8Array.from(hex.match(/../g)!.map(s => parseInt(s, 16))), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function openSession(sealed: string, keyHex: string): Promise<SessionCookie[]> {
  if (sealed.length > 65536) throw new Error('SESSION_INVALID');
  try {
    const s = JSON.parse(sealed); if (![1,2].includes(s.v)) throw new Error();
    const decode=(x:any)=>s.v===1?new Uint8Array(x):Uint8Array.from(atob(x),c=>c.charCodeAt(0));
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(s.iv), additionalData: new TextEncoder().encode('ulsan-session-v1') }, await sessionKey(keyHex), decode(s.data));
    const jar = JSON.parse(new TextDecoder().decode(data));
    if (!Array.isArray(jar) || jar.length > 20) throw new Error();
    return jar;
  } catch { throw new Error('SESSION_INVALID'); }
}
export const applicationHash = (rows: ApplicationObservation[]) => sha256(JSON.stringify([...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
