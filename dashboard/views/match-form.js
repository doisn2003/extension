/**
 * Tab Trận đấu — Phase 2.
 *
 * Bạn nhập tay tên hai đội, nên rủi ro lớn nhất là sai chính tả: sai một ký tự
 * là hỏng cả 15 site cùng lúc, và chỉ phát hiện ra đúng lúc code đã hết.
 *
 * Nút **Thử nghiệm** giải quyết chuyện đó bằng cách so sánh chứ không bằng cách
 * đọc thông báo: "Kiểm tra endpoint" ở tab Site đã thu sẵn chữ ký phản hồi khi
 * tên trận *chắc chắn sai*. Bắn tên thật rồi so với chữ ký đó — khác nghĩa là
 * server nhận ra tên trận, giống nghĩa là bạn gõ sai. Cách này không cần biết
 * server viết thông báo bằng chữ gì.
 */

import * as storage from '../../lib/storage.js';
import * as sites from '../../lib/sites.js';
import {
  validateMatch, splitPasted, sortByKickoff, releaseTime,
  offsetFromSiteCountdown, DEFAULT_RELEASE_OFFSET_MIN,
} from '../../lib/match.js';
import { vnToday, formatDuration, vnDateTimeString } from '../../lib/vn-time.js';
import { request, loadDictionary } from '../../lib/net.js';
import { LABEL_INFO } from '../../lib/blackbox.js';
import * as discover from '../../lib/discover.js';
import * as hotmatch from '../../lib/hotmatch.js';
import { el, $, clear, toast, fmtAgo, pooled } from '../ui.js';

let onDataChanged = () => {};
let getServerNow = () => Date.now();

export function init({ onChange, serverNow } = {}) {
  onDataChanged = onChange || (() => {});
  if (serverNow) getServerNow = serverNow;

  for (const id of ['#in-home', '#in-away', '#in-date', '#in-time', '#in-release-offset']) {
    $(id).addEventListener('input', renderPreview);
  }
  $('#in-home').addEventListener('paste', handlePasteWholeName);
  $('#btn-check-countdown').addEventListener('click', handleCountdownCheck);
  $('#btn-load-matches').addEventListener('click', handleLoadMatches);
  $('#btn-discover-api').addEventListener('click', handleDiscoverApi);
  $('#btn-save-match').addEventListener('click', handleSave);
  $('#btn-clear-match').addEventListener('click', () => {
    $('#in-home').value = '';
    $('#in-away').value = '';
    renderPreview();
  });

  $('#in-date').value = vnToday(getServerNow());
  renderPreview();
  return render();
}

function readForm() {
  return {
    home: $('#in-home').value,
    away: $('#in-away').value,
    date: $('#in-date').value,
    time: $('#in-time').value,
    releaseOffsetMin: $('#in-release-offset').value,
  };
}

// ------------------------------------------------------------------ preview

function renderPreview() {
  const node = clear($('#match-preview'));
  const input = readForm();

  if (!input.home && !input.away) {
    node.append(el('span', { class: 'dim', text: 'Nhập tên hai đội để xem trước chuỗi sẽ gửi lên server.' }));
    return;
  }

  const v = validateMatch(input, getServerNow());

  if (!v.ok) {
    for (const e of v.errors) node.append(el('div', { class: 'preview-error', text: `✕ ${e}` }));
    return;
  }

  const m = v.match;
  node.append(
    row('Tên trận gửi đi', el('code', { class: 'strong', text: m.matchName })),
    row('Tham số date', el('code', { text: m.dateParam })),
    row('Bóng lăn', `${vnDateTimeString(m.kickoffEpoch, false)} giờ VN`),
    // Đây mới là mốc engine dùng — code ra trước trận, không phải lúc bóng lăn.
    row('Phát code', el('span', {},
      el('strong', { text: vnDateTimeString(m.releaseEpoch, false) }),
      ` giờ VN — sớm hơn bóng lăn ${m.releaseOffsetMin} phút · còn ${formatDuration(m.releaseEpoch - getServerNow())}`)),
    row('URL sẽ gửi', el('code', { class: 'wrap', text: sampleUrlFor(m) })),
  );

  for (const w of v.warnings) node.append(el('div', { class: 'preview-warn', text: `⚠ ${w}` }));
}

