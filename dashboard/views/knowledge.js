/**
 * Tab Hộp đen.
 *
 * Phần quan trọng nhất là bảng từ điển: mỗi kiểu phản hồi tool từng gặp là một
 * dòng, bạn gán nhãn một lần và classify.js dùng nhãn đó mãi về sau. Đây là cách
 * tool khá lên sau mỗi trận mà không cần sửa code.
 */

import * as blackbox from '../../lib/blackbox.js';
import { LABELS, LABEL_INFO } from '../../lib/blackbox.js';
import { el, $, clear, toast, fmtInt, fmtAgo } from '../ui.js';

const LABEL_ORDER = [
  LABELS.UNKNOWN,
  LABELS.SUCCESS,
  LABELS.NOT_YET,
  LABELS.SOLD_OUT,
  LABELS.TRANSIENT,
  LABELS.THROTTLED,
  LABELS.SESSION_DEAD,
  LABELS.CHALLENGED,
  LABELS.BAD_MATCH,
];

export function init() {
  $('#btn-export').addEventListener('click', handleExport);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', handleImport);
  $('#btn-clear-attempts').addEventListener('click', () => handleClear('attempts'));
  $('#btn-clear-all').addEventListener('click', () => handleClear('all'));
  return render();
}

export async function render() {
  await Promise.all([renderCounts(), renderDictionary(), renderSuggestions()]);
}

async function renderCounts() {
  const [counts, unlabeled] = await Promise.all([blackbox.counts(), blackbox.countUnlabeled()]);
  const row = clear($('#bb-counts'));
  const stat = (value, label, tone) =>
    el('div', { class: 'stat' },
      el('div', { class: 'stat-value', style: tone ? `color: var(--${tone})` : '', text: fmtInt(value) }),
      el('div', { class: 'stat-label', text: label }));

  row.append(
    stat(counts.attempts, 'Lần bắn đã ghi'),
    stat(counts.runs, 'Trận đã chạy'),
    stat(counts.dictionary, 'Kiểu phản hồi'),
    stat(unlabeled, 'Chưa gán nhãn', unlabeled > 0 ? 'warn' : null),
    stat(counts.notes, 'Ghi chú'),
  );
}

async function renderDictionary() {
  const rows = await blackbox.listDictionary();
  const body = clear($('#dict-body'));

  if (!rows.length) {
    body.append(el('tr', {}, el('td', {
      colspan: 5,
      class: 'empty',
      text: 'Chưa ghi được phản hồi nào. Bấm "Kiểm tra endpoint" ở tab Site để thu mẫu đầu tiên.',
    })));
    return;
  }

  for (const row of rows) {
    const info = LABEL_INFO[row.label] || LABEL_INFO.UNKNOWN;
    const confirmed = row.labelSource === 'user';

    body.append(el('tr', {},
      el('td', { class: 'num', text: fmtInt(row.count) }),
      el('td', { class: 'num', text: row.status || '—' }),
      el('td', {},
        el('span', { class: 'sample', title: row.sample, text: row.sample || '(rỗng)' }),
        el('span', { class: 'tiny dim', text: `${fmtAgo(row.lastSeen)} · ${row.sig}` })),
      el('td', { class: 'tiny dim', text: (row.brands || []).join(', ') || '—' }),
      el('td', {},
        el('div', { class: 'btn-row' },
          el('select', {
            class: 'label-select',
            title: info.text,
            onChange: async (e) => {
              await blackbox.labelSignature(row.sig, e.target.value);
              toast(`Đã chốt: ${LABEL_INFO[e.target.value]?.text || e.target.value}`, 'good');
              await render();
            },
          }, ...LABEL_ORDER.map((label) =>
            el('option', { value: label, selected: label === row.label, text: LABEL_INFO[label].text }))),

          // Nhãn máy đoán chỉ là phỏng đoán. Một cú bấm biến nó thành tri thức đã chốt.
          confirmed
            ? el('span', { class: 'chip good tiny', text: 'bạn đã chốt' })
            : el('button', {
                class: 'btn btn-mini',
                text: 'Confirm',
                title: 'Chốt nhãn máy đang đoán. Engine sẽ tin nhãn này thay vì đoán lại.',
                onClick: async () => {
                  await blackbox.confirmSignature(row.sig);
                  toast(`Đã chốt: ${LABEL_INFO[row.label]?.text || row.label}`, 'good');
                  await render();
                },
              }),
          confirmed ? null : el('span', { class: 'chip unknown tiny', text: 'máy đoán' }),
        )),
    ));
  }
}

