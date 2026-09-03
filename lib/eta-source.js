const PORTS = new Set(['ULSAN', "P'TAEK", 'YOSU', 'DAESAN', 'DONGHAE']);
const text = value => String(value ?? '').trim();
const header = value => text(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
const key = row => [row.vessel, row.voyage, row.port].map(value => text(value).toUpperCase()).join('|');

function headerMap(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    const values = rows[index].map(header);
    const find = names => values.findIndex(value => names.includes(value));
    const map = {
      vessel: find(['VESSEL']), voyage: find(['VOY', 'VOYAGE']), port: find(['PORT']),
      etaRaw: find(['ETAARRIVED', 'ETA']), remark: find(['REMARK']), etdRaw: find(['ETD']), pic: find(['PIC']),
    };
    if (map.vessel >= 0 && map.voyage >= 0 && map.port >= 0 && map.etaRaw >= 0 && map.pic >= 0) return { index, map };
  }
  throw new Error('KOREA ETA UPDATE 헤더를 찾지 못했습니다.');
}

function parseEtaRows(rows) {
  if (!Array.isArray(rows)) throw new Error('ETA 시트 형식이 올바르지 않습니다.');
  const { index, map } = headerMap(rows);
  const result = [];
  for (const values of rows.slice(index + 1)) {
    const row = Object.fromEntries(Object.entries(map).map(([name, column]) => [name, text(values[column])]));
    row.port = row.port.toUpperCase();
    if (!row.vessel || !row.voyage || !row.etaRaw) continue;
    if (!PORTS.has(row.port)) continue;
    result.push(row);
  }
  if (!result.length) throw new Error('동기화할 ETA 행이 없습니다.');
  return result;
}

function parseEtaClipboard(value) {
  const source = text(value).replace(/^\uFEFF/, '');
  if (!source) throw new Error('Excel에서 복사한 ETA 표를 붙여넣어 주세요.');
  const rows = source.split(/\r?\n/)
    .filter(line => line.replace(/\t/g, '').trim())
    .map(line => line.split('\t'));
  return parseEtaRows(rows);
}

function parseEtaWorkbook(buffer, XLSX = require('xlsx')) {
  if (!buffer || !buffer.byteLength) throw new Error('전달받은 ETA 파일이 비어 있습니다.');
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames.find(name => /ETA\s*UPDATE/i.test(name));
  if (!sheetName) throw new Error('ETA UPDATE 시트를 찾지 못했습니다.');
  return parseEtaRows(XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false }));
}

function defaultCall(row, id) {
  return {
    id, vessel: row.vessel, voyage: row.voyage, port: row.port, etaRaw: row.etaRaw, etdRaw: row.etdRaw,
    pic: row.pic, status: row.remark.toUpperCase() === 'INPORT' ? 'INPORT' : 'PRE-ARRIVAL', year: 2026,
    notes: '', activityNotes: '', vcrFileName: '', latestReport: '', reportType: 'DEP.REPORT', reportReceived: '', reportChecked: false,
    activities: [], cargo: [], crew: [], tasks: [], sof: null, highlight: [],
  };
}

function callFromEta(row, existing, id) {
  const source = existing || defaultCall(row, id);
  return {
    ...source, id, vessel: row.vessel, voyage: row.voyage, port: row.port, etaRaw: row.etaRaw,
    etdRaw: row.etdRaw, pic: row.pic, status: row.remark.toUpperCase() === 'INPORT' ? 'INPORT' : 'PRE-ARRIVAL',
    year: Number.isInteger(source.year) ? source.year : 2026,
  };
}

module.exports = { key, parseEtaRows, parseEtaClipboard, parseEtaWorkbook, callFromEta };
