/**
 * Tab Bắn code — Phase 3.
 *
 * Trang này là "não": nó là extension page nên Chrome không bóp timer khi nó
 * đang mở và đang hiển thị. Đó là lý do lịch bắn nằm ở đây chứ không nằm trong
 * service worker. Đổi lại, nếu bạn chuyển sang tab khác trong lúc đang ARM thì
 * Chrome sẽ bóp timer của trang này — nên có cảnh báo khi điều đó xảy ra.
 */

import * as storage from '../../lib/storage.js';
import * as sites from '../../lib/sites.js';
import { consensus, effectiveClock, hasAnchor, serverNow as calibratedNow } from '../../lib/clock.js';
import { createRun, SITE_STATUS, codeRemainingMs, CODE_TTL_MS } from '../../lib/engine.js';
import { sortByKickoff, releaseTime } from '../../lib/match.js';
import { formatDuration, vnDateTimeString, formatOffset } from '../../lib/vn-time.js';
import { loadDictionary } from '../../lib/net.js';
import { LABEL_INFO, LABELS } from '../../lib/blackbox.js';
import { el, $, clear, toast, fmtAgo } from '../ui.js';

const REHEARSAL_NAME = 'HotMatch Probe A & HotMatch Probe B';

let getServerNow = () => Date.now();
let onDataChanged = () => {};
let activeRun = null;
let armedInfo = null;
let lastRecord = null;
let logLines = [];
let renderQueued = false;

export function init({ serverNow, onChange } = {}) {
  if (serverNow) getServerNow = serverNow;
  onDataChanged = onChange || (() => {});

  $('#btn-arm').addEventListener('click', handleArm);
  $('#btn-disarm').addEventListener('click', handleDisarm);
  $('#run-match').addEventListener('change', async () => {
    await refreshMatchCache();
    await renderPreview();
  });

  const shootModeSel = $('#sel-shoot-mode');
  if (shootModeSel) {
    storage.get('config').then((cfg) => {
      if (cfg?.shootMode) shootModeSel.value = cfg.shootMode;
    });
    shootModeSel.addEventListener('change', async () => {
      const shootMode = shootModeSel.value;
      await storage.patch('config', { shootMode });
      await renderPreview();
      toast(`Chế độ bắn: ${shootMode === 'awm' ? 'AWM (Bắn tuần tự)' : 'SCAR (Bắn liên thanh)'}`, 'good');
    });
  }

  $('#btn-refresh-sites').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const accountResult = await sites.refreshAccounts();
      await render();
      onDataChanged();
      const summary = sites.accountReadSummary(accountResult);
      toast(summary.text, summary.tone, 9000);
    } catch (error) {
      toast(error.message || 'Không đọc được tài khoản.', 'bad', 9000);
    } finally {
      e.target.disabled = false;
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && activeRun) {
      log('⚠ Tab bị ẩn — Chrome bóp timer của tab nền, thời điểm bắn có thể trượt. Quay lại tab này.');
      notify('HotMatch: quay lại tab!', 'Tab đang ẩn trong lúc chờ bắn — thời điểm có thể trượt.');
    }
  });

  return render();
}

// ------------------------------------------------------------------ render

export async function render() {
  await renderMatchOptions();
  await refreshMatchCache();
  await renderPreview();
  await renderRunSites();
  await renderResults();
}

/**
 * Danh sách site sẽ tham gia, ngay trong tab Bắn code.
 *
 * Tự đồng bộ khi bạn tick/bỏ tick ở tab Site (qua onChange của bảng site), nên
 * không phải nhớ mình đã bật những site nào. Nút Làm mới chỉ cần khi cookie đổi
 * ngoài tool — ví dụ bạn vừa đăng nhập lại một site ở tab khác.
 */
async function renderRunSites() {
  const node = clear($('#run-sites'));
  node.className = 'run-sites';
  const list = await sites.list();

  if (!list.length) {
    node.append(el('span', { class: 'dim tiny', text: 'Chưa có site nào. Sang tab Site bấm "Dò site từ cookie".' }));
    $('#run-sites-label').textContent = 'Site sẽ bắn';
    return;
  }

  let ready = 0;
  for (const site of list) {
    const noSession = !site.isLogin || !site.account?.uid;
    const willFire = site.enabled && !noSession;
    if (willFire) ready += 1;

    const why = !site.enabled ? 'đã tắt'
      : !site.account?.uid ? 'chưa có UID'
      : !site.isLogin ? 'hết phiên'
      : null;

    node.append(el('span', {
      class: `run-site ${willFire ? 'on' : noSession && site.enabled ? 'bad' : 'off'}`,
      title: willFire ? `${site.domain} · uid ${site.account.uid}` : `${site.domain} — ${why}`,
    },
      sites.displayName(site),
      why ? el('span', { class: 'why', text: `· ${why}` }) : null));
  }

  $('#run-sites-label').textContent = `Site sẽ bắn — ${ready}/${list.length}`;
}

