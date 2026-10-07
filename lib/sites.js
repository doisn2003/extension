/** Site registry: legacy JSON cookies or authenticated profile API.
 * Raw session cookies and API response bodies are never persisted.
 */

import * as storage from './storage.js';
import { DEFAULT_SITE_CONFIG } from './storage.js';
import { fetchProfile, ACCOUNT_ERRORS } from './account-reader.js';
import { selectTabDomains, tabBrand } from './tab-domains.js';

/** Path mặc định theo API mới nhất. Không dùng /hotmatch-proxy/ */
export const DEFAULT_PATHS = {
  promoPath: '/khuyen-mai/free-code-tran-dau-hot',
  claimPath: '/api/v1/hotmatch/giftcode',
  // Endpoint đổi thưởng: /api/v1/gift-code
};

const GENERIC_LABELS = new Set(['www', 'm', 'mobile', 'app', 'web', 'wap', 'api', 'static']);

// ---------------------------------------------------------------- phân tích cookie

function tryDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Cookie `user` là JSON đã URL-encode. Tên cookie quá chung nên phải kiểm tra
 * hình dạng bên trong để không nhận nhầm site khác: phải có đủ id + token và
 * một trong các trường đặc trưng của nền tảng này.
 */
export function parseUserCookie(rawValue) {
  let obj;
  try {
    obj = JSON.parse(tryDecode(rawValue));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const hasIdentity = typeof obj.id === 'number' && typeof obj.token === 'string';
  const hasPlatformMarker =
    obj.member_id !== undefined || obj.boping_id !== undefined || obj.uuid !== undefined;
  if (!hasIdentity || !hasPlatformMarker) return null;

  return obj;
}

/** Giải payload JWT để lấy `iat` — dùng ước lượng tuổi phiên đăng nhập. */
export function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Mã đại lý có dạng vài chữ cái rồi tới một dãy số dài (`bc120049`, `ac183423`).
 * Tên nhà cái thật thì không (`tip88`, `uk88`, `11bet`, `bom88`).
 */
export function looksLikeBrand(value) {
  const s = String(value || '').toLowerCase();
  if (!s || s.length > 20) return false;
  if (/^[a-z]{1,3}\d{5,}$/.test(s)) return false;
  return /[a-z]/.test(s);
}

/** `tip88.fyi` -> `tip88`. Bỏ qua các nhãn chung như www/m/app. */
export function brandFromHost(host) {
  const labels = String(host || '').replace(/^\./, '').split('.');
  for (const label of labels) {
    if (!GENERIC_LABELS.has(label)) return label.toLowerCase();
  }
  return labels[0] || host;
}

function accountFromUser(user) {
  const jwt = decodeJwtPayload(user.token);
  let phone = user.phone || '';
  if (!phone && jwt?.phone) {
    phone = String(jwt.phone).replace(/^\d+_/, '');
  }
  if (!phone && user.phonemask) {
    phone = user.phonemask;
  }

  return {
    uid: user.id,
    username: user.username || '',
    fullname: user.fullname || '',
    phone: phone || '',
    phonemask: user.phonemask || '',
    isVerifyPhone: !!user.is_verify_phone,
    uuid: user.uuid || '',
    balance: typeof user.balance === 'number' ? user.balance : null,
    vip: user.vip_info || '',
    memberId: user.member_id ?? null,
    tokenIat: jwt?.iat ? jwt.iat * 1000 : null,
    tokenDomain: jwt?.domain || '',
    readAt: Date.now(),
  };
}

// ---------------------------------------------------------------- quyền

export async function hasBroadPermission() {
  return chrome.permissions.contains({ origins: ['*://*/*'] });
}

// ---------------------------------------------------------------- đọc cookie

/**
 * Đọc tài khoản từ cookie JSON cũ hoặc API với phiên opaque hiện tại.
 * @returns {Promise<{host:string, account:object|null, isLogin:boolean, brandHint:string|null}>}
 */
const pendingReads = new Map();
export function readHost(host, options = {}) {
  if (pendingReads.has(host)) return pendingReads.get(host);
  const work = readHostOnce(host, options).finally(() => pendingReads.delete(host));
  pendingReads.set(host, work);
  return work;
}

async function readHostOnce(host, { known = true } = {}) {
  const url = `https://${host}/`;
  const base = { host, account: null, isLogin: false, brandHint: null, source: null, error: null, state: 'logged-out' };
  let cookies = [];
  try {
    if (!(await chrome.permissions.contains({ origins: [`https://${host}/*`] }))) {
      return { ...base, state: 'error', error: 'permission' };
    }
    cookies = await chrome.cookies.getAll({ url });
  } catch {
    return { ...base, state: 'error', error: 'cookies' };
  }

  const byName = new Map();
  // Chrome orders cookies by path/creation time; keep the first duplicate.
  for (const c of cookies) if (!byName.has(c.name)) byName.set(c.name, c.value);
  const user = byName.has('user') ? parseUserCookie(byName.get('user')) : null;

  // Cookie `recently_<uid>_<x>` không phải lúc nào cũng chứa tên nhà cái: trên
  // nhiều site nó là mã đại lý (bc120049, ac183423) trong khi domain thật là
  // 11bet.date, net88.beer. Chỉ nhận gợi ý này khi nó trông giống tên thương
  // hiệu, còn lại lấy tên từ domain.
  let brandHint = null;
  for (const c of cookies) {
    const m = /^recently_(\d+)_(.+)$/.exec(c.name);
    if (m && looksLikeBrand(m[2])) {
      brandHint = m[2].toLowerCase();
      break;
    }
  }

  base.brandHint = brandHint;
  const loginFlag = tryDecode(byName.get('is_login') || '') === 'true';
  if (user) return { ...base, account: accountFromUser(user), isLogin: loginFlag, source: 'cookie', state: loginFlag ? 'ok' : 'logged-out' };
  const platformMarker = cookies.some(c => /^chat_token_(?:AC|BC)\d+$/i.test(c.name));
  const supported = known || BRAND_ORDER.includes(brandFromHost(host)) || brandFromHost(host) === 'vu88' || platformMarker;
  // A generic cookie named user on an unrelated website is not a discovery signal.
  if (!supported) return { ...base, state: 'ignored' };
  if (!byName.has('user') && !loginFlag) return base;
  const result = await fetchProfile(host);
  if (result.state !== 'ok') return { ...base, state: result.state, error: result.error || null, source: 'api' };
  return { ...base, account: accountFromUser(result.user), isLogin: true, source: 'api', state: 'ok' };
}

/** Offline discovery: committed tab URLs win; local cookies are a fallback. */
export async function discover() {
  const registry = await storage.get('sites');
  const tabs = await readTabDomains(registry);
  const found = new Map([...tabs].map(([brand, item]) => [brand, { ...item, source: 'tab' }]));
  const issues = [];
  const granted = await hasBroadPermission();
  if (!granted) return { granted: found.size > 0, found: [...found.values()], issues };
  let cookies;
  try {
    const [users, flags] = await Promise.all([
      chrome.cookies.getAll({ name: 'user' }), chrome.cookies.getAll({ name: 'is_login' }),
    ]);
    cookies = [...users, ...flags];
  } catch {
    if (!found.size) throw new Error(ACCOUNT_ERRORS.cookies);
    return { granted: true, found: [...found.values()], issues: [{ host: 'Cookie', error: 'cookies' }] };
  }
  const brands = recognizedBrands(registry);
  const currentHosts = new Set(Object.values(registry).map(site => site.domain));
  const byHost = new Map();
  for (const cookie of cookies) {
    const host = cookie.domain.replace(/^\./, '');
    const user = cookie.name === 'user' ? parseUserCookie(cookie.value) : null;
    const previous = byHost.get(host);
    if (!previous || user) byHost.set(host, { host, user });
  }
  for (const { host, user } of byHost.values()) {
    const brand = tabBrand(host, brands) || brandFromHost(host);
    // Open-tab URLs already determined this brand; stale cookies cannot undo it.
    if (tabs.has(brand)) continue;
    const saved = registry[brand] || Object.values(registry).find(site => tabBrand(site.domain, brands) === brand);
    if (saved && saved.domain !== host && saved.domainHistory?.includes(host)) continue;
    let supported = brands.has(brand) || currentHosts.has(host) || !!user;
    if (!supported) {
      try {
        const metadata = await chrome.cookies.getAll({ url: `https://${host}/` });
        supported = metadata.some(c => /^chat_token_(?:AC|BC)\d+$/i.test(c.name));
      } catch { /* Unrelated/unknown host: no account request is ever made. */ }
    }
    if (!supported) continue;
    const item = { host, brand, source: 'cookie', identityUid: user?.id ?? null, tokenIat: decodeJwtPayload(user?.token)?.iat || 0 };
    const previous = found.get(brand);
    // Without a tab, keep a saved domain instead of oscillating between aliases.
    if (!previous || (currentHosts.has(host) && !currentHosts.has(previous.host)) ||
        (currentHosts.has(host) === currentHosts.has(previous.host) && item.tokenIat > previous.tokenIat)) found.set(brand, item);
  }
  return { granted: true, found: [...found.values()], issues };
}

export function accountReadSummary(records) {
  const list = Object.values(records);
  const errors = list.filter(s => s.accountError);
  const ready = list.filter(s => s.isLogin && s.account && !s.accountStale).length;
  return {
    text: `Đọc được tài khoản: ${ready}/${list.length} site.` + (errors.length ? ' ' + errors.map(s => `${displayName(s)}: ${ACCOUNT_ERRORS[s.accountError] || 'Không đọc được tài khoản'}`).join(' · ') : ''),
    tone: errors.length || ready !== list.length || !list.length ? 'warn' : 'good',
  };
}

export function accountIssueText(issues = []) {
  return issues.map(i => `${i.host}: ${ACCOUNT_ERRORS[i.error] || 'Không đọc được tài khoản'}`).join(' · ');
}

function applyAccountRead(site, detail) {
  if (detail.account) site.account = detail.account;
  site.isLogin = detail.isLogin;
  site.accountStale = !detail.isLogin || !detail.account;
  // Retain identity for display/manual login, but clear the outdated balance.
  if (site.accountStale && site.account) site.account = { ...site.account, balance: null };
  site.accountSource = detail.source;
  site.accountError = detail.error;
  site.accountCheckedAt = Date.now();
  if (detail.state === 'error') site.status = 'account-error';
  else if (!detail.isLogin) site.status = 'logged-out';
  else if (['account-error', 'logged-out', 'account-unverified'].includes(site.status)) site.status = 'ok';
  site.updatedAt = Date.now();
}

// ---------------------------------------------------------------- registry

function newSiteRecord(brand, host, account, isLogin) {
  return {
    brand,
    label: brand.toUpperCase(),
    /** Người dùng đặt tên hiển thị; nhãn suy từ domain số kiểu BC117116 vô nghĩa. */
    customLabel: null,
    domain: host,
    enabled: true,
    account: account || null,
    isLogin: !!isLogin,
    paths: { ...DEFAULT_PATHS },
    // Rỗng, KHÔNG phải bản sao mặc định. `cfgFor` cho config của site đè lên
    // config của lần chạy, nên nếu ở đây có sẵn đủ khoá thì mọi thiết lập theo
    // lần chạy đều bị vô hiệu — đúng lỗi từng khiến Diễn tập bắn cả nghìn request.
    config: {},
    clock: null,
    /** Chữ ký phản hồi khi tên trận sai — làm mốc đối chiếu cho nút Thử nghiệm. */
    badMatchSig: null,
    domainHistory: [host],
    status: 'ok',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function displayName(site) {
  if (site.customLabel) return site.customLabel;
  // Registry cũ có thể đang giữ khoá là mã đại lý (bc120049). Không đổi khoá —
  // đổi khoá là mất lịch sử — chỉ hiển thị tên suy từ domain hiện tại.
  if (!looksLikeBrand(site.brand)) return brandFromHost(site.domain).toUpperCase();
  return site.label || site.brand.toUpperCase();
}

/** Domain metadata only; never refresh account data during Discover. */
export function discoverAndMerge() {
  return serialized(async () => {
    const { granted, found, issues } = await discover();
    if (!granted) return { granted: false, added: [], moved: [], updated: [], issues };
    const registry = await storage.get('sites');
    const result = mergeDomainRecords(registry, found);
    await storage.set('sites', registry);
    return { granted: true, ...result, issues };
  });
}

function recognizedBrands(registry) {
  const brands = new Set([...BRAND_ORDER, 'vu88']);
  for (const site of Object.values(registry)) {
    // Existing, explicitly added branded domains may also rotate suffixes.
    const brand = brandFromHost(site.domain);
    if (looksLikeBrand(brand)) brands.add(brand);
  }
  return brands;
}

async function readTabDomains(registry) {
  if (!chrome.tabs?.query) return new Map();
  const tabs = await chrome.tabs.query({});
  return selectTabDomains(tabs, recognizedBrands(registry), new Set(Object.values(registry).map(site => site.domain)), {
    incognito: !!chrome.extension?.inIncognitoContext,
  });
}

function moveDomain(site, host, source) {
  const from = site.domain;
  site.domainHistory = [host, from, ...(site.domainHistory || [])].filter((value, index, all) => value && all.indexOf(value) === index).slice(0, 10);
  site.domain = host;
  site.clock = null;
  site.probe = null;
  site.badMatchSig = null;
  site.domainSource = source;
  site.domainUpdatedAt = Date.now();
  // A visible tab proves its URL, not the account or session on that new host.
  site.isLogin = false;
  site.accountStale = true;
  site.accountSource = null;
  site.accountError = null;
  site.accountCheckedAt = null;
  if (site.account) site.account = { ...site.account, balance: null };
  site.status = 'account-unverified';
  site.updatedAt = Date.now();
  return { brand: site.brand, from, to: host };
}

function mergeDomainRecords(registry, found) {
  const added = [], moved = [], updated = [];
  const brands = recognizedBrands(registry);
  for (const item of found) {
    const existing = registry[item.brand] || Object.values(registry).find(site =>
      site.domain === item.host || tabBrand(site.domain, brands) === item.brand ||
      site.domainHistory?.some(host => tabBrand(host, brands) === item.brand)) ||
      (!looksLikeBrand(item.brand) && item.identityUid != null ? Object.values(registry).find(site =>
        site.account?.uid === item.identityUid || site.domainIdentityUid === item.identityUid) : null);
    if (!existing) {
      const site = newSiteRecord(item.brand, item.host, null, false);
      site.domainSource = item.source;
      site.domainIdentityUid = item.identityUid ?? null;
      site.accountStale = true;
      site.status = 'account-unverified';
      registry[item.brand] = site;
      added.push(item.brand);
    } else {
      if (existing.domain !== item.host) moved.push(moveDomain(existing, item.host, item.source));
      else updated.push(existing.brand);
      if (item.identityUid != null) existing.domainIdentityUid = item.identityUid;
    }
  }
  return { added, moved, updated };
}

/** Đọc lại tài khoản/phiên; mỗi host dùng cookie opaque có tối đa một GET, không retry. */
export async function refreshAccounts() {
  await discoverAndMerge();
  return serialized(async () => {
    const sites = await storage.get('sites');
    const queue = Object.values(sites);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (cursor < queue.length) {
        const site = queue[cursor++];
        applyAccountRead(site, await readHost(site.domain));
      }
    }));
    await storage.set('sites', sites);
    return sites;
  });
}

