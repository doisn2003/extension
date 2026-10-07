/**
 * API "Dự đoán tỉ số" — `/api/v1/prediction/*`.
 *
 * Tri thức nền nằm ở `vk88-prediction-api.md`. Ba điều quyết định thiết kế của
 * file này, đều đã đo trực tiếp trên 3 site (17/08/2026):
 *
 * 1. **UUID trận là CHUNG cho cả 15 site.** Gọi `ongoing` một lần ở bất kỳ site
 *    nào là có danh sách dùng được ở mọi nơi. Không cần quét 15 site để lấy trận.
 * 2. **`uid` và `siteId` thì RIÊNG từng site.** Cùng username `minh003` nhưng là
 *    15 tài khoản độc lập (uid khác nhau hoàn toàn). Gửi uid của site này kèm
 *    cookie của site kia là một request tự mâu thuẫn.
 * 3. **Mỗi POST trừ đúng 1 lượt, không hoàn tác, không có idempotency key.**
 *    Vì vậy ở đây **không có retry**, và mọi lời gọi POST đều đi qua một cổng
 *    duy nhất có kiểm tra trước.
 *
 * Cố tình KHÔNG dùng `net.js#request`: hàm đó phân loại phản hồi theo từ điển
 * của luồng gift code rồi ghi vào hộp đen. Phản hồi dự đoán có hình dạng khác
 * hẳn, nhét vào đó chỉ làm bẩn từ điển nhãn. Dùng `timedFetch` — vẫn bấm giờ,
 * vẫn không bao giờ ném lỗi.
 */

import { timedFetch } from './net.js';

const api = (domain, path) => `https://${domain}/api/v1/${path}`;

// ------------------------------------------------------------------ phản hồi

/**
 * Bóc vỏ `{code, status, message, data}`.
 *
 * **Cạm bẫy đã đo được, hai lần:** server trả `code: 200` **và** HTTP 200 kể cả
 * khi lỗi. Chỉ khác là `data` biến mất. Bắt được nguyên văn khi hết lượt:
 *
 *     HTTP 200  {"code":200,"status":"OUT_OF_TURNS","error_key":"OUT_OF_TURNS",
 *                "message":"Bạn đã hết lượt dự đoán!"}
 *
 * Nên điều kiện thành công là **`data` tồn tại**, không phải `res.ok` hay
 * `code === 200`. Tin vào `code` là ghi nhận một POST hỏng thành công.
 *
 * `error_key` là mã máy đọc được (`OUT_OF_TURNS`), đáng tin hơn `message` tiếng
 * Việt — dùng nó để xử lý theo trường hợp thay vì so chuỗi.
 */
export function unwrap(res) {
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    return {
      ok: false,
      data: null,
      message: res.error || `Phản hồi không phải JSON (HTTP ${res.status})`,
      status: res.status,
      errorKey: null,
      raw: res,
    };
  }

  const ok = json?.data != null;
  return {
    ok,
    data: ok ? json.data : null,
    message: json?.message || (ok ? '' : `HTTP ${res.status}`),
    status: res.status,
    // `status` trong body là enum của server (`OK` / `OUT_OF_TURNS`), khác hẳn
    // HTTP status. Giữ cả hai, đừng gộp.
    errorKey: json?.error_key || (json?.status && json.status !== 'OK' ? json.status : null),
    raw: res,
  };
}

/** Hết lượt — biết chắc sổ lượt bằng 0, không cần hỏi lại server. */
export const OUT_OF_TURNS = 'OUT_OF_TURNS';

// ------------------------------------------------------------------- siteId

/**
 * `siteId` (`s1-6170`) — **không suy ra được từ domain hay cookie**, bắt buộc phải đọc.
 * `vk88→6170`, `k88→6176`, `tx88→6174` trông có quy luật, nhưng `bu88→0592`,
 * `net88→3423` thì không. Đoán là sai.
 *
 * Nuxt inline `__NUXT__` vào HTML server-render của trang chủ, nên chỉ cần
 * `fetch` trang chủ rồi regex — không cần content script, không cần chạy JS.
 * Đọc được **cả khi chưa đăng nhập** (đã lấy được siteId của 2 site đang logout),
 * nên bước này không phụ thuộc vào phiên.
 *
 * `credentials: 'omit'` — không việc gì phải gửi cookie cho một lần tải trang chủ.
 * `res.url` trả về địa chỉ cuối sau redirect, dùng để phát hiện site đã xoay domain.
 */