async function renderMatchOptions() {
  const matches = sortByKickoff(await storage.get('matches'));
  const select = $('#run-match');
  const previous = select.value;
  clear(select);

  if (!matches.length) {
    select.append(el('option', { value: '', text: '— chưa có trận nào, nhập ở tab Trận đấu —' }));
    return;
  }
  for (const m of matches) {
    select.append(el('option', {
      value: m.id,
      text: `${m.matchName} — phát code ${vnDateTimeString(releaseTime(m), false)} (bóng lăn ${vnDateTimeString(m.kickoffEpoch, false)})`,
    }));
  }
  const upcoming = matches.find((m) => releaseTime(m) > getServerNow());
  select.value = matches.some((m) => m.id === previous) ? previous : (upcoming || matches[0]).id;
}

/**
 * Trận đang chọn, có nhớ đệm.
 *
 * `tick()` chạy 4 lần mỗi giây; đọc storage mỗi lần là sao chép cả registry
 * ngần ấy lần, và đúng vào lúc burst thì công việc thừa đó làm trượt thời điểm
 * bắn. Chỉ đọc lại khi thực sự có thay đổi.
 */
let matchCache = null;

async function refreshMatchCache() {
  const matches = await storage.get('matches');
  matchCache = matches.find((m) => m.id === $('#run-match').value) || null;
  return matchCache;
}

async function currentMatch() {
  return matchCache ?? refreshMatchCache();
}

/**
 * Băng trạng thái khi đã ARM.
 *
 * ARM rồi thì tool chỉ ngồi chờ, không gửi gì cho tới T-5 giây — nhìn màn hình
 * đứng im rất dễ tưởng là hỏng. Băng này nói rõ đang chờ gì và sẽ bắn lúc nào.
 */
function renderArmBanner() {
  const node = $('#arm-banner');
  if (!armedInfo) {
    node.hidden = true;
    return;
  }
  node.hidden = false;

  const left = armedInfo.releaseEpoch - getServerNow();
  const phase = activeRun?.state.phase;

  if (phase && phase !== 'armed' && phase !== 'running') {
    node.className = 'notice';
    node.textContent = `Giai đoạn: ${phase}.`;
    return;
  }

  node.className = left > 0 ? 'notice warn' : 'notice';
  clear(node).append(
    el('strong', { text: left > 0 ? 'ĐÃ ARM — đang chờ.' : 'ĐANG BẮN.' }),
    ' ',
    el('span', {
      text: left > 0
        ? `Sẽ bắn lúc ${vnDateTimeString(armedInfo.releaseEpoch)} giờ VN, còn ${formatDuration(left)}. `
          + 'Tool không gửi gì cho tới 5 giây trước mốc đó.'
        : 'Đang trong cửa sổ bắn.',
    }),
    el('div', {
      class: 'tiny dim',
      style: 'margin-top:4px',
      text: 'Giữ tab này đang hiển thị. Chuyển sang tab khác thì Chrome bóp bộ hẹn giờ và thời điểm bắn có thể trượt.',
    }),
  );
}

/** Số request tối đa một site sẽ gửi trong một lần chạy, theo cấu hình hiện tại. */
function projectedAttempts(cfg) {
  const dense = cfg.denseWindowMs > 0 ? Math.floor(cfg.denseWindowMs / cfg.intervalMs) + 1 : 1;
  const tail = Math.max(0, Math.floor((cfg.tailWindowMs - cfg.denseWindowMs) / cfg.tailIntervalMs));
  return Math.min(cfg.maxAttempts || Infinity, dense + tail);
}

