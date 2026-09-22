import { parse } from 'parse5';
import { sha256 } from '../../ulsan-pilot-watcher/lib/source.ts';

export type PilotAction = 'CREATE' | 'UPDATE';
export type PilotFields = Record<string, string>;
export interface PilotForm { action: PilotAction; fields: PilotFields; options: Record<string, { value: string; label: string }[]>; hidden: string[]; remarkMaxLength?: number }
export interface PilotChoice { label: string; values: PilotFields }
interface RegNode { nodeName: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: RegNode[] }
const regAttr = (n: RegNode, key: string) => n.attrs?.find(a => a.name === key)?.value ?? '';
const regHas = (n: RegNode, key: string) => n.attrs?.some(a => a.name === key) ?? false;
const regNodes = (n: RegNode, tag: string): RegNode[] => [...(n.nodeName === tag ? [n] : []), ...(n.childNodes ?? []).flatMap(c => regNodes(c, tag))];
const regText = (n: RegNode): string => ['script', 'style', '#comment'].includes(n.nodeName) ? '' : n.value ?? (n.childNodes ?? []).map(regText).join(' ');
export const REG_FORM_PATH = { CREATE: '/crew/sub01/sub01_01.php', UPDATE: '/crew/sub01/sub02_03.php' };
export const REG_POST_PATH = { CREATE: '/crew/sub01/sub01_01_ok.php', UPDATE: '/crew/sub01/sub02_03_ok.php' };
// Observed application controls, not invented FWD/AFT/IMO/MMSI fields.
export const REG_EDITABLE = ['etryptyear','etryptco','cd_cargo','num_length','num_draft','tp_vessel','tp_cargo','dt_ship','tm_ship_h','tm_ship_i',
  'nm_point_f','cd_pointrep_f','cd_pointend_f','nm_pointrep_f','nm_pointend_f','nm_point_t','cd_pointrep_t','cd_pointend_t','nm_pointrep_t','nm_pointend_t',
  'tugboat_1','tugboat_2','tugboat_a','tugboat_b','sn_partner','cd_partner_line','tel_partner_line','fg_side','num_bt_yn','fg_inoutport','tp_q','nm_text',
  'ln_partner_ship','cd_partner_ship','ln_partner_chg','cd_partner_chg','cd_emp_partner','no_hpemp_partner','fg_tax','e_mail','yn_dispilot','final_confirm_1'] as const;
export const REG_VESSEL = ['nm_callsign','cd_callsign','cd_imo','cd_cargo','num_ton','num_length','cd_nation','nm_nation'] as const;
export const REG_MOVEMENTS = { '010': '최초입항', '030': '최종출항', '060': '항내이동', '070': '재입항', '090': '기타' };

export function parsePilotForm(html: string, action: PilotAction, readOnly=false): PilotForm {
  if (/로그인 후 사용|cf-chl-|captcha|access denied/i.test(html)) throw Error('REG_AUTH_OR_CHALLENGE');
  if (!/<\/body\s*>[\s\S]*<\/html\s*>/i.test(html)) throw Error('REG_FORM_TRUNCATED');
  const root = parse(html) as RegNode;
  if (!regText(root).replace(/\s+/g, ' ').includes('협운해운 ON')) throw Error('REG_ACCOUNT');
  const forms = regNodes(root, 'form').filter(n => regAttr(n, 'name') === 'ship_frm');
  const form = forms[0];
  if (forms.length !== 1 || regAttr(form, 'method').toLowerCase() !== 'post'
    || new URL(regAttr(form, 'action'), 'http://www.ulsanpilot.co.kr' + REG_FORM_PATH[action]).href !== 'http://www.ulsanpilot.co.kr' + REG_POST_PATH[action]) throw Error('REG_FORM_CONTRACT');
  const fields: PilotFields = {}, options: PilotForm['options'] = {}, hidden: string[] = [];
  for (const input of regNodes(form, 'input')) {
    const name = regAttr(input, 'name'), type = regAttr(input, 'type').toLowerCase();
    if (!name || regHas(input, 'disabled') || ['submit','button','image','reset','file'].includes(type)) continue;
    if (['radio','checkbox'].includes(type)) {
      (options[name] ??= []).push({ value: regAttr(input, 'value'), label: regAttr(input, 'value') });
      if (!(name in fields)) fields[name] = '';
      if (regHas(input, 'checked')) fields[name] = regAttr(input, 'value');
    } else {
      if (name in fields) throw Error('REG_DUPLICATE_CONTROL');
      fields[name] = regAttr(input, 'value');
      if (type === 'hidden') hidden.push(name);
    }
  }
  for (const s of regNodes(form, 'select')) {
    const name = regAttr(s, 'name'); if (!name || regHas(s, 'disabled')) continue;
    const opts = regNodes(s, 'option');
    options[name] = opts.map(o => ({ value: regAttr(o, 'value'), label: regText(o).replace(/\s+/g, ' ').trim() }));
    fields[name] = regAttr(opts.find(o => regHas(o, 'selected')) ?? opts[0], 'value');
  }
  let remarkMaxLength: number | undefined;
  for (const t of regNodes(form, 'textarea')) {
    const name = regAttr(t, 'name');
    if (!name || regHas(t, 'disabled')) continue;
    if (name in fields) throw Error('REG_DUPLICATE_CONTROL');
    fields[name] = regText(t);
    if (name === 'nm_text' && regHas(t, 'maxlength')) {
      const limit = regAttr(t, 'maxlength');
      if (!/^\d+$/.test(limit) || !Number.isSafeInteger(Number(limit))) throw Error('REG_REMARK_CONTRACT');
      remarkMaxLength = Number(limit);
    }
  }
  for (const key of ['no_forecast','seq_log','fg_status',action==='CREATE'?'xxr':'s_cd_partner','cd_callsign','dt_ship','tm_ship_h','tm_ship_i','cd_pointend_f','cd_pointend_t','cd_partner','num_draft'])
    if (!(key in fields)) throw Error('REG_REQUIRED_CONTROL_MISSING');
  if (fields.cd_partner !== '1002' && !(action==='CREATE'&&fields.cd_partner==='')) throw Error('REG_ACCOUNT');
  if (action === 'UPDATE' && (!/^\d{1,30}$/.test(fields.no_forecast) || (readOnly?['090']:['050','060','090']).includes(fields.fg_status))) throw Error('REG_NOT_EDITABLE');
  return { action, fields, options, hidden, ...(remarkMaxLength === undefined ? {} : { remarkMaxLength }) };
}

