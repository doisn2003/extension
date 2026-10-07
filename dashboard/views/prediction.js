/**
 * Tab "Dự đoán".
 *
 * Sự kiện dự đoán tỉ số chạy trên cả 15 nhà cái. Làm tay nghĩa là mở 15 tab, mỗi
 * tab tìm lại đúng trận đó rồi gõ lại đúng tỉ số đó. Tab này gom về một bảng:
 * một danh sách trận dùng chung, mỗi dòng là một site.
 *
 * Vì sao chỉ tải trận từ **một** site: UUID trận là chung toàn hệ thống (đã đối
 * chiếu vk88/k88/bu88, trùng từng ký tự). Gọi 15 lần chỉ để nhận về cùng một
 * danh sách là lãng phí. Cái **phải** hỏi từng site là sổ lượt và `siteId` —
 * đó là việc của nút "Đọc lượt các site".
 *
 * Ranh giới an toàn của tab này:
 *
 * - Nút "Gửi" nằm ở **từng dòng**, không có nút gửi tất cả. Mỗi POST trừ đúng
 *   một lượt và không hoàn tác được, nên thao tác đó phải là một chủ đích rõ
 *   ràng cho một site, không phải một cú bấm quét cả bảng.
 * - Gửi xong thì đọc lại sổ lượt từ phản hồi của server, không tự trừ ở client.
 * - Không có retry. Xem `lib/prediction.js#sendPredict`.
 */

import * as sites from '../../lib/sites.js';
import * as storage from '../../lib/storage.js';
import * as pred from '../../lib/prediction.js';
import { el, $, clear, toast, fmtInt, pooled } from '../ui.js';
import { vnDateTimeString } from '../../lib/vn-time.js';

let onDataChanged = () => {};

/**
 * Nội dung đang gõ dở của từng dòng, khoá theo brand.
 *
 * Bảng vẽ lại mỗi lần đọc lượt hoặc gửi xong. Nếu để state trong DOM thì mỗi lần
 * vẽ lại là mất hết tỉ số vừa gõ cho 15 site.
 */
const form = new Map();

const formOf = (brand) =>
  form.get(brand) || { uuid: '', home: '', away: '', sameCount: '', busy: false, result: null };

const setForm = (brand, partial) => form.set(brand, { ...formOf(brand), ...partial });

export function init({ onChange } = {}) {
  onDataChanged = onChange || (() => {});

  $('#btn-pred-load').addEventListener('click', handleLoadMatches);
  $('#btn-pred-turns').addEventListener('click', handleReadTurns);
  $('#btn-pred-discover').addEventListener('click', handleDiscover);
  $('#btn-pred-refresh').addEventListener('click', handleRefresh);
  $('#btn-pred-batch').addEventListener('click', handleBatchSend);
  $('#pred-allow-dup').addEventListener('change', renderSlipPreview);
  $('#pred-th-stt')?.addEventListener('click', handleToggleAll);
  $('#pred-th-check').addEventListener('click', handleToggleAll);

  // Gõ 10 kèo rồi lỡ tay F5 mà mất hết thì lần sau không ai dám gõ. Nhớ lại cả
  // ô kèo lẫn trận đang chọn.
  $('#pred-slips').addEventListener('input', async (e) => {
    await storage.patch('prediction', { slips: e.target.value });
    renderSlipPreview();
  });
  $('#pred-batch-match').addEventListener('change', async (e) => {
    await storage.patch('prediction', { batchMatch: e.target.value });
    renderSlipPreview();
  });

  return render();
}

/**
 * `siteId` phải có thì mới POST được, mà nó chỉ đọc được từ HTML trang chủ.
 *
 * Trước đây chỉ nút "Đọc lượt các site" đi lấy, nên ai bấm "Tải trận từ site"
 * rồi gửi luôn sẽ thấy nút Gửi câm lặng không bấm được — mọi thứ trên bảng trông
 * đã sẵn sàng, lý do thật thì nằm trong tooltip. Giờ mọi đường dẫn tới lúc gửi
 * đều đi qua đây, và lý do bị chặn được in thẳng ra dòng đó.
 */
async function ensureSiteId(site) {
  if (site.siteId) return site;
  const r = await pred.fetchSiteId(site.domain);
  if (!r.ok) return site;
  await sites.update(site.brand, { siteId: r.siteId });
  return { ...site, siteId: r.siteId };
}

