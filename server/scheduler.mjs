import { sleep } from './util.mjs';

const TICK_MS = 30 * 1000;
const MAX_LAG_MS = 30 * 60 * 1000;

// 每天从 startHour 点开始，每隔 intervalHours 小时一个刷新槽（含 startHour 本身），
// 同一槽内按用户创建顺序依次错开 userStaggerMinutes 分钟。
export class Scheduler {
  constructor(store, syncUserPlatform) {
    this.store = store;
    this.sync = syncUserPlatform;
    this.timer = null;
    this.executed = new Set();
    this.queue = Promise.resolve();
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  slotTimes(now = Date.now()) {
    const s = this.store.scheduleSettings();
    if (!s.enabled) return [];
    const out = new Set();
    const base = new Date();
    base.setHours(s.startHour, 0, 0, 0);
    for (let dayOffset = -1; dayOffset <= 1; dayOffset++) {
      for (let k = -1; k * s.intervalHours < 48; k++) {
        const t = new Date(base);
        t.setDate(t.getDate() + dayOffset);
        t.setHours(s.startHour + k * s.intervalHours);
        const ms = t.getTime();
        if (Number.isFinite(ms)) out.add(ms);
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  async tick() {
    const now = Date.now();
    const s = this.store.scheduleSettings();
    if (!s.enabled) return;
    const users = this.store.listUsers();
    if (users.length === 0) return;
    for (const slot of this.slotTimes(now)) {
      const age = now - slot;
      if (age < 0 || age > MAX_LAG_MS) continue;
      users.forEach((u, i) => {
        const due = slot + i * s.userStaggerMinutes * 60 * 1000;
        const key = `${slot}:${u.id}`;
        if (due <= now && !this.executed.has(key)) {
          this.executed.add(key);
          this.enqueue(async () => {
            await this.syncUser(u.id, false);
          });
        }
      });
    }
    // 清理两天前的执行标记，避免集合无限增长
    for (const key of this.executed) {
      const slotMs = Number(key.split(':')[0]);
      if (Number.isFinite(slotMs) && now - slotMs > 48 * 3600 * 1000) this.executed.delete(key);
    }
  }

  enqueue(job) {
    this.queue = this.queue.then(job).catch((e) => console.error('[scheduler]', e.message));
  }

  async syncUser(userId, full) {
    this.running = true;
    try {
      const results = [];
      for (const p of ['codeforces', 'atcoder', 'luogu', 'nowcoder', 'qoj', 'leetcode']) {
        try {
          results.push(await this.sync(userId, p, !!full, 'auto'));
        } catch (e) {
          results.push({ platform: p, ok: false, message: e.message });
        }
      }
      return results;
    } finally {
      this.running = false;
    }
  }
}

export { sleep };
