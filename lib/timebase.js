/** Trục thời gian ổn định của phiên dashboard, không đi theo Windows Sync. */
export const contextId = crypto.randomUUID();
const monoOrigin = performance.now();
const wallOrigin = Date.now();
export const monoNow = () => performance.now();
export const stableNow = () => wallOrigin + monoNow() - monoOrigin;
export const wallShift = () => Date.now() - stableNow();
export const stableToMono = (epoch) => monoOrigin + epoch - wallOrigin;
