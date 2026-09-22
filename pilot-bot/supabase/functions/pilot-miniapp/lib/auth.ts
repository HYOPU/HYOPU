const enc = new TextEncoder();
async function hmac(key: Uint8Array, value: string) {
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(value)));
}
/** Validate Telegram's original initData, never initDataUnsafe or a client chat ID. */
export async function verifyMiniApp(raw: string, token: string, now = Date.now()): Promise<number> {
  if (!token || typeof raw !== 'string' || raw.length > 8192) throw Error('MINI_AUTH');
  const params = new URLSearchParams(raw), seen = new Set<string>();
  for (const [key] of params) { if (seen.has(key)) throw Error('MINI_AUTH'); seen.add(key); }
  const hash = params.get('hash') ?? '';
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('MINI_AUTH');
  params.delete('hash');
  const data = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${k}=${v}`).join('\n');
  const expected = await hmac(await hmac(enc.encode('WebAppData'), token), data);
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= expected[i] ^ parseInt(hash.slice(i*2,i*2+2),16);
  const stamp = Number(params.get('auth_date'));
  if (difference || !Number.isSafeInteger(stamp) || stamp > now/1000+30 || stamp < now/1000-1200) throw Error('MINI_AUTH_EXPIRED');
  let user: any; try { user = JSON.parse(params.get('user') ?? 'null'); } catch { throw Error('MINI_AUTH'); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot) throw Error('MINI_AUTH');
  return user.id;
}