const ensureAllSiteIds = (list) => pooled(list.filter((s) => s.isLogin), 5, ensureSiteId);

// ------------------------------------------------------------------ render

export async function render() {
  const [list, granted, store] = await Promise.all([
    sites.list(),
    sites.hasBroadPermission(),
    storage.get('prediction'),
  ]);

  renderNotice(granted, list, store);
  renderMatches(store);
  renderBatchMatchPicker(store);
  renderSites(list, store);
  renderSlipPreview();
}

/** Ô chọn trận của khối gửi hàng loạt. Giữ nguyên lựa chọn cũ khi vẽ lại. */
function renderBatchMatchPicker(store) {
  const sel = $('#pred-batch-match');
  const dangChon = sel.value || store.batchMatch || '';
  clear(sel);
  const running = store.matches.filter(pred.isRunning);
  sel.append(el('option', { value: '', text: running.length ? '— chọn trận —' : '— chưa tải trận —' }));
  for (const m of running) {
    sel.append(el('option', { value: m.id, text: `${m.home_team} – ${m.away_team}` }));
  }
  if (running.some((m) => m.id === dangChon)) sel.value = dangChon;

  const o = $('#pred-slips');
  if (!o.value && store.slips) o.value = store.slips;
}

function renderNotice(granted, list, store) {
  const notice = $('#pred-notice');
  if (!granted) {
    notice.hidden = false;
    notice.className = 'notice warn';
    notice.textContent = 'Chưa có quyền đọc cookie. Bấm "Cấp quyền đọc cookie" ở góc trên rồi dò lại site.';
  } else if (!list.length) {
    notice.hidden = false;
    notice.className = 'notice';
    notice.textContent = 'Chưa thấy site nào. Đăng nhập các nhà cái trong Chrome này rồi bấm "Dò site từ cookie".';
  } else if (!store.matches.length) {
    notice.hidden = false;
    notice.className = 'notice';
    notice.textContent = 'Chưa có trận nào. Bấm "Tải trận từ site" — chỉ 1 request, và danh sách dùng chung cho cả 15 site.';
  } else {
    notice.hidden = true;
  }
}

function renderMatches(store) {
  const body = clear($('#pred-matches-body'));
  const runningOnly = store.matches.filter(pred.isRunning);

  $('#pred-matches-summary').textContent = store.loadedAt
    ? `${runningOnly.length} trận đang nhận dự đoán · tải từ ${store.sourceBrand?.toUpperCase() || '?'} lúc ${vnDateTimeString(store.loadedAt)}`
    : 'Chưa tải danh sách trận.';

  if (!runningOnly.length) {
    body.append(el('tr', {}, el('td', {
      colspan: 7,
      class: 'empty',
      text: store.loadedAt
        ? 'Không có trận nào đang nhận dự đoán. (WAITING nghĩa là đã đóng, chờ kết quả — không phải sắp mở.)'
        : 'Chưa tải danh sách trận.',
    })));
    return;
  }

  runningOnly.forEach((m, i) => {
    body.append(el('tr', {},
      el('td', { class: 'num col-stt', text: i + 1 }),
      el('td', { class: 'site-name', text: `${m.home_team} – ${m.away_team}` }),
      el('td', { class: 'tiny', text: m.league_name || '—' }),
      el('td', { class: 'tiny mono', text: m.match_time ? vnDateTimeString(Date.parse(m.match_time)) : '—' }),
      el('td', { class: 'tiny mono', text: m.end_time ? vnDateTimeString(Date.parse(m.end_time)) : '—' }),
      el('td', { class: 'num mono', text: fmtInt(m.prize_amount) }),
      el('td', { class: 'tiny mono dim', title: `UUID dùng chung cho cả 15 site\n${m.id}`, text: shortId(m.id) }),
    ));
  });
}

const shortId = (uuid) => (uuid ? `${uuid.slice(0, 8)}…` : '—');