/**
 * Lấy chính đồng hồ đếm ngược của nhà cái làm chuẩn.
 *
 * Đồng hồ đó đếm tới thời điểm *phát code*. Nhập con số đang hiện trên trang vào
 * đây là suy ra được số phút phát trước, không phải phỏng đoán.
 */
function handleCountdownCheck() {
  const out = $('#countdown-check');
  const v = validateMatch(readForm(), getServerNow());
  if (!v.ok) {
    out.className = 'tiny preview-error';
    out.textContent = 'Nhập đủ tên hai đội và giờ bóng lăn trước đã.';
    return;
  }

  const parsed = offsetFromSiteCountdown($('#in-site-countdown').value, v.match.kickoffEpoch, getServerNow());
  if (!parsed) {
    out.className = 'tiny preview-error';
    out.textContent = 'Định dạng phải là HH:MM:SS, ví dụ 00:57:58.';
    return;
  }

  const rounded = Math.round(parsed.offsetMin);
  const drift = Math.abs(parsed.offsetMin - rounded) * 60;

  // Kết quả chỉ dùng để lấy số PHÚT TRÒN, nên gõ lệch vài chục giây không ảnh
  // hưởng gì. Nói rõ điều đó thay vì khoe con số lệch giây làm người dùng tưởng
  // mình phải căn chuẩn.
  if (rounded === v.match.releaseOffsetMin) {
    out.className = 'tiny';
    out.style.color = 'var(--good)';
    out.textContent = `Khớp: phát trước ${rounded} phút. (Bạn gõ lệch tới ${Math.round(drift)}s vẫn ra kết quả này.)`;
    return;
  }

  out.className = 'tiny';
  out.style.color = 'var(--warn)';
  out.textContent = `Theo đồng hồ của họ thì phát trước ${rounded} phút, không phải ${v.match.releaseOffsetMin}. Đã sửa giúp bạn.`;
  $('#in-release-offset').value = rounded;
  renderPreview();
}

function row(label, value) {
  return el('div', { class: 'preview-row' },
    el('span', { class: 'preview-label', text: label }),
    typeof value === 'string' ? el('span', { text: value }) : value);
}

let cachedFirstSite = null;
function sampleUrlFor(match) {
  const site = cachedFirstSite;
  const siteConfigId = (site ? match.configBySite?.[site.brand] : null) || match.configId;
  if (!site) {
    if (siteConfigId) {
      return `…${sites.DEFAULT_PATHS.claimPath}?config_id=${encodeURIComponent(siteConfigId)}`;
    }
    return `…${sites.DEFAULT_PATHS.claimPath}?match_name=${encodeURIComponent(match.matchName)}`;
  }
  return sites.buildClaimUrl(site, { matchName: match.matchName, date: match.dateParam, uid: site.account?.uid ?? '…', configId: siteConfigId });
}

/** Dán cả "A & B" vào ô đội nhà thì tách hộ thay vì bắt sửa tay. */
function handlePasteWholeName(event) {
  const text = event.clipboardData?.getData('text') || '';
  const split = splitPasted(text);
  if (!split || $('#in-away').value.trim()) return;
  event.preventDefault();
  $('#in-home').value = split.home;
  $('#in-away').value = split.away;
  renderPreview();
  toast('Đã tách "A & B" thành hai ô.', 'good');
}

// ------------------------------------------------------------------ danh sách

export async function render() {
  const [matches, list] = await Promise.all([storage.get('matches'), sites.list()]);
  cachedFirstSite = list.find((s) => s.enabled && s.account?.uid) || list[0] || null;

  renderSuggestions(await storage.get('matchHistory'));

  const body = clear($('#matches-body'));
  if (!matches.length) {
    body.append(el('tr', {}, el('td', { colspan: 5, class: 'empty', text: 'Chưa có trận nào. Nhập ở form phía trên rồi bấm Lưu trận.' })));
    return;
  }

  for (const m of sortByKickoff(matches)) body.append(renderMatchRow(m));
}

function renderSuggestions(history) {
  const node = clear($('#team-suggestions'));
  for (const name of history.slice(0, 200)) node.append(el('option', { value: name }));
}

