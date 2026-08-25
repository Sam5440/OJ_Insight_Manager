import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  PLATFORMS,
  PLATFORM_ORDER_IDX,
  dayUtc8,
  dayStartEpoch,
  dayEndEpoch,
  nowEpoch,
  todayUtc8,
  dayDiff,
} from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SCHEDULE = { enabled: true, startHour: 0, intervalHours: 4, userStaggerMinutes: 10 };

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 32).toString('hex');
}

export class Store {
  constructor({ rootDir } = {}) {
    this.rootDir = rootDir || path.join(__dirname, 'data');
    this.dataDir = path.join(this.rootDir, 'data');
    this.exportDir = path.join(this.rootDir, 'exports');
    this.webviewDir = path.join(this.rootDir, 'webview');
    this.logDir = path.join(this.rootDir, 'logs');
    this.file = path.join(this.dataDir, 'oj-insight.json');
    this.data = null;
    for (const dir of [this.dataDir, this.exportDir, this.webviewDir, this.logDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this._load();
  }

  // ---------------------------------------------------------------- storage

  _load() {
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        this.data = null;
      }
    }
    if (!this.data || typeof this.data !== 'object') this.data = {};
    const d = this.data;
    if (!Array.isArray(d.groups)) d.groups = [];
    if (!Array.isArray(d.users)) d.users = [];
    if (!d.accounts) d.accounts = {};
    if (!Array.isArray(d.submissions)) d.submissions = [];
    if (!Array.isArray(d.dailyCounts)) d.dailyCounts = [];
    if (!Array.isArray(d.dailyAggregates)) d.dailyAggregates = [];
    if (!d.platformStats) d.platformStats = {};
    if (!Array.isArray(d.difficultyStats)) d.difficultyStats = [];
    if (!d.syncState) d.syncState = {};
    if (!d.settings) d.settings = {};
    if (!d.settings.schedule) d.settings.schedule = { ...DEFAULT_SCHEDULE };
    const VALID_PERIODS = ['week', 'month', 'year', 'total'];
    if (!VALID_PERIODS.includes(d.settings.summary?.defaultPeriod)) {
      d.settings.summary = { defaultPeriod: 'week' };
    }
    if (!d.auth) d.auth = null;

    // v1 → v2 迁移：把全局单账号结构迁移为「默认分组 + 默认用户」。
    if (d.users.length === 0 && d.accounts.platforms !== 'v2') {
      const legacy = d.accounts;
      const hasLegacyAccounts = Object.keys(legacy).some(
        (k) => ['codeforces', 'atcoder', 'luogu', 'nowcoder', 'qoj', 'leetcode'].includes(k)
      );
      const groupId = newId('g');
      const userId = newId('u');
      d.groups.push({ id: groupId, name: '默认分组', createdAt: nowEpoch() });
      d.users.push({ id: userId, name: '默认用户', groupId, createdAt: nowEpoch() });
      const migrated = {};
      for (const p of PLATFORMS) {
        if (legacy[p] && typeof legacy[p] === 'object') {
          migrated[p] = { account: legacy[p].account || '', secret: legacy[p].secret || '' };
        }
      }
      d.accounts = { platforms: 'v2' };
      d.accounts[userId] = migrated;
      for (const s of d.submissions) s.userId = userId;
      for (const c of d.dailyCounts) c.userId = userId;
      for (const a of d.dailyAggregates) a.userId = userId;
      for (const x of d.difficultyStats) x.userId = userId;
      const newState = {};
      for (const [key, value] of Object.entries(d.syncState)) {
        newState[`${userId}:${key}`] = value;
      }
      d.syncState = newState;
      const oldStats = d.platformStats;
      d.platformStats = {};
      for (const [p, value] of Object.entries(oldStats)) {
        d.platformStats[`${userId}:${p}`] = value;
      }
      this.persist();
    }

    for (const p of PLATFORMS) {
      for (const u of d.users) {
        const key = `${u.id}:${p}`;
        if (!d.syncState[key]) {
          d.syncState[key] = { account: '', status: 'idle', message: '', last_attempt: null, last_success: null, cursor_epoch: 0 };
        }
      }
    }
    // 默认管理员 admin / qwe123
    if (!d.auth) {
      const salt = crypto.randomBytes(12).toString('hex');
      d.auth = { username: 'admin', salt, hash: hashPassword('qwe123', salt) };
      this.persist();
    }
  }