function renderSites(list, store) {
  const body = clear($('#pred-body'));
  const running = store.matches.filter(pred.isRunning);

  const daDoc = list.filter((s) => s.predictionTurns != null);
  const tongLuot = daDoc.reduce((a, s) => a + s.predictionTurns, 0);
  $('#pred-summary').textContent = list.length
    ? `${list.length} site · ${list.filter((s) => s.isLogin).length} đang đăng nhập` +
      (daDoc.length ? ` · đã đọc lượt ${daDoc.length} site, tổng ${tongLuot} lượt` : ' · chưa đọc lượt')
    : 'Chưa có site nào.';

  if (!list.length) {
    body.append(el('tr', {}, el('td', { colspan: 11, class: 'empty', text: 'Chưa có site nào.' })));
    return;
  }

  list.forEach((site, i) => body.append(renderRow(site, i + 1, running)));
}

function renderRow(site, stt, running) {
  const st = formOf(site.brand);
  const acc = site.account;

  const sessionChip = site.isLogin && acc
    ? el('span', { class: 'chip good tiny', text: 'Đăng nhập' })
    : el('span', { class: 'chip bad tiny', text: 'Chưa đăng nhập' });

  const turnChip = site.predictionTurns == null
    ? el('span', { class: 'chip tiny', text: '—' })
    : el('span', {
        class: `chip tiny ${site.predictionTurns > 0 ? 'good' : 'bad'}`,
        text: `${site.predictionTurns} lượt`,
      });

  // Ô chọn trận: chỉ liệt kê trận RUNNING. Trận WAITING đã đóng, đưa vào chỉ tổ
  // mời người dùng đốt một lượt vào chỗ chắc chắn hỏng.
  const matchSel = el('select', {
    class: 'label-select',
    disabled: st.busy || !running.length,
    onChange: (e) => edit(site, { uuid: e.target.value }),
  }, el('option', { value: '', text: running.length ? '— chọn trận —' : '— chưa có trận —' }),
     ...running.map((m) => el('option', {
       value: m.id,
       selected: m.id === st.uuid,
       text: `${m.home_team} – ${m.away_team}`,
     })));

  const scoreInput = (key, ph) => el('input', {
    type: 'number', min: 0, max: 99, step: 1, class: 'score-in', placeholder: ph,
    value: st[key], disabled: st.busy,
    onInput: (e) => edit(site, { [key]: e.target.value }),
  });

  const trangThai = sendState(site, st);

  return el('tr', { class: site.isLogin ? '' : 'row-disabled', dataset: { brand: site.brand } },
    el('td', { class: 'num col-stt', text: stt }),
    // Dùng chung cờ `enabled` với tab Site: tick ở đâu cũng là một danh sách.
    el('td', { class: 'col-check' },
      el('input', {
        type: 'checkbox',
        checked: !!site.enabled,
        disabled: !site.isLogin,
        title: site.isLogin ? 'Chọn site này cho lần gửi hàng loạt' : 'Site chưa đăng nhập',
        // Không vẽ lại cả bảng: xoá sạch <tbody> rồi dựng lại làm mất mốc cuộn,
        // tick site cuối bảng xong là bị ném về đầu trang. Chỉ preview số lượt
        // sẽ dùng là phụ thuộc `enabled`.
        onChange: async (e) => {
          await sites.update(site.brand, { enabled: e.target.checked });
          await renderSlipPreview();
        },
      })),
    el('td', { class: 'site-name', text: sites.displayName(site) }),
    el('td', { class: 'mono tiny', text: site.domain }),
    el('td', {}, sessionChip),
    el('td', { class: 'num mono tiny', text: acc?.uid ?? '—' }),
    el('td', { class: 'mono tiny', title: 'Đọc từ HTML trang chủ, không suy ra được từ domain', text: site.siteId || '—' }),
    el('td', { class: 'num' }, turnChip),
    el('td', {}, matchSel),
    el('td', { class: 'score-cell' },
      scoreInput('home', 'H'),
      el('span', { class: 'field-joiner', text: '–' }),
      scoreInput('away', 'A'),
      el('input', {
        type: 'number', min: 0, class: 'same-in',
        title: 'predicted_same_count — bạn đoán sẽ có bao nhiêu người cùng chọn tỉ số này',
        placeholder: 'cùng kèo', value: st.sameCount, disabled: st.busy,
        // Phải đi qua edit() như hai ô tỉ số: setForm suông thì nút Gửi không
        // tính lại, gõ xong vẫn thấy nút khoá.
        onInput: (e) => edit(site, { sameCount: e.target.value }),
      })),
    el('td', { class: 'col-action' },
      el('button', {
        class: 'btn btn-mini btn-primary',
        disabled: trangThai.disabled,
        title: trangThai.title,
        text: st.busy ? 'Submitting…' : 'Submit',
        onClick: () => handleSend(site),
      }),
      st.result
        ? el('div', { class: `tiny ${st.result.ok ? 'chip good' : 'chip bad'}`, text: st.result.text })
        : null,
      // Lý do bị chặn phải nhìn thấy được. Giấu trong tooltip là cách một nút câm
      // lặng làm người dùng tưởng tool hỏng.
      trangThai.lyDo ? el('div', { class: 'tiny bad-text', text: trangThai.lyDo }) : null),
  );
}

