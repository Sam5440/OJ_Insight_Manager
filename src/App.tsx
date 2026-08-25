import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardCopy, Download, ExternalLink, FileSpreadsheet, Github, Menu, RefreshCw, ShieldCheck } from 'lucide-react';
import Sidebar from './components/Sidebar';
import MonitorBoard from './components/MonitorBoard';
import Heatmap from './components/Heatmap';
import StatCards from './components/StatCards';
import DayDrawer from './components/DayDrawer';
import { api, isTauri } from './lib/api';
import { exportHeatmap, exportSubmissionsCsv } from './lib/export';
import { currentYear, formatDateTime, today } from './lib/date';
import { METRICS, PLATFORM_META, PLATFORM_ORDER } from './lib/platforms';
import type { CardPeriod, DayDetail, GroupInfo, Metric, Platform, Snapshot, SummaryCards, SummaryItem, SyncStatus, TrendData, UserLite } from './types';

type Page = 'overview' | 'summary' | 'monitor' | 'export' | 'data' | 'settings' | 'about' | Platform;
type TimeKind = 'until' | 'year' | 'custom';

const HASH_PAGES: Page[] = ['overview', 'summary', 'monitor', 'export', 'data', 'settings', 'about', ...PLATFORM_ORDER];

function pageFromHash(): Page {
  const h = decodeURIComponent(window.location.hash.replace(/^#\/?/, '')).trim();
  if (!h) return 'overview';
  return (HASH_PAGES as string[]).includes(h) ? (h as Page) : 'overview';
}

function hashFromPage(p: Page): string {
  return p === 'overview' ? '#/' : `#/${p}`;
}

const emptySnapshot: Snapshot = {
  stats: { solved: 0, accepted_submissions: 0, active_days: 0, longest_streak: 0, current_streak: 0, peak_day: null, peak_count: 0 },
  career: { solved: 0, accepted_submissions: 0, active_days: 0, longest_streak: 0, current_streak: 0, peak_day: null, peak_count: 0 },
  daily: [], platforms: [], difficulty: [], recent: [], metric_available: true, warnings: [],
};

function yearRange(year: number) { return { start: `${year}-01-01`, end: `${year}-12-31` }; }
function scopeRange(kind: TimeKind, year: number, customStart: string, customEnd: string) {
  if (kind === 'year') return yearRange(year);
  if (kind === 'custom') return { start: customStart || '2010-01-01', end: customEnd || today() };
  const end = new Date(`${today()}T00:00:00Z`); const start = new Date(end); start.setUTCDate(start.getUTCDate() - 364);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export default function App() {
  const [timeKind, setTimeKind] = useState<TimeKind>('until');
  const [year, setYear] = useState(currentYear());
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState(today());
  const [metric, setMetric] = useState<Metric>('activity');
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string>('');
  const [statuses, setStatuses] = useState<SyncStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number; added: number; failed: number } | null>(null);
  const [toast, setToast] = useState<string>('');
  const [dayDetail, setDayDetail] = useState<DayDetail | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [page, setPage] = useState<Page>(pageFromHash);

  // TOOLS 区（导出/数据源/账号绑定/关于）仅管理员登录后可见
  useEffect(() => {
    if (isTauri) { setIsAdmin(true); return; }
    api.verifyAdmin().then((r) => setIsAdmin(r.admin)).catch(() => setIsAdmin(false));
  }, []);

  // hash 与页面状态保持同步（支持深链接与浏览器前进后退）
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const currentUser = users.find((u) => u.id === currentUserId) || null;
  const selectedPlatform: Platform | null = PLATFORM_ORDER.includes(page as Platform) ? page as Platform : null;
  const changePage = (p: Page) => {
    setPage(p);
    const want = hashFromPage(p);
    if (window.location.hash !== want) window.location.hash = want;
    setNavOpen(false);
  };
  const range = useMemo(() => scopeRange(timeKind, year, customStart, customEnd), [timeKind, year, customStart, customEnd]);
  const accountMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of statuses) map[s.platform] = s.account;
    return map;
  }, [statuses]);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 3200); };

  useEffect(() => {
    api.users().then(({ groups: g, users: us }) => {
      setGroups(g);
      setUsers(us);
      const saved = localStorage.getItem('oj_current_user');
      setCurrentUserId((prev) => prev || (saved && us.some((u) => u.id === saved) ? saved : us[0]?.id) || '');
    }).catch((e) => notify(String(e)));
  }, []);

  useEffect(() => { if (currentUserId) localStorage.setItem('oj_current_user', currentUserId); }, [currentUserId]);

  const loadStatuses = useCallback(async () => {
    if (!currentUserId) return;
    try { setStatuses(await api.getStatuses(currentUserId)); } catch (e) { notify(String(e)); }
  }, [currentUserId]);

  const loadSnapshot = useCallback(async () => {
    if (!currentUserId) return;
    setLoading(true);
    try {
      const data = await api.snapshot(currentUserId, selectedPlatform, range.start, range.end, metric);
      setSnapshot(data);
    } catch (e) { notify(String(e)); }
    finally { setLoading(false); }
  }, [currentUserId, selectedPlatform, range.start, range.end, metric]);

  useEffect(() => { loadStatuses(); }, [loadStatuses]);
  useEffect(() => { loadSnapshot(); }, [loadSnapshot]);

  const syncOne = async (platform: Platform, full = false) => {
    if (!currentUserId) return;
    setSyncing(platform);
    try {
      const result = await api.syncPlatform(currentUserId, platform, full);
      notify(`${PLATFORM_META[platform].name}: ${result.message}`);
      await Promise.all([loadSnapshot(), loadStatuses()]);
    } catch (e) { notify(`${PLATFORM_META[platform].name}: ${String(e)}`); await loadStatuses(); }
    finally { setSyncing(null); }
  };

  const syncAll = async () => {
    if (!currentUserId) return;
    setSyncing('all');
    try {
      let done=0,added=0,failed=0;setSyncProgress({done,total:PLATFORM_ORDER.length,added,failed});
      for (const platform of PLATFORM_ORDER) {
        if (accountMap[platform]?.trim()) {
          try { const result=await api.syncPlatform(currentUserId, platform); added+=result.inserted; } catch { failed+=1; }
        }
        done+=1;setSyncProgress({done,total:PLATFORM_ORDER.length,added,failed});await loadStatuses();
      }
      notify(`同步检查完成：${done}/${done} · 新增 ${added} · 失败 ${failed}`);
      await Promise.all([loadSnapshot(), loadStatuses()]);
    } catch (e) { notify(String(e)); }
    finally { setSyncing(null); window.setTimeout(()=>setSyncProgress(null),2500); }
  };

  const openDay = async (day: string) => {
    if (!currentUserId) return;
    setDayLoading(true); setDayDetail({ day, items: [], aggregates: [] });
    try { setDayDetail(await api.dayDetail(day, currentUserId, selectedPlatform)); }
    catch (e) { notify(String(e)); }
    finally { setDayLoading(false); }
  };

  return <div className="app-shell">
    <Sidebar page={page} onChange={changePage} users={users} groups={groups} currentUserId={currentUserId} onChangeUser={setCurrentUserId} open={navOpen} onClose={() => setNavOpen(false)} isAdmin={isAdmin} />
    <main className="main">
      <div className="mobile-topbar">
        <button className="icon-btn" onClick={() => setNavOpen(true)} aria-label="打开菜单"><Menu size={18} /></button>
        <strong>OJ Insight</strong>
      </div>
      {!isAdmin && (page === 'export' || page === 'data' || page === 'settings' || page === 'about') ? <AdminRequired /> :
      <>
      {page === 'summary' ? <SummaryPage /> :
       page === 'monitor' ? <MonitorPage /> :
       page === 'settings' ? <SettingsPage statuses={statuses} /> :
       page === 'data' ? <DataPage statuses={statuses} syncing={syncing} onSync={syncOne} onSyncAll={syncAll} onReload={async () => { await Promise.all([loadSnapshot(), loadStatuses()]); }} notify={notify} /> :
       page === 'export' ? <ExportPage accountMap={accountMap} metric={metric} userId={currentUserId} userName={currentUser?.name || ''} /> :
       page === 'about' ? <AboutPage /> :
       <DashboardPage platform={selectedPlatform} timeKind={timeKind} setTimeKind={setTimeKind} year={year} setYear={setYear} customStart={customStart} setCustomStart={setCustomStart} customEnd={customEnd} setCustomEnd={setCustomEnd} range={range} metric={metric} setMetric={setMetric} snapshot={snapshot} loading={loading} syncing={syncing} syncProgress={syncProgress} onSync={() => selectedPlatform ? syncOne(selectedPlatform) : syncAll()} onDay={openDay} onPlatform={(p)=>setPage(p)} userName={currentUser?.name || ''} />}
      </>}
    </main>
    <DayDrawer detail={dayDetail} loading={dayLoading} onClose={() => setDayDetail(null)} />
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function DashboardPage({ platform, timeKind, setTimeKind, year, setYear, customStart, setCustomStart, customEnd, setCustomEnd, range, metric, setMetric, snapshot, loading, syncing, syncProgress, onSync, onDay, onPlatform, userName }: {
  platform: Platform | null; timeKind: TimeKind; setTimeKind: (k: TimeKind) => void; year: number; setYear: (y: number) => void;
  customStart: string; setCustomStart: (v: string) => void; customEnd: string; setCustomEnd: (v: string) => void;
  range:{start:string;end:string}; metric: Metric; setMetric: (m: Metric) => void; snapshot: Snapshot; loading: boolean; syncing: string | null; syncProgress:{done:number;total:number;added:number;failed:number}|null; onSync: () => void; onDay: (day: string) => void; onPlatform:(p:Platform)=>void; userName: string;
}) {
  const title = platform ? PLATFORM_META[platform].name : '总览';
  const years = Array.from({ length: currentYear() - 2009 }, (_, i) => currentYear()-i);
  const label = timeKind==='until'?'至今（最近一年）': timeKind==='year'? String(year):`${customStart||'…'} — ${customEnd||'…'}`;
  const move=(delta:number)=>{if(timeKind==='year')setYear(Math.min(currentYear(),Math.max(2010,year+delta)));};
  return <>
    <header className="topbar"><div><small>{platform ? 'PLATFORM ANALYTICS' : 'UNIFIED ANALYTICS'}{userName ? ` · ${userName}` : ''}</small><h1>{title}</h1><p>{platform ? '查看单平台生涯、当前范围、活动图与难度数据' : '将多个 Online Judge 的训练轨迹汇总为一套统计。'}</p></div><button className="primary" onClick={onSync} disabled={!!syncing}><RefreshCw size={16} className={syncing ? 'spin' : ''} />{syncProgress?`${syncProgress.done}/${syncProgress.total}`:syncing?'同步中':'同步'}</button></header>
    {syncProgress&&<div className="sync-banner"><strong>正在同步 {syncProgress.done} / {syncProgress.total}</strong><span>新增 {syncProgress.added} 条 · {syncProgress.failed} 个平台失败</span><i><b style={{width:`${syncProgress.total?syncProgress.done/syncProgress.total*100:0}%`}}/></i></div>}
    <div className="toolbar">
      <label>时间范围
        <div className="range-controls">
          <div className="segmented seg-inline"><button className={timeKind==='until'?'active':''} onClick={()=>setTimeKind('until')}>至今</button><button className={timeKind==='year'?'active':''} onClick={()=>setTimeKind('year')}>按年</button><button className={timeKind==='custom'?'active':''} onClick={()=>setTimeKind('custom')}>自定义</button></div>
          {timeKind==='year'&&<div className="year-control"><button onClick={()=>move(-1)} disabled={year<=2010}><ChevronLeft size={15}/></button><div className="select-wrap"><select value={year} onChange={(e)=>setYear(Number(e.target.value))}>{years.map(y=><option value={y} key={y}>{y}</option>)}</select><ChevronDown size={14}/></div><button onClick={()=>move(1)} disabled={year>=currentYear()}><ChevronRight size={15}/></button></div>}
          {timeKind==='custom'&&<div className="custom-range"><input type="date" value={customStart} onChange={(e)=>setCustomStart(e.target.value)} /><span>—</span><input type="date" value={customEnd} onChange={(e)=>setCustomEnd(e.target.value)} /></div>}
        </div>
      </label>
      <label>Activity 口径<div className="select-wrap"><select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>{METRICS.map((m) => <option value={m.value} key={m.value}>{m.label}</option>)}</select><ChevronDown size={14} /></div></label>
      <span className="toolbar-note">日期统计基准：UTC+8</span>
    </div>
    {!snapshot.metric_available && <div className="warning"><AlertTriangle size={16} />当前平台没有该口径的逐日数据，已显示可用数据为空。</div>}
    {snapshot.warnings.map((w) => <div className="warning" key={w}><AlertTriangle size={16} />{w}</div>)}
    <div className="section-title"><small>CAREER · 不随时间范围变化</small><h2>{platform?`${title} 生涯统计`:'生涯统计'}</h2></div><StatCards stats={snapshot.career} />
    <div className="section-title"><small>CURRENT RANGE</small><h2>当前范围 · {label}</h2></div><StatCards stats={snapshot.stats} />
    <section className="panel heat-panel"><div className="panel-head"><div><small>ACTIVITY · {range.start} — {range.end}</small><h2>活动图 · {label}</h2></div>{loading && <span className="muted">读取中…</span>}</div><Heatmap startDay={range.start} endDay={range.end} daily={snapshot.daily} onDay={onDay} /></section>
    <div className="two-col">
      <section className="panel"><div className="panel-head"><div><small>PLATFORM SUMMARY</small><h2>{platform ? '本平台概况' : '平台概览'}</h2></div></div><PlatformTable rows={snapshot.platforms} onSelect={onPlatform} /></section>
      <section className="panel"><div className="panel-head"><div><small>DIFFICULTY PROFILE</small><h2>难度分布</h2></div></div><DifficultyProfile data={snapshot.difficulty} /></section>
    </div>
    <section className="panel"><div className="panel-head"><div><small>RECENT</small><h2>最近 AC</h2></div></div><RecentList items={snapshot.recent} /></section>
  </>;
}

