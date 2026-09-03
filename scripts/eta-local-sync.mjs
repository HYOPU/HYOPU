#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ENDPOINT = 'https://hyopu.vercel.app/api/eta-import';
export const DEFAULT_DELAY_MS = 45_000;

export function parseArgs(args) {
  const options = { file: '', endpoint: DEFAULT_ENDPOINT, delayMs: DEFAULT_DELAY_MS, watch: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--watch') options.watch = true;
    else if (value === '--once') options.watch = false;
    else if (value === '--file') options.file = args[++index] || '';
    else if (value === '--endpoint') options.endpoint = args[++index] || '';
    else if (value === '--delay') options.delayMs = Math.max(5_000, Number(args[++index]) * 1000 || DEFAULT_DELAY_MS);
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`알 수 없는 옵션: ${value}`);
  }
  return options;
}

export function resolveFile(options, environment = process.env) {
  return options.file || environment.HYOPU_ETA_SOURCE_FILE || '';
}

export function isXlsx(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

export function fingerprint(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function defaultStatePath(environment = process.env) {
  const base = environment.LOCALAPPDATA || path.join(os.homedir(), '.hyopu');
  return path.join(base, 'HYOPU', 'eta-sync-state.json');
}

async function readState(filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); } catch { return { files: {} }; }
}

async function writeState(filename, state) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, JSON.stringify(state, null, 2), 'utf8');
}

async function readStableFile(filename, delayMs = 2_000) {
  const first = await fs.stat(filename);
  await new Promise(resolve => setTimeout(resolve, delayMs));
  const second = await fs.stat(filename);
  if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) throw new Error('OneDrive 파일이 아직 저장 중입니다. 다음 변경 감지 때 다시 시도합니다.');
  const buffer = await fs.readFile(filename);
  if (!isXlsx(buffer)) throw new Error('대상 파일이 유효한 .xlsx 파일이 아닙니다.');
  return buffer;
}

export async function syncEtaFile({ file, token, endpoint = DEFAULT_ENDPOINT, statePath = defaultStatePath(), fetchImpl = fetch, force = false, stableDelayMs = 2_000 }) {
  if (!file) throw new Error('--file 또는 HYOPU_ETA_SOURCE_FILE을 지정해 주세요.');
  if (!token) throw new Error('HYOPU_ETA_SYNC_TOKEN이 설정되지 않았습니다.');
  if (!existsSync(file)) throw new Error(`OneDrive 파일을 찾지 못했습니다: ${file}`);
  const buffer = await readStableFile(file, stableDelayMs);
  const hash = fingerprint(buffer);
  const state = await readState(statePath);
  const entry = state.files?.[path.resolve(file)];
  if (!force && entry?.hash === hash) return { skipped: true, reason: '동일한 파일 버전입니다.', hash };
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ $content: buffer.toString('base64') }),
  });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok || !result.synced) throw new Error(result.error || `HYOPU 전송 실패 (${response.status})`);
  state.files ||= {};
  state.files[path.resolve(file)] = { hash, syncedAt: new Date().toISOString(), sourceRows: result.sourceRows, changed: result.changed };
  await writeState(statePath, state);
  return { skipped: false, ...result, hash };
}

export function watchEtaFile({ file, delayMs, onChange }) {
  const directory = path.dirname(file);
  const basename = path.basename(file).toLowerCase();
  let timer;
  const schedule = filename => {
    if (filename && String(filename).toLowerCase() !== basename) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, delayMs);
  };
  const watcher = watch(directory, { persistent: true }, (_event, filename) => schedule(filename));
  return { watcher, schedule };
}

function usage() {
  return [
    'HYOPU ETA Local Sync',
    '  node scripts/eta-local-sync.mjs --once --file "C:\\OneDrive\\...\\KOREA ETA UPDATE.xlsx"',
    '  node scripts/eta-local-sync.mjs --watch --file "C:\\OneDrive\\...\\KOREA ETA UPDATE.xlsx"',
    '  필요한 환경 변수: HYOPU_ETA_SYNC_TOKEN',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return console.log(usage());
  const file = resolveFile(options);
  const token = process.env.HYOPU_ETA_SYNC_TOKEN;
  const run = async () => {
    try {
      const result = await syncEtaFile({ file, token, endpoint: options.endpoint });
      console.log(result.skipped ? `[HYOPU ETA] 건너뜀: ${result.reason}` : `[HYOPU ETA] 완료: ${result.sourceRows}건 확인 · ${result.changed}건 갱신`);
    } catch (error) { console.error(`[HYOPU ETA] ${error.message}`); }
  };
  await run();
  if (!options.watch) return;
  const { watcher } = watchEtaFile({ file, delayMs: options.delayMs, onChange: run });
  console.log(`[HYOPU ETA] 감시 중: ${file} (저장 후 ${Math.round(options.delayMs / 1000)}초 대기)`);
  process.on('SIGINT', () => { watcher.close(); process.exit(0); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