export const BRAND_ORDER = [
  'tx88', 'ta88', 'uk88', 'da88', 'man88', '11bet', 'vk88',
  'du88', 'k88', 'bu88', 'bom88', '11win', 'co88', 'tip88', 'net88',
];

export function siteOrderIndex(site, customOrder = []) {
  if (!site) return Infinity;
  const brandKey = (site.brand || '').toLowerCase();
  const domainBrand = brandFromHost(site.domain).toLowerCase();

  // Ưu tiên thứ tự người dùng kéo thả tùy chỉnh nếu có
  if (Array.isArray(customOrder) && customOrder.length > 0) {
    let idx = customOrder.indexOf(brandKey);
    if (idx !== -1) return idx;
    idx = customOrder.indexOf(domainBrand);
    if (idx !== -1) return idx;
  }

  let idx = BRAND_ORDER.indexOf(brandKey);
  if (idx !== -1) return idx;
  idx = BRAND_ORDER.indexOf(domainBrand);
  if (idx !== -1) return idx;

  return Infinity;
}

export function sortSites(list, customOrder = []) {
  return [...list].sort((a, b) => {
    const idxA = siteOrderIndex(a, customOrder);
    const idxB = siteOrderIndex(b, customOrder);
    if (idxA !== idxB) return idxA - idxB;
    return (a.brand || '').localeCompare(b.brand || '');
  });
}