export function pilotRemarkLimit(form: Pick<PilotForm, 'remarkMaxLength'>): number {
  const limit = form.remarkMaxLength;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw Error('REG_REMARK_CONTRACT');
  // A placeholder is advisory, not an HTML constraint. Bound application input
  // even when the source does not declare maxlength; never truncate source text.
  return Math.min(limit ?? 1200, 1200);
}
export function validatePilotRemark(form: Pick<PilotForm, 'remarkMaxLength'>, value: string): void {
  if (typeof value !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw Error('REG_REMARK_INPUT');
  if (value.length > pilotRemarkLimit(form)) throw Error('REG_REMARK_LIMIT');
}

export function pilotBusinessFields(fields: PilotFields): PilotFields {
  const names = [...REG_EDITABLE, ...REG_VESSEL, 'no_forecast','fg_status','cd_partner','ln_partner'];
  return Object.fromEntries([...new Set(names)].sort().filter(k => k in fields).map(k => [k, fields[k]]));
}
export const pilotBusinessHash = (fields: PilotFields) => sha256(JSON.stringify(pilotBusinessFields(fields)));
export function pilotPayload(form: PilotForm, draft: PilotFields): PilotFields {
  const result = { ...form.fields };
  for (const key of [...REG_EDITABLE, ...(form.action === 'CREATE' ? REG_VESSEL : [])])
    if (key in draft && !(key in result)) throw Error('REG_FORM_FIELDS_CHANGED');
  for (const key of REG_EDITABLE) if (key in draft && key in result) result[key] = draft[key];
  if (form.action === 'CREATE') for (const key of REG_VESSEL) if (key in draft && key in result) result[key] = draft[key];
  if (form.action === 'CREATE') { result.cd_partner='1002'; result.ln_partner='협운해운'; }
  // Status, application ID, agency and opaque controls always come from the fresh form.
  if (result.fg_status === '090') throw Error('REG_CANCEL_FORBIDDEN');
  return result;
}
export function validatePilotFields(form: PilotForm, f: PilotFields, now = Date.now()): void {
  if (Object.values(f).some(v => typeof v !== 'string' || v.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))) throw Error('REG_FIELD_LIMIT');
  for (const key of ['nm_callsign','cd_callsign','cd_pointrep_f','cd_pointend_f','cd_pointrep_t','cd_pointend_t','fg_inoutport','ln_partner_ship','cd_partner_ship','ln_partner','cd_partner','cd_emp_partner','no_hpemp_partner','fg_tax'])
    if (!f[key]?.trim()) throw Error('REG_REQUIRED_' + key.toUpperCase());
  if (form.action === 'CREATE' && (!/^\d{4}$/.test(f.etryptyear) || !f.cd_cargo)) throw Error('REG_VESSEL_REQUIRED');
  if (f.cd_partner !== '1002' || !Object.hasOwn(REG_MOVEMENTS, f.fg_inoutport) || f.fg_status === '090') throw Error('REG_IDENTITY');
  if (!/^\d{8}$/.test(f.dt_ship) || !/^(?:[01]\d|2[0-3])$/.test(f.tm_ship_h) || !/^[0-5]\d$/.test(f.tm_ship_i)) throw Error('REG_DATETIME');
  const date = `${f.dt_ship.slice(0,4)}-${f.dt_ship.slice(4,6)}-${f.dt_ship.slice(6,8)}`;
  const stamp = Date.parse(`${date}T${f.tm_ship_h}:${f.tm_ship_i}:00+09:00`);
  if (!Number.isFinite(stamp) || new Date(stamp + 9*3600000).toISOString().slice(0,10) !== date || stamp <= now) throw Error('REG_PAST_OR_INVALID_TIME');
  if (f.num_draft && !/^\d{1,2}(?:\.\d{1,2})?$/.test(f.num_draft)) throw Error('REG_DRAFT_NUMBER');
  if (f.num_length && !/^\d{1,3}(?:\.\d{1,2})?$/.test(f.num_length)) throw Error('REG_LOA_NUMBER');
  validatePilotRemark(form, f.nm_text ?? '');
  for(const [company,count] of [['tugboat_1','tugboat_a'],['tugboat_2','tugboat_b']])
    if ((!f[company]&&Number(f[count])>0)||(f[company]&&!(Number(f[count])>=1&&Number(f[count])<=5))) throw Error('REG_TUG_PAIR');
  for (const [key, opts] of Object.entries(form.options)) if (f[key] && !opts.some(o => o.value === f[key])) throw Error('REG_OPTION_' + key.toUpperCase());
  if (f.cd_pointrep_f === f.cd_pointrep_t && f.cd_pointend_f === f.cd_pointend_t) throw Error('REG_IDENTICAL_ROUTE');
  if (form.action === 'UPDATE') for (const k of ['no_forecast','cd_callsign','nm_callsign','cd_partner']) if (f[k] !== form.fields[k]) throw Error('REG_FIXED_IDENTITY');
}