function renderMatchRow(m) {
  const release = releaseTime(m);
  const remaining = release - getServerNow();

  const testCell = (() => {
    if (!m.test) return el('span', { class: 'chip tiny', text: 'chưa thử' });
    const v = m.test.verdict;
    const tone = v === 'name-ok' ? 'good' : v === 'name-bad' ? 'bad' : 'warn';
    const text = v === 'name-ok' ? 'tên đúng' : v === 'name-bad' ? 'TÊN SAI' : 'không nhất quán';
    return el('span', {
      class: `chip ${tone}`,
      title: `${m.test.okCount}/${m.test.total} site nhận diện được tên trận · ${fmtAgo(m.test.at)}`,
      text: `${text} (${m.test.okCount}/${m.test.total})`,
    });
  })();

  return el('tr', { dataset: { id: m.id, release: String(release) } },
    el('td', {},
      el('div', { class: 'site-name', text: m.matchName }),
      el('div', { class: 'tiny dim mono', text: `date=${m.dateParam}` })),
    el('td', { class: 'tiny', text: vnDateTimeString(m.kickoffEpoch, false) }),
    el('td', { class: 'tiny' },
      el('strong', { text: vnDateTimeString(release, false) }),
      el('div', { class: 'tiny dim', text: `sớm hơn ${m.releaseOffsetMin ?? DEFAULT_RELEASE_OFFSET_MIN} phút` })),
    el('td', { class: 'num mono', text: formatDuration(remaining) }),
    el('td', {}, testCell),
    el('td', {},
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-mini', text: 'Test', onClick: (e) => handleTest(m, e.target) }),
        m.test ? el('button', { class: 'btn btn-mini', text: 'Details', onClick: () => renderTestDetail(m) }) : null,
        el('button', { class: 'btn btn-mini', text: 'Edit', onClick: () => loadIntoForm(m) }),
        el('button', { class: 'btn btn-mini', text: 'Delete', onClick: () => handleDelete(m) }))),
  );
}

/** Đếm ngược tới lúc PHÁT CODE — cùng thứ đồng hồ trên trang nhà cái đang đếm. */
export function tick() {
  const now = getServerNow();
  for (const tr of document.querySelectorAll('#matches-body tr[data-release]')) {
    const cell = tr.querySelector('td.num');
    const epoch = Number(tr.dataset.release);
    if (cell && Number.isFinite(epoch)) cell.textContent = formatDuration(epoch - now);
  }
}

// ------------------------------------------------------------------ lưu / xoá

