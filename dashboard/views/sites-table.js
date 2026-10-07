/** Discover chỉ đồng bộ domain cục bộ. Refresh mới đọc tài khoản qua API. */

import * as sites from '../../lib/sites.js';
import * as storage from '../../lib/storage.js';
import { ACCOUNT_ERRORS } from '../../lib/account-reader.js';
import { measureOffset, quality, consensus } from '../../lib/clock.js';
import { request, loadDictionary } from '../../lib/net.js';
import { vnToday, formatOffset } from '../../lib/vn-time.js';
import { LABEL_INFO } from '../../lib/blackbox.js';
import { el, $, clear, toast, fmtInt, fmtAgo, pooled } from '../ui.js';

/**
 * Tên trận cố tình vô nghĩa, dùng làm **mốc đối chiếu**: chữ ký phản hồi thu
 * được ở đây chính là hình dạng của "tên trận sai". Nút Thử nghiệm ở tab Trận
 * đấu sẽ so tên thật với mốc này — khác mốc nghĩa là server nhận ra tên trận.
 */
const PROBE_MATCH_NAME = 'HotMatch Probe A & HotMatch Probe B';
const PROBE_CONFIG_ID = '00000000-0000-0000-0000-000000000000';

let onDataChanged = () => {};

export function init({ onChange } = {}) {
  onDataChanged = onChange || (() => {});

  $('#btn-discover').addEventListener('click', handleDiscover);
  $('#btn-refresh').addEventListener('click', handleRefresh);
  $('#btn-login-all')?.addEventListener('click', handleLoginAll);
  $('#btn-sync-clock').addEventListener('click', handleSyncAll);
  $('#btn-open-all').addEventListener('click', handleOpenAll);
  $('#btn-probe').addEventListener('click', handleProbe);
  $('#btn-add-manual').addEventListener('click', handleAddManual);
  $('#th-stt')?.addEventListener('click', handleToggleSelectAll);
  $('#manual-domain').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddManual();
  });

  return render();
}

/** Đồng thuận đồng hồ hiện tại, để các view khác dùng chung. */
export async function currentConsensus() {
  const list = await sites.list();
  return consensus(list.map((s) => ({ key: s.brand, clock: s.clock })));
}

// ------------------------------------------------------------------ render

export async function render() {
  const [list, granted, passwords] = await Promise.all([
    sites.list(),
    sites.hasBroadPermission(),
    sites.getAllPasswords(),
  ]);
  const body = clear($('#sites-body'));
  const notice = $('#sites-notice');

  if (!granted) {
    notice.hidden = false;
    notice.className = 'notice warn';
    notice.textContent =
      'Discover vẫn dò được domain từ tab đang mở. Cấp quyền đọc cookie để Refresh đọc phiên và tài khoản.';
  } else if (!list.length) {
    notice.hidden = false;
    notice.className = 'notice';
    notice.textContent =
      'Chưa thấy site nào. Mở site trong Chrome này rồi bấm Discover; bấm Refresh để đọc tài khoản.';
  } else {
    notice.hidden = true;
  }

  renderConsensus(list);

  if (!list.length) {
    body.append(el('tr', {}, el('td', { colspan: 13, class: 'empty', text: 'Chưa có site nào.' })));
    renderFoot([]);
    return;
  }

  const cons = consensus(list.map((s) => ({ key: s.brand, clock: s.clock })));
  list.forEach((site, idx) => body.append(renderRow(site, idx + 1, cons, passwords)));
  renderFoot(list);
}

/**
 * Banner đồng thuận đồng hồ — con số quan trọng nhất trên màn hình này.
 * Lệch 2 giây mà không biết thì mọi tính toán thời điểm bắn đều vô nghĩa.
 */