/** Nút "Gửi" bấm được chưa, và nếu chưa thì vì sao. Dùng chung cho lúc vẽ và lúc gõ. */
function sendState(site, st) {
  const loi = pred.validate({
    site, uuid: st.uuid, home: st.home, away: st.away, sameCount: st.sameCount,
  });

  // `handleSend` gọi ensureSiteId trước khi POST, nên thiếu siteId KHÔNG phải lý
  // do khoá nút — khoá vì nó là đúng cái bẫy đã làm nút Gửi câm lặng lần trước.
  const tuLoDuoc = new Set(['chưa đọc được siteId']);
  const chan = loi.filter((l) => !tuLoDuoc.has(l));

  // Thiếu tỉ số chỉ là "chưa gõ xong", không đáng báo đỏ. Cái đáng báo là những
  // thứ người dùng không tự đoán ra được: hết lượt, mất phiên.
  const chuaGoXong = new Set(['thiếu Đội nhà', 'thiếu Đội khách', 'thiếu Cùng kèo', 'chưa chọn trận']);
  let dangKe = chan.filter((l) => !chuaGoXong.has(l));

  // Chưa đăng nhập thì kéo theo thiếu uid lẫn siteId. Liệt kê cả ba là ba lần
  // nói một chuyện, và làm dòng đó cao gấp đôi các dòng khác.
  if (!site?.isLogin) dangKe = ['site chưa đăng nhập'];

  return {
    disabled: st.busy || chan.length > 0,
    title: chan.length
      ? `Chưa gửi được: ${chan.join('; ')}`
      : 'Gửi dự đoán — TRỪ 1 LƯỢT, không hoàn tác được',
    lyDo: dangKe.length ? dangKe.join('; ') : null,
  };
}

/**
 * Người dùng vừa sửa một ô.
 *
 * Cố tình **không** vẽ lại cả bảng: vẽ lại giữa lúc gõ là mất con trỏ khỏi ô
 * đang gõ. Chỉ vá đúng hai thứ thay đổi được — số "cùng kèo" và trạng thái nút.
 */
function edit(site, patch) {
  setForm(site.brand, patch);
  syncRow(site);
}

function syncRow(site) {
  const tr = document.querySelector(`tr[data-brand="${site.brand}"]`);
  if (!tr) return;
  const btn = tr.querySelector('button');
  if (!btn) return;
  const { disabled, title } = sendState(site, formOf(site.brand));
  btn.disabled = disabled;
  btn.title = title;
}

// ------------------------------------------------------------ gửi hàng loạt