export async function list() {
  const [sites, customOrder] = await Promise.all([
    storage.get('sites'),
    storage.get('site_order').catch(() => null),
  ]);
  // Tự động nâng cấp claimPath cho các site đã lưu từ phiên bản cũ (bỏ hoàn toàn /hotmatch-proxy/)
  let changed = false;
  for (const site of Object.values(sites)) {
    if (site.paths?.claimPath && site.paths.claimPath.includes('hotmatch-proxy')) {
      site.paths.claimPath = DEFAULT_PATHS.claimPath;
      changed = true;
    }
  }
  if (changed) {
    await storage.set('sites', sites);
  }
  return sortSites(Object.values(sites), customOrder || []);
}

export async function saveSiteOrder(orderList) {
  return serialized(async () => {
    await storage.set('site_order', orderList);
  });
}

/**
 * Dọn các bản ghi cũ lỡ mang sẵn nguyên bộ cấu hình mặc định.
 * Chỉ giữ lại những khoá bạn thực sự đặt khác mặc định (dùng cho A/B leadMs).
 */
export function migrateSiteConfigs() {
  return serialized(async () => {
    const sites = await storage.get('sites');
    let cleaned = 0;
    for (const site of Object.values(sites)) {
      if (!site.config) continue;
      const kept = {};
      for (const [key, value] of Object.entries(site.config)) {
        if (DEFAULT_SITE_CONFIG[key] !== value) kept[key] = value;
      }
      if (Object.keys(kept).length !== Object.keys(site.config).length) cleaned += 1;
      site.config = kept;
    }
    if (cleaned) await storage.set('sites', sites);
    return cleaned;
  });
}

