/**
 * Thời gian theo múi giờ Việt Nam.
 *
 * Việt Nam dùng UTC+7 cố định, không có DST — nên offset hằng số vừa đúng vừa
 * đáng tin hơn Intl (không phụ thuộc dữ liệu múi giờ của máy, không lệch khi
 * máy đặt sai timezone).
 */

export const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

const pad2 = (n) => String(n).padStart(2, '0');

/** Các thành phần ngày/giờ theo giờ VN của một mốc epoch. */
export function vnParts(epochMs) {
  const d = new Date(epochMs + VN_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/**
 * Ngày theo giờ VN dạng YYYY-MM-DD — chính là giá trị tham số `date` của API.
 *
 * Quan trọng: request lúc 18:51 GMT ngày 08/08 phải gửi date=2026-08-09, vì
 * lúc đó ở VN đã sang ngày mới. Dùng ngày UTC ở đây là sai.
 */
export function vnDateString(epochMs) {
  const p = vnParts(epochMs);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Giờ VN dạng HH:MM hoặc HH:MM:SS. */
export function vnTimeString(epochMs, withSeconds = true) {
  const p = vnParts(epochMs);
  const base = `${pad2(p.hour)}:${pad2(p.minute)}`;
  return withSeconds ? `${base}:${pad2(p.second)}` : base;
}

/** Ngày + giờ VN, để hiển thị. */
export function vnDateTimeString(epochMs, withSeconds = true) {
  return `${vnDateString(epochMs)} ${vnTimeString(epochMs, withSeconds)}`;
}

/**
 * Chuyển "ngày + giờ theo VN" mà người dùng nhập thành mốc epoch.
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} timeStr HH:MM hoặc HH:MM:SS
 */
export function vnToEpoch(dateStr, timeStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(timeStr || '').trim());
  if (!m || !t) return null;

  const [, y, mo, d] = m;
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  const second = Number(t[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;

  return Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, minute, second) - VN_OFFSET_MS;
}

/** Hôm nay theo giờ VN, dạng YYYY-MM-DD. Dùng làm giá trị mặc định của form. */
export function vnToday(now = Date.now()) {
  return vnDateString(now);
}

/**
 * Khoảng thời gian dạng đếm ngược HH:MM:SS (âm thì có dấu trừ ở đầu).
 * Dùng cho countdown tới giờ bóng lăn và cho đồng hồ 30 phút của gift code.
 */
export function formatDuration(ms) {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return `${neg ? '-' : ''}${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** Độ lệch đồng hồ dạng dễ đọc: "+312ms", "-1.2s". */
export function formatOffset(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  const sign = ms >= 0 ? '+' : '-';
  const abs = Math.abs(ms);
  return abs < 1000 ? `${sign}${Math.round(abs)}ms` : `${sign}${(abs / 1000).toFixed(2)}s`;
}