/** Đọc lại ô kèo + ô chọn trận, in ra sẽ tốn bao nhiêu lượt ở những site nào. */
async function renderSlipPreview() {
  const box = $('#pred-slip-preview');
  if (!box) return;

  const { slips, errors } = pred.parseSlips($('#pred-slips').value);
  const uuid = $('#pred-batch-match').value;
  const chon = (await sites.list()).filter((s) => s.enabled && s.isLogin);
  const keHoach = planBatch(chon, slips);

  clear(box);

  if (errors.length) {
    box.append(el('div', { class: 'preview-error' },
      el('div', { class: 'preview-label', text: 'Kèo không đọc được' }),
      ...errors.map((e) => el('div', { class: 'tiny', text: e }))));
  }

  if (!slips.length) {
    box.append(el('div', { class: 'tiny dim', text: 'Nhập kèo dạng 0-0-40, 2-0-40, 3-1-40 — mỗi kèo là nhà-khách-số người cùng kèo.' }));
  } else {
    box.append(el('div', { class: 'preview-row' },
      el('span', { class: 'preview-label', text: `${slips.length} kèo` }),
      el('span', { class: 'mono', text: slips.map(pred.formatSlip).join('  ·  ') })));
  }

  const canhBao = [];
  if (!uuid) canhBao.push('chưa chọn trận');
  if (!chon.length) canhBao.push('chưa tick site nào đang đăng nhập');

  // Server KHÔNG khử trùng lặp (đã đo: 2 POST giống hệt nhau = 2 lượt). Gõ lặp
  // một tỉ số là tự đốt thêm lượt, nên phải nói ra trước khi bấm.
  const trung = pred.duplicateScores(slips);
  if (trung.length) {
    canhBao.push(`trùng tỉ số trong ô kèo: ${trung.map((d) => `${d.score} ×${d.count}`).join(', ')} — server không khử trùng, mỗi lần là 1 lượt`);
  }
  const thieuLuot = keHoach.filter((p) => p.n < slips.length);
  if (slips.length && thieuLuot.length) {
    canhBao.push(`${thieuLuot.length} site không đủ lượt cho hết ${slips.length} kèo — sẽ gửi tối đa theo lượt còn`);
  }

  if (keHoach.length && slips.length) {
    box.append(el('div', { class: 'preview-row' },
      el('span', { class: 'preview-label', text: 'Sẽ gửi' }),
      el('span', {}, `${keHoach.reduce((a, p) => a + p.n, 0)} lượt trên ${keHoach.filter((p) => p.n).length} site — `),
      el('span', { class: 'tiny mono', text: keHoach.map((p) => `${p.site.brand}:${p.n}`).join(' ') })));
  }

  if (canhBao.length) {
    box.append(el('div', { class: 'preview-warn', text: canhBao.join(' · ') }));
  }

  $('#btn-pred-batch').disabled = !uuid || !slips.length || !keHoach.some((p) => p.n > 0);
}

/**
 * Mỗi site gửi được bao nhiêu kèo.
 *
 * Chặn trên bằng sổ lượt của chính site đó. Site chưa đọc lượt (`null`) thì tin
 * người dùng và cho gửi đủ — server vẫn là chốt cuối, và ta dừng ngay khi nó báo lỗi.
 */
function planBatch(chosen, slips) {
  return chosen.map((site) => ({
    site,
    n: site.predictionTurns == null ? slips.length : Math.min(slips.length, site.predictionTurns),
  }));
}

/**
 * Gửi nhiều kèo lên nhiều site.
 *
 * Nhịp đi theo đúng những gì đo được: **song song giữa các site** (sổ lượt và
 * rate limit đều tính riêng từng site) nhưng **nối tiếp trong cùng một site**
 * (không có idempotency key, bắn song song thì các phản hồi trả về sổ lượt đua
 * nhau, không biết thực tế còn bao nhiêu).
 *
 * Gặp lỗi ở một site thì **dừng hẳn site đó**, không gửi nốt các kèo còn lại và
 * không thử lại — request đã bay đi thì lượt có thể đã bị trừ.
 */
