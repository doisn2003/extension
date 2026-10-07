/**
 * Dò endpoint danh sách trận.
 *
 * Ta đã biết chắc một path trên hệ thống sự kiện dùng chung:
 *   /api/hotmatch-proxy/v1/hotmatch/giftcode/
 * Một API đưa được gift code theo `match_name` thì gần như chắc chắn cũng có
 * chỗ nào đó liệt kê các trận — trang khuyến mãi phải lấy tên trận và đồng hồ
 * đếm ngược từ đâu đó ra.
 *
 * Nếu tìm được, hai rủi ro lớn nhất biến mất cùng lúc: không phải gõ tay tên
 * trận (nên hết sai chính tả), và có luôn thời điểm phát code do server công bố
 * (nên hết phải suy ra số phút phát trước).
 *
 * Chỉ thử trên **một** site, mỗi path một request.
 */

import { request } from './net.js';
import * as sites from './sites.js';

const BASE = '/api/hotmatch-proxy/v1/hotmatch';

/** Xếp theo mức khả dĩ giảm dần. */
export const CANDIDATE_PATHS = [
  `${BASE}/`,
  `${BASE}/matches/`,
  `${BASE}/match/`,
  `${BASE}/list/`,
  `${BASE}/schedule/`,
  `${BASE}/events/`,
  `${BASE}/config/`,
];

const TEAM_KEYS = [
  ['home', 'away'],
  ['home_team', 'away_team'],
  ['homeTeam', 'awayTeam'],
  ['team1', 'team2'],
  ['team_home', 'team_away'],
];

const NAME_KEYS = /^(match_?name|name|title|match)$/i;
const TIME_KEYS = /(kick_?off|start|match_?time|begin|release|open|time|date)/i;

/** Mảng dài nhất chứa object trong cây JSON — thường là danh sách trận. */
function findArrays(node, depth = 0, out = []) {
  if (depth > 6 || node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    if (node.length && node.some((x) => x && typeof x === 'object')) out.push(node);
    for (const item of node) findArrays(item, depth + 1, out);
    return out;
  }
  for (const value of Object.values(node)) findArrays(value, depth + 1, out);
  return out;
}

function parseTime(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    // Giây hay mili-giây? Mốc 1e12 tách được hai loại trong vài chục năm tới.
    const ms = value < 1e12 ? value * 1000 : value;
    return ms > 1e11 && ms < 4e12 ? ms : null;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n) && value.trim() !== '') return parseTime(n);
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Cố rút danh sách trận ra khỏi một phản hồi có cấu trúc chưa biết.
 * Trả về cả những gì không chắc, kèm nhãn để giao diện hiển thị trung thực.
 */
export function extractMatches(bodyText) {
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return [];
  }

  const found = [];
  for (const arr of findArrays(json)) {
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;

      let matchName = null;
      let home = null;
      let away = null;

      for (const [hk, ak] of TEAM_KEYS) {
        if (typeof item[hk] === 'string' && typeof item[ak] === 'string') {
          home = item[hk].trim();
          away = item[ak].trim();
          matchName = `${home} & ${away}`;
          break;
        }
      }

      if (!matchName) {
        for (const [key, value] of Object.entries(item)) {
          if (typeof value === 'string' && NAME_KEYS.test(key) && value.includes(' & ')) {
            matchName = value.trim();
            const parts = matchName.split(' & ');
            home = parts[0];
            away = parts.slice(1).join(' & ');
            break;
          }
        }
      }

      if (!matchName) continue;

      const times = {};
      for (const [key, value] of Object.entries(item)) {
        if (!TIME_KEYS.test(key)) continue;
        const t = parseTime(value);
        if (t) times[key] = t;
      }

      found.push({ matchName, home, away, times, raw: item });
    }
  }
  return found;
}

/**
 * Thử lần lượt các path ứng viên trên một site.
 * @returns {Promise<Array<{path, status, contentType, bytes, isJson, matches, sample}>>}
 */
export async function probeMatchApi(site, { date, uid, dictionary = null, onProgress = () => {} } = {}) {
  const results = [];
  for (const path of CANDIDATE_PATHS) {
    const url = `${sites.origin(site)}${path}?date=${encodeURIComponent(date)}&uid=${encodeURIComponent(uid)}`;
    const res = await request({ url, brand: site.brand, phase: 'discover', dictionary });
    const contentType = res.headers['content-type'] || '';
    const isJson = contentType.includes('json');
    const matches = isJson ? extractMatches(res.body) : [];

    results.push({
      path,
      url,
      status: res.status,
      contentType,
      bytes: res.body.length,
      isJson,
      matches,
      sample: res.body.slice(0, 600),
    });
    onProgress(results.length, CANDIDATE_PATHS.length);
  }
  return results;
}

/** Path nào đáng dùng nhất: có trận rút ra được, rồi mới tới JSON dài. */
export function bestResult(results) {
  const withMatches = results.filter((r) => r.matches.length);
  if (withMatches.length) {
    return withMatches.sort((a, b) => b.matches.length - a.matches.length)[0];
  }
  const json = results.filter((r) => r.isJson && r.status >= 200 && r.status < 300);
  return json.sort((a, b) => b.bytes - a.bytes)[0] || null;
}