async function renderSuggestions() {
  const list = await blackbox.suggestions();
  const node = clear($('#suggestions'));
  if (!list.length) {
    node.append(el('li', { class: 'dim', text: 'Chưa đủ dữ liệu để đề xuất. Cần chạy vài trận thật trước.' }));
    return;
  }
  for (const s of list) node.append(el('li', { text: s.text }));
}

// ------------------------------------------------------------------ xoá dữ liệu

/**
 * Xoá có cân nhắc: nói rõ sắp mất bao nhiêu bản ghi và mất những gì.
 * Nhãn bạn đã chốt là phần đắt nhất trong hộp đen — chỉ mức "toàn bộ" mới đụng tới.
 */
async function handleClear(scope) {
  const c = await blackbox.counts();

  const message = scope === 'attempts'
    ? `Xoá ${fmtInt(c.attempts)} bản ghi lần bắn?\n\n`
      + `GIỮ LẠI: ${c.dictionary} nhãn phản hồi, ${c.runs} lịch sử trận, ${c.notes} ghi chú.\n`
      + 'Thống kê độ trễ và tỉ lệ thắng sẽ tính lại từ đầu.'
    : `Xoá TOÀN BỘ hộp đen?\n\n`
      + `MẤT: ${fmtInt(c.attempts)} lần bắn · ${c.dictionary} nhãn phản hồi (kể cả nhãn bạn đã chốt) · `
      + `${c.runs} lịch sử trận · ${c.notes} ghi chú.\n\n`
      + 'GIỮ LẠI: danh sách site, cấu hình, đồng hồ, danh sách trận.\n\n'
      + 'Nên bấm "Xuất gói dữ liệu" trước nếu còn muốn giữ.';

  if (!confirm(message)) return;

  const before = await blackbox.clearData(scope);
  await render();
  toast(
    scope === 'attempts'
      ? `Đã xoá ${fmtInt(before.attempts)} bản ghi lần bắn.`
      : `Đã xoá toàn bộ hộp đen (${fmtInt(before.attempts)} lần bắn, ${before.dictionary} nhãn).`,
    'good', 7000,
  );
}

// ------------------------------------------------------------------ xuất / nhập

async function handleExport() {
  const bundle = await blackbox.exportBundle();
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const a = el('a', { href: url, download: `hotmatch-blackbox-${stamp}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Đã xuất gói dữ liệu.', 'good');
}

async function handleImport(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const bundle = JSON.parse(await file.text());
    const includeSettings = confirm(
      'Nhập cả cấu hình và danh sách site trong gói này?\n\n' +
      'OK = ghi đè cấu hình hiện tại. Cancel = chỉ nhập log, từ điển và ghi chú.',
    );
    let added;
    try {
      added = await blackbox.importBundle(bundle, { includeSettings });
    } catch (err) {
      if (!(err instanceof blackbox.DuplicateBundleError)) throw err;
      if (!confirm('Gói này đã được nhập trước đó. Nhập lại sẽ nhân đôi log và làm sai thống kê.\n\nVẫn tiếp tục?')) {
        return toast('Đã huỷ nhập.', 'warn');
      }
      added = await blackbox.importBundle(bundle, { includeSettings, force: true });
    }
    toast(
      `Đã nhập ${added.attempts} lần bắn, ${added.runs} trận, ${added.dictionary} kiểu phản hồi, ${added.notes} ghi chú.`,
      'good', 8000,
    );
    await render();
  } catch (err) {
    toast(`Nhập thất bại: ${err.message || err}`, 'bad', 8000);
  }
}
