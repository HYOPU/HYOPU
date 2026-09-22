import JSZip from "jszip";

export const JSTT_ORIGIN = "https://www.jstt.co.kr:5440";
export const JSTT_LOGIN_URL = `${JSTT_ORIGIN}/accounts/login`;
export const JSTT_SCHEDULE_URL = `${JSTT_ORIGIN}/TW/VesselSchedule/List`;
export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const MAX_WORKBOOK_BYTES = 4 * 1024 * 1024;
export const PUBLIC_CLIENT_HEADER = "lineup-ui-v1";
const MAX_CAPTURED_BASE64_BYTES = Math.ceil(MAX_WORKBOOK_BYTES / 3) * 4 + 32;

export class JsttScheduleError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "JsttScheduleError";
    this.code = code;
    this.status = status;
  }
}

function integerDatePart(parts, type) {
  const value = parts.find((part) => part.type === type)?.value ?? "";
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Missing ${type}`);
  }
  return parsed;
}

function isoDate(year, month, day) {
  return [year, month, day]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

function shiftedCalendarDate(year, month, day, monthOffset) {
  const targetMonthIndex = month - 1 + monthOffset;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedMonthIndex = ((targetMonthIndex % 12) + 12) % 12;
  const targetMonth = normalizedMonthIndex + 1;
  const targetMonthLastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return isoDate(targetYear, targetMonth, Math.min(day, targetMonthLastDay));
}

export function jsttScheduleDateRange(reference = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(reference);
  const year = integerDatePart(parts, "year");
  const month = integerDatePart(parts, "month");
  const day = integerDatePart(parts, "day");

  return {
    // JSTT filters by ETB. A lookback keeps vessels that berthed before today
    // but have not departed yet; completed departures are removed by the parser.
    startDate: shiftedCalendarDate(year, month, day, -1),
    endDate: shiftedCalendarDate(year, month, day, 1),
  };
}

export function loadJsttScheduleConfig(environ = process.env) {
  const userId = (environ.JSTT_SCHEDULE_USER_ID ?? "").trim();
  const password = environ.JSTT_SCHEDULE_PASSWORD ?? "";
  const supabaseUrl = (environ.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const serviceRoleKey = environ.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const validUserId = /^[A-Za-z0-9._@-]{2,80}$/.test(userId);
  // Accept the supplied legacy account's existing password, not a new-password policy.
  const validPassword = password.length >= 1
    && password.length <= 256
    && !/[\r\n\0]/.test(password);
  let validSupabaseUrl = false;
  try {
    const parsed = new URL(supabaseUrl);
    validSupabaseUrl = parsed.protocol === "https:"
      && parsed.origin === supabaseUrl
      && !parsed.username
      && !parsed.password;
  } catch {
    validSupabaseUrl = false;
  }
  const validServiceRoleKey = serviceRoleKey.length >= 20
    && serviceRoleKey.length <= 8192
    && !/[\r\n\0]/.test(serviceRoleKey);
  if (!validUserId || !validPassword || !validSupabaseUrl || !validServiceRoleKey) {
    throw new JsttScheduleError(
      "credentials_missing",
      503,
      "JSTT 자동 조회 계정이 아직 연결되지 않았습니다.",
    );
  }
  return {
    credentials: { userId, password },
    store: { supabaseUrl, serviceRoleKey },
  };
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return headers.get(name) ?? "";
  }
  const expected = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === expected);
  const value = entry?.[1];
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

export function isAllowedPublicScheduleRequest(headers) {
  const client = headerValue(headers, "x-jstt-schedule-client");
  const fetchSite = headerValue(headers, "sec-fetch-site").toLowerCase();
  return client === PUBLIC_CLIENT_HEADER
    && (fetchSite === "same-origin" || fetchSite === "same-site");
}

export function hasUnexpectedSearchParams(requestUrl) {
  try {
    return new URL(String(requestUrl ?? ""), "https://lineup.invalid").search.length > 0;
  } catch {
    return true;
  }
}

export function workbookFileName({ startDate, endDate }) {
  return `JSTT-Schedule-${startDate}-to-${endDate}.xlsx`;
}

export async function assertValidJsttWorkbook(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (
    buffer.byteLength < 4
    || buffer.byteLength > MAX_WORKBOOK_BYTES
    || buffer[0] !== 0x50
    || buffer[1] !== 0x4b
  ) {
    throw new JsttScheduleError(
      "invalid_export",
      502,
      "JSTT에서 받은 엑셀 파일 형식을 확인할 수 없습니다.",
    );
  }
  let archive;
  try {
    archive = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch {
    throw new JsttScheduleError(
      "invalid_export",
      502,
      "JSTT에서 받은 엑셀 파일이 손상되었습니다.",
    );
  }
  if (!archive.file("[Content_Types].xml") || !archive.file("xl/workbook.xml")) {
    throw new JsttScheduleError(
      "invalid_export",
      502,
      "JSTT에서 받은 파일이 지원되는 엑셀 형식이 아닙니다.",
    );
  }
  return buffer;
}

export async function decodeCapturedJsttWorkbook(value) {
  if (typeof value !== "string") {
    throw new JsttScheduleError(
      "invalid_export",
      502,
      "JSTT에서 받은 엑셀 파일 형식을 확인할 수 없습니다.",
    );
  }
  const encoded = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  if (
    !encoded
    || encoded.length > MAX_CAPTURED_BASE64_BYTES
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw new JsttScheduleError(
      "invalid_export",
      502,
      "JSTT에서 받은 엑셀 파일 형식을 확인할 수 없습니다.",
    );
  }
  return assertValidJsttWorkbook(Buffer.from(encoded, "base64"));
}

export function publicError(error) {
  if (error instanceof JsttScheduleError) {
    return error;
  }
  return new JsttScheduleError(
    "upstream_unavailable",
    502,
    "JSTT 선박 일정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
  );
}