/**
 * Mọi thao tác ghi registry đều là đọc-sửa-ghi trên nguyên khối `sites`, nên
 * hai lời gọi chạy song song sẽ đè mất nhau. Việc này xảy ra thật: "Kiểm tra
 * endpoint" và "Đồng bộ đồng hồ" cùng cập nhật 15 site với 4 luồng song song.
 * Xếp hàng lại để mỗi lần ghi đọc được kết quả của lần trước.
 */
let writeQueue = Promise.resolve();
function serialized(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(() => {}, () => {});
  return run;
}

export function update(brand, partial) {
  return serialized(async () => {
    const sites = await storage.get('sites');
    if (!sites[brand]) return null;
    sites[brand] = { ...sites[brand], ...partial, updatedAt: Date.now() };
    await storage.set('sites', sites);
    return sites[brand];
  });
}

export function setAllEnabled(enabled) {
  return serialized(async () => {
    const sites = await storage.get('sites');
    for (const site of Object.values(sites)) {
      site.enabled = !!enabled;
      site.updatedAt = Date.now();
    }
    await storage.set('sites', sites);
    return sites;
  });
}

export function setClock(brand, clock) {
  return update(brand, { clock });
}

export function remove(brand) {
  return serialized(async () => {
    const sites = await storage.get('sites');
    delete sites[brand];
    await storage.set('sites', sites);
  });
}

