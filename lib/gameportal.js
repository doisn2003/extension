/**
 * Mở thẳng một game trong sảnh nhà cung cấp, bỏ qua toàn bộ bước điều hướng.
 *
 * Bình thường muốn vào Tài Xỉu MD5 phải đi bốn chặng: vào site → menu game →
 * sảnh Table Games → chọn provider `hit` → bấm ô game. Nhân với 15 site là
 * khoảng 60–75 cú bấm chỉ để *đi tới chỗ chơi*.
 *
 * Nhưng link game có dạng
 *
 *   https://games.gnightfast.net?brand=vk88&token=70-<32 hex>&gameid=vgmn_101&ru=…
 *
 * với `token` riêng từng phiên và `games.gnightfast.net` là tên miền của nhà
 * cung cấp — thứ có thể khác nhau giữa các nhà cái. Ghép tay chuỗi này là ngõ cụt.
 *
 * Lời giải: **không ghép, mà đi hỏi.** Chính trang khi bạn bấm vào ô game cũng
 * chỉ gọi đúng một request tới API của nhà cái:
 *
 *   GET /api/v1/gameUrl?partnerGameId=vgmn_101&partnerProvider=go&ru=<đường về>
 *   → {"code":200,"status":"OK","data":{"url":"https://…","url_mobile":"https://…"}}
 *
 * Đo trên vk88 (15/08/2026): 200 OK trong 56 ms, `data.url` trùng từng ký tự
 * với link sinh ra khi bấm tay, token khớp hoàn toàn. Nhà cái tự điền token,
 * tự điền tên miền nhà cung cấp — tool không cần biết cái nào cả.
 *
 * Đây là GET trên API của chính nhà cái, cùng họ với `/api/v1/refresh`. Nó chỉ
 * *lấy địa chỉ để mở tab*; không đặt cược, không gửi lệnh ghi nào. Mọi thao tác
 * cược vẫn do bạn tự bấm trong game.
 */

import * as sites from './sites.js';
import { request } from './net.js';

/**
 * Sảnh (nhà cung cấp). `code` là giá trị đi vào `partnerProvider` của API.
 *
 * ⚠️ "HitClub" mang mã `go`, không phải `hit`. Chuỗi `hit` chỉ xuất hiện ở URL
 * sảnh live casino; API game dùng `go`. Nhầm hai cái là 404.
 */
export const LOBBIES = {
  go: 'HitClub',
  b52: 'B52',
};

/**
 * Danh mục game.
 *
 * **Mã game KHÔNG định danh được game nếu thiếu sảnh.** Cùng một `vgcg_1`:
 *
 *   go  → Tiến Lên Đếm Lá
 *   b52 → Tiến Lên Miền Nam
 *
 * Đọc trực tiếp từ hai sảnh trên 11win.casa (19/08/2026). Vì vậy khoá của mỗi
 * mục là `provider:gameId`, và mọi chỗ dùng đều phải mang theo cả hai — chứ
 * không phải một `gameId` trần như bản trước.
 *
 * `lobby` là sảnh chứa game, dùng dựng đường quay về (`ru`) sau khi thoát game.
 */
export const GAMES = [
  { provider: 'go',  gameId: 'vgmn_101', name: 'Tài Xỉu MD5',       lobby: 'table-games' },
  { provider: 'go',  gameId: 'vgcg_11',  name: 'Tiến Lên Miền Nam', lobby: 'game-bai' },
  { provider: 'go',  gameId: 'vgcg_1',   name: 'Tiến Lên Đếm Lá',   lobby: 'game-bai' },
  { provider: 'go',  gameId: 'vgcg_5',   name: 'Liêng',             lobby: 'game-bai' },
  { provider: 'go',  gameId: 'vgcg_6',   name: 'Poker',             lobby: 'game-bai' },

  { provider: 'b52', gameId: 'vgmn_101', name: 'Tài Xỉu MD5',       lobby: 'table-games' },
  { provider: 'b52', gameId: 'vgcg_1',   name: 'Tiến Lên Miền Nam', lobby: 'game-bai' },
  { provider: 'b52', gameId: 'vgcg_5',   name: 'Liêng',             lobby: 'game-bai' },
];

/** Khoá duy nhất của một mục game. */
export const gameKey = (g) => `${g.provider}:${g.gameId}`;

/** Nhãn hiển thị: tên game kèm tên sảnh trong ngoặc — "Tài Xỉu MD5 (B52)". */
export const gameLabel = (g) => `${g.name} (${LOBBIES[g.provider] || g.provider})`;

/** Tra một mục theo khoá `provider:gameId`. */
export const findGame = (key) => GAMES.find((g) => gameKey(g) === key) || null;

/** Mặc định: Tài Xỉu MD5 của HitClub — game hay dùng để chạy đủ vòng cược. */
export const DEFAULT_GAME_KEY = 'go:vgmn_101';

