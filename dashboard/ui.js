/** Vài hàm DOM nhỏ, đủ dùng — không cần framework cho một trang. */

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function toast(message, tone = 'info', ms = 4200) {
  const stack = $('#toasts');
  if (!stack) return;
  const node = el('div', { class: `toast ${tone}`, text: message });
  stack.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

export function fmtInt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('vi-VN');
}

/** "3 phút trước", "2 giờ trước" — đủ để biết dữ liệu còn tươi hay không. */
export function fmtAgo(epochMs) {
  if (!epochMs) return '—';
  const s = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (s < 60) return `${s}s trước`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} giờ trước`;
  return `${Math.round(h / 24)} ngày trước`;
}

/** Chạy các tác vụ song song nhưng giới hạn số việc chạy cùng lúc. */
export async function pooled(items, limit, worker) {
  const queue = [...items.entries()];
  const results = new Array(items.length);
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [index, item] = next;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}