/** Thêm tay, cho trường hợp chưa đăng nhập nên cookie chưa có gì để dò. */
export function addManual(host) {
  const clean = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!clean) return Promise.reject(new Error('Domain trống'));
  return serialized(async () => {
    const brand = brandFromHost(clean);
    const sites = await storage.get('sites');
    if (!sites[brand]) {
      sites[brand] = newSiteRecord(brand, clean, null, false);
    } else {
      sites[brand].domain = clean;
    }
    await storage.set('sites', sites);
    return sites[brand];
  });
}

// ---------------------------------------------------------------- dựng URL

export function origin(site) {
  return `https://${site.domain}`;
}

/**
 * URL nhận code theo chuẩn API mới nhất (/api/v1/hotmatch/giftcode?config_id=...).
 * Tuyệt đối không dùng và không fallback về /hotmatch-proxy/.
 */
export function buildClaimUrl(site, { matchName, date, uid, configId }) {
  let path = site?.paths?.claimPath || DEFAULT_PATHS.claimPath;
  if (!path || path.includes('hotmatch-proxy')) {
    path = DEFAULT_PATHS.claimPath;
  }
  path = path.replace(/\/+$/, '');

  let parts;
  if (configId) {
    parts = [`config_id=${encodeURIComponent(configId)}`];
  } else {
    parts = [`match_name=${encodeURIComponent(matchName || '')}`];
  }
  return `${origin(site)}${path}?${parts.join('&')}`;
}