function renderConsensus(list) {
  const node = $('#clock-consensus');
  const cons = consensus(list.map((s) => ({ key: s.brand, clock: s.clock })));

  if (!cons) {
    node.hidden = true;
    return;
  }

  node.hidden = false;
  const slow = cons.offsetMs > 0;
  const abs = Math.abs(cons.offsetMs);
  const big = abs > 500;
  node.className = `notice ${big ? 'warn' : ''}`;

  clear(node).append(
    el('strong', {
      text: big
        ? `Đồng hồ máy bạn ${slow ? 'CHẬM' : 'NHANH'} ${(abs / 1000).toFixed(2)}s so với server.`
        : `Đồng hồ máy bạn lệch ${formatOffset(cons.offsetMs)} so với server.`,
    }),
    ' ',
    el('span', {
      text: `Sai số ±${cons.uncertaintyMs}ms, ${cons.agree}/${cons.total} site đồng thuận.` +
        (cons.outliers.length ? ` Lệch nhóm: ${cons.outliers.join(', ')}.` : ''),
    }),
    big
      ? el('div', {
          class: 'tiny dim',
          style: 'margin-top:4px',
          text: 'Mọi thời điểm bắn đều tính theo giờ server đã hiệu chỉnh, không theo đồng hồ máy — nên độ lệch này đã được bù. Đây cũng là lý do bấm tay hay trượt.',
        })
      : null,
  );
}

async function handleEditLabel(site, e) {
  const next = e.target.value.trim();
  await sites.update(site.brand, { customLabel: next && next !== site.brand.toUpperCase() ? next : null });
  await render();
}

async function handleEditDomain(site, e) {
  const next = e.target.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!next || next === site.domain) return render();
  const history = [next, ...(site.domainHistory || []).filter((d) => d !== next)].slice(0, 10);
  await sites.update(site.brand, { domain: next, domainHistory: history, clock: null, probe: null, badMatchSig: null });
  toast(`${sites.displayName(site)}: đổi domain sang ${next}. Cần đo lại giờ và kiểm lại endpoint.`, 'warn', 7000);
  await render();
  onDataChanged();
}