function loadIntoForm(m) {
  $('#in-home').value = m.home;
  $('#in-away').value = m.away;
  $('#in-date').value = m.kickoffDate;
  $('#in-time').value = m.kickoffTime;
  $('#in-release-offset').value = m.releaseOffsetMin ?? DEFAULT_RELEASE_OFFSET_MIN;
  renderPreview();
  $('#in-home').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function handleSave() {
  const v = validateMatch(readForm(), getServerNow());
  if (!v.ok) return toast(v.errors.join(' '), 'bad', 7000);

  const matches = await storage.get('matches');
  const existingIndex = matches.findIndex((m) => m.id === v.match.id);
  if (existingIndex >= 0) {
    matches[existingIndex] = { ...matches[existingIndex], ...v.match };
    toast('Đã cập nhật trận.', 'good');
  } else {
    matches.push({ ...v.match, createdAt: Date.now(), test: null });
    toast('Đã lưu trận. Nhớ bấm Thử nghiệm để kiểm chính tả trước giờ bóng lăn.', 'good', 8000);
  }
  await storage.set('matches', matches);

  const history = await storage.get('matchHistory');
  for (const name of [v.match.home, v.match.away]) {
    if (!history.includes(name)) history.unshift(name);
  }
  await storage.set('matchHistory', history.slice(0, 300));

  await render();
  onDataChanged();
}

async function handleDelete(m) {
  if (!confirm(`Xoá trận "${m.matchName}"?`)) return;
  const matches = await storage.get('matches');
  await storage.set('matches', matches.filter((x) => x.id !== m.id));
  clear($('#test-detail'));
  await render();
  onDataChanged();
}

// ------------------------------------------------------------------ thử nghiệm

/**
 * Bắn một request thật với tên trận thật, so chữ ký với mốc "tên trận sai".
 * Đây là cổng nghiệm thu của Phase 2.
 */
async function handleTest(m, btn) {
  const list = (await sites.list()).filter((s) => s.enabled && s.account?.uid);
  if (!list.length) return toast('Không có site nào vừa bật vừa có UID.', 'warn');

  const withoutBaseline = list.filter((s) => !s.badMatchSig);
  if (withoutBaseline.length === list.length) {
    return toast('Chưa có mốc đối chiếu. Sang tab Site bấm "Kiểm tra endpoint" trước — nó thu chữ ký phản hồi khi tên trận sai.', 'warn', 12000);
  }

  const released = releaseTime(m) <= getServerNow();
  const warning = released
    ? '\n\n⚠ ĐÃ QUA GIỜ PHÁT CODE. Request này là một lần nhận code THẬT, không còn là thử nghiệm.'
    : '\n\nChưa tới giờ phát code — request này không tiêu mất lượt của bạn.';

  if (!confirm(`Gửi 1 request tới ${list.length} site với tên trận:\n\n"${m.matchName}"\ndate=${m.dateParam}${warning}\n\nTiếp tục?`)) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'đang thử…';
  }

  const dictionary = await loadDictionary();
  const results = {};
  let done = 0;

  try {
    await pooled(list, 4, async (site) => {
      const siteConfigId = m.configBySite?.[site.brand] || m.configId;
      const url = sites.buildClaimUrl(site, { matchName: m.matchName, date: m.dateParam, uid: site.account.uid, configId: siteConfigId });
      const res = await request({ url, brand: site.brand, phase: 'test', dictionary });

      results[site.brand] = {
        brand: site.brand,
        label: res.label,
        status: res.status,
        sig: res.sig,
        baselineSig: site.badMatchSig || null,
        // Khác mốc "tên sai" nghĩa là server phân biệt được tên này — tên đúng.
        recognised: site.badMatchSig ? res.sig !== site.badMatchSig : null,
        latencyMs: res.latencyMs,
        code: res.code || null,
        body: res.body.slice(0, 400),
      };
      done += 1;
      if (btn) btn.textContent = `${done}/${list.length}…`;
    });

    const judged = Object.values(results).filter((r) => r.recognised !== null);
    const okCount = judged.filter((r) => r.recognised).length;
    const verdict = !judged.length ? 'unknown'
      : okCount === judged.length ? 'name-ok'
      : okCount === 0 ? 'name-bad'
      : 'mixed';

    const matches = await storage.get('matches');
    const idx = matches.findIndex((x) => x.id === m.id);
    if (idx >= 0) {
      matches[idx].test = { at: Date.now(), verdict, okCount, total: judged.length, results };
      await storage.set('matches', matches);
      m = matches[idx];
    }

    await render();
    renderTestDetail(m);

    const message = {
      'name-ok': `Tên trận ĐÚNG — cả ${okCount}/${judged.length} site đều phân biệt được tên này với tên không tồn tại.`,
      'name-bad': `Chưa phân biệt được với tên sai (${judged.length}/${judged.length} site trả về y hệt phản hồi của tên bịa). `
        + 'Thường là do gõ sai chính tả — nhưng cũng có thể do dữ liệu trận chưa được đẩy lên. Soát lại tên, và thử lại lúc gần giờ phát code hơn.',
      mixed: `Không nhất quán: ${okCount}/${judged.length} site phân biệt được. Xem chi tiết bên dưới.`,
      unknown: 'Chưa site nào có mốc đối chiếu — chạy "Kiểm tra endpoint" ở tab Site trước.',
    }[verdict];
    toast(message, verdict === 'name-ok' ? 'good' : verdict === 'name-bad' ? 'bad' : 'warn', 14000);

    const won = Object.values(results).filter((r) => r.code);
    if (won.length) {
      toast(`Có ${won.length} site trả về code thật: ${won.map((r) => `${r.brand}=${r.code}`).join(', ')}. Sang tab Bắn code để đổi thưởng.`, 'good', 20000);
    }
    onDataChanged();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Thử nghiệm';
    }
  }
}

// -------------------------------------------------- tải trận thẳng từ server

/**
 * Một request, lấy về đúng chuỗi `match_name` mà API nhận code cần.
 *
 * Đây là thứ xoá bỏ hẳn rủi ro gõ sai chính tả: tên trận không còn do bạn gõ mà
 * do chính server đọc ra. Kèm theo là giờ bóng lăn, số code còn lại, và tài
 * khoản đã nhận code của trận đó chưa.
 */
