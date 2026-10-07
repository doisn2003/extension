/**
 * Bộ hẹn giờ chính xác, không phụ thuộc setTimeout ở đoạn cuối.
 *
 * Vì sao cần: Chrome bóp `setTimeout` của trang không được vẽ lên màn hình. Đo
 * thực tế trong một trang như vậy cho sai số 500-930ms — trong cuộc đua mà code
 * hết sau 5 giây thì trượt nửa giây là thua. Điều tệ hơn: `document.hidden` vẫn
 * báo `false`, nên không thể dựa vào cờ đó để biết mình đang bị bóp.
 *
 * Cách xử lý: chờ thô bằng setTimeout cho phần lớn thời gian (rẻ, và bị bóp thì
 * chỉ *muộn* chứ không *sớm*), rồi ở 3 giây cuối chuyển sang vòng lặp
 * `MessageChannel`. postMessage xếp vào hàng đợi **task**, không phải timer, nên
 * không dính cơ chế clamp — đổi lại tốn CPU, nhưng chỉ trong 3 giây.
 *
 * Chỉ có **một** vòng lặp dùng chung cho mọi người chờ: 15 site cùng chờ một mốc
 * gần như trùng nhau, chạy 15 vòng quay riêng là phí vô ích.
 */

/**
 * Cửa sổ quay tay. Phải dài hơn mức Chrome bóp timer (~1 giây) để chắc chắn đã
 * vào chế độ quay trước khi tới hạn, nhưng không dài hơn mức cần thiết vì mỗi
 * giây quay là một giây đốt CPU.
 */
const SPIN_WINDOW_MS = 1600;
/** Không ngủ thô quá lâu một lần: nếu bị bóp nặng, còn cơ hội tỉnh lại mà chỉnh. */
const COARSE_STEP_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Nhường một vòng của event loop mà không đụng tới timer.
 *
 * Dùng lại **một** MessageChannel duy nhất. Bản trước tạo mới mỗi vòng, tức
 * hàng nghìn đối tượng trong vài giây — đủ để kích một đợt dọn rác đúng vào
 * nhịp bắn. Đo trên máy thật khi đó cho sai số tới 243ms.
 */
const channel = new MessageChannel();
let tickResolve = null;
channel.port1.onmessage = () => {
  const resolve = tickResolve;
  tickResolve = null;
  if (resolve) resolve();
};
channel.port1.start();

function macroTick() {
  return new Promise((resolve) => {
    tickResolve = resolve;
    channel.port2.postMessage(0);
  });
}

let queue = [];
let looping = false;

async function loop() {
  looping = true;
  try {
    while (queue.length) {
      const now = Date.now();
      while (queue.length && queue[0].at <= now) queue.shift().resolve(true);
      if (!queue.length) break;

      const remaining = queue[0].at - Date.now();
      if (remaining > SPIN_WINDOW_MS) {
        await sleep(Math.min(remaining - SPIN_WINDOW_MS, COARSE_STEP_MS));
      } else {
        await macroTick();
      }
    }
  } finally {
    looping = false;
  }
}

/**
 * Chờ tới một mốc trên đồng hồ máy.
 * @param {number} at mốc epoch (ms)
 * @returns {Promise<boolean>} true khi tới hạn
 */
export function waitUntil(at) {
  if (at <= Date.now()) return Promise.resolve(true);
  return new Promise((resolve) => {
    queue.push({ at, resolve });
    queue.sort((a, b) => a.at - b.at);
    if (!looping) loop();
  });
}

/** Huỷ mọi lượt chờ đang treo (dùng khi bấm Huỷ). */
export function cancelAll() {
  const pending = queue;
  queue = [];
  for (const item of pending) item.resolve(false);
}

/** Đo sai số thực tế của bộ hẹn giờ trong môi trường hiện tại. */
export async function measurePrecision(samples = 5, gapMs = 400) {
  const errors = [];
  for (let i = 0; i < samples; i++) {
    const target = Date.now() + gapMs;
    await waitUntil(target);
    errors.push(Date.now() - target);
  }
  errors.sort((a, b) => a - b);
  return { errors, median: errors[Math.floor(errors.length / 2)], worst: errors.at(-1) };
}
