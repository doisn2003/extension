/**
 * Tab "Điều kiện cược".
 *
 * Nhiều khuyến mãi đòi đủ vòng cược trong ngày mới đổi được thưởng. Chỗ tốn
 * thời gian nhất không phải lúc cược, mà là lúc **đi tới chỗ cược**: vào site →
 * menu game → sảnh Table Games → chọn provider → bấm ô game, nhân với 15 site.
 *
 * Tab này rút gọn việc đó còn một cú bấm. Nút "Mở tất cả" hỏi từng site link
 * vào game rồi mở tab — xem `lib/gameportal.js` để biết vì sao phải đi hỏi thay
 * vì tự ghép URL (token có tiền tố riêng theo từng nhà cái).
 *
 * Tool **chỉ mở tab**. Không có lệnh đặt cược nào ở đây, và sẽ không có: mọi
 * thao tác cược do bạn tự bấm trong game.
 */

import * as sites from '../../lib/sites.js';
import {
  GAMES, DEFAULT_GAME_KEY, gameKey, gameLabel, findGame, returnPathFor,
  fetchLaunchUrl, openGamePortals, reloadSiteTabs,
} from '../../lib/gameportal.js';
import { el, $, clear, toast, fmtInt, fmtAgo } from '../ui.js';

let onDataChanged = () => {};

export function init({ onChange } = {}) {
  onDataChanged = onChange || (() => {});

  fillGamePicker();
  $('#btn-bet-discover').addEventListener('click', handleDiscover);
  $('#btn-bet-refresh').addEventListener('click', handleRefresh);
  $('#btn-bet-open-all').addEventListener('click', handleOpenAll);
  $('#bet-th-stt')?.addEventListener('click', handleToggleAll);
  $('#bet-th-check')?.addEventListener('click', handleToggleAll);
  $('#btn-bet-reload-all').addEventListener('click', handleReloadAll);

  return render();
}

/** Mục game đang chọn — luôn gồm cả sảnh, vì mã game một mình không định danh được. */
function currentGame() {
  return findGame($('#bet-game-pick')?.value) || findGame(DEFAULT_GAME_KEY);
}

function fillGamePicker() {
  const sel = $('#bet-game-pick');
  if (!sel) return;
  clear(sel);
  // Tài Xỉu MD5 của HitClub lên đầu: game hay dùng để chạy đủ vòng cược.
  const ds = [...GAMES].sort((a, b) =>
    (gameKey(a) === DEFAULT_GAME_KEY ? -1 : gameKey(b) === DEFAULT_GAME_KEY ? 1 : 0));
  for (const g of ds) sel.appendChild(el('option', { value: gameKey(g), text: gameLabel(g) }));
  sel.value = DEFAULT_GAME_KEY;
}

// ------------------------------------------------------------------ render

export async function render() {
  const [list, granted] = await Promise.all([sites.list(), sites.hasBroadPermission()]);
  const body = clear($('#bet-body'));
  const notice = $('#bet-notice');

  if (!granted) {
    notice.hidden = false;
    notice.className = 'notice warn';
    notice.textContent =
      'Chưa có quyền đọc cookie. Bấm "Cấp quyền đọc cookie" ở góc trên rồi dò lại site.';
  } else if (!list.length) {
    notice.hidden = false;
    notice.className = 'notice';
    notice.textContent =
      'Chưa thấy site nào. Đăng nhập các nhà cái trong Chrome này rồi bấm "Dò site từ cookie".';
  } else {
    notice.hidden = true;
  }

  refreshSummary(list);

  if (!list.length) {
    body.append(el('tr', {}, el('td', { colspan: 10, class: 'empty', text: 'Chưa có site nào.' })));
    return;
  }

  list.forEach((site, idx) => body.append(renderRow(site, idx + 1)));
}

