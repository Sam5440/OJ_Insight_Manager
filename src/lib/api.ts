export interface StorageInfo {
  rootDir: string;
  dataDir: string;
  databasePath: string;
  exportDir: string;
  webviewDir: string;
}

import { invoke } from '@tauri-apps/api/core';
import type {
  AdminOverview, DayDetail, GroupInfo, Metric, MonitorData, Platform, RecordItem,
  Snapshot, SummaryCards, SummaryItem, SyncResult, SyncStatus, TrendData, UpdateInfo, UserLite, CardPeriod,
} from '../types';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data && typeof data.error === 'string') message = data.error;
    } catch {
      /* keep the status fallback */
    }
    throw new Error(message);
  }
  return res.json();
}

async function adminReq<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = localStorage.getItem('oj_admin_token') || '';
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data && typeof data.error === 'string') message = data.error;
    } catch { /* ignore */ }
    if (res.status === 401 && !path.endsWith('/login')) {
      localStorage.removeItem('oj_admin_token');
      throw new Error('未登录或登录已过期');
    }
    throw new Error(message);
  }
  return res.json();
}

const LOCAL_USER: UserLite = { id: 'local', name: '本地账号', groupId: null };

export const api = isTauri
  ? {
      storageInfo: () => invoke<StorageInfo>('get_storage_info'),
      users: async () => ({ groups: [] as GroupInfo[], users: [LOCAL_USER] }),
      getStatuses: (_userId: string) => invoke<SyncStatus[]>('get_sync_statuses'),
      syncPlatform: (_userId: string, platform: Platform, full = false) =>
        invoke<SyncResult>('sync_platform', { platform, full }),
      snapshot: (_userId: string, platform: Platform | null, startDay: string | null, endDay: string | null, metric: Metric) =>
        invoke<Snapshot>('get_snapshot', { platform, startDay, endDay, metric }),
      dayDetail: (day: string, _userId: string, platform: Platform | null) =>
        invoke<DayDetail>('get_day_detail', { day, platform }),
      records: (_userId: string | null): Promise<(SubmissionLike & { userName: string })[]> =>
        invoke<SubmissionLike[]>('get_all_submissions').then((rows) => rows.map((r) => ({ ...r, userName: '本地账号' }))),
      summary: (limit: number) =>
        invoke<SubmissionLike[]>('get_all_submissions').then((rows) =>
          rows.slice(-limit).reverse().map((r) => ({ ...r, userId: 'local', userName: '本地账号' })),
        ),
      cards: async (period: CardPeriod): Promise<SummaryCards> => {
        const rows = await invoke<SubmissionLike[]>('get_all_submissions');
        const today = new Date((Math.floor(Date.now() / 1000) + 8 * 3600) * 1000).toISOString().slice(0, 10);
        const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
        const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
        let cur: [string, string] | null = null;
        let prev: [string, string] | null = null;
        let label = '';
        if (period === 'week') {
          const monday = addDays(today, -((dow + 6) % 7));
          cur = [monday, today]; prev = [addDays(monday, -7), addDays(monday, -1)]; label = '本周 / 上一周';
        } else if (period === 'month') {
          const first = `${today.slice(0, 7)}-01`;
          const pmLast = addDays(first, -1);
          cur = [first, today]; prev = [`${pmLast.slice(0, 7)}-01`, pmLast]; label = '本月 / 上月';
        } else if (period === 'year') {
          const y = today.slice(0, 4);
          cur = [`${y}-01-01`, today]; prev = [`${Number(y) - 1}-01-01`, `${Number(y) - 1}-12-31`]; label = '本年 / 去年';
        } else {
          label = '总计';
        }
        const cnt = (r: SubmissionLike[], range: [string, string] | null) => {
          if (!range) return r.length;
          const s = Date.parse(`${range[0]}T00:00:00Z`) / 1000 - 8 * 3600;
          const e = Date.parse(`${range[1]}T00:00:00Z`) / 1000 + 86399 - 8 * 3600;
          return r.filter((x) => x.epoch_second >= s && x.epoch_second <= e).length;
        };
        const cells = Object.fromEntries(
          ['codeforces', 'atcoder', 'luogu', 'nowcoder', 'qoj', 'leetcode'].map((p) => {
            const sub = rows.filter((x) => x.platform === p);
            return [p, { cur: cnt(sub, cur), prev: prev ? cnt(sub, prev) : 0 }];
          }),
        ) as SummaryCards['cards'][number]['cells'];
        const labels: Record<CardPeriod, [string, string | null]> = {
          week: ['本周', '上一周'], month: ['本月', '上月'], year: ['本年', '去年'], total: ['总计', null],
        };
        return {
          period, label, curLabel: labels[period][0], prevLabel: labels[period][1],
          generatedAt: Math.floor(Date.now() / 1000), ranges: { cur, prev },
          cards: [{ userId: 'local', userName: '本地账号', groupName: '', cells, totalCur: cnt(rows, cur), totalPrev: prev ? cnt(rows, prev) : 0 }],
        };
      },
      userTrend: async (userId: string, days: 30 | 180): Promise<TrendData> => {
        const rows = await invoke<SubmissionLike[]>('get_all_submissions');
        const n = days;
        const map: Record<string, number> = {};
        for (const r of rows) {
          const d = new Date((r.epoch_second + 8 * 3600) * 1000).toISOString().slice(0, 10);
          map[d] = (map[d] || 0) + 1;
        }
        const points = Array.from({ length: n }, (_, i) => {
          const d = new Date((Math.floor(Date.now() / 1000) - (n - 1 - i) * 86400 + 8 * 3600) * 1000).toISOString().slice(0, 10);
          return { day: d, count: map[d] || 0 };
        });
        return { userId, userName: '本地账号', days: n, start: points[0].day, end: points[n - 1].day, points };
      },
      monitor: async (): Promise<MonitorData> => ({
        generatedAt: Date.now(),
        schedule: { enabled: false, startHour: 0, intervalHours: 4, userStaggerMinutes: 10 },
        hosts: [],
        platforms: ['codeforces', 'atcoder', 'luogu', 'nowcoder', 'qoj', 'leetcode'].map((p) => ({ platform: p as Platform, entries: [] })),
        logs: [],
      }),
      checkForUpdates: () => invoke<UpdateInfo>('check_for_updates'),
      openExternal: (url: string) => invoke<void>('open_external', { url }),
    }
  : {
      storageInfo: () => req<StorageInfo>('GET', '/api/storage_info'),
      users: () => req<{ groups: GroupInfo[]; users: UserLite[] }>('GET', '/api/users'),
      getStatuses: (userId: string) => req<SyncStatus[]>('GET', `/api/statuses?${new URLSearchParams({ userId })}`),
      syncPlatform: (userId: string, platform: Platform, full = false) =>
        req<SyncResult>('POST', '/api/sync', { userId, platform, full }),
      snapshot: (userId: string, platform: Platform | null, startDay: string | null, endDay: string | null, metric: Metric) =>
        req<Snapshot>('POST', '/api/snapshot', { userId, platform, startDay, endDay, metric }),
      dayDetail: (day: string, userId: string, platform: Platform | null) =>
        req<DayDetail>('POST', '/api/day_detail', { day, userId, platform }),
      records: (userId: string | null, startDay?: string | null, endDay?: string | null) => {
        const params = new URLSearchParams();
        if (userId) params.set('userId', userId);
        if (startDay) params.set('start', startDay);
        if (endDay) params.set('end', endDay);
        return req<RecordItem[]>('GET', `/api/records?${params}`);
      },
      summary: (limit: number) => req<SummaryItem[]>('GET', `/api/summary?limit=${limit}`),
      cards: (period: CardPeriod) => req<SummaryCards>('GET', `/api/cards?period=${period}`),
      userTrend: (userId: string, days: 30 | 180) =>
        req<TrendData>('GET', `/api/user_trend?${new URLSearchParams({ userId, days: String(days) })}`),
      monitor: () => req<MonitorData>('GET', '/api/monitor'),
      checkForUpdates: () => req<UpdateInfo>('GET', '/api/check_updates'),
      openExternal: (url: string) => {
        window.open(url, '_blank', 'noopener,noreferrer');
        return Promise.resolve();
      },
    };

