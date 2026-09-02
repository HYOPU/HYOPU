const json = (res, code, body) => res.status(code).json(body);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json(res, 204, { saved: false });
  const { filename, fileBase64, metadata } = req.body || {};
  if (!filename || !fileBase64) return json(res, 400, { error: 'Missing document' });
  const safeName = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const file = Buffer.from(fileBase64, 'base64');
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/sof-documents/${safeName}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-upsert': 'false' }, body: file });
  if (!upload.ok) return json(res, 502, { error: 'Document storage failed' });
  const row = await fetch(`${SUPABASE_URL}/rest/v1/sof_documents`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ file_path: safeName, vessel: metadata?.vessel || null, voyage: metadata?.voyage || null, port: metadata?.port || null, charterer: metadata?.charterer || null }) });
  if (!row.ok) return json(res, 502, { error: 'Document record failed' });
  return json(res, 201, { saved: true });
};