export type PilotLookup = 'vessel' | 'point' | 'mooring' | 'shipcompany' | 'billing';
export const REG_LOOKUPS: Record<PilotLookup, { path: string; parameter: string; input: string }> = {
  vessel: { path:'get_data_callsign.php', parameter:'nm_callsign', input:'cb_cd_callsign' },
  point: { path:'get_data_bs_point.php', parameter:'cd_point', input:'cb_cd_point' },
  mooring: { path:'get_data_partner_line.php', parameter:'sn_partner', input:'cb_cd_partner' },
  shipcompany: { path:'get_data_partner_ship.php', parameter:'ln_partner_ship', input:'cb_cd_partner' },
  billing: { path:'get_data_partner_chg.php', parameter:'ln_partner_chg', input:'cb_cd_partner_chg' },
};
export function parsePilotChoices(html: string, kind: PilotLookup): PilotChoice[] {
  if (/로그인 후 사용|cf-chl-|captcha/i.test(html)) throw Error('REG_LOOKUP_AUTH');
  const nodes = [...new Map(regNodes(parse(html) as RegNode, 'input').filter(n => regAttr(n, 'name') === REG_LOOKUPS[kind].input).map(n => [regAttr(n,'value'),n])).values()];
  if (nodes.length > 100) throw Error('REG_SEARCH_NARROW');
  return nodes.map(n => {
    const p = regAttr(n, 'value').split('|');
    if (p.length < 2 || !p[0] || !p[1]) throw Error('REG_LOOKUP_CONTRACT');
    if (kind === 'vessel') {
      if (p.length < 10) throw Error('REG_VESSEL_CONTRACT');
      return { label: `${p[1]} / ${p[0]} / ${p[9]}`, values: Object.fromEntries(['cd_callsign','nm_callsign','cd_imo','cd_cargo','num_ton','num_length','','cd_nation','','nm_nation'].flatMap((k,i) => k ? [[k,p[i]]] : [])) };
    }
    if (kind === 'point') {
      if (p.length < 5 || !/^\d{2}$/.test(p[0]) || !/^\d{5}$/.test(p[1])) throw Error('REG_POINT_CONTRACT');
      return { label: `${p[2]} (${p[0]}:${p[1]})`, values:{ cd_pointrep:p[0],nm_pointrep:p[3],cd_pointend:p[1],nm_pointend:p[4],nm_point:p[2] } };
    }
    if (kind === 'mooring') return { label:p[1],values:{cd_partner_line:p[0],sn_partner:p[1],tel_partner_line:p[2]??''} };
    const suffix = kind === 'billing' ? 'chg' : 'ship';
    return { label:p[1],values:{['cd_partner_'+suffix]:p[0],['ln_partner_'+suffix]:p[1]} };
  });
}
