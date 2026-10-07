/**
 * Hộp đen — mọi thứ tool học được đều nằm ở đây.
 *
 * Bật ngay từ Phase 1 chứ không để cuối: dữ liệu của trận đầu tiên là quý nhất,
 * bật muộn là mất luôn.
 *
 * Bốn store:
 *   attempts   mỗi lần bắn một bản ghi (request, response, timing, phân loại)
 *   runs       mỗi trận một bản ghi, kèm snapshot cấu hình đã dùng
 *   dictionary từ điển chữ ký phản hồi -> nhãn do người dùng gán
 *   notes      ghi chú phát hiện, để đổ vào docs/KNOWLEDGE.md
 *
 * `runs` lưu snapshot cấu hình để mọi kết quả thắng/thua đều truy được về
 * tham số nào sinh ra nó — đó là điều kiện để A/B leadMs giữa các site có nghĩa.
 */

const DB_NAME = 'hotmatch-blackbox';
const DB_VERSION = 1;
const BODY_LIMIT = 2048;

/** Nhãn phân loại phản hồi. Bảng xử lý trong classify.js đọc theo các nhãn này. */
export const LABELS = {
  SUCCESS: 'SUCCESS',
  NOT_YET: 'NOT_YET',
  SOLD_OUT: 'SOLD_OUT',
  TRANSIENT: 'TRANSIENT',
  THROTTLED: 'THROTTLED',
  SESSION_DEAD: 'SESSION_DEAD',
  CHALLENGED: 'CHALLENGED',
  BAD_MATCH: 'BAD_MATCH',
  /**
   * `423 "Vui lòng tải lại trang!"` — rào chống tự động hoá `setCookiesBarrier` từ chối.
   * Chỉ thao tác trên chính trang nhà cái mới qua được; tool không tự làm việc đó.
   */
  NEEDS_PAGE: 'NEEDS_PAGE',
  /** Body request sai hình dạng (thiếu trường, sai tên trường). */
  BAD_REQUEST: 'BAD_REQUEST',
  UNKNOWN: 'UNKNOWN',
};