function renderRow(site, stt, cons, passwords = {}) {
  const acc = site.account;

  const sessionChip = (() => {
    if (site.status === 'account-unverified') return el('span', { class: 'chip warn', text: 'Domain đã cập nhật · cần Refresh' });
    if (site.accountError) return el('span', { class: 'chip warn', text: ACCOUNT_ERRORS[site.accountError] || 'Chưa đọc được tài khoản', title: 'Thông tin cũ chưa được xác minh; hãy làm mới sau khi kiểm tra site.' });
    if (site.isLogin && acc) {
      const age = acc.tokenIat ? ` · token ${fmtAgo(acc.tokenIat)}` : '';
      return el('span', { class: 'chip good', text: `Đăng nhập${age}` });
    }
    if (acc) return el('span', { class: 'chip warn', text: 'Dữ liệu cũ, chưa xác nhận phiên' });
    return el('span', { class: 'chip bad', text: 'Chưa đăng nhập' });
  })();

  const clockCell = (() => {
    if (!site.clock) return el('span', { class: 'dim', text: '—' });
    if (!site.clock.ok) return el('span', { class: 'chip bad', title: site.clock.error, text: 'đo hỏng' });
    const isOutlier = cons?.outliers.includes(site.brand);
    const q = quality(site.clock);
    const tone = isOutlier ? 'bad' : q === 'good' ? 'good' : q === 'fair' ? 'warn' : 'bad';
    return el('span', {
      class: `chip ${tone}`,
      title: `Sai số tối đa ±${site.clock.uncertaintyMs}ms · ${site.clock.samples} mẫu · ${fmtAgo(site.clock.at)}` +
        (isOutlier ? '\nLệch khỏi đồng thuận của các site khác — sẽ dùng phép đo riêng của site này.' : ''),
    }, `${formatOffset(site.clock.offsetMs)} ±${site.clock.uncertaintyMs}ms`);
  })();

  const endpointCell = (() => {
    const p = site.probe;
    if (!p) return el('span', { class: 'dim tiny', text: 'chưa kiểm' });
    const isJson = (p.contentType || '').includes('json');
    const tone = isJson ? 'good' : 'bad';
    return el('span', {
      class: `chip ${tone} tiny`,
      title: `HTTP ${p.status} · ${p.contentType || 'không rõ kiểu'} · ${fmtAgo(p.at)}\nNhãn: ${LABEL_INFO[p.label]?.text || p.label}\nMẫu: ${(p.sample || '').slice(0, 200)}`,
      text: isJson ? `API ${p.status}` : `không phải API (${p.status})`,
    });
  })();

  const savedPassword = passwords?.[site.brand] || '';
  const keyIcon = savedPassword ? el('span', { class: 'acc-key-icon', title: 'Đã lưu mật khẩu' }, '🔑') : null;

  const passInput = el('input', {
    type: 'password',
    class: 'acc-pass-input',
    value: savedPassword,
    placeholder: 'Nhập mật khẩu…',
    title: 'Mật khẩu đăng nhập (Rê chuột để xem, Enter để lưu)',
    onMouseEnter: (e) => { e.target.type = 'text'; },
    onMouseLeave: (e) => {
      if (document.activeElement !== e.target) e.target.type = 'password';
    },
    onFocus: (e) => { e.target.type = 'text'; },
    onBlur: async (e) => {
      e.target.type = 'password';
      const val = e.target.value.trim();
      await sites.savePassword(site.brand, val);
      if (val) toast(`${sites.displayName(site)}: Đã lưu mật khẩu.`, 'good', 2500);
    },
    onKeyDown: (e) => {
      if (e.key === 'Enter') {
        e.target.blur();
        accWrap.classList.remove('is-pinned');
      } else if (e.key === 'Escape') {
        accWrap.classList.remove('is-pinned');
      }
    },
  });

  const popover = el('div', { class: 'acc-pass-popover' }, passInput);

  const userBtn = el('span', {
    class: 'acc-user-btn',
    title: 'Click để hiện/ẩn ô mật khẩu',
    onClick: (e) => {
      e.stopPropagation();
      const isPinned = accWrap.classList.toggle('is-pinned');
      if (isPinned) {
        passInput.focus();
      }
    },
  }, acc?.username || el('span', { class: 'dim', text: 'Chưa có user' }), keyIcon);

  const accWrap = el('div', { class: 'acc-wrap' }, userBtn, popover);
  const accountCell = el('td', { class: 'col-account' }, accWrap);

  const sttCell = el('td', { class: 'num col-stt', title: 'Kéo thả để sắp xếp lại vị trí site' },
    el('span', { class: 'stt-num', text: String(stt) }),
    el('span', { class: 'drag-icon', text: '☰' }),
  );

  // Chỉ cho phép kéo thả khi cố tình mousedown vào cột STT
  sttCell.addEventListener('mousedown', () => {
    row.setAttribute('draggable', 'true');
  });
  sttCell.addEventListener('mouseleave', () => {
    if (!window.__draggedBrand) {
      row.removeAttribute('draggable');
    }
  });

  const row = el('tr', { class: site.enabled ? '' : 'row-disabled', dataset: { brand: site.brand } },
    sttCell,
    el('td', { class: 'col-check' },
      el('input', {
        type: 'checkbox',
        checked: !!site.enabled,
        title: 'Tham gia bắn code',
        onChange: async (e) => {
          const bat = e.target.checked;
          e.target.closest('tr')?.classList.toggle('row-disabled', !bat);
          await sites.update(site.brand, { enabled: bat });
          renderFoot(await sites.list());
        },
      })),

    // Nhãn suy từ domain dạng số (BC117116) không mang nghĩa gì — cho sửa tay.
    el('td', {},
      el('input', {
        class: 'site-domain site-label',
        value: sites.displayName(site),
        title: `Tên hiển thị. Khoá nội bộ: ${site.brand}`,
        onChange: (e) => handleEditLabel(site, e),
      })),

    el('td', {},
      el('input', {
        class: 'site-domain',
        value: site.domain,
        title: (site.domainHistory || []).length > 1
          ? `Domain cũ: ${site.domainHistory.slice(1).join(', ')}`
          : 'Sửa khi site đổi đuôi tên miền',
        onChange: (e) => handleEditDomain(site, e),
      })),

    el('td', {}, sessionChip),
    el('td', { class: 'num', text: acc?.uid ?? '—' }),
    accountCell,
    el('td', { class: 'num', title: site.accountSource === 'api' ? 'Nguồn: API tài khoản' : 'Nguồn: cookie cũ', text: site.accountStale || acc?.balance == null ? '—' : fmtInt(acc.balance) }),
    el('td', { class: 'num' }, clockCell),
    el('td', {}, endpointCell),
    el('td', { class: 'col-action' },
      el('button', {
        class: 'btn btn-mini btn-login-row',
        text: 'Login',
        title: 'Đăng nhập vào site này bằng mật khẩu đã lưu',
        onClick: (e) => loginOne(site, e.target),
      })),
    el('td', { class: 'col-action' },
      el('button', {
        class: 'btn btn-mini',
        text: 'Open Page',
        title: 'Mở trang sự kiện trong tab mới',
        onClick: () => {
          try {
            chrome.tabs.create({ url: sites.buildPromoUrl(site), active: false });
          } catch (err) {
            console.warn(`[openPromo] Không thể mở tab cho ${site.brand}:`, err);
          }
        },
      })),
    el('td', { class: 'col-action' },
      el('button', {
        class: 'btn btn-mini',
        text: 'Sync',
        title: 'Đo độ lệch đồng hồ của site này',
        onClick: (e) => syncOne(site, e.target),
      })),
  );

  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', site.brand);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('is-dragging');
    window.__draggedBrand = site.brand;
  });

  row.addEventListener('dragend', () => {
    row.removeAttribute('draggable');
    row.classList.remove('is-dragging');
    document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach((r) => {
      r.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    window.__draggedBrand = null;
  });

  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!window.__draggedBrand || window.__draggedBrand === site.brand) return;
    const rect = row.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      row.classList.add('drag-over-top');
      row.classList.remove('drag-over-bottom');
    } else {
      row.classList.add('drag-over-bottom');
      row.classList.remove('drag-over-top');
    }
  });

  row.addEventListener('dragleave', () => {
    row.classList.remove('drag-over-top', 'drag-over-bottom');
  });

  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    const sourceBrand = window.__draggedBrand || e.dataTransfer.getData('text/plain');
    if (!sourceBrand || sourceBrand === site.brand) return;

    const currentList = await sites.list();
    const brands = currentList.map((s) => s.brand);
    const sourceIdx = brands.indexOf(sourceBrand);
    const targetIdx = brands.indexOf(site.brand);
    if (sourceIdx === -1 || targetIdx === -1) return;

    const rect = row.getBoundingClientRect();
    const placeBefore = e.clientY < (rect.top + rect.height / 2);

    brands.splice(sourceIdx, 1);
    const newTargetIdx = brands.indexOf(site.brand);
    const insertIdx = placeBefore ? newTargetIdx : newTargetIdx + 1;
    brands.splice(insertIdx, 0, sourceBrand);

    await sites.saveSiteOrder(brands);
    await render();
    onDataChanged();
    toast(`Đã chuyển ${sourceBrand.toUpperCase()} sang vị trí ${insertIdx + 1}.`, 'good', 3000);
  });

  return row;
}

