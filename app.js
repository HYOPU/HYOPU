 const $ = (selector) => document.querySelector(selector);
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const state = {
  statements: [],
  cargo: [],
  fields: { vessel: '', voyage: '', port: '', charterer: '', mode: 'LOAD', berth: '', period: '' },
};
const labels = [
  ['vessel', 'VESSEL'], ['voyage', 'VOYAGE'], ['port', 'PORT'], ['charterer', 'CHARTERER'],
  ['mode', '작업 구분 (LOAD / DISCHARGE)'], ['berth', '기본 선석'], ['period', "기간 (예: AUG' 2026)"],
];
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const parseDate = (value) => {
  const text = clean(value);
  const match = text.match(/(?:\d{4}[,./ -]+[A-Z]{3}[,./ -]+)?\s*(\d{1,2})\s*[/.-]\s*(\d{3,4})/i);
  return match ? `${match[1].padStart(2, '0')}/${match[2].padStart(4, '0')}` : text;
};

function render() {
  const grid = $('#summary-grid');
  grid.innerHTML = '';
  labels.forEach(([key, label]) => {
    const node = $('#summary-template').content.cloneNode(true);
    const input = node.querySelector('input');
    node.querySelector('span').textContent = label;
    input.value = state.fields[key] || '';
    input.oninput = (event) => { state.fields[key] = event.target.value; };
    grid.append(node);
  });
  $('#statement-rows').innerHTML = state.statements.map((row, index) => `<tr><td><input aria-label="날짜와 시간" data-i="${index}" data-k="date" value="${esc(row.date)}"></td><td><input aria-label="Statement" data-i="${index}" data-k="text" value="${esc(row.text)}"></td><td><button class="delete" data-delete="${index}" aria-label="항목 삭제">×</button></td></tr>`).join('') || '<tr><td colspan="3">추출된 Statement가 없습니다. 항목 추가로 입력해 주세요.</td></tr>';
  const keys = ['berth', 'cargo', 'party', 'tank', 'line', 'hoseOn', 'commLoad', 'compLoad', 'hoseOff', 'bl', 'ship'];
  $('#cargo-rows').innerHTML = state.cargo.map((row, index) => `<tr>${keys.map((key) => `<td><input aria-label="${key}" data-c="${index}" data-k="${key}" value="${esc(row[key])}"></td>`).join('')}</tr>`).join('') || '<tr><td colspan="11">화물 정보가 없습니다.</td></tr>';
}

function readWorkbook(file) {
  if (file.size > 20 * 1024 * 1024) { alert('20MB 이하의 파일을 올려 주세요.'); return; }
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      if (/\.txt$/i.test(file.name)) extractText(String(event.target.result));
      else extract(XLSX.read(event.target.result, { type: 'array', cellDates: true }));
      $('#file-name').textContent = file.name;
      $('#upload-panel').classList.add('hidden');
      $('#review-panel').classList.remove('hidden');
      render();
    } catch (error) {
      alert('파일을 읽지 못했습니다. XLSX, XLS, CSV, TXT 형식을 확인해 주세요.');
      console.error(error);
    }
  };
  if (/\.txt$/i.test(file.name)) reader.readAsText(file); else reader.readAsArrayBuffer(file);
}

function inferPeriod(text) {
  let match = text.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z']*\s*[,']?\s*(20\d{2})\b/i);
  if (match) return `${match[1].toUpperCase()}' ${match[2]}`;
  match = text.match(/\b(20\d{2})\s*[,/-]\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/i);
  return match ? `${match[2].toUpperCase()}' ${match[1]}` : '';
}