async function handleBatchSend() {
  const { slips } = pred.parseSlips($('#pred-slips').value);
  const uuid = $('#pred-batch-match').value;
  const store = await storage.get('prediction');
  const tran = store.matches.find((m) => m.id === uuid);
  if (!tran || !slips.length) return;

  const chon = (await sites.list()).filter((s) => s.enabled && s.isLogin);
  const keHoach = planBatch(chon, slips).filter((p) => p.n > 0);
  const tongLuot = keHoach.reduce((a, p) => a + p.n, 0);

  const dongY = confirm(
    `Gửi hàng loạt: ${tran.home_team} – ${tran.away_team}\n\n` +
    `Kèo (${slips.length}): ${slips.map(pred.formatSlip).join(', ')}\n` +
    `Site (${keHoach.length}): ${keHoach.map((p) => `${p.site.brand}×${p.n}`).join(', ')}\n\n` +
    `TỐI ĐA ${tongLuot} LƯỢT sẽ bị trừ và không hoàn tác được.\n` +
    '(Kèo nào bạn đã đặt trên site đó sẽ được bỏ qua, nên số thực tế có thể ít hơn.)\n\nTiếp tục?',
  );
  if (!dongY) return;

  const btn = $('#btn-pred-batch');
  const log = clear($('#pred-batch-log'));
  btn.disabled = true;
  btn.textContent = 'Đang gửi…';

  let xong = 0;
  const ghi = (tone, text) => log.prepend(el('div', { class: `log-line ${tone}`, text }));

  const boQuaTrung = !$('#pred-allow-dup').checked;

  await pooled(keHoach, 5, async ({ site, n }) => {
    const day = await ensureSiteId(site);
    const ten = sites.displayName(day);

    // MỘT lần kiểm cho cả loạt, thay vì kiểm trước từng POST.
    const kiem = await pred.precheckMatch(day, uuid);
    if (!kiem.ok) {
      ghi('warn', `– ${ten} — ${kiem.message}. Bỏ qua site này (không mất lượt).`);
      return;
    }

    // Tỉ số đã đặt trên chính site này thì gửi lại chỉ tốn thêm lượt: server
    // không khử trùng lặp, đã đo trực tiếp.
    let danhSach = slips.slice(0, n);
    if (boQuaTrung) {
      const trung = danhSach.filter((s) => kiem.daDat.has(pred.scoreKey(s.home, s.away)));
      if (trung.length) {
        ghi('warn', `– ${ten} — bỏ qua ${trung.length} kèo đã đặt trước đó: ${trung.map(pred.formatSlip).join(', ')}`);
        danhSach = danhSach.filter((s) => !kiem.daDat.has(pred.scoreKey(s.home, s.away)));
      }
    }

    let conLai = day.predictionTurns;
    let daGui = 0;

    for (const slip of danhSach) {
      const nhan = `${ten} · ${pred.formatSlip(slip)}`;

      // precheck: false — đã kiểm một lần ở trên cho cả loạt.
      const res = await pred.sendPredict({ ...day, predictionTurns: conLai }, {
        uuid, home: slip.home, away: slip.away, sameCount: slip.sameCount, precheck: false,
      });
      xong += 1;
      daGui += 1;
      $('#pred-batch-progress').textContent = `${xong}/${tongLuot}`;

      if (res.ok) {
        conLai = res.remainingTurns;
        ghi('good', `✓ ${nhan} — còn ${res.remainingTurns ?? '?'} lượt`);
        continue;
      }

      // Hết lượt là kết cục bình thường, không phải sự cố: không có gì bị trừ,
      // và ta biết chắc sổ lượt bằng 0 nên khỏi hỏi lại.
      if (res.outOfTurns) {
        await sites.update(day.brand, { predictionTurns: 0 });
        ghi('warn', `– ${sites.displayName(day)} — hết lượt, dừng ở kèo ${pred.formatSlip(slip)} (không mất lượt nào).`);
        return;
      }

      // Dừng site này. Nếu request đã bay đi thì hỏi lại server thay vì đoán.
      if (res.sent) {
        const lai = await pred.fetchOngoing(day);
        if (lai.ok) await sites.update(day.brand, { predictionTurns: lai.remainingTurns });
        ghi('bad', `✕ ${nhan} — ${res.message}. Đã đọc lại sổ lượt: ${lai.ok ? lai.remainingTurns : '?'}. Dừng site này, KHÔNG gửi lại.`);
      } else {
        ghi('warn', `– ${nhan} — ${res.message} (chưa gửi gì, không mất lượt). Dừng site này.`);
      }
      return;
    }

    // Chốt sổ bằng một GET thay vì tin con số trong phản hồi cuối. Phản hồi của
    // POST nối tiếp thì đúng, nhưng nếu có tab khác cùng đặt thì nó đã cũ —
    // và một GET rẻ hơn nhiều so với một lượt bị hiểu nhầm là còn.
    if (daGui) {
      const chot = await pred.fetchOngoing(day);
      if (chot.ok) await sites.update(day.brand, { predictionTurns: chot.remainingTurns });
    }
  });

  btn.textContent = 'Gửi hàng loạt';
  await render();
  toast(`Xong ${xong}/${tongLuot} lượt. Xem nhật ký bên dưới.`, 'good', 9000);
  onDataChanged();
}

/** Tick / bỏ tick toàn bộ site đang đăng nhập. */
async function handleToggleAll() {
  const list = await sites.list();
  const dangDangNhap = list.filter((s) => s.isLogin);
  if (!dangDangNhap.length) return;
  const bat = !dangDangNhap.every((s) => s.enabled);
  for (const s of dangDangNhap) await sites.update(s.brand, { enabled: bat });
  await render();
  onDataChanged();
}