function renderFoot(list) {
  const foot = clear($('#sites-foot'));
  const loggedIn = list.filter((s) => s.isLogin && s.account).length;
  const total = list.reduce((sum, s) => sum + (s.account?.balance || 0), 0);
  const probed = list.filter((s) => s.probe).length;

  foot.append(el('tr', {},
    el('td', { colspan: 7, class: 'tiny dim', text: 'Số dư từ cookie cũ hoặc API tài khoản; hiển thị — nếu chưa đọc được.' }),
    el('td', { class: 'num', text: fmtInt(total) }),
    el('td', { colspan: 5, class: 'tiny dim', text: `${loggedIn}/${list.length} còn phiên · ${probed}/${list.length} đã kiểm endpoint` }),
  ));

  $('#sites-summary').textContent = list.length
    ? `${list.length} site · ${loggedIn} đang đăng nhập · ${list.filter((s) => s.enabled).length} bật`
    : 'Chưa có site nào.';
}

// ------------------------------------------------------------------ actions

async function loginOne(site, btn) {
  const pwd = await sites.getPassword(site.brand);
  if (!pwd) {
    return toast(`${sites.displayName(site)}: Chưa lưu mật khẩu. Hãy nhập mật khẩu ở cột Account.`, 'warn', 5000);
  }
  if (!site.account?.username) {
    return toast(`${sites.displayName(site)}: Chưa có tên đăng nhập.`, 'warn', 5000);
  }

  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await sites.loginSite(site, pwd);
    if (res.ok) {
      toast(`${sites.displayName(site)}: Đăng nhập thành công!`, 'good', 4000);
      await render();
      onDataChanged();
    } else {
      toast(`${sites.displayName(site)}: Đăng nhập thất bại (${res.message})`, 'bad', 7000);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
}

async function handleLoginAll() {
  const [list, passwords] = await Promise.all([sites.list(), sites.getAllPasswords()]);
  const targets = list.filter((s) => s.enabled && passwords[s.brand]);

  if (!targets.length) {
    return toast('Không có site nào vừa được tick chọn, vừa đã lưu mật khẩu.', 'warn', 5000);
  }

  const btn = $('#btn-login-all');
  btn.disabled = true;
  btn.textContent = 'Đang login…';

  let successCount = 0;
  let failList = [];

  try {
    await pooled(targets, 4, async (site) => {
      const pwd = passwords[site.brand];
      const res = await sites.loginSite(site, pwd);
      if (res.ok) {
        successCount++;
      } else {
        failList.push(`${sites.displayName(site)}: ${res.message}`);
      }
    });

    await render();
    onDataChanged();

    if (failList.length === 0) {
      toast(`Đã đăng nhập thành công toàn bộ ${successCount}/${targets.length} site!`, 'good', 5000);
    } else {
      toast(
        `Đăng nhập thành công ${successCount}/${targets.length} site. Thất bại ${failList.length}: ${failList.join(', ')}`,
        successCount > 0 ? 'warn' : 'bad',
        9000,
      );
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Login All';
  }
}

// ------------------------------------------------------------------ actions

async function handleToggleSelectAll() {
  const list = await sites.list();
  if (!list.length) return;
  const allEnabled = list.every((s) => s.enabled);
  await sites.setAllEnabled(!allEnabled);
  await render();
  onDataChanged();
}

async function handleDiscover() {
  const btn = $('#btn-discover');
  btn.disabled = true;
  btn.textContent = 'Đang dò…';
  try {
    const res = await sites.discoverAndMerge();
    if (!res.granted) return toast('Cần cấp quyền đọc cookie trước.', 'warn');

    const parts = [];
    if (res.issues?.length) parts.push(sites.accountIssueText(res.issues));
    if (res.added.length) parts.push(`thêm ${res.added.length} site mới`);
    if (res.moved.length) parts.push(`${res.moved.length} site đổi domain (${res.moved.map((m) => `${m.brand}→${m.to}`).join(', ')})`);
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
  const btn = $('#btn-refresh');
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

async function syncOne(site, btn) {
  const config = await storage.get('config');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'đang đo…';
  }
  const clock = await measureOffset(sites.origin(site), { samples: config.clockSamples });
  await sites.setClock(site.brand, clock);
  await render();
  if (!clock.ok) toast(`${sites.displayName(site)}: không đo được giờ (${clock.error}).`, 'bad');
  return clock;
}

async function handleSyncAll() {
  const btn = $('#btn-sync-clock');
  const list = (await sites.list()).filter((s) => s.enabled);
  if (!list.length) return toast('Không có site nào đang bật.', 'warn');

  btn.disabled = true;
  let done = 0;
  const config = await storage.get('config');

  try {
    await pooled(list, 4, async (site) => {
      const clock = await measureOffset(sites.origin(site), { samples: config.clockSamples });
      await sites.setClock(site.brand, clock);
      done += 1;
      btn.textContent = `Đo ${done}/${list.length}…`;
    });

    await render();
    const cons = await currentConsensus();
    toast(
      cons
        ? `Đo xong. Đồng hồ máy lệch ${formatOffset(cons.offsetMs)} (±${cons.uncertaintyMs}ms, ${cons.agree}/${cons.total} site đồng thuận).`
        : 'Không đo được site nào — kiểm tra mạng và quyền host.',
      cons ? 'good' : 'bad',
      9000,
    );
    onDataChanged();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Đo';
  }
}

/**
 * Bắn một request nhận code với tên trận cố tình sai, lên từng site.
 *
 * Hai mục đích: xác nhận endpoint tồn tại và giống nhau trên cả 15 site, và
 * thu chữ ký phản hồi "tên trận sai" làm mốc cho nút Thử nghiệm ở Phase 2.
 */
async function handleProbe() {
  const list = (await sites.list()).filter((s) => s.enabled && s.account?.uid);
  if (!list.length) return toast('Không có site nào vừa bật vừa có UID.', 'warn');

  const date = vnToday();
  const sample = sites.buildClaimUrl(list[0], { matchName: PROBE_MATCH_NAME, date, uid: list[0].account.uid, configId: PROBE_CONFIG_ID });
  const agreed = confirm(
    `Sẽ gửi 1 request tới ${list.length} site, dùng tên trận cố tình sai để xem server trả về gì.\n\n` +
    `Ví dụ:\n${sample}\n\n` +
    `Tên trận không có thật nên không thể tiêu mất lượt nhận code của bạn. Tiếp tục?`,
  );
  if (!agreed) return;

  const btn = $('#btn-probe');
  btn.disabled = true;
  const dictionary = await loadDictionary();
  let done = 0;

  try {
    const results = await pooled(list, 4, async (site) => {
      const url = sites.buildClaimUrl(site, { matchName: PROBE_MATCH_NAME, date, uid: site.account.uid, configId: PROBE_CONFIG_ID });
      const res = await request({ url, brand: site.brand, phase: 'probe', dictionary });

      // Chữ ký này là mốc đối chiếu cho Thử nghiệm — lưu vào site.
      await sites.update(site.brand, {
        badMatchSig: res.sig,
        probe: {
          sig: res.sig,
          status: res.status,
          contentType: res.headers['content-type'] || '',
          label: res.label,
          sample: res.body.slice(0, 400),
          at: Date.now(),
        },
      });

      done += 1;
      btn.textContent = `Đang kiểm tra ${done}/${list.length}…`;
      return { site, res };
    });

    await render();

    const byStatus = {};
    for (const { res } of results) byStatus[res.status] = (byStatus[res.status] || 0) + 1;
    const distinctSigs = new Set(results.map((r) => r.res.sig));
    const jsonCount = results.filter((r) => (r.res.headers['content-type'] || '').includes('json')).length;
    const nonApi = results.filter((r) => !(r.res.headers['content-type'] || '').includes('json'));

    let tone = 'good';
    let extra = '';
    if (jsonCount < results.length) {
      tone = 'warn';
      extra = ` ${nonApi.length} site KHÔNG trả JSON (${nonApi.map((r) => r.site.brand).join(', ')}) — có thể dùng path khác, cần sửa claimPath riêng.`;
    } else if (distinctSigs.size > 1) {
      tone = 'warn';
      extra = ` Có ${distinctSigs.size} kiểu phản hồi khác nhau — xem tab Hộp đen để đối chiếu.`;
    }

    toast(
      `Kiểm tra xong ${results.length} site. HTTP ${Object.entries(byStatus).map(([s, n]) => `${s}×${n}`).join(', ')} · ${jsonCount} trả JSON.${extra}`,
      tone, 14000,
    );
    onDataChanged();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Kiểm tra endpoint';
  }
}

async function handleAddManual() {
  const input = $('#manual-domain');
  const value = input.value.trim();
  if (!value) return;
  try {
    const site = await sites.addManual(value);
    input.value = '';
    await render();
    toast(`Đã thêm ${sites.displayName(site)} (${site.domain}).`, 'good');
    onDataChanged();
  } catch (err) {
    toast(String(err.message || err), 'bad');
  }
}

async function handleOpenAll() {
  const list = await sites.list();
  const enabledSites = list.filter((s) => s.enabled);
  if (!enabledSites.length) return toast('Không có site nào đang bật để mở.', 'warn');

  for (const site of enabledSites) {
    try {
      chrome.tabs.create({ url: sites.buildPromoUrl(site), active: false });
    } catch (err) {
      console.warn(`[handleOpenAll] Không thể mở tab cho ${site.brand}:`, err);
    }
  }
  toast(`Đã mở ${enabledSites.length} trang nhà cái trong các tab mới.`, 'good');
}