async function handleLoadMatches() {
  const list = (await sites.list()).filter((s) => s.enabled && s.account?.uid && s.isLogin);
  if (!list.length) return toast('Không có site nào vừa bật, vừa đăng nhập, vừa có UID.', 'warn');

  const btn = $('#btn-load-matches');
  btn.disabled = true;
  btn.textContent = 'Đang tải…';
  const node = clear($('#api-discovery'));

  try {
    const dictionary = await loadDictionary();

    // Quét song song tất cả các site đã đăng nhập để gom config_id riêng cho từng site
    const fetchResults = await pooled(list, 6, async (site) => {
      const res = await hotmatch.fetchMatches(site, { dictionary });
      return { site, res };
    });

    const successful = fetchResults.filter((r) => r.res.ok);
    if (!successful.length) {
      const firstErr = fetchResults[0]?.res?.error || 'lỗi không rõ';
      node.append(el('div', { class: 'notice bad' },
        `Không lấy được danh sách trận từ site nào (${firstErr}). `
        + 'Endpoint có thể đã đổi — bấm "Dò lại endpoint" để tìm, hoặc nhập tay ở form trên.'));
      return toast('Tải trận thất bại. Xem ghi chú bên dưới.', 'bad', 9000);
    }

    // Hợp nhất danh sách trận và gom config_id theo từng site
    const matchMap = new Map();
    let primaryUpcoming = null;

    for (const { site, res } of successful) {
      const allOnSite = res.upcoming
        ? [res.upcoming, ...res.matches.filter((m) => m.id !== res.upcoming.id)]
        : res.matches;

      if (!primaryUpcoming && res.upcoming) {
        primaryUpcoming = res.upcoming;
      }

      for (const m of allOnSite) {
        if (!matchMap.has(m.id)) {
          matchMap.set(m.id, {
            ...m,
            configBySite: {},
          });
        }
        const existing = matchMap.get(m.id);
        if (m.configId) {
          existing.configBySite[site.brand] = m.configId;
        }
      }
    }

    const all = Array.from(matchMap.values());
    const siteNames = successful.map((s) => sites.displayName(s.site)).join(', ');

    node.append(el('h3', { text: 'Trận lấy từ server' }));
    node.append(el('div', { class: 'notice' },
      el('strong', { text: `${all.length} trận từ ${successful.length}/${list.length} site (${siteNames})` }),
      el('div', { class: 'tiny dim', style: 'margin-top:4px',
        text: 'Đã tự động thu thập config_id riêng cho từng nhà cái. Tên trận là nguyên văn của server.' })));

    node.append(renderServerMatches(all, primaryUpcoming));
    node.append(el('div', { class: 'btn-row', style: 'margin-top:10px' },
      el('button', {
        class: 'btn btn-primary',
        text: `Thêm tất cả ${all.length} trận vào danh sách`,
        onClick: () => importMatches(all),
      })));

    toast(`Tải được ${all.length} trận từ ${successful.length} site.`, 'good', 8000);
    onDataChanged();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Tải trận từ site';
  }
}

function renderServerMatches(all, upcoming) {
  const now = getServerNow();
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'grid' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Trận' }),
        el('th', { text: 'Bóng lăn (VN)' }),
        el('th', { text: 'Phát code (VN)' }),
        el('th', { class: 'num', text: 'Còn lại' }),
        el('th', { class: 'num', text: 'Code' }),
        el('th', { text: 'Đã nhận' }),
        el('th', {}))),
      el('tbody', {}, ...all.map((m) => el('tr', {},
        el('td', {},
          el('code', { class: 'strong', text: m.matchName }),
          m.id === upcoming?.id ? el('span', { class: 'chip good tiny', style: 'margin-left:6px', text: 'kế tiếp' }) : null,
          el('div', { class: 'tiny dim', text: m.campaignName ? `${m.league} · ${m.campaignName}` : m.league })),
        el('td', { class: 'tiny', text: vnDateTimeString(m.kickoffEpoch, false) }),
        el('td', { class: 'tiny' }, el('strong', { text: vnDateTimeString(m.releaseEpoch, false) })),
        el('td', { class: 'num mono', text: formatDuration(m.releaseEpoch - now) }),
        el('td', { class: 'num tiny', text: m.remainingCodes == null ? '—' : `${m.remainingCodes}/${m.totalCodes}` }),
        el('td', {}, m.received
          ? el('span', { class: 'chip warn tiny', title: m.giftCode || '', text: m.giftCode ? `rồi: ${m.giftCode}` : 'rồi' })
          : el('span', { class: 'chip tiny', text: 'chưa' })),
        el('td', {}, el('button', { class: 'btn btn-mini', text: 'Thêm', onClick: () => importMatches([m]) })),
      )))));
}

