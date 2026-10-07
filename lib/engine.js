/**
 * Engine bắn code — Phase 3.
 *
 * Nguyên tắc chi phối mọi thứ ở đây: **GET là cuộc đua**. Toàn bộ hạn mức
 * request đổ vào GET nhận code; POST đổi thưởng có 30 phút nên bị cấm tuyệt đối
 * không được chiếm slot trong cửa sổ burst, nó xếp hàng chạy sau và chỉ chạm
 * vào những site đã thắng.
 *
 * Mọi mốc thời gian tính theo **giờ server đã hiệu chỉnh**, không theo đồng hồ
 * máy. Đo thực tế cho thấy máy chậm hơn server ~2,3 giây — bắn theo đồng hồ máy
 * là vào trận muộn 2,3 giây, tức thua chắc.
 */

import * as storage from './storage.js';
import * as sites from './sites.js';
import { releaseTime } from './match.js';
import { request, loadDictionary } from './net.js';
import * as hotmatch from './hotmatch.js';
import { saveRun, LABELS } from './blackbox.js';
import { waitUntil, cancelAll } from './scheduler.js';

export const SITE_STATUS = {
  WAITING: 'waiting',
  PREWARM: 'prewarm',
  FIRING: 'firing',
  WON: 'won',
  LOST: 'lost',
  BLOCKED: 'blocked',
  ABORTED: 'aborted',
};

/**
 * Gift code có hiệu lực **10 phút** kể từ lúc nhận.
 *
 * Đo trực tiếp ngày 11/08/2026: co88 ghi `date_received` lúc 15:50:00Z, tới
 * 16:00:04Z thì mã đã hết hạn. Con số 30 phút trước đây là phỏng đoán ban đầu và
 * đã sai — nó khiến đồng hồ đếm ngược báo còn nhiều thời gian hơn thực tế.
 */
export const CODE_TTL_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Chờ tới một mốc theo đồng hồ máy.
 * Dùng scheduler dùng chung — 3 giây cuối nó bỏ setTimeout để không dính cơ chế
 * bóp timer của Chrome khi trang không được vẽ (xem lib/scheduler.js).
 */
async function sleepUntil(localTargetMs, isAborted) {
  const reached = await waitUntil(localTargetMs);
  return reached && !isAborted();
}

const jitter = (ms) => ms + (Math.random() * 2 - 1) * 20;

/**
 * @param {object} o
 * @param {object} o.match          trận từ lib/match.js
 * @param {Array}  o.siteList       các site sẽ tham gia
 * @param {object} o.config         cấu hình chung
 * @param {(site)=>number} o.offsetFor  offset đồng hồ nên dùng cho site đó
 * @param {(event)=>void} o.onEvent  báo tiến trình cho giao diện
 */
