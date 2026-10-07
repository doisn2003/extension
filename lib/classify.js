/**
 * Phân loại phản hồi.
 *
 * Không hardcode chuỗi thông báo: tra từ điển trước (nhãn do bạn gán, chính xác
 * tuyệt đối), chỉ khi chưa có nhãn mới đoán bằng heuristic. Gán nhãn một lần là
 * lần sau tool xử lý đúng mãi — không cần sửa code.
 */

import { LABELS, signature } from './blackbox.js';

/** Việc engine phải làm ứng với mỗi nhãn, khi không xét giai đoạn. */
export const ACTIONS = {
  [LABELS.SUCCESS]: 'stop-win',
  [LABELS.NOT_YET]: 'continue',
  [LABELS.SOLD_OUT]: 'stop-lose',
  [LABELS.TRANSIENT]: 'retry-now',
  [LABELS.THROTTLED]: 'backoff',
  [LABELS.SESSION_DEAD]: 'stop-alert',
  [LABELS.CHALLENGED]: 'stop-alert',
  [LABELS.BAD_MATCH]: 'stop-alert',
  [LABELS.NEEDS_PAGE]: 'stop-alert',
  [LABELS.BAD_REQUEST]: 'stop-alert',
  // Giữa cuộc đua, một phản hồi lạ không phải lý do để dừng.
  [LABELS.UNKNOWN]: 'continue',
};

/** Các giai đoạn thuộc cuộc đua — nơi mọi phán đoán phải nghiêng về "bắn tiếp". */
const RACE_PHASES = new Set(['burst', 'tail']);

/**
 * Chỉ bốn lý do này được phép dừng một site giữa cuộc đua.
 * Danh sách trắng chứ không phải danh sách đen: thêm nhãn mới về sau cũng không
 * vô tình làm tắt engine giữa chừng.
 */
const RACE_STOPPERS = new Set([
  LABELS.SUCCESS,      // đã có mã, không cần bắn nữa
  LABELS.SOLD_OUT,     // hết code, bắn thêm chỉ phí
  LABELS.SESSION_DEAD, // không đăng nhập thì bắn bao nhiêu cũng vô ích
  LABELS.CHALLENGED,   // bị chặn, bắn tiếp chỉ làm tệ hơn
]);

/**
 * Việc phải làm, có xét giai đoạn.
 *
 * Giữa burst, mọi phản hồi không nằm trong danh sách trắng đều được coi là
 * "bắn tiếp". Lý do rất cụ thể: API thật trả `404 Invalid match name`, và nhiều
 * khả năng nó cũng trả đúng như vậy khi bản ghi gift code chưa được tạo — tức
 * là lúc code chưa phát. Tin nhãn đó mà dừng thì engine bắn đúng một phát ở
 * T-150ms rồi tắt hẳn, ngay trước thời điểm code xuất hiện.
 *
 * Chính tả tên trận đã được kiểm từ trước bằng Kiểm tra sẵn sàng, còn việc bắn
 * lan man đã có trần cứng `maxAttempts` và quy tắc "4xx lạ lặp 3 lần" chặn.
 */
export function actionFor(label, phase) {
  const base = ACTIONS[label] || 'continue';
  if (!RACE_PHASES.has(phase)) return base;
  // Giãn nhịp và thử lại ngay là điều tiết, không phải dừng — giữ nguyên.
  if (base === 'backoff' || base === 'retry-now') return base;
  return RACE_STOPPERS.has(label) ? base : 'continue';
}

/**
 * Chuỗi lỗi thật của hệ thống sự kiện, xác minh trên site thật (09/08/2026):
 *   400 + "Outside time window" / TIME_OUT_CODE  → tên trận ĐÚNG, chưa tới giờ
 *   404 + "Invalid match name"                   → tên trận SAI hoặc sai ngày
 * Hai mã khác nhau nên phân biệt được — đây là điều làm nút Thử nghiệm có nghĩa.
 */
