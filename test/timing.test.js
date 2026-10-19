import test from 'node:test';
import assert from 'node:assert/strict';
import { contextId, monoNow, stableNow } from '../lib/timebase.js';
import { measureOffset, supportedInterval, safeSendDeadline, serverNow, hasAnchor, isFresh } from '../lib/clock.js';
import { createRun, SITE_STATUS } from '../lib/engine.js';
import { classify } from '../lib/classify.js';
import { timedFetch } from '../lib/net.js';
import { DEFAULT_CONFIG } from '../lib/storage.js';
import { waitUntilMono, cancelAll } from '../lib/scheduler.js';

const early = { status: 400, body: '{"error_code":"TIME_OUT_CODE","message":"Ngoài thời gian nhận code"}' };
const win = { status: 200, body: '{"data":{"gift_code":"HOTMATCHTEST123"}}' };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function mockLocks(t, locks) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
  t.after(() => {
    if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
    else delete navigator.locks;
  });
}

function fastSampleGaps(t, sim) {
  const originalTimeout = setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => ms === 220
    ? originalTimeout(() => { sim.advance(ms); fn(...args); }, 0) : originalTimeout(fn, ms, ...args));
}

function simulation(t) {
  const start = performance.now();
  let m = start, w = Date.now();
  t.mock.method(performance, 'now', () => m);
  t.mock.method(Date, 'now', () => w);
  return { advance(ms) { m += ms; w += ms; }, jump(ms) { w += ms; },
    clock(uncertaintyMs = 50) { return { ok: true, offsetMs: 744, uncertaintyMs, at: w, source: 'api-date', sourceKey: 'https://11bet.test/api/leagues',
      anchor: { contextId, monoMs: m, serverEpochMs: w + 744 } }; } };
}

function harness(t, options = {}) {
  const sim = simulation(t);
  const clock = sim.clock(options.uncertainty ?? 50);
  const release = serverNow(clock) + (options.lead ?? 1000);
  const site = { brand: '11bet', domain: '11bet.test', account: { uid: 'test' }, clock, config: {} };
  const calls = [], events = [], calibrations = [];
  let active = 0, peak = 0, saved = [];
  const services = {
    loadDictionary: async () => new Map(), setClock: async () => {},
    getRuns: async () => structuredClone(saved), setRuns: async (r) => { saved = structuredClone(r); }, saveRun: async () => {},
    sleep: async (ms) => { sim.advance(ms); },
    waitUntil: async (at) => { options.onWait?.(sim, at); sim.advance(Math.max(0, at - monoNow())); return true; },
    measureOffset: async () => { calibrations.push(monoNow()); const server = serverNow(clock); return { ...clock, at: Date.now(), anchor: { contextId, monoMs: monoNow(), serverEpochMs: server } }; },
    lookupMatch: async () => { sim.advance(options.preflightMs ?? 529); return { ok: true, match: { received: false, configId: 'match-id' } }; },
    request: async (args) => {
      active++; peak = Math.max(active, peak);
      const sent = { args, tSent: Date.now(), tSentMono: monoNow() }; calls.push(sent);
      try {
        const resp = await (options.respond?.(calls.length, sim, sent) ?? win);
        const tDoneMono = monoNow();
        sent.doneMono = tDoneMono;
        return { ...sent, ...resp, ...classify(resp, null, args.phase), tDone: Date.now(), tDoneMono, rate: null };
      } finally { active--; }
    },
  };
  const run = createRun({ match: { id: 'fixture', matchName: 'Brighton & Crystal Palace', releaseEpoch: release, configId: 'match-id' },
    siteList: [site], config: { ...DEFAULT_CONFIG, preflight: false, verifyAfter: false, ...options.config }, kind: options.kind || 'claim',
    services, onEvent: (e) => { events.push({ type: e.type, status: e.state.entries[0].status, pending: e.state.entries[0].requestPending }); } });
  return { run, sim, clock, release, site, services, calls, events, calibrations, peak: () => peak };
}

for (const jump of [3000, -3000, 457, -457]) {
  test(`Windows Sync ${jump}ms sau ARM không đổi deadline hoặc độ trễ gửi`, async (t) => {
    let changed = false;
    const h = harness(t, { onWait(sim) { if (!changed) { changed = true; sim.jump(jump); } } });
    const expected = safeSendDeadline(h.clock, h.release, 200);
    const result = await h.run.start();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].tSentMono, expected);
    assert.equal(result.results['11bet'].timing[0].dispatchErrorMs, 0);
    assert.ok(result.clockChanges.some(c => Math.abs(c.deltaMs - jump) < 2));
    assert.equal(result.results['11bet'].status, 'won');
  });
}

