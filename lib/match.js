/**
 * Mô hình trận đấu và kiểm tra chính tả.
 *
 * Vì `match_name` phải khớp tuyệt đối với chuỗi hệ thống sự kiện đang giữ, và
 * một trận dùng chung cho cả 15 site, nên một ký tự sai là hỏng toàn bộ. Mọi
 * hàm ở đây tồn tại để cái sai lộ ra trước giờ bóng lăn chứ không phải lúc bắn.
 */

import { vnToEpoch, vnDateString, formatDuration } from './vn-time.js';

/** Ký tự vô hình hay lọt vào khi copy tên đội từ trang web: zero-width, BOM, soft hyphen. */
const INVISIBLE = /[\u200b-\u200d\ufeff\u00ad]/g;
/** Khoảng trắng trông y hệt dấu cách nhưng mã khác: nbsp, en/em space, ideographic space… */
const ODD_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

export const SEPARATOR = ' & ';

/**
 * Code được phát TRƯỚC giờ bóng lăn 10 phút.
 *
 * Đồng hồ đếm ngược trên trang đếm tới thời điểm *phát code*, không phải tới
 * giờ bóng lăn: card trận 08:30 hiện 00:57:58 vào lúc ~07:22 → kết thúc tại
 * 08:20. Nhầm chỗ này là bắn muộn nguyên 10 phút, tức thua chắc.
 */
export const DEFAULT_RELEASE_OFFSET_MIN = 10;

/**
 * Chuẩn hoá tên đội. Trả về cả tên sạch lẫn danh sách thứ đã sửa, để giao diện
 * nói rõ "tôi vừa sửa gì" thay vì lặng lẽ đổi chữ bạn gõ.
 */
export function normalizeTeam(raw) {
  const original = String(raw ?? '');
  const fixes = [];

  let s = original;
  if (INVISIBLE.test(s)) {
    s = s.replace(INVISIBLE, '');
    fixes.push('bỏ ký tự vô hình');
  }
  if (ODD_SPACE.test(s)) {
    s = s.replace(ODD_SPACE, ' ');
    fixes.push('đổi khoảng trắng lạ thành khoảng trắng thường');
  }
  if (s !== s.trim()) {
    s = s.trim();
    fixes.push('bỏ khoảng trắng đầu/cuối');
  }
  if (/\s{2,}/.test(s)) {
    s = s.replace(/\s{2,}/g, ' ');
    fixes.push('gộp khoảng trắng lặp');
  }

  return { value: s, fixes, changed: s !== original };
}

/**
 * Nếu dán nguyên "A & B" vào ô Đội nhà, tách hộ thay vì để người dùng tự sửa.
 * @returns {{home:string, away:string}|null}
 */
export function splitPasted(text) {
  const s = String(text ?? '');
  const m = /^(.+?)\s*&\s*(.+)$/.exec(s.trim());
  if (!m) return null;
  return { home: m[1].trim(), away: m[2].trim() };
}

export function joinMatchName(home, away) {
  return `${home}${SEPARATOR}${away}`;
}

export function matchId(matchName, kickoffEpoch) {
  return `${new Date(kickoffEpoch).toISOString().slice(0, 16)}|${matchName}`;
}

/**
 * Dựng trận từ dữ liệu người dùng nhập và chỉ ra mọi chỗ đáng ngờ.
 *
 * Lỗi (`errors`) chặn không cho lưu. Cảnh báo (`warnings`) vẫn cho lưu nhưng
 * hiện rõ — vì tôi không biết tên đội thật, chỉ bạn mới biết.
 */