const RE_TIME_WINDOW = /(TIME_OUT_CODE|outside time window)/i;
const RE_INVALID_NAME = /invalid match name/i;
/**
 * Chuỗi lỗi thật của bước ĐỔI THƯỞNG, bắt được trong trận thật 10/08/2026:
 *   423 "Vui lòng tải lại trang!"        → nonce hết hạn, phải đổi từ trong trang
 *   422 "giftCode: Bắt buộc nhập..."     → sai tên trường trong body
 */
const RE_RELOAD_PAGE = /(tải lại trang|reload the page)/i;
const RE_FIELD_REQUIRED = /bắt buộc nhập trường/i;
const RE_MISSING_CONFIG = /(missing config_?id|config_?id)/i;

const RE_TRANSIENT = /(có lỗi xảy ra|thử lại sau|vui lòng thử lại|system busy|try again)/i;
const RE_SOLD_OUT = /(hết code|đã hết|hết lượt|hết quà|out of stock|sold ?out|không còn)/i;
const RE_NOT_YET = /(chưa (đến|tới) giờ|chưa bắt đầu|chưa mở|not started|not yet)/i;
const RE_ALREADY = /(đã nhận|đã sử dụng|already (claimed|used))/i;
const RE_BAD_MATCH = /(không tìm thấy|không tồn tại|not found|invalid match|no match)/i;
const RE_SESSION = /(chưa đăng nhập|phiên|unauthor|token|đăng nhập lại)/i;
const RE_CHALLENGE = /(just a moment|cf-browser-verification|cdn-cgi\/challenge|attention required)/i;

/**
 * Khoá nào trông giống nơi chứa gift code.
 *
 * Phải chặt: phản hồi lỗi thật có `"error_code": "ERROR_SYSTEM"` — khớp lỏng là
 * tool tưởng đã lấy được code trong khi thực ra vừa gặp lỗi.
 */
const CODE_KEY = /^(gift_?code|code|coupon|voucher|promo_?code)$/i;
const CODE_KEY_BANNED = /(error|status|http|reason|type)/i;
/** Gift code: chữ-số, gạch nối, gạch dưới 5-31 ký tự. */
const CODE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,31}$/;
const NON_CODE_WORDS = /^(true|false|null|success|ok|error|fail|failed|pending|done|not-found|unknown|ERROR_SYSTEM)$/i;

/**
 * Tìm gift code trong phản hồi mà không cần biết trước tên trường.
 * Duyệt cây JSON tìm khoá trông giống "code", nếu không có thì quét regex trên
 * text thô. Phase 4 sẽ chốt lại tên trường thật rồi rút gọn hàm này.
 */
export function extractCode(bodyText) {
  const text = String(bodyText ?? '');
  if (!text) return null;

  // Body parse được JSON thì CHỈ tin cấu trúc, tuyệt đối không quét regex.
  //
  // Lý do: phản hồi thật `{"message":"User already received","branch":"BC373351"}`
  // không có trường mã nào, nhưng regex sẽ nhặt "BC373351" (mã chi nhánh) và
  // báo là đã lấy được code. Thà không tìm thấy còn hơn tìm nhầm.
  try {
    return walkForCode(JSON.parse(text), 0);
  } catch {
    // không phải JSON — mới rơi xuống quét regex
  }

  const m = /\b(HOTMATCH[A-Z0-9]{2,})\b/.exec(text) || /\b([A-Z][A-Z0-9]{7,23})\b/.exec(text);
  return m ? m[1] : null;
}

