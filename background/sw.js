/**
 * Service worker.
 *
 * Ở Phase 1 nó gần như trống, và đó là chủ ý: extension page có đủ quyền gọi
 * chrome.cookies / fetch, nên Dashboard tự làm hết được. Càng ít logic ở đây
 * càng ít lỗi do service worker MV3 bị kill giữa chừng.
 *
 * Phase 3 sẽ thêm phần "máy nhịp": SW là nơi duy nhất không bị Chrome bóp timer
 * khi tab ẩn, nên nó sẽ gửi tick cho content script trong 3 giây cuối.
 */

const PRUNE_ALARM = 'blackbox-prune';
const PRUNE_DAYS = 90;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 24 * 60 });
});

chrome.action.onClicked.addListener(() => {
  openDashboard();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== PRUNE_ALARM) return;
  const { prune } = await import('../lib/blackbox.js');
  await prune(PRUNE_DAYS);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'open-dashboard') {
    openDashboard().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

/** Chỉ một tab dashboard: mở lại thì nhảy về tab cũ thay vì đẻ thêm tab mới. */
async function openDashboard() {
  const url = chrome.runtime.getURL('dashboard/dashboard.html');
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}