async function importMatches(incoming) {
  const matches = await storage.get('matches');
  let added = 0;
  for (const m of incoming) {
    const idx = matches.findIndex((x) => x.id === m.id);
    const existingConfigBySite = idx >= 0 ? (matches[idx].configBySite || {}) : {};
    const mergedConfigBySite = { ...existingConfigBySite, ...(m.configBySite || {}) };
    const record = {
      ...m,
      configBySite: mergedConfigBySite,
      createdAt: Date.now(),
      test: idx >= 0 ? matches[idx].test : null,
    };
    if (idx >= 0) matches[idx] = { ...matches[idx], ...record };
    else { matches.push(record); added += 1; }
  }
  await storage.set('matches', matches);
  await render();
  toast(added ? `Đã thêm ${added} trận.` : 'Đã cập nhật các trận đã có.', 'good');
  onDataChanged();
}

// ------------------------------------------------------- dò lại endpoint (dự phòng)

/**
 * Nếu tìm được endpoint liệt kê trận thì cả hai rủi ro lớn nhất biến mất: không
 * còn gõ tay tên trận, và có luôn thời điểm phát code do chính server công bố.
 * Chỉ thử trên một site, mỗi path một request.
 */
async function handleDiscoverApi() {
  const list = (await sites.list()).filter((s) => s.enabled && s.account?.uid && s.isLogin);
  if (!list.length) return toast('Không có site nào vừa bật, vừa đăng nhập, vừa có UID.', 'warn');

  const site = list[0];
  const date = vnToday(getServerNow());
  if (!confirm(
    `Thử ${discover.CANDIDATE_PATHS.length} đường dẫn ứng viên trên MỘT site (${sites.displayName(site)}), mỗi đường một request.\n\n` +
    `Mục đích: tìm chỗ server liệt kê các trận, để khỏi phải gõ tay tên trận và khỏi phải đoán số phút phát code trước.\n\n` +
    `Đây là các request đọc dữ liệu, không nhận code, không tiêu lượt.\n\nTiếp tục?`,
  )) return;

  const btn = $('#btn-discover-api');
  btn.disabled = true;
  const node = clear($('#api-discovery'));

  try {
    const dictionary = await loadDictionary();
    const results = await discover.probeMatchApi(site, {
      date,
      uid: site.account.uid,
      dictionary,
      onProgress: (done, total) => { btn.textContent = `Đang dò ${done}/${total}…`; },
    });

    const best = discover.bestResult(results);
    node.append(el('h3', { text: 'Kết quả dò API' }));

    if (best?.matches.length) {
      node.append(el('div', { class: 'notice' },
        el('strong', { text: `Tìm thấy ${best.matches.length} trận tại ${best.path}` }),
        el('div', { class: 'tiny dim', style: 'margin-top:4px', text: 'Bấm "Dùng trận này" để điền thẳng vào form — không còn nguy cơ gõ sai chính tả.' })));
      node.append(renderFoundMatches(best.matches));
    } else {
      node.append(el('div', { class: 'notice warn' },
        'Chưa rút được danh sách trận từ đường dẫn nào. Bảng dưới là nguyên văn những gì server trả về — '
        + 'gửi lại cho tôi để tôi dò tiếp hoặc viết bộ đọc riêng.'));
    }

    node.append(renderProbeTable(results));
    toast(`Dò xong ${results.length} đường dẫn. ${best?.matches.length ? `Tìm được ${best.matches.length} trận.` : 'Chưa thấy danh sách trận.'}`,
      best?.matches.length ? 'good' : 'warn', 10000);
    onDataChanged();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Dò API danh sách trận';
  }
}

