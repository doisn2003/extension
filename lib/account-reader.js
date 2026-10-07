/** Read-only account endpoint used by the current TX88/11BET web clients.
 * Never decode opaque session cookies or persist response bodies/tokens.
 */
export const ACCOUNT_PATH = '/api/v1/refresh';
export const ACCOUNT_ERRORS = {
  permission: 'Chưa có quyền truy cập site',
  cookies: 'Không đọc được cookie',
  network: 'Không kết nối được API tài khoản',
  timeout: 'API tài khoản quá thời gian chờ',
  blocked: 'API từ chối truy cập (403)',
  limited: 'API giới hạn yêu cầu (429)',
  http: 'API tài khoản báo lỗi',
  format: 'API không trả dữ liệu tài khoản hợp lệ',
};

export function normalizeProfile(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
  const id = user.id;
  if (!((typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
        (typeof id === 'string' && /^[1-9]\d*$/.test(id)))) return null;
  if (typeof user.username !== 'string' || !user.username.trim()) return null;
  const numberId = Number(id);
  const rawBalance = user.balance;
  const balance = typeof rawBalance === 'number' ? rawBalance :
    typeof rawBalance === 'string' && /^-?\d+(\.\d+)?$/.test(rawBalance.trim()) ? Number(rawBalance) : null;
  // Explicit allowlist: no token, password or unknown fields leave this reader.
  return {
    id: Number.isSafeInteger(numberId) ? numberId : id,
    username: user.username,
    fullname: typeof user.fullname === 'string' ? user.fullname : '',
    phone: typeof user.phone === 'string' ? user.phone : '',
    phonemask: typeof user.phonemask === 'string' ? user.phonemask : '',
    is_verify_phone: user.is_verify_phone === true || user.is_verify_phone === 1,
    uuid: typeof user.uuid === 'string' ? user.uuid : '',
    balance: Number.isFinite(balance) ? balance : null,
    vip_info: typeof user.vip_info === 'string' || typeof user.vip_info === 'number' ? user.vip_info : '',
    member_id: typeof user.member_id === 'number' || typeof user.member_id === 'string' ? user.member_id : null,
  };
}

export async function fetchProfile(host, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://${host}${ACCOUNT_PATH}`, {
      method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json' }, signal: controller.signal,
    });
    if (response.status === 401) return { state: 'logged-out' };
    if (!response.ok) return { state: 'error', error: response.status === 403 ? 'blocked' : response.status === 429 ? 'limited' : 'http' };
    if (!(response.headers.get('content-type') || '').includes('application/json')) return { state: 'error', error: 'format' };
    const body = await response.json();
    if (body && Object.hasOwn(body, 'user') && body.user === null) return { state: 'logged-out' };
    const user = normalizeProfile(body?.user);
    return user ? { state: 'ok', user } : { state: 'error', error: 'format' };
  } catch (error) {
    return { state: 'error', error: controller.signal.aborted ? 'timeout' : error instanceof SyntaxError ? 'format' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