async function armChecklist(match) {
  const list = (await sites.list()).filter((s) => s.enabled);
  const cons = consensus(list.map((s) => ({ key: s.brand, clock: s.clock })));
  const blockers = [];
  const warnings = [];

  if (!match) blockers.push('Chưa chọn trận.');

  const usable = list.filter((s) => s.account?.uid && s.isLogin);
  if (!usable.length) blockers.push('Không có site nào vừa bật, vừa đăng nhập, vừa có UID.');

  const noSession = list.filter((s) => !s.isLogin || !s.account?.uid);
  if (noSession.length) warnings.push(`${noSession.length} site sẽ bị bỏ qua vì chưa đăng nhập: ${noSession.map((s) => s.brand).join(', ')}.`);

  // Trận tải từ API mang tên nguyên văn của server nên không thể sai chính tả —
  // cảnh báo kiểm chính tả với loại trận đó là vô nghĩa.
  if (match && match.source !== 'api') {
    if (match.test && match.test.verdict !== 'name-ok') {
      warnings.push(`Kiểm chính tả tên trận cho kết quả "${match.test.verdict}" chứ không phải "tên đúng".`);
    } else if (!match.test) {
      warnings.push('Tên trận này do bạn gõ tay và chưa được kiểm. Bấm "Kiểm tra sẵn sàng" hoặc "Thử nghiệm" trước.');
    }
  }

  if (match && releaseTime(match) < getServerNow() - 60000) {
    warnings.push('Thời điểm phát code đã qua — AWM sẽ bỏ qua nếu đã hết cửa sổ gửi.');
  }

  return { list, usable, cons, blockers, warnings };
}

async function renderPreview() {
  const node = clear($('#run-preview'));
  const match = await currentMatch();
  if (!match) {
    node.append(el('span', { class: 'dim', text: 'Chọn một trận để xem kế hoạch bắn.' }));
    return;
  }

  const { usable, cons, blockers, warnings } = await armChecklist(match);
  const config = await storage.get('config');
  const shootMode = (config.shootMode || 'awm').toLowerCase();
  const isAwm = shootMode === 'awm';

  node.append(
    el('div', { class: 'preview-row' },
      el('span', { class: 'preview-label', text: 'Chế độ' }),
      el('span', {},
        el('strong', { text: isAwm ? 'AWM (Bắn tuần tự — Mặc định)' : 'SCAR (Bắn liên thanh / Dồn dập — Dự phòng)' }),
        isAwm ? ' — chỉ thử tiếp khi server đã từ chối ngoài giờ; tối đa 3 phát' : ' — bắn liên tiếp, chờ phản hồi trước khi gửi tiếp')),
    el('div', { class: 'preview-row' },
      el('span', { class: 'preview-label', text: 'Sẽ bắn' }),
      el('span', { text: `${usable.length} site · tên trận ` }),
      el('code', { class: 'strong', text: match.matchName })),
    el('div', { class: 'preview-row' },
      el('span', { class: 'preview-label', text: 'Mốc bắn' }),
      el('span', {},
        el('strong', { text: vnDateTimeString(releaseTime(match), false) }),
        ` — lúc phát code, sớm hơn bóng lăn ${match.releaseOffsetMin ?? 10} phút`)),
    el('div', { class: 'preview-row' },
      el('span', { class: 'preview-label', text: 'Lịch' }),
      el('span', {
        text: isAwm
          ? `bắn sau cận dưới giờ mở + ${config.safetyBufferMs ?? 200}ms · thử tiếp sau phản hồi ngoài giờ, cách ít nhất ${config.awmRetryDelayMs ?? 200}ms`
          : `phát đầu tại T-${config.leadMs}ms · dày mỗi ${config.intervalMs}ms tới T+${config.denseWindowMs / 1000}s ` +
            `· thưa mỗi ${config.tailIntervalMs / 1000}s tới T+${config.tailWindowMs / 1000}s · tối đa 1 request đang chờ/site`,
      })),
    el('div', { class: 'preview-row' },
      el('span', { class: 'preview-label', text: 'Lượng request' }),
      el('span', {},
        el('strong', { text: isAwm ? 'Tối đa 3 request mỗi site, gửi tuần tự' : `tối đa ${projectedAttempts(config)} request mỗi site` }),
        isAwm
          ? ` — không gửi thêm khi phát trước còn chờ hoặc kết quả chưa rõ.`
          : ` — tổng không quá ${projectedAttempts(config) * usable.length} cho cả lần chạy. Site nào thắng hoặc gặp báo hết code sẽ dừng sớm hơn.`)),
    el('div', { class: 'preview-row' },
      el('span', { class: 'preview-label', text: 'Đồng hồ' }),
      el('span', {
        text: 'Tự đo giờ riêng từng site trước khi bắn; lịch đã hiệu chỉnh không đổi khi Windows Sync.',
      })),
    el('div', { class: 'preview-row' },
      el('span', { class: 'preview-label', text: 'Đổi thưởng' }),
      el('span', { text: 'đổi thưởng tự động, đổi thưởng riêng hoặc đổi thưởng thủ công' })),
  );

  for (const b of blockers) node.append(el('div', { class: 'preview-error', text: `✕ ${b}` }));
  for (const w of warnings) node.append(el('div', { class: 'preview-warn', text: `⚠ ${w}` }));
}