function extractBerthName(text) {
  const match = clean(text).match(/(?:BERTHED AT|ALL FAST(?: AT)?|BERTH\s*[:：])\s+(.+)/i);
  if (!match) return '';
  return clean(match[1].replace(/\s*\((?:MAX|PORT|STBD|STARBOARD|FOR)\b.*$/i, '').replace(/\s+FOR\s+(?:T\/S|CARGO).*$/i, ''));
}

function extract(workbook) {
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '', raw: false });
  const flat = rows.map((row) => row.map(clean));
  const all = flat.map((row) => row.join(' '));
  const joined = all.join('\n');
  const valueAfter = (pattern) => {
    const line = all.find((item) => pattern.test(item));
    return line ? clean(line.replace(pattern, '').replace(/^[:\s-]+/, '')) : '';
  };
  state.fields.vessel = valueAfter(/VESSEL\s*[:：]?/i);
  state.fields.voyage = valueAfter(/VOY(?:AGE)?\s*[:：]?/i);
  state.fields.port = valueAfter(/PORT\s*(?:OF\s*)?(?:LOAD|DISCHARGE)(?:ING)?\s*[:：]?/i);
  state.fields.charterer = valueAfter(/CHARTERER\s*[:：]?/i);
  state.fields.mode = /\bDISCH(?:ARGE|ARGING)?\b/i.test(joined) ? 'DISCHARGE' : 'LOAD';
  state.fields.period = inferPeriod(joined);
  state.fields.berth = '';
  state.statements = [];
  let activeBerth = '';
  flat.forEach((row, sourceIndex) => {
    const line = row.join(' ');
    const hit = line.match(/(?:\d{1,2}\s*[/.-]\s*\d{3,4})/);
    const text = clean(line.replace(/.*?(?:\d{1,2}\s*[/.-]\s*\d{3,4})\s*-?\s*/, ''));
    const foundBerth = extractBerthName(text);
    if (foundBerth) activeBerth = foundBerth;
    if (hit && text && !/HOSE|COMM|COMP|LINE/i.test(text)) state.statements.push({ date: parseDate(hit[0]), text, berth: activeBerth, sourceIndex });
  });
  state.statements = [...new Map(state.statements.map((item) => [item.date + item.text, item])).values()];
  state.fields.berth = state.statements.find((item) => item.berth)?.berth || '';
  state.cargo = [];
  const cargoRow = flat.find((row) => row.some((value) => /CARGO|CGO\./i.test(value)) && row.some((value) => /TANK/i.test(value)));
  const start = cargoRow ? flat.indexOf(cargoRow) + 1 : -1;
  if (start > 0) {
    for (let index = start; index < Math.min(start + 10, flat.length); index += 1) {
      const row = flat[index];
      if (row.some(Boolean) && !row.join(' ').match(/START CARGO/i)) state.cargo.push({ berth: state.fields.berth, cargo: row[0], party: row[1], tank: row[2], line: row[3], hoseOn: row[4], commLoad: row[5], compLoad: row[6], hoseOff: row[7], bl: row[8], ship: row[9] });
    }
  }
}

