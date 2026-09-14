import { normalizeBerth } from './berth-drafts.mjs';

const cleanDraft = value => {
  const match=String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*M?$/i);
  return match ? `${Number(match[1]).toFixed(2)}M` : '';
};
const newer = (left, right) => String(left.updatedAt || '') >= String(right.updatedAt || '') ? left : right;

// This stays inside the workspace: it is a reference built only from saved
// port-call records, never an external model or an unverified web source.
export function buildOperationalLearning(calls, port = '') {
  const entries=[];
  for (const call of calls || []) {
    if(port && call.port !== port) continue;
    for(const cargo of call.cargo || []) {
      const maxDraft=cleanDraft(cargo.maxDraft);
      if(maxDraft && cargo.berth) entries.push({ berth:cargo.berth, maxDraft, source:'PROFORMA 확인값', vessel:call.vessel, voyage:call.voyage, updatedAt:call.updatedAt || '' });
    }
    for(const group of call.sof?.groups || []) {
      const maxDraft=cleanDraft(group.maxDraft);
      if(maxDraft && group.berth) entries.push({ berth:group.berth, maxDraft, source:'SOF · 출항 리포트 분석', vessel:call.vessel, voyage:call.voyage, updatedAt:call.updatedAt || '' });
    }
  }
  const byBerth=new Map();
  for(const entry of entries) {
    const key=normalizeBerth(entry.berth);
    if(key) byBerth.set(key,byBerth.has(key)?newer(byBerth.get(key),entry):entry);
  }
  return [...byBerth.values()].sort((left,right)=>left.berth.localeCompare(right.berth));
}

export function learnedMaxDraft(berth, learning) {
  const key=normalizeBerth(berth);
  return (learning || []).find(item=>normalizeBerth(item.berth)===key)?.maxDraft || '';
}