function PlatformTable({ rows,onSelect }: { rows: Snapshot['platforms'];onSelect:(p:Platform)=>void }) {
  if (!rows.length) return <div className="empty">该用户还没有本地数据。管理员可在后台绑定账号并同步。</div>;
  return <div className="platform-table">{rows.map((x) => <button key={x.platform} onClick={()=>onSelect(x.platform)}><span className="oj-dot" style={{ background: PLATFORM_META[x.platform].accent }} /><strong>{PLATFORM_META[x.platform].name}</strong><span>{x.solved == null ? '暂无解题数' : `已解 ${x.solved.toLocaleString()} 题`}</span><small>缓存 {x.cached_records} 条 · {syncStatusLabel(x.status)}</small></button>)}</div>;
}

function DifficultyProfile({ data }: { data: Snapshot['difficulty'] }) {
  const available=PLATFORM_ORDER.filter(p=>data.some(x=>x.platform===p));const[first]=available;const[selected,setSelected]=useState<Platform|undefined>(first);
  useEffect(()=>{if(!selected||!available.includes(selected))setSelected(first);},[first,selected,available.join('|')]);
  const active = selected && available.includes(selected) ? selected : first;
  if (!data.length || !active) return <div className="empty">当前范围没有可靠的难度数据。</div>;
  const shown=data.filter(x=>x.platform===active);
  if (!shown.length) return <div className="empty">当前范围没有可靠的难度数据。</div>;
  const max=Math.max(...shown.map(x=>x.count),1);const total=shown.reduce((a,b)=>a+b.count,0);
  const peak=shown.reduce((a,b)=>a.count>b.count?a:b);
  let accumulated=0;const median=shown.find(x=>(accumulated+=x.count)>=Math.ceil(total/2))?.label||'暂无';
  const highest=[...shown].reverse().find(x=>x.count>0)?.label||'暂无';
  return <><div className="difficulty-tabs">{available.map(p=><button className={p===active?'active':''} onClick={()=>setSelected(p)} key={p}>{PLATFORM_META[p].short}</button>)}</div><div className="histogram">{shown.map((x,i)=><div key={`${x.platform}-${x.label}-${i}`} title={`${x.label}：${x.count}`}><strong>{x.count}</strong><i style={{height:`${Math.max(8,x.count/max*70)}%`}}/><span>{x.label}</span></div>)}</div><div className="difficulty-summary"><span>中位难度<strong>{median}</strong></span><span>峰值区间<strong>{peak.label}</strong></span><span>最高难度<strong>{highest}</strong></span><span>有难度题目<strong>{total}</strong></span></div></>;
}