export async function fetchSiteId(domain) {
  const res = await timedFetch(`https://${domain}/`, { credentials: 'omit', cache: 'no-store' });
  if (res.status === 0) return { ok: false, siteId: null, finalDomain: null, error: res.error };
  if (!res.ok) return { ok: false, siteId: null, finalDomain: null, error: `HTTP ${res.status}` };

  const m =
    res.body.match(/S1CHAT_SITE_ID["']?\s*:\s*["'](s\d+-\d+)["']/) ||
    res.body.match(/["'](s\d+-\d{3,6})["']/);

  let finalDomain = null;
  try {
    finalDomain = new URL(res.url || `https://${domain}/`).host;
  } catch {
    finalDomain = null;
  }

  return m
    ? { ok: true, siteId: m[1], finalDomain, error: null }
    : { ok: false, siteId: null, finalDomain, error: 'Không thấy S1CHAT_SITE_ID trong HTML' };
}

// -------------------------------------------------------------------- đọc

/**
 * GET `prediction/matches/ongoing`.
 *
 * `data` **không phải mảng** — nó là vỏ phân trang, mảng nằm ở `data.list`, và
 * `data.remaining_turns` là sổ lượt của **riêng site này**.
 *
 * `uid`/`username` trong query là thứ interceptor của trang tự chèn. Server nhận
 * dạng bằng cookie nên bỏ đi vẫn chạy, nhưng cứ gửi kèm cho giống request thật.
 */
export async function fetchOngoing(site, { page = 1, limit = 20 } = {}) {
  const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
  const acc = site.account;
  if (acc?.username) qs.set('username', acc.username);
  if (acc?.uid != null) qs.set('uid', String(acc.uid));

  const res = await timedFetch(api(site.domain, `prediction/matches/ongoing?${qs}`), {
    credentials: 'include',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });

  const out = unwrap(res);
  if (!out.ok) return { ...out, matches: [], remainingTurns: null };

  return {
    ...out,
    matches: Array.isArray(out.data.list) ? out.data.list : [],
    remainingTurns: typeof out.data.remaining_turns === 'number' ? out.data.remaining_turns : null,
  };
}

/**
 * GET `prediction/matches/{uuid}` — bản chi tiết, lộ thêm luật chơi.
 *
 * Hai thứ đáng giá: `is_locked` (cờ khoá thật, đáng tin hơn `status`) và
 * `most_popular` (nguồn của `predicted_same_count`).
 */
export async function fetchMatch(site, uuid) {
  const res = await timedFetch(api(site.domain, `prediction/matches/${encodeURIComponent(uuid)}`), {
    credentials: 'include',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  return unwrap(res);
}

/**
 * Kiểm một lần mọi thứ cần biết trước khi bắn cả loạt kèo lên một site.
 *
 * Gộp lại thành một GET thay vì kiểm trước từng POST: gửi 5 kèo thì trước đây
 * tốn 5 GET + 5 POST, giờ 1 GET + 5 POST. Trận không tự khoá giữa chừng trong
 * vài trăm mili giây, mà nếu có thì POST cũng chỉ hỏng vô hại.
 *
 * Tiện thể lấy luôn `my_entries` — danh sách tỉ số đã đặt trên chính site này.
 * Đây là thứ chặn được lãng phí thật: server **không** khử trùng lặp (đo trực
 * tiếp — hai POST giống hệt nhau ra hai `entry_id`, trừ 2 lượt), nên gửi lại
 * một tỉ số đã đặt là mất thêm một lượt mà không được gì.
 */
export async function precheckMatch(site, uuid) {
  const res = await fetchMatch(site, uuid);
  if (!res.ok) return { ok: false, message: res.message, daDat: new Set() };

  const d = res.data;
  if (d.is_locked) {
    return { ok: false, message: `Trận đang khoá${d.lock_reason ? ` (${d.lock_reason})` : ''}`, daDat: new Set() };
  }
  if (!isRunning(d)) {
    return { ok: false, message: `Trận không còn nhận dự đoán (${d.status})`, daDat: new Set() };
  }

  return { ok: true, message: '', daDat: sentScores(d), remainingTurns: d.remaining_turns ?? null };
}

/**
 * `status === "RUNNING"` ⟺ đang nhận dự đoán.
 *
 * ⚠️ `WAITING` nghĩa là **"đã đóng, chờ kết quả"** — không phải "sắp mở". Tên gọi
 * của nhà cái dễ gây hiểu ngược.
 */
export const isRunning = (m) => m?.status === 'RUNNING';

/**
 * `predicted_same_count` là **một dự đoán nữa do người chơi tự nhập**: đoán xem
 * sẽ có bao nhiêu người cùng chọn tỉ số này.
 *
 * Không suy ra được, không tính được — chỉ người chơi mới biết mình muốn đặt số
 * mấy. Điều này giải thích dữ liệu từng làm tôi hiểu sai: ba lượt với ba tỉ số
 * khác nhau (1-0, 1-1, 0-0) đều mang **cùng số 40** vì người chơi gõ 40 cả ba
 * lần, chứ không phải vì server tính ra nó.
 *
 * `most_popular` cho **phần trăm** (20.81) — đơn vị khác hẳn, không dùng để điền
 * trường này.
 */

/**
 * Đọc chuỗi kèo dạng `0-0-40, 2-0-40, 3-1-40` thành danh sách dự đoán.
 *
 * Mỗi kèo là ba số: **nhà - khách - số người cùng kèo**. Nhận dấu phẩy, chấm
 * phẩy hoặc xuống dòng giữa các kèo; nhận `-`, `:` hoặc khoảng trắng giữa ba số.
 *
 * Trả về cả `slips` lẫn `errors` thay vì ném lỗi: người dùng gõ 10 kèo mà sai 1
 * thì nên thấy rõ kèo nào sai, chứ không phải mất trắng cả ô nhập.
 */
export function parseSlips(text) {
  const slips = [];
  const errors = [];

  for (const raw of String(text || '').split(/[,;\n]+/)) {
    const item = raw.trim();
    if (!item) continue;

    // Khớp cả chuỗi thay vì tách rồi lọc rỗng: tách kiểu đó thì `1--2-10` bị
    // gộp âm thầm thành `1-2-10` — một kèo người dùng không hề gõ.
    const m = /^(\d+)(?:\s*[-:]\s*|\s+)(\d+)(?:\s*[-:]\s*|\s+)(\d+)$/.exec(item);
    if (!m) {
      errors.push(`"${item}" — cần đúng 3 số nguyên ≥ 0 dạng nhà-khách-cùngkèo`);
      continue;
    }

    slips.push({ home: Number(m[1]), away: Number(m[2]), sameCount: Number(m[3]) });
  }

  return { slips, errors };
}

export const formatSlip = (s) => `${s.home}-${s.away}-${s.sameCount}`;

/**
 * Khoá nhận dạng một kèo **theo tỉ số**.
 *
 * Không tính `sameCount` vào khoá: `my_entries` mà server trả về chỉ có tỉ số,
 * không có số cùng kèo, nên đó là tất cả những gì đối chiếu được.
 */
export const scoreKey = (home, away) => `${Number(home)}-${Number(away)}`;

/** Các tỉ số bị lặp ngay trong ô nhập. Server KHÔNG khử trùng lặp — xem §21. */
export function duplicateScores(slips) {
  const dem = new Map();
  for (const s of slips) {
    const k = scoreKey(s.home, s.away);
    dem.set(k, (dem.get(k) || 0) + 1);
  }
  return [...dem.entries()].filter(([, n]) => n > 1).map(([k, n]) => ({ score: k, count: n }));
}

/** Tỉ số đã đặt trên site này cho trận này, lấy từ `my_entries` của `getMatch`. */
export function sentScores(matchDetail) {
  return new Set((matchDetail?.my_entries || []).map((e) => scoreKey(e.predicted_home, e.predicted_away)));
}

// -------------------------------------------------------------------- ghi

/**
 * Kiểm mọi thứ kiểm được **trước khi** tiêu một lượt.
 *
 * Trả về danh sách lý do không gửi được. Rỗng = đủ điều kiện. Tách khỏi
 * `sendPredict` để giao diện vô hiệu hoá nút và giải thích lý do ngay, thay vì
 * để người dùng bấm rồi mới biết hỏng.
 */
export function validate({ site, uuid, home, away, sameCount }) {
  const loi = [];

  if (!site?.isLogin) loi.push('site chưa đăng nhập');
  if (site?.account?.uid == null) loi.push('chưa đọc được uid từ cookie');
  if (!site?.siteId) loi.push('chưa đọc được siteId');
  if (!uuid) loi.push('chưa chọn trận');
  if (site?.predictionTurns === 0) loi.push('hết lượt');

  for (const [nhan, v] of [['Đội nhà', home], ['Đội khách', away], ['Cùng kèo', sameCount]]) {
    if (v === '' || v == null) loi.push(`thiếu ${nhan}`);
    else if (!Number.isInteger(Number(v)) || Number(v) < 0) loi.push(`${nhan} phải là số nguyên ≥ 0`);
  }

  return loi;
}

/**
 * POST `prediction/predict` — **lệnh ghi duy nhất của tab này**.
 *
 * Mỗi lần gọi thành công trừ đúng 1 lượt và không thể hoàn tác. Ba quy tắc:
 *
 * - **Không retry.** Body không có idempotency key, nên timeout hay 5xx **không**
 *   có nghĩa là lượt chưa bị trừ. Retry mù là cách nhanh nhất đốt sạch sổ lượt.
 *   Lỗi thì dừng, đọc lại `ongoing` để biết thực tế còn bao nhiêu.
 * - **Kiểm `is_locked` trước** (tuỳ chọn `precheck`, mặc định bật). Một GET rẻ
 *   hơn một lượt bị mất vì trận vừa đóng.
 * - **`data != null` mới là thành công**, không phải `code === 200`.
 *
 * `username` gửi lên là dạng trần (`minh003`); `user_name` trong phản hồi có
 * tiền tố site (`76170_minh003`). Hai thứ khác nhau, đừng đối chiếu chéo.
 */
export async function sendPredict(site, { uuid, home, away, sameCount, precheck = true }) {
  const loi = validate({ site, uuid, home, away, sameCount });
  if (loi.length) return { ok: false, sent: false, message: loi.join('; '), data: null };

  if (precheck) {
    const chiTiet = await fetchMatch(site, uuid);
    if (!chiTiet.ok) {
      return { ok: false, sent: false, message: `Không đọc được trận: ${chiTiet.message}`, data: null };
    }
    if (chiTiet.data.is_locked) {
      return {
        ok: false,
        sent: false,
        message: `Trận đang khoá${chiTiet.data.lock_reason ? ` (${chiTiet.data.lock_reason})` : ''}`,
        data: null,
      };
    }
    if (!isRunning(chiTiet.data)) {
      return { ok: false, sent: false, message: `Trận không còn nhận dự đoán (${chiTiet.data.status})`, data: null };
    }
  }

  const body = {
    prediction_id: uuid,
    predicted_home: Number(home),
    predicted_away: Number(away),
    predicted_same_count: Number(sameCount),
    uid: site.account.uid,
    username: site.account.username,
    siteId: site.siteId,
  };

  const res = await timedFetch(api(site.domain, 'prediction/predict'), {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const out = unwrap(res);
  const hetLuot = out.errorKey === OUT_OF_TURNS;

  return {
    ok: out.ok,
    // Đã bay đi rồi — lượt có thể đã bị trừ dù kết quả là gì. Giao diện dùng cờ
    // này để buộc đọc lại sổ lượt thay vì tin vào phép trừ ở phía client.
    // Ngoại lệ duy nhất: hết lượt thì chắc chắn không có gì bị trừ.
    sent: !hetLuot,
    outOfTurns: hetLuot,
    errorKey: out.errorKey,
    message: out.message || (out.ok ? 'Gửi dự đoán thành công' : 'Không rõ kết quả'),
    data: out.data,
    // Hết lượt ⇒ biết chắc bằng 0, khỏi tốn thêm một GET để hỏi lại.
    remainingTurns: hetLuot ? 0
      : typeof out.data?.remaining_turns === 'number' ? out.data.remaining_turns : null,
    request: body,
  };
}
