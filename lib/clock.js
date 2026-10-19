/**
 * HTTP Date chỉ chính xác tới giây và chưa chứng minh cùng đồng hồ backend cấp mã.
 * Mỗi mẫu mới cùng nguồn cho offset ∈ [D-t1, D+1000-t0]. t0/t1 dùng trục đơn điệu.
 * Khoảng báo cáo có điều kiện vào nguồn timestamp, không phải bảo đảm tuyệt đối.
 */
import { contextId, monoNow, stableNow, wallShift } from './timebase.js';
const SAMPLE_GAP_MS = 220;
export const DRIFT_RATE = 100 / 1_000_000;

/** Tập được n-f mẫu hỗ trợ; không để mẫu đầu quyết định các mẫu được giữ. */
export function supportedInterval(intervals, faults = 1) {
  const required = intervals.length - faults;
  if (!intervals.length || required <= intervals.length / 2) return null;
  const points = [...new Set(intervals.flat())].sort((a, b) => a - b);
  const covered = (x) => intervals.filter(([lo, hi]) => lo <= x && x <= hi).length >= required;
  const parts = [];
  for (let i = 0; i < points.length; i++) {
    if (covered(points[i])) parts.push([points[i], points[i]]);
    if (i + 1 < points.length && covered((points[i] + points[i + 1]) / 2)) parts.push([points[i], points[i + 1]]);
  }
  const merged = [];
  for (const [lo, hi] of parts) {
    const last = merged.at(-1);
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged.length === 1 ? merged[0] : null;
}

/** url là API đọc trạng thái; tuyệt đối không truyền URL nhận code vào phép đo. */
export async function measureOffset(origin, { samples = 12, timeoutMs = 8000, url = null, fallbackUrl = null, signal } = {}) {
  samples = Math.max(6, Math.min(20, Math.floor(samples) || 8));
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  const records = [];
  let error = null, sourceKey = null, rejected = 0;
  const startedMono = monoNow();
  try {
    for (let i = 0; i < samples && !controller.signal.aborted; i++) {
      const t0 = stableNow();
      try {
        const init = { method: url ? 'GET' : 'HEAD', cache: 'no-store', credentials: url ? 'include' : 'omit', signal: controller.signal };
        let res = await fetch(url || origin + '/', init);
        // Chỉ chọn endpoint thay thế trước mẫu đầu; không trộn giờ từ hai đường API.
        if (res.status === 404 && url && fallbackUrl && !records.length) {
          res.body?.cancel().catch(() => {});
          url = fallbackUrl;
          fallbackUrl = null;
          res = await fetch(url, init);
        }
        if (!url && (res.status === 405 || res.status === 501)) {
          res.body?.cancel().catch(() => {});
          res = await fetch(origin + '/', { ...init, method: 'GET' });
        }
        const t1 = stableNow();
        res.body?.cancel().catch(() => {});
        const finalUrl = new URL(res.url || url || origin + '/');
        const key = finalUrl.origin + finalUrl.pathname; // không lưu query/uid
        const date = Date.parse(res.headers.get('date'));
        const cache = res.headers.get('cf-cache-status') || res.headers.get('x-cache') || '';
        const age = Number(res.headers.get('age') || 0);
        const contentType = res.headers.get('content-type') || '';
        const movedPath = url && finalUrl.pathname.replace(/\/$/, '') !== new URL(url).pathname.replace(/\/$/, '');
        if (movedPath || (url && contentType && !/json/i.test(contentType))) {
          rejected++; error = 'API đo giờ chuyển sang trang khác hoặc trả nội dung không phải JSON'; records.length = 0; break;
        }
        if ([401, 403, 404, 429].includes(res.status)) { rejected++; error = `API đo giờ trả HTTP ${res.status}`; break; }
        if (!res.ok || finalUrl.origin !== new URL(origin).origin || !Number.isFinite(date) || age > 0 || /HIT|STALE|UPDATING/i.test(cache)) {
          rejected++; error = 'Mẫu lỗi, cache hoặc chuyển nguồn'; continue;
        }
        if (sourceKey && sourceKey !== key) { error = 'Nguồn giờ thay đổi trong lúc đo'; records.length = 0; break; }
        sourceKey = key;
        records.push({ t0, t1, date, lo: date - t1, hi: date + 1000 - t0, rttMs: t1 - t0 });
      } catch (err) { rejected++; error = String(err?.message || err); }
      if (i < samples - 1 && !controller.signal.aborted) await new Promise((r) => setTimeout(r, SAMPLE_GAP_MS));
    }
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  const bounds = supportedInterval(records.map((r) => [r.lo, r.hi]), 1);
  const common = { at: Date.now(), samples: records.length, rejected, source: url ? 'api-date' : 'homepage-date', sourceKey,
    wallShiftMs: wallShift(), measurements: records };
  if (controller.signal.aborted || records.length < 6 || new Set(records.map((r) => r.date)).size < 2 || !bounds) {
    return { ...common, ok: false, offsetMs: 0, uncertaintyMs: null, error: error || 'Không đủ mẫu giờ nhất quán; hãy đo lại' };
  }
  const atMono = monoNow();
  const serverEpochMs = stableNow() + (bounds[0] + bounds[1]) / 2;
  const uncertaintyMs = Math.ceil((bounds[1] - bounds[0]) / 2 + (atMono - startedMono) * DRIFT_RATE);
  return { ...common, ok: true, offsetMs: Math.round(serverEpochMs - Date.now()), uncertaintyMs,
    anchor: { contextId, monoMs: atMono, serverEpochMs }, faultBudget: 1 };
}

export function hasAnchor(clock) {
  const a = clock?.anchor;
  return !!clock?.ok && a?.contextId === contextId && Number.isFinite(a.monoMs) && Number.isFinite(a.serverEpochMs) &&
    Number.isFinite(clock.uncertaintyMs) && clock.uncertaintyMs >= 0;
}
export function serverNow(clock, now) {
  if (now !== undefined) return now + (clock?.ok ? clock.offsetMs : 0);
  return hasAnchor(clock) ? clock.anchor.serverEpochMs + monoNow() - clock.anchor.monoMs : Date.now() + (clock?.ok ? clock.offsetMs : 0);
}
export function isFresh(clock, maxAgeMs = 60000) {
  const age = hasAnchor(clock) ? monoNow() - clock.anchor.monoMs : Infinity;
  return age >= 0 && age <= maxAgeMs;
}
export function uncertaintyNow(clock) {
  return clock.uncertaintyMs + Math.max(0, monoNow() - clock.anchor.monoMs) * DRIFT_RATE;
}
export function serverToMono(clock, epoch) {
  if (!hasAnchor(clock)) throw new Error('Đồng hồ chưa được đo trong phiên hiện tại');
  return clock.anchor.monoMs + epoch - clock.anchor.serverEpochMs;
}
/** Cận dưới giờ server phải qua T+buffer; không giả định RTT/2 là thời gian đi một chiều. */
export function safeSendDeadline(clock, release, bufferMs = 200) {
  const nominal = serverToMono(clock, release + bufferMs + clock.uncertaintyMs);
  const age = Math.max(0, nominal - clock.anchor.monoMs);
  return nominal + age * DRIFT_RATE / (1 - DRIFT_RATE);
}
export function quality(clock) {
  if (!clock?.ok) return 'none';
  return clock.uncertaintyMs <= 80 ? 'good' : clock.uncertaintyMs <= 250 ? 'fair' : 'poor';
}
export function toInterval(clock) {
  if (!clock?.ok || !Number.isFinite(clock.uncertaintyMs)) return null;
  const offset = hasAnchor(clock) ? serverNow(clock) - Date.now() : clock.offsetMs;
  const uncertainty = hasAnchor(clock) ? uncertaintyNow(clock) : clock.uncertaintyMs;
  return [offset - uncertainty, offset + uncertainty];
}
/** Chỉ để đối chiếu/hiển thị, không dùng để lập lịch cho một nguồn khác. */
export function consensus(entries) {
  const items = entries.flatMap((e) => { const iv = toInterval(e.clock); return iv ? [{ key: e.key, lo: iv[0], hi: iv[1], at: e.clock.at }] : []; });
  if (!items.length) return null;
  let best = [];
  for (const candidate of items) {
    const covering = items.filter((it) => it.lo <= candidate.lo && candidate.lo <= it.hi);
    if (covering.length > best.length) best = covering;
  }
  const lo = Math.max(...best.map((i) => i.lo)), hi = Math.min(...best.map((i) => i.hi));
  const keys = new Set(best.map((i) => i.key));
  return { ok: true, offsetMs: Math.round((lo + hi) / 2), uncertaintyMs: Math.ceil((hi - lo) / 2), agree: best.length,
    total: items.length, outliers: items.filter((i) => !keys.has(i.key)).map((i) => i.key),
    at: Math.min(...best.map((i) => i.at || 0)), samples: best.length };
}
export function effectiveClock(site) {
  return site?.clock?.ok ? { ...site.clock, source: site.clock.source || 'site' } : null;
}