function extractText(text) {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  state.fields = { vessel: '', voyage: '', port: '', charterer: '', mode: /\bDISCH(?:ARGE|ARGING)?\b/i.test(text) ? 'DISCHARGE' : 'LOAD', berth: '', period: inferPeriod(text) };
  const heading = lines.find((line) => /^\([A-Z ]+\)$/.test(line));
  state.fields.port = heading ? heading.replace(/[()]/g, '') : '';
  const title = lines.find((line) => /\bHBR\s*\d+/i.test(line));
  if (title) {
    const parts = title.split('/').map(clean);
    state.fields.vessel = parts[0] || '';
    state.fields.voyage = parts[1] || '';
    state.fields.port = parts[2] || state.fields.port;
  }
  state.statements = [];
  const berthEvents = [];
  let activeDay = '';
  let activeBerth = '';
  lines.forEach((line, sourceIndex) => {
    let match = line.match(/^\*?(\d{1,2})\/(\d{4})(?:\s*~\s*(\d{1,2})\/(\d{4}))?\s*:\s*(.+)$/);
    let date = '';
    let statement = '';
    if (match) {
      activeDay = match[1];
      date = match[3] ? `${match[1].padStart(2, '0')}/${match[2]} - ${match[3].padStart(2, '0')}/${match[4]}` : `${match[1].padStart(2, '0')}/${match[2]}`;
      statement = match[5];
    } else {
      match = line.match(/^(\d{4})\s*:\s*(.+)$/);
      if (match && activeDay) { date = `${activeDay.padStart(2, '0')}/${match[1]}`; statement = match[2]; }
    }
    if (!date) return;
    const foundBerth = extractBerthName(statement);
    if (foundBerth) { activeBerth = foundBerth; berthEvents.push({ sourceIndex, berth: activeBerth }); }
    state.statements.push({ date, text: statement, berth: activeBerth, sourceIndex });
  });
  state.statements = [...new Map(state.statements.map((item) => [item.date + item.text, item])).values()];
  state.fields.berth = berthEvents[0]?.berth || '';
  state.cargo = [];
  lines.forEach((line, sourceIndex) => {
    const match = line.match(/^(?:\(LOAD\)\s*)?(?:CGO)?#(\d+[A-Z/]*)\s+([A-Z][A-Z0-9 ()+.-]*?)\s*\/\s*([\d,.]+)\s*MT\(([^)]*)\)/i);
    if (!match) return;
    const schedule = `${line.slice(match.index + match[0].length)} ${lines[sourceIndex + 1] || ''}`;
    const times = [...schedule.matchAll(/\b(?:H\/ON|COMM|COMP|H\/OFF)\s+(\d{1,2}\/\d{4})/gi)];
    const byLabel = {};
    times.forEach((item) => { byLabel[item[0].split(/\s+/)[0].toUpperCase()] = item[1]; });
    if (!times.length) {
      const dates = [...schedule.matchAll(/\b\d{1,2}\/\d{4}\b/g)].map((item) => item[0]);
      [byLabel['H/ON'], byLabel.COMM, byLabel.COMP, byLabel['H/OFF']] = dates;
    }
    const berth = [...berthEvents].reverse().find((item) => item.sourceIndex < sourceIndex)?.berth || state.fields.berth;
    state.cargo.push({ berth, cargo: `CGO#${match[1]} ${clean(match[2])}`, party: '', tank: match[4], line: '', hoseOn: byLabel['H/ON'] || '', commLoad: byLabel.COMM || '', compLoad: byLabel.COMP || '', hoseOff: byLabel['H/OFF'] || '', bl: match[3], ship: '' });
  });
}

function xmlParse(text) {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('OOXML parse error');
  return document;
}
function xmlText(bytes) { return fflate.strFromU8(bytes); }
function xmlBytes(document) { return fflate.strToU8(new XMLSerializer().serializeToString(document)); }
function sheetName(value, fallback) {
  let name = clean(value || fallback).replace(/^\d+\.\s*/, '');
  const code = name.match(/\(([A-Z]+(?:SP)?#?\d+)\)/i);
  if (code) name = code[1];
  return (name.replace(/[\\/*?:\[\]]/g, ' ').trim() || fallback).slice(0, 31);
}
function setCell(document, address, value, style) {
  const cell = [...document.getElementsByTagNameNS(MAIN_NS, 'c')].find((item) => item.getAttribute('r') === address);
  if (!cell) throw new Error(`Template cell not found: ${address}`);
  while (cell.firstChild) cell.removeChild(cell.firstChild);
  cell.setAttribute('t', 'inlineStr');
  if (style !== undefined) cell.setAttribute('s', String(style));
  const inline = document.createElementNS(MAIN_NS, 'is');
  const text = document.createElementNS(MAIN_NS, 't');
  text.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
  text.textContent = clean(value);
  inline.appendChild(text);
  cell.appendChild(inline);
}
function topDate(group) {
  const period = clean(state.fields.period).toUpperCase();
  const periodMatch = period.match(/(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)'?\s*(20\d{2})/);
  const candidates = group.cargo.map((item) => clean(item.hoseOff)).filter(Boolean).map((value) => ({ value, match: value.match(/(?:^|\D)(\d{1,2})\s*\/\s*(\d{4})/) })).filter((item) => item.match);
  if (!candidates.length) return '';
  const anchorDay = Number(state.statements.map((item) => item.date.match(/^(\d{1,2})\//)?.[1]).find(Boolean) || 1);
  candidates.forEach((item) => {
    const day = Number(item.match[1]);
    const time = Number(item.match[2]);
    item.order = (day < anchorDay - 15 ? day + 31 : day) * 10000 + time;
  });
  const latest = candidates.sort((a, b) => b.order - a.order)[0];
  if (!periodMatch) return latest.value;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const day = Number(latest.match[1]);
  let monthIndex = months.indexOf(periodMatch[1]);
  let year = Number(periodMatch[2]);
  if (day < anchorDay - 15) { monthIndex += 1; if (monthIndex === 12) { monthIndex = 0; year += 1; } }
  return `${String(day).padStart(2, '0')}/${months[monthIndex]}/${year}`;
}
function periodHeading() {
  const match = clean(state.fields.period).toUpperCase().match(/(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)'?\s*(20\d{2})/);
  return match ? `${match[2]}, ${match[1]}'` : clean(state.fields.period);
}
function canonicalRow(text) {
  const value = clean(text).toUpperCase();
  if (/ARRIVED PILOT|PILOT STATION|ANCHORAGE|\bEOSP\b/.test(value)) return 12;
  if (/PILOT ON BOARD FOR BERTHING|POB FOR BERTHING/.test(value)) return 13;
  if (/BERTHED AT|ALL FAST/.test(value)) return 14;
  if (/NOR TENDERED/.test(value)) return 15;
  if (/NOR ACCEPTED/.test(value)) return 16;
  if (/TANKS? INSPECTED|TANK INSPECTION/.test(value)) return 17;
  if (/TANKS? ACCEPTED|INSPECTION.*PASSED/.test(value)) return 18;
  if (/START(?:ED)? CARGO CALCULATION/.test(value)) return 32;
  if (/COMPLETED CARGO CALCULATION/.test(value)) return 33;
  if (/CARGO PAPERS ON BOARD/.test(value)) return 34;
  if ((/PILOT ON BOARD|\bPOB\b/.test(value)) && !/BERTHING/.test(value)) return 35;
  if (/LEFT (?:FM|FROM) BERTH|SAILED/.test(value)) return 36;
  return 0;
}
function fillSheet(document, group, mode) {
  setCell(document, 'B6', state.fields.vessel, 150);
  setCell(document, 'G6', state.fields.voyage, 150);
  setCell(document, 'N6', topDate(group), 153);
  const portLabel = mode === 'LOAD' ? 'LOADING' : 'LOADING / DISCHARGING';
  setCell(document, 'B7', `${portLabel} : ${state.fields.port}`, 150);
  setCell(document, 'B8', state.fields.charterer, 150);
  setCell(document, 'A12', periodHeading(), 143);
  const remarks = [];
  group.statements.forEach((item) => {
    const row = canonicalRow(item.text);
    if (!row) { remarks.push(`*${item.date} : ${item.text}`); return; }
    setCell(document, `B${row}`, item.date, 164);
    if (row === 14) setCell(document, 'G14', group.berth, 150);
  });
  group.cargo.slice(0, 5).forEach((item, index) => {
    const row = 22 + (index * 2);
    const match = clean(item.cargo).match(/(?:CGO)?#?([^\s]+)\s*(.*)/i);
    const cargoNo = match?.[1] || clean(item.cargo);
    const cargoName = match?.[2] || '';
    const description = [cargoName, clean(item.party)].filter((part) => part && !/^LOAD|DISCHARGE$/i.test(part)).join(' / ');
    setCell(document, `A${row}`, cargoNo, 169);
    setCell(document, `B${row}`, description, 168);
    const detail = [clean(item.party), item.tank ? `TANK ${clean(item.tank)}` : '', item.line ? `LINE ${clean(item.line)}` : ''].filter(Boolean).join(' / ');
    if (detail) setCell(document, `A${row + 1}`, detail, 168);
    setCell(document, `F${row}`, item.hoseOn, 164);
    setCell(document, `G${row}`, item.commLoad, 164);
    setCell(document, `I${row}`, item.compLoad, 164);
    setCell(document, `L${row}`, item.hoseOff, 164);
    setCell(document, `N${row}`, item.bl, 169);
    if (mode === 'LOAD') setCell(document, `O${row}`, item.ship, 169);
  });
  const remarkCells = ['B39', 'B40', 'B42', 'B50', 'B53', 'B54', 'B55', 'B56'];
  remarks.slice(0, remarkCells.length).forEach((remark, index) => setCell(document, remarkCells[index], remark, 150));
}
function groupsForExport() {
  const fallback = clean(state.fields.berth) || 'BERTH 1';
  const groups = [];
  [...state.statements, ...state.cargo].forEach((item) => {
    const berth = clean(item.berth || fallback);
    const name = sheetName(berth, `BERTH ${groups.length + 1}`);
    if (!groups.some((group) => group.name.toUpperCase() === name.toUpperCase())) groups.push({ berth, name, cargo: [], statements: [] });
  });
  if (!groups.length) groups.push({ berth: fallback, name: sheetName(fallback, 'BERTH 1'), cargo: [], statements: [] });
  state.statements.forEach((item) => {
    const name = sheetName(clean(item.berth || fallback), groups[0].name);
    (groups.find((group) => group.name.toUpperCase() === name.toUpperCase()) || groups[0]).statements.push(item);
  });
  state.cargo.forEach((item) => {
    const name = sheetName(clean(item.berth || fallback), groups[0].name);
    (groups.find((group) => group.name.toUpperCase() === name.toUpperCase()) || groups[0]).cargo.push(item);
  });
  return groups;
}
function relationshipTarget(target) {
  const cleanTarget = target.replace(/^\//, '');
  return cleanTarget.startsWith('xl/') ? cleanTarget : `xl/${cleanTarget}`;
}
function prepareWorkbook(files, groups) {
  const workbookPath = 'xl/workbook.xml';
  const relsPath = 'xl/_rels/workbook.xml.rels';
  const typesPath = '[Content_Types].xml';
  const workbook = xmlParse(xmlText(files[workbookPath]));
  const rels = xmlParse(xmlText(files[relsPath]));
  const types = xmlParse(xmlText(files[typesPath]));
  const sheetsParent = workbook.getElementsByTagNameNS(MAIN_NS, 'sheets')[0];
  let sheets = [...workbook.getElementsByTagNameNS(MAIN_NS, 'sheet')];
  const relationships = [...rels.getElementsByTagNameNS(PKG_REL_NS, 'Relationship')];
  const relationById = new Map(relationships.map((item) => [item.getAttribute('Id'), item]));
  while (sheets.length > groups.length) {
    const removed = sheets.pop();
    const rid = removed.getAttributeNS(REL_NS, 'id');
    relationById.get(rid)?.remove();
    removed.remove();
  }
  const maxRid = () => Math.max(0, ...[...rels.getElementsByTagNameNS(PKG_REL_NS, 'Relationship')].map((item) => Number(item.getAttribute('Id').replace(/\D/g, '')) || 0));
  const maxSheetId = () => Math.max(0, ...[...workbook.getElementsByTagNameNS(MAIN_NS, 'sheet')].map((item) => Number(item.getAttribute('sheetId')) || 0));
  for (let index = sheets.length; index < groups.length; index += 1) {
    const sheetNumber = index + 1;
    const drawingNumber = index + 1;
    files[`xl/worksheets/sheet${sheetNumber}.xml`] = files['xl/worksheets/sheet1.xml'].slice();
    const sheetRels = xmlParse(xmlText(files['xl/worksheets/_rels/sheet1.xml.rels']));
    const drawingRel = sheetRels.getElementsByTagNameNS(PKG_REL_NS, 'Relationship')[0];
    drawingRel.setAttribute('Target', `/xl/drawings/drawing${drawingNumber}.xml`);
    files[`xl/worksheets/_rels/sheet${sheetNumber}.xml.rels`] = xmlBytes(sheetRels);
    files[`xl/drawings/drawing${drawingNumber}.xml`] = files['xl/drawings/drawing1.xml'].slice();
    files[`xl/drawings/_rels/drawing${drawingNumber}.xml.rels`] = files['xl/drawings/_rels/drawing1.xml.rels'].slice();
    const rid = `rId${maxRid() + 1}`;
    const relationship = rels.createElementNS(PKG_REL_NS, 'Relationship');
    relationship.setAttribute('Id', rid);
    relationship.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet');
    relationship.setAttribute('Target', `worksheets/sheet${sheetNumber}.xml`);
    rels.documentElement.appendChild(relationship);
    const sheet = workbook.createElementNS(MAIN_NS, 'sheet');
    sheet.setAttribute('name', groups[index].name);
    sheet.setAttribute('sheetId', String(maxSheetId() + 1));
    sheet.setAttributeNS(REL_NS, 'r:id', rid);
    sheetsParent.appendChild(sheet);
    for (const [part, contentType] of [[`/xl/worksheets/sheet${sheetNumber}.xml`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'], [`/xl/drawings/drawing${drawingNumber}.xml`, 'application/vnd.openxmlformats-officedocument.drawing+xml']]) {
      const override = types.createElementNS(CONTENT_NS, 'Override');
      override.setAttribute('PartName', part);
      override.setAttribute('ContentType', contentType);
      types.documentElement.appendChild(override);
    }
  }
  sheets = [...workbook.getElementsByTagNameNS(MAIN_NS, 'sheet')];
  const definedParent = workbook.getElementsByTagNameNS(MAIN_NS, 'definedNames')[0];
  [...workbook.getElementsByTagNameNS(MAIN_NS, 'definedName')].forEach((item) => item.remove());
  groups.forEach((group, index) => {
    sheets[index].setAttribute('name', group.name);
    const definition = workbook.createElementNS(MAIN_NS, 'definedName');
    definition.setAttribute('name', '_xlnm.Print_Area');
    definition.setAttribute('localSheetId', String(index));
    definition.textContent = `'${group.name.replaceAll("'", "''")}'!$A$1:$P$58`;
    definedParent.appendChild(definition);
    const rid = sheets[index].getAttributeNS(REL_NS, 'id');
    const path = relationshipTarget(relationById.get(rid)?.getAttribute('Target') || `worksheets/sheet${index + 1}.xml`);
    const sheetDocument = xmlParse(xmlText(files[path]));
    fillSheet(sheetDocument, group, /^DISCH/i.test(state.fields.mode) ? 'DISCHARGE' : 'LOAD');
    files[path] = xmlBytes(sheetDocument);
  });
  files[workbookPath] = xmlBytes(workbook);
  files[relsPath] = xmlBytes(rels);
  files[typesPath] = xmlBytes(types);
}
async function buildTemplateWorkbook() {
  if (!window.fflate) throw new Error('압축 모듈을 불러오지 못했습니다.');
  const mode = /^DISCH/i.test(clean(state.fields.mode)) ? 'DISCHARGE' : 'LOAD';
  const template = mode === 'LOAD' ? './HYOPWOON_SOF_TEMPLATE_LOAD.xlsx' : './HYOPWOON_SOF_TEMPLATE.xlsx';
  const response = await fetch(template);
  if (!response.ok) throw new Error('원본 협운해운 템플릿을 불러오지 못했습니다.');
  const files = fflate.unzipSync(new Uint8Array(await response.arrayBuffer()));
  prepareWorkbook(files, groupsForExport());
  return fflate.zipSync(files, { level: 6 });
}
function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}
async function saveToSupabase(bytes, filename) {
  try {
    const response = await fetch('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename, fileBase64: toBase64(bytes), metadata: state.fields }) });
    if (response.ok) console.info('SOF saved to workspace');
  } catch { /* Download remains available when storage is not configured. */ }
}
async function download() {
  const button = $('#download');
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = '원본 서식 생성 중…';
  try {
    const bytes = await buildTemplateWorkbook();
    const filename = `SOF_${(state.fields.vessel || 'Draft').replace(/[^a-z0-9가-힣]+/gi, '_')}.xlsx`;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    saveToSupabase(bytes, filename);
  } catch (error) {
    alert(error.message || 'SOF를 생성하지 못했습니다.');
    console.error(error);
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

$('#report-file').onchange = (event) => event.target.files[0] && readWorkbook(event.target.files[0]);
['dragenter', 'dragover'].forEach((name) => $('#dropzone').addEventListener(name, (event) => { event.preventDefault(); $('#dropzone').classList.add('drag'); }));
['dragleave', 'drop'].forEach((name) => $('#dropzone').addEventListener(name, (event) => { event.preventDefault(); $('#dropzone').classList.remove('drag'); }));
$('#dropzone').addEventListener('drop', (event) => event.dataTransfer.files[0] && readWorkbook(event.dataTransfer.files[0]));
$('#replace-file').onclick = () => $('#report-file').click();
$('#add-row').onclick = () => { state.statements.push({ date: '', text: '', berth: state.fields.berth }); render(); };
$('#statement-rows').addEventListener('input', (event) => { if (event.target.dataset.i !== undefined) state.statements[event.target.dataset.i][event.target.dataset.k] = event.target.value; });
$('#statement-rows').addEventListener('click', (event) => { if (event.target.dataset.delete !== undefined) { state.statements.splice(event.target.dataset.delete, 1); render(); } });
$('#cargo-rows').addEventListener('input', (event) => { if (event.target.dataset.c !== undefined) state.cargo[event.target.dataset.c][event.target.dataset.k] = event.target.value; });
$('#download').onclick = download;
$('#reset').onclick = () => location.reload();
