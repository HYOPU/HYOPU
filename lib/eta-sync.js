const crypto = require('crypto');
const { backend } = require('./workspace-auth');
const { key, callFromEta } = require('./eta-source');
const { validateCall } = require('./call-validation');

const sourceFields = row => JSON.stringify([row.vessel, row.voyage, row.port, row.etaRaw, row.etdRaw, row.pic, row.status]);
const generatedId = row => `flow-eta-${crypto.createHash('sha256').update(key(row)).digest('hex').slice(0, 24)}`;
const sourceManaged = row => /^(?:eta-\d{4}-\d+|flow-eta-[a-f0-9]+)$/i.test(String(row.id || ''));
const vesselPortKey = row => [row.vessel, row.port].map(value => String(value || '').trim().toUpperCase()).join('|');

async function syncEtaRows(source, request = backend, now = new Date().toISOString()) {
  if (!Array.isArray(source) || !source.length) throw new Error('동기화할 ETA 행이 없습니다.');
  const existingResponse = await request('/rest/v1/hyopu_port_calls?select=id,data,revision&order=id.asc&limit=1000');
  if (!existingResponse.ok) throw new Error('기존 ETA 기록을 불러오지 못했습니다.');
  const existingRows = await existingResponse.json();
  const existing = new Map(existingRows.map(row => [key(row.data), row]));
  const existingByVesselPort = new Map();
  for (const record of existingRows.filter(sourceManaged)) {
    const fallback = vesselPortKey(record.data);
    existingByVesselPort.set(fallback, [...(existingByVesselPort.get(fallback) || []), record]);
  }
  const changes = [];
  const used = new Set();
  for (const row of source) {
    let prior = existing.get(key(row));
    // ETA source corrections often change only the voyage. Reuse the unique
    // vessel/port record so that notes, VCR data, and SOF work stay attached.
    if (!prior) {
      const candidates = (existingByVesselPort.get(vesselPortKey(row)) || []).filter(record => !used.has(record.id));
      if (candidates.length === 1) prior = candidates[0];
    }
    const call = { ...callFromEta(row, prior?.data, prior?.id || generatedId(row)), etaActive: true };
    const error = validateCall(call);
    if (error) throw new Error(`ETA 원본 행을 저장할 수 없습니다: ${error}`);
    used.add(call.id);
    if (!prior || sourceFields(prior.data) !== sourceFields(call) || prior.data.etaActive !== true) {
      changes.push({ id: call.id, data: call, revision: (prior?.revision || 0) + 1, updated_at: now });
    }
  }
  // Treat each full Excel paste as the current ETA snapshot. Entries that no
  // longer appear are retained in Supabase, but hidden from the ETA views.
  let hidden = 0;
  for (const record of existingRows.filter(sourceManaged)) {
    if (used.has(record.id) || record.data.etaActive === false) continue;
    const archived = { ...record.data, etaActive: false };
    const error = validateCall(archived);
    if (error) throw new Error(`기존 ETA 행을 보관할 수 없습니다: ${error}`);
    changes.push({ id: record.id, data: archived, revision: (record.revision || 0) + 1, updated_at: now });
    hidden += 1;
  }
  if (changes.length) {
    const saved = await request('/rest/v1/hyopu_port_calls?on_conflict=id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(changes),
    });
    if (!saved.ok) throw new Error('동기화한 ETA 기록을 저장하지 못했습니다.');
  }
  return { sourceRows: source.length, changed: changes.length, hidden, checkedAt: now };
}

module.exports = { syncEtaRows };