function RecentList({ items }: { items: Snapshot['recent'] }) {
  if (!items.length) return <div className="empty">没有逐题记录。</div>;
  return <div className="recent-list">{items.map((x) => <a href={x.problem_url || '#'} target={x.problem_url ? '_blank' : undefined} rel="noreferrer" key={`${x.platform}-${x.submission_id}`}><span className="oj-badge" style={{ borderColor: PLATFORM_META[x.platform].accent, color: PLATFORM_META[x.platform].accent }}>{PLATFORM_META[x.platform].short}</span><div><strong>{x.problem_id || x.problem_name}</strong><span>{x.problem_name}</span></div><small>{new Date(x.epoch_second * 1000).toLocaleDateString('zh-CN')}{x.difficulty ? ` · ${x.difficulty}` : ''}</small></a>)}</div>;
}

// ---------------------------------------------------------------- 汇总界面

const PERIODS: Array<{ value: CardPeriod; label: string }> = [
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'year', label: '本年' },
  { value: 'total', label: '总计' },
];

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const wd = (d: string) => WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()];
// 短日期：同年省略年份
const fmtDay = (d: string, baseYear?: string) =>
  baseYear && d.slice(0, 4) === baseYear ? `${d.slice(5)} ${wd(d)}` : `${d} ${wd(d)}`;

