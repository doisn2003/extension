import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchProfile, normalizeProfile } from '../lib/account-reader.js';
import * as sites from '../lib/sites.js';
import { selectTabDomains } from '../lib/tab-domains.js';

let jar, store, calls, openTabs, respond;
const profile = { id: '123', username: 'synthetic-user', balance: '120.5', uuid: 'synthetic', token: 'SECRET', password: 'SECRET' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const session = (host) => [
  { name: 'user', value: 'opaque-session-not-json', domain: host, path: '/', httpOnly: true, secure: true, storeId: '0' },
  { name: 'is_login', value: 'true', domain: host, path: '/', storeId: '0' },
];
beforeEach(() => {
  jar = session('tx88.kiwi'); store = {}; calls = []; openTabs = [];
  respond = async () => json({ user: profile });
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return respond(url, init); };
  globalThis.chrome = {
    permissions: { contains: async () => true },
    tabs: { query: async () => openTabs },
    cookies: { getAll: async (query) => jar.filter(c => query.name ? c.name === query.name : query.url ? c.domain.replace(/^\./, '') === new URL(query.url).hostname : true) },
    storage: { local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, structuredClone(store[k])])),
      set: async (value) => { Object.assign(store, structuredClone(value)); },
    } },
  };
});

async function discoverAccounts() {
  const result = await sites.discoverAndMerge();
  await sites.refreshAccounts();
  return result;
}

test('opaque cookies on both reported domains discover profiles without storing secrets', async () => {
  jar.push(...session('11bet.gdn'));
  respond = async url => json({ user: { ...profile, id: url.includes('11bet') ? 456 : 123 } });
  const result = await discoverAccounts();
  assert.equal(result.added.length, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.url).sort(), ['https://11bet.gdn/api/v1/refresh', 'https://tx88.kiwi/api/v1/refresh']);
  for (const c of calls) {
    assert.equal(c.init.method, 'GET'); assert.equal(c.init.credentials, 'include');
    assert.equal(c.init.redirect, 'error'); assert.equal(c.init.body, undefined);
    assert.equal(Object.hasOwn(c.init.headers, 'Cookie'), false);
  }
  assert.equal(store.sites.tx88.account.uid, 123);
  assert.equal(store.sites.tx88.account.balance, 120.5);
  assert.equal(store.sites.tx88.isLogin, true);
  assert.equal(store.sites.tx88.accountSource, 'api');
  assert.equal(JSON.stringify(store).includes('SECRET'), false);
  assert.equal(JSON.stringify(store).includes('opaque-session'), false);
});

test('legacy JSON cookie still works without network', async () => {
  jar[0].value = encodeURIComponent(JSON.stringify({ ...profile, id: 123, balance: 10 }));
  const result = await discoverAccounts();
  assert.equal(result.added.length, 1); assert.equal(calls.length, 0);
  assert.equal(store.sites.tx88.accountSource, 'cookie');
});

test('numeric id normalization and absent balance never become false zero', () => {
  assert.equal(normalizeProfile(profile).id, 123);
  for (const balance of ['', null, undefined, 'abc', Infinity]) assert.equal(normalizeProfile({ ...profile, balance }).balance, null);
  assert.equal(normalizeProfile({ ...profile, balance: 0 }).balance, 0);
  assert.equal(normalizeProfile({ ...profile, id: '9007199254740993' }).id, '9007199254740993');
  assert.equal(normalizeProfile({ ...profile, id: {} }), null);
  assert.equal(normalizeProfile({ ...profile, username: '' }), null);
});

test('unrelated cookies never trigger external account requests or registry entries', async () => {
  jar = session('unrelated.example');
  const result = await discoverAccounts();
  assert.equal(result.added.length, 0); assert.equal(calls.length, 0);
});

test('known platform marker supports numeric/changed domains with opaque sessions', async () => {
  jar = [...session('bc999999.example'), { name: 'chat_token_BC999999', value: 'unused', domain: 'bc999999.example' }];
  const result = await discoverAccounts();
  assert.equal(result.added.length, 1); assert.equal(calls.length, 1);
});

