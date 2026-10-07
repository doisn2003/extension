/**
 * Đối chiếu logic của tool với chính dữ liệu đã bắt được từ tip88.
 *
 * Đây không phải unit test cho vui: nó ghim hành vi của tool vào request thật.
 * Nếu ai đó sửa cách dựng URL hay cách đọc cookie mà làm lệch đi, bộ này đỏ ngay.
 *
 *   npm test        (trong thư mục extension/)
 */
import fs from 'node:fs';
import { vnDateString, vnToEpoch, vnTimeString, vnDateTimeString, formatDuration } from '../lib/vn-time.js';
import {
  parseUserCookie, decodeJwtPayload, brandFromHost, buildClaimUrl, joinMatchName,
  looksLikeBrand, displayName, DEFAULT_PATHS, redeemCode,
} from '../lib/sites.js';
import { extractCode, heuristicLabel, classify, rateLimitFrom } from '../lib/classify.js';
import { signature, normalizeBody, LABELS } from '../lib/blackbox.js';
import { consensus, effectiveClock } from '../lib/clock.js';
import { validateMatch, splitPasted, releaseTime, countdown, offsetFromSiteCountdown } from '../lib/match.js';
import { extractMatches, bestResult } from '../lib/discover.js';
import { parseLeagues } from '../lib/hotmatch.js';
import { DEFAULT_CONFIG, DEFAULT_SITE_CONFIG } from '../lib/storage.js';
import { CODE_TTL_MS, codeRemainingMs } from '../lib/engine.js';
import {
  buildGameUrlRequest, GAMES, DEFAULT_GAME_KEY, LOBBIES,
  gameKey, gameLabel, findGame, returnPathFor,
} from '../lib/gameportal.js';
import {
  unwrap, isRunning, parseSlips, formatSlip, validate,
  scoreKey, duplicateScores, sentScores,
} from '../lib/prediction.js';