// ---------------------------------------------------------------- thao tác

/**
 * Tải danh sách trận — **1 request tới site đầu bảng**, cộng thêm một GET chi
 * tiết cho mỗi trận RUNNING để lấy `most_popular`.
 *
 * Toàn bộ là GET, không đụng tới sổ lượt.
 */
async function handleLoadMatches() {
  const list = await sites.list();
  const nguon = list.find((s) => s.isLogin);
  if (!nguon) return toast('Cần ít nhất một site đang đăng nhập để hỏi danh sách trận.', 'warn');

  const btn = $('#btn-pred-load');
  btn.disabled = true;
  btn.textContent = 'Đang tải…';
  try {
    const res = await pred.fetchOngoing(nguon);
    if (!res.ok) {
      return toast(`${sites.displayName(nguon)}: ${res.message}`, 'bad', 9000);
    }

    // Kèm most_popular + is_locked cho các trận còn nhận dự đoán.
    const running = res.matches.filter(pred.isRunning);
    const details = await pooled(running, 4, (m) => pred.fetchMatch(nguon, m.id));
    const merged = res.matches.map((m) => {
      const i = running.indexOf(m);
      const d = i >= 0 ? details[i] : null;
      return d?.ok ? { ...m, most_popular: d.data.most_popular, is_locked: d.data.is_locked } : m;
    });

    // patch chứ không set: set sẽ xoá mất ô kèo và trận đang chọn mà người dùng
    // vừa gõ, chỉ vì bấm "Tải trận".
    await storage.patch('prediction', {
      matches: merged,
      loadedAt: Date.now(),
      sourceBrand: nguon.brand,
    });

    // Sổ lượt của chính site nguồn đã có sẵn trong phản hồi — ghi luôn, khỏi hỏi lại.
    if (res.remainingTurns != null) {
      await sites.update(nguon.brand, { predictionTurns: res.remainingTurns });
    }

    // Lấy luôn siteId cho mọi site đang đăng nhập. Thiếu nó là không POST được,
    // mà bảng thì trông đã sẵn sàng — đúng cái bẫy đã làm nút Gửi câm lặng.
    await ensureAllSiteIds(list);

    await render();
    toast(
      `${sites.displayName(nguon)}: ${running.length}/${res.matches.length} trận đang nhận dự đoán. ` +
      'UUID dùng chung cho cả 15 site.',
      'good', 8000,
    );
    onDataChanged();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Tải trận từ site';
  }
}

/**
 * Hỏi từng site hai thứ không thể suy ra từ nơi khác: `siteId` và sổ lượt.
 *
 * Chạy song song giữa các site — an toàn, vì sổ lượt và rate limit đều tính
 * riêng từng site. Vẫn giới hạn 5 luồng cho lịch sự.
 */
async function handleReadTurns() {
  const list = (await sites.list()).filter((s) => s.enabled && s.isLogin);
  if (!list.length) return toast('Không có site nào vừa được tick chọn, vừa đang đăng nhập.', 'warn');

  const btn = $('#btn-pred-turns');
  const summary = $('#pred-summary');
  btn.disabled = true;
  btn.textContent = 'Đang đọc…';

  let xong = 0;
  try {
    const results = await pooled(list, 5, async (site) => {
      const patch = {};
      let moved = null;

      if (!site.siteId) {
        const s = await pred.fetchSiteId(site.domain);
        if (s.ok) patch.siteId = s.siteId;
        // Domain đã xoay. Chỉ báo lên chứ không tự ghi đè — việc dời domain là
        // của `discoverAndMerge`, nơi có sẵn lịch sử domain và cách khớp theo uid.
        if (s.finalDomain && s.finalDomain !== site.domain) moved = s.finalDomain;
      }

      const res = await pred.fetchOngoing(site);
      patch.predictionTurns = res.ok ? res.remainingTurns : null;

      await sites.update(site.brand, patch);
      summary.textContent = `${++xong}/${list.length} · ${sites.displayName(site)}`;
      return { site, ok: res.ok, message: res.message, turns: patch.predictionTurns, moved };
    });

    await render();

    const hong = results.filter((r) => !r.ok);
    const moved = results.filter((r) => r.moved);
    if (moved.length) {
      toast(`${moved.length} site đã đổi domain: ${moved.map((r) => `${r.site.brand}→${r.moved}`).join(', ')}. Bấm "Dò site từ cookie" để cập nhật.`, 'warn', 12000);
    }
    toast(
      hong.length
        ? `Đọc được ${results.length - hong.length}/${results.length}. Hỏng: ${hong.map((r) => `${r.site.brand} (${r.message})`).join(', ')}`
        : `Đã đọc lượt của ${results.length} site.`,
      hong.length ? 'warn' : 'good',
      hong.length ? 12000 : 6000,
    );
    onDataChanged();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Đọc lượt các site';
  }
}