test('is_login candidate can use API when user cookie is absent', async () => {
  jar = jar.filter(c => c.name === 'is_login');
  const result = await discoverAccounts();
  assert.equal(result.added.length, 1); assert.equal(store.sites.tx88.isLogin, true);
});

test('API profile establishes state even when login flag is absent', async () => {
  jar = jar.filter(c => c.name === 'user');
  const result = await sites.readHost('tx88.kiwi');
  assert.equal(result.isLogin, true);
});

test('missing cookies clear active state and balance, retain identity with stale flag', async () => {
  await discoverAccounts(); jar = []; calls = [];
  await sites.refreshAccounts();
  assert.equal(store.sites.tx88.account.username, profile.username);
  assert.equal(store.sites.tx88.account.balance, null);
  assert.equal(store.sites.tx88.accountStale, true);
  assert.equal(store.sites.tx88.isLogin, false);
  assert.equal(store.sites.tx88.status, 'logged-out'); assert.equal(calls.length, 0);
});

test('401 and explicit null user are logout; malformed response is not', async () => {
  for (const response of [json({}, 401), json({ user: null })]) {
    respond = async () => response;
    assert.equal((await sites.readHost('tx88.kiwi')).state, 'logged-out');
  }
  respond = async () => json({ status: 'OK' });
  assert.equal((await sites.readHost('tx88.kiwi')).error, 'format');
});

test('API failures keep sites discoverable, explain errors, and never retry', async () => {
  for (const [status, error] of [[403, 'blocked'], [429, 'limited'], [500, 'http']]) {
    calls = []; respond = async () => json({}, status);
    const result = await discoverAccounts();
    assert.equal(calls.length, 1); assert.equal(result.issues.length, 0);
    assert.equal(store.sites.tx88.accountError, error);
    assert.equal(store.sites.tx88.isLogin, false);
    assert.equal(sites.accountReadSummary(store.sites).tone, 'warn');
  }
});

test('HTML challenge and malformed JSON cannot become a valid profile', async () => {
  respond = async () => new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } });
  assert.equal((await sites.readHost('tx88.kiwi')).error, 'format');
  respond = async () => new Response('{invalid', { headers: { 'content-type': 'application/json' } });
  assert.equal((await sites.readHost('tx88.kiwi')).error, 'format');
});

test('transient failure invalidates old balance and successful refresh recovers', async () => {
  await discoverAccounts();
  const oldReadAt = store.sites.tx88.account.readAt;
  respond = async () => { throw new Error('SECRET internal network detail'); };
  await sites.refreshAccounts();
  assert.equal(store.sites.tx88.account.readAt, oldReadAt);
  assert.equal(store.sites.tx88.account.balance, null);
  assert.equal(store.sites.tx88.accountError, 'network');
  assert.equal(JSON.stringify(store).includes('SECRET'), false);
  respond = async () => json({ user: { ...profile, balance: '999' } });
  await sites.refreshAccounts();
  assert.equal(store.sites.tx88.account.balance, 999);
  assert.equal(store.sites.tx88.accountStale, false);
  assert.equal(store.sites.tx88.accountError, null);
  assert.equal(store.sites.tx88.status, 'ok');
});

test('missing host permission and cookie API errors stay distinguishable', async () => {
  chrome.permissions.contains = async () => false;
  assert.equal((await sites.readHost('tx88.kiwi')).error, 'permission');
  assert.equal((await sites.discover()).granted, false);
  chrome.permissions.contains = async () => true;
  chrome.cookies.getAll = async () => { throw new Error('synthetic'); };
  assert.equal((await sites.readHost('tx88.kiwi')).error, 'cookies');
  await assert.rejects(sites.discover(), /cookie/);
  assert.equal(calls.length, 0);
});

test('hung request is aborted with a bounded timeout', async () => {
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  assert.equal((await fetchProfile('tx88.kiwi', { fetchImpl, timeoutMs: 10 })).error, 'timeout');
});

test('concurrent reads of same host issue only one request', async () => {
  await Promise.all([sites.readHost('tx88.kiwi'), sites.readHost('tx88.kiwi')]);
  assert.equal(calls.length, 1);
});

