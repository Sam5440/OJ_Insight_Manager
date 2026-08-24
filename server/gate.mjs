import { host as urlHost } from './util.mjs';

// 全局唯一的共享限流计时器：
// 所有对 OJ 平台的出站请求都必须经过本网关，底层只有一个 setInterval 驱动
// 各平台队列的放行，保证同一平台任意时刻只有一个请求在途、且间隔不小于 minGap。
const MIN_GAP = {
  'codeforces.com': 2100,
  'atcoder.jp': 1100,
  'kenkoooo.com': 1100,
  'www.luogu.com.cn': 600,
  'luogu.com.cn': 600,
  'ac.nowcoder.com': 300,
  'nowcoder.com': 300,
  'qoj.ac': 400,
  'leetcode.com': 200,
  'leetcode.cn': 200,
  'api.github.com': 300,
};
const DEFAULT_GAP = 500;
const TICK_MS = 120;

const gapFor = (host) => {
  for (const [suffix, gap] of Object.entries(MIN_GAP)) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return gap;
  }
  return DEFAULT_GAP;
};

class RequestGate {
  constructor() {
    this.queues = new Map();   // host -> [resolve]
    this.lastAt = new Map();   // host -> 上次放行时间
    this.stats = new Map();    // host -> {total, lastAt, nextAt, running}
    this.reqLog = [];          // 最近请求日志（环形，最多 200 条）
    this.timer = null;
    this.logListeners = [];
  }

  _ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  _stat(host) {
    let s = this.stats.get(host);
    if (!s) {
      s = { total: 0, running: 0, lastAt: null, nextAt: null };
      this.stats.set(host, s);
    }
    return s;
  }

  _tick() {
    const now = Date.now();
    for (const [host, queue] of this.queues) {
      if (queue.length === 0) continue;
      const last = this.lastAt.get(host) || 0;
      if (now - last >= gapFor(host)) {
        this.lastAt.set(host, now);
        const resolve = queue.shift();
        const s = this._stat(host);
        s.nextAt = queue.length ? now + gapFor(host) : null;
        resolve();
      }
    }
  }

  /** 取得对指定平台的请求许可（排队等待共享计时器放行） */
  acquire(url) {
    const host = typeof url === 'string' && url.includes('//') ? urlHost(url) : String(url);
    this._ensureTimer();
    let queue = this.queues.get(host);
    if (!queue) {
      queue = [];
      this.queues.set(host, queue);
    }
    const s = this._stat(host);
    s.total += 1;
    s.running += 1;
    if (!s.nextAt && queue.length === 0) s.nextAt = Date.now();
    const promise = new Promise((resolve) => queue.push(resolve));
    this._tick();
    return promise;
  }

  release(url, info = {}) {
    const host = typeof url === 'string' && url.includes('//') ? urlHost(url) : String(url);
    const s = this._stat(host);
    s.running = Math.max(0, s.running - 1);
    s.lastAt = Date.now();
    this.reqLog.push({
      ts: Date.now(),
      platform: host,
      method: info.method || 'GET',
      path: info.path || '',
      status: info.status ?? null,
      ms: info.ms ?? null,
      error: info.error || null,
    });
    if (this.reqLog.length > 200) this.reqLog.splice(0, this.reqLog.length - 200);
    for (const cb of this.logListeners) {
      try { cb(this.reqLog[this.reqLog.length - 1]); } catch { /* ignore */ }
    }
  }

  snapshotHosts() {
    return [...this.stats.entries()]
      .map(([platform, s]) => ({ platform, ...s, queued: (this.queues.get(platform) || []).length }))
      .sort((a, b) => b.total - a.total);
  }

  recentLogs(limit = 200) {
    return this.reqLog.slice(-limit).reverse();
  }
}

export const gate = new RequestGate();

export function platformOfUrl(url) {
  return urlHost(url);
}