/**
 * Gửi dự đoán cho đúng một site.
 *
 * Có hộp xác nhận vì đây là hành động **không hoàn tác được**: một lượt bị trừ
 * là mất hẳn. Hộp thoại nêu rõ site, trận, tỉ số — ba thứ mà nhầm một cái là
 * mất lượt vào chỗ vô nghĩa.
 */
async function handleSend(site) {
  const st = formOf(site.brand);
  const store = await storage.get('prediction');
  const m = store.matches.find((x) => x.id === st.uuid);
  if (!m) return toast('Trận đã chọn không còn trong danh sách. Tải lại trận.', 'warn');

  const conLai = site.predictionTurns == null ? 'chưa rõ' : `${site.predictionTurns}`;
  const dongY = confirm(
    `Gửi dự đoán trên ${sites.displayName(site)}\n\n` +
    `Trận:   ${m.home_team} – ${m.away_team}\n` +
    `Tỉ số:  ${st.home} – ${st.away}\n` +
    `Tài khoản: ${site.account?.username} (uid ${site.account?.uid})\n\n` +
    `Việc này TRỪ 1 LƯỢT và không hoàn tác được. Lượt còn lại: ${conLai}.\n\nTiếp tục?`,
  );
  if (!dongY) return;

  setForm(site.brand, { busy: true, result: null });
  await render();

  const day = await ensureSiteId(site);
  const res = await pred.sendPredict(day, {
    uuid: st.uuid,
    home: st.home,
    away: st.away,
    sameCount: st.sameCount,
  });

  if (res.ok) {
    setForm(site.brand, { busy: false, result: { ok: true, text: `✓ ${st.home}–${st.away}` } });
    await sites.update(site.brand, { predictionTurns: res.remainingTurns });
    toast(`${sites.displayName(site)}: ${res.message}. Còn ${res.remainingTurns ?? '?'} lượt.`, 'good', 7000);
  } else if (res.outOfTurns) {
    setForm(site.brand, { busy: false, result: { ok: false, text: 'hết lượt' } });
    await sites.update(site.brand, { predictionTurns: 0 });
    toast(`${sites.displayName(site)}: ${res.message} Không mất lượt nào.`, 'warn', 8000);
  } else {
    setForm(site.brand, { busy: false, result: { ok: false, text: '✕ hỏng' } });

    // Request đã bay đi mà kết quả không rõ ⇒ lượt CÓ THỂ đã bị trừ. Không đoán,
    // không retry — hỏi lại server cho chắc.
    if (res.sent) {
      const lai = await pred.fetchOngoing(site);
      if (lai.ok) await sites.update(site.brand, { predictionTurns: lai.remainingTurns });
      toast(
        `${sites.displayName(site)}: ${res.message}. Đã đọc lại sổ lượt: ${lai.ok ? lai.remainingTurns : 'không đọc được'}. ` +
        'KHÔNG tự gửi lại — request đã bay đi thì lượt có thể đã bị trừ.',
        'bad', 14000,
      );
    } else {
      toast(`${sites.displayName(site)}: ${res.message} — chưa gửi gì cả, không mất lượt.`, 'warn', 9000);
    }
  }

  await render();
  onDataChanged();
}

async function handleDiscover() {
  const btn = $('#btn-pred-discover');
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
    toast(
      parts.length ? `Dò domain xong: ${parts.join(' · ')}. Bấm Refresh để cập nhật tài khoản.` : 'Chưa tìm thấy domain site trong tab đang mở hoặc cookie.',
      parts.length && !res.issues?.length ? 'good' : 'warn', 8000,
    );
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
  const btn = $('#btn-pred-refresh');
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
