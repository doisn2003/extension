/**
 * Một chỗ duy nhất để gọi mạng — mọi request đều được bấm giờ, phân loại và
 * ghi vào hộp đen. Không có đường tắt nào khác, nên không có request nào lọt
 * khỏi log.
 *
 * Burst engine ở Phase 3 dùng chung đúng hàm này, nhờ vậy dữ liệu đo trong lúc
 * kiểm tra thủ công và dữ liệu đo trong trận thật so sánh được với nhau.
 */

import { logAttempt } from './blackbox.js';
import { classify, rateLimitFrom } from './classify.js';

/** Chỉ giữ các header có ích — phần còn lại chỉ làm phình hộp đen. */
const KEEP_HEADERS = [
  'date',
  'content-type',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
  'cf-ray',
  'cf-cache-status',
  'server',
];

function pickHeaders(headers) {
  const out = {};
  for (const name of KEEP_HEADERS) {
    const v = headers.get(name);
    if (v != null) out[name] = v;
  }
  return out;
}

/**
 * fetch có bấm giờ, không bao giờ ném lỗi — lỗi mạng trả về status 0.
 * Trong lúc burst, một exception làm vỡ vòng lặp còn tệ hơn một request hỏng.
 */
export async function timedFetch(url, init = {}) {
  const tSent = Date.now();
  try {
    const res = await fetch(url, init);
    const tFirstByte = Date.now();
    const body = await res.text();
    const tDone = Date.now();
    return {
      ok: res.ok,
      status: res.status,
      headers: pickHeaders(res.headers),
      body,
      // Địa chỉ CUỐI sau redirect. Các nhà cái xoay đuôi tên miền (đã thấy
      // tx88.games → tx88.rest), domain cũ vẫn redirect chứ không chết — nên
      // trường này là cách rẻ nhất để phát hiện site đã dời nhà.
      url: res.url,
      tSent,
      tFirstByte,
      tDone,
      latencyMs: tFirstByte - tSent,
      error: null,
    };
  } catch (err) {
    const tDone = Date.now();
    return {
      ok: false,
      status: 0,
      headers: {},
      body: '',
      url: null,
      tSent,
      tFirstByte: null,
      tDone,
      latencyMs: tDone - tSent,
      error: String(err?.message || err),
    };
  }
}

/**
 * Gọi mạng + phân loại + ghi hộp đen trong một bước.
 *
 * @param {object} o
 * @param {string} o.url
 * @param {object} [o.init]      tuỳ chọn cho fetch
 * @param {string} o.brand       thương hiệu site, để quy kết số liệu
 * @param {string} o.phase       probe | prewarm | burst | tail
 * @param {string} [o.runId]     id của trận, để gộp log theo trận
 * @param {Map}    [o.dictionary] từ điển đã nạp sẵn (tránh đọc IndexedDB mỗi lần bắn)
 * @param {number} [o.offsetUsed] offset đồng hồ đã dùng, để soi lại sau trận
 */
export async function request({ url, init = {}, brand, phase, runId = null, dictionary = null, offsetUsed = null }) {
  const res = await timedFetch(url, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
  });

  const verdict = classify({ status: res.status, body: res.body, headers: res.headers }, dictionary, phase);
  const rate = rateLimitFrom(res.headers);

  const logged = await logAttempt({
    brand,
    phase,
    runId,
    // Gieo nhãn heuristic vào từ điển cho chữ ký mới, để bạn chỉ phải xác nhận.
    label: verdict.label,
    method: init.method || 'GET',
    url,
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    body: res.body,
    tSent: res.tSent,
    tFirstByte: res.tFirstByte,
    tDone: res.tDone,
    latencyMs: res.latencyMs,
    offsetUsed,
    error: res.error,
  });

  return { ...res, ...verdict, rate, attemptId: logged.id, isNewSignature: logged.isNew };
}

/** Nạp từ điển thành Map để tra cứu nhanh trong vòng lặp burst. */
export async function loadDictionary() {
  const { listDictionary } = await import('./blackbox.js');
  const rows = await listDictionary();
  return new Map(rows.map((r) => [r.sig, r]));
}