function walkForCode(node, depth) {
  if (depth > 6 || node == null) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = walkForCode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== 'string') continue;
    if (CODE_KEY_BANNED.test(key) || !CODE_KEY.test(key)) continue;
    if (!CODE_VALUE.test(value) || NON_CODE_WORDS.test(value)) continue;
    return value;
  }
  for (const value of Object.values(node)) {
    const found = walkForCode(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Đoán nhãn khi chữ ký chưa có trong từ điển. */
export function heuristicLabel({ status, body, headers = {} }) {
  const text = String(body ?? '');

  if (!status) return LABELS.TRANSIENT; // lỗi mạng / abort

  // Mã lỗi cụ thể của hệ thống sự kiện được xét trước mọi suy đoán theo HTTP status.
  if (RE_TIME_WINDOW.test(text)) return LABELS.NOT_YET;
  if (RE_INVALID_NAME.test(text)) return LABELS.BAD_MATCH;
  if (status === 423 || RE_RELOAD_PAGE.test(text)) return LABELS.NEEDS_PAGE;
  if (RE_FIELD_REQUIRED.test(text) || RE_MISSING_CONFIG.test(text)) return LABELS.BAD_REQUEST;

  if (status === 429) return LABELS.THROTTLED;
  if (status === 401) return LABELS.SESSION_DEAD;
  if (status === 403) return RE_CHALLENGE.test(text) ? LABELS.CHALLENGED : LABELS.SESSION_DEAD;
  if (status >= 500) return LABELS.TRANSIENT;

  const remaining = Number(headers['x-ratelimit-remaining']);
  if (Number.isFinite(remaining) && remaining <= 0) return LABELS.THROTTLED;

  if (status >= 200 && status < 300) {
    if (extractCode(text)) return LABELS.SUCCESS;
    if (RE_TRANSIENT.test(text)) return LABELS.TRANSIENT;
    if (RE_SOLD_OUT.test(text)) return LABELS.SOLD_OUT;
    if (RE_ALREADY.test(text)) return LABELS.SOLD_OUT;
    if (RE_NOT_YET.test(text)) return LABELS.NOT_YET;
    if (RE_BAD_MATCH.test(text)) return LABELS.BAD_MATCH;
    if (RE_SESSION.test(text)) return LABELS.SESSION_DEAD;
    return LABELS.UNKNOWN;
  }

  if (status === 404) return LABELS.BAD_MATCH;
  return LABELS.UNKNOWN;
}

/**
 * Phân loại đầy đủ: từ điển thắng heuristic.
 * @param {{status:number, body:string, headers?:object}} resp
 * @param {Map<string,object>|object} dictionary chữ ký -> bản ghi
 */
export function classify(resp, dictionary, phase = null) {
  const sig = signature(resp.status, resp.body);
  const foundCode = extractCode(resp.body);

  // Nếu phản hồi có chứa gift code hợp lệ -> luôn ưu tiên trả về SUCCESS và dừng thắng ngay
  if (foundCode) {
    return {
      sig,
      label: LABELS.SUCCESS,
      source: 'code-extracted',
      action: ACTIONS[LABELS.SUCCESS],
      code: foundCode,
    };
  }

  const entry = dictionary instanceof Map ? dictionary.get(sig) : dictionary?.[sig];

  // Chỉ nhãn do bạn chốt mới được đè lên heuristic. Nhãn heuristic đã lưu trong
  // từ điển thì bỏ qua và tính lại — nhờ vậy mỗi lần heuristic được cải thiện,
  // các chữ ký cũ hưởng ngay mà không bị đóng băng theo phán đoán lần đầu.
  let label;
  let source;
  if (entry && entry.labelSource === 'user' && entry.label && entry.label !== LABELS.UNKNOWN) {
    label = entry.label;
    source = 'dictionary';
  } else {
    label = heuristicLabel(resp);
    source = 'heuristic';
  }

  return {
    sig,
    label,
    source,
    action: actionFor(label, phase),
    code: label === LABELS.SUCCESS ? foundCode : null,
  };
}

/** Đọc các header liên quan tới hạn mức, để engine tự giãn nhịp. */
export function rateLimitFrom(headers = {}) {
  const limit = Number(headers['x-ratelimit-limit']);
  const remaining = Number(headers['x-ratelimit-remaining']);
  const reset = Number(headers['x-ratelimit-reset']);
  if (!Number.isFinite(limit) && !Number.isFinite(remaining)) return null;
  return {
    limit: Number.isFinite(limit) ? limit : null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetAt: Number.isFinite(reset) ? reset * 1000 : null,
  };
}
