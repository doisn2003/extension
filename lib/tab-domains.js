/** Domain recognition from committed Chrome tab URLs only; no network or cookies. */
const WEB_PREFIXES = new Set(['www', 'm', 'mobile', 'app', 'web', 'wap']);
const COMPOUND_SUFFIXES = new Set(['com.vn', 'net.vn', 'org.vn', 'co.uk', 'com.au', 'co.nz']);

export function tabBrand(host, brands) {
  const labels = String(host).toLowerCase().replace(/\.$/, '').split('.');
  while (labels.length > 2 && WEB_PREFIXES.has(labels[0])) labels.shift();
  const suffix = labels.slice(1).join('.');
  // Do not mistake tx88.example.com or tx88.kiwi.evil.com for tx88.<suffix>.
  if (labels.length !== 2 && !(labels.length === 3 && COMPOUND_SUFFIXES.has(suffix))) return null;
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/i.test(labels.at(-1))) return null;
  return brands.has(labels[0]) ? labels[0] : null;
}

export function selectTabDomains(tabs, brands, currentHosts = new Set(), { incognito = false } = {}) {
  const selected = new Map();
  const rank = item => [Number(item.active), item.lastAccessed, Number(currentHosts.has(item.host))];
  const preferred = (item, previous) => {
    const a = rank(item), b = rank(previous);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return item.host.localeCompare(previous.host) < 0;
  };
  for (const tab of tabs) {
    if (!!tab.incognito !== incognito) continue;
    let url;
    try { url = new URL(tab.url); } catch { continue; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) continue;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const brand = tabBrand(host, brands);
    if (!brand) continue;
    const item = { brand, host, active: !!tab.active, lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : 0 };
    const previous = selected.get(brand);
    if (!previous || preferred(item, previous)) selected.set(brand, item);
  }
  return selected;
}
