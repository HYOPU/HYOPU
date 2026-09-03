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
  const rowIndex = rows.findIndex(row => row.some(cell => key(cell) === 'CARGONAME') && row.some(cell => ['QUANTITYMT', 'DISCHARGEQUANTITYMT'].includes(key(cell))));
  if (rowIndex < 0) throw new Error('VCR의 Loading 또는 Discharging 화물 헤더를 찾지 못했습니다.');
  const indexes = Object.fromEntries(rows[rowIndex].map((cell, index) => [key(cell), index]));
  const operation = ['LOADPORT', 'LOADBERTH', 'QUANTITYMT'].every(required => indexes[required] !== undefined) ? 'LOAD'
    : ['DISCHARGEPORT', 'DISCHARGEBERTH', 'DISCHARGEQUANTITYMT'].every(required => indexes[required] !== undefined) ? 'DISCH' : '';
  if (!operation) throw new Error('VCR의 Loading 또는 Discharging 항만·선석·수량 열을 찾지 못했습니다.');
  for (const required of ['CARGONAME', 'CODE', 'TANKS', 'CHARTERER']) {
    if (indexes[required] === undefined) throw new Error(`VCR의 ${required} 열을 찾지 못했습니다.`);
  }
  return { rowIndex, indexes, operation };
}

export function parseVcrRows(rows, { port = '' } = {}) {
  const { rowIndex, indexes, operation } = headerMap(rows);
  const fields = operation === 'LOAD' ? { port: 'LOADPORT', berth: 'LOADBERTH', quantity: 'QUANTITYMT', counterpart: 'DISCHARGEPORTBERTHS' }
    : { port: 'DISCHARGEPORT', berth: 'DISCHARGEBERTH', quantity: 'DISCHARGEQUANTITYMT', counterpart: 'LOADPORTBERTHS' };
  const targetPort = key(port);
  const source = rows.slice(rowIndex + 1).map(row => ({
    sourcePort: text(row[indexes[fields.port]]), berth: text(row[indexes[fields.berth]]), number: text(row[indexes.CODE]),
    name: text(row[indexes.CARGONAME]), bl: quantity(row[indexes[fields.quantity]]), tanks: text(row[indexes.TANKS]), party: text(row[indexes.CHARTERER]),
    counterpart: text(row[indexes[fields.counterpart]]),
  })).filter(item => item.name && item.number);
  const cargo = targetPort ? source.filter(item => key(item.sourcePort) === targetPort) : source;
  if (!cargo.length) throw new Error(`${port || '선택한 항만'}의 VCR 화물을 찾지 못했습니다.`);
  return cargo.map(item => ({
    operation, number: item.number, name: item.name, bl: item.bl, ship: '', tanks: item.tanks, party: item.party, berth: item.berth, coaster: '',
    note: `VCR · ${item.sourcePort}${item.berth ? ` / ${item.berth}` : ''}${item.counterpart ? `${operation === 'LOAD' ? ' →' : ' ←'} ${item.counterpart}` : ''}`,
  }));
}

// Excel copies a selected range as tab-separated rows. Keeping the parser on
// the same row format as a workbook means the user can paste either Loading or
// Discharging schedule directly without uploading the original VCR file.
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
  const sheetName = workbook.SheetNames.find(name => ['LOADSCHEDULE', 'DISCHARGESCHEDULE'].some(schedule => key(name).includes(schedule)));
  if (!sheetName) throw new Error('VCR의 Loading 또는 Discharging Schedule 시트를 찾지 못했습니다.');
  return parseVcrRows(rowsForSheet(workbook.Sheets[sheetName]), options);
}