export function validateMatch({ home, away, date, time, releaseOffsetMin }, now = Date.now()) {
  const errors = [];
  const warnings = [];
  const offsetMin = Number.isFinite(Number(releaseOffsetMin)) ? Number(releaseOffsetMin) : DEFAULT_RELEASE_OFFSET_MIN;

  const h = normalizeTeam(home);
  const a = normalizeTeam(away);

  if (!h.value) errors.push('Chưa nhập đội nhà.');
  if (!a.value) errors.push('Chưa nhập đội khách.');
  if (h.value && h.value.length < 2) errors.push('Tên đội nhà quá ngắn.');
  if (a.value && a.value.length < 2) errors.push('Tên đội khách quá ngắn.');

  if (h.changed) warnings.push(`Đội nhà: đã ${h.fixes.join(', ')}.`);
  if (a.changed) warnings.push(`Đội khách: đã ${a.fixes.join(', ')}.`);

  // Dấu & là ký tự nối hai đội, không được nằm trong tên một đội.
  if (h.value.includes('&')) warnings.push('Tên đội nhà có dấu "&" — kiểm tra xem bạn có dán nhầm cả hai đội vào một ô không.');
  if (a.value.includes('&')) warnings.push('Tên đội khách có dấu "&" — kiểm tra lại.');

  if (h.value && a.value && h.value === a.value) {
    warnings.push('Hai đội trùng tên nhau.');
  }

  const kickoffEpoch = vnToEpoch(date, time);
  if (kickoffEpoch == null) {
    errors.push('Ngày hoặc giờ bóng lăn không hợp lệ.');
  } else if (kickoffEpoch < now - 6 * 3600 * 1000) {
    warnings.push('Giờ bóng lăn đã qua hơn 6 tiếng — kiểm tra lại ngày.');
  }

  if (offsetMin < 0 || offsetMin > 180) errors.push('Số phút phát code trước trận phải nằm trong 0–180.');
  if (errors.length) return { ok: false, errors, warnings, match: null };

  const matchName = joinMatchName(h.value, a.value);
  const releaseEpoch = kickoffEpoch - offsetMin * 60000;

  // `date` khoá theo ngày bóng lăn (giờ VN). Với trận ngay sau nửa đêm, thời
  // điểm phát code rơi vào ngày hôm trước — chưa rõ server khoá theo ngày nào,
  // nên cảnh báo thay vì đoán bừa.
  const dateParam = vnDateString(kickoffEpoch);
  if (vnDateString(releaseEpoch) !== dateParam) {
    warnings.push(`Giờ phát code (${vnDateString(releaseEpoch)}) rơi vào ngày khác giờ bóng lăn (${dateParam}). Tool đang gửi date theo ngày bóng lăn — hãy chạy Thử nghiệm để chắc chắn.`);
  }

  if (releaseEpoch < now) {
    warnings.push('Thời điểm phát code đã trôi qua — engine sẽ bắn ngay thay vì chờ.');
  }

  return {
    ok: true,
    errors,
    warnings,
    match: {
      id: matchId(matchName, kickoffEpoch),
      home: h.value,
      away: a.value,
      matchName,
      dateParam,
      kickoffEpoch,
      kickoffDate: date,
      kickoffTime: time,
      releaseOffsetMin: offsetMin,
      releaseEpoch,
    },
  };
}

/**
 * Thời điểm phát code của một trận.
 * Bản ghi cũ chưa có `releaseEpoch` thì suy lại từ kickoff cho khỏi vỡ.
 */
export function releaseTime(match) {
  if (Number.isFinite(match?.releaseEpoch)) return match.releaseEpoch;
  const offsetMin = Number.isFinite(match?.releaseOffsetMin) ? match.releaseOffsetMin : DEFAULT_RELEASE_OFFSET_MIN;
  return match.kickoffEpoch - offsetMin * 60000;
}

/** Đếm ngược tới thời điểm phát code — đúng thứ đồng hồ trên trang đang đếm. */
export function countdown(match, serverNowMs) {
  return formatDuration(releaseTime(match) - serverNowMs);
}

/**
 * Suy ngược số phút phát code trước trận từ đồng hồ đang hiện trên trang.
 * Đây là cách kiểm chắc chắn nhất: lấy chính con số của họ làm chuẩn.
 * @param {string} hhmmss ví dụ "00:57:58"
 */
export function offsetFromSiteCountdown(hhmmss, kickoffEpoch, serverNowMs) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(hhmmss || '').trim());
  if (!m) return null;
  const remainingMs = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
  const releaseEpoch = serverNowMs + remainingMs;
  return {
    releaseEpoch,
    offsetMin: (kickoffEpoch - releaseEpoch) / 60000,
    remainingMs,
  };
}

export function sortByKickoff(matches) {
  return [...matches].sort((x, y) => releaseTime(x) - releaseTime(y));
}

/** Trận sắp tới gần nhất còn trong tầm bắn (chưa qua quá 2 phút). */
export function nextMatch(matches, serverNowMs) {
  return sortByKickoff(matches).find((m) => releaseTime(m) > serverNowMs - 120000) || null;
}