test('domain rotation preserves configuration and current open domain wins', async () => {
  await discoverAccounts();
  await sites.update('tx88', { enabled: false, customLabel: 'Custom', clock: { offsetMs: 1 } });
  jar.push(...session('tx88.example'));
  openTabs = [{ url: 'https://tx88.example/' }];
  const result = await discoverAccounts();
  assert.equal(result.moved.length, 1);
  assert.equal(Object.keys(store.sites).length, 1);
  assert.equal(store.sites.tx88.domain, 'tx88.example');
  assert.equal(store.sites.tx88.enabled, false); assert.equal(store.sites.tx88.customLabel, 'Custom');
  assert.equal(store.sites.tx88.clock, null);
});

test('open domain wins even when its account API fails; old alias is never contacted', async () => {
  jar.push(...session('tx88.example'));
  openTabs = [{ url: 'https://tx88.example/' }];
  respond = async url => url.includes('example') ? json({}, 403) : json({ user: profile });
  await discoverAccounts();
  assert.equal(store.sites.tx88.domain, 'tx88.example');
  assert.equal(store.sites.tx88.accountError, 'blocked');
  assert.deepEqual(calls.map(c => c.url), ['https://tx88.example/api/v1/refresh']);
});

test('first root cookie is used consistently when cookie names duplicate', async () => {
  jar.push({ name: 'user', value: JSON.stringify({ ...profile, id: 9, balance: 1 }), domain: 'tx88.kiwi' });
  const result = await sites.readHost('tx88.kiwi');
  assert.equal(result.source, 'api'); assert.equal(result.account.uid, 123);
});

test('Discover changes band to kiwi without cookie on kiwi and without any request', async () => {
  jar = session('tx88.band');
  await discoverAccounts();
  await sites.update('tx88', { enabled: false, customLabel: 'My TX', config: { custom: true }, clock: { offsetMs: 1 }, probe: { status: 200 }, badMatchSig: 'old' });
  calls = [];
  respond = async () => { throw new Error('Discover must never fetch'); };
  openTabs = [{ url: 'https://tx88.kiwi/', lastAccessed: 50 }];
  const result = await sites.discoverAndMerge();
  assert.deepEqual(result.moved, [{ brand: 'tx88', from: 'tx88.band', to: 'tx88.kiwi' }]);
  const site = store.sites.tx88;
  assert.equal(site.domain, 'tx88.kiwi');
  assert.equal(site.customLabel, 'My TX'); assert.equal(site.enabled, false);
  assert.deepEqual(site.config, { custom: true });
  assert.equal(site.account.uid, 123); assert.equal(site.accountStale, true);
  assert.equal(site.isLogin, false); assert.equal(site.clock, null);
  assert.equal(site.probe, null); assert.equal(site.badMatchSig, null);
  assert.equal(site.status, 'account-unverified');
  assert.equal(calls.length, 0);
  // Repeated clicks and closing the new tab must not resurrect a historic alias.
  await sites.discoverAndMerge(); openTabs = []; await sites.discoverAndMerge();
  assert.equal(store.sites.tx88.domain, 'tx88.kiwi'); assert.equal(calls.length, 0);
});

test('Refresh persists the new URL before account fetch and never contacts old domain', async () => {
  jar = session('tx88.band'); await discoverAccounts();
  calls = []; jar.push(...session('tx88.kiwi'));
  openTabs = [{ url: 'https://tx88.kiwi/' }];
  respond = async () => {
    assert.equal(store.sites.tx88.domain, 'tx88.kiwi');
    return json({ user: { ...profile, id: 321, balance: '777' } });
  };
  await sites.refreshAccounts();
  assert.deepEqual(calls.map(c => c.url), ['https://tx88.kiwi/api/v1/refresh']);
  assert.equal(store.sites.tx88.account.uid, 321);
  assert.equal(store.sites.tx88.account.balance, 777);
  assert.equal(store.sites.tx88.status, 'ok');
});

