/**
 * Vỏ dashboard: chuyển tab, đồng hồ, quyền host.
 *
 * Trang này cũng là "não" của engine bắn. Nó là extension page nên Chrome không
 * bóp timer khi nó đang mở và hiển thị — đó là lý do lịch bắn nằm ở đây chứ
 * không nằm trong service worker.
 *
 * Mọi đồng hồ hiển thị đều là **giờ server đã hiệu chỉnh**, không phải đồng hồ
 * máy: đo thực tế cho thấy máy có thể chậm hơn server vài giây.
 */

import { $, toast } from './ui.js';
import { vnTimeString, vnDateString } from '../lib/vn-time.js';
import * as sitesLib from '../lib/sites.js';
import * as sitesView from './views/sites-table.js';
import * as betView from './views/bet-conditions.js';
import * as predictView from './views/prediction.js';
import * as matchView from './views/match-form.js';
import * as runView from './views/run.js';
import * as knowledgeView from './views/knowledge.js';

import { hasAnchor, serverNow as calibratedNow } from '../lib/clock.js';
let displayClock = null;
const serverNow = () => displayClock ? calibratedNow(displayClock) : Date.now();

async function refreshClockOffset() {
  const list = await sitesLib.list();
  displayClock = list.find((s) => s.enabled && hasAnchor(s.clock))?.clock || null;
  const label = document.querySelector('#server-clock')?.previousElementSibling;
  if (label) label.textContent = displayClock ? 'Giờ server tham khảo' : 'Giờ máy · chưa đo trong phiên này';
}

function initTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  for (const tab of tabs) {
    tab.addEventListener('click', async () => {
      for (const t of tabs) t.classList.toggle('is-active', t === tab);
      for (const panel of document.querySelectorAll('.panel')) {
        panel.classList.toggle('is-active', panel.id === tab.dataset.panel);
      }
      if (tab.dataset.panel === 'panel-sites') await sitesView.render();
      if (tab.dataset.panel === 'panel-bet') await betView.render();
      if (tab.dataset.panel === 'panel-predict') await predictView.render();
      if (tab.dataset.panel === 'panel-knowledge') await knowledgeView.render();
      if (tab.dataset.panel === 'panel-matches') await matchView.render();
      if (tab.dataset.panel === 'panel-run') await runView.render();
    });
  }
}

function initClock() {
  const timeNode = $('#server-clock');
  const dateNode = $('#vn-date');
  const tick = () => {
    const now = serverNow();
    timeNode.textContent = vnTimeString(now);
    dateNode.textContent = vnDateString(now);
    matchView.tick();
    runView.tick();
  };
  tick();
  setInterval(tick, 250);
}

async function initPermission() {
  const chip = $('#perm-chip');
  const btn = $('#btn-grant');

  const refresh = async () => {
    const granted = await chrome.permissions.contains({ origins: ['*://*/*'] });
    chip.hidden = false;
    chip.className = granted ? 'chip good' : 'chip warn';
    chip.textContent = granted ? 'Đã có quyền đọc cookie' : 'Chưa có quyền';
    btn.hidden = granted;
    return granted;
  };

  btn.addEventListener('click', async () => {
    // chrome.permissions.request bắt buộc phải gọi từ thao tác người dùng.
    const granted = await chrome.permissions.request({ origins: ['*://*/*'] });
    await refresh();
    if (granted) {
      toast('Đã cấp quyền. Đang dò site…', 'good');
      $('#btn-discover').click();
    } else {
      toast('Bạn đã từ chối. Tool không tự tìm được site khi thiếu quyền này.', 'warn', 7000);
    }
  });

  return refresh();
}

async function onDataChanged() {
  await refreshClockOffset();
  const activePanel = document.querySelector('.panel.is-active')?.id;
  const promises = [];
  if (activePanel !== 'panel-sites') promises.push(sitesView.render());
  if (activePanel !== 'panel-bet') promises.push(betView.render());
  if (activePanel !== 'panel-predict') promises.push(predictView.render());
  if (activePanel !== 'panel-matches') promises.push(matchView.render());
  if (activePanel !== 'panel-run') promises.push(runView.render());
  if (activePanel !== 'panel-knowledge') promises.push(knowledgeView.render());
  await Promise.all(promises);
}

async function main() {
  initTabs();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.sites) refreshClockOffset();
  });
  await initPermission();

  // Bản ghi site cũ mang sẵn nguyên bộ cấu hình mặc định, khiến mọi thiết lập
  // theo lần chạy bị vô hiệu. Dọn một lần khi mở dashboard.
  const cleaned = await sitesLib.migrateSiteConfigs();
  if (cleaned) toast(`Đã dọn cấu hình thừa ở ${cleaned} site.`, 'good');

  await refreshClockOffset();

  await sitesView.init({ onChange: onDataChanged });
  await betView.init({ onChange: onDataChanged });
  await predictView.init({ onChange: onDataChanged });
  await matchView.init({ onChange: onDataChanged, serverNow });
  await runView.init({ onChange: onDataChanged, serverNow });
  await knowledgeView.init();

  $('#btn-rehearse').addEventListener('click', () => runView.rehearse());

  initClock();
}

main().catch((err) => {
  console.error(err);
  toast(`Lỗi khởi động: ${err.message || err}`, 'bad', 12000);
});
