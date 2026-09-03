const { parseEtaRows } = require('./eta-source');

const FILE_NAME = 'KOREA ETA UPDATE 2020.08.31.xlsx';
const SITE_HOST = 'stolt-my.sharepoint.com';
const SITE_PATH = 'personal/hyopu_stolt_com';
const required = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'];

function missingConfig(env = process.env) { return required.filter(name => !env[name]); }
function configured(env = process.env) { return missingConfig(env).length === 0; }

async function responseJson(response, message) {
  if (response.ok) return response.json();
  throw new Error(message);
}

async function accessToken(env = process.env, fetchImpl = fetch) {
  const missing = missingConfig(env);
  if (missing.length) throw new Error(`Microsoft Graph 설정이 필요합니다: ${missing.join(', ')}`);
  const body = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID, client_secret: env.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
  });
  const response = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(env.GRAPH_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(8000),
  });
  const data = await responseJson(response, 'Microsoft Graph 인증에 실패했습니다.');
  if (!data.access_token || typeof data.access_token !== 'string') throw new Error('Microsoft Graph 인증 토큰이 올바르지 않습니다.');
  return data.access_token;
}

async function graph(path, token, fetchImpl = fetch) {
  const response = await fetchImpl(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  });
  return response;
}

async function driveForEta(token, env = process.env, fetchImpl = fetch) {
  if (env.GRAPH_ETA_DRIVE_ID) return env.GRAPH_ETA_DRIVE_ID;
  const siteId = env.GRAPH_ETA_SITE_ID || (await responseJson(
    await graph(`/sites/${SITE_HOST}:/${SITE_PATH}`, token, fetchImpl), 'SharePoint 사이트를 찾지 못했습니다.'
  )).id;
  if (!siteId) throw new Error('SharePoint 사이트 식별자를 찾지 못했습니다.');
  const drive = await responseJson(await graph(`/sites/${encodeURIComponent(siteId)}/drive`, token, fetchImpl), 'SharePoint 문서함을 찾지 못했습니다.');
  if (!drive.id) throw new Error('SharePoint 문서함 식별자를 찾지 못했습니다.');
  return drive.id;
}

async function itemForEta(driveId, token, env = process.env, fetchImpl = fetch) {
  if (env.GRAPH_ETA_ITEM_ID) return env.GRAPH_ETA_ITEM_ID;
  const name = env.GRAPH_ETA_FILE_NAME || FILE_NAME;
  const search = await responseJson(
    await graph(`/drives/${encodeURIComponent(driveId)}/root/search(q='${encodeURIComponent(name).replace(/%27/g, "''")}')`, token, fetchImpl),
    'KOREA ETA UPDATE 파일을 찾지 못했습니다.'
  );
  const item = (search.value || []).find(value => value.name === name && value.file);
  if (!item?.id) throw new Error('KOREA ETA UPDATE 파일을 찾지 못했습니다.');
  return item.id;
}

async function readGraphEtaRows(env = process.env, fetchImpl = fetch) {
  const token = await accessToken(env, fetchImpl);
  const driveId = await driveForEta(token, env, fetchImpl);
  const itemId = await itemForEta(driveId, token, env, fetchImpl);
  const response = await graph(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`, token, fetchImpl);
  if (!response.ok) throw new Error('KOREA ETA UPDATE 파일을 다운로드하지 못했습니다.');
  const length = Number(response.headers.get('content-length') || 0);
  if (length > 10 * 1024 * 1024) throw new Error('KOREA ETA UPDATE 파일이 10MB를 초과합니다.');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 10 * 1024 * 1024) throw new Error('KOREA ETA UPDATE 파일이 10MB를 초과합니다.');
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const sheetName = workbook.SheetNames.find(name => /ETA\s*UPDATE/i.test(name));
  if (!sheetName) throw new Error('ETA UPDATE 시트를 찾지 못했습니다.');
  return parseEtaRows(XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false }));
}

module.exports = { configured, missingConfig, accessToken, readGraphEtaRows };