test('Sync sau đo nhưng trước ARM vẫn dùng anchor cũ chính xác', async (t) => {
  const h = harness(t);
  h.sim.jump(-2700);
  const expected = safeSendDeadline(h.clock, h.release, 200);
  await h.run.start();
  assert.equal(h.calls[0].tSentMono, expected);
});

test('ARM xa giờ G đo lại gần giờ phát, không mất anchor khi Windows Sync', async (t) => {
  let jump = false;
  const h = harness(t, { lead: 120000, onWait(sim) { if (!jump) { jump = true; sim.jump(3000); } } });
  await h.run.start();
  assert.equal(h.calibrations.length, 1);
  assert.ok(h.calls[0].args.timing.clockAgeMs < 16000);
  const serverAtSend = h.clock.anchor.serverEpochMs + h.calls[0].tSentMono - h.clock.anchor.monoMs;
  assert.ok(serverAtSend >= h.release + 200);
});

test('Đồng hồ từ phiên khác bắt buộc đo lại, không mượn offset đã lưu', async (t) => {
  const h = harness(t);
  h.run.state.entries[0].clock.anchor.contextId = 'previous-tab';
  await h.run.start();
  assert.equal(h.calibrations.length, 1);
  assert.equal(h.calls.length, 1);
});

test('Đo lại lỗi thì không bắn bằng đồng hồ máy hoặc offset cũ', async (t) => {
  const h = harness(t);
  h.run.state.entries[0].clock = null;
  const run = createRun({ match: { id: 'bad-clock', releaseEpoch: h.release }, siteList: [h.site],
    clockFor: () => null, config: { ...DEFAULT_CONFIG, verifyAfter: false },
    services: { ...h.services, measureOffset: async () => ({ ok: false, error: 'no Date' }) } });
  const record = await run.start();
  assert.equal(h.calls.length, 0);
  assert.equal(record.results['11bet'].status, 'blocked');
});

test('Hồi quy 11BET: preflight 529ms không kéo deadline lên sớm; dùng cả ±154ms', async (t) => {
  const h = harness(t, { lead: 10000, uncertainty: 154, config: { preflight: true } });
  await h.run.start();
  const sentServerLower = h.clock.anchor.serverEpochMs + h.calls[0].tSentMono - h.clock.anchor.monoMs - 154;
  assert.ok(sentServerLower >= h.release + 200);
  assert.equal(h.calls[0].args.timing.flightCompensationMs, 0);
  assert.equal(h.run.state.entries[0].latencyMs, 529);
});

test('Lỗi sớm 197ms được thử tiếp sau phản hồi, không ngủ cứu hộ 3.8s', async (t) => {
  const h = harness(t, { respond(n, sim) { sim.advance(n === 1 ? 197 : 100); return n === 1 ? early : win; } });
  const result = await h.run.start();
  assert.equal(h.calls.length, 2);
  assert.equal(h.peak(), 1);
  assert.ok(h.calls[1].tSentMono >= h.calls[0].doneMono + 200);
  assert.ok(h.calls[1].tSentMono - h.calls[0].tSentMono < 500);
  assert.ok(h.events.some(e => e.status === SITE_STATUS.RETRY_WAIT && !e.pending));
  assert.equal(result.results['11bet'].status, 'won');
});

test('NOT_YET lặp lại bị giới hạn 3 phát', async (t) => {
  const h = harness(t, { respond: () => early });
  const result = await h.run.start();
  assert.equal(h.calls.length, 3);
  assert.equal(h.peak(), 1);
  assert.equal(result.results['11bet'].status, 'lost');
});

test('Readiness chỉ gửi 1 phát, không cứu hộ lỗi ngoài giờ dự kiến', async (t) => {
  const h = harness(t, { kind: 'readiness', respond: () => early });
  await h.run.start(); assert.equal(h.calls.length, 1);
});

for (const resp of [
  { status: 0, body: '' }, { status: 503, body: '' }, { status: 429, body: '' },
  { status: 200, body: '{"message":"Đã hết code"}' }, { status: 202, body: '{"status":"pending"}' },
]) test(`Không bắn tiếp khi kết quả ${resp.status}/${resp.body} không xác nhận từ chối sớm`, async (t) => {
  const h = harness(t, { respond: () => resp });
  await h.run.start(); assert.equal(h.calls.length, 1);
});

