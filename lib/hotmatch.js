/**
 * Client cho API sự kiện thật.
 *
 * Endpoint đã xác minh trên site thật (vk88.srl, 09/08/2026):
 *   GET /api/hotmatch-proxy/v1/hotmatch/leagues-wc?uid=<uid>
 *
 * Nó trả về đúng những thứ trước đây phải gõ tay hoặc phải đoán:
 *   match_name       chuỗi API nhận code cần, nguyên văn từ server
 *   text_time        giờ bóng lăn (ISO, UTC)
 *   remaining_codes  số code còn lại, cập nhật theo thời gian thực
 *   received         tài khoản này đã nhận code của trận đó chưa
 *   gift_code        mã đã nhận, nếu có
 *
 * Nhờ endpoint này, rủi ro gõ sai tên trận biến mất hoàn toàn.
 */

import { vnDateString } from './vn-time.js';
import { matchId, SEPARATOR } from './match.js';
import * as sites from './sites.js';
import { request } from './net.js';

export const LEAGUES_PATH = '/api/hotmatch-proxy/v1/hotmatch/leagues-wc';
export const DIRECT_LEAGUES_PATH = '/api/v1/hotmatch/leagues-wc';

/**
 * Code được phát trước giờ bóng lăn 10 phút.
 *
 * Đo trực tiếp trên site thật: `valid_from` trong API bằng đúng `text_time`
 * (giờ bóng lăn), nhưng đồng hồ đếm ngược hiển thị trên trang lúc đó là
 * 18:07:20 trong khi khoảng cách tới `valid_from` là 18:17:20 — lệch đúng
 * 10 phút 00 giây. Trang tự trừ 10 phút; con số này không có trong API.
 */
export const RELEASE_OFFSET_MIN = 10;

/** Mã lỗi server dùng khi tên trận đúng nhưng chưa tới giờ phát. */
export const ERR_TIME_WINDOW = 'TIME_OUT_CODE';

function splitName(matchName) {
  const idx = matchName.indexOf(SEPARATOR);
  if (idx < 0) return { home: matchName, away: '' };
  return { home: matchName.slice(0, idx), away: matchName.slice(idx + SEPARATOR.length) };
}

function toMatch(item) {
  if (!item || typeof item.match_name !== 'string' || !item.text_time) return null;
  const kickoffEpoch = Date.parse(item.text_time);
  if (!Number.isFinite(kickoffEpoch)) return null;

  const { home, away } = splitName(item.match_name);
  const releaseEpoch = kickoffEpoch - RELEASE_OFFSET_MIN * 60000;

  return {
    id: matchId(item.match_name, kickoffEpoch),
    home,
    away,
    matchName: item.match_name,
    kickoffEpoch,
    releaseEpoch,
    releaseOffsetMin: RELEASE_OFFSET_MIN,
    // Xác minh trên site thật: date phải là ngày BÓNG LĂN theo giờ VN.
    // Dùng ngày UTC thì server trả 404, dùng ngày VN thì trả 400 "Outside time
    // window" — tức nó nhận ra trận, chỉ là chưa tới giờ.
    dateParam: vnDateString(kickoffEpoch),
    kickoffDate: vnDateString(kickoffEpoch),
    kickoffTime: new Date(kickoffEpoch + 7 * 3600000).toISOString().slice(11, 16),

    matchId: item.match_id ?? null,
    configId: item.config_id || null,
    campaignId: item.campaign_id || null,
    campaignName: item.campaign_name || null,
    codesetId: item.codeset_id || null,
    codesetName: item.codeset_name || null,
    league: item.league_name || '',
    totalCodes: item.total_codes ?? null,
    claimedCodes: item.claimed_codes ?? null,
    remainingCodes: item.remaining_codes ?? null,
    received: !!item.received,
    giftCode: item.gift_code || null,
    validFrom: item.valid_from ? Date.parse(item.valid_from) : null,
    validTo: item.valid_to ? Date.parse(item.valid_to) : null,
    source: 'api',
  };
}

/** Rút danh sách trận từ body của leagues-wc. */
export function parseLeagues(bodyText) {
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return { ok: false, matches: [], upcoming: null, error: 'Phản hồi không phải JSON' };
  }

  const list = Array.isArray(json?.result) ? json.result : [];
  const matches = list.map(toMatch).filter(Boolean);
  const upcoming = toMatch(json?.upcoming);

  return {
    ok: matches.length > 0 || !!upcoming,
    matches,
    upcoming,
    error: matches.length || upcoming ? null : 'Không có trận nào trong phản hồi',
  };
}

export function buildLeaguesUrl(site) {
  const path = site.paths?.leaguesPath || LEAGUES_PATH;
  return `${sites.origin(site)}${path}?uid=${encodeURIComponent(site.account?.uid ?? '')}`;
}

export function buildAlternateLeaguesUrl(site) {
  const leaguesPath = (site.paths?.leaguesPath || LEAGUES_PATH) === LEAGUES_PATH ? DIRECT_LEAGUES_PATH : LEAGUES_PATH;
  return buildLeaguesUrl({ ...site, paths: { ...site.paths, leaguesPath } });
}

/**
 * Lấy danh sách trận của một site.
 * @returns {Promise<{ok:boolean, matches:Array, upcoming:object|null, status:number, error:string|null}>}
 */
export async function fetchMatches(site, { dictionary = null, signal } = {}) {
  if (!site.account?.uid) {
    return { ok: false, matches: [], upcoming: null, status: 0, error: 'Site chưa có UID' };
  }
  let res = await request({
    url: buildLeaguesUrl(site),
    brand: site.brand,
    phase: 'leagues',
    dictionary,
    init: { signal },
  });

  if (res.status === 404 && !signal?.aborted) {
    const altRes = await request({
      url: buildAlternateLeaguesUrl(site),
      brand: site.brand,
      phase: 'leagues',
      dictionary,
      init: { signal },
    });
    if (altRes.status >= 200 && altRes.status < 300) {
      res = altRes;
    }
  }

  if (res.status < 200 || res.status >= 300) {
    return { ok: false, matches: [], upcoming: null, status: res.status, error: `HTTP ${res.status}` };
  }
  const parsed = parseLeagues(res.body);
  return { ...parsed, status: res.status };
}

/**
 * Tra trạng thái một trận cho một site: đã nhận chưa, còn bao nhiêu code.
 * Dùng sau khi bắn để xác nhận kết quả, và để **cứu lại mã** nếu request nhận
 * code đã thành công nhưng tool không đọc ra được mã từ phản hồi.
 */
export async function lookupMatch(site, matchName, { dictionary = null, signal } = {}) {
  const res = await fetchMatches(site, { dictionary, signal });
  if (!res.ok) return { ok: false, error: res.error, match: null };
  const all = res.upcoming ? [res.upcoming, ...res.matches] : res.matches;
  const found = all.find((m) => m.matchName === matchName) || null;
  return { ok: !!found, match: found, error: found ? null : 'Không thấy trận trong danh sách' };
}