function renderRow(site, stt) {
  const acc = site.account;

  const sessionChip = site.isLogin && acc
    ? el('span', { class: 'chip good', text: `Đăng nhập${acc.tokenIat ? ` · token ${fmtAgo(acc.tokenIat)}` : ''}` })
    : acc
      ? el('span', { class: 'chip warn', text: 'Cookie cũ, chưa chắc còn phiên' })
      : el('span', { class: 'chip bad', text: 'Chưa đăng nhập' });

  return el('tr', { class: site.isLogin ? '' : 'row-disabled', dataset: { brand: site.brand } },
    el('td', { class: 'num col-stt', text: stt }),
    // Cùng cờ `enabled` với tab Site và tab Dự đoán: tick ở đâu cũng là một danh sách.
    el('td', { class: 'col-check' },
      el('input', {
        type: 'checkbox',
        checked: !!site.enabled,
        title: 'Chọn site này cho nút "Mở tất cả"',
        onChange: (e) => handleToggle(site, e.target.checked),
      })),
    el('td', { class: 'site-name', text: sites.displayName(site) }),
    el('td', { class: 'mono tiny', text: site.domain }),
    el('td', {}, sessionChip),
    el('td', { class: 'num mono', text: acc?.uid ?? '—' }),
    el('td', { text: acc?.username || '—' }),
    el('td', { class: 'num mono', text: acc?.balance != null ? fmtInt(acc.balance) : '—' }),
    el('td', { class: 'col-action' },
      el('button', {
        class: 'btn btn-mini',
        disabled: !site.isLogin,
        title: site.isLogin
          ? 'Hỏi site link vào game rồi mở tab'
          : 'Site này chưa đăng nhập nên không xin được link game',
        text: 'Mở game',
        onClick: (e) => handleOpenOne(site, e.target),
      })),
    el('td', { class: 'col-action' },
      el('button', {
        class: 'btn btn-mini',
        title: 'Nạp lại mọi tab đang mở của site này (trang nhà cái lẫn tab game)',
        text: 'Reload',
        onClick: (e) => handleReloadOne(site, e.target),
      })),
  );
}

// ---------------------------------------------------------------- thao tác

/** Mở game của đúng một site. */
async function handleOpenOne(site, btn) {
  const game = currentGame();
  btn.disabled = true;
  btn.textContent = 'Đang hỏi…';
  try {
    const res = await fetchLaunchUrl(site, {
      gameId: game.gameId, provider: game.provider, returnPath: returnPathFor(game),
    });
    if (!res.ok) {
      return toast(`${sites.displayName(site)}: ${res.error}`, 'bad', 8000);
    }
    // `active: false` — mở tab nền, giữ nguyên chỗ đang đứng. Bị kéo sang tab
    // game sau mỗi cú bấm thì không theo dõi được bảng nữa.
    await chrome.tabs.create({ url: res.url, active: false });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Mở game';
  }
}

/** Nạp lại tab của đúng một site. */
async function handleReloadOne(site, btn) {
  btn.disabled = true;
  try {
    const n = await reloadSiteTabs(site);
    toast(
      n ? `${sites.displayName(site)}: đã nạp lại ${n} tab.` : `${sites.displayName(site)}: chưa có tab nào đang mở.`,
      n ? 'good' : 'warn',
    );
  } finally {
    btn.disabled = false;
  }
}

/** Nạp lại tab của mọi site cùng lúc. */
async function handleReloadAll() {
  const list = await sites.list();
  if (!list.length) return toast('Chưa có site nào.', 'warn');

  const btn = $('#btn-bet-reload-all');
  btn.disabled = true;
  try {
    const counts = await Promise.all(list.map((s) => reloadSiteTabs(s)));
    const tong = counts.reduce((a, b) => a + b, 0);
    const soSite = counts.filter((n) => n > 0).length;
    toast(
      tong ? `Đã nạp lại ${tong} tab trên ${soSite} site.` : 'Không có tab nào đang mở để nạp lại.',
      tong ? 'good' : 'warn',
    );
  } finally {
    btn.disabled = false;
  }
}

