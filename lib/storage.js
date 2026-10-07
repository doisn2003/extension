/**
 * Lớp bọc mỏng quanh chrome.storage.local.
 *
 * Cấu hình, registry site và các trận đã nhập nằm ở đây (dữ liệu nhỏ, cần đọc
 * đồng bộ nhanh). Log từng lần bắn và từ điển phản hồi nằm ở blackbox.js
 * (IndexedDB) vì chúng lớn và ghi liên tục.
 */

/**
 * Nhịp bắn.
 *
 * Code hết sau khoảng 5 giây, nên mọi request sau mốc đó gần như vô giá trị mà
 * vẫn tiêu hạn mức và vẫn để lại dấu vết. Cấu hình dồn phần lớn đạn vào 3 giây
 * đầu rồi thưa nhanh, và có **trần cứng** để một lần chạy không bao giờ vượt quá
 * số request đã biết trước.
 */
export const DEFAULT_SITE_CONFIG = {
  /** Bắn phát đầu sớm bao nhiêu ms so với mốc phát code (bù thời gian request bay tới server). */
  leadMs: 150,
  /** Khoảng cách giữa hai lần bắn trong cửa sổ dày. */
  intervalMs: 130,
  /** Số request được phép bay cùng lúc. */
  concurrency: 4,
  /** Kết thúc cửa sổ dày, chuyển sang nhịp thưa. */
  denseWindowMs: 3000,
  /** Dừng hẳn sau mốc này. */
  tailWindowMs: 15000,
  /** Nhịp thưa ở giai đoạn đuôi. */
  tailIntervalMs: 1500,
  /** Trần cứng số request mỗi site mỗi lần chạy. Không bao giờ vượt, dù còn thời gian. */
  maxAttempts: 35,
  /**
   * Gặp bao nhiêu lần liên tiếp CÙNG một phản hồi 4xx chưa rõ nghĩa thì dừng site đó.
   *
   * Ta không thể biết trước chuỗi lỗi "hết code" của server. Nhưng lỗi tạm thời
   * là 5xx hoặc có chữ "có lỗi xảy ra", còn "chưa tới giờ" đã có nhãn riêng —
   * nên một mã 4xx lạ lặp lại y hệt nhiều lần gần như chắc chắn là kết cục cuối
   * cùng chứ không phải trục trặc. Dừng sớm ở đây chỉ lãng phí vài request,
   * trong khi bắn tiếp thì lãng phí cả cửa sổ.
   */
  stopAfterRepeatedUnknown: 3,
};

/**
 * Tool **không có** tính năng đổi thưởng tự động, và sẽ không có.
 *
 * Cookie `ikowqewqezzzz` mà API đổi thưởng đòi hỏi được chính JS của nhà cái ký
 * bằng HMAC với khoá nhúng trong bundle — một rào chống tự động hoá. Dựng lại nó
 * là giả mạo rào đó. Chi tiết trong docs/KNOWLEDGE.md, mục `setCookiesBarrier`.
 *
 * Tool chỉ hiện mã và mở sẵn trang để bạn tự bấm.
 */
export const DEFAULT_CONFIG = {
  ...DEFAULT_SITE_CONFIG,
  /** Chế độ bắn: 'awm' (Bắn từng viên / FIFO đón đầu) hoặc 'scar' (Bắn liên thanh / Burst) */
  shootMode: 'awm',
  /** Vùng đệm an toàn (ms) cho chế độ AWM: TriggerTime = T - offsetMs - (RTT/2) + safetyBufferMs */
  safetyBufferMs: 200,
  /** Độ trễ chờ (ms) trước khi bắn phát cứu hộ #2 trong chế độ AWM nếu phát #1 rớt mạng */
  awmRescueDelayMs: 3800,
  /** Tự mở tab trang khuyến mãi trước giờ G. */
  autoOpenTabs: true,
  /** Số mẫu dùng khi đồng bộ đồng hồ. */
  clockSamples: 8,
  /** Coi offset là cũ sau bao lâu (ms). */
  clockMaxAgeMs: 30 * 60 * 1000,
};

const DEFAULTS = {
  /** brand slug -> bản ghi site. Xem sites.js. */
  sites: {},
  config: DEFAULT_CONFIG,
  /** Các trận đã nhập, kèm kết quả kiểm chính tả. */
  matches: [],
  /** Tên đội đã từng nhập, để gợi ý và giảm gõ sai. */
  matchHistory: [],
  /** Kết quả các lần bắn gần đây (code thắng được, trạng thái đổi thưởng). */
  runs: [],
  /**
   * Danh sách trận của sự kiện "Dự đoán tỉ số".
   *
   * Chỉ cần một bản: UUID trận là **chung cho cả 15 site** (đã đối chiếu 3 site,
   * trùng từng ký tự). Nên tải một lần từ một site rồi dùng chung, thay vì quét
   * 15 nơi để lấy về cùng một thứ.
   */
  prediction: { matches: [], loadedAt: null, sourceBrand: null, slips: '', batchMatch: '' },
  /** Thứ tự sắp xếp các site do người dùng kéo thả tùy chỉnh. */
  site_order: [],
  /** Mật khẩu đăng nhập lưu cục bộ cho từng site (brand -> password). */
  site_passwords: {},
  /** Trạng thái giao diện (tab đang mở, sắp xếp...). */
  ui: {},
};

export async function getAll() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    out[key] = stored[key] === undefined ? structuredClone(fallback) : stored[key];
  }
  // Cấu hình có thể thiếu khoá mới sau khi nâng cấp extension — vá lại bằng mặc định.
  out.config = { ...DEFAULTS.config, ...out.config };
  return out;
}

export async function get(key) {
  const all = await getAll();
  return all[key];
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
  return value;
}

/** Trộn nông vào một object đã lưu. */
export async function patch(key, partial) {
  const current = await get(key);
  const next = { ...current, ...partial };
  await set(key, next);
  return next;
}

export function onChange(handler) {
  const listener = (changes, area) => {
    if (area !== 'local') return;
    handler(changes);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
