export const PLATFORMS = ['codeforces', 'atcoder', 'luogu', 'nowcoder', 'qoj', 'leetcode'];

export const PLATFORM_ORDER_IDX = Object.fromEntries(PLATFORMS.map((p, i) => [p, i + 1]));

export function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function dayUtc8(ts) {
  return new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);
}

export function dayStartEpoch(day) {
  const parts = String(day).split('-').map(Number);
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]) / 1000 - 8 * 3600;
}

export function dayEndEpoch(day) {
  const s = dayStartEpoch(day);
  return s === null ? null : s + 86399;
}

export function todayUtc8() {
  return dayUtc8(nowEpoch());
}

export function parseDay(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str));
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function dayDiff(a, b) {
  return Math.round((parseDay(a) - parseDay(b)) / 86400000);
}

export function host(url) {
  const after = String(url).split('//')[1];
  return after ? after.split('/')[0] : String(url);
}