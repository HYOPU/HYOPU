const text = value => String(value ?? '').trim();
const key = value => text(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
const quantity = value => {
  const number = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(number) ? String(number) : '';
};

export function vesselNameForSof(value) {
  const vessel = text(value).toUpperCase();
  if (/^STOLT\s+/.test(vessel)) return vessel;
  return vessel.replace(/^S\.\s*/, 'STOLT ');
}

function headerMap(rows) {
  const rowIndex = rows.findIndex(row => row.some(cell => key(cell) === 'CARGONAME') && row.some(cell => key(cell) === 'QUANTITYMT'));
  if (rowIndex < 0) throw new Error('VCR의 Load-Schedule 화물 헤더를 찾지 못했습니다.');
  const indexes = Object.fromEntries(rows[rowIndex].map((cell, index) => [key(cell), index]));
  for (const required of ['LOADPORT', 'LOADBERTH', 'CARGONAME', 'QUANTITYMT', 'CODE', 'TANKS', 'CHARTERER']) {
    if (indexes[required] === undefined) throw new Error(`VCR의 ${required} 열을 찾지 못했습니다.`);
  }
  return { rowIndex, indexes };
}

export function parseVcrRows(rows, { port = '' } = {}) {
  const { rowIndex, indexes } = headerMap(rows);
  const targetPort = key(port);
  const source = rows.slice(rowIndex + 1).map(row => ({
    sourcePort: text(row[indexes.LOADPORT]), berth: text(row[indexes.LOADBERTH]), number: text(row[indexes.CODE]),
    name: text(row[indexes.CARGONAME]), bl: quantity(row[indexes.QUANTITYMT]), tanks: text(row[indexes.TANKS]), party: text(row[indexes.CHARTERER]),
    discharge: text(row[indexes.DISCHARGEPORTBERTHS]),
  })).filter(item => item.name && item.number);
  const cargo = targetPort ? source.filter(item => key(item.sourcePort) === targetPort) : source;
  if (!cargo.length) throw new Error(`${port || '선택한 항만'}의 VCR 화물을 찾지 못했습니다.`);
  return cargo.map(item => ({
    operation: 'LOAD', number: item.number, name: item.name, bl: item.bl, ship: '', tanks: item.tanks, party: item.party,
    note: `VCR · ${item.sourcePort}${item.berth ? ` / ${item.berth}` : ''}${item.discharge ? ` → ${item.discharge}` : ''}`,
  }));
}

// Excel copies a selected range as tab-separated rows. Keeping the parser on
// the same row format as a workbook means the user can paste the Load Schedule
// table directly without uploading or retaining the original VCR file.
export function parseVcrClipboard(value, options = {}) {
  const source = text(value).replace(/^\uFEFF/, '');
  if (!source) throw new Error('VCR 표를 Excel에서 복사해 붙여넣어 주세요.');
  const rows = source
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map(line => line.split('\t'));
  return parseVcrRows(rows, options);
}

export function parseVcrWorkbook(workbook, rowsForSheet, options = {}) {
  const sheetName = workbook.SheetNames.find(name => key(name).includes('LOADSCHEDULE'));
  if (!sheetName) throw new Error('VCR의 Load-Schedule 시트를 찾지 못했습니다.');
  return parseVcrRows(rowsForSheet(workbook.Sheets[sheetName]), options);
}