/** Đếm ngược tới giờ bóng lăn, và đếm ngược 30 phút của từng code. */
export function tick() {
  const match = matchCache;
  const node = $('#run-countdown');
  if (match) {
    // Đếm tới lúc PHÁT CODE, đúng thứ đồng hồ trên trang nhà cái đang đếm.
    const liveClock = activeRun?.state.entries.find((e) => hasAnchor(e.clock))?.clock;
    const remaining = releaseTime(match) - (liveClock ? calibratedNow(liveClock) : getServerNow());
    node.textContent = formatDuration(remaining);
    node.className = `clock-value big ${remaining < 0 ? 'dim' : remaining < 60000 ? 'hot' : ''}`;
  } else {
    node.textContent = '--:--:--';
  }

  renderArmBanner();

  for (const cell of document.querySelectorAll('[data-wonat]')) {
    const left = codeRemainingMs(Number(cell.dataset.wonat));
    cell.textContent = left > 0 ? formatDuration(left) : 'hết hạn';
    cell.className = `num mono ${left <= 0 ? 'bad-text' : left < 5 * 60000 ? 'warn-text' : ''}`;
  }
}

// ------------------------------------------------------------------ kết quả

function currentEntries() {
  if (activeRun) return activeRun.state.entries;
  if (lastRecord) return Object.values(lastRecord.results || {});
  return null;
}

async function renderResults() {
  const node = clear($('#run-results'));
  if (!lastRecord && !activeRun) {
    // Bỏ qua các lần kiểm tra sẵn sàng: chúng không bao giờ có code, để chúng
    // đè lên kết quả một trận thật thì mất chỗ hiển thị mã vừa giành được.
    const runs = await storage.get('runs');
    lastRecord = runs.find((r) => r.kind !== 'readiness') || runs[0] || null;
  }
  const entries = currentEntries();
  if (!entries?.length) return;

  // Cần bản ghi site để biết site nào từng trả 423 — nó quyết định nút nào hiện.
  const siteByBrand = new Map((await sites.list()).map((s) => [s.brand, s]));
  const won = entries.filter((e) => e.code);
  const lost = entries.filter((e) => !e.code);
  const title = activeRun ? activeRun.state.match.matchName : lastRecord?.matchName;

  node.append(el('h3', {}, `Kết quả — ${title || ''}`));

  if (won.length) {
    node.append(el('div', { class: 'notice' },
      el('strong', { text: `Đã lấy được code — ${won.length}/${entries.length} site` })));
    node.append(el('div', { class: 'table-wrap' },
      el('table', { class: 'grid' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'Site' }),
          el('th', { text: 'Code' }),
          el('th', { class: 'num', text: 'Remaining' }),
          el('th', { text: 'Action' }))),
        el('tbody', {}, ...won.map((e) => renderWinnerRow(e, siteByBrand))))));

    node.append(el('div', { class: 'btn-row', style: 'margin-top:10px; gap:8px; flex-wrap:wrap;' },
      el('button', {
        class: 'btn btn-primary',
        text: `Redeem All (${won.length} sites)`,
        title: 'Gửi yêu cầu đổi thưởng lần lượt cho toàn bộ các site đã thắng qua API',
        onClick: (e) => handleRedeemAll(won, e.target),
      }),
      el('button', {
        class: 'btn',
        text: `Open ${won.length} Pages`,
        title: 'Mở tab của từng site, mã điền sẵn trên URL. Bạn chỉ việc bấm Đổi thưởng trên mỗi tab.',
        onClick: () => openAllRedeemPages(won),
      }),
      el('button', {
        class: 'btn',
        text: 'Copy All Codes',
        title: 'Copy toàn bộ mã vào Clipboard',
        onClick: () => {
          navigator.clipboard.writeText(won.map((e) => `${e.label || e.brand}\t${e.code}`).join('\n'));
          toast('Đã copy toàn bộ code.', 'good');
        },
      })));

    node.append(el('p', { class: 'hint' },
      'Bạn có thể bấm "Redeem All" để đổi nhanh qua API, hoặc bấm "Open Pages" để tự bấm trên trang.'));
  } else if (!activeRun) {
    node.append(el('div', { class: 'notice bad', text: 'Không lấy được code nào ở lần chạy gần nhất.' }));
  }

  if (lost.length) {
    const byReason = {};
    for (const e of lost) {
      const key = e.lastLabel || e.status || 'không rõ';
      byReason[key] = (byReason[key] || 0) + 1;
    }
    node.append(el('p', { class: 'hint' },
      `Không lấy được — ${lost.length} site: ` +
      Object.entries(byReason).map(([k, n]) => `${LABEL_INFO[k]?.text || k}: ${n}`).join(' · ')));
  }

  node.append(renderLiveGrid(entries));
}