/** Mở game của mọi site đang đăng nhập. Đây là cú bấm chính của tab này. */
async function handleOpenAll() {
  // Chỉ site đã tick VÀ đang đăng nhập — dùng chung cờ `enabled` với tab Site.
  const list = (await sites.list()).filter((s) => s.enabled && s.isLogin);
  if (!list.length) return toast('Chưa tick site nào đang đăng nhập.', 'warn');

  const game = currentGame();
  const name = gameLabel(game);
  if (!confirm(`Mở "${name}" trên ${list.length} site đã tick, mỗi site một tab nền.\n\nTool chỉ xin link và mở tab — mọi thao tác cược do bạn tự bấm.\n\nTiếp tục?`)) return;

  const btn = $('#btn-bet-open-all');
  const summary = $('#bet-summary');
  btn.disabled = true;

  const results = await openGamePortals(list, {
    gameId: game.gameId,
    provider: game.provider,
    returnPath: returnPathFor(game),
    onProgress: ({ index, total, brand, ok }) => {
      summary.textContent = `${index}/${total} · ${brand} ${ok ? 'đã mở' : 'hỏng'}`;
    },
  });

  btn.disabled = false;
  const bad = results.filter((r) => !r.ok);
  toast(
    bad.length
      ? `Mở được ${results.length - bad.length}/${results.length}. Hỏng: ${bad.map((r) => `${r.brand} (${r.error})`).join(', ')}`
      : `Đã mở ${results.length} tab, mỗi tab vào thẳng ${name}.`,
    bad.length ? 'warn' : 'good',
    bad.length ? 12000 : 8000,
  );
  await render();
}

async function handleDiscover() {
  const btn = $('#btn-bet-discover');
  btn.disabled = true;
  btn.textContent = 'Đang dò…';
  try {
    const res = await sites.discoverAndMerge();
    if (!res.granted) return toast('Cần cấp quyền đọc cookie trước.', 'warn');

    const parts = [];
    if (res.issues?.length) parts.push(sites.accountIssueText(res.issues));
    if (res.added.length) parts.push(`thêm ${res.added.length} site mới`);
    if (res.moved.length) parts.push(`${res.moved.length} site đổi domain`);
    if (res.updated.length) parts.push(`${res.updated.length} site không đổi`);
    toast(parts.length ? `Dò domain xong: ${parts.join(' · ')}. Bấm Refresh để cập nhật tài khoản.` : 'Chưa tìm thấy domain site trong tab đang mở hoặc cookie.', parts.length && !res.issues?.length ? 'good' : 'warn', 8000);
    await render();
    onDataChanged();
  } catch (error) {
    toast(error.message || 'Không đọc được tài khoản.', 'bad', 9000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Discover';
  }
}

async function handleRefresh() {
  const btn = $('#btn-bet-refresh');
  btn.disabled = true;
  try {
    const accountResult = await sites.refreshAccounts();
    await render();
    const summary = sites.accountReadSummary(accountResult);
    toast(summary.text, summary.tone, 9000);
    onDataChanged();
  } catch (error) {
    toast(error.message || 'Không đọc được tài khoản.', 'bad', 9000);
  } finally {
    btn.disabled = false;
  }
}

/** Dòng tóm tắt. Tách riêng để tick một ô không phải vẽ lại cả bảng. */
function refreshSummary(list) {
  const loggedIn = list.filter((s) => s.isLogin);
  const daTick = list.filter((s) => s.enabled && s.isLogin);
  $('#bet-summary').textContent = list.length
    ? `${list.length} site · ${loggedIn.length} đang đăng nhập · "Mở tất cả" mở game cho ${daTick.length} site đã tick`
    : 'Chưa có site nào.';
}

/**
 * Tick / bỏ tick một site.
 *
 * Cố tình **không** gọi `render()` hay `onDataChanged()`: vẽ lại cả bảng làm trang
 * nhảy về đầu, nên tick site thứ 15 xong là phải cuộn ngược lại để tick site thứ 16.
 * Ô vừa bấm thì trình duyệt đã tự vẽ; chỉ còn dòng tóm tắt cần cập nhật. Khi chuyển
 * tab, tab đích sẽ tự render dữ liệu mới từ storage.
 */
async function handleToggle(site, checked) {
  await sites.update(site.brand, { enabled: checked });
  refreshSummary(await sites.list());
}

/**
 * Tick / bỏ tick tất cả.
 *
 * Ở đây buộc phải vẽ lại vì mọi ô đều đổi trạng thái cùng lúc, và người dùng đang ở đầu bảng.
 */
async function handleToggleAll() {
  const list = await sites.list();
  if (!list.length) return;
  const bat = !list.every((s) => s.enabled);
  for (const s of list) await sites.update(s.brand, { enabled: bat });
  await render();
  onDataChanged();
}