test('Refresh updates URL with zero requests if new domain has no auth cookies', async () => {
  jar = session('tx88.band'); await discoverAccounts(); calls = [];
  openTabs = [{ url: 'https://tx88.kiwi/' }];
  await sites.refreshAccounts();
  assert.equal(store.sites.tx88.domain, 'tx88.kiwi');
  assert.equal(calls.length, 0);
});

test('Discover registers all supported open sites without cookies or network', async () => {
  jar = [];
  openTabs = [{ url: 'https://tx88.kiwi/' }, { url: 'https://11bet.gdn/account/bonus' }, { url: 'https://da88.frl/' }];
  const result = await sites.discoverAndMerge();
  assert.equal(result.added.length, 3); assert.equal(calls.length, 0);
  assert.equal(store.sites['11bet'].account, null);
  assert.equal(store.sites['11bet'].status, 'account-unverified');
});

test('unchanged Discover does not refresh or erase account values', async () => {
  await discoverAccounts(); calls = [];
  const before = structuredClone(store.sites.tx88);
  openTabs = [{ url: 'https://tx88.kiwi/' }];
  await sites.discoverAndMerge();
  assert.deepEqual(store.sites.tx88, before); assert.equal(calls.length, 0);
});

test('tab discovery works without host permissions and survives cookie API failure', async () => {
  openTabs = [{ url: 'https://tx88.kiwi/' }];
  chrome.permissions.contains = async () => false;
  assert.equal((await sites.discoverAndMerge()).granted, true);
  assert.equal(store.sites.tx88.domain, 'tx88.kiwi'); assert.equal(calls.length, 0);
  chrome.permissions.contains = async () => true;
  chrome.cookies.getAll = async () => { throw new Error('synthetic'); };
  openTabs = [{ url: 'https://tx88.band/' }];
  const result = await sites.discoverAndMerge();
  assert.equal(store.sites.tx88.domain, 'tx88.band');
  assert.equal(result.issues[0].error, 'cookies'); assert.equal(calls.length, 0);
});

test('tab API failure leaves domain untouched and sends no request', async () => {
  await discoverAccounts(); calls = [];
  chrome.tabs.query = async () => { throw new Error('Cannot read Chrome tabs'); };
  await assert.rejects(sites.refreshAccounts(), /Chrome tabs/);
  assert.equal(store.sites.tx88.domain, 'tx88.kiwi'); assert.equal(calls.length, 0);
});

test('tab selection uses active then lastAccessed, independent of array order', () => {
  const brands = new Set(['tx88']);
  const tabs = [{ url: 'https://tx88.band/', lastAccessed: 1 }, { url: 'https://tx88.kiwi/', lastAccessed: 2 }];
  assert.equal(selectTabDomains(tabs, brands).get('tx88').host, 'tx88.kiwi');
  assert.equal(selectTabDomains([...tabs].reverse(), brands).get('tx88').host, 'tx88.kiwi');
  tabs[0].active = true;
  assert.equal(selectTabDomains(tabs, brands).get('tx88').host, 'tx88.band');
  assert.equal(selectTabDomains(tabs.map(t => ({ url: t.url })), brands, new Set(['tx88.kiwi'])).get('tx88').host, 'tx88.kiwi');
});

test('only committed supported URLs count; no title/pending URL/substring matching', () => {
  const tabs = [
    { url: 'https://tx88.kiwi.evil.com/' }, { url: 'https://not-tx88.com/' },
    { url: 'https://example.com/tx88.kiwi', title: 'TX88' },
    { url: 'about:blank', pendingUrl: 'https://tx88.kiwi/' },
    { url: 'https://11bet.gdn/', incognito: true }, { url: 'https://tx88.kiwi:444/' },
    { url: 'chrome-extension://test/tx88.kiwi' }, { url: 'https://tx88.kiwi@evil.com/' },
  ];
  assert.equal(selectTabDomains(tabs, new Set(['tx88', '11bet'])).size, 0);
  const result = selectTabDomains([{ url: 'https://www.tx88.kiwi/' }, { url: 'https://m.11bet.com.vn/' }], new Set(['tx88', '11bet']));
  assert.equal(result.size, 2);
});