/**
 * Một dòng site đã thắng: mã, đồng hồ đếm ngược, nút Đổi thưởng, Copy và Mở trang.
 */
function renderWinnerRow(entry) {
  return el('tr', {},
    el('td', { class: 'site-name', text: entry.label || entry.brand }),
    el('td', {}, el('code', { class: 'strong', text: entry.code })),
    el('td', { class: 'num mono', dataset: { wonat: String(entry.wonAt || 0) }, text: formatDuration(codeRemainingMs(entry.wonAt)) }),
    el('td', {}, el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-mini btn-redeem-row',
        text: 'Redeem',
        dataset: { redeemBrand: entry.brand },
        title: 'Gửi yêu cầu đổi thưởng ngay cho site này qua API',
        onClick: (e) => redeemOneEntry(entry, e.target),
      }),
      el('button', {
        class: 'btn btn-mini',
        text: 'Copy',
        title: 'Copy mã quà tặng',
        onClick: () => { navigator.clipboard.writeText(entry.code); toast(`Đã copy ${entry.code}.`, 'good'); },
      }),
      el('button', {
        class: 'btn btn-mini',
        text: 'Open Page',
        title: 'Mở trang khuyến mãi với mã điền sẵn trên URL, để bạn bấm Đổi thưởng.',
        onClick: () => openRedeemPage(entry),
      }))),
  );
}

