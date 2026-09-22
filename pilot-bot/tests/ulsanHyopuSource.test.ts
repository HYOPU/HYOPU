// @vitest-environment node
// Synthetic, privacy-redacted contract tests. NOT proof of a successful server login.
import { describe, expect, it } from 'vitest';
import { parseApplications, updateCookies, sealSession, openSession, UlsanReadClient } from '../supabase/functions/ulsan-pilot-watcher/lib/hyopuSource';
const range = { start: '2026-09-20', end: '2026-09-22' };
const header = ['NO','상태','C/F','협회 REMARK','DATE','TIME',"SHIP'S NAME",'PILOT (s)','P','Two.','Co.','C/SIGN','G/T','LOA','DFT','FROM','TO','CA','S/A','B/T','G/A','L/A','T','L','Q','REMARKS','PIC','TEL',"SHIP'S NAME"];
const fixture = (status = '변경', id: string | null = '123', extra = '') => `<html><body><div>협운해운 ON</div>
  <form name="ser_frm"><input name="s_dt_ships" value="20260920"><input name="s_dt_shipe" value="20260922"></form>
  <table><tr>${header.map(v => `<th>${v}</th>`).join('')}</tr><tr>${[
    `1 ${id ? `<a href="sub02_03.php?no_forecast=${id}&s_dt_ship=20260920&s_cd_partner=1002">수정</a>` : ''}`,
    status,'','Bad weather','2026/09/20','14:00','TEST VESSEL','','','','','TEST1','100','100','6.0','P/S','OTK(S)','','','','협운해운','협운','','','','test','REDACTED','REDACTED','TEST VESSEL',
  ].map(v => `<td>${v}</td>`).join('')}</tr></table>${extra}</body></html>`;

describe('login-source parser: observed shape, synthetic fixtures', () => {
  it('preserves observed nameless historical cancellation without guessing its vessel',()=>{
    const html=fixture('취소',null).replaceAll('<td>TEST VESSEL</td>','<td></td>');
    expect(parseApplications(html,range)[0]).toMatchObject({vessel_name:'',application_id:null,completion_status:'CANCELLED'});
    for(const status of ['요청','완료','청구'])expect(()=>parseApplications(fixture(status,status==='요청'?'123':null).replaceAll('<td>TEST VESSEL</td>','<td></td>'),range)).toThrow('APPLICATION_FIELDS');
    expect(()=>parseApplications(fixture('취소','123').replaceAll('<td>TEST VESSEL</td>','<td></td>'),range)).toThrow('APPLICATION_FIELDS');
  });
  it('normalizes remark entities, NBSP and newlines exactly once before comparison',()=>{
    const read=(s:string)=>parseApplications(fixture().replace('<td>test</td>',`<td>${s}</td>`),range)[0].remarks;
    expect(read(' KEYOUNG&nbsp; STAR\n  이안 후 ')).toBe(read('KEYOUNG STAR 이안 후'));
    expect(read('A &amp; B')).toBe(read('A &#38; B'));
    expect(read('A &amp;lt; B')).toBe('A &lt; B');
  });
  it('reads only verified L column as mooring and rejects shifted headers',()=>{
    const html=fixture().replace('<td>협운</td><td></td><td></td>', '<td>협운</td><td>2</td><td>진산</td>');
    expect(parseApplications(html,range)[0].mooring_name).toBe('진산');
    expect(parseApplications(fixture(),range)[0].mooring_name).toBe('');
    expect(()=>parseApplications(html.replace('<th>L</th>','<th>CHANGED</th>'),range)).toThrow('APPLICATION_HEADER');
  });
  it('keeps login state separate from association weather remarks and drops contacts', () => {
    const rows = parseApplications(fixture(), range);
    expect(rows[0]).toMatchObject({ application_id: '123', application_status: '030', completion_status: 'ACTIVE', association_remark: 'Bad weather' });
    expect(JSON.stringify(rows)).not.toContain('REDACTED');
    expect(rows[0]).not.toHaveProperty('forecast_status');
  });
  it.each(['완료', '청구', '취소'])('retains unidentified terminal evidence %s without inventing an ID', status => {
    expect(parseApplications(fixture(status, null), range)[0].application_id).toBeNull();
  });
  it('retains the observed ID-less POB row as explicit active evidence for DB reconciliation', () => {
    expect(parseApplications(fixture('POB', null), range)[0]).toMatchObject({application_id:null,application_status:'040',raw_application_status:'POB',completion_status:'ACTIVE'});
  });
  it.each(['요청','확인','변경','UNKNOWN'])('still rejects unverified ID-less %s rather than silently dropping work', status => {
    expect(() => parseApplications(fixture(status, null), range)).toThrow('ACTIVE_APPLICATION_ID_MISSING');
  });
  it('rejects wrong agency, changed date range and partial HTML', () => {
    expect(() => parseApplications(fixture().replace('<td>협운</td>', '<td>OTHER</td>'), range)).toThrow('APPLICATION_AGENCY');
    expect(() => parseApplications(fixture().replace('value="20260922"', 'value="20260920"'), range)).toThrow('APPLICATION_RANGE_ECHO');
    expect(() => parseApplications(fixture().replace('</html>', ''), range)).toThrow('APPLICATION_TRUNCATED');
  });
  it('rejects a login form returned with HTTP 200', () => {
    expect(() => parseApplications(fixture('변경', '123', '<form name="login_frm"></form>'), range)).toThrow('SESSION_EXPIRED');
  });
  it('recognizes the actual unauthenticated HTTP 200 script without treating it as empty', () => {
    expect(() => parseApplications("<script> alert('로그인 후 사용이 가능합니다.'); </script>", range)).toThrow('SESSION_EXPIRED');
  });
  it('accepts only the observed authenticated no-results row, not a silently empty table', () => {
    const empty = fixture().replace(/<tr><td>[\s\S]*?<\/tr>/, '<tr><td colspan="27">검색된 자료가 없습니다.</td></tr>');
    expect(parseApplications(empty, range)).toEqual([]);
    expect(() => parseApplications(empty.replace('검색된 자료가 없습니다.', '오류'), range)).toThrow('APPLICATION_ROW');
    expect(() => parseApplications(empty.replace('<tr><td colspan="27">검색된 자료가 없습니다.</td></tr>', ''), range)).toThrow('APPLICATION_EMPTY_UNVERIFIED');
    expect(() => parseApplications(empty.replace('</html>', ''), range)).toThrow('APPLICATION_TRUNCATED');
  });
});