function rangeLine(cards: SummaryCards): string {
  const y = cards.ranges.cur?.[0].slice(0, 4);
  if (!cards.ranges.cur) return '统计区间：全部历史 · 基准 UTC+8';
  const parts = [`${cards.curLabel} ${fmtDay(cards.ranges.cur[0], y)} ~ ${fmtDay(cards.ranges.cur[1], y)}`];
  if (cards.ranges.prev && cards.prevLabel) {
    parts.push(`${cards.prevLabel} ${fmtDay(cards.ranges.prev[0], y)} ~ ${fmtDay(cards.ranges.prev[1], y)}`);
  }
  return `${parts.join(' · ')} · 基准 UTC+8`;
}

/** 轻量 SVG 面积折线图（无第三方依赖） */
function TrendChart({ points }: { points: Array<{ day: string; count: number }> }) {
  const W = 620; const H = 170;
  const pad = { l: 34, r: 10, t: 12, b: 22 };
  const max = Math.max(1, ...points.map((p) => p.count));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const x = (i: number) => pad.l + (points.length <= 1 ? iw / 2 : (i * iw) / (points.length - 1));
  const y = (v: number) => pad.t + (1 - v / max) * ih;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.count).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + ih).toFixed(1)} Z`;
  const ticks = [0, Math.floor(points.length / 2), points.length - 1];
  const dotEvery = points.length > 60 ? 7 : points.length > 40 ? 3 : 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg">
      <line x1={pad.l} y1={pad.t + ih} x2={W - pad.r} y2={pad.t + ih} stroke="#232b34" />
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + ih} stroke="#232b34" />
      <text x={4} y={pad.t + 8} fill="#5f6a75" fontSize="9">{max}</text>
      <text x={4} y={pad.t + ih} fill="#5f6a75" fontSize="9">0</text>
      <path d={area} fill="rgba(88,210,129,.12)" />
      <path d={line} fill="none" stroke="#58d281" strokeWidth="1.6" />
      {points.map((p, i) => (
        i % dotEvery === 0 && (
          <circle key={p.day} cx={x(i)} cy={y(p.count)} r="2.4" fill="#58d281">
            <title>{`${p.day}（${wd(p.day)}）：${p.count}`}</title>
          </circle>
        )
      ))}
      {ticks.map((i) => (
        <text key={i} x={x(i)} y={H - 6} fill="#5f6a75" fontSize="9" textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>
          {points[i]?.day.slice(5)}
        </text>
      ))}
    </svg>
  );
}

function UserTrend({ userId }: { userId: string }) {
  const [days, setDays] = useState<30 | 180>(30);
  const [data, setData] = useState<TrendData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api.userTrend(userId, days)
      .then((d) => { if (alive) { setData(d); setError(''); } })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [userId, days]);
  const total = data?.points.reduce((a, p) => a + p.count, 0) ?? 0;
  return (
    <div className="trend-box">
      <div className="trend-head">
        <small>{data ? `${data.start} ~ ${data.end} · 合计 ${total.toLocaleString()} 次` : ''}</small>
        <div className="segmented seg-inline seg-mini">
          <button className={days === 30 ? 'active' : ''} onClick={() => setDays(30)}>30 天</button>
          <button className={days === 180 ? 'active' : ''} onClick={() => setDays(180)}>180 天</button>
        </div>
      </div>
      {error && <div className="admin-error"><AlertTriangle size={13} />{error}</div>}
      {data && <TrendChart points={data.points} />}
    </div>
  );
}

function SummaryPage() {
  const [items, setItems] = useState<SummaryItem[]>([]);
  const [cards, setCards] = useState<SummaryCards | null>(null);
  // 默认周期来自管理后台设置；加载完成前先不请求 cards，避免闪两次
  const [period, setPeriod] = useState<CardPeriod | null>(null);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  useEffect(() => {
    api.publicSettings().then((s) => setPeriod(s.summaryDefaultPeriod)).catch(() => setPeriod('week'));
  }, []);
  // silent=true 时为后台自动刷新：不转圈、不禁用按钮，只更新数据与时间戳
  const load = useCallback(async (silent = false) => {
    if (period == null) return;
    if (!silent) setLoading(true);
    try {
      const [rows, cardData] = await Promise.all([api.summary(300), api.cards(period)]);
      setItems(rows); setCards(cardData); setError(''); setUpdatedAt(Date.now());
    } catch (e) { setError(String(e)); }
    finally { if (!silent) setLoading(false); }
  }, [period]);
  useEffect(() => {
    if (period == null) return;
    load();
    const timer = setInterval(() => load(true), 60000);
    return () => clearInterval(timer);
  }, [load]);
  const userColor = (id: string) => {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h}, 55%, 62%)`;
  };
  return <>
    <header className="topbar">
      <div><small>ALL USERS · RECENT</small><h1>全站汇总</h1><p>全部用户做题卡片与最近提交记录，每分钟自动刷新{updatedAt ? ` · 上次更新 ${new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}。</p></div>
      <div className="topbar-actions">
        <div className="segmented seg-inline">{PERIODS.map((p) => <button key={p.value} className={period === p.value ? 'active' : ''} onClick={() => setPeriod(p.value)}>{p.label}</button>)}</div>
        <button className="primary" onClick={() => load()} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} />刷新</button>
      </div>
    </header>
    {error && <div className="warning"><AlertTriangle size={16} />{error}</div>}
    <section className="panel sum-cards-panel">
      <div className="panel-head"><div><small>PER-USER CARDS</small><h2>用户做题卡片{cards ? ` · ${cards.label}` : ''}</h2><p>{cards ? rangeLine(cards) : ''} · 统计唯一 AC 题数（同一题目多次 AC 仅计一次）· 点击卡片可展开最近 30 / 180 天做题曲线</p></div></div>
      {!cards?.cards.length && !loading && <div className="empty">还没有用户。管理员在后台创建用户并同步后即可查看。</div>}
      <div className="sum-cards">
        {cards?.cards.map((c) => {
          const expanded = expandedUser === c.userId;
          return (
            <article className={`sum-card${expanded ? ' expanded' : ''}`} key={c.userId}>
              <header className="sum-card-head" onClick={() => setExpandedUser(expanded ? null : c.userId)} title={expanded ? '收起曲线图' : '展开最近 30 / 180 天做题曲线'}>
                <span className="user-chip" style={{ borderColor: userColor(c.userId), color: userColor(c.userId) }}>{c.userName}</span>
                <small>{c.groupName}{expanded ? ' · 点击收起' : ' · 点击展开'}</small>
                <strong>{c.totalCur.toLocaleString()}<small>{period === 'total' ? ' 总计' : ` ${cards.curLabel}`}</small></strong>
              </header>
              <div className="sum-card-cols">
                <span />
                <span className="sum-pname" />
                <span className="sum-cur sum-colhead">{cards.curLabel}</span>
                <span className="sum-prev sum-colhead">{cards.prevLabel ?? ''}</span>
              </div>
              <div className="sum-card-rows">
              {PLATFORM_ORDER.map((p) => {
                const cell = c.cells[p];
                if (!cell) return null;
                const isActivity = cell.approx === true;
                return (
                  <div className={`sum-card-row${cell.cur > 0 || cell.prev > 0 ? '' : ' zero'}`} key={p}>
                    <span className="oj-dot" style={{ background: PLATFORM_META[p].accent }} />
                    <span className="sum-pname">{PLATFORM_META[p].name}{isActivity && <em className="sum-ast" title="该平台仅有活动量数据，无法按题目去重">＊</em>}</span>
                    <span className="sum-cur">{cell.cur.toLocaleString()}</span>
                    <span className="sum-prev">{period === 'total' ? '' : cell.prev.toLocaleString()}</span>
                  </div>
                );
              })}
              </div>
              {expanded && <UserTrend userId={c.userId} />}
            </article>
          );
        })}
      </div>
    </section>
    <section className="panel">
      <div className="panel-head"><div><small>RECENT SUBMISSIONS · {items.length}</small><h2>最近提交（全部用户）</h2></div></div>
      {!items.length && !loading && <div className="empty">还没有任何用户的提交记录。管理员在后台绑定账号并同步后即可查看。</div>}
      <div className="summary-list">
        {items.map((x) => (
          <a href={x.problem_url || '#'} target={x.problem_url ? '_blank' : undefined} rel="noreferrer" key={`${x.userId}-${x.platform}-${x.submission_id}`}>
            <small className="summary-time">{formatDateTime(x.epoch_second)}</small>
            <span className="user-chip" style={{ borderColor: userColor(x.userId), color: userColor(x.userId) }}>{x.userName}</span>
            <span className="oj-badge" style={{ borderColor: PLATFORM_META[x.platform].accent, color: PLATFORM_META[x.platform].accent }}>{PLATFORM_META[x.platform].short}</span>
            <div><strong>{x.problem_id || x.problem_name}</strong><span>{x.problem_name}</span></div>
            <small>{x.language}{x.difficulty ? ` · ${x.difficulty}` : ''}</small>
          </a>
        ))}
      </div>
    </section>
  </>;
}

function MonitorPage() {
  return <>
    <header className="topbar"><div><small>QUEUE MONITOR</small><h1>监控队列</h1><p>实时查看各平台同步队列与全部出站请求日志，每 2 秒自动刷新。</p></div></header>
    <MonitorBoard />
  </>;
}

function AdminRequired() {
  return <section className="panel admin-required">
    <ShieldCheck size={30} />
    <h2>该功能区仅对管理员开放</h2>
    <p>导出、数据源、账号绑定与关于页面需要登录管理员账号后使用。</p>
    <a className="primary" href="#/admin"><ShieldCheck size={15} />前往管理后台登录</a>
  </section>;
}

function syncStatusLabel(status?: string) {
  return ({ idle:'未同步', syncing:'同步中', ok:'成功', error:'失败', auth_required:'需要重新登录' } as Record<string,string>)[status || 'idle'] || status || '未同步';
}

// ---------------------------------------------------------------- 只读账号页

function SettingsPage({ statuses }: { statuses: SyncStatus[] }) {
  const copyJson = async () => {
    const payload: Array<{ platform: Platform; account: string }> = [];
    for (const s of statuses) if (s.account) payload.push({ platform: s.platform, account: s.account });
    try { await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)); alert('已复制当前用户绑定的账号 JSON。'); }
    catch (e) { alert(`复制失败：${String(e)}`); }
  };
  return <>
    <header className="topbar"><div><small>ACCOUNTS · READ ONLY</small><h1>账号绑定</h1><p>各用户的平台绑定由管理员在后台统一配置，这里仅展示当前用户的绑定情况。</p></div>
      <div className="topbar-actions">
        <button className="btn-ghost" onClick={copyJson}><ClipboardCopy size={15} />复制 JSON</button>
        <a className="btn-ghost" href="#/admin"><ShieldCheck size={15} />管理后台</a>
      </div>
    </header>
    <section className="panel account-panel">
      {PLATFORM_ORDER.map((p) => {
        const s = statuses.find((x) => x.platform === p);
        return <div className="account-row readonly" key={p}>
          <div className="account-name"><span className="oj-dot" style={{ background: PLATFORM_META[p].accent }} /><div><strong>{PLATFORM_META[p].name}</strong><small>{s?.account ? `已绑定 · ${s.account}` : '未绑定'}</small></div></div>
          <div className={`source-state ${s?.status || 'idle'}`}><div><strong>最近同步 · {syncStatusLabel(s?.status)}</strong><small>{s?.message || '尚未同步'} · 上次成功 {formatDateTime(s?.last_success || null)}</small></div></div>
          <span />
        </div>;
      })}
    </section>
  </>;
}

// ---------------------------------------------------------------- 数据源页

function DataPage({ statuses, syncing, onSync, onSyncAll, onReload, notify }: { statuses: SyncStatus[]; syncing: string | null; onSync: (p: Platform, full?: boolean) => void; onSyncAll: () => void; onReload: () => Promise<void>; notify: (s: string) => void }) {
  return <>
    <header className="topbar"><div><small>DATA SOURCES</small><h1>同步与本地数据</h1><p>缓存数据与本次同步结果彼此独立；单站失败不会删除旧数据。清空数据与账号绑定请前往管理后台。</p></div>
      <div className="topbar-actions">
        <a className="btn-ghost" href="#/admin"><ShieldCheck size={15} />管理后台</a>
        <button className="primary" onClick={() => { onSyncAll(); }} disabled={!!syncing}><RefreshCw size={16} className={syncing ? 'spin' : ''} />同步全部</button>
      </div>
    </header>
    <section className="panel source-list">
      {PLATFORM_ORDER.map((p) => {
        const s = statuses.find((x) => x.platform === p);
        const okState = s?.status === 'ok';
        return <article key={p}>
          <div className="source-id"><span className="oj-dot" style={{ background: PLATFORM_META[p].accent }} /><div><strong>{PLATFORM_META[p].name}</strong><small>{s?.account || '未绑定账号'} · 本地缓存 {s?.cached_records||0} 条</small></div></div>
          <div className={`source-state ${s?.status || 'idle'}`}>{okState ? <Check size={15} /> : s?.status === 'error' || s?.status === 'auth_required' ? <AlertTriangle size={15} /> : null}<div><strong>最近同步 · {syncStatusLabel(s?.status)}</strong><small>{s?.message || '尚未同步'} · 上次成功 {formatDateTime(s?.last_success || null)}</small></div></div>
          <div className="source-actions">
            <button onClick={() => onSync(p)} disabled={!!syncing}><RefreshCw size={14} />增量</button>
            <button onClick={() => onSync(p, true)} disabled={!!syncing}>重建</button>
            <button onClick={async () => { notify('已重新读取'); await onReload(); }}>刷新</button>
          </div>
        </article>;
      })}
    </section>
  </>;
}

// ---------------------------------------------------------------- 导出页

function ExportPage({ accountMap, metric, userId, userName }: { accountMap: Record<string, string>; metric: Metric; userId: string; userName: string }) {
  const [until,setUntil]=useState(true);
  const [start,setStart]=useState(`${currentYear()}-01-01`);
  const [end,setEnd]=useState(today());
  const [scope, setScope] = useState<'all' | Platform>('all');
  const [format, setFormat] = useState<'png' | 'svg'>('png');
  const [busy, setBusy] = useState(false);
  const [csvMsg, setCsvMsg] = useState('');
  const [csvUserScope, setCsvUserScope] = useState<'current' | 'all'>('current');
  const [csvTimeScope, setCsvTimeScope] = useState<'all' | 'custom'>('all');

  const run = async () => {
    setBusy(true);
    try {
      const r = until ? scopeRange('until', currentYear(), '', '') : { start, end };
      const snap = await api.snapshot(userId, scope === 'all' ? null : scope, r.start, r.end, metric);
      await exportHeatmap(
        `OJ Insight · ${scope === 'all' ? '所有 OJ' : PLATFORM_META[scope].name}${userName ? ` · ${userName}` : ''} · ${r.start} — ${r.end}`,
        snap.daily, Number(r.start.slice(0, 4)), Number(r.end.slice(0, 4)), format, r.start, r.end,
      );
    } catch (e) { setCsvMsg(`导出失败：${String(e)}`); }
    finally { setBusy(false); }
  };

  const runCsv = async () => {
    setBusy(true); setCsvMsg('');
    try {
      const rows = await api.records(csvUserScope === 'all' ? null : userId,
        csvTimeScope === 'custom' ? (start || null) : null,
        csvTimeScope === 'custom' ? (end || null) : null);
      rows.sort((a, b) => a.epoch_second - b.epoch_second);
      await exportSubmissionsCsv(rows, `OJ-Insight-records-${csvUserScope === 'all' ? 'all-users' : (userId || 'user')}.csv`);
      setCsvMsg(`已导出 ${rows.length} 条记录（按时间升序${csvTimeScope==='custom'?'，已按日期过滤':''}）。`);
    } catch (e) { setCsvMsg(`导出失败：${String(e)}`); }
    finally { setBusy(false); }
  };

  return <>
    <header className="topbar"><div><small>EXPORT STUDIO</small><h1>导出中心</h1><p>自定义任意时间段导出活动图与做题记录 CSV。</p></div></header>
    <div className="export-layout">
      <section className="panel export-form">
        <label>时间范围<div className="segmented"><button className={!until?'active':''} onClick={()=>setUntil(false)}>自定义区间</button><button className={until?'active':''} onClick={()=>setUntil(true)}>至今（最近一年）</button></div></label>
        {!until&&<label>起止日期<div className="range-row"><input type="date" value={start} onChange={(e)=>setStart(e.target.value)} /><span>—</span><input type="date" value={end} onChange={(e)=>setEnd(e.target.value)} /></div></label>}
        <label>平台<select value={scope} onChange={(e) => setScope(e.target.value as 'all' | Platform)}><option value="all">所有 OJ 合并</option>{PLATFORM_ORDER.map((p) => <option key={p} value={p} disabled={!accountMap[p]}>{PLATFORM_META[p].name}</option>)}</select></label>
        <label>格式<div className="segmented"><button className={format === 'png' ? 'active' : ''} onClick={() => setFormat('png')}>PNG</button><button className={format === 'svg' ? 'active' : ''} onClick={() => setFormat('svg')}>SVG</button></div></label>
        <button className="primary export-btn" onClick={run} disabled={busy || (!until && start > end)}><Download size={16} />{busy ? '生成中…' : '导出活动图'}</button>
      </section>
      <section className="panel export-preview">
        <div className="mock-export"><div><strong>OJ Insight · 活动图</strong><small>{until?'至今（最近一年）':`${start} — ${end}`}</small></div>
          <div className="mock-grid">{Array.from({ length: 160 }).map((_, i) => <i key={i} className={`level-${(i * 17 + i * i) % 5}`} />)}</div>
          <span>{scope === 'all' ? '所有 OJ' : PLATFORM_META[scope].name}{userName ? ` · ${userName}` : ''}</span></div>
      </section>
    </div>
    <section className="panel csv-panel">
      <div className="panel-head"><div><small>SUBMISSION RECORDS</small><h2>做题记录 CSV</h2><p>按时间顺序导出 AC 提交为 CSV 表格；支持筛选任意时间段和用户范围。</p></div></div>
      <div className="csv-filter">
        <label>用户范围<select value={csvUserScope} onChange={(e)=>setCsvUserScope(e.target.value as 'current'|'all')}><option value="current">当前用户{userName?`（${userName}）`:''}</option><option value="all">全部用户</option></select></label>
        <label>时间范围<div className="segmented"><button className={csvTimeScope==='all'?'active':''} onClick={()=>setCsvTimeScope('all')}>全部时间</button><button className={csvTimeScope==='custom'?'active':''} onClick={()=>setCsvTimeScope('custom')}>自定义区间</button></div></label>
        {csvTimeScope==='custom'&&<label className="csv-dates"><span>起止</span><div className="range-row"><input type="date" value={start} onChange={(e)=>setStart(e.target.value)} /><span>—</span><input type="date" value={end} onChange={(e)=>setEnd(e.target.value)} /></div></label>}
      </div>
      <div className="csv-actions">
        <button className="primary" onClick={runCsv} disabled={busy || !userId}><FileSpreadsheet size={16} />导出 CSV</button>
        {csvMsg && <span className="csv-msg">{csvMsg}</span>}
      </div>
    </section>
  </>;
}

function AboutPage(){
  const[update,setUpdate]=useState<Awaited<ReturnType<typeof api.checkForUpdates>>|null>(null);const[checking,setChecking]=useState(false);const[error,setError]=useState('');
  const check=async()=>{setChecking(true);setError('');try{setUpdate(await api.checkForUpdates());}catch(e){setError(String(e));}finally{setChecking(false);}};
  return <><header className="topbar"><div><small>ABOUT</small><h1>关于 OJ Insight</h1><p>统一整理与呈现多个 Online Judge 的训练数据。</p></div></header><section className="panel about-card"><div className="about-mark">OI</div><h2>OJ Insight</h2><p>版本 0.2.0 · Web 多用户版</p>{update?<div className={update.updateAvailable?'update-state available':'update-state'}><strong>{update.updateAvailable?`发现新版本 · v${update.latestVersion}`:'当前已是最新版本'}</strong>{update.updateAvailable&&<button onClick={()=>api.openExternal(update.releaseUrl)}>查看发布页 <ExternalLink size={14}/></button>}</div>:<button className="primary" onClick={check} disabled={checking}><RefreshCw size={15} className={checking?'spin':''}/>{checking?'正在检查…':'检查更新'}</button>}{error&&<div className="warning"><AlertTriangle size={15}/>{error}</div>}<div className="about-links"><button onClick={()=>api.openExternal('https://github.com/sam5440/OJ_Insight_Manager')}><Github size={16}/>GitHub 仓库<ExternalLink size={13}/></button><button onClick={()=>api.openExternal('https://github.com/sam5440/OJ_Insight_Manager/issues/new')}><AlertTriangle size={16}/>报告问题<ExternalLink size={13}/></button><a className="btn-ghost" href="#/admin" style={{justifyContent:'center'}}><ShieldCheck size={16}/>管理后台</a></div><small>多用户数据目录：server/data-root/</small></section></>;
}