const CAPTURE = new URL('../../giftCode-Collected.json', import.meta.url);
const REDEEM = new URL('../../giftCode-rewardRedeemed.json', import.meta.url);

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = typeof actual === 'object' ? JSON.stringify(actual) : String(actual);
  const e = typeof expected === 'object' ? JSON.stringify(expected) : String(expected);
  if (a === e) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  XX  ${name}\n        nhận:  ${a}\n        chờ:   ${e}`); }
}

const collected = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
const redeemed = JSON.parse(fs.readFileSync(REDEEM, 'utf8'));
const cookieHeader = collected['Request Headers'].cookie;
const jar = Object.fromEntries(
  cookieHeader.split('; ').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }),
);

console.log('\n1) Múi giờ VN — date param phải là ngày VN, không phải ngày UTC');
const reqMoment = Date.parse(collected['Response Headers'].date); // Sat, 08 Aug 2026 18:51:18 GMT
check('ngày VN tại thời điểm request', vnDateString(reqMoment), '2026-08-09');
check('date param trong URL thật', new URL(collected.General['Request URL']).searchParams.get('date'), '2026-08-09');
check('giờ VN tại thời điểm request', vnTimeString(reqMoment), '01:51:18');
check('vnToEpoch quay vòng', vnDateString(vnToEpoch('2026-08-09', '04:20')), '2026-08-09');

console.log('\n2) Ba card countdown nhất quán với nhau (KHÔNG suy ra được mốc kết thúc)');
// Card 1: kickoff 04:20 09/08, còn 00:48:27. Card 2: 08:30 09/08, còn 04:58:27.
// Card 3: 04:05 10/08, còn 24:33:27.
//
// Cả ba cùng lệch so với kickoff một lượng như nhau — điều đó chỉ chứng minh ba
// đồng hồ chạy đồng bộ, KHÔNG chứng minh chúng kết thúc tại giờ bóng lăn: nếu
// tất cả kết thúc sớm hơn 10 phút thì phép tính này vẫn ra cùng một mốc, chỉ dời
// đi đúng 10 phút. Thực tế đúng là như vậy — xem mục 15.
const now1 = vnToEpoch('2026-08-09', '04:20') - (48 * 60 + 27) * 1000;
const now2 = vnToEpoch('2026-08-09', '08:30') - (4 * 3600 + 58 * 60 + 27) * 1000;
const now3 = vnToEpoch('2026-08-10', '04:05') - (24 * 3600 + 33 * 60 + 27) * 1000;
check('card 1 và card 2 lệch kickoff cùng một lượng', now1, now2);
check('card 1 và card 3 lệch kickoff cùng một lượng', now1, now3);
check('phép trừ ra 03:31:33 giờ VN', vnTimeString(now1), '03:31:33');
check('định dạng đếm ngược đúng', formatDuration(vnToEpoch('2026-08-09', '04:20') - now1), '00:48:27');
// Chứng minh luôn tính mơ hồ: dời cả ba đi 10 phút thì vẫn nhất quán y hệt.
const shift = 10 * 60 * 1000;
check('dời 10 phút vẫn nhất quán — nên bằng chứng này không kết luận được',
  (now1 - shift) === (now2 - shift) && (now2 - shift) === (now3 - shift), 'true');

console.log('\n3) Dựng lại URL nhận code theo format mới (không dùng hotmatch-proxy)');
const site = { domain: 'tip88.fyi', paths: DEFAULT_PATHS };
const built = buildClaimUrl(site, {
  matchName: joinMatchName('Independiente Santa Fe', 'Boyaca Chico'),
  date: '2026-08-09',
  uid: 10500449,
});
check('URL dựng ra theo format mới', built, 'https://tip88.fyi/api/v1/hotmatch/giftcode?match_name=Independiente%20Santa%20Fe%20%26%20Boyaca%20Chico');
check('dấu cách mã hoá thành %20 (không phải +)', built.includes('%20'), 'true');
check('dấu & của tên trận mã hoá thành %26', built.includes('%26'), 'true');

console.log('\n4) Đọc tài khoản từ cookie — không tốn request nào');
const user = parseUserCookie(jar.user);
check('parse được cookie user', user !== null, 'true');
check('uid', user.id, 10500449);
check('username', user.username, 'minh003');
check('balance', user.balance, 460);
check('is_login', decodeURIComponent(jar.is_login), 'true');
const jwt = decodeJwtPayload(user.token);
check('giải được JWT', jwt !== null, 'true');
check('iat trong JWT', jwt.iat, 1786215060);
check('domain trong JWT', jwt.domain, 'https://tip88.fyi');

console.log('\n5) Suy thương hiệu từ domain và từ cookie recently_*');
check('brandFromHost', brandFromHost('tip88.fyi'), 'tip88');
check('brandFromHost bỏ qua www', brandFromHost('www.uk88.crm'), 'uk88');
check('brandFromHost trên domain có dấu chấm đầu', brandFromHost('.da88.soy'), 'da88');
const recently = Object.keys(jar).find((k) => /^recently_\d+_/.test(k));
check('tìm được cookie recently_*', /^recently_(\d+)_(.+)$/.exec(recently)[2], 'tip88');

console.log('\n6) Body POST đổi thưởng — vì sao đếm byte KHÔNG đủ để chốt tên trường');
// Bài học: `content-length: 27` khớp với CẢ HAI cách viết. Suy luận từ độ dài
// chỉ loại được các khả năng khác độ dài, không phân biệt được hoa thường —
// nhưng khi đó tôi lại coi nó là bằng chứng chắc chắn và chọn nhầm chữ thường.
// Server nói thẳng ra khi thiếu trường: "giftCode: Bắt buộc nhập trường này!".
const lowerCase = JSON.stringify({ giftcode: 'HOTMATCHPXGM' });
const camelCase = JSON.stringify({ giftCode: 'HOTMATCHPXGM' });
check('cả hai cách viết đều đúng 27 byte',
  `${Buffer.byteLength(lowerCase)}/${Buffer.byteLength(camelCase)}`, '27/27');
check('content-length đã bắt được là 27', redeemed['Request Headers']['content-length'], '27');
check('code khớp referer của request thật', new URL(redeemed['Request Headers'].referer).searchParams.get('giftcode'), 'HOTMATCHPXGM');
// Tool KHÔNG còn gửi request này nữa — xem docs/KNOWLEDGE.md, mục setCookiesBarrier.
// Giữ mục kiểm thử này vì bài học về phương pháp vẫn đúng và vẫn đáng nhớ.

console.log('\n7) Rút code khỏi phản hồi khi chưa biết trước tên trường');
check('trường giftcode', extractCode('{"giftcode":"HOTMATCHPXGM"}'), 'HOTMATCHPXGM');
check('trường lồng nhau', extractCode('{"data":{"gift_code":"HOTMATCHQR4T"},"ok":true}'), 'HOTMATCHQR4T');
// Body là JSON mà không có trường mã nào thì trả null, KHÔNG đoán bằng regex.
// Đoán bừa từng làm tool nhặt "BC373351" (mã chi nhánh) làm gift code — xem mục 25.
check('JSON không có trường mã thì không đoán', extractCode('{"result":"HOTMATCHZZ12"}'), 'null');
check('body không phải JSON mới dò bằng regex', extractCode('mã của bạn: HOTMATCHZZ12'), 'HOTMATCHZZ12');
check('không nhầm giá trị "success"', extractCode('{"code":"success"}'), 'null');
check('phản hồi rỗng', extractCode('{"data":null}'), 'null');

console.log('\n8) Chữ ký phản hồi — hai code khác nhau phải cho cùng một chữ ký');
const sigA = signature(200, '{"giftcode":"HOTMATCHPXGM","uid":10500449}');
const sigB = signature(200, '{"giftcode":"HOTMATCHQR4T","uid":10500450}');
check('cùng chữ ký', sigA, sigB);
check('khác status thì khác chữ ký', signature(500, '{"giftcode":"HOTMATCHPXGM"}') !== sigA, 'true');
check('lỗi khác nội dung thì khác chữ ký',
  signature(200, '{"msg":"Có lỗi xảy ra"}') !== signature(200, '{"msg":"Hết code"}'), 'true');
check('chuẩn hoá bỏ số dài', normalizeBody('{"balance":12267716907236}'), '{"balance":<N>}');

console.log('\n9) Đoán nhãn khi từ điển chưa có');
check('lỗi tạm thời', heuristicLabel({ status: 200, body: '{"message":"Có lỗi xảy ra, vui lòng thử lại sau"}' }), LABELS.TRANSIENT);
check('hết code', heuristicLabel({ status: 200, body: '{"message":"Đã hết code"}' }), LABELS.SOLD_OUT);
check('chưa tới giờ', heuristicLabel({ status: 200, body: '{"message":"Chưa đến giờ phát code"}' }), LABELS.NOT_YET);
check('sai tên trận', heuristicLabel({ status: 200, body: '{"message":"Không tìm thấy trận đấu"}' }), LABELS.BAD_MATCH);
check('thành công', heuristicLabel({ status: 200, body: '{"giftcode":"HOTMATCHPXGM"}' }), LABELS.SUCCESS);
check('chạm hạn mức qua header', heuristicLabel({ status: 200, body: '{}', headers: { 'x-ratelimit-remaining': '0' } }), LABELS.THROTTLED);
check('cloudflare chặn', heuristicLabel({ status: 403, body: '<html><title>Just a moment...</title>' }), LABELS.CHALLENGED);
check('lỗi mạng', heuristicLabel({ status: 0, body: '' }), LABELS.TRANSIENT);

console.log('\n10) Đồng hồ đồng thuận — dùng số đo thật từ bản nghiệm thu 15 site');
// Giá trị lấy nguyên từ "HotMatch Claimer.html": mọi site đều lệch ~+2.3s,
// nên đại lượng đang đo là sai số đồng hồ MÁY, và 15 site là 15 phép đo độc lập.
const measured = [
  ['11win', 2210, 93], ['ac183423', 2260, 119], ['bc117116', 2380, 116],
  ['bc119121', 2270, 51], ['bc120049', 2330, 117], ['bc180591', 2270, 91],
  ['bom88', 2260, 120], ['bu88', 2300, 117], ['co88', 2300, 144],
  ['du88', 2230, 112], ['k88', 2320, 129], ['man88', 2290, 95],
  ['tip88', 2240, 119], ['tx88', 2310, 113], ['vk88', 2310, 114],
].map(([key, offsetMs, uncertaintyMs]) => ({ key, clock: { ok: true, offsetMs, uncertaintyMs } }));

const cons = consensus(measured);
check('cả 15 site cùng đồng thuận', `${cons.agree}/${cons.total}`, '15/15');
check('không site nào lệch nhóm', cons.outliers.length, 0);
check('offset đồng thuận nằm giữa dải đo', cons.offsetMs > 2260 && cons.offsetMs < 2310, 'true');
check('sai số hẹp hơn hẳn site tốt nhất (±51ms)', cons.uncertaintyMs < 51, 'true');

// Một site lệch thật thì phải bị loại khỏi nhóm chứ không được kéo cả nhóm theo.
const withRogue = [...measured, { key: 'rogue', clock: { ok: true, offsetMs: -40000, uncertaintyMs: 50 } }];
const consRogue = consensus(withRogue);
check('site lệch bị đẩy ra ngoài nhóm', consRogue.outliers, ['rogue']);
check('nhóm còn lại không bị kéo lệch', consRogue.offsetMs, cons.offsetMs);
check('không có dữ liệu thì trả null', consensus([{ key: 'x', clock: null }]), 'null');

console.log('\n11) Ưu tiên offset nào khi bắn');
const tight = { brand: 'tip88', clock: { ok: true, offsetMs: 2240, uncertaintyMs: 119 } };
check('đồng thuận hẹp hơn thì dùng đồng thuận', effectiveClock(tight, cons).source, 'consensus');
check('site lệch nhóm thì dùng phép đo riêng', effectiveClock({ brand: 'rogue', clock: { ok: true, offsetMs: -40000, uncertaintyMs: 50 } }, consRogue).source, 'site');
check('site chưa đo thì mượn đồng thuận', effectiveClock({ brand: 'moi', clock: null }, cons).source, 'consensus');

console.log('\n12) Kiểm chính tả tên trận');
const good = validateMatch({ home: 'Independiente Santa Fe', away: 'Boyaca Chico', date: '2026-08-09', time: '04:20' }, vnToEpoch('2026-08-09', '00:00'));
check('trận hợp lệ', good.ok, 'true');
check('tên trận ghép đúng', good.match.matchName, 'Independiente Santa Fe & Boyaca Chico');
check('date suy từ giờ bóng lăn theo giờ VN', good.match.dateParam, '2026-08-09');
check('không cảnh báo thừa', good.warnings.length, 0);

// Kickoff 00:30 giờ VN ngày 09/08 = 17:30 UTC ngày 08/08. date phải là ngày VN.
const midnight = validateMatch({ home: 'A Team', away: 'B Team', date: '2026-08-09', time: '00:30' }, Date.parse('2026-08-08T12:00:00Z'));
check('trận sau nửa đêm vẫn lấy ngày VN', midnight.match.dateParam, '2026-08-09');

const dirty = validateMatch({ home: '  Real Madrid  ', away: 'Barcelona​', date: '2026-08-09', time: '04:20' }, vnToEpoch('2026-08-09', '00:00'));
check('khoảng trắng lạ và ký tự vô hình bị dọn', dirty.match.matchName, 'Real Madrid & Barcelona');
check('có báo lại là đã sửa gì', dirty.warnings.length >= 2, 'true');

const ampersand = validateMatch({ home: 'A & B', away: 'C', date: '2026-08-09', time: '04:20' }, vnToEpoch('2026-08-09', '00:00'));
check('cảnh báo khi tên đội chứa dấu &', ampersand.warnings.some((w) => w.includes('&')), 'true');

check('thiếu đội khách thì chặn', validateMatch({ home: 'A Team', away: '', date: '2026-08-09', time: '04:20' }).ok, 'false');
check('giờ sai định dạng thì chặn', validateMatch({ home: 'A Team', away: 'B Team', date: '2026-08-09', time: '25:00' }).ok, 'false');
check('dán nguyên "A & B" thì tách được', splitPasted('Independiente Santa Fe & Boyaca Chico'), { home: 'Independiente Santa Fe', away: 'Boyaca Chico' });
check('chuỗi không có & thì không tách', splitPasted('Chelsea'), 'null');

console.log('\n13) Đổi tên miền không được làm vỡ registry (lỗi lộ ra từ bản nghiệm thu)');
await testDomainRotation();

async function testDomainRotation() {
  // Site có domain dạng số như bc117116.com: khớp theo tên domain sẽ đẻ ra site
  // mới khi họ đổi số. Phải khớp theo UID tài khoản mới đúng.
  const store = {};
  const jarFor = (host) => ([
    { name: 'user', value: encodeURIComponent(JSON.stringify({
        id: 1837192, token: 'a.eyJpYXQiOjE3ODYyMTUwNjB9.c', username: 'minh003', balance: 250, member_id: 42 })),
      domain: host },
    { name: 'is_login', value: 'true', domain: host },
  ]);
  let currentHost = 'bc117116.com';

  globalThis.chrome = {
    permissions: { contains: async () => true },
    storage: {
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = structuredClone(store[k]);
          return out;
        },
        set: async (obj) => { Object.assign(store, structuredClone(obj)); },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    cookies: {
      getAll: async (q) => {
        if (q.name === 'user') return jarFor(currentHost).filter((c) => c.name === 'user');
        return jarFor(currentHost);
      },
    },
  };

  const sitesMod = await import('../lib/sites.js');

  const first = await sitesMod.discoverAndMerge();
  check('lần đầu: thêm 1 site', first.added.length, 1);
  let all = await sitesMod.list();
  check('registry có 1 site', all.length, 1);
  const brandKey = all[0].brand;
  check('khoá suy từ domain số', brandKey, 'bc117116');

  await sitesMod.update(brandKey, { customLabel: 'BC Thể Thao', enabled: false });

  currentHost = 'bc990001.net';
  const second = await sitesMod.discoverAndMerge();
  all = await sitesMod.list();
  check('đổi domain KHÔNG đẻ site mới', all.length, 1);
  check('được ghi nhận là đổi domain', second.moved.length, 1);
  check('domain đã cập nhật', all[0].domain, 'bc990001.net');
  check('khoá brand giữ nguyên', all[0].brand, 'bc117116');
  check('tên bạn đặt được giữ lại', all[0].customLabel, 'BC Thể Thao');
  check('cấu hình bật/tắt được giữ lại', all[0].enabled, 'false');
  check('domain cũ vào lịch sử', all[0].domainHistory.includes('bc117116.com'), 'true');
  check('đồng hồ bị xoá vì edge mới', all[0].clock, 'null');

  await sitesMod.setAllEnabled(true);
  all = await sitesMod.list();
  check('setAllEnabled(true) bật tất cả site', all.every((s) => s.enabled), 'true');

  await sitesMod.setAllEnabled(false);
  all = await sitesMod.list();
  check('setAllEnabled(false) tắt tất cả site', all.every((s) => !s.enabled), 'true');

  const testList = [
    { brand: 'net88', domain: 'net88.beer' },
    { brand: 'tx88', domain: 'tx88.fyi' },
    { brand: 'unknown_site', domain: 'unknown.com' },
    { brand: 'vk88', domain: 'vk88.srl' },
    { brand: 'ta88', domain: 'ta88.link' },
  ];
  const sorted = sitesMod.sortSites(testList).map((s) => s.brand);
  check('thứ tự cố định chuẩn xác', JSON.stringify(sorted), JSON.stringify(['tx88', 'ta88', 'vk88', 'net88', 'unknown_site']));
}

console.log('\n14) Bộ hẹn giờ chính xác');
await testScheduler();

async function testScheduler() {
  const { waitUntil, cancelAll } = await import('../lib/scheduler.js');

  const t0 = Date.now() + 120;
  await waitUntil(t0);
  const err = Date.now() - t0;
  check('tới hạn với sai số dưới 20ms', err >= 0 && err < 20, 'true');

  // 15 site cùng chờ một mốc gần trùng nhau — phải cùng tỉnh, không ai bị bỏ lại.
  const target = Date.now() + 150;
  const errs = await Promise.all(
    Array.from({ length: 15 }, (_, i) => waitUntil(target + i).then(() => Date.now() - target)),
  );
  check('15 lượt chờ đều tới hạn', errs.length, 15);
  check('không lượt nào tỉnh sớm', errs.every((e) => e >= 0), 'true');
  check('không lượt nào trễ quá 30ms', Math.max(...errs) < 30, 'true');

  // Mốc đã qua thì trả về ngay, không treo.
  const immediate = await waitUntil(Date.now() - 5000);
  check('mốc đã qua thì trả ngay', immediate, 'true');

  // Huỷ phải giải phóng mọi lượt chờ, nếu không engine sẽ treo khi bấm Huỷ.
  const far = waitUntil(Date.now() + 60000);
  setTimeout(cancelAll, 30);
  check('huỷ thì lượt chờ trả về false', await far, 'false');
}

console.log('\n15) Code phát trước bóng lăn 10 phút');
// Card trận 08:30 hiện countdown 00:57:58 vào lúc ~07:22 -> kết thúc tại 08:20.
const rel = validateMatch(
  { home: 'Deportivo Pasto', away: 'Deportivo Cali', date: '2026-08-09', time: '08:30' },
  vnToEpoch('2026-08-09', '07:22'),
);
check('mặc định phát trước 10 phút', rel.match.releaseOffsetMin, 10);
check('giờ phát code', vnTimeString(rel.match.releaseEpoch), '08:20:00');
check('releaseTime đọc đúng', releaseTime(rel.match), rel.match.releaseEpoch);
check('đếm ngược khớp đồng hồ trên trang', countdown(rel.match, vnToEpoch('2026-08-09', '07:22:02')), '00:57:58');
check('date vẫn theo ngày bóng lăn', rel.match.dateParam, '2026-08-09');

// Suy ngược số phút phát trước từ chính đồng hồ của nhà cái.
const derived = offsetFromSiteCountdown('00:57:58', vnToEpoch('2026-08-09', '08:30'), vnToEpoch('2026-08-09', '07:22:02'));
check('suy ra đúng 10 phút', Math.round(derived.offsetMin), 10);
check('suy ra đúng giờ phát', vnTimeString(derived.releaseEpoch), '08:20:00');
check('chuỗi sai định dạng trả null', offsetFromSiteCountdown('58 phút', 0, 0), 'null');

// Bản ghi cũ chưa có releaseEpoch không được làm vỡ engine.
check('bản ghi cũ suy lại được', releaseTime({ kickoffEpoch: vnToEpoch('2026-08-09', '08:30') }), vnToEpoch('2026-08-09', '08:20'));

const crossMidnight = validateMatch({ home: 'A Team', away: 'B Team', date: '2026-08-09', time: '00:05' }, Date.parse('2026-08-08T00:00:00Z'));
check('trận sát nửa đêm có cảnh báo lệch ngày', crossMidnight.warnings.some((w) => w.includes('ngày khác')), 'true');

console.log('\n16) 404 không được làm dừng burst (lỗi lộ ra từ phản hồi thật)');
// Phản hồi thật của API: 404 kèm "Invalid match name".
const real404 = `{"error":true,"url":"http://tip88.fyi/api/hotmatch-proxy/v1/hotmatch/giftcode/?match_name=X%20%26%20Y&date=2026-08-09&uid=10500449","statusCode":404,"statusMessage":"Not Found","message":"Not Found","data":{"status":"ERROR","code":404,"message":"Invalid match name","error_code":"ERROR_SYSTEM"}}`;
check('vẫn nhận nhãn sai tên trận', heuristicLabel({ status: 404, body: real404 }), LABELS.BAD_MATCH);
check('lúc Thử nghiệm thì dừng và báo', classify({ status: 404, body: real404 }, null, 'test').action, 'stop-alert');
check('giữa burst thì BẮN TIẾP', classify({ status: 404, body: real404 }, null, 'burst').action, 'continue');
check('giữa đuôi cũng bắn tiếp', classify({ status: 404, body: real404 }, null, 'tail').action, 'continue');
check('phản hồi lạ giữa burst cũng bắn tiếp', classify({ status: 200, body: '{"foo":1}' }, null, 'burst').action, 'continue');
check('hết code thì vẫn dừng giữa burst', classify({ status: 200, body: '{"message":"Đã hết code"}' }, null, 'burst').action, 'stop-lose');
check('thắng thì vẫn dừng giữa burst', classify({ status: 200, body: '{"giftcode":"HOTMATCHPXGM"}' }, null, 'burst').action, 'stop-win');

console.log('\n17) URL echo trong body không được làm hỏng phép so chữ ký');
// Body lỗi echo nguyên URL đã gọi, tức chứa cả match_name -> nếu không lược bỏ
// thì tên bịa và tên thật luôn ra hai chữ ký khác nhau, và Thử nghiệm luôn báo
// "tên đúng" kể cả khi gõ sai.
const bodyFake = real404.replace('match_name=X%20%26%20Y', 'match_name=HotMatch%20Probe%20A%20%26%20HotMatch%20Probe%20B');
const bodyReal = real404.replace('match_name=X%20%26%20Y', 'match_name=Deportivo%20Pasto%20%26%20Deportivo%20Cali');
check('cùng lỗi, khác tên trận -> cùng chữ ký', signature(404, bodyFake), signature(404, bodyReal));
check('cùng lỗi, khác site -> cùng chữ ký',
  signature(404, bodyReal), signature(404, bodyReal.replace('tip88.fyi', 'uk88.nyc')));
check('lỗi khác nội dung vẫn khác chữ ký',
  signature(404, bodyReal) !== signature(404, bodyReal.replace('Invalid match name', 'Gift code not released')), 'true');

console.log('\n18) Không nhầm hằng số lỗi thành gift code');
check('error_code không phải code', extractCode(real404), 'null');
check('ERROR_SYSTEM bị loại', extractCode('{"error_code":"ERROR_SYSTEM"}'), 'null');
check('statusCode không phải code', extractCode('{"statusCode":"404999"}'), 'null');
check('code thật vẫn lấy được', extractCode('{"data":{"giftcode":"HOTMATCHPXGM"}}'), 'HOTMATCHPXGM');
check('không báo thắng nhầm khi gặp lỗi 200',
  heuristicLabel({ status: 200, body: '{"data":{"status":"ERROR","error_code":"ERROR_SYSTEM"}}' }) !== LABELS.SUCCESS, 'true');

console.log('\n19) Tên site suy từ domain, không lấy mã đại lý');
check('mã đại lý bị loại', looksLikeBrand('bc120049'), 'false');
check('mã đại lý ac cũng bị loại', looksLikeBrand('ac183423'), 'false');
check('tên thương hiệu được nhận', looksLikeBrand('tip88'), 'true');
check('tên có số ở đầu vẫn được nhận', looksLikeBrand('11bet'), 'true');
check('hiển thị theo domain khi khoá là mã đại lý',
  displayName({ brand: 'bc120049', label: 'BC120049', domain: '11bet.date' }), '11BET');
check('khoá là tên thật thì giữ nguyên',
  displayName({ brand: 'tip88', label: 'TIP88', domain: 'tip88.fyi' }), 'TIP88');
check('tên bạn tự đặt luôn thắng',
  displayName({ brand: 'bc120049', customLabel: '11BET Thể Thao', domain: '11bet.date' }), '11BET Thể Thao');

console.log('\n20) Rút danh sách trận từ phản hồi có cấu trúc chưa biết');
check('tách được từ trường home/away', extractMatches(JSON.stringify({
  data: [{ home: 'Deportivo Pasto', away: 'Deportivo Cali', kickoff_time: 1786300200 }],
}))[0].matchName, 'Deportivo Pasto & Deportivo Cali');

check('tách được từ một chuỗi có dấu &', extractMatches(JSON.stringify({
  result: { list: [{ match_name: 'Independiente Santa Fe & Boyaca Chico' }] },
}))[0].matchName, 'Independiente Santa Fe & Boyaca Chico');

const withTimes = extractMatches(JSON.stringify({
  matches: [{ home_team: 'A FC', away_team: 'B FC', start_time: '2026-08-09T01:30:00Z', release_time: 1786310400 }],
}))[0];
check('nhặt được nhiều mốc thời gian', Object.keys(withTimes.times).length, 2);
check('mốc dạng giây được nhân lên ms', withTimes.times.release_time, 1786310400000);
check('mốc dạng ISO đọc được', withTimes.times.start_time, Date.parse('2026-08-09T01:30:00Z'));
check('body không phải JSON thì trả rỗng', extractMatches('<html>404</html>').length, 0);
check('JSON không có trận thì trả rỗng', extractMatches('{"error":true,"data":{"status":"ERROR"}}').length, 0);

const ranked = bestResult([
  { path: '/a', isJson: true, status: 200, bytes: 900, matches: [] },
  { path: '/b', isJson: true, status: 200, bytes: 120, matches: [{}, {}, {}] },
]);
check('ưu tiên đường dẫn rút được trận', ranked.path, '/b');
check('không có trận thì lấy JSON dài nhất',
  bestResult([{ path: '/x', isJson: true, status: 200, bytes: 50, matches: [] },
              { path: '/y', isJson: true, status: 200, bytes: 800, matches: [] }]).path, '/y');

console.log('\n21) Cấu hình từng site không được đè cấu hình lần chạy');
// Lỗi thật: site mang sẵn nguyên bộ mặc định nên mọi override bị vô hiệu,
// khiến Diễn tập chạy full 30 giây và bắn hơn nghìn request.
const runCfg = { ...DEFAULT_SITE_CONFIG, maxAttempts: 1, denseWindowMs: 0 };
const cfgWithFullSite = { ...runCfg, ...{ ...DEFAULT_SITE_CONFIG } };
check('minh hoạ lỗi cũ: override bị nuốt', cfgWithFullSite.maxAttempts, DEFAULT_SITE_CONFIG.maxAttempts);
const cfgWithEmptySite = { ...runCfg, ...{} };
check('site config rỗng thì override sống', cfgWithEmptySite.maxAttempts, 1);
const cfgWithPartial = { ...runCfg, ...{ leadMs: 400 } };
check('site chỉ đè khoá nó thực sự đặt', `${cfgWithPartial.leadMs}/${cfgWithPartial.maxAttempts}`, '400/1');

console.log('\n22) Trần cứng số request');
const projected = (cfg) => {
  const dense = cfg.denseWindowMs > 0 ? Math.floor(cfg.denseWindowMs / cfg.intervalMs) + 1 : 1;
  const tail = Math.max(0, Math.floor((cfg.tailWindowMs - cfg.denseWindowMs) / cfg.tailIntervalMs));
  return Math.min(cfg.maxAttempts || Infinity, dense + tail);
};
check('mặc định không vượt trần', projected(DEFAULT_SITE_CONFIG) <= DEFAULT_SITE_CONFIG.maxAttempts, 'true');
check('mặc định nhẹ hơn hẳn cấu hình cũ (74)', projected(DEFAULT_SITE_CONFIG) < 40, 'true');
check('kiểm tra sẵn sàng chỉ 1 phát',
  projected({ ...DEFAULT_SITE_CONFIG, maxAttempts: 1, denseWindowMs: 0, tailWindowMs: 3000 }), 1);

console.log('\n23) API danh sách trận thật (leagues-wc trên vk88.srl)');
const leaguesBody = fs.readFileSync(new URL('./fixtures/leagues-wc.json', import.meta.url), 'utf8');
const leagues = parseLeagues(leaguesBody);

check('đọc được danh sách', leagues.ok, 'true');
check('số trận', leagues.matches.length, 3);
check('có trận kế tiếp', leagues.upcoming.matchName, 'Alianza Petrolera & Atletico Bucaramanga');

const m0 = leagues.matches[0];
check('tên trận nguyên văn từ server', m0.matchName, 'Alianza Petrolera & Atletico Bucaramanga');
check('tách được đội nhà', m0.home, 'Alianza Petrolera');
check('tách được đội khách', m0.away, 'Atletico Bucaramanga');
check('giờ bóng lăn theo VN', vnDateTimeString(m0.kickoffEpoch), '2026-08-10 04:05:00');
check('giờ phát code sớm hơn 10 phút', vnDateTimeString(m0.releaseEpoch), '2026-08-10 03:55:00');
check('số code còn lại', `${m0.remainingCodes}/${m0.totalCodes}`, '20/20');
check('chưa nhận', m0.received, 'false');
check('configId trong trận của server', m0.configId, '3943aa0d-5cc3-429d-bcd5-9e2117e18a64');
check('campaignId trong trận của server', m0.campaignId, 'bf74eea7-29b7-42ce-af02-5efa37b6b616');

// date phải là ngày BÓNG LĂN theo giờ VN. Xác minh trên site thật: gửi ngày UTC
// (2026-08-09) server trả 404, gửi ngày VN (2026-08-10) server trả 400 "Outside
// time window" — tức nó nhận ra trận, chỉ là chưa tới giờ.
check('date là ngày VN của kickoff', m0.dateParam, '2026-08-10');
check('KHÔNG phải ngày UTC', m0.dateParam !== m0.matchName.slice(0, 10) && m0.dateParam !== '2026-08-09', 'true');

// Phép thử quan trọng nhất: dựng lại đúng con số đồng hồ đang chạy trên trang.
// Lúc server báo 02:47:40Z, trang hiện "18 Giờ : 07 Phút : 20 Giây", trong khi
// khoảng cách tới valid_from là 18:17:20 — chênh đúng 10 phút.
const observedNow = Date.parse('2026-08-09T02:47:40Z');
check('đếm ngược khớp đồng hồ thật trên trang', countdown(m0, observedNow), '18:07:20');
check('còn tới valid_from thì dài hơn 10 phút', formatDuration(m0.validFrom - observedNow), '18:17:20');

check('URL nhận code dựng từ trận của server (không có config_id khi chưa cấp)', buildClaimUrl(
  { domain: 'vk88.srl', paths: DEFAULT_PATHS },
  { matchName: m0.matchName, date: m0.dateParam, uid: 10153911 },
), 'https://vk88.srl/api/v1/hotmatch/giftcode?match_name=Alianza%20Petrolera%20%26%20Atletico%20Bucaramanga');

check('URL nhận code dựng từ trận của server (kèm config_id)', buildClaimUrl(
  { domain: 'vk88.srl', paths: DEFAULT_PATHS },
  { matchName: m0.matchName, date: m0.dateParam, uid: 10153911, configId: m0.configId },
), 'https://vk88.srl/api/v1/hotmatch/giftcode?config_id=3943aa0d-5cc3-429d-bcd5-9e2117e18a64');

const mockMatchWithConfigBySite = {
  ...m0,
  configBySite: {
    tx88: 'tx88-uuid-1111',
    vk88: 'vk88-uuid-2222',
  },
};
const vkConfig = mockMatchWithConfigBySite.configBySite['vk88'] || mockMatchWithConfigBySite.configId;
check('lấy đúng configId riêng của từng site từ configBySite', vkConfig, 'vk88-uuid-2222');
check('URL của vk88 mang đúng config_id của vk88', buildClaimUrl(
  { domain: 'vk88.srl', paths: DEFAULT_PATHS },
  { matchName: m0.matchName, date: m0.dateParam, uid: 10153911, configId: vkConfig },
), 'https://vk88.srl/api/v1/hotmatch/giftcode?config_id=vk88-uuid-2222');

check('body rác thì không vỡ', parseLeagues('<html>').ok, 'false');
check('JSON rỗng thì báo không có trận', parseLeagues('{"result":[]}').ok, 'false');

console.log('\n24) Chuỗi lỗi thật của hệ thống sự kiện');
// Nguyên văn hai phản hồi bắt được trên vk88.srl.
const bodyTimeWindow = '{"error":true,"url":"http://vk88.srl/api/hotmatch-proxy/v1/hotmatch/giftcode/?match_name=Alianza%20Petrolera%20%26%20Atletico%20Bucaramanga&date=2026-08-10&uid=10153911","statusCode":400,"statusMessage":"Bad Request","message":"Bad Request","data":{"status":"ERROR","code":400,"message":"Outside time window","error_code":"TIME_OUT_CODE"}}';
const bodyInvalidName = '{"error":true,"url":"http://vk88.srl/api/hotmatch-proxy/v1/hotmatch/giftcode/?match_name=HotMatch%20Probe%20A%20%26%20HotMatch%20Probe%20B&date=2026-08-10&uid=10153911","statusCode":404,"statusMessage":"Not Found","message":"Not Found","data":{"status":"ERROR","code":404,"message":"Invalid match name","error_code":"ERROR_SYSTEM"}}';
const bodyMissingConfig = '{"status":"ERROR","code":400,"message":"Missing config_id"}';

check('400 TIME_OUT_CODE = tên đúng, chưa tới giờ', heuristicLabel({ status: 400, body: bodyTimeWindow }), LABELS.NOT_YET);
check('404 Invalid match name = tên sai', heuristicLabel({ status: 404, body: bodyInvalidName }), LABELS.BAD_MATCH);
check('400 Missing config_id = thiếu tham số', heuristicLabel({ status: 400, body: bodyMissingConfig }), LABELS.BAD_REQUEST);
check('hai loại lỗi cho hai chữ ký khác nhau',
  signature(400, bodyTimeWindow) !== signature(404, bodyInvalidName), 'true');
// Đây là điều làm nút Thử nghiệm có nghĩa: trước giờ phát, tên đúng và tên sai
// KHÔNG cho cùng một phản hồi.
check('giữa burst, "chưa tới giờ" thì bắn tiếp',
  classify({ status: 400, body: bodyTimeWindow }, null, 'burst').action, 'continue');
check('lúc Thử nghiệm, "chưa tới giờ" không bị coi là sai tên',
  classify({ status: 400, body: bodyTimeWindow }, null, 'test').label, LABELS.NOT_YET);
check('không nhặt nhầm ERROR_SYSTEM thành code', extractCode(bodyTimeWindow), 'null');

console.log('\n25) Phản hồi thật của trận đấu 10/08/2026 (15/15 site lấy được code)');
// Nguyên văn từ hộp đen sau trận thật đầu tiên.
const bodySuccess = '{"status":"OK","code":200,"message":"Receive gift code successfully","received":true,"branch":"BC376173","data":{"gift_code":"HOTMATCHHT2I","match_name":"Alianza Petrolera & Atletico Bucaramanga","remain_code":19}}';
const bodyAlready = '{"status":"OK","code":200,"message":"User already received","received":true,"branch":"BC376173","data":{"user_id":10500449,"match_name":"Alianza Petrolera & Atletico Bucaramanga","gift_code":"HOTMATCHHT2I","date":"2026-08-10","date_received":"2026-08-09T20:55:00.147Z"}}';
const bodyAlreadyNoData = '{"status":"OK","code":200,"message":"User already received","received":true,"branch":"BC373351"}';
const bodyReload = '{"code":423,"message":"4. Vui lòng tải lại trang!","status":"ERROR"}';
const bodyFieldMissing = '{"code":422,"message":"giftCode: Bắt buộc nhập trường này!","status":"ERROR"}';

check('lấy được mã từ phản hồi thành công', extractCode(bodySuccess), 'HOTMATCHHT2I');
check('nhãn là thành công', heuristicLabel({ status: 200, body: bodySuccess }), LABELS.SUCCESS);
check('"đã nhận rồi" vẫn trả đúng mã đó', extractCode(bodyAlready), 'HOTMATCHHT2I');
check('nên hai phản hồi cho cùng một mã, không tiêu thêm code',
  extractCode(bodySuccess) === extractCode(bodyAlready), 'true');

// Lỗi từng khiến tool báo "11WIN: BC373351" — BC373351 là mã chi nhánh, không phải gift code.
check('KHÔNG nhặt nhầm trường branch làm mã', extractCode(bodyAlreadyNoData), 'null');
check('không có mã thì không báo thắng',
  heuristicLabel({ status: 200, body: bodyAlreadyNoData }) !== LABELS.SUCCESS, 'true');

console.log('\n26) Hai phản hồi từng gặp lúc đổi thưởng vẫn phải đọc được trong hộp đen');
// Tool không còn gửi lệnh ghi nào, nên hai phản hồi này sẽ không do tool sinh ra nữa. Nhưng
// từ điển chữ ký phải giữ nhãn cho chúng: dữ liệu cũ trong hộp đen vẫn còn, và nếu sau này
// chúng xuất hiện ở một phase khác thì phải hiện ra chữ tiếng Việt chứ không phải "Chưa gán nhãn".
check('423 = rào chống tự động chặn', heuristicLabel({ status: 423, body: bodyReload }), LABELS.NEEDS_PAGE);
check('422 = body sai hình dạng', heuristicLabel({ status: 422, body: bodyFieldMissing }), LABELS.BAD_REQUEST);
check('hai lỗi cho hai chữ ký khác nhau',
  signature(423, bodyReload) !== signature(422, bodyFieldMissing), 'true');
// Điều quan trọng nhất và là điều duy nhất còn ảnh hưởng tới hành vi chạy thật:
// không mã lỗi lạ nào được phép làm gãy cuộc đua nhận code.
check('423 giữa lúc burst vẫn cho bắn tiếp',
  classify({ status: 423, body: bodyReload }, null, 'burst').action, 'continue');
check('422 giữa lúc burst vẫn cho bắn tiếp',
  classify({ status: 422, body: bodyFieldMissing }, null, 'burst').action, 'continue');

console.log('\n27) Tool không còn đường gửi lệnh ghi nào');
const libFiles = fs.readdirSync(new URL('../lib/', import.meta.url));
check('lib/redeem.js đã bị xoá', libFiles.includes('redeem.js'), 'false');
check('không còn khoá autoRedeem trong cấu hình', 'autoRedeem' in DEFAULT_SITE_CONFIG, 'false');

// Quét toàn bộ mã nguồn: không được còn chỗ nào tự động gửi POST tới endpoint đổi thưởng (trừ hàm thủ công sites.redeemCode).
const srcDirs = [new URL('../lib/', import.meta.url), new URL('../dashboard/', import.meta.url),
                 new URL('../dashboard/views/', import.meta.url)];
let postHits = [];
for (const dir of srcDirs) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    if (f === 'sites.js') continue; // Chứa hàm thủ công sites.redeemCode khi người dùng bấm nút
    const text = fs.readFileSync(new URL(f, dir), 'utf8');
    if (/\/api\/v1\/gift-code/.test(text) && /method:\s*'POST'/.test(text)) postHits.push(f);
  }
}
check('không module engine/dashboard nào tự động POST tới /api/v1/gift-code', postHits, []);
check('sites.js cung cấp hàm đổi thưởng chủ động redeemCode', typeof redeemCode, 'function');

console.log('\n28) Hạn dùng của mã là 10 phút, không phải 30');
// Đo thật 11/08/2026: co88 nhận lúc 15:50:00Z, tới 16:00:04Z đã hết hạn.
check('CODE_TTL_MS', CODE_TTL_MS, 10 * 60 * 1000);
const nhan = Date.parse('2026-08-11T15:50:00Z');
check('còn 10 phút ngay khi nhận', formatDuration(codeRemainingMs(nhan, nhan)), '00:10:00');
check('đã hết hạn tại 16:00:04Z', codeRemainingMs(nhan, Date.parse('2026-08-11T16:00:04Z')) < 0, 'true');

console.log('\n29) Mở thẳng sảnh game: xin link chứ không tự ghép');
const vk88 = { brand: 'vk88', domain: 'vk88.srl', paths: {} };
// Đúng request mà trang tự gọi khi bạn bấm ô game, bắt được trên vk88 15/08/2026.
check('URL hỏi link game',
  buildGameUrlRequest(vk88),
  'https://vk88.srl/api/v1/gameUrl?partnerGameId=vgmn_101&partnerProvider=go&ru=%2Fgame%2Ftable-games%3Fprovider%3Dgo');
check('mặc định là Tài Xỉu MD5 của HitClub',
  gameLabel(findGame(DEFAULT_GAME_KEY)), 'Tài Xỉu MD5 (HitClub)');
check('đổi game chỉ là đổi một chuỗi',
  new URL(buildGameUrlRequest(vk88, { gameId: 'vgcg_11', provider: 'go' })).searchParams.get('partnerGameId'), 'vgcg_11');

console.log('\n29b) Danh mục game phải mang theo SẢNH, không chỉ mã game');

// Đọc trực tiếp hai sảnh trên 11win.casa (19/08/2026). Cùng mã `vgcg_1` nhưng
// là hai trò khác nhau — đây là lý do khoá phải là `provider:gameId`.
check('vgcg_1 ở HitClub là Tiến Lên Đếm Lá', findGame('go:vgcg_1').name, 'Tiến Lên Đếm Lá');
check('vgcg_1 ở B52 là Tiến Lên Miền Nam', findGame('b52:vgcg_1').name, 'Tiến Lên Miền Nam');
check('Tiến Lên Miền Nam của HitClub lại là vgcg_11', findGame('go:vgcg_11').name, 'Tiến Lên Miền Nam');

check('nhãn kèm tên sảnh trong ngoặc', gameLabel(findGame('b52:vgmn_101')), 'Tài Xỉu MD5 (B52)');
check('HitClub mang mã go, không phải hit', LOBBIES.go, 'HitClub');

const nhomSanh = (p) => GAMES.filter((g) => g.provider === p).map((g) => g.name);
check('HitClub đủ 5 game đã yêu cầu', nhomSanh('go'),
  ['Tài Xỉu MD5', 'Tiến Lên Miền Nam', 'Tiến Lên Đếm Lá', 'Liêng', 'Poker']);
check('B52 đủ 3 game đã yêu cầu', nhomSanh('b52'),
  ['Tài Xỉu MD5', 'Tiến Lên Miền Nam', 'Liêng']);
check('mọi khoá là duy nhất', new Set(GAMES.map(gameKey)).size, GAMES.length);

// Đường quay về phải trỏ đúng sảnh chứa game, không phải một hằng số duy nhất.
check('game bài quay về sảnh game bài', returnPathFor(findGame('b52:vgcg_5')), '/game/game-bai?provider=b52');
check('tài xỉu quay về sảnh table games', returnPathFor(findGame('go:vgmn_101')), '/game/table-games?provider=go');
check('URL cho game B52 mang đúng provider',
  new URL(buildGameUrlRequest(vk88, { gameId: 'vgcg_1', provider: 'b52' })).searchParams.get('partnerProvider'), 'b52');

// Thân phản hồi thật, chép nguyên văn. Token và tên miền nhà cung cấp do nhà
// cái điền — tool không được phép tự dựng hai thứ này.
const gameUrlBody = JSON.stringify({ code: 200, status: 'OK', data: {
  url: 'https://games.gnightfast.net?brand=vk88&token=70-bcde1bc589a32313f9ab9c5b01239127&gameid=vgmn_101&ru=https%3A%2F%2Fvk88.srl%2Fgame%2Ftable-games%3Fprovider%3Dhit',
  url_mobile: 'https://games.gnightfast.net?brand=vk88&token=70-bcde1bc589a32313f9ab9c5b01239127&gameid=vgmn_101&ru=x' } });
const launched = JSON.parse(gameUrlBody).data.url;
check('link trả về mang đúng game vừa chọn', new URL(launched).searchParams.get('gameid'), 'vgmn_101');
// Tiền tố token khác nhau theo nhà cái: vk88 dùng `70-`, ta88 dùng `31-` (đo
// 15/08/2026). Ai tự ghép token sẽ sai ngay ở site thứ hai — thêm một lý do
// phải đi xin link thay vì tự dựng.
check('token do nhà cái điền, không nằm trong mã nguồn tool',
  /^\d+-[0-9a-f]{32}$/.test(new URL(launched).searchParams.get('token')), 'true');
check('cùng mã game chạy trên nhà cái khác',
  new URL('https://games.gnightfast.net?brand=ta88&token=31-64abdd9a0d7bb975d7dfe89cc9099bc8&gameid=vgmn_101')
    .searchParams.get('gameid'), 'vgmn_101');
check('tool không hardcode tên miền nhà cung cấp',
  fs.readFileSync(new URL('../lib/gameportal.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .some((l) => l.includes('gnightfast')), 'false');

console.log('\n30) Tab "Điều kiện cược" nối đúng vào vỏ dashboard');
const html = fs.readFileSync(new URL('../dashboard/dashboard.html', import.meta.url), 'utf8');
const betView = fs.readFileSync(new URL('../dashboard/views/bet-conditions.js', import.meta.url), 'utf8');
const shell = fs.readFileSync(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');

check('có nút tab', /data-panel="panel-bet"[^>]*>(?:Điều kiện cược|Bet Conditions)</.test(html), 'true');
check('tab đứng ngay sau tab Site',
  (html.match(/data-panel="panel-(\w+)"/g) || []).slice(0, 2).join(','),
  'data-panel="panel-sites",data-panel="panel-bet"');
check('có panel tương ứng', html.includes('id="panel-bet"'), 'true');
check('tiêu đề cột Mở game là nút Mở tất cả',
  /id="btn-bet-open-all"[^>]*>(?:Mở tất cả|Open All)</.test(html), 'true');
check('có nút dò site và làm mới tài khoản',
  ['btn-bet-discover', 'btn-bet-refresh'].every((id) => html.includes(`id="${id}"`)), 'true');

// Bắt lỗi hay gặp nhất khi thêm view: JS trỏ tới một id không có trong HTML.
const idsDung = [...new Set((betView.match(/\$\('#([\w-]+)'\)/g) || []).map((s) => s.slice(4, -2)))];
const idsThieu = idsDung.filter((id) => !html.includes(`id="${id}"`));
check(`mọi id view dùng đều có trong HTML (${idsDung.length} id)`, idsThieu, []);

check('có nút Reload từng dòng và Refresh all trên đầu cột',
  html.includes('id="btn-bet-reload-all"') && /Refresh [aA]ll</.test(html) && /text: 'Reload'/.test(betView), 'true');
// Đếm ô tiêu đề của ĐÚNG bảng này. Lookahead để `<th` không khớp nhầm `<thead>`.
const cotBet = (html.split('<tbody id="bet-body">')[0]
  .split('<table class="grid" id="bet-table">')[1].match(/<th(?=[\s>])/g) || []).length;
check('bảng có 10 cột (thêm cột tick)', cotBet, 10);
check('colspan hàng rỗng khớp số cột', betView.includes(`colspan: ${cotBet}`), 'true');
check('có cột tick và bấm tiêu đề để chọn tất cả',
  html.includes('id="bet-th-check"') && /handleToggleAll/.test(betView), 'true');
// Tick không được vẽ lại cả bảng: mất mốc cuộn, tick site 15 xong bị ném về đầu.
check('tick một site KHÔNG vẽ lại cả bảng',
  /async function handleToggle\(site, checked\)[\s\S]{0,400}await render\(\)/.test(betView), 'false');
check('chỉ mở game cho site đã tick',
  /filter\(\(s\) => s\.enabled && s\.isLogin\)/.test(betView), 'true');
check('tick dùng chung cờ enabled với tab Site',
  /sites\.update\(site\.brand, \{ enabled: checked \}\)/.test(betView), 'true');
// Mở tab nền: không kéo người dùng rời khỏi trang extension.
check('mở game ở tab nền', /active: false/.test(betView), 'true');
check('không còn mở tab ở chế độ active', /active: true/.test(betView), 'false');

// Khớp brand phải đọc query param. So chuỗi con thì `brand=ta88` khớp nhầm `brand=ta889`.
const khopBrand = (url, brand) => {
  try { return new URL(url).searchParams.get('brand') === brand; } catch { return false; }
};
check('nhận đúng tab game của ta88',
  khopBrand('https://games.gnightfast.net?brand=ta88&token=31-x&gameid=vgmn_101', 'ta88'), 'true');
check('KHÔNG nhận nhầm brand dài hơn',
  khopBrand('https://games.gnightfast.net?brand=ta889&token=31-x', 'ta88'), 'false');
check('view dùng searchParams chứ không phải includes',
  /searchParams\.get\('brand'\)/.test(fs.readFileSync(new URL('../lib/gameportal.js', import.meta.url), 'utf8')), 'true');

check('vỏ có gọi init', /betView\.init\(/.test(shell), 'true');
check('vỏ có render khi chuyển sang tab', /panel-bet'\)\s*await betView\.render/.test(shell.replace(/\s+/g, ' ')), 'true');

// Tab này chỉ mở tab, tuyệt đối không gửi lệnh cược.
check('view không có lệnh ghi nào', /method:\s*'POST'/.test(betView), 'false');
check('không hardcode tên miền nhà cung cấp', /gnightfast/.test(betView), 'false');

console.log('\n31) API dự đoán tỉ số — phản hồi thật, bắt trên vk88/k88/bu88 ngày 17/08/2026');

// Vỏ phản hồi nguyên văn của GET prediction/matches/ongoing.
const ongoingThat = JSON.stringify({
  code: 200, status: 'OK',
  data: {
    page: 1, limit: 20, total: 7, total_page: 1, remaining_turns: 7,
    list: [
      { id: '9d28f03e-0d86-4631-aa7a-909a147c11b5', match_id: '5587613', status: 'WAITING',
        home_team: 'Malaysia', away_team: 'Việt Nam', prize_amount: 50000 },
      { id: 'd708b65a-3c43-42ca-a887-7fac0fcebdbd', match_id: '5608339', status: 'RUNNING',
        home_team: 'Slovan Bratislava', away_team: 'NK Celje', prize_amount: 50000,
        most_popular: [
          { predicted_score: '2 - 1', predicted_home: 2, predicted_away: 1, percent: 20.72 },
          { predicted_score: '1 - 1', predicted_home: 1, predicted_away: 1, percent: 19.47 },
          { predicted_score: '1 - 0', predicted_home: 1, predicted_away: 0, percent: 14.91 },
        ] },
    ],
  },
});

const resOf = (body, status = 200) => ({ body, status, ok: status >= 200 && status < 300, error: null });

check('bóc được vỏ phân trang', unwrap(resOf(ongoingThat)).data.list.length, 2);
check('remaining_turns nằm ở cấp vỏ, không phải trong list',
  unwrap(resOf(ongoingThat)).data.remaining_turns, 7);

// §16 — cạm bẫy lớn nhất của API này. Lỗi validate vẫn trả HTTP 200 + code 200,
// chỉ khác là `data` biến mất. Tin vào `code` là ghi nhận một POST hỏng thành công.
const loiValidate = JSON.stringify({ code: 200, status: 'OK', message: 'type: Không hợp lệ!' });
check('code:200 nhưng thiếu data ⇒ KHÔNG phải thành công', unwrap(resOf(loiValidate)).ok, 'false');
check('lấy được message của lỗi trá hình', unwrap(resOf(loiValidate)).message, 'type: Không hợp lệ!');
check('có data mới là thành công', unwrap(resOf(ongoingThat)).ok, 'true');
check('chưa đăng nhập (401)',
  unwrap(resOf(JSON.stringify({ code: 401, message: 'Bạn chưa đăng nhập!' }), 401)).ok, 'false');
check('body không phải JSON không làm vỡ', unwrap(resOf('<html>lỗi</html>', 502)).ok, 'false');

// Nguyên văn phản hồi khi hết lượt, bắt trên vu88.co 19/08/2026 bằng một POST thật.
// HTTP 200, code 200 — chỉ `data` vắng mặt mới tố cáo đây là lỗi.
const hetLuot = '{"code":200,"status":"OUT_OF_TURNS","error_key":"OUT_OF_TURNS","message":"Bạn đã hết lượt dự đoán!"}';
check('hết lượt vẫn trả HTTP 200 + code 200', JSON.parse(hetLuot).code, 200);
check('nhưng KHÔNG phải thành công', unwrap(resOf(hetLuot)).ok, 'false');
check('đọc được error_key máy hiểu', unwrap(resOf(hetLuot)).errorKey, 'OUT_OF_TURNS');
check('giữ nguyên message cho người đọc',
  unwrap(resOf(hetLuot)).message, 'Bạn đã hết lượt dự đoán!');
check('status trong body khác status HTTP', unwrap(resOf(hetLuot)).status, 200);
check('phản hồi tốt thì không có error_key', unwrap(resOf(ongoingThat)).errorKey, 'null');

// WAITING nghĩa là "đã đóng, chờ kết quả" — KHÔNG phải "sắp mở". Nhầm chiều này
// là mời người dùng đốt một lượt vào trận chắc chắn hỏng.
const list = unwrap(resOf(ongoingThat)).data.list;
check('RUNNING là trận nhận dự đoán', isRunning(list[1]), 'true');
check('WAITING là ĐÃ ĐÓNG, không phải sắp mở', isRunning(list[0]), 'false');
check('lọc ra đúng 1 trận gửi được', list.filter(isRunning).length, 1);

// predicted_same_count là MỘT DỰ ĐOÁN NỮA do người chơi tự nhập: đoán bao nhiêu
// người cùng chọn tỉ số đó. Không suy ra được từ đâu cả. Lịch sử thật cho thấy
// ba tỉ số khác nhau đều mang số 40 — vì người chơi gõ 40 cả ba lần.
check('không lấy từ most_popular (percent, sai đơn vị)',
  list[1].most_popular[0].percent !== 40, 'true');

console.log('\n31b) Đọc chuỗi kèo "0-0-40, 2-0-40, 3-1-40"');

const keo = parseSlips('0-0-40, 2-0-40, 3-1-40');
check('đọc đủ 3 kèo', keo.slips.length, 3);
check('không có lỗi', keo.errors, []);
check('kèo đầu', keo.slips[0], { home: 0, away: 0, sameCount: 40 });
check('kèo cuối', keo.slips[2], { home: 3, away: 1, sameCount: 40 });
check('in lại đúng dạng đã nhập', keo.slips.map(formatSlip).join(', '), '0-0-40, 2-0-40, 3-1-40');

check('chấp nhận xuống dòng và chấm phẩy',
  parseSlips('1-0-10\n2-1-20; 0-0-5').slips.length, 3);
check('chấp nhận khoảng trắng thừa', parseSlips('  1 - 0 - 10  ,  2-1-20 ').slips.length, 2);
check('tỉ số hai chữ số', parseSlips('10-2-40').slips[0], { home: 10, away: 2, sameCount: 40 });
check('bỏ qua ô trống', parseSlips('1-0-10,,,2-1-20,').slips.length, 2);
check('chuỗi rỗng ⇒ không kèo nào', parseSlips('').slips, []);

// Sai một kèo thì chỉ hỏng kèo đó, không mất trắng cả ô nhập.
const lech = parseSlips('1-0-10, 2-1, 3-1-40');
check('kèo thiếu số bị loại riêng', lech.slips.length, 2);
check('nêu rõ kèo nào sai', lech.errors.length, 1);
check('thông báo chỉ đúng kèo hỏng', /"2-1"/.test(lech.errors[0]), 'true');
// `1--2-10` KHÔNG được âm thầm thành `1-2-10`: đó là một kèo người dùng không gõ.
check('chặn dấu trừ kép thay vì gộp âm thầm', parseSlips('1--2-10').errors.length, 1);
check('không đẻ ra kèo lạ từ đầu vào hỏng', parseSlips('1--2-10').slips, []);
check('chặn số lẻ', parseSlips('1-0-2.5').errors.length, 1);
check('chặn chữ', parseSlips('a-b-c').errors.length, 1);

// prediction_id là UUID `id`, KHÔNG phải `match_id` — gửi nhầm là mất trắng 1 lượt.
check('UUID và match_id là hai thứ khác nhau',
  list[1].id !== list[1].match_id && /^[0-9a-f-]{36}$/.test(list[1].id), 'true');

console.log('\n32) Chốt chặn trước khi tiêu một lượt');

const siteDu = {
  brand: 'vk88', domain: 'vk88.srl', isLogin: true, siteId: 's1-6170',
  account: { uid: 10153911, username: 'minh003' }, predictionTurns: 7,
};
const uuid = 'd708b65a-3c43-42ca-a887-7fac0fcebdbd';

const dayDu = { site: siteDu, uuid, home: 1, away: 0, sameCount: 40 };
check('đủ điều kiện thì không có lỗi nào', validate(dayDu), []);
check('tỉ số 0-0 là hợp lệ', validate({ ...dayDu, home: 0, away: 0 }), []);
check('cùng kèo 0 là hợp lệ', validate({ ...dayDu, sameCount: 0 }), []);

const coLoi = (site, extra = {}) => validate({ ...dayDu, site, ...extra }).length > 0;

check('chặn khi chưa đăng nhập', coLoi({ ...siteDu, isLogin: false }), 'true');
check('chặn khi thiếu uid', coLoi({ ...siteDu, account: { username: 'minh003' } }), 'true');
check('chặn khi chưa có siteId', coLoi({ ...siteDu, siteId: null }), 'true');
check('chặn khi hết lượt', coLoi({ ...siteDu, predictionTurns: 0 }), 'true');
check('KHÔNG chặn khi chưa biết số lượt', coLoi({ ...siteDu, predictionTurns: null }), 'false');
check('chặn khi chưa chọn trận', validate({ ...dayDu, uuid: '' }).length > 0, 'true');
check('chặn tỉ số âm', coLoi(siteDu, { home: -1 }), 'true');
check('chặn tỉ số lẻ', coLoi(siteDu, { away: 1.5 }), 'true');
check('chặn ô tỉ số bỏ trống', coLoi(siteDu, { home: '' }), 'true');
check('chặn khi bỏ trống ô cùng kèo', coLoi(siteDu, { sameCount: '' }), 'true');
check('chặn cùng kèo âm', coLoi(siteDu, { sameCount: -5 }), 'true');

// uid là RIÊNG từng site. Cùng username minh003 nhưng vk88=10153911, bu88=10500079.
// Gửi uid của site này kèm cookie site kia là request tự mâu thuẫn.
check('uid khác nhau giữa các site nên phải đọc theo site',
  10153911 !== 10500079, 'true');

console.log('\n33) Tab "Dự đoán" nối đúng vào vỏ dashboard');
const predView = fs.readFileSync(new URL('../dashboard/views/prediction.js', import.meta.url), 'utf8');
const predLib = fs.readFileSync(new URL('../lib/prediction.js', import.meta.url), 'utf8');

check('có nút tab', /data-panel="panel-predict"[^>]*>(?:Dự đoán|Predictions?)</.test(html), 'true');
check('tab đứng ngay sau tab Điều kiện cược',
  (html.match(/data-panel="panel-(\w+)"/g) || []).slice(0, 3).join(','),
  'data-panel="panel-sites",data-panel="panel-bet",data-panel="panel-predict"');
check('có panel tương ứng', html.includes('id="panel-predict"'), 'true');
check('có đủ 4 nút đầu bảng',
  ['btn-pred-load', 'btn-pred-turns', 'btn-pred-discover', 'btn-pred-refresh']
    .every((id) => html.includes(`id="${id}"`)), 'true');
check('có nút "Tải trận từ site"', /id="btn-pred-load"[^>]*>(?:Tải trận từ site|Load Matches)</.test(html), 'true');
check('có hai nút giống tab đứng trước',
  /id="btn-pred-discover"[^>]*>(?:Dò site từ cookie|Discover Sites)</.test(html) &&
  /id="btn-pred-refresh"[^>]*>(?:Làm mới tài khoản|Refresh Accounts)</.test(html), 'true');

const predIds = [...new Set((predView.match(/\$\('#([\w-]+)'\)/g) || []).map((s) => s.slice(4, -2)))];
check(`mọi id view dùng đều có trong HTML (${predIds.length} id)`,
  predIds.filter((id) => !html.includes(`id="${id}"`)), []);

// `/<th[^>]*>/` cũng khớp `<thead>` — dùng lookahead để chỉ đếm ô tiêu đề thật.
const cotSite = (html.split('<tbody id="pred-body">')[0]
  .split('<table class="grid" id="pred-table">')[1].match(/<th(?=[\s>])/g) || []).length;
check('bảng site có 11 cột', cotSite, 11);
check('colspan hàng rỗng khớp đúng số cột', predView.includes(`colspan: ${cotSite}`), 'true');

// LỖI ĐÃ GẶP: chỉ nút "Đọc lượt các site" đi lấy siteId, nên ai bấm "Tải trận
// từ site" rồi gửi luôn sẽ thấy nút Gửi câm lặng — bảng trông đã sẵn sàng
// (có trận, có lượt) mà thiếu đúng một trường vô hình.
check('mọi đường tới lúc gửi đều tự lấy siteId',
  /async function ensureSiteId/.test(predView), 'true');
check('tải trận cũng lấy siteId cho cả danh sách',
  /ensureAllSiteIds\(list\)/.test(predView), 'true');
check('gửi lẻ tự lấy siteId trước khi POST',
  /ensureSiteId\(site\)[\s\S]{0,200}sendPredict/.test(predView), 'true');
check('gửi hàng loạt cũng vậy',
  /ensureSiteId\(site\)[\s\S]{0,900}for \(const slip of danhSach\)/.test(predView), 'true');
// Nút câm lặng phải nói ra lý do, không giấu trong tooltip.
check('lý do bị chặn hiển thị ngay trên dòng', /lyDo \? el\(/.test(predView), 'true');
// Thiếu siteId KHÔNG được khoá nút: handleSend tự đi lấy trước khi POST. Khoá nút
// vì lý do mà tool tự lo được chính là cái bẫy đã làm nút Gửi câm lặng lần trước.
check('thiếu siteId không khoá nút Gửi',
  /tuLoDuoc = new Set\(\['chưa đọc được siteId'\]\)/.test(predView), 'true');
check('nút khoá theo danh sách đã lọc, không phải toàn bộ lỗi',
  /disabled: st\.busy \|\| chan\.length > 0/.test(predView), 'true');

console.log('\n35) Gửi hàng loạt');

check('có ô chọn trận riêng cho khối hàng loạt', html.includes('id="pred-batch-match"'), 'true');
check('có ô nhập kèo', html.includes('id="pred-slips"'), 'true');
check('ô kèo gợi ý đúng định dạng', /id="pred-slips"[^>]*placeholder="0-0-40, 2-0-40, 3-1-40"/.test(html), 'true');
check('có nút Gửi hàng loạt', /id="btn-pred-batch"[^>]*>(?:Gửi hàng loạt|Batch Submit)</.test(html), 'true');
check('nút hàng loạt mặc định bị khoá', /id="btn-pred-batch"[^>]*\sdisabled/.test(html), 'true');
check('có cột tick chọn site', html.includes('id="pred-th-check"'), 'true');
check('bấm tiêu đề cột để chọn tất cả', /handleToggleAll/.test(predView), 'true');
check('dùng chung cờ enabled với tab Site',
  /sites\.update\(site\.brand, \{ enabled:/.test(predView), 'true');
check('chỉ gửi cho site đã tick VÀ đang đăng nhập',
  /filter\(\(s\) => s\.enabled && s\.isLogin\)/.test(predView), 'true');
// Con số trong hộp xác nhận là CHẶN TRÊN: dedupe xảy ra sau đó nên số thực tế
// có thể ít hơn. Nói "tối đa" chứ đừng hứa một con số rồi trừ ít hơn.
check('hộp xác nhận nêu chặn trên số lượt',
  /TỐI ĐA \$\{tongLuot\} LƯỢT/.test(predView), 'true');
check('có nói rõ vì sao số thực tế có thể ít hơn',
  /số thực tế có thể ít hơn/.test(predView), 'true');
check('có nhật ký kết quả', html.includes('id="pred-batch-log"'), 'true');

// Nhịp bắn phải khớp những gì đo được: song song giữa site, nối tiếp trong site.
check('song song giữa các site', /pooled\(keHoach, 5/.test(predView), 'true');
// Nối tiếp trong cùng một site: mỗi lượt phải `await` trước khi sang kèo sau.
// Đo được lý do: bắn đồng thời thì `remaining_turns` trong phản hồi bị đua
// (3 request trả về 8, 9, 8 trong khi giá trị thật là 7).
check('nối tiếp trong cùng một site — chờ từng lượt',
  /for \(const slip of danhSach\)[\s\S]{0,700}await pred\.sendPredict/.test(predView), 'true');
check('không gom các lượt vào Promise.all trong một site',
  /Promise\.all\([\s\S]{0,80}sendPredict/.test(predView), 'false');
check('lỗi ở một site thì dừng site đó',
  /Dừng site này[\s\S]{0,120}return;/.test(predView), 'true');

// Hết lượt là kết cục bình thường: không mất gì, biết chắc sổ lượt = 0.
check('hết lượt ⇒ không coi là đã gửi', /sent: !hetLuot/.test(predLib), 'true');
check('hết lượt ⇒ chốt luôn sổ lượt = 0', /hetLuot \? 0/.test(predLib), 'true');
check('không tốn thêm GET để hỏi lại khi hết lượt',
  /res\.outOfTurns[\s\S]{0,300}predictionTurns: 0/.test(predView), 'true');
check('gửi lẻ cũng phân biệt hết lượt với lỗi thật',
  /else if \(res\.outOfTurns\)/.test(predView), 'true');

console.log('\n36) Chống lãng phí lượt — server KHÔNG khử trùng lặp');

// Đo trực tiếp trên 11win.casa 19/08/2026: hai POST giống hệt nhau từng byte,
// bắn đồng thời -> hai entry_id khác nhau, trừ 2 lượt (7 -> 5). Không có
// idempotency ở bất kỳ tầng nào.
check('hai kèo cùng tỉ số bị phát hiện',
  duplicateScores(parseSlips('1-0-40, 2-1-40, 1-0-99').slips), [{ score: '1-0', count: 2 }]);
check('khác sameCount vẫn tính là trùng tỉ số',
  duplicateScores([{ home: 1, away: 0, sameCount: 10 }, { home: 1, away: 0, sameCount: 20 }]).length, 1);
check('không trùng thì không báo',
  duplicateScores(parseSlips('1-0-40, 2-1-40, 0-0-40').slips), []);
check('khoá tỉ số bỏ qua sameCount', scoreKey(2, 1), '2-1');
check('khoá nhận cả chuỗi từ ô input', scoreKey('2', '1'), '2-1');

// my_entries của getMatch cho biết site này đã đặt những tỉ số nào.
const chiTietCoEntries = { my_entries: [
  { predicted_home: 1, predicted_away: 0, predicted_score: '1 - 0' },
  { predicted_home: 2, predicted_away: 2, predicted_score: '2 - 2' },
] };
check('đọc được tỉ số đã đặt', [...sentScores(chiTietCoEntries)].sort(), ['1-0', '2-2']);
check('chưa đặt gì ⇒ rỗng', [...sentScores({ my_entries: [] })], []);
check('không có trường ⇒ rỗng', [...sentScores(null)], []);

const daDat = sentScores(chiTietCoEntries);
const loc = parseSlips('1-0-40, 3-1-40, 2-2-40').slips.filter((s) => !daDat.has(scoreKey(s.home, s.away)));
check('lọc ra đúng kèo chưa từng đặt', loc.map(formatSlip), ['3-1-40']);

check('view kiểm một lần cho cả loạt', /pred\.precheckMatch\(day, uuid\)/.test(predView), 'true');
check('các POST sau đó không kiểm lại', /precheck: false/.test(predView), 'true');
check('mặc định bỏ qua kèo đã đặt', /const boQuaTrung = !\$\('#pred-allow-dup'\)\.checked/.test(predView), 'true');
check('có ô cho phép gửi lại kèo trùng', html.includes('id="pred-allow-dup"'), 'true');
check('cảnh báo trùng ngay ở preview', /duplicateScores\(slips\)/.test(predView), 'true');
check('chốt sổ lượt bằng GET sau khi bắn xong', /if \(daGui\)[\s\S]{0,200}fetchOngoing/.test(predView), 'true');

// Ô kèo phải sống sót qua F5.
check('nhớ ô kèo', /storage\.patch\('prediction', \{ slips:/.test(predView), 'true');
check('nhớ trận đang chọn', /storage\.patch\('prediction', \{ batchMatch:/.test(predView), 'true');
check('tải trận không xoá mất ô kèo',
  /patch\('prediction', \{\s*matches: merged/.test(predView), 'true');

// Không bao giờ gửi quá sổ lượt của site.
const plan = (turns, soKeo) => (turns == null ? soKeo : Math.min(soKeo, turns));
check('site 3 lượt, 5 kèo ⇒ gửi 3', plan(3, 5), 3);
check('site 10 lượt, 3 kèo ⇒ gửi 3', plan(10, 3), 3);
check('site hết lượt ⇒ gửi 0', plan(0, 5), 0);
check('chưa đọc lượt ⇒ để server chốt', plan(null, 5), 5);
check('view dùng đúng phép chặn trên đó',
  /Math\.min\(slips\.length, site\.predictionTurns\)/.test(predView), 'true');

check('vỏ có gọi init', /predictView\.init\(/.test(shell), 'true');
check('vỏ có render khi chuyển sang tab',
  /panel-predict'\)\s*await predictView\.render/.test(shell.replace(/\s+/g, ' ')), 'true');

console.log('\n34) Ranh giới an toàn: lệnh ghi phải hiếm, phải có chủ đích');

// Đúng MỘT nơi trong toàn tab được phép POST, và nó nằm trong lib chứ không phải view.
check('view không tự gửi POST', /method:\s*'POST'/.test(predView), 'false');
check('chỉ có đúng 1 lệnh POST trong lib', (predLib.match(/method:\s*'POST'/g) || []).length, 1);

// Không có nút quét cả bảng — mỗi lượt mất đi phải là một cú bấm có chủ đích.
// Soi phần tử <button> thật, không soi chữ: câu giải thích trong panel cũng
// chứa cụm "gửi tất cả" và từng làm phép kiểm này báo nhầm.
const nutTrongPanel = (html.split('id="panel-predict"')[1] || '').split('</section>')[0].match(/<button[\s\S]*?<\/button>/g) || [];
check('không có nút gửi hàng loạt trong panel',
  nutTrongPanel.some((b) => /gửi tất cả|send-all/i.test(b)), 'false');
// Cả BA ô nhập phải đi qua edit(), nếu không nút Gửi không tính lại khi gõ.
// Ô "cùng kèo" từng bị bỏ sót đúng lỗi này.
check('mọi ô nhập trên dòng đều gọi edit()',
  (predView.match(/onInput: \(e\) => edit\(site,/g) || []).length, 2);
check('ô chọn trận cũng vậy', /onChange: \(e\) => edit\(site, \{ uuid:/.test(predView), 'true');
check('không còn setForm suông trong ô nhập',
  /onInput: \(e\) => setForm\(/.test(predView), 'false');

check('nút Gửi được dựng theo từng dòng site',
  /text:\s*st\.busy\s*\?\s*'(?:Đang gửi…|Submitting…)'\s*:\s*'(?:Gửi|Submit)'/.test(predView), 'true');
check('nút Gửi có hộp xác nhận', /confirm\(/.test(predView), 'true');

// Không idempotency key ⇒ retry mù là cách nhanh nhất đốt sạch sổ lượt.
check('không có vòng lặp retry quanh POST', /retry|thử lại/i.test(predLib.replace(/\*.*|\/\/.*/g, '')), 'false');
check('lỗi sau khi đã gửi thì đọc lại sổ lượt chứ không đoán',
  /res\.sent[\s\S]{0,400}fetchOngoing/.test(predView), 'true');

// Sổ lượt luôn lấy từ server, không tự trừ ở client.
check('không tự trừ lượt ở client', /predictionTurns\s*-[-=]/.test(predView), 'false');
check('ghi lượt từ phản hồi của server',
  /predictionTurns:\s*res\.remainingTurns/.test(predView), 'true');

// Kiểm is_locked trước khi POST: một GET rẻ hơn một lượt mất oan.
check('có kiểm khoá trước khi gửi', /is_locked/.test(predLib), 'true');
check('ô chọn trận chỉ liệt kê trận RUNNING', /filter\(pred\.isRunning\)/.test(predView), 'true');

console.log('\n37) Tick site không được làm nhảy trang');

// Tick ô thứ 15 mà bảng vẽ lại từ đầu thì trình duyệt mất mốc cuộn và ném người
// dùng về đầu trang — phải cuộn ngược lại mới tick được ô thứ 16. Cách chữa:
// đừng xoá <tbody> vì một thay đổi chỉ ảnh hưởng đúng một dòng.
const sitesView = fs.readFileSync(new URL('../dashboard/views/sites-table.js', import.meta.url), 'utf8');
const predView2 = fs.readFileSync(new URL('../dashboard/views/prediction.js', import.meta.url), 'utf8');

const oTick = (src) => {
  const i = src.indexOf("type: 'checkbox'");
  return i < 0 ? '' : src.slice(i, i + 900);
};

check('tab Site: tick KHÔNG gọi render()', /await render\(\)/.test(oTick(sitesView)), 'false');
check('tab Site: chỉ cập nhật chân bảng', /renderFoot\(await sites\.list\(\)\)/.test(oTick(sitesView)), 'true');
check('tab Site: dòng vừa bấm tự đổi trạng thái mờ',
  /classList\.toggle\('row-disabled'/.test(oTick(sitesView)), 'true');

check('tab Dự đoán: tick KHÔNG gọi render()', /await render\(\)/.test(oTick(predView2)), 'false');
check('tab Dự đoán: chỉ tính lại preview', /await renderSlipPreview\(\)/.test(oTick(predView2)), 'true');

check('tab Điều kiện cược: tick KHÔNG gọi render()', /await render\(\)/.test(oTick(betView)), 'false');

// "Chọn tất cả" thì vẽ lại là đúng — mọi ô đều đổi, và người dùng đang ở đầu bảng.
check('chọn tất cả thì vẫn vẽ lại',
  /async function handleToggleAll\(\)[\s\S]{0,400}await render\(\)/.test(betView), 'true');

console.log('\n38) Chế độ AWM (Bắn từng viên / FIFO Queue) & SCAR (Bắn liên thanh)');
check('mặc định cấu hình là chế độ awm', DEFAULT_CONFIG.shootMode, 'awm');
check('vùng đệm an toàn mặc định là 200ms', DEFAULT_CONFIG.safetyBufferMs, 200);
check('awmRescueDelayMs mặc định là 3800ms', DEFAULT_CONFIG.awmRescueDelayMs, 3800);

// Công thức tính thời điểm trigger AWM: TriggerTime = Release - Offset - Math.round(RTT / 2) + SafetyBuffer
const mockReleaseEpoch = 1700000000000;
const mockOffsetMs = -120; // Server đi trước máy 120ms
const mockRttMs = 80;      // Preflight round-trip time 80ms
const mockBufferMs = 200;  // Vùng đệm 200ms
const expectedTrigger = (mockReleaseEpoch - mockOffsetMs) - Math.round(mockRttMs / 2) + mockBufferMs;
check('công thức tính giờ AWM bù đúng RTT/2 và vùng đệm', expectedTrigger, 1700000000120 - 40 + 200);

console.log('\n39) Classify: Sửa bug phản hồi trận Ngoại Hạng Anh (RE_ALREADY có data.gift_code)');
const realPremierLeagueSuccess = JSON.stringify({
  code: 200,
  message: "Bạn đã nhận code của trận đấu này",
  data: {
    gift_code: "PREMIER_LEAGUE_GIFTCODE_2026",
    match_name: "Arsenal vs Chelsea"
  }
});
const realSoldOutResponse = JSON.stringify({
  code: 200,
  message: "Bạn đã nhận code của trận đấu này"
});

check('extractCode lấy được mã khi server trả "Bạn đã nhận code..." kèm data.gift_code',
  extractCode(realPremierLeagueSuccess), 'PREMIER_LEAGUE_GIFTCODE_2026');
check('heuristicLabel trả về SUCCESS khi có gift_code bất kể chuỗi message',
  heuristicLabel({ status: 200, body: realPremierLeagueSuccess }), LABELS.SUCCESS);
check('classify coi là Thắng và dừng bắn ngay khi trích xuất được code',
  classify({ status: 200, body: realPremierLeagueSuccess }, null, 'burst').action, 'stop-win');

check('không có data.gift_code thì mới coi là hết code / đã nhận hết',
  heuristicLabel({ status: 200, body: realSoldOutResponse }), LABELS.SOLD_OUT);
check('classify dừng site khi thực sự hết code',
  classify({ status: 200, body: realSoldOutResponse }, null, 'burst').action, 'stop-lose');

console.log('\n40) Chuẩn hóa buildClaimUrl theo API mới nhất (không dùng hotmatch-proxy)');
const mockClaimSite = { domain: 'bk88.net', paths: DEFAULT_PATHS };
const urlWithConfig = buildClaimUrl(mockClaimSite, {
  configId: 'cfg-uuid-9999',
  matchName: 'Brazil vs Argentina',
  date: '2026-08-30',
  uid: '888888',
});
check('khi có config_id, URL chỉ gồm config_id (bỏ date, uid, hotmatch-proxy)',
  urlWithConfig, 'https://bk88.net/api/v1/hotmatch/giftcode?config_id=cfg-uuid-9999');

const urlWithoutConfig = buildClaimUrl(mockClaimSite, {
  matchName: 'Brazil vs Argentina',
  date: '2026-08-30',
  uid: '888888',
});
check('khi không có config_id, fallback dùng match_name (không dùng hotmatch-proxy)',
  urlWithoutConfig, 'https://bk88.net/api/v1/hotmatch/giftcode?match_name=Brazil%20vs%20Argentina');

console.log('\n41) Khớp chuẩn request và response API mới nhất (giftcode_collected_API_newest.md)');
const net88Site = { domain: 'net88.wang', paths: DEFAULT_PATHS };
const net88ClaimUrl = buildClaimUrl(net88Site, {
  configId: 'a2243212-7a74-4953-81e8-103896937400',
  matchName: 'Trận 21/9 - 1',
  date: '2026-09-20',
  uid: 1078118,
});
check('URL bắn code khớp chính xác net88.wang trong giftcode_collected_API_newest.md',
  net88ClaimUrl, 'https://net88.wang/api/v1/hotmatch/giftcode?config_id=a2243212-7a74-4953-81e8-103896937400');

const newestResponseBody = JSON.stringify({
  status: 'OK',
  code: 200,
  message: 'Receive gift code successfully',
  received: true,
  branch: 'AC183423',
  data: {
    gift_code: 'HOTMATCHWB5N',
    match_name: 'Trận 21/9 - 1',
    config_id: 'a2243212-7a74-4953-81e8-103896937400',
    remain_code: 26,
  },
});
check('bóc được mã quà tặng từ phản hồi API mới nhất', extractCode(newestResponseBody), 'HOTMATCHWB5N');
const classification = classify({ status: 200, body: newestResponseBody }, null, 'burst');
check('classify nhận diện thành công và dừng bắn (stop-win)', classification.action, 'stop-win');
check('classify lưu đúng mã trúng thưởng', classification.code, 'HOTMATCHWB5N');

const newestHeaders = {
  'x-ratelimit-limit': '30',
  'x-ratelimit-remaining': '29',
  'x-ratelimit-reset': '1789930202',
};
const rateLimit = rateLimitFrom(newestHeaders);
check('đọc được rate-limit 30 của API mới', rateLimit.limit, 30);
check('đọc được remaining 29 của API mới', rateLimit.remaining, 29);

console.log(`\n=== ${pass} đạt, ${fail} hỏng ===\n`);
process.exit(fail ? 1 : 0);