export function buildPromoUrl(site) {
  const path = site.paths?.promoPath || DEFAULT_PATHS.promoPath;
  return `${origin(site)}${path}`;
}

// ---------------------------------------------------------------- xác thực & mật khẩu

/** Lấy mật khẩu đã lưu của một site */
export async function getPassword(brand) {
  const passwords = (await storage.get('site_passwords')) || {};
  return passwords[brand] || '';
}

/** Lấy toàn bộ danh sách mật khẩu đã lưu */
export async function getAllPasswords() {
  return (await storage.get('site_passwords')) || {};
}

/** Lưu mật khẩu cho một site */
export async function savePassword(brand, password) {
  return serialized(async () => {
    const passwords = (await storage.get('site_passwords')) || {};
    if (password) {
      passwords[brand] = password;
    } else {
      delete passwords[brand];
    }
    await storage.set('site_passwords', passwords);
  });
}

/**
 * Reload các tab đang mở của site trong Chrome sau khi đăng nhập.
 * @param {object} site
 */
export async function reloadSiteTabs(site) {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query) return;
    const domain = site.domain;
    if (!domain) return;
    const tabs = await chrome.tabs.query({
      url: [`*://${domain}/*`, `*://*.${domain}/*`],
    });
    for (const tab of tabs) {
      if (tab.id) {
        try {
          await chrome.tabs.reload(tab.id);
        } catch {
          // Bỏ qua nếu tab đang bị kéo thả hoặc chuyển trang
        }
      }
    }
  } catch (err) {
    console.warn(`[reloadSiteTabs] Không thể reload tab ${site.brand}:`, err);
  }
}

/**
 * Tạo chữ ký cookie Barrier chống bot (ikowqewqezzzz & amount)
 * để đăng nhập được vào các site có rào chặn WAF như TX88, DU88...
 */