export const LABEL_INFO = {
  SUCCESS: { text: 'Lấy được code', tone: 'good' },
  NOT_YET: { text: 'Chưa tới giờ phát', tone: 'neutral' },
  SOLD_OUT: { text: 'Hết code', tone: 'bad' },
  TRANSIENT: { text: 'Lỗi tạm thời — thử lại ngay', tone: 'warn' },
  THROTTLED: { text: 'Chạm giới hạn tần suất', tone: 'warn' },
  SESSION_DEAD: { text: 'Phiên đăng nhập hỏng', tone: 'bad' },
  CHALLENGED: { text: 'Bị Cloudflare chặn', tone: 'bad' },
  BAD_MATCH: { text: 'Sai tên trận', tone: 'bad' },
  NEEDS_PAGE: { text: 'Rào chống tự động — phải thao tác trên trang', tone: 'warn' },
  BAD_REQUEST: { text: 'Body request sai hình dạng', tone: 'bad' },
  UNKNOWN: { text: 'Chưa gán nhãn', tone: 'unknown' },
};

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('attempts')) {
        const s = db.createObjectStore('attempts', { keyPath: 'id', autoIncrement: true });
        s.createIndex('ts', 'ts');
        s.createIndex('runId', 'runId');
        s.createIndex('brand', 'brand');
      }
      if (!db.objectStoreNames.contains('runs')) {
        const s = db.createObjectStore('runs', { keyPath: 'id' });
        s.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('dictionary')) {
        const s = db.createObjectStore('dictionary', { keyPath: 'sig' });
        s.createIndex('lastSeen', 'lastSeen');
        s.createIndex('label', 'label');
      }
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
        s.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, stores, mode) {
  return db.transaction(stores, mode);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

// ---------------------------------------------------------------- chữ ký phản hồi

/**
 * Bỏ mọi phần biến thiên khỏi body để hai phản hồi "cùng loại" cho ra một chữ ký.
 * Nhờ đó một mã gift code mới không tạo ra một chữ ký mới.
 */
export function normalizeBody(text) {
  let s = String(text ?? '').slice(0, 4000);
  s = s.replace(/\s+/g, ' ').trim();

  // Bỏ URL trước tiên. API này echo nguyên URL đã gọi vào body lỗi, tức chứa cả
  // `match_name` và `uid` — không bỏ đi thì mỗi site và mỗi tên trận lại thành
  // một "kiểu phản hồi" riêng, và phép so chữ ký để kiểm chính tả mất tác dụng
  // hoàn toàn vì hai bên luôn khác nhau.
  s = s.replace(/https?:\/\/[^\s"'<>\\]+/g, '<URL>');

  s = s.replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<TS>');
  s = s.replace(/\b[A-Z][A-Z0-9]{7,}\b/g, '<CODE>');
  s = s.replace(/\b[0-9a-f]{16,}\b/gi, '<HEX>');
  s = s.replace(/\b\d{3,}\b/g, '<N>');
  return s.slice(0, 1000);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Chữ ký gồm cả HTTP status: cùng body mà khác status là hai chuyện khác nhau. */
export function signature(status, bodyText) {
  const norm = normalizeBody(bodyText);
  return `${status || 0}:${fnv1a(norm)}`;
}

// ---------------------------------------------------------------- ghi nhận

/**
 * Ghi một lần bắn và đồng thời nạp phản hồi vào từ điển.
 * @returns {Promise<{id:number, sig:string, label:string, isNew:boolean}>}
 */
export async function logAttempt(rec) {
  const db = await open();
  const ts = rec.ts ?? Date.now();
  const bodyText = rec.body == null ? '' : String(rec.body);
  const sig = signature(rec.status, bodyText);

  const t = tx(db, ['attempts', 'dictionary'], 'readwrite');
  const dict = t.objectStore('dictionary');

  const existing = await wrap(dict.get(sig));
  const isNew = !existing;
  // Chữ ký mới được gieo sẵn nhãn heuristic do người gọi tính (net.js). Nhờ vậy
  // bạn chỉ phải *xác nhận* hoặc *sửa*, thay vì gán nhãn từ số không cho từng
  // kiểu phản hồi. `labelSource` phân biệt rõ đâu là máy đoán, đâu là bạn chốt.
  const entry = existing || {
    sig,
    status: rec.status ?? 0,
    sample: bodyText.slice(0, BODY_LIMIT),
    normalized: normalizeBody(bodyText),
    label: rec.label || LABELS.UNKNOWN,
    labelSource: 'heuristic',
    count: 0,
    brands: [],
    firstSeen: ts,
    lastSeen: ts,
  };
  entry.count += 1;
  entry.lastSeen = ts;
  if (rec.brand && !entry.brands.includes(rec.brand)) entry.brands.push(rec.brand);
  dict.put(entry);

  const attempt = {
    ts,
    runId: rec.runId ?? null,
    brand: rec.brand ?? null,
    phase: rec.phase ?? 'unknown', // probe | prewarm | burst | tail
    method: rec.method ?? 'GET',
    url: rec.url ?? '',
    status: rec.status ?? 0,
    ok: !!rec.ok,
    headers: rec.headers ?? {},
    body: bodyText.slice(0, BODY_LIMIT),
    sig,
    label: entry.label,
    tSent: rec.tSent ?? null,
    tFirstByte: rec.tFirstByte ?? null,
    tDone: rec.tDone ?? null,
    latencyMs: rec.latencyMs ?? null,
    offsetUsed: rec.offsetUsed ?? null,
    error: rec.error ?? null,
  };
  const id = await wrap(t.objectStore('attempts').add(attempt));
  await done(t);

  return { id, sig, label: entry.label, isNew };
}

export async function saveRun(run) {
  const db = await open();
  const t = tx(db, ['runs'], 'readwrite');
  t.objectStore('runs').put({ ts: Date.now(), ...run });
  await done(t);
  return run.id;
}

export async function addNote({ title, body, evidence = [] }) {
  const db = await open();
  const t = tx(db, ['notes'], 'readwrite');
  t.objectStore('notes').add({ ts: Date.now(), title, body, evidence });
  await done(t);
}

// ---------------------------------------------------------------- truy vấn

async function getAllFrom(store, index, range, limit, reverse = true) {
  const db = await open();
  const t = tx(db, [store], 'readonly');
  const src = index ? t.objectStore(store).index(index) : t.objectStore(store);
  const out = [];
  await new Promise((resolve, reject) => {
    const req = src.openCursor(range ?? null, reverse ? 'prev' : 'next');
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || (limit && out.length >= limit)) return resolve();
      out.push(cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return out;
}

export function listAttempts({ limit = 200, runId = null } = {}) {
  if (runId) {
    return getAllFrom('attempts', 'runId', IDBKeyRange.only(runId), limit, false);
  }
  return getAllFrom('attempts', 'ts', null, limit, true);
}

export function listRuns(limit = 50) {
  return getAllFrom('runs', 'ts', null, limit, true);
}

export function listNotes(limit = 200) {
  return getAllFrom('notes', 'ts', null, limit, true);
}

export async function listDictionary() {
  const rows = await getAllFrom('dictionary', 'lastSeen', null, 0, true);
  return rows.sort((a, b) => b.count - a.count);
}

/** Gán nhãn cho một chữ ký. Đây là vòng lặp học: gán một lần, classify.js dùng mãi. */
export async function labelSignature(sig, label) {
  const db = await open();
  const t = tx(db, ['dictionary'], 'readwrite');
  const store = t.objectStore('dictionary');
  const entry = await wrap(store.get(sig));
  if (entry) {
    entry.label = label;
    entry.labelSource = 'user';
    entry.labeledAt = Date.now();
    store.put(entry);
  }
  await done(t);
  return entry;
}

/** Chốt nhãn heuristic hiện tại thành nhãn do bạn xác nhận, không đổi giá trị. */
export function confirmSignature(sig) {
  return open()
    .then((db) => {
      const t = tx(db, ['dictionary'], 'readonly');
      return wrap(t.objectStore('dictionary').get(sig));
    })
    .then((entry) => (entry ? labelSignature(sig, entry.label) : null));
}

/**
 * Đếm các kiểu phản hồi chưa được bạn chốt.
 * Nhãn heuristic vẫn tính là chưa chốt — máy đoán không phải tri thức đã xác nhận.
 */
export async function countUnlabeled() {
  const rows = await listDictionary();
  return rows.filter((r) => r.labelSource !== 'user').length;
}

// ---------------------------------------------------------------- thống kê

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Số liệu để sinh đề xuất tinh chỉnh, ví dụ:
 * "uk88 thắng 0/8, first-byte p50 480ms so với tip88 190ms -> tăng leadMs".
 */
export async function stats() {
  const [attempts, runs] = await Promise.all([listAttempts({ limit: 20000 }), listRuns(500)]);

  const byLabel = {};
  const byBrand = {};

  for (const a of attempts) {
    byLabel[a.label || LABELS.UNKNOWN] = (byLabel[a.label || LABELS.UNKNOWN] || 0) + 1;
    if (!a.brand) continue;
    const b = (byBrand[a.brand] ||= { brand: a.brand, attempts: 0, latencies: [], wins: 0, runs: 0 });
    b.attempts += 1;
    if (typeof a.latencyMs === 'number' && a.latencyMs >= 0) b.latencies.push(a.latencyMs);
  }

  for (const run of runs) {
    for (const [brand, outcome] of Object.entries(run.results || {})) {
      const b = (byBrand[brand] ||= { brand, attempts: 0, latencies: [], wins: 0, runs: 0 });
      b.runs += 1;
      if (outcome && outcome.code) b.wins += 1;
    }
  }

  const brands = Object.values(byBrand).map((b) => {
    const sorted = b.latencies.slice().sort((x, y) => x - y);
    return {
      brand: b.brand,
      attempts: b.attempts,
      runs: b.runs,
      wins: b.wins,
      winRate: b.runs ? b.wins / b.runs : null,
      latencyP50: percentile(sorted, 50),
      latencyP90: percentile(sorted, 90),
    };
  }).sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));

  return { totalAttempts: attempts.length, totalRuns: runs.length, byLabel, brands };
}

/**
 * Đề xuất tinh chỉnh sinh từ số liệu thật, không phải phỏng đoán.
 * Chỉ nói khi có đủ dữ liệu — thà im lặng còn hơn khuyên bừa.
 */
export async function suggestions() {
  const s = await stats();
  const out = [];
  const withLatency = s.brands.filter((b) => b.latencyP50 != null);
  if (withLatency.length >= 2) {
    const best = withLatency.reduce((a, b) => (a.latencyP50 <= b.latencyP50 ? a : b));
    for (const b of withLatency) {
      if (b.runs >= 3 && b.wins === 0 && b.latencyP50 > best.latencyP50 * 1.8) {
        out.push({
          brand: b.brand,
          text: `${b.brand} thắng 0/${b.runs}, first-byte p50 ${Math.round(b.latencyP50)}ms so với ${best.brand} ${Math.round(best.latencyP50)}ms → thử tăng leadMs của ${b.brand}.`,
        });
      }
    }
  }
  const unconfirmed = await countUnlabeled();
  if (unconfirmed > 0) {
    out.push({
      brand: null,
      text: `${unconfirmed} kiểu phản hồi chưa được bạn chốt nhãn — chốt để engine xử lý đúng thay vì đoán.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- xuất / nhập / dọn

export async function exportBundle() {
  const [attempts, runs, dictionary, notes] = await Promise.all([
    listAttempts({ limit: 100000 }),
    listRuns(10000),
    listDictionary(),
    listNotes(10000),
  ]);
  const local = await chrome.storage.local.get(null);
  return {
    format: 'hotmatch-blackbox',
    version: 1,
    // Định danh gói, để nhập lại đúng file này lần nữa không nhân đôi log.
    bundleId: crypto.randomUUID(),
    exportedAt: new Date().toISOString(),
    settings: local,
    attempts,
    runs,
    dictionary,
    notes,
  };
}

export class DuplicateBundleError extends Error {}

export async function importBundle(bundle, { includeSettings = false, force = false } = {}) {
  if (!bundle || bundle.format !== 'hotmatch-blackbox') {
    throw new Error('File không đúng định dạng gói dữ liệu HotMatch.');
  }

  // `attempts` dùng khoá tự tăng nên không tự chống trùng được. Chặn ở mức gói:
  // nhập nhầm cùng một file hai lần sẽ làm sai mọi thống kê tỉ lệ thắng.
  const { importedBundles = [] } = await chrome.storage.local.get('importedBundles');
  if (bundle.bundleId && importedBundles.includes(bundle.bundleId) && !force) {
    throw new DuplicateBundleError('Gói này đã được nhập trước đó.');
  }

  const db = await open();
  const t = tx(db, ['attempts', 'runs', 'dictionary', 'notes'], 'readwrite');
  const dict = t.objectStore('dictionary');

  for (const a of bundle.attempts || []) {
    const { id, ...rest } = a;
    t.objectStore('attempts').add(rest);
  }
  for (const r of bundle.runs || []) t.objectStore('runs').put(r);
  for (const d of bundle.dictionary || []) {
    // Nhãn bạn đã chốt tại máy này quý hơn nhãn máy đoán từ gói nhập vào.
    const local = await wrap(dict.get(d.sig));
    if (local?.labelSource === 'user' && d.labelSource !== 'user') {
      dict.put({ ...d, label: local.label, labelSource: 'user', labeledAt: local.labeledAt });
    } else {
      dict.put(d);
    }
  }
  for (const n of bundle.notes || []) {
    const { id, ...rest } = n;
    t.objectStore('notes').add(rest);
  }
  await done(t);

  if (bundle.bundleId) {
    await chrome.storage.local.set({ importedBundles: [...importedBundles, bundle.bundleId].slice(-50) });
  }
  if (includeSettings && bundle.settings) {
    await chrome.storage.local.set(bundle.settings);
  }
  return {
    attempts: (bundle.attempts || []).length,
    runs: (bundle.runs || []).length,
    dictionary: (bundle.dictionary || []).length,
    notes: (bundle.notes || []).length,
  };
}

/** Dọn attempts cũ. Runs, từ điển và ghi chú giữ lại — chúng nhỏ và là phần tri thức. */
export async function prune(days = 90) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const db = await open();
  const t = tx(db, ['attempts'], 'readwrite');
  const idx = t.objectStore('attempts').index('ts');
  let removed = 0;
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(IDBKeyRange.upperBound(cutoff));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      cur.delete();
      removed += 1;
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  await done(t);
  return removed;
}

/**
 * Xoá dữ liệu theo mức.
 * @param {'attempts'|'all'} scope
 *   attempts — chỉ log từng lần bắn (phần phình nhanh nhất), giữ tri thức
 *   all      — xoá cả từ điển, lịch sử trận và ghi chú
 */
export async function clearData(scope = 'attempts') {
  const db = await open();
  const stores = scope === 'all'
    ? ['attempts', 'runs', 'dictionary', 'notes']
    : ['attempts'];

  const before = await counts();
  const t = tx(db, stores, 'readwrite');
  for (const name of stores) t.objectStore(name).clear();
  await done(t);

  if (scope === 'all') {
    // Bỏ luôn dấu vết các gói đã nhập, để nhập lại được sau khi xoá sạch.
    await chrome.storage.local.remove('importedBundles');
  }
  return before;
}

export async function counts() {
  const db = await open();
  const t = tx(db, ['attempts', 'runs', 'dictionary', 'notes'], 'readonly');
  const [attempts, runs, dictionary, notes] = await Promise.all([
    wrap(t.objectStore('attempts').count()),
    wrap(t.objectStore('runs').count()),
    wrap(t.objectStore('dictionary').count()),
    wrap(t.objectStore('notes').count()),
  ]);
  return { attempts, runs, dictionary, notes };
}