test('Request treo hơn 3.8s vẫn chỉ 1 phát; phản hồi muộn không gây retry ngoài cửa sổ', async (t) => {
  let finish;
  const h = harness(t, { respond: () => new Promise(r => { finish = r; }) });
  const running = h.run.start(); await flush();
  assert.equal(h.calls.length, 1);
  h.sim.advance(7000); h.sim.jump(3000); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.run.state.entries[0].requestPending, true);
  finish(early); const result = await running;
  assert.equal(h.calls.length, 1);
  assert.equal(result.results['11bet'].status, 'lost');
});

test('Huỷ rồi ARM lại không bắn chồng request cũ còn chờ', async (t) => {
  let finish;
  const h = harness(t, { respond: () => new Promise(r => { finish = r; }) });
  const first = h.run.start(); await flush(); h.run.abort();
  const second = createRun({ match: h.run.state.match, siteList: [h.site], config: { ...DEFAULT_CONFIG, preflight: false, verifyAfter: false }, services: h.services });
  const record = await second.start();
  assert.equal(record.results['11bet'].status, 'blocked');
  assert.equal(h.calls.length, 1);
  finish(early); await first;
  assert.equal(h.calls.length, 1);
  assert.equal(h.run.state.entries[0].status, 'aborted');
});

test('Khoá từ dashboard khác chặn gửi và không tăng số phát', async (t) => {
  const locks = { request: async (_name, _options, callback) => callback(null) };
  mockLocks(t, locks);
  const h = harness(t);
  const record = await h.run.start();
  assert.equal(h.calls.length, 0);
  assert.equal(record.results['11bet'].status, 'blocked');
  assert.equal(record.results['11bet'].attempts, 0);
});

test('Khoá liên tab được giữ tới khi phản hồi hoàn tất, kể cả sau Huỷ', async (t) => {
  let held = false, finish;
  const locks = { request: async (name, options, callback) => {
    assert.equal(name, 'hotmatch-claim:11bet'); assert.equal(options.ifAvailable, true);
    held = true;
    try { return await callback({ name }); } finally { held = false; }
  } };
  mockLocks(t, locks);
  const h = harness(t, { respond: () => new Promise(r => { finish = r; }) });
  const running = h.run.start(); await flush();
  h.run.abort(); h.sim.advance(7000); await flush();
  assert.equal(held, true); assert.equal(h.calls.length, 1);
  finish(early); await running;
  assert.equal(held, false);
});

test('SCAR cũng chờ phản hồi, dù cấu hình cũ đặt concurrency 4', async (t) => {
  const h = harness(t, { config: { shootMode: 'scar', concurrency: 4, maxAttempts: 3 },
    respond: async (n, sim) => { sim.advance(500); await flush(); return n === 3 ? win : early; } });
  await h.run.start();
  assert.equal(h.calls.length, 3);
  assert.equal(h.peak(), 1);
  for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i].tSentMono >= h.calls[i - 1].doneMono);
});

test('Không dùng clock cũ 10 phút dù cấu hình lưu từ bản cũ cho phép 30 phút', async (t) => {
  const h = harness(t, { config: { clockMaxAgeMs: 1800000 } });
  h.run.state.entries[0].clock.anchor.monoMs -= 600000;
  h.run.state.entries[0].clock.anchor.serverEpochMs -= 600000;
  await h.run.start();
  assert.equal(h.calibrations.length, 1);
  assert.equal(h.calls.length, 1);
});

test('Windows chỉnh dần 457ms sau ARM cũng không thay đổi deadline', async (t) => {
  let changes = 0;
  const h = harness(t, { config: { preflight: true }, lead: 10000,
    onWait(sim) { sim.jump(228.5); changes++; } });
  const expected = safeSendDeadline(h.clock, h.release, 200);
  await h.run.start();
  assert.equal(changes, 2);
  assert.equal(h.calls[0].tSentMono, expected);
  assert.ok(h.run.state.clockChanges.length >= 2);
});

test('Chọn khoảng không phụ thuộc thứ tự và không để mẫu cache đầu khoá kết quả', () => {
  const good = [[-340,720],[-620,440],[-900,160],[-180,880],[-460,600],[-740,320],[-1020,40]];
  const samples = [[-2060,-1000], ...good];
  assert.deepEqual(supportedInterval(samples), [-180,40]);
  assert.deepEqual(supportedInterval([...samples].reverse()), [-180,40]);
  assert.equal(supportedInterval([[0,1],[0,1],[3,4],[3,4]], 1), null);
});