function renderFoundMatches(found) {
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'grid' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Tên trận server trả về' }),
        el('th', { text: 'Các mốc thời gian tìm thấy' }),
        el('th', {}))),
      el('tbody', {}, ...found.slice(0, 40).map((f) => el('tr', {},
        el('td', {}, el('code', { class: 'strong', text: f.matchName })),
        el('td', { class: 'tiny' }, Object.entries(f.times).length
          ? Object.entries(f.times).map(([k, v]) => el('div', { text: `${k}: ${vnDateTimeString(v)}` }))
          : el('span', { class: 'dim', text: 'không thấy trường thời gian' })),
        el('td', {}, el('button', {
          class: 'btn btn-mini',
          text: 'Dùng trận này',
          onClick: () => {
            $('#in-home').value = f.home || '';
            $('#in-away').value = f.away || '';
            const stamps = Object.values(f.times).filter((t) => t > getServerNow() - 6 * 3600e3);
            if (stamps.length) {
              // Mốc muộn nhất thường là giờ bóng lăn; mốc sớm hơn hay là giờ phát code.
              const kickoff = Math.max(...stamps);
              const p = vnDateTimeString(kickoff).split(' ');
              $('#in-date').value = p[0];
              $('#in-time').value = p[1].slice(0, 5);
              if (stamps.length > 1) {
                const release = Math.min(...stamps);
                const mins = Math.round((kickoff - release) / 60000);
                if (mins > 0 && mins <= 180) $('#in-release-offset').value = mins;
              }
            }
            renderPreview();
            toast('Đã điền vào form. Soát lại rồi bấm Lưu trận.', 'good');
            $('#in-home').scrollIntoView({ behavior: 'smooth', block: 'center' });
          },
        })),
      )))));
}

function renderProbeTable(results) {
  return el('div', { class: 'table-wrap', style: 'margin-top:12px' },
    el('table', { class: 'grid' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Đường dẫn' }),
        el('th', { class: 'num', text: 'HTTP' }),
        el('th', { text: 'Kiểu' }),
        el('th', { class: 'num', text: 'Cỡ' }),
        el('th', { class: 'num', text: 'Trận' }),
        el('th', { text: 'Nguyên văn' }))),
      el('tbody', {}, ...results.map((r) => el('tr', {},
        el('td', { class: 'tiny mono', text: r.path }),
        el('td', { class: 'num', text: r.status }),
        el('td', { class: 'tiny', text: r.isJson ? 'JSON' : (r.contentType || '—').split(';')[0] }),
        el('td', { class: 'num tiny', text: `${r.bytes}B` }),
        el('td', { class: 'num', text: r.matches.length || '—' }),
        el('td', {}, el('span', { class: 'sample', title: r.sample, text: r.sample || '(rỗng)' })),
      )))));
}

function renderTestDetail(m) {
  const node = clear($('#test-detail'));
  if (!m.test) return;

  node.append(el('h3', { text: `Chi tiết thử nghiệm — ${m.matchName}` }));
  node.append(el('p', { class: 'hint', text: `Chạy ${fmtAgo(m.test.at)}. "Nhận diện" nghĩa là phản hồi KHÁC với phản hồi khi tên trận chắc chắn sai.` }));

  const rows = Object.values(m.test.results).sort((a, b) => a.brand.localeCompare(b.brand));
  node.append(el('div', { class: 'table-wrap' },
    el('table', { class: 'grid' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Site' }),
        el('th', { text: 'Nhận diện tên trận' }),
        el('th', { class: 'num', text: 'HTTP' }),
        el('th', { text: 'Nhãn' }),
        el('th', { class: 'num', text: 'Độ trễ' }),
        el('th', { text: 'Phản hồi' }))),
      el('tbody', {}, ...rows.map((r) => el('tr', {},
        el('td', { class: 'site-name', text: r.brand }),
        el('td', {}, r.recognised === null
          ? el('span', { class: 'chip tiny', text: 'chưa có mốc' })
          : el('span', { class: `chip ${r.recognised ? 'good' : 'bad'}`, text: r.recognised ? 'có' : 'không — giống hệt tên sai' })),
        el('td', { class: 'num', text: r.status }),
        el('td', { class: 'tiny', text: LABEL_INFO[r.label]?.text || r.label }),
        el('td', { class: 'num mono', text: `${r.latencyMs}ms` }),
        el('td', {}, el('span', { class: 'sample', title: r.body, text: r.body || '(rỗng)' })),
      ))))));
}
