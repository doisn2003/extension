/**
 * Đồng bộ đồng hồ với từng site.
 *
 * Header `Date` chỉ có độ phân giải giây, nên một mẫu đơn lẻ chỉ cho biết offset
 * nằm đâu đó trong một khoảng rộng 1 giây. Cách thu hẹp: mỗi mẫu cho một khoảng,
 * rồi **giao** các khoảng lại.
 *
 *   serverTrue ∈ [D, D + 1000)      D = giá trị header Date
 *   localTrue  ∈ [t0, t1]           thời điểm server đóng dấu nằm giữa lúc gửi và lúc nhận
 *   offset = serverTrue - localTrue ∈ [D - t1, D + 1000 - t0]
 *
 * Giao ~8 mẫu rải qua ranh giới giây sẽ thu sai số xuống còn vài chục ms.
 * Đây là chặn đúng theo nghĩa toán học, không phải ước lượng trung bình — nên
 * bề rộng khoảng cuối cùng chính là sai số tối đa, dùng làm độ tin cậy luôn.
 */

// Giãn đủ rộng để 12 mẫu cắt qua nhiều ranh giới giây khác nhau — đó là thứ
// làm hẹp khoảng giao, chứ không phải số mẫu đơn thuần.
const SAMPLE_GAP_MS = 220;

async function probe(url, signal) {
  // HEAD là đủ và rẻ nhất. no-store buộc CDN xác thực lại để Date không phải đồ cũ trong cache.
  const init = { method: 'HEAD', cache: 'no-store', credentials: 'omit', redirect: 'follow', signal };
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    // Vài server chặn HEAD — thử GET rồi vứt body ngay.
    res = await fetch(url, { ...init, method: 'GET' });
    res.body?.cancel().catch(() => {});
  }
  return res;
}

/**
 * @param {string} origin ví dụ "https://tip88.fyi"
 * @returns {Promise<{offsetMs:number, uncertaintyMs:number, ok:boolean, samples:number, at:number, error?:string}>}
 */
export async function measureOffset(origin, { samples = 12, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let lo = -Infinity;
  let hi = Infinity;
  let used = 0;
  let rejected = 0;
  let lastError = null;

  try {
    for (let i = 0; i < samples; i++) {
      const t0 = Date.now();
      let res;
      try {
        res = await probe(origin + '/', controller.signal);
      } catch (err) {
        lastError = String(err?.message || err);
        continue;
      }
      const t1 = Date.now();

      const header = res.headers.get('date');
      if (!header) {
        lastError = 'Không có header Date';
        continue;
      }
      const D = Date.parse(header);
      if (!Number.isFinite(D)) {
        lastError = 'Header Date không đọc được';
        continue;
      }

      const sLo = D - t1;
      const sHi = D + 1000 - t0;
      const nextLo = Math.max(lo, sLo);
      const nextHi = Math.min(hi, sHi);

      if (nextLo <= nextHi) {
        lo = nextLo;
        hi = nextHi;
        used += 1;
      } else {
        // Khoảng mới không giao với khoảng đang có: đồng hồ máy vừa nhảy, hoặc
        // gặp response từ cache. Bỏ mẫu, giữ nguyên kết quả đang tích luỹ.
        rejected += 1;
      }

      if (i < samples - 1) await new Promise((r) => setTimeout(r, SAMPLE_GAP_MS));
    }
  } finally {
    clearTimeout(timer);
  }

  if (!used) {
    return { ok: false, offsetMs: 0, uncertaintyMs: Infinity, samples: 0, rejected, at: Date.now(), error: lastError || 'Không lấy được mẫu nào' };
  }

  return {
    ok: true,
    offsetMs: Math.round((lo + hi) / 2),
    uncertaintyMs: Math.round((hi - lo) / 2),
    samples: used,
    rejected,
    at: Date.now(),
  };
}

/** Giờ server ước lượng, tính từ đồng hồ máy cộng offset đã đo. */
export function serverNow(clock, now = Date.now()) {
  return now + (clock?.ok ? clock.offsetMs : 0);
}

/** Offset cũ quá thì không nên tin — đồng hồ máy trôi, và server có thể đã đổi edge. */
export function isFresh(clock, maxAgeMs) {
  return !!clock?.ok && Date.now() - clock.at < maxAgeMs;
}

/** Xếp hạng chất lượng để tô màu trên dashboard. */
export function quality(clock) {
  if (!clock?.ok) return 'none';
  if (clock.uncertaintyMs <= 80) return 'good';
  if (clock.uncertaintyMs <= 250) return 'fair';
  return 'poor';
}

export function toInterval(clock) {
  if (!clock?.ok || !Number.isFinite(clock.uncertaintyMs)) return null;
  return [clock.offsetMs - clock.uncertaintyMs, clock.offsetMs + clock.uncertaintyMs];
}

/**
 * Gộp phép đo của nhiều site thành một con số chung.
 *
 * Đo thực tế trên 15 site cho ra offset +2.21s..+2.38s — mười lăm hạ tầng độc
 * lập không thể cùng lệch một lượng như nhau, nên đại lượng đang đo chính là
 * **sai số đồng hồ máy bạn**, và mỗi site là một phép đo độc lập của cùng một
 * đại lượng đó. Giao 15 khoảng lại thu sai số xuống thấp hơn hẳn site tốt nhất.
 *
 * Không giao thẳng tất cả: một site lệch thật sẽ làm rỗng giao. Thay vào đó tìm
 * điểm được nhiều khoảng phủ nhất rồi chỉ giao nhóm đó, phần còn lại báo là lệch.
 *
 * @param {Array<{key:string, clock:object}>} entries
 */
export function consensus(entries) {
  const items = [];
  for (const e of entries) {
    const iv = toInterval(e.clock);
    if (iv) items.push({ key: e.key, lo: iv[0], hi: iv[1] });
  }
  if (!items.length) return null;

  // Độ phủ lớn nhất của một tập khoảng luôn đạt tại mút trái của một khoảng nào đó.
  let best = null;
  for (const candidate of items) {
    const covering = items.filter((it) => it.lo <= candidate.lo && candidate.lo <= it.hi);
    if (!best || covering.length > best.length) best = covering;
  }

  const lo = Math.max(...best.map((i) => i.lo));
  const hi = Math.min(...best.map((i) => i.hi));
  const agreeKeys = new Set(best.map((i) => i.key));

  return {
    ok: true,
    offsetMs: Math.round((lo + hi) / 2),
    uncertaintyMs: Math.round((hi - lo) / 2),
    agree: best.length,
    total: items.length,
    outliers: items.filter((i) => !agreeKeys.has(i.key)).map((i) => i.key),
    at: Date.now(),
    samples: best.length,
  };
}

/**
 * Offset nên dùng khi bắn cho một site.
 * Ưu tiên đồng thuận vì nó hẹp hơn nhiều; site nào lệch khỏi đồng thuận thì
 * dùng phép đo riêng của chính nó.
 */
export function effectiveClock(site, cons) {
  const own = site?.clock;
  if (cons?.ok && !cons.outliers.includes(site?.brand)) {
    if (!own?.ok || cons.uncertaintyMs < own.uncertaintyMs) return { ...cons, source: 'consensus' };
  }
  return own?.ok ? { ...own, source: 'site' } : cons?.ok ? { ...cons, source: 'consensus' } : null;
}
