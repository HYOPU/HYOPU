// Separate authenticated-encryption domain from the login cookie envelope.
export async function pilotSeal(value: unknown, keyHex: string, requestId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await pilotEncryptionKey(keyHex);
  const data = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('pilot-draft-v1:'+requestId)},key,new TextEncoder().encode(JSON.stringify(value))));
  const sealed=JSON.stringify({v:1,iv:btoa(String.fromCharCode(...iv)),data:btoa(String.fromCharCode(...data))});
  // Fits the existing 64KiB read/save reservation, including both directions.
  if(sealed.length>30000)throw Error('REG_DRAFT_TOO_LARGE_NARROW_SEARCH');
  return sealed;
}
async function pilotEncryptionKey(hex: string) {
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw Error('REG_ENCRYPTION_KEY');
  return crypto.subtle.importKey('raw',Uint8Array.from(hex.match(/../g)!.map(x=>parseInt(x,16))),'AES-GCM',false,['encrypt','decrypt']);
}
export async function pilotOpen<T>(sealed: string, key: string, requestId: string): Promise<T> {
  if (sealed.length>120000) throw Error('REG_ENVELOPE_LIMIT');
  try {
    const e=JSON.parse(sealed);if(e.v!==1)throw Error();
    const decode=(v:string)=>Uint8Array.from(atob(v),x=>x.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(e.iv),additionalData:new TextEncoder().encode('pilot-draft-v1:'+requestId)},await pilotEncryptionKey(key),decode(e.data))));
  } catch { throw Error('REG_ENVELOPE_INVALID'); }
}