describe('secure login transport', () => {
  it('renews an expired reused session once per execution, not once per range', async () => {
    const paths: string[] = [];
    const transport = (async (url: unknown) => {
      paths.push(new URL(String(url)).pathname);
      if (paths.length === 2) return new Response('<form name="login_frm" method="post" action="login_check.php"><input name="l_id"><input name="l_pw"></form>', { headers: { 'set-cookie': 'PHPSESSID=fresh; Path=/' } });
      if (paths.length === 3) return new Response('');
      if (paths.length === 4) return new Response(fixture());
      return new Response("<script>alert('로그인 후 사용이 가능합니다.');</script>");
    }) as typeof fetch;
    const stale = [{ name: 'PHPSESSID', value: 'expired', domain: 'www.ulsanpilot.co.kr', path: '/', secure: false, expires: null }];
    const client = new UlsanReadClient({ username: 'TEST', password: 'TEST' }, transport, stale, 'http-approved');
    expect(await client.authenticatedApplications(range)).toHaveLength(1);
    await expect(client.authenticatedApplications(range)).rejects.toThrow('SESSION_EXPIRED');
    expect(paths.filter(p => p.endsWith('login_check.php'))).toHaveLength(1);
  });
  it('requires explicit HTTP approval and never sends Secure cookies over HTTP', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const transport = (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return new Response('<form name="login_frm" method="post" action="http://www.ulsanpilot.co.kr/crew/member/login_check.php"><input name="l_id"><input name="l_pw"></form>', { headers: { 'set-cookie': 'PHPSESSID=synthetic; Path=/' } });
      return new Response('', { status: 302, headers: { location: '/crew/main/main.php' } });
    }) as typeof fetch;
    const cookies = [{ name: 'SECURE_ONLY', value: 'private', domain: 'www.ulsanpilot.co.kr', path: '/', secure: true, expires: null }];
    await new UlsanReadClient({ username: 'TEST', password: 'TEST' }, transport, cookies, 'http-approved').login();
    expect(calls).toHaveLength(2);
    expect(calls.every(c => new URL(c.url).origin === 'http://www.ulsanpilot.co.kr')).toBe(true);
    expect(JSON.stringify(calls.map(c => c.init.headers))).not.toContain('SECURE_ONLY');
    expect((calls[1].init.headers as Record<string,string>).Cookie).toBe('PHPSESSID=synthetic');
  });
  it('does not post credentials to an HTTP form without approval or to another host', async () => {
    for (const [mode, action] of [['https', 'http://www.ulsanpilot.co.kr/crew/member/login_check.php'], ['http-approved', 'http://example.test/crew/member/login_check.php']] as const) {
      let calls = 0;
      const transport = (async () => { calls++; return new Response(`<form name="login_frm" method="post" action="${action}"><input name="l_id"><input name="l_pw"></form>`); }) as typeof fetch;
      await expect(new UlsanReadClient({ username: 'TEST', password: 'TEST' }, transport, [], mode).login()).rejects.toThrow('LOGIN_FORM_CHANGED');
      expect(calls).toBe(1);
    }
  });
  it('does not send credentials when TLS validation fails on the initial GET', async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const transport = (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), method: init.method, body: init.body });
      throw new TypeError('fetch failed', { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } });
    }) as typeof fetch;
    await expect(new UlsanReadClient({ username: 'TEST_USER', password: 'TEST_PASSWORD' }, transport).login()).rejects.toThrow('SOURCE_TLS_HOSTNAME_MISMATCH');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.startsWith('https://')).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('TEST_PASSWORD');
    expect(calls.every(c => !c.url.startsWith('http://'))).toBe(true);
  });
  it('posts only observed login fields, passes hidden CSRF fields, and disables redirects', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const transport = (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return new Response('<form name="login_frm" method="post" action="login_check.php"><input name="l_id"><input name="l_pw" type="password"><input name="go_url" type="hidden" value=""><input name="csrf" type="hidden" value="synthetic"></form>', { headers: { 'set-cookie': 'SESSION=test; Path=/; Secure; HttpOnly' } });
      return new Response('', { status: 302, headers: { location: '/crew/main/main.php' } });
    }) as typeof fetch;
    const client = new UlsanReadClient({ username: 'TEST_USER', password: 'TEST_PASSWORD' }, transport);
    await client.login();
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://www.ulsanpilot.co.kr/crew/member/login_check.php');
    expect(calls[1].init.redirect).toBe('manual');
    const body = calls[1].init.body as URLSearchParams;
    expect(body.get('l_pw')).toBe('TEST_PASSWORD');
    expect(body.get('csrf')).toBe('synthetic');
    expect(body.has('chk_saveid')).toBe(false);
  });
  it('does not follow an authentication redirect to another host', async () => {
    let calls = 0;
    const transport = (async () => ++calls === 1 ? new Response('<form name="login_frm" method="post" action="login_check.php"><input name="l_id"><input name="l_pw"></form>', { headers: { 'set-cookie': 'SESSION=test; Path=/' } })
      : new Response('', { status: 302, headers: { location: 'https://example.test/' } })) as typeof fetch;
    await expect(new UlsanReadClient({ username: 'TEST', password: 'TEST' }, transport).login()).rejects.toThrow('LOGIN_REDIRECT_REJECTED');
    expect(calls).toBe(2);
  });
  it('scopes cookies and honors expiry without logging their values', () => {
    const url = new URL('https://www.ulsanpilot.co.kr/crew/member/login.php');
    let jar = updateCookies([], new Headers({ 'set-cookie': 'SESSION=test; Path=/crew/; Secure; Max-Age=60' }), url, 1000);
    expect(jar[0]).toMatchObject({ path: '/crew/', secure: true, expires: 61000 });
    jar = updateCookies(jar, new Headers({ 'set-cookie': 'SESSION=gone; Path=/crew/; Max-Age=0' }), url, 2000);
    expect(jar).toEqual([]);
    expect(() => updateCookies([], new Headers({ 'set-cookie': 'SESSION=test; Domain=example.test' }), url)).toThrow('SESSION_COOKIE_DOMAIN');
  });
  it('encrypts shared sessions and rejects wrong keys or damaged ciphertext', async () => {
    const cookies = [{ name: 'SESSION', value: 'private-value', domain: 'www.ulsanpilot.co.kr', path: '/', secure: true, expires: null }];
    const sealed = await sealSession(cookies, 'ab'.repeat(32));
    expect(sealed).not.toContain('private-value');
    expect(await openSession(sealed, 'ab'.repeat(32))).toEqual(cookies);
    await expect(openSession(sealed, 'cd'.repeat(32))).rejects.toThrow('SESSION_INVALID');
    await expect(openSession(sealed.slice(0, -1), 'ab'.repeat(32))).rejects.toThrow('SESSION_INVALID');
  });
});
