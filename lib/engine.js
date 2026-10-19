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
import { waitUntilMono, cancelAll } from './scheduler.js';
import { monoNow, wallShift } from './timebase.js';
import { measureOffset, hasAnchor, isFresh, serverNow, serverToMono, safeSendDeadline, uncertaintyNow } from './clock.js';

// Giữ khoá tới khi request thực sự kết thúc, kể cả sau Huỷ/ARM lại.
const pendingClaims = new Set();

export const SITE_STATUS = {
  WAITING: 'waiting',
  PREWARM: 'prewarm',
  FIRING: 'firing',
  RETRY_WAIT: 'retry-wait',
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

const jitter = (ms) => ms + (Math.random() * 2 - 1) * 20;

/**
 * @param {object} o
 * @param {object} o.match          trận từ lib/match.js
 * @param {Array}  o.siteList       các site sẽ tham gia
 * @param {object} o.config         cấu hình chung
 * @param {(site)=>object} o.clockFor đồng hồ riêng có mốc đơn điệu của site
 * @param {(event)=>void} o.onEvent  báo tiến trình cho giao diện
 */
export function createRun({ match, siteList, config, clockFor = (site) => site.clock, onEvent = () => {}, kind = 'claim', services = {} }) {
  const io = { request, loadDictionary, saveRun, lookupMatch: hotmatch.lookupMatch, measureOffset,
    waitUntil: waitUntilMono, sleep, getRuns: () => storage.get('runs'), setRuns: (runs) => storage.set('runs', runs),
    setClock: sites.setClock, ...services };
  const calibrationAbort = new AbortController();
  const armWallShift = wallShift();
  let reportedWallShift = armWallShift;
  async function sleepUntil(target, isCancelled = () => aborted) {
    const reached = await io.waitUntil(target);
    observeWallClock();
    return reached && !isCancelled();
  }
  async function claimOnce(entry, args) {
    if (pendingClaims.has(entry.brand)) throw new Error('Site vẫn còn request nhận code đang chờ');
    pendingClaims.add(entry.brand);
    entry.requestPending = true;
    const send = () => {
      if (aborted) throw new Error('Đã huỷ trước khi gửi request');
      entry.offsetMs = Math.round(serverNow(entry.clock) - Date.now());
      args.offsetUsed = entry.offsetMs;
      if (args.timing) args.timing.wallShiftMs = wallShift();
      entry.attempts++;
      return io.request(args);
    };
    try {
      // Web Locks dùng chung giữa các dashboard của cùng extension/profile.
      if (globalThis.navigator?.locks) {
        return await navigator.locks.request(`hotmatch-claim:${entry.brand}`, { ifAvailable: true }, (lock) => {
          if (!lock) throw new Error('Tab khác vẫn còn request nhận code của site này đang chờ');
          return send();
        });
      }
      return await send();
    }
    finally { entry.requestPending = false; pendingClaims.delete(entry.brand); }
  }
  const runId = `${match.id}#${Date.now()}`;
  let aborted = false;
  let dictionary = null;

  const entries = siteList.map((site) => ({
    brand: site.brand,
    label: sites.displayName(site),
    site,
    clock: structuredClone(clockFor(site) || null),
    offsetMs: 0,
    timing: [],
    requestPending: false,
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
    clockChanges: [],
  };

  const emit = (type, extra = {}) => onEvent({ type, state, ...extra });
  const isAborted = () => aborted;
  function observeWallClock() {
    const shift = wallShift();
    if (Math.abs(shift - reportedWallShift) < 25) return;
    state.clockChanges.push({ at: Date.now(), atMono: monoNow(), deltaMs: shift - reportedWallShift, sinceArmMs: shift - armWallShift });
    reportedWallShift = shift;
    emit('clock-change', { change: state.clockChanges.at(-1) });
  }

  function abort() {
    aborted = true;
    calibrationAbort.abort();
    cancelAll();
    for (const e of entries) {
      if (e.status === SITE_STATUS.WAITING || e.status === SITE_STATUS.PREWARM || e.status === SITE_STATUS.FIRING || e.status === SITE_STATUS.RETRY_WAIT) {
        e.status = SITE_STATUS.ABORTED;
        e.stateNote = e.requestPending ? 'Đã huỷ lịch; request đã gửi vẫn đang chờ phản hồi' : null;
      }
    }
    state.phase = 'aborted';
    emit('abort');
  }

  function cfgFor(entry) {
    return { ...config, ...(entry.site.config || {}) };
  }

  /** Deadline đơn điệu: không đổi khi Windows Sync sau ARM. */
  function toMono(entry, serverMs) { return serverToMono(entry.clock, serverMs); }
  async function refreshClock(entry) {
    const cfg = cfgFor(entry);
    entry.status = SITE_STATUS.PREWARM;
    entry.stateNote = 'Đang đo giờ riêng của site';
    emit('site', { brand: entry.brand });
    const measured = await io.measureOffset(sites.origin(entry.site), {
      samples: cfg.clockSamples, url: hotmatch.buildLeaguesUrl(entry.site), fallbackUrl: hotmatch.buildAlternateLeaguesUrl(entry.site),
      timeoutMs: 8000, signal: calibrationAbort.signal,
    });
    if (aborted) return false;
    if (!hasAnchor(measured) || measured.uncertaintyMs > (cfg.clockMaxUncertaintyMs ?? 500)) {
      throw new Error(measured.error || 'Sai số đồng hồ còn quá lớn; hãy đo lại');
    }
    entry.clock = measured;
    entry.offsetMs = measured.offsetMs;
    await io.setClock(entry.brand, measured);
    entry.stateNote = null;
    emit('clock-ready', { brand: entry.brand });
    return true;
  }

  // -------------------------------------------------------------- một site

  async function runSite(entry) {
    const cfg = cfgFor(entry);
    // Cấu hình cũ từng cho phép 30 phút; không để giá trị đã lưu vô hiệu chặn giờ cũ.
    const maxAge = Math.min(60000, Math.max(0, cfg.clockMaxAgeMs ?? 60000));
    if (!isFresh(entry.clock, maxAge) || entry.clock?.source !== 'api-date') {
      if (!(await refreshClock(entry))) return;
    }
    entry.offsetMs = Math.round(serverNow(entry.clock) - Date.now());
    const refreshAt = toMono(entry, releaseTime(match) - (cfg.clockSyncLeadMs ?? 15000));
    if (kind === 'claim' && refreshAt > monoNow()) {
      entry.status = SITE_STATUS.WAITING;
      if (!(await sleepUntil(refreshAt))) return;
      if (!(await refreshClock(entry))) return;
    }
    if (aborted) return;
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
    let preflightLatencyMs = 0;
    if (cfg.preflight !== false && await sleepUntil(toMono(entry, release - 5000), isAborted)) {
      entry.status = SITE_STATUS.PREWARM;
      emit('site', { brand: entry.brand });

      const tPre0 = monoNow();
      // Preflight phải kết thúc trước cửa sổ bắn; không dùng thời lượng này để bù đường bay.
      const preController = new AbortController();
      const cancelPreflight = () => preController.abort();
      calibrationAbort.signal.addEventListener('abort', cancelPreflight, { once: true });
      const preTimer = setTimeout(cancelPreflight, Math.max(1, Math.min(2500, toMono(entry, release - 1000) - monoNow())));
      let pre;
      try { pre = await io.lookupMatch(entry.site, match.matchName, { dictionary, signal: preController.signal }); }
      finally { clearTimeout(preTimer); calibrationAbort.signal.removeEventListener('abort', cancelPreflight); }
      const tPre1 = monoNow();
      observeWallClock();
      if (aborted) return;
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
    // 🔫 CHẾ ĐỘ 1: AWM (Bắn tuần tự, chỉ thử lại khi bị từ chối ngoài giờ)
    // =========================================================================
    if (shootMode === 'awm') {
      if (!isFresh(entry.clock, maxAge) || uncertaintyNow(entry.clock) > (cfg.clockMaxUncertaintyMs ?? 500)) {
        throw new Error('Đồng hồ đã cũ hoặc sai số quá lớn trước khi bắn');
      }
      const buffer = Math.max(0, Number.isFinite(cfg.safetyBufferMs) ? cfg.safetyBufferMs : 200);
      const firstTarget = safeSendDeadline(entry.clock, release, buffer);
      const retryDeadline = toMono(entry, release + (cfg.awmRetryWindowMs ?? 2000));
      const maxAttempts = kind === 'claim' ? Math.max(1, Math.min(3, cfg.awmMaxAttempts ?? 3, cfg.maxAttempts ?? 3)) : 1;
      let target = firstTarget;
      for (let shot = 1; shot <= maxAttempts && !aborted; shot++) {
        if (!(await sleepUntil(target))) return;
        if (kind === 'claim' && monoNow() > retryDeadline) {
          entry.status = SITE_STATUS.LOST;
          entry.stateNote = null;
          entry.error = 'Đã qua cửa sổ nhận; không gửi request muộn';
          break;
        }
        entry.status = SITE_STATUS.FIRING;
        entry.stateNote = 'Đang chờ phản hồi';
        entry.offsetMs = Math.round(serverNow(entry.clock) - Date.now());
        const timing = { shot, targetMono: target, releaseEpoch: release, uncertaintyMs: uncertaintyNow(entry.clock),
          clockAgeMs: monoNow() - entry.clock.anchor.monoMs, source: entry.clock.sourceKey,
          anchor: entry.clock.anchor, safetyBufferMs: buffer, flightCompensationMs: 0, wallShiftMs: wallShift() };
        const flight = claimOnce(entry, { url, brand: entry.brand, phase: shot === 1 ? 'awm' : 'awm-retry',
          runId, dictionary, offsetUsed: entry.offsetMs, timing });
        emit('site', { brand: entry.brand });
        // Không race timeout/rescue: request trước phải kết thúc mới có thể gửi phát tiếp.
        const res = await flight;
        observeWallClock();
        entry.firstAttemptAt ??= res.tSent;
        entry.firstAttemptMono ??= res.tSentMono;
        entry.lastStatus = res.status;
        entry.lastLabel = res.label;
        entry.lastBody = res.body.slice(0, 300);
        if (res.rate) entry.rate = res.rate;
        entry.timing.push({ ...timing, tSent: res.tSent, tSentMono: res.tSentMono,
          dispatchErrorMs: res.tSentMono - target, tDoneMono: res.tDoneMono, label: res.label });
        entry.stateNote = null;
        if (res.action === 'stop-win') {
          entry.code = res.code;
          entry.wonAt = Date.now();
          entry.status = SITE_STATUS.WON;
          await persist();
          emit('win', { brand: entry.brand });
        } else if (aborted) {
          entry.status = SITE_STATUS.ABORTED;
        } else if (res.action === 'stop-alert' || res.action === 'backoff') {
          entry.status = SITE_STATUS.BLOCKED;
          entry.error = res.label;
        } else {
          const earlyRejection = res.status === 400 && res.label === LABELS.NOT_YET && /TIME_OUT_CODE|outside time window/i.test(res.body);
          target = Math.max(firstTarget + shot * (cfg.awmRetryDelayMs ?? 200), monoNow() + Math.max(50, cfg.awmRetryDelayMs ?? 200));
          if (earlyRejection && shot < maxAttempts && target <= retryDeadline) {
            entry.status = SITE_STATUS.RETRY_WAIT;
            entry.stateNote = 'Bị từ chối ngoài giờ; chờ thử lại';
          } else {
            entry.status = SITE_STATUS.LOST;
            if (!res.status || res.status >= 500) entry.error = 'Chưa rõ backend đã nhận request; chỉ kiểm tra kết quả, không bắn lại';
          }
        }
        emit('attempt', { brand: entry.brand, res });
        if (entry.status !== SITE_STATUS.RETRY_WAIT) break;
      }
      emit('site', { brand: entry.brand });
      return;
    }

    // =========================================================================
    // ⚡ CHẾ ĐỘ 2: SCAR (Bắn liên thanh / Burst Spam Mode — DỰ PHÒNG)
    // =========================================================================
    // Bắn sớm hơn giờ bóng lăn đúng leadMs, để request *đến nơi* khi cổng mở.
    if (!(await sleepUntil(toMono(entry, release - cfg.leadMs), isAborted))) return;

    entry.status = SITE_STATUS.FIRING;
    const denseUntilMono = toMono(entry, release + cfg.denseWindowMs);
    const deadlineMono = toMono(entry, release + cfg.tailWindowMs);

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
        const res = await claimOnce(entry, {
          url, brand: entry.brand, phase: monoNow() < denseUntilMono ? 'burst' : 'tail',
          runId, dictionary, offsetUsed: entry.offsetMs,
        });

        entry.firstAttemptAt ??= res.tSent;
        entry.lastStatus = res.status;
        entry.lastLabel = res.label;
        entry.lastBody = res.body.slice(0, 300);
        if (res.rate) entry.rate = res.rate;

        switch (res.action) {
          case 'stop-win': {
            // Ghi nhận mã ngay khi request duy nhất đang chờ kết thúc.
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
            const resetMono = res.rate?.resetAt ? toMono(entry, res.rate.resetAt) : 0;
            backoffUntil = Math.max(monoNow() + 1500, resetMono);
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
      } catch (err) {
        stop = true;
        entry.status = SITE_STATUS.BLOCKED;
        entry.error = String(err?.message || err);
        emit('site', { brand: entry.brand });
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
    if ((cfg.maxAttempts || Infinity) > 1) await io.sleep(jitter(cfg.intervalMs));

    const maxAttempts = cfg.maxAttempts || Infinity;

    while (!stop && !aborted && monoNow() < deadlineMono) {
      // Trần cứng: hết đạn thì dừng kể cả khi còn thời gian. Request sau vài giây
      // đầu gần như vô giá trị, nhưng vẫn tiêu hạn mức và vẫn để lại dấu vết.
      if (issued >= maxAttempts) break;
      if (monoNow() < backoffUntil) {
        await io.sleep(Math.min(200, backoffUntil - monoNow()));
        continue;
      }
      if (inFlight >= 1) {
        await io.sleep(10);
        continue;
      }

      fire();

      if (immediateRetry) {
        immediateRetry = false;
        await io.sleep(5);
        continue;
      }
      const dense = monoNow() < denseUntilMono;
      await io.sleep(jitter(dense ? cfg.intervalMs : cfg.tailIntervalMs));
    }

    // Chờ các request còn đang bay, biết đâu một trong số đó thắng.
    // (Không đặt tên biến là `waitUntil` — trùng tên hàm nhập từ scheduler.js.)
    while (inFlight > 0) await io.sleep(50);

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
    if (aborted || config.verifyAfter === false) return;
    const missed = entries.filter((e) => !e.code && e.attempts > 0 && e.status !== SITE_STATUS.BLOCKED);
    if (!missed.length) return;

    state.phase = 'verify';
    emit('phase');

    for (const entry of missed) {
      if (aborted) break;
      const res = await io.lookupMatch(entry.site, match.matchName, { dictionary });
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
      await io.sleep(150);
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
      clockChanges: state.clockChanges,
      results: Object.fromEntries(entries.map((e) => [e.brand, {
        brand: e.brand,
        label: e.label,
        status: e.status,
        stateNote: e.stateNote || null,
        requestPending: e.requestPending,
        clock: e.clock,
        timing: e.timing,
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
    const runs = await io.getRuns();
    const idx = runs.findIndex((r) => r.id === runId);
    if (idx >= 0) runs[idx] = record;
    else runs.unshift(record);
    await io.setRuns(runs.slice(0, 50));
    return record;
  }

  // ------------------------------------------------------------------ chạy

  async function start() {
    dictionary = await io.loadDictionary();
    state.startedAt = Date.now();
    state.phase = 'running';
    emit('phase');

    const clockMonitor = setInterval(observeWallClock, 1000);
    try {
      await Promise.all(entries.map((e) => runSite(e).catch((err) => {
        e.status = aborted ? SITE_STATUS.ABORTED : SITE_STATUS.BLOCKED;
        e.stateNote = null;
        e.error = String(err?.message || err);
      })));

      state.phase = 'burst-done';
      emit('phase');
      await persist();

      await recoverMissedCodes();
      // Không có bước đổi thưởng. Engine chỉ nhận code rồi dừng — xem
      // docs/KNOWLEDGE.md, mục `setCookiesBarrier`.

      state.phase = aborted ? 'aborted' : 'done';
      state.finishedAt = Date.now();
      const record = await persist();
      await io.saveRun(record);
      emit('done');
      return record;
    } finally { clearInterval(clockMonitor); }
  }

  return { runId, state, start, abort, persist, serialize };
}

/** Thời gian còn lại của một code trước khi hết hạn đổi thưởng. */
export function codeRemainingMs(wonAt, now = Date.now()) {
  return wonAt ? wonAt + CODE_TTL_MS - now : 0;
}