export async function computeBarrier(payload) {
  const secret = 'aB3#kLp9!D7zX@eV1qW%rTmY6uC^nZ*t';
  const multiplier = 6868;
  let a = '';
  Object.keys(payload).forEach((k) => (a += String(payload[k])));
  const s = Math.floor(Date.now() / 1000).toString();
  const msg = `${s}:${a}`;

  const enc = new TextEncoder();
  const cryptoObj = typeof crypto !== 'undefined' ? crypto : (await import('crypto')).webcrypto;
  const key = await cryptoObj.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await cryptoObj.subtle.sign('HMAC', key, enc.encode(msg));
  const hashArray = Array.from(new Uint8Array(signature));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  const amount = (parseInt(s, 10) * multiplier).toString();

  return { ikowqewqezzzz: hex, amount };
}

/**
 * Ghi cookie Barrier vào cookie store của Chrome trước khi gọi login
 */
export async function setBarrierCookies(domain, payload) {
  try {
    if (typeof chrome === 'undefined' || !chrome.cookies?.set) return;
    const barrier = await computeBarrier(payload);
    const url = `https://${domain}`;
    await Promise.all([
      chrome.cookies.set({ url, name: 'ikowqewqezzzz', value: barrier.ikowqewqezzzz, path: '/' }),
      chrome.cookies.set({ url, name: 'amount', value: barrier.amount, path: '/' }),
    ]);
  } catch (err) {
    console.warn(`[setBarrierCookies] Không thể đặt cookie barrier cho ${domain}:`, err);
  }
}

/**
 * Thực hiện đăng nhập API vào một nhà cái: POST /api/v1/login
 * @param {object} site
 * @param {string} password
 * @param {string} [customUsername]
 * @returns {Promise<{ok:boolean, message?:string, user?:object}>}
 */
export async function loginSite(site, password, customUsername) {
  const username = customUsername || site.account?.username;
  if (!username) {
    return { ok: false, message: 'Chưa có tên đăng nhập' };
  }
  if (!password) {
    return { ok: false, message: 'Chưa nhập mật khẩu' };
  }

  const payload = { username, password };
  // Đặt cookie Barrier (nếu site có rào chống bot như TX88, DU88...)
  await setBarrierCookies(site.domain, payload);

  const url = `https://${site.domain}/api/v1/login`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(payload),
    });

    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, message: `HTTP ${res.status}: Phản hồi không phải JSON` };
    }

    if (!res.ok || (data.code && data.code !== 200) || (data.status && data.status !== 'OK')) {
      const msg = data.message || data.error || (data.data && data.data.message) || `Lỗi HTTP ${res.status}`;
      return { ok: false, message: msg };
    }

    // Đăng nhập thành công -> đọc lại thông tin tài khoản và reload các tab đang mở
    await refreshAccounts();
    await reloadSiteTabs(site);
    return { ok: true, user: data.data || data };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

/**
 * Thực hiện đổi thưởng một mã giftcode qua API: POST /api/v1/gift-code
 * @param {object} site
 * @param {string} code
 * @returns {Promise<{ok:boolean, message?:string, data?:object}>}
 */
export async function redeemCode(site, code) {
  if (!code) {
    return { ok: false, message: 'Thiếu mã giftcode' };
  }

  const payload = { giftCode: code.trim() };
  // Đặt cookie Barrier cho endpoint đổi thưởng
  await setBarrierCookies(site.domain, payload);

  const url = `https://${site.domain}/api/v1/gift-code`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(payload),
    });

    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, message: `HTTP ${res.status}: Phản hồi không phải JSON` };
    }

    if (!res.ok || (data.code && data.code !== 200) || (data.status && data.status !== 'OK')) {
      const msg = data.message || data.error || (data.data && data.data.message) || `Lỗi HTTP ${res.status}`;
      return { ok: false, message: msg };
    }

    // Đổi thưởng thành công -> làm mới lại số dư ví và tài khoản
    await refreshAccounts();
    return { ok: true, message: data.message || 'Đổi thưởng thành công!', data: data.data || data };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

// Ghép tên hai đội: định nghĩa nằm ở match.js, xuất lại ở đây cho tiện dùng.
export { joinMatchName } from './match.js';