interface SubmissionLike {
  platform: Platform;
  submission_id: string;
  problem_key: string;
  problem_id: string;
  problem_name: string;
  problem_url: string;
  epoch_second: number;
  language: string;
  difficulty: string | null;
}

// 管理后台 API（仅 Web 模式可用）
export const adminApi = {
  available: !isTauri,
  login: async (username: string, password: string) => {
    const r = await adminReq<{ token: string }>('POST', '/api/admin/login', { username, password });
    localStorage.setItem('oj_admin_token', r.token);
    return r;
  },
  logout: async () => {
    try { await adminReq('POST', '/api/admin/logout'); } catch { /* ignore */ }
    localStorage.removeItem('oj_admin_token');
  },
  overview: () => adminReq<AdminOverview>('GET', '/api/admin/overview'),
  upsertGroup: (id: string | null, name: string) => adminReq<GroupInfo[]>('PUT', '/api/admin/groups', { id, name }),
  deleteGroup: (id: string) => adminReq<GroupInfo[]>('DELETE', `/api/admin/groups/${id}`),
  upsertUser: (id: string | null, name: string, groupId: string | null) =>
    adminReq<AdminOverview['users']>('PUT', '/api/admin/users', { id, name, groupId }),
  deleteUser: (id: string) => adminReq<AdminOverview['users']>('DELETE', `/api/admin/users/${id}`),
  saveAccount: (userId: string, platform: Platform, account: string, secret: string) =>
    adminReq<unknown>('PUT', `/api/admin/users/${userId}/accounts`, { platform, account, secret }),
  clearData: (userId: string, platform: Platform | null) =>
    adminReq<void>('POST', '/api/admin/clear', { userId, platform }),
  saveSettings: (schedule: { enabled: boolean; startHour: number; intervalHours: number; userStaggerMinutes: number }) =>
    adminReq<unknown>('PUT', '/api/admin/settings', { schedule }),
  changePassword: (oldPassword: string, newPassword: string) =>
    adminReq<void>('POST', '/api/admin/password', { oldPassword, newPassword }),
  sync: (userId: string, platform: Platform | null, full: boolean) =>
    adminReq<{ user: string; results: SyncResult[] }>('POST', '/api/admin/sync', { userId, platform, full }),
};