/** Đường quay về sau khi thoát game: đúng sảnh chứa nó. */
export const returnPathFor = (g) => `/game/${g.lobby}?provider=${g.provider}`;

/** Đường API trả về link vào game. */
export const GAME_URL_PATH = '/api/v1/gameUrl';

/**
 * Dựng URL hỏi link game.
 *
 * Không dùng `URLSearchParams`: nó mã hoá dấu cách thành `+`, và ở
 * `buildClaimUrl` thói quen đó từng làm hỏng tên trận. Giữ nguyên nếp cũ cho
 * nhất quán, dù ở đây tham số không có dấu cách.
 */
export function buildGameUrlRequest(site, { gameId, provider, returnPath } = {}) {
  const mac = findGame(DEFAULT_GAME_KEY);
  gameId ??= mac.gameId;
  provider ??= mac.provider;
  returnPath ??= returnPathFor(findGame(`${provider}:${gameId}`) || mac);

  const path = site.paths?.gameUrlPath || GAME_URL_PATH;
  const qs = [
    `partnerGameId=${encodeURIComponent(gameId)}`,
    `partnerProvider=${encodeURIComponent(provider)}`,
    `ru=${encodeURIComponent(returnPath)}`,
  ].join('&');
  return `${sites.origin(site)}${path}?${qs}`;
}

/**
 * Hỏi một site link vào game.
 *
 * Trả `{ ok, url, error }`. Không ném lỗi: một site không có sảnh này thì các
 * site còn lại vẫn phải mở được.
 */
export async function fetchLaunchUrl(site, opts = {}) {
  const url = buildGameUrlRequest(site, opts);
  const res = await request({
    url,
    brand: site.brand,
    phase: 'probe',
    dictionary: opts.dictionary || null,
  });

  if (!res.ok) {
    return { ok: false, url: null, error: `HTTP ${res.status}` };
  }

  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    return { ok: false, url: null, error: 'Phản hồi không phải JSON' };
  }

  const launch = json?.data?.url || json?.data?.url_mobile || null;
  if (!launch) {
    return { ok: false, url: null, error: json?.message || 'Phản hồi không có data.url' };
  }
  return { ok: true, url: launch, error: null };
}

/**
 * Tìm mọi tab đang mở thuộc về một site.
 *
 * Hai loại tab đều tính:
 *   - tab trên chính tên miền nhà cái (`vk88.srl/...`)
 *   - tab game ở tên miền nhà cung cấp, nhận ra nhờ tham số `brand=<brand>`
 *
 * So khớp `brand` bằng cách **đọc query param**, không phải tìm chuỗi con:
 * `brand=ta88` mà so chuỗi con thì sẽ khớp nhầm cả `brand=ta889`.
 */
export async function findSiteTabs(site) {
  const all = await chrome.tabs.query({});
  const host = site.domain;
  return all.filter((tab) => {
    if (!tab.url) return false;
    let u;
    try {
      u = new URL(tab.url);
    } catch {
      return false;
    }
    if (u.hostname === host || u.hostname.endsWith(`.${host}`)) return true;
    return u.searchParams.get('brand') === site.brand;
  });
}

/**
 * Nạp lại mọi tab của một site.
 *
 * Dùng khi game treo hoặc bảng cược đứng hình — nạp lại đúng tab đó mà không
 * phải đi tìm giữa 15 cửa sổ. Không mở tab mới: chưa có tab nào thì báo để bạn
 * bấm "Mở game" trước.
 */
export async function reloadSiteTabs(site) {
  const tabs = await findSiteTabs(site);
  await Promise.all(
    tabs.map((t) =>
      chrome.tabs.reload(t.id, { bypassCache: false }).catch(() => {})
    )
  );
  return tabs.length;
}

/**
 * Hỏi lần lượt nhiều site rồi mở tab cho từng site trả lời được.
 *
 * Tuần tự chứ không song song: 15 request rải ra vẫn xong trong khoảng một
 * giây, mà không tạo ra một chùm đồng thời — đây không phải cuộc đua như lúc
 * nhận code, nên không có lý do gì phải bắn dồn.
 *
 * `onProgress({ brand, ok, error, index, total })` để giao diện báo tiến độ.
 */
export async function openGamePortals(siteList, { gameId, provider, returnPath, spacingMs = 400, active = false, onProgress } = {}) {
  const results = [];
  for (let i = 0; i < siteList.length; i += 1) {
    const site = siteList[i];
    const res = await fetchLaunchUrl(site, { gameId, provider, returnPath });
    if (res.ok) {
      try {
        await chrome.tabs.create({ url: res.url, active });
      } catch (err) {
        console.warn(`[openGamePortals] Không thể mở tab cho ${site.brand}:`, err);
      }
    }
    results.push({ brand: site.brand, ...res });
    onProgress?.({ brand: site.brand, ok: res.ok, error: res.error, index: i + 1, total: siteList.length });
    if (i < siteList.length - 1) {
      await new Promise((r) => setTimeout(r, spacingMs));
    }
  }
  return results;
}
