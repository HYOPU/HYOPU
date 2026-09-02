const json = (res, code, body) => res.status(code).json(body);

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json(res, req.method === 'GET' ? 200 : 503, { configured: false, saved: false, error: 'Supabase is not configured' });
  if (req.method === 'GET') {
    try {
      const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
      const [bucket, table] = await Promise.all([
        fetch(`${SUPABASE_URL}/storage/v1/bucket/sof-documents`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/sof_documents?select=id&limit=0`, { headers }),
      ]);
      return json(res, bucket.ok && table.ok ? 200 : 502, { configured: true, healthy: bucket.ok && table.ok, bucket: 'sof-documents', table: 'sof_documents', storageStatus: bucket.status, databaseStatus: table.status });
    } catch { return json(res, 502, { configured: true, healthy: false, error: 'Supabase connection failed' }); }
  }
  const { filename, fileBase64, metadata } = req.body || {};
  if (typeof filename !== 'string' || !/\.xlsx$/i.test(filename) || typeof fileBase64 !== 'string' || !fileBase64) return json(res, 400, { error: 'Missing XLSX document' });
  if (fileBase64.length > 4 * 1024 * 1024) return json(res, 413, { error: 'Document too large' });
  const safeName = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const file = Buffer.from(fileBase64, 'base64');
  if (file[0] !== 0x50 || file[1] !== 0x4b) return json(res, 400, { error: 'Invalid XLSX document' });
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/sof-documents/${safeName}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-upsert': 'false' }, body: file });
  if (!upload.ok) return json(res, 502, { error: 'Document storage failed' });
  const row = await fetch(`${SUPABASE_URL}/rest/v1/sof_documents`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ file_path: safeName, vessel: metadata?.vessel || null, voyage: metadata?.voyage || null, port: metadata?.port || null, charterer: metadata?.charterer || null }) });
  if (!row.ok) return json(res, 502, { error: 'Document record failed' });
  return json(res, 201, { saved: true });
};