  persist() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  storageInfo() {
    return {
      rootDir: this.rootDir,
      dataDir: this.dataDir,
      databasePath: this.file,
      exportDir: this.exportDir,
      webviewDir: this.webviewDir,
      logDir: this.logDir,
    };
  }

  // ------------------------------------------------------------------- auth

  verifyLogin(username, password) {
    const a = this.data.auth;
    if (!a || username !== a.username) return false;
    const candidate = hashPassword(password, a.salt);
    const okLen = candidate.length === a.hash.length;
    return okLen && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(a.hash));
  }

  changePassword(oldPassword, newPassword) {
    if (!this.verifyLogin(this.data.auth.username, oldPassword)) throw new Error('原密码不正确');
    if (!newPassword || String(newPassword).length < 6) throw new Error('新密码至少 6 位');
    const salt = crypto.randomBytes(12).toString('hex');
    this.data.auth.salt = salt;
    this.data.auth.hash = hashPassword(newPassword, salt);
    this.persist();
  }

  // ------------------------------------------------------------ users/groups

  listGroups() {
    return this.data.groups.slice().sort((a, b) => a.createdAt - b.createdAt);
  }

  listUsers() {
    return this.data.users.slice().sort((a, b) => a.createdAt - b.createdAt);
  }

  publicUsers() {
    return {
      groups: this.listGroups().map((g) => ({ id: g.id, name: g.name })),
      users: this.listUsers().map((u) => ({ id: u.id, name: u.name, groupId: u.groupId })),
    };
  }

  getUser(userId) {
    const u = this.data.users.find((x) => x.id === userId);
    if (!u) throw new Error('用户不存在');
    return u;
  }

  upsertGroup({ id, name }) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('分组名称不能为空');
    if (id) {
      const g = this.data.groups.find((x) => x.id === id);
      if (!g) throw new Error('分组不存在');
      g.name = trimmed;
    } else {
      this.data.groups.push({ id: newId('g'), name: trimmed, createdAt: nowEpoch() });
    }
    this.persist();
  }

  deleteGroup(id) {
    const idx = this.data.groups.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error('分组不存在');
    this.data.groups.splice(idx, 1);
    for (const u of this.data.users) {
      if (u.groupId === id) u.groupId = null;
    }
    this.persist();
  }

  adminUser(u) {
    return {
      id: u.id,
      name: u.name,
      groupId: u.groupId ?? null,
      createdAt: u.createdAt,
      accounts: this.data.accounts[u.id] || {},
    };
  }

  upsertUser({ id, name, groupId }) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('用户名不能为空');
    if (groupId && !this.data.groups.some((g) => g.id === groupId)) throw new Error('分组不存在');
    if (id) {
      const u = this.getUser(id);
      u.name = trimmed;
      u.groupId = groupId || null;
    } else {
      this.data.users.push({ id: newId('u'), name: trimmed, groupId: groupId || null, createdAt: nowEpoch() });
    }
    this.persist();
  }

  deleteUser(id) {
    const idx = this.data.users.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error('用户不存在');
    this.data.users.splice(idx, 1);
    delete this.data.accounts[id];
    this.data.submissions = this.data.submissions.filter((x) => x.userId !== id);
    this.data.dailyCounts = this.data.dailyCounts.filter((x) => x.userId !== id);
    this.data.dailyAggregates = this.data.dailyAggregates.filter((x) => x.userId !== id);
    this.data.difficultyStats = this.data.difficultyStats.filter((x) => x.userId !== id);
    for (const key of Object.keys(this.data.syncState)) {
      if (key.startsWith(`${id}:`)) delete this.data.syncState[key];
    }
    for (const key of Object.keys(this.data.platformStats)) {
      if (key.startsWith(`${id}:`)) delete this.data.platformStats[key];
    }
    this.persist();
  }

  setUserAccount(userId, platform, account, secret) {
    if (!PLATFORMS.includes(platform)) throw new Error('不支持的平台');
    this.getUser(userId);
    this.data.accounts[userId] = this.data.accounts[userId] || {};
    this.data.accounts[userId][platform] = {
      account: String(account || '').trim(),
      secret: String(secret || '').trim(),
    };
    const key = `${userId}:${platform}`;
    if (this.data.syncState[key]) this.data.syncState[key].account = String(account || '').trim();
    this.persist();
  }

  getAccount(userId, platform) {
    const entry = this.data.accounts[userId]?.[platform];
    if (!entry || !String(entry.account || '').trim()) throw new Error(`${platform} 尚未绑定账号`);
    return { platform, account: entry.account, secret: entry.secret || '' };
  }

  userAccountView(userId) {
    const out = {};
    for (const p of PLATFORMS) {
      const e = this.data.accounts[userId]?.[p];
      if (e && e.account) out[p] = { account: e.account, secret: e.secret || '' };
    }
    return out;
  }

  // -------------------------------------------------------------- sync state

  getCursor(userId, platform) {
    return this.data.syncState[`${userId}:${platform}`]?.cursor_epoch || 0;
  }

  markSyncing(userId, platform, account) {
    const key = `${userId}:${platform}`;
    this.data.syncState[key] = {
      ...(this.data.syncState[key] || {}),
      account,
      status: 'syncing',
      message: '正在同步',
      last_attempt: nowEpoch(),
    };
    this.persist();
  }

  markFailed(userId, platform, account, status, message) {
    const key = `${userId}:${platform}`;
    this.data.syncState[key] = {
      ...(this.data.syncState[key] || {}),
      account,
      status,
      message,
      last_attempt: nowEpoch(),
    };
    this.persist();
  }

  markOk(userId, platform, account, message, cursorEpoch) {
    const now = nowEpoch();
    const key = `${userId}:${platform}`;
    this.data.syncState[key] = {
      account,
      status: 'ok',
      message,
      last_attempt: now,
      last_success: now,
      cursor_epoch: Math.max(this.getCursor(userId, platform), cursorEpoch),
    };
  }

  statuses(userId) {
    const out = [];
    for (const p of PLATFORMS) {
      const key = `${userId}:${p}`;
      const s = this.data.syncState[key];
      const account = s?.account || this.data.accounts[userId]?.[p]?.account || '';
      const cachedRecords =
        this.data.submissions.filter((x) => x.userId === userId && x.platform === p).length +
        this.data.dailyAggregates.filter((x) => x.userId === userId && x.platform === p).length;
      out.push({
        platform: p,
        account,
        status: s?.status || 'idle',
        message: s?.message || '',
        last_attempt: s?.last_attempt ?? null,
        last_success: s?.last_success ?? null,
        cached_records: cachedRecords,
      });
    }
    out.sort((a, b) => PLATFORM_ORDER_IDX[a.platform] - PLATFORM_ORDER_IDX[b.platform]);
    return out;
  }

  clearPlatform(userId, platform) {
    this.getUser(userId);
    const d = this.data;
    d.submissions = d.submissions.filter((x) => !(x.userId === userId && x.platform === platform));
    d.dailyCounts = d.dailyCounts.filter((x) => !(x.userId === userId && x.platform === platform));
    d.dailyAggregates = d.dailyAggregates.filter((x) => !(x.userId === userId && x.platform === platform));
    delete d.platformStats[`${userId}:${platform}`];
    d.difficultyStats = d.difficultyStats.filter((x) => !(x.userId === userId && x.platform === platform));
    const key = `${userId}:${platform}`;
    if (d.syncState[key]) {
      d.syncState[key] = {
        account: d.syncState[key].account,
        status: 'idle',
        message: '本地记录已清空',
        last_attempt: null,
        last_success: null,
        cursor_epoch: 0,
      };
    }
    this.persist();
  }

  clearAll(userId) {
    for (const p of PLATFORMS) this.clearPlatform(userId, p);
  }

  // ----------------------------------------------------------------- logging

  logEvent(platform, message, secret, tag = '') {
    const safe = this._redact(message, secret);
    const prefix = tag ? `[${tag}] ` : '';
    const line = `${new Date().toISOString()} ${prefix}[${platform}] ${safe}\n`;
    try {
      fs.appendFileSync(path.join(this.logDir, 'oj-insight.log'), line);
    } catch { /* ignore */ }
  }

  _redact(input, secret) {
    let value = String(input);
    if (secret && secret.trim()) value = value.split(secret.trim()).join('[REDACTED]');
    return value.replace(/UOJSESSID=[^;\s]+/gi, 'UOJSESSID=[REDACTED]');
  }

  // ------------------------------------------------------------- apply remote

  applyRemote(remote, userId) {
    const d = this.data;
    let inserted = 0;
    let updated = 0;
    if (remote.replaceSubmissions) {
      d.submissions = d.submissions.filter((s) => !(s.userId === userId && s.platform === remote.platform));
    }
    if (remote.replaceAggregates) {
      d.dailyAggregates = d.dailyAggregates.filter((a) => !(a.userId === userId && a.platform === remote.platform));
      d.dailyCounts = d.dailyCounts.filter((c) => !(c.userId === userId && c.platform === remote.platform));
    }
    for (const s of remote.submissions) {
      const stored = {
        userId,
        platform: s.platform,
        submission_id: s.submissionId,
        problem_key: s.problemKey,
        problem_id: s.problemId,
        problem_name: s.problemName,
        problem_url: s.problemUrl,
        epoch_second: s.epochSecond,
        language: s.language,
        difficulty: s.difficulty,
      };
      const idx = d.submissions.findIndex(
        (x) => x.userId === userId && x.platform === stored.platform && x.submission_id === stored.submission_id
      );
      if (idx >= 0) {
        d.submissions[idx] = stored;
        updated += 1;
      } else {
        d.submissions.push(stored);
        inserted += 1;
      }
    }
    for (const a of remote.aggregates) {
      const agg = { userId, platform: remote.platform, day: a.day, metric: a.metric, count: a.count, note: a.note };
      const match = (x) => x.userId === userId && x.platform === agg.platform && x.day === agg.day && x.metric === agg.metric;
      let idx = d.dailyAggregates.findIndex(match);
      if (idx >= 0) d.dailyAggregates[idx] = agg;
      else d.dailyAggregates.push(agg);
      idx = d.dailyCounts.findIndex(match);
      const point = { userId, platform: agg.platform, day: agg.day, metric: agg.metric, count: agg.count };
      if (idx >= 0) d.dailyCounts[idx] = point;
      else d.dailyCounts.push(point);
    }
    d.difficultyStats = d.difficultyStats.filter((x) => !(x.userId === userId && x.platform === remote.platform));
    for (const df of remote.difficulty) {
      d.difficultyStats.push({ userId, platform: remote.platform, label: df.label, count: df.count, order: df.order });
    }
    const statKey = `${userId}:${remote.platform}`;
    this._setStat(statKey, 'activity_only', remote.activityOnly ? '1' : '0');
    this._setStat(statKey, 'notes', JSON.stringify(remote.notes || []));
    if (remote.solvedCount != null) {
      this._setStat(statKey, 'solved_count', String(remote.solvedCount));
    } else if (!remote.activityOnly) {
      this._deleteStat(statKey, 'solved_count');
    }
    if (!remote.activityOnly) this._recomputeRawDaily(userId, remote.platform);

    const warning = (remote.notes || []).find((n) => n.startsWith('警告：'));
    const base = `同步成功 · 新增 ${inserted}，更新 ${updated}`;
    this.markOk(userId, remote.platform, remote.account, warning ? `${base} · ${warning}` : base, remote.cursorEpoch);
    this.persist();
    return { inserted, updated };
  }

  _setStat(key, k, value) {
    this.data.platformStats[key] = this.data.platformStats[key] || {};
    this.data.platformStats[key][k] = value;
  }

  _deleteStat(key, k) {
    if (this.data.platformStats[key]) delete this.data.platformStats[key][k];
  }

  _getStat(key, k) {
    return this.data.platformStats[key]?.[k];
  }

  _recomputeRawDaily(userId, platform) {
    const d = this.data;
    d.dailyCounts = d.dailyCounts.filter((c) => !(c.userId === userId && c.platform === platform));
    const subs = d.submissions
      .filter((s) => s.userId === userId && s.platform === platform)
      .slice()
      .sort((a, b) => a.epoch_second - b.epoch_second || (a.submission_id < b.submission_id ? -1 : a.submission_id > b.submission_id ? 1 : 0));
    const firstSeen = new Set();
    const dailySeen = new Set();
    const first = {};
    const unique = {};
    const counts = {};
    for (const s of subs) {
      const day = dayUtc8(s.epoch_second);
      counts[day] = (counts[day] || 0) + 1;
      const uk = `${day}\0${s.problem_key}`;
      if (!dailySeen.has(uk)) {
        dailySeen.add(uk);
        unique[day] = (unique[day] || 0) + 1;
      }
      if (!firstSeen.has(s.problem_key)) {
        firstSeen.add(s.problem_key);
        first[day] = (first[day] || 0) + 1;
      }
    }
    this._insertCounts(userId, platform, 'accepted_submissions', counts);
    this._insertCounts(userId, platform, 'activity', counts);
    this._insertCounts(userId, platform, 'daily_unique', unique);
    this._insertCounts(userId, platform, 'first_ac', first);
  }

  _insertCounts(userId, platform, metric, map) {
    for (const [day, count] of Object.entries(map)) {
      this.data.dailyCounts.push({ userId, platform, day, metric, count });
    }
  }

  // ------------------------------------------------------------------ queries

  getAllSubmissions(userId /* string | null */) {
    return this.data.submissions
      .filter((s) => !userId || s.userId === userId)
      .slice()
      .sort(
        (a, b) =>
          a.epoch_second - b.epoch_second ||
          (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0) ||
          (a.submission_id < b.submission_id ? -1 : a.submission_id > b.submission_id ? 1 : 0)
      );
  }

  recordsWithUser(userId, startDay, endDay) {
    const rows = this.getAllSubmissions(userId || null).filter((s) => {
      const day = dayUtc8(s.epoch_second);
      return (!startDay || day >= startDay) && (!endDay || day <= endDay);
    });
    const names = new Map(this.listUsers().map((u) => [u.id, u.name]));
    return rows.map((r) => ({ ...r, userName: names.get(r.userId) || r.userId }));
  }

  summary(limit) {
    const names = new Map(this.listUsers().map((u) => [u.id, u.name]));
    return this.data.submissions
      .slice()
      .sort((a, b) => b.epoch_second - a.epoch_second)
      .slice(0, limit)
      .map((r) => ({ ...r, userName: names.get(r.userId) || r.userId }));
  }

  // ---------------------------------------------------------------- 周期卡片

  _countInRange(userId, platform, startDay, endDay) {
    const startTs = dayStartEpoch(startDay);
    const endTs = dayEndEpoch(endDay);
    if (startTs === null || endTs === null) return 0;
    return this.data.submissions.filter(
      (s) => s.userId === userId && s.platform === platform && s.epoch_second >= startTs && s.epoch_second <= endTs
    ).length;
  }

  _activitySumInRange(userId, platform, startDay, endDay) {
    if (!startDay || !endDay) {
      // 全期：活动总和
      let total = 0;
      for (const c of this.data.dailyCounts) {
        if (c.userId === userId && c.platform === platform && c.metric === 'activity') total += c.count;
      }
      return total;
    }
    let total = 0;
    for (const c of this.data.dailyCounts) {
      if (c.userId === userId && c.platform === platform && c.metric === 'activity' && c.day >= startDay && c.day <= endDay) {
        total += c.count;
      }
    }
    return total;
  }

  cards(period = 'week') {
    const tz8 = (offsetDays = 0) => {
      // 以 UTC+8 的「今天」为基准的日期偏移
      const d = new Date((nowEpoch() + 8 * 3600 + offsetDays * 86400) * 1000);
      return d.toISOString().slice(0, 10);
    };
    const dowUtc8 = (dayStr) => new Date(`${dayStr}T00:00:00Z`).getUTCDay(); // 0=周日
    const addDays = (dayStr, n) => {
      const t = Date.parse(`${dayStr}T00:00:00Z`) / 1000 + n * 86400;
      return new Date(t * 1000).toISOString().slice(0, 10);
    };
    const today = tz8();

    let curRange = null;
    let prevRange = null;
    let label = '';
    let curLabel = '本期';
    let prevLabel = '上期';
    if (period === 'week') {
      const monday = addDays(today, -((dowUtc8(today) + 6) % 7));
      curRange = [monday, today];
      prevRange = [addDays(monday, -7), addDays(monday, -1)];
      label = '本周 / 上一周';
      curLabel = '本周';
      prevLabel = '上一周';
    } else if (period === 'month') {
      const first = `${today.slice(0, 7)}-01`;
      const prevMonthLast = addDays(first, -1);
      const prevFirst = `${prevMonthLast.slice(0, 7)}-01`;
      curRange = [first, today];
      prevRange = [prevFirst, prevMonthLast];
      label = '本月 / 上月';
      curLabel = '本月';
      prevLabel = '上月';
    } else if (period === 'year') {
      const first = `${today.slice(0, 4)}-01-01`;
      curRange = [first, today];
      prevRange = [`${Number(today.slice(0, 4)) - 1}-01-01`, `${Number(today.slice(0, 4)) - 1}-12-31`];
      label = '本年 / 去年';
      curLabel = '本年';
      prevLabel = '去年';
    } else {
      label = '总计';
      curLabel = '总计';
      prevLabel = null;
    }

    const users = this.listUsers();
    const groups = new Map(this.listGroups().map((g) => [g.id, g.name]));
    const cards = users.map((u) => {
      const cells = {};
      let totalCur = 0;
      let totalPrev = 0;
      for (const p of PLATFORMS) {
        let cur = 0;
        let prev = 0;
        const hasSubs = this.data.submissions.some((s) => s.userId === u.id && s.platform === p);
        const activityOnly = this._platformActivityOnly(`${u.id}:${p}`);
        const useActivity = activityOnly || (!hasSubs && !!this.data.dailyCounts.some((c) => c.userId === u.id && c.platform === p));
        if (useActivity) {
          cur = curRange ? this._activitySumInRange(u.id, p, curRange[0], curRange[1]) : this._activitySumInRange(u.id, p, null, null);
          prev = prevRange ? this._activitySumInRange(u.id, p, prevRange[0], prevRange[1]) : 0;
        } else {
          cur = curRange ? this._countInRange(u.id, p, curRange[0], curRange[1]) : this.data.submissions.filter((s) => s.userId === u.id && s.platform === p).length;
          prev = prevRange ? this._countInRange(u.id, p, prevRange[0], prevRange[1]) : 0;
        }
        cells[p] = { cur, prev };
        totalCur += cur;
        if (period !== 'total') totalPrev += prev;
      }
      return {
        userId: u.id,
        userName: u.name,
        groupName: u.groupId ? groups.get(u.groupId) || '未分组' : '未分组',
        cells,
        totalCur,
        totalPrev,
      };
    });
    cards.sort((a, b) => b.totalCur - a.totalCur);
    return { period, label, curLabel, prevLabel, generatedAt: nowEpoch(), ranges: { cur: curRange, prev: prevRange }, cards };
  }

  /** 用户最近 N 天的每日做题数量曲线（activity 口径，UTC+8） */
  userTrend(userId, days = 30) {
    const user = this.getUser(userId);
    const n = Number(days) === 180 ? 180 : 30;
    const map = {};
    const start = dayUtc8(nowEpoch() - (n - 1) * 86400);
    for (const c of this.data.dailyCounts) {
      if (c.userId === userId && c.metric === 'activity' && c.day >= start) {
        map[c.day] = (map[c.day] || 0) + c.count;
      }
    }
    const points = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = dayUtc8(nowEpoch() - i * 86400);
      points.push({ day: d, count: map[d] || 0 });
    }
    return { userId, userName: user.name, days: n, start, end: dayUtc8(nowEpoch()), points };
  }

  _platformActivityOnly(key) {
    return this._getStat(key, 'activity_only') === '1';
  }

  _platformSolvedLifetime(userId, platform) {
    const v = this._getStat(`${userId}:${platform}`, 'solved_count');
    if (v != null && !Number.isNaN(Number(v))) return Number(v);
    const seen = new Set();
    let n = 0;
    for (const s of this.data.submissions) {
      if (s.userId === userId && s.platform === platform && !seen.has(s.problem_key)) {
        seen.add(s.problem_key);
        n += 1;
      }
    }
    return n;
  }

  _loadDaily(userId, platform, metric, start, end) {
    const s = start || '0000-00-00';
    const e = end || '9999-99-99';
    return this.data.dailyCounts
      .filter((c) => c.userId === userId && c.platform === platform && c.metric === metric && c.day >= s && c.day <= e)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
      .map((c) => [c.day, c.count]);
  }

  _loadRecent(userId, platform, start, end, limitN) {
    const startTs = dayStartEpoch(start || '1970-01-01') ?? 0;
    const endTs = dayEndEpoch(end || '2999-12-31') ?? Math.floor(Number.MAX_SAFE_INTEGER / 2);
    return this.data.submissions
      .filter((s) => s.userId === userId && s.platform === platform && s.epoch_second >= startTs && s.epoch_second <= endTs)
      .sort((a, b) => b.epoch_second - a.epoch_second)
      .slice(0, limitN);
  }

  _difficultyForPlatform(userId, platform, start, end) {
    const explicit = this.data.difficultyStats.filter((x) => x.userId === userId && x.platform === platform);
    if (explicit.length > 0) {
      return explicit
        .slice()
        .sort((a, b) => a.order - b.order || (a.label < b.label ? -1 : 1))
        .map((x) => ({ platform: x.platform, label: x.label, count: x.count, order: x.order }));
    }
    const s = start || '0000-00-00';
    const e = end || '9999-99-99';
    const seen = new Set();
    const bucket = new Map();
    const rows = this.data.submissions
      .filter((x) => x.userId === userId && x.platform === platform)
      .sort((a, b) => a.epoch_second - b.epoch_second || (a.submission_id < b.submission_id ? -1 : a.submission_id > b.submission_id ? 1 : 0));
    for (const r of rows) {
      if (seen.has(r.problem_key)) continue;
      seen.add(r.problem_key);
      const day = dayUtc8(r.epoch_second);
      if (day < s || day > e) continue;
      if (r.difficulty == null) continue;
      const [order, label] = this._bucketLabel(platform, r.difficulty);
      const key = `${order}\0${label}`;
      bucket.set(key, (bucket.get(key) || 0) + 1);
    }
    return [...bucket.entries()]
      .map(([k, count]) => {
        const [order, label] = k.split('\0');
        return { platform, label, count, order: Number(order) };
      })
      .sort((a, b) => a.order - b.order);
  }

  _bucketLabel(platform, diff) {
    if (platform === 'codeforces' || platform === 'atcoder') {
      const x = Number(diff);
      if (!Number.isNaN(x)) {
        const lo = Math.floor((platform === 'atcoder' ? Math.max(0, x) : x) / 400) * 400;
        return [lo, `${lo}–${lo + 399}`];
      }
    }
    return [9999, String(diff)];
  }

  _streaks(map, end) {
    const days = Object.keys(map)
      .filter((dd) => map[dd] > 0 && !Number.isNaN(Date.parse(`${dd}T00:00:00Z`)))
      .sort();
    if (days.length === 0) return [0, 0];
    let best = 1;
    let cur = 1;
    for (let i = 1; i < days.length; i++) {
      if (dayDiff(days[i], days[i - 1]) === 1) {
        cur += 1;
        best = Math.max(best, cur);
      } else {
        cur = 1;
      }
    }
    const today = todayUtc8();
    let target = today;
    if (end) {
      const parsed = Date.parse(`${end}T00:00:00Z`);
      if (!Number.isNaN(parsed)) target = end < today ? end : today;
    }
    let current = 0;
    const d = new Date(`${target}T00:00:00Z`);
    for (;;) {
      const key = d.toISOString().slice(0, 10);
      if ((map[key] || 0) > 0) {
        current += 1;
        d.setUTCDate(d.getUTCDate() - 1);
      } else {
        break;
      }
    }
    return [best, current];
  }

  _statsForMap(map, solved, acceptedSubmissions, end) {
    let activeDays = 0;
    let peakDay = null;
    let peakCount = 0;
    for (const [dd, c] of Object.entries(map)) {
      if (c > 0) activeDays += 1;
      if (c > peakCount) {
        peakCount = c;
        peakDay = dd;
      }
    }
    const [longest, current] = this._streaks(map, end);
    return {
      solved,
      accepted_submissions: acceptedSubmissions,
      active_days: activeDays,
      longest_streak: longest,
      current_streak: current,
      peak_day: peakDay,
      peak_count: peakCount,
    };
  }

  snapshot(userId, platform, startDay, endDay, metric) {
    this.getUser(userId);
    const selected = platform ? [platform] : PLATFORMS;
    const combined = {};
    const warnings = [];
    let metricAvailable = false;
    const platforms = [];
    let recent = [];
    let difficulty = [];
    let solvedRange = 0;
    let acSubRange = 0;
    let careerSolved = 0;
    let careerAcSub = 0;
    const careerDaily = {};
    const statusesMap = new Map(this.statuses(userId).map((s) => [s.platform, s]));
    const name = (p) => ({ codeforces: 'Codeforces', atcoder: 'AtCoder', luogu: '洛谷', nowcoder: '牛客', qoj: 'QOJ', leetcode: 'LeetCode' }[p] || 'OJ');
    const label = (m) => ({ first_ac: '首次 AC', daily_unique: '当日去重 AC', accepted_submissions: 'AC 提交', activity: '平台活动' }[m] || m);

    for (const p of selected) {
      const activityOnly = this._platformActivityOnly(`${userId}:${p}`);
      const account = this.data.accounts[userId]?.[p]?.account || '';
      const status = statusesMap.get(p) || { platform: p, account, status: 'idle', message: '', last_attempt: null, last_success: null, cached_records: 0 };
      const daily = this._loadDaily(userId, p, metric, startDay, endDay);
      if (daily.length > 0) metricAvailable = true;
      for (const [day, count] of daily) combined[day] = (combined[day] || 0) + count;
      const first = this._loadDaily(userId, p, 'first_ac', startDay, endDay);
      solvedRange += first.reduce((acc, x) => acc + x[1], 0);
      const acs = this._loadDaily(userId, p, 'accepted_submissions', startDay, endDay);
      acSubRange += acs.reduce((acc, x) => acc + x[1], 0);
      const activeDays = daily.filter((x) => x[1] > 0).length;
      const solvedLifetime = this._platformSolvedLifetime(userId, p);
      const acLifetime = this.data.submissions.filter((s) => s.userId === userId && s.platform === p).length;
      careerSolved += solvedLifetime;
      careerAcSub += acLifetime;
      for (const [day, count] of this._loadDaily(userId, p, 'activity', null, null)) {
        careerDaily[day] = (careerDaily[day] || 0) + count;
      }
      platforms.push({
        platform: p,
        account,
        solved: solvedLifetime,
        accepted_submissions: acLifetime,
        active_days: activeDays,
        last_success: status.last_success ?? null,
        status: status.status,
        message: status.message,
        activity_only: activityOnly,
        cached_records: status.cached_records,
        last_attempt: status.last_attempt ?? null,
      });
      if (activityOnly && metric !== 'activity') {
        warnings.push(`${name(p)} 只有平台公开的日期活动计数，无法还原"${label(metric)}"逐日口径。`);
      }
      recent = recent.concat(this._loadRecent(userId, p, startDay, endDay, 20));
      difficulty = difficulty.concat(this._difficultyForPlatform(userId, p, startDay, endDay));
    }
    recent.sort((a, b) => b.epoch_second - a.epoch_second);
    recent = recent.slice(0, 20);
    const dailyVec = Object.entries(combined)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, count]) => ({ day, count }));
    return {
      stats: this._statsForMap(combined, solvedRange, acSubRange, endDay),
      career: this._statsForMap(careerDaily, careerSolved, careerAcSub, null),
      daily: dailyVec,
      platforms,
      difficulty,
      recent,
      metric_available: metricAvailable,
      warnings,
    };
  }

  dayDetail(day, userId, platform) {
    const start = dayStartEpoch(day);
    const end = dayEndEpoch(day);
    if (start === null || end === null) throw new Error('日期格式错误');
    const ps = platform ? [platform] : PLATFORMS;
    const items = [];
    const aggregates = [];
    for (const p of ps) {
      items.push(
        ...this.data.submissions
          .filter((s) => s.userId === userId && s.platform === p && s.epoch_second >= start && s.epoch_second <= end)
          .sort((a, b) => b.epoch_second - a.epoch_second)
      );
      aggregates.push(
        ...this.data.dailyAggregates
          .filter((a) => a.userId === userId && a.platform === p && a.day === day)
          .sort((a, b) => (a.metric < b.metric ? -1 : 1))
          .map((a) => ({ platform: a.platform, metric: a.metric, count: a.count, note: a.note }))
      );
    }
    items.sort((a, b) => b.epoch_second - a.epoch_second);
    return { day, items, aggregates };
  }

  // ---------------------------------------------------------------- settings

  scheduleSettings() {
    return { ...DEFAULT_SCHEDULE, ...(this.data.settings.schedule || {}) };
  }

  summarySettings() {
    const p = this.data.settings.summary?.defaultPeriod;
    return { defaultPeriod: ['week', 'month', 'year', 'total'].includes(p) ? p : 'week' };
  }

  setSummarySettings(summary) {
    const p = String(summary?.defaultPeriod || '');
    this.data.settings.summary = {
      defaultPeriod: ['week', 'month', 'year', 'total'].includes(p) ? p : 'week',
    };
    this.persist();
    return this.summarySettings();
  }

  setScheduleSettings(schedule) {
    const s = this.data.settings.schedule;
    const num = (v, min, max, fb) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) return fb;
      return Math.trunc(n);
    };
    s.enabled = !!schedule.enabled;
    s.startHour = num(schedule.startHour, 0, 23, DEFAULT_SCHEDULE.startHour);
    s.intervalHours = num(schedule.intervalHours, 1, 24, DEFAULT_SCHEDULE.intervalHours);
    s.userStaggerMinutes = num(schedule.userStaggerMinutes, 0, 720, DEFAULT_SCHEDULE.userStaggerMinutes);
    this.persist();
    return this.scheduleSettings();
  }
}