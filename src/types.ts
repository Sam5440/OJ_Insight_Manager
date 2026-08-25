export type Platform = 'codeforces' | 'atcoder' | 'luogu' | 'nowcoder' | 'qoj' | 'leetcode';
export type Metric = 'first_ac' | 'daily_unique' | 'accepted_submissions' | 'activity';

export interface AccountConfig {
  platform: Platform;
  account: string;
  secret: string;
}

export interface SyncStatus {
  platform: Platform;
  account: string;
  status: 'idle' | 'syncing' | 'ok' | 'error' | 'auth_required';
  message: string;
  last_attempt: number | null;
  last_success: number | null;
  cached_records: number;
}

export interface PlatformSummary {
  platform: Platform;
  account: string;
  solved: number | null;
  accepted_submissions: number;
  active_days: number;
  last_success: number | null;
  status: string;
  message: string;
  activity_only: boolean;
  cached_records: number;
  last_attempt: number | null;
}

export interface DailyPoint {
  day: string;
  count: number;
}

export interface DifficultyBucket {
  platform: Platform;
  label: string;
  count: number;
  order: number;
}

export interface SubmissionItem {
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

export interface SnapshotStats {
  solved: number;
  accepted_submissions: number;
  active_days: number;
  longest_streak: number;
  current_streak: number;
  peak_day: string | null;
  peak_count: number;
}

export interface Snapshot {
  stats: SnapshotStats;
  career: SnapshotStats;
  daily: DailyPoint[];
  platforms: PlatformSummary[];
  difficulty: DifficultyBucket[];
  recent: SubmissionItem[];
  metric_available: boolean;
  warnings: string[];
}

export interface UpdateInfo { currentVersion: string; latestVersion: string; releaseUrl: string; updateAvailable: boolean; }

export interface DayDetail {
  day: string;
  items: SubmissionItem[];
  aggregates: Array<{ platform: Platform; metric: string; count: number; note: string }>;
}

export interface SyncResult {
  platform: Platform;
  inserted: number;
  updated: number;
  message: string;
  status: string;
}

export interface GroupInfo { id: string; name: string }
export interface UserLite { id: string; name: string; groupId: string | null }

export interface SummaryItem extends SubmissionItem {
  userId: string;
  userName: string;
}

export interface ScheduleSettings {
  enabled: boolean;
  startHour: number;
  intervalHours: number;
  userStaggerMinutes: number;
}

export interface AdminUser {
  id: string;
  name: string;
  groupId: string | null;
  createdAt: number;
  accounts: Partial<Record<Platform, { account: string; secret: string }>>;
}

export interface AdminOverview {
  username: string;
  groups: GroupInfo[];
  users: AdminUser[];
  settings: { schedule: ScheduleSettings; summary: { defaultPeriod: CardPeriod } };
}

export interface RecordItem extends SubmissionItem { userName: string }

export type CardPeriod = 'week' | 'month' | 'year' | 'total';

export interface SummaryCards {
  period: CardPeriod;
  label: string;
  curLabel: string;
  prevLabel: string | null;
  generatedAt: number;
  ranges: { cur: [string, string] | null; prev: [string, string] | null };
  cards: Array<{
    userId: string;
    userName: string;
    groupName: string;
    cells: Record<Platform, { cur: number; prev: number; approx?: boolean }>;
    totalCur: number;
    totalPrev: number;
  }>;
}

export interface TrendData {
  userId: string;
  userName: string;
  days: number;
  start: string;
  end: string;
  points: Array<{ day: string; count: number }>;
}

export interface GateHostStat {
  platform: string;
  total: number;
  running: number;
  queued: number;
  lastAt: number | null;
  nextAt: number | null;
}

export interface MonitorEntry {
  key?: string;
  kind?: 'active' | 'idle';
  userId: string;
  userName: string;
  platform: Platform;
  state?: 'waiting' | 'running';
  source?: string;
  enqueuedAt?: number;
  startedAt?: number | null;
  nextAt?: number | null;
  lastSuccessAt: number | null;
}

export interface RequestLogLine {
  ts: number;
  platform: string;
  method: string;
  path: string;
  status: number | null;
  ms: number | null;
  error: string | null;
}

export interface MonitorData {
  generatedAt: number;
  schedule: ScheduleSettings;
  hosts: GateHostStat[];
  platforms: Array<{ platform: Platform; entries: MonitorEntry[] }>;
  logs: RequestLogLine[];
}