export function createRun({ match, siteList, config, offsetFor, onEvent = () => {}, kind = 'claim' }) {
  const runId = `${match.id}#${Date.now()}`;
  let aborted = false;
  let dictionary = null;

  const entries = siteList.map((site) => ({
    brand: site.brand,
    label: sites.displayName(site),
    site,
    offsetMs: offsetFor(site) || 0,
    status: SITE_STATUS.WAITING,
    attempts: 0,
    firstAttemptAt: null,
    lastStatus: null,
    lastLabel: null,
    lastBody: '',
    rate: null,
    code: null,
    wonAt: null,
    error: null,
  }));

  const state = {
    runId,
    match,
    entries,
    phase: 'armed',
    startedAt: null,
    finishedAt: null,
    configSnapshot: structuredClone(config),
  };

  const emit = (type, extra = {}) => onEvent({ type, state, ...extra });
  const isAborted = () => aborted;

  function abort() {
    aborted = true;
    cancelAll();
    for (const e of entries) {
      if (e.status === SITE_STATUS.WAITING || e.status === SITE_STATUS.PREWARM || e.status === SITE_STATUS.FIRING) {
        e.status = SITE_STATUS.ABORTED;
      }
    }
    state.phase = 'aborted';
    emit('abort');
  }

  function cfgFor(entry) {
    return { ...config, ...(entry.site.config || {}) };
  }

  /** Đổi mốc "giờ server" thành mốc trên đồng hồ máy. */
  function toLocal(entry, serverMs) {
    return serverMs - entry.offsetMs;
  }

  // -------------------------------------------------------------- một site

  async function runSite(entry) {
    const cfg = cfgFor(entry);
    // Mốc bắn là thời điểm PHÁT CODE, không phải giờ bóng lăn — code ra trước
    // trận 10 phút. Nhầm chỗ này là bắn muộn nguyên 10 phút.
    const release = releaseTime(match);
    let siteConfigId = match.configBySite?.[entry.brand] || match.configId;
    let url = sites.buildClaimUrl(entry.site, {
      matchName: match.matchName,
      date: match.dateParam,
      uid: entry.site.account?.uid,
      configId: siteConfigId,
    });

    // Hâm nóng bằng chính API danh sách trận thay vì một HEAD trống.
    //
    // Cùng một request nhưng được ba việc: bắt tay TLS + HTTP/2 xong trước
    // (tiết kiệm 100-300ms ở nhịp quyết định), biết trước site này đã nhận code
    // của trận chưa, và biết còn bao nhiêu code. Site nào đã nhận thì khỏi bắn.
    let preflightLatencyMs = 80;
    if (cfg.preflight !== false && await sleepUntil(toLocal(entry, release - 5000), isAborted)) {
      entry.status = SITE_STATUS.PREWARM;
      emit('site', { brand: entry.brand });

      const tPre0 = Date.now();
      const pre = await hotmatch.lookupMatch(entry.site, match.matchName, { dictionary });
      const tPre1 = Date.now();
      preflightLatencyMs = Math.max(20, tPre1 - tPre0);
      entry.latencyMs = preflightLatencyMs;

      if (pre.match) {
        if (pre.match.configId && pre.match.configId !== siteConfigId) {
          siteConfigId = pre.match.configId;
          url = sites.buildClaimUrl(entry.site, {
            matchName: match.matchName,
            date: match.dateParam,
            uid: entry.site.account?.uid,
            configId: siteConfigId,
          });
        }
        entry.preflight = {
          received: pre.match.received,
          remainingCodes: pre.match.remainingCodes,
          totalCodes: pre.match.totalCodes,
        };
        if (pre.match.received) {
          entry.code = pre.match.giftCode || null;
          entry.wonAt = pre.match.giftCode ? Date.now() : null;
          entry.status = pre.match.giftCode ? SITE_STATUS.WON : SITE_STATUS.LOST;
          entry.error = 'Tài khoản đã nhận code của trận này từ trước';
          await persist();
          emit('site', { brand: entry.brand });
          return;
        }
      }
    }

    const shootMode = (cfg.shootMode || 'awm').toLowerCase();

    // =========================================================================
    // 🔫 CHẾ ĐỘ 1: AWM (Bắn từng viên / FIFO Queue Sniper Mode — MẶC ĐỊNH)
    // =========================================================================
    if (shootMode === 'awm') {
      const oneWayFlightMs = Math.round(preflightLatencyMs / 2);
      const safetyBufferMs = Number.isFinite(cfg.safetyBufferMs) ? cfg.safetyBufferMs : 200;
      // TriggerTime = T - offsetMs - (Latency / 2) + SafetyBuffer
      const targetLocal = toLocal(entry, release) - oneWayFlightMs + safetyBufferMs;

      if (!(await sleepUntil(targetLocal, isAborted))) return;

      entry.status = SITE_STATUS.FIRING;
      entry.stateNote = 'Đang xử lý...';
      emit('site', { brand: entry.brand });

      let shot1Done = false;
      let shot1Error = false;

      const handleAwmResponse = async (res) => {
        entry.attempts += 1;
        entry.firstAttemptAt ??= res.tSent;
        entry.lastStatus = res.status;
        entry.lastLabel = res.label;
        entry.lastBody = res.body.slice(0, 300);
        if (res.rate) entry.rate = res.rate;

        switch (res.action) {
          case 'stop-win': {
            const firstWin = !entry.code;
            entry.code = res.code;
            entry.wonAt ??= Date.now();
            entry.status = SITE_STATUS.WON;
            entry.stateNote = null;
            await persist();
            if (firstWin) emit('win', { brand: entry.brand });
            emit('site', { brand: entry.brand });
            return 'win';
          }
          case 'stop-lose':
            entry.status = SITE_STATUS.LOST;
            entry.stateNote = null;
            emit('site', { brand: entry.brand });
            return 'lose';
          case 'stop-alert':
            entry.status = SITE_STATUS.BLOCKED;
            entry.error = res.label;
            entry.stateNote = null;
            emit('site', { brand: entry.brand });
            return 'blocked';
          default:
            if (res.status === 0 || res.status >= 500 || res.action === 'retry-now') {
              shot1Error = true;
            }
            return 'continue';
        }
      };

      // Bắn phát DUY NHẤT #1 và giữ kết nối
      const shot1Promise = request({
        url,
        brand: entry.brand,
        phase: 'awm',
        runId,
        dictionary,
        offsetUsed: entry.offsetMs,
      }).then(async (res) => {
        shot1Done = true;
        const outcome = await handleAwmResponse(res);
        emit('attempt', { brand: entry.brand, res });
        return outcome;
      }).catch((err) => {
        shot1Done = true;
        shot1Error = true;
        entry.error = String(err?.message || err);
      });

      // Lắng nghe phát cứu hộ #2 sau rescueDelay (mặc định 3.8s)
      const rescueDelay = cfg.awmRescueDelayMs || 3800;
      await sleep(rescueDelay);

      // Nếu đã có kết quả hoặc đã huỷ -> kết thúc
      if (aborted || entry.status === SITE_STATUS.WON || entry.status === SITE_STATUS.LOST || entry.status === SITE_STATUS.BLOCKED) {
        return;
      }

      // Chỉ bắn phát cứu hộ #2 nếu phát #1 THỰC SỰ bị rớt mạng (status 0 / 5xx / timeout)
      if (shot1Done && shot1Error && !entry.code) {
        entry.stateNote = '🔄 Bắn cứu hộ #2...';
        emit('site', { brand: entry.brand });

        try {
          const res2 = await request({
            url,
            brand: entry.brand,
            phase: 'awm-rescue',
            runId,
            dictionary,
            offsetUsed: entry.offsetMs,
          });
          await handleAwmResponse(res2);
          emit('attempt', { brand: entry.brand, res: res2 });
        } catch (err) {
          entry.error = String(err?.message || err);
        }
      } else {
        // Server vẫn đang giữ kết nối FIFO xử lý -> tuyệt đối im lặng, chờ tối đa 15s
        await Promise.race([
          shot1Promise,
          sleep(15000),
        ]);
      }

      if (entry.status === SITE_STATUS.FIRING) {
        entry.status = entry.code ? SITE_STATUS.WON : SITE_STATUS.LOST;
        entry.stateNote = null;
      }
      emit('site', { brand: entry.brand });
      return;
    }

    // =========================================================================
    // ⚡ CHẾ ĐỘ 2: SCAR (Bắn liên thanh / Burst Spam Mode — DỰ PHÒNG)
    // =========================================================================
    // Bắn sớm hơn giờ bóng lăn đúng leadMs, để request *đến nơi* khi cổng mở.
    if (!(await sleepUntil(toLocal(entry, release - cfg.leadMs), isAborted))) return;

    entry.status = SITE_STATUS.FIRING;
    const denseUntilLocal = toLocal(entry, release + cfg.denseWindowMs);
    const deadlineLocal = toLocal(entry, release + cfg.tailWindowMs);

    let inFlight = 0;
    let issued = 0;
    let stop = false;
    let backoffUntil = 0;
    let immediateRetry = false;
    let repeatedSig = null;
    let repeatedCount = 0;

    const fire = async () => {
      inFlight += 1;
      issued += 1;
      try {
        const res = await request({
          url, brand: entry.brand, phase: Date.now() < denseUntilLocal ? 'burst' : 'tail',
          runId, dictionary, offsetUsed: entry.offsetMs,
        });

        entry.attempts += 1;
        entry.firstAttemptAt ??= res.tSent;
        entry.lastStatus = res.status;
        entry.lastLabel = res.label;
        entry.lastBody = res.body.slice(0, 300);
        if (res.rate) entry.rate = res.rate;

        switch (res.action) {
          case 'stop-win': {
            // Các request đang bay tiếp tục trả về cùng mã đó dưới dạng
            // "User already received" — chỉ ghi nhận lần đầu, khỏi rối nhật ký.
            const firstWin = !entry.code;
            entry.code = res.code;
            entry.wonAt ??= Date.now();
            entry.status = SITE_STATUS.WON;
            stop = true;
            // Ghi bền NGAY, trước cả khi vẽ lên màn hình: cái quý nhất vừa
            // giành được không được phép mất vì trình duyệt sập.
            await persist();
            if (firstWin) emit('win', { brand: entry.brand });
            break;
          }
          case 'stop-lose':
            entry.status = SITE_STATUS.LOST;
            stop = true;
            break;
          case 'stop-alert':
            entry.status = SITE_STATUS.BLOCKED;
            entry.error = res.label;
            stop = true;
            break;
          case 'backoff': {
            const resetLocal = res.rate?.resetAt ? toLocal(entry, res.rate.resetAt) : 0;
            backoffUntil = Math.max(Date.now() + 1500, resetLocal);
            break;
          }
          case 'retry-now':
            // Lỗi quá tải tạm thời — đây chính là "Có lỗi xảy ra, thử lại sau".
            // Không chờ, bắn lại ngay.
            immediateRetry = true;
            break;
          default:
            break;
        }

        // Mã 4xx lạ lặp lại y hệt nhiều lần: gần như chắc chắn là kết cục cuối
        // cùng (hết code / đã nhận rồi) chứ không phải trục trặc tạm thời.
        const unknown4xx = res.status >= 400 && res.status < 500 && res.label === LABELS.UNKNOWN;
        if (unknown4xx) {
          repeatedCount = res.sig === repeatedSig ? repeatedCount + 1 : 1;
          repeatedSig = res.sig;
          if (!stop && repeatedCount >= (cfg.stopAfterRepeatedUnknown || Infinity)) {
            entry.status = SITE_STATUS.LOST;
            entry.error = `Dừng sau ${repeatedCount} lần cùng một phản hồi ${res.status} chưa rõ nghĩa — hãy chốt nhãn cho nó ở tab Hộp đen`;
            stop = true;
          }
        } else {
          repeatedSig = null;
          repeatedCount = 0;
        }

        emit('attempt', { brand: entry.brand, res });
      } finally {
        inFlight -= 1;
      }
    };

    // Phát đầu tiên đi trước mọi việc phụ. Báo trạng thái cho giao diện là việc
    // rẻ, nhưng nhân với 15 site ngay tại nhịp quyết định thì vẫn làm trượt vài
    // chục ms — nên để nó xếp sau khi request đã rời máy.
    fire();
    emit('site', { brand: entry.brand });
    // Vòng lặp bên dưới bắn phát tiếp theo, nên chờ đủ một nhịp để không bắn
    // trùng hai phát cùng lúc.
    if ((cfg.maxAttempts || Infinity) > 1) await sleep(jitter(cfg.intervalMs));

    const maxAttempts = cfg.maxAttempts || Infinity;

    while (!stop && !aborted && Date.now() < deadlineLocal) {
      // Trần cứng: hết đạn thì dừng kể cả khi còn thời gian. Request sau vài giây
      // đầu gần như vô giá trị, nhưng vẫn tiêu hạn mức và vẫn để lại dấu vết.
      if (issued >= maxAttempts) break;
      if (Date.now() < backoffUntil) {
        await sleep(Math.min(200, backoffUntil - Date.now()));
        continue;
      }
      if (inFlight >= cfg.concurrency) {
        await sleep(10);
        continue;
      }

      fire();

      if (immediateRetry) {
        immediateRetry = false;
        await sleep(5);
        continue;
      }
      const dense = Date.now() < denseUntilLocal;
      await sleep(jitter(dense ? cfg.intervalMs : cfg.tailIntervalMs));
    }

    // Chờ các request còn đang bay, biết đâu một trong số đó thắng.
    // (Không đặt tên biến là `waitUntil` — trùng tên hàm nhập từ scheduler.js.)
    const drainDeadline = Date.now() + 5000;
    while (inFlight > 0 && Date.now() < drainDeadline) await sleep(50);

    if (entry.status === SITE_STATUS.FIRING) entry.status = SITE_STATUS.LOST;
    emit('site', { brand: entry.brand });
  }

  /**
   * Lưới an toàn sau burst.
   *
   * Có thể request nhận code đã thành công nhưng tool không đọc ra được mã từ
   * phản hồi (hình dạng lạ, mạng đứt giữa chừng, tab bị đóng). API danh sách
   * trận biết chắc: `received` và `gift_code`. Một request mỗi site, sau khi
   * cuộc đua đã xong nên không tranh chấp gì.
   */
  async function recoverMissedCodes() {
    if (config.verifyAfter === false) return;
    const missed = entries.filter((e) => !e.code && e.attempts > 0 && e.status !== SITE_STATUS.BLOCKED);
    if (!missed.length) return;

    state.phase = 'verify';
    emit('phase');

    for (const entry of missed) {
      if (aborted) break;
      const res = await hotmatch.lookupMatch(entry.site, match.matchName, { dictionary });
      if (res.match?.received && res.match.giftCode) {
        entry.code = res.match.giftCode;
        entry.wonAt = Date.now();
        entry.status = SITE_STATUS.WON;
        entry.error = 'Cứu lại từ API danh sách trận — request nhận code đã thành công nhưng không đọc được mã';
        await persist();
        emit('win', { brand: entry.brand });
      } else if (res.match) {
        entry.remainingCodes = res.match.remainingCodes;
      }
      await sleep(150);
    }
  }

  // ---------------------------------------------------------------- lưu trữ

  function serialize() {
    return {
      id: runId,
      kind,
      ts: state.startedAt || Date.now(),
      matchName: match.matchName,
      matchId: match.id,
      kickoffEpoch: match.kickoffEpoch,
      releaseEpoch: releaseTime(match),
      releaseOffsetMin: match.releaseOffsetMin ?? null,
      dateParam: match.dateParam,
      phase: state.phase,
      configSnapshot: state.configSnapshot,
      results: Object.fromEntries(entries.map((e) => [e.brand, {
        brand: e.brand,
        label: e.label,
        status: e.status,
        stateNote: e.stateNote || null,
        latencyMs: e.latencyMs || null,
        attempts: e.attempts,
        firstAttemptAt: e.firstAttemptAt,
        code: e.code,
        wonAt: e.wonAt,
        lastLabel: e.lastLabel,
        lastStatus: e.lastStatus,
        lastBody: e.lastBody,
        offsetMs: e.offsetMs,
        error: e.error,
      }])),
    };
  }

  async function persist() {
    const record = serialize();
    const runs = await storage.get('runs');
    const idx = runs.findIndex((r) => r.id === runId);
    if (idx >= 0) runs[idx] = record;
    else runs.unshift(record);
    await storage.set('runs', runs.slice(0, 50));
    return record;
  }

  // ------------------------------------------------------------------ chạy

  async function start() {
    dictionary = await loadDictionary();
    state.startedAt = Date.now();
    state.phase = 'running';
    emit('phase');

    await Promise.all(entries.map((e) => runSite(e).catch((err) => {
      e.status = SITE_STATUS.BLOCKED;
      e.error = String(err?.message || err);
    })));

    state.phase = 'burst-done';
    emit('phase');
    await persist();

    await recoverMissedCodes();
    // Không có bước đổi thưởng. Engine chỉ nhận code rồi dừng — xem
    // docs/KNOWLEDGE.md, mục `setCookiesBarrier`.

    state.phase = 'done';
    state.finishedAt = Date.now();
    const record = await persist();
    await saveRun(record);
    emit('done');
    return record;
  }

  return { runId, state, start, abort, persist, serialize };
}

/** Thời gian còn lại của một code trước khi hết hạn đổi thưởng. */
export function codeRemainingMs(wonAt, now = Date.now()) {
  return wonAt ? wonAt + CODE_TTL_MS - now : 0;
}
