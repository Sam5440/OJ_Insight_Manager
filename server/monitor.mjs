import { PLATFORMS } from './util.mjs';

// 监控队列：记录正在排队/执行中的同步任务，供管理后台「监控队列」板块展示。
export class Monitor {
  constructor() {
    this.active = new Map(); // `${userId}:${platform}` -> entry
  }

  enter(userId, userName, platform, source = 'manual') {
    const key = `${userId}:${platform}`;
    this.active.set(key, {
      key,
      userId,
      userName,
      platform,
      state: 'waiting',
      source,
      enqueuedAt: Date.now(),
      startedAt: null,
    });
  }

  markRunning(userId, platform) {
    const e = this.active.get(`${userId}:${platform}`);
    if (e && !e.startedAt) {
      e.state = 'running';
      e.startedAt = Date.now();
    }
  }

  exit(userId, platform, result = {}) {
    this.active.delete(`${userId}:${platform}`);
    return { ok: result.ok !== false };
  }

  list() {
    return [...this.active.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }
}

export const monitor = new Monitor();

// 计算某个用户（按创建顺序 index）在自动同步计划下的下一次刷新时间。
export function nextRunFor(schedule, userIndex, now = Date.now()) {
  if (!schedule.enabled) return null;
  const { startHour, intervalHours, userStaggerMinutes } = schedule;
  const base = new Date();
  base.setHours(startHour, 0, 0, 0);
  const candidates = [];
  for (let d = -1; d <= 2; d++) {
    for (let k = 0; k * intervalHours < 48; k++) {
      const t = new Date(base);
      t.setDate(t.getDate() + d);
      t.setHours(startHour + k * intervalHours);
      candidates.push(t.getTime() + userIndex * userStaggerMinutes * 60 * 1000);
    }
  }
  candidates.sort((a, b) => a - b);
  return candidates.find((t) => t > now) || null;
}

export function monitorSnapshot(store, gate, scheduler) {
  const users = store.listUsers();
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const schedule = store.scheduleSettings();
  const activeList = monitor.list().map((e) => ({
    ...e,
    lastSuccessAt: store.data.syncState[`${e.userId}:${e.platform}`]?.last_success ?? null,
  }));
  // 每个平台的等待/运行列表 + 空闲用户的下次计划刷新
  const byPlatform = {};
  for (const p of PLATFORMS) byPlatform[p] = [];
  for (const e of activeList) byPlatform[e.platform]?.push({ ...e, kind: 'active' });
  users.forEach((u, idx) => {
    const nextAt = nextRunFor(schedule, idx);
    for (const p of PLATFORMS) {
      if (activeList.some((e) => e.userId === u.id && e.platform === p)) continue;
      const lastSuccessAt = store.data.syncState[`${u.id}:${p}`]?.last_success ?? null;
      if (!store.data.accounts[u.id]?.[p]?.account) continue;
      byPlatform[p].push({ kind: 'idle', userId: u.id, userName: u.name, platform: p, nextAt, lastSuccessAt });
    }
  });
  return {
    generatedAt: Date.now(),
    schedule,
    hosts: gate.snapshotHosts(),
    platforms: PLATFORMS.map((p) => ({ platform: p, entries: byPlatform[p] })),
    logs: gate.recentLogs(200),
  };
}