test('Đo Date trong khi Windows nhảy 3s vẫn giữ khoảng server đúng', async (t) => {
  const sim = simulation(t); let n = 0;
  // Chỉ tăng thời gian chờ giữa mẫu; timeout toàn đợt không được kích hoạt.
  fastSampleGaps(t, sim);
  t.mock.method(globalThis, 'fetch', async () => {
    const d = Math.floor((stableNow() + 30) / 1000) * 1000;
    sim.advance(60); if (++n === 3) sim.jump(3000);
    return new Response(null, { status: 200, headers: { Date: new Date(d).toUTCString() } });
  });
  const clock = await measureOffset('https://11bet.test', { samples: 8, url: 'https://11bet.test/api/leagues' });
  assert.equal(clock.ok, true);
  assert.ok(Math.abs(serverNow(clock) - stableNow()) <= clock.uncertaintyMs);
  assert.equal(hasAnchor(clock), true);
  sim.jump(-6000); assert.equal(isFresh(clock), true);
});

test('API proxy 404 chuyển sang API trực tiếp trước khi lấy mẫu giờ', async (t) => {
  const sim = simulation(t), urls = [];
  fastSampleGaps(t, sim);
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    const d = Math.floor((stableNow() + 30) / 1000) * 1000;
    sim.advance(60);
    return new Response(null, { status: urls.length === 1 ? 404 : 200, headers: { Date: new Date(d).toUTCString() } });
  });
  const clock = await measureOffset('https://11bet.test', { samples: 8,
    url: 'https://11bet.test/proxy/leagues', fallbackUrl: 'https://11bet.test/api/leagues' });
  assert.equal(clock.ok, true);
  assert.equal(clock.sourceKey, 'https://11bet.test/api/leagues');
  assert.equal(urls.filter(u => u.includes('/proxy/')).length, 1);
  assert.equal(clock.samples, 8);
});

for (const extra of [{ Age: '2' }, { 'CF-Cache-Status': 'HIT', Age: '0' }]) {
  test(`Không dùng HTTP Date từ cache ${JSON.stringify(extra)}`, async (t) => {
    const sim = simulation(t);
    t.mock.method(globalThis, 'fetch', async () => {
      sim.advance(60);
      return new Response(null, { headers: { Date: new Date(stableNow()).toUTCString(), ...extra } });
    });
    const clock = await measureOffset('https://11bet.test', { samples: 8 });
    assert.equal(clock.ok, false); assert.equal(clock.samples, 0); assert.equal(clock.rejected, 8);
  });
}

test('Preflight quá chậm bị ngắt trước giờ bắn, không kéo lịch nhận code', async (t) => {
  const h = harness(t, { lead: 10000 });
  const originalTimeout = setTimeout;
  let cancelled = false;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => ms === 2500
    ? originalTimeout(() => { h.sim.advance(ms); fn(...args); }, 0) : originalTimeout(fn, ms, ...args));
  const run = createRun({ match: h.run.state.match, siteList: [h.site],
    config: { ...DEFAULT_CONFIG, verifyAfter: false }, services: { ...h.services,
      lookupMatch: async (_site, _name, { signal }) => new Promise(resolve => {
        signal.addEventListener('abort', () => { cancelled = true; resolve({ ok: false, match: null }); }, { once: true });
      }),
    } });
  await run.start();
  assert.equal(cancelled, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].tSentMono, safeSendDeadline(h.clock, h.release, 200));
});

test('Không lấy giờ từ trang đăng nhập/challenge thay cho API', async (t) => {
  simulation(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    headers: { Date: new Date().toUTCString(), 'Content-Type': 'text/html' },
  }));
  const clock = await measureOffset('https://11bet.test', { url: 'https://11bet.test/api/leagues' });
  assert.equal(clock.ok, false);
  assert.equal(clock.samples, 0);
});

test('TTFB đo đơn điệu khi Windows Sync ngay trong fetch', async (t) => {
  const sim = simulation(t);
  t.mock.method(globalThis, 'fetch', async () => { sim.advance(197); sim.jump(-3000); return new Response('{}'); });
  const result = await timedFetch('https://offline.test');
  assert.equal(result.latencyMs, 197);
  assert.equal(result.wallClockChangeMs, -3000);
});

test('Scheduler thật không bắn sớm khi Date.now nhảy tiến sau ARM', async (t) => {
  const realNow = Date.now.bind(Date);
  let shift = 0;
  t.mock.method(Date, 'now', () => realNow() + shift);
  const start = performance.now();
  const wait = waitUntilMono(start + 100);
  shift = 3000;
  assert.equal(await wait, true);
  assert.ok(performance.now() - start >= 100);
  cancelAll();
});

test('Scheduler đang ngủ thô được đánh thức khi thêm deadline sớm hơn', async () => {
  const far = waitUntilMono(performance.now() + 60000);
  const at = performance.now() + 100;
  await waitUntilMono(at);
  assert.ok(performance.now() - at < 500);
  cancelAll(); assert.equal(await far, false);
});