/** Đổi thưởng lẻ cho một site */
async function redeemOneEntry(entry, btn) {
  const list = await sites.list();
  const site = list.find((s) => s.brand === entry.brand);
  if (!site) return toast(`Không tìm thấy site ${entry.brand}.`, 'bad');

  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Redeeming…';

  try {
    const res = await sites.redeemCode(site, entry.code);
    if (res.ok) {
      toast(`${sites.displayName(site)}: Đổi thưởng thành công!`, 'good', 5000);
      btn.textContent = '✔ Redeemed';
      btn.classList.add('btn-good');
    } else {
      toast(`${sites.displayName(site)}: Đổi thưởng thất bại (${res.message})`, 'bad', 7000);
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  } catch (err) {
    toast(`${sites.displayName(site)}: Lỗi (${err.message})`, 'bad', 7000);
    btn.disabled = false;
    btn.textContent = prevText;
  }
}

/** Đổi thưởng lần lượt toàn bộ site đã thắng với delay an toàn ngẫu nhiên */
async function handleRedeemAll(won, btn) {
  if (!won.length) return;
  const list = await sites.list();
  const siteByBrand = new Map(list.map((s) => [s.brand, s]));

  const prevText = btn.textContent;
  btn.disabled = true;

  let successCount = 0;
  let failList = [];

  for (let i = 0; i < won.length; i++) {
    const entry = won[i];
    const site = siteByBrand.get(entry.brand);
    btn.textContent = `Redeeming ${i + 1}/${won.length}…`;

    if (!site) {
      failList.push(`${entry.label || entry.brand}: Không tìm thấy site`);
      continue;
    }

    try {
      const res = await sites.redeemCode(site, entry.code);
      if (res.ok) {
        successCount++;
        const rowBtn = document.querySelector(`button[data-redeem-brand="${entry.brand}"]`);
        if (rowBtn) {
          rowBtn.textContent = '✔ Redeemed';
          rowBtn.disabled = true;
          rowBtn.classList.add('btn-good');
        }
      } else {
        failList.push(`${sites.displayName(site)}: ${res.message}`);
      }
    } catch (err) {
      failList.push(`${sites.displayName(site)}: ${err.message}`);
    }

    // Giãn cách ngẫu nhiên 400ms - 800ms giữa các site để mô phỏng hành vi tự nhiên
    if (i < won.length - 1) {
      const delay = Math.floor(Math.random() * 400) + 400;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  btn.disabled = false;
  btn.textContent = prevText;

  if (failList.length === 0) {
    toast(`Đã đổi thưởng thành công toàn bộ ${successCount}/${won.length} site!`, 'good', 6000);
  } else {
    toast(
      `Đổi thưởng thành công ${successCount}/${won.length} site. Thất bại ${failList.length}: ${failList.slice(0, 3).join('; ')}${failList.length > 3 ? '...' : ''}`,
      successCount > 0 ? 'warn' : 'bad',
      9000,
    );
  }
}

/** Mở trang khuyến mãi kèm mã — đúng URL mà trang tự dùng sau khi nhận code. */
async function openRedeemPage(entry, active = true) {
  const list = await sites.list();
  const site = list.find((s) => s.brand === entry.brand);
  if (!site) return toast(`Không tìm thấy site ${entry.brand}.`, 'bad');
  try {
    await chrome.tabs.create({
      url: `${sites.buildPromoUrl(site)}?giftcode=${encodeURIComponent(entry.code)}`,
      active,
    });
  } catch (err) {
    console.warn(`[openRedeemPage] Không thể mở tab cho ${entry.brand}:`, err);
  }
}

/** Mở lần lượt trang của mọi site đã thắng, giãn cách để không dội một lúc. */
async function openAllRedeemPages(won) {
  if (!confirm(`Sẽ mở ${won.length} tab, mỗi tab một site, mã điền sẵn trên URL.\n\nBạn tự bấm "Đổi thưởng" trên từng tab. Tiếp tục?`)) return;
  for (const entry of won) {
    await openRedeemPage(entry, false);
    await new Promise((r) => setTimeout(r, 600));
  }
  toast(`Đã mở ${won.length} tab. Bấm Đổi thưởng trên từng tab.`, 'good', 9000);
}

function renderLiveGrid(entries) {
  const statusChip = (e) => {
    const map = {
      [SITE_STATUS.WAITING]: ['', 'chờ'],
      [SITE_STATUS.PREWARM]: ['warn', 'hâm nóng'],
      [SITE_STATUS.FIRING]: ['warn', 'chờ phản hồi'],
      [SITE_STATUS.RETRY_WAIT]: ['warn', 'chờ thử lại'],
      [SITE_STATUS.WON]: ['good', 'thắng'],
      [SITE_STATUS.LOST]: ['', 'thua'],
      [SITE_STATUS.BLOCKED]: ['bad', 'chặn'],
      [SITE_STATUS.ABORTED]: ['', 'huỷ'],
    };
    const [tone, text] = map[e.status] || ['', e.status];
    return el('span', { class: `chip tiny ${tone}`, text });
  };

  return el('div', { class: 'table-wrap', style: 'margin-top:14px' },
    el('table', { class: 'grid' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Site' }),
        el('th', { text: 'Status' }),
        el('th', { class: 'num', text: 'Attempts' }),
        el('th', { text: 'Last Response' }),
        el('th', { class: 'num', text: 'Limit' }),
        el('th', { class: 'num', text: 'Offset Used' }))),
      el('tbody', {}, ...entries.map((e) => el('tr', {},
        el('td', { class: 'site-name', text: e.label || e.brand }),
        el('td', {},
          statusChip(e),
          e.stateNote && [SITE_STATUS.FIRING, SITE_STATUS.RETRY_WAIT, SITE_STATUS.PREWARM, SITE_STATUS.ABORTED].includes(e.status)
            ? el('div', { class: 'tiny dim', style: 'margin-top:2px', text: e.stateNote })
            : null),
        el('td', { class: 'num', text: e.attempts }),
        el('td', {},
          el('span', { class: 'tiny', text: LABEL_INFO[e.lastLabel]?.text || e.lastLabel || '—' }),
          e.lastBody ? el('span', { class: 'sample', title: e.lastBody, text: e.lastBody }) : null),
        el('td', { class: 'num tiny', text: e.rate ? `${e.rate.remaining}/${e.rate.limit}` : '—' }),
        el('td', { class: 'num tiny mono', text: formatOffset(e.offsetMs) }),
      )))));
}

// ------------------------------------------------------------------ hành động

async function handleArm() {
  const match = await currentMatch();
  const { usable, cons, blockers, warnings } = await armChecklist(match);

  if (blockers.length) return toast(blockers.join(' '), 'bad', 8000);
  if (warnings.length) {
    if (!confirm(`Có ${warnings.length} cảnh báo:\n\n• ${warnings.join('\n• ')}\n\nVẫn ARM?`)) return;
  }

  await startRun(match, usable, cons);
}

async function startRun(match, siteList, cons, configOverride = null, meta = {}) {
  const config = configOverride || await storage.get('config');
  if (activeRun) return toast('Đang có lần chạy; hãy chờ request đang gửi kết thúc.', 'warn');
  const kind = meta.kind || 'claim';
  logLines = [];

  activeRun = createRun({
    match,
    siteList,
    config,
    kind,
    clockFor: (site) => effectiveClock(site),
    onEvent: handleRunEvent,
  });

  armedInfo = { releaseEpoch: releaseTime(match) };
  $('#btn-arm').hidden = true;
  $('#btn-disarm').hidden = false;
  $('#run-match').disabled = true;

  const isAwm = (config.shootMode || 'awm').toLowerCase() === 'awm';
  log(`ARM: ${siteList.length} site · ${isAwm ? 'AWM' : 'SCAR'} · tối đa 1 request đang chờ/site. Đang chuẩn bị đồng hồ riêng từng site.`);
  await renderResults();

  try {
    const record = await activeRun.start();
    lastRecord = record;
    const won = Object.values(record.results).filter((r) => r.code);

    // Con số đáng xem nhất của một lần diễn tập: bắn lệch mốc bao nhiêu.
    const errs = Object.values(record.results).map((r) => r.timing?.[0]?.dispatchErrorMs).filter(Number.isFinite);
    if (errs.length) log(`Độ trễ gửi so với deadline từng site: ${Math.min(...errs).toFixed(1)}…${Math.max(...errs).toFixed(1)}ms (đồng hồ đơn điệu).`);

    if (kind === 'readiness') {
      await reportReadiness(record);
    } else {
      log(`Xong: thắng ${won.length}/${Object.keys(record.results).length} site.`);
      notify(
        won.length ? `Thắng ${won.length}/${Object.keys(record.results).length} site` : 'Không lấy được code',
        won.length ? won.map((w) => `${w.brand}: ${w.code}`).join(', ') : 'Xem nhật ký để biết lý do.',
      );
      // Engine dừng ở đây. Đổi thưởng làm thủ công trên trang nhà cái.
      await renderResults();
      if (won.length) {
        log(`${won.length} mã sẵn sàng. Dùng nút "Mở lần lượt ${won.length} trang" rồi bấm Đổi thưởng trên từng tab.`);
      }
    }
  } catch (err) {
    log(`Lỗi engine: ${err.message || err}`);
    toast(`Engine lỗi: ${err.message || err}`, 'bad', 10000);
  } finally {
    activeRun = null;
    armedInfo = null;
    $('#btn-arm').hidden = false;
    $('#btn-disarm').hidden = true;
    $('#run-match').disabled = false;
    await renderResults();
    onDataChanged();
  }
}

/**
 * Tổng kết một lần kiểm tra sẵn sàng.
 *
 * Vì nó dùng tên trận thật, kết quả nói được cả bốn thứ cùng lúc: thời điểm bắn
 * chính xác đến đâu, server có nhận ra tên trận không, phiên đăng nhập còn tốt
 * không, và site nào đang có vấn đề.
 */
async function reportReadiness(record) {
  const results = Object.values(record.results);
  const byLabel = {};
  for (const r of results) byLabel[r.lastLabel || '?'] = (byLabel[r.lastLabel || '?'] || 0) + 1;

  const recognised = byLabel[LABELS.NOT_YET] || 0;
  const badName = byLabel[LABELS.BAD_MATCH] || 0;
  const total = results.length;

  // Mọi site đều nhận ra tên trận: coi như đã kiểm chính tả xong, khỏi bắt bạn
  // chạy thêm nút Thử nghiệm cho cùng một việc.
  if (recognised === total && total > 0) {
    const matches = await storage.get('matches');
    const idx = matches.findIndex((x) => x.id === record.matchId);
    if (idx >= 0) {
      matches[idx].test = { at: Date.now(), verdict: 'name-ok', okCount: recognised, total, via: 'readiness', results: {} };
      await storage.set('matches', matches);
      await refreshMatchCache();
      await renderPreview();
    }
  }

  log(`Tên trận: ${recognised}/${total} site trả "chưa tới giờ phát" — nghĩa là server nhận ra tên này.`);
  if (badName) log(`⚠ ${badName} site báo SAI TÊN TRẬN. Tải lại trận từ site, hoặc kiểm tra site đó có cùng lịch không.`);
  for (const [label, n] of Object.entries(byLabel)) {
    if (label !== LABELS.NOT_YET && label !== LABELS.BAD_MATCH) {
      log(`· ${n} site: ${LABEL_INFO[label]?.text || label}`);
    }
  }

  const ok = recognised === total;
  toast(
    ok
      ? `${total}/${total} site nhận ra tên trận. Độ trễ gửi được ghi riêng trong nhật ký.`
      : `${recognised}/${total} site nhận ra tên trận — xem nhật ký để biết chi tiết.`,
    ok ? 'good' : 'warn', 12000,
  );
}

function handleDisarm() {
  activeRun?.abort();
  log('Đã huỷ.');
}

function handleRunEvent(event) {
  switch (event.type) {
    case 'clock-change':
      log(`Giờ Windows đổi ${formatOffset(event.change.deltaMs)}; giữ nguyên lịch bắn theo đồng hồ đơn điệu.`);
      break;
    case 'win': {
      const e = event.state.entries.find((x) => x.brand === event.brand);
      log(`✔ ${e.label}: ${e.code} (sau ${e.attempts} lần bắn)`);
      toast(`${e.label} lấy được code ${e.code}`, 'good', 10000);
      break;
    }
    case 'phase':
      log(`Giai đoạn: ${event.state.phase}`);
      break;
    default:
      break;
  }
  queueRender();
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(async () => {
    renderQueued = false;
    await renderResults();
  }, 250);
}


/** Cách xa giờ phát code tối thiểu bao nhiêu thì mới cho kiểm tra sẵn sàng. */
const READINESS_SAFETY_MS = 60000;
const READINESS_LEAD_MS = 12000;

/**
 * Kiểm tra sẵn sàng: **đúng một request mỗi site**, dùng **trận thật đang chọn**,
 * bắn tại một mốc giả cách 12 giây.
 *
 * Dùng tên trận thật chứ không phải tên bịa, vì đã xác minh trên site thật rằng
 * trước giờ phát thì tên đúng chỉ nhận `400 Outside time window` — không tiêu
 * mất lượt nào. Đổi lại, một lần bấm kiểm được đủ bốn thứ cùng lúc: độ chính xác
 * thời điểm, tên trận có được server nhận không, phiên đăng nhập còn tốt không,
 * và chính xác cái request sẽ bắn lúc vào trận.
 *
 * Chốt chặn: chỉ chạy khi còn cách giờ phát ít nhất 60 giây, để request không
 * bao giờ rơi vào cửa sổ thật.
 */
export async function rehearse() {
  if (activeRun) return toast('Đang có lần chạy; hãy chờ hoàn tất trước khi kiểm tra.', 'warn');
  const match = await currentMatch();
  if (!match) return toast('Chọn một trận trước đã.', 'warn');

  const list = (await sites.list()).filter((s) => s.enabled && s.account?.uid && s.isLogin);
  if (!list.length) return toast('Không có site nào vừa bật, vừa đăng nhập, vừa có UID.', 'warn');

  const untilRelease = releaseTime(match) - getServerNow();
  if (untilRelease < READINESS_SAFETY_MS) {
    return toast(
      untilRelease > 0
        ? `Còn ${Math.round(untilRelease / 1000)}s là tới giờ phát code — quá sát để kiểm tra. Bấm ARM luôn đi.`
        : 'Đã qua giờ phát code của trận này. Request lúc này là nhận code thật, không còn là kiểm tra.',
      'warn', 10000,
    );
  }

  const cons = consensus(list.map((s) => ({ key: s.brand, clock: s.clock })));
  const target = getServerNow() + READINESS_LEAD_MS;

  if (!confirm(
    `KIỂM TRA SẴN SÀNG\n\n` +
    `Gửi đúng ${list.length} request — 1 cho mỗi site — sau 12 giây, dùng trận thật:\n` +
    `"${match.matchName}"\n\n` +
    `Còn ${Math.round(untilRelease / 60000)} phút nữa mới tới giờ phát code, nên server sẽ trả ` +
    `"Outside time window" và không tiêu lượt nào của bạn.\n\n` +
    `Kết quả mong đợi: ${list.length}/${list.length} site báo "Chưa tới giờ phát", và sai số thời điểm dưới ±30ms.\n\nTiếp tục?`,
  )) return;

  const config = await storage.get('config');
  // Giữ nguyên tên trận và date thật, chỉ thay mốc bắn bằng mốc giả gần.
  const probeMatch = { ...match, releaseEpoch: target, releaseOffsetMin: 0 };

  await startRun(probeMatch, list, cons, {
    ...config,
    maxAttempts: 1,          // đúng một phát mỗi site
    denseWindowMs: 0,
    tailWindowMs: 3000,
    preflight: false,        // không gọi leagues-wc trước
    verifyAfter: false,      // không tra lại sau — tổng đúng 1 request/site
  }, { kind: 'readiness' });
}

// ------------------------------------------------------------------ tiện ích

function log(line) {
  logLines.unshift(`${new Date().toLocaleTimeString('vi-VN')}  ${line}`);
  logLines = logLines.slice(0, 300);
  const node = $('#run-log');
  if (node) node.textContent = logLines.join('\n');
}

function getNotificationIcon() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('HM', 32, 32);
    return canvas.toDataURL('image/png');
  } catch {
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }
}

async function notify(title, message) {
  if (typeof chrome === 'undefined' || !chrome.notifications?.create) return;
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: getNotificationIcon(),
      title,
      message,
    });
  } catch {
    // Thiếu icon hoặc quyền thì bỏ qua — thông báo hệ thống chỉ là tiện thêm.
  }
}

export { CODE_TTL_MS };
