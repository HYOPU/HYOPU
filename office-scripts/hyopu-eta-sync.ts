interface HyopuSyncResponse {
  synced?: boolean;
  sourceRows?: number;
  changed?: number;
  hidden?: number;
  checkedAt?: string;
  error?: string;
}

// Replace only this placeholder inside Excel for the web. Never commit the
// real FLOW_SYNC_SECRET to GitHub.
const HYOPU_SYNC_KEY = 'PASTE_FLOW_SYNC_SECRET_HERE';
// Dedicated alias: stays on the CORS-enabled import deployment even when the
// main HYOPU production alias is promoted by another feature deployment.
const HYOPU_ENDPOINT = 'https://hyopu-eta-sync.vercel.app/api/eta-import';

/** Read the first ETA UPDATE(SC포함) sheet and sync it directly to HYOPU. */
async function main(workbook: ExcelScript.Workbook): Promise<string> {
  if (HYOPU_SYNC_KEY === 'PASTE_FLOW_SYNC_SECRET_HERE' || !HYOPU_SYNC_KEY.trim()) {
    throw new Error('HYOPU_SYNC_KEY에 FLOW_SYNC_SECRET 값을 넣어 주세요.');
  }
  const sheet = workbook.getWorksheets()[0];
  if (!sheet || normalize(sheet.getName()) !== 'ETAUPDATESC') {
    throw new Error('맨 앞 시트가 ETA UPDATE(SC포함)인지 확인해 주세요.');
  }

  const usedRange = sheet.getUsedRange(true);
  if (!usedRange) throw new Error('ETA UPDATE 시트가 비어 있습니다.');
  const values = usedRange.getTexts();
  const headerIndex = values.findIndex(row => {
    const headings = row.map(normalize);
    return headings.includes('VESSEL') && headings.some(value => value === 'VOY' || value === 'VOYAGE')
      && headings.includes('PORT') && headings.some(value => value === 'ETAARRIVED' || value === 'ETA')
      && headings.includes('PIC');
  });
  if (headerIndex < 0) throw new Error('Vessel, Voy, Port, ETA/Arrived, PIC 헤더를 찾지 못했습니다.');

  const result: string[][] = [values[headerIndex]];
  let blankRows = 0;
  for (let index = headerIndex + 1; index < values.length; index += 1) {
    const row = values[index];
    const hasTableValue = row.slice(0, 7).some(value => value.trim() !== '');
    if (!hasTableValue) {
      blankRows += 1;
      if (blankRows >= 2) break;
      continue;
    }
    blankRows = 0;
    if (/^(?:RGDS\b|HYOP WOON SHIPPING\b)/i.test(row[0]?.trim() || '')) break;
    result.push(row);
  }
  if (result.length < 2) throw new Error('동기화할 ETA 행이 없습니다.');

  const response = await fetch(HYOPU_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HYOPU_SYNC_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ rows: result }),
  });
  const responseText = await response.text();
  let payload: HyopuSyncResponse;
  try {
    payload = JSON.parse(responseText) as HyopuSyncResponse;
  } catch {
    throw new Error(`HYOPU 응답을 확인할 수 없습니다. (HTTP ${response.status})`);
  }
  if (!response.ok || !payload.synced) {
    throw new Error(payload.error || `HYOPU 동기화에 실패했습니다. (HTTP ${response.status})`);
  }
  return `HYOPU 동기화 완료: ${payload.sourceRows || 0}건 확인 · ${payload.changed || 0}건 변경 · ${payload.hidden || 0}건 숨김`;
}

function normalize(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
