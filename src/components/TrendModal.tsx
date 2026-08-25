import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CalendarDays, X } from 'lucide-react';
import { api } from '../lib/api';
import { PLATFORM_META, PLATFORM_ORDER } from '../lib/platforms';
import type { DayDetail, Platform, TrendData, TrendPoint } from '../types';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const wd = (d: string) => WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()];

export default function TrendModal({ userId, userName, onClose }: { userId: string; userName: string; onClose: () => void }) {
  const [days, setDays] = useState<30 | 180>(30);
  const [data, setData] = useState<TrendData | null>(null);
  const [error, setError] = useState('');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [detail, setDetail] = useState<DayDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null); setSelectedDay(null); setError('');
    api.userTrend(userId, days)
      .then((d) => {
        if (!alive) return;
        setData(d);
        const lastActive = [...d.points].reverse().find((p) => p.count > 0) || d.points[d.points.length - 1];
        setSelectedDay(lastActive?.day ?? null);
      })
      .catch((e) => { if (alive) setError(String((e as Error)?.message || e)); });
    return () => { alive = false; };
  }, [userId, days]);

  useEffect(() => {
    if (!selectedDay) { setDetail(null); return; }
    let alive = true;
    setDetailLoading(true);
    api.dayDetail(selectedDay, userId, null)
      .then((d) => { if (alive) setDetail(d); })
      .catch(() => { if (alive) setDetail(null); })
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [selectedDay, userId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 默认选中：数据里最后一个有记录的日子（在 trend 加载回调中设置）

  return (
    <div className="trend-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="trend-card">
        <button className="icon-btn trend-close" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        <header className="trend-card-head">
          <small>PROBLEM SOLVING TREND</small>
          <h3>{userName} · 做题曲线</h3>
          <p className="muted">悬停查看当日各平台去重题数 · 点击某天在右侧查看当日全部 AC 明细（UTC+8）</p>
          <div className="segmented seg-inline seg-mini trend-toggle">
            <button className={days === 30 ? 'active' : ''} onClick={() => setDays(30)}>30 天</button>
            <button className={days === 180 ? 'active' : ''} onClick={() => setDays(180)}>180 天</button>
          </div>
        </header>
        {error && <div className="admin-error"><AlertTriangle size={14} />{error}</div>}
        <div className="trend-grid">
          <div className="trend-left">
            {data && <TrendChart
              points={data.points}
              hoverIdx={hoverIdx}
              selectedDay={selectedDay}
              onHover={setHoverIdx}
              onSelect={(day) => setSelectedDay(day)}
            />}
            {!data && !error && <div className="loading-block">读取中…</div>}
          </div>
          <aside className="trend-right">
            <div className="trend-day-head">
              <CalendarDays size={14} />
              <strong>{selectedDay ? `${selectedDay} ${wd(selectedDay)}` : '选择日期'}</strong>
              <span className="muted">{detail ? `AC ${detail.items.length} 条` : ''}</span>
            </div>
            {detail && detail.aggregates.map((a, i) => (
              <div className="aggregate-note" key={`agg-${i}`}>
                <strong>{PLATFORM_META[a.platform as Platform]?.name || a.platform}</strong>
                <span>{a.count} · {a.note}</span>
              </div>
            ))}
            <div className="submission-list">
              {detailLoading && <div className="loading-block">读取当日记录…</div>}
              {detail && detail.items.length === 0 && !detailLoading && (!detail || detail.aggregates.length === 0) && (
                <div className="empty">这一天没有可显示的记录。</div>
              )}
              {detail && detail.items.map((it) => (
                <article key={`${it.platform}-${it.submission_id}`}>
                  <a
                    className="oj-badge"
                    style={{ borderColor: PLATFORM_META[it.platform].accent, color: PLATFORM_META[it.platform].accent }}
                    href={it.problem_url || undefined}
                    target={it.problem_url ? '_blank' : undefined}
                    rel="noreferrer"
                    onClick={(e) => { if (!it.problem_url) e.preventDefault(); }}
                  >
                    {PLATFORM_META[it.platform].short}
                  </a>
                  <div className="submission-main">
                    <strong title={it.problem_name}>{it.problem_name || it.problem_id}</strong>
                    <small>
                      {new Date(it.epoch_second * 1000).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      {it.difficulty ? ` · ${it.difficulty}` : ''}{it.language ? ` · ${it.language}` : ''}
                    </small>
                  </div>
                </article>
              ))}
              {detail && detail.items.length === 0 && detail.aggregates.length > 0 && (
                <div className="empty">该平台当日仅有活动量统计，无逐题明细。</div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function TrendChart({ points, hoverIdx, selectedDay, onHover, onSelect }: {
  points: TrendPoint[];
  hoverIdx: number | null;
  selectedDay: string | null;
  onHover: (i: number | null) => void;
  onSelect: (day: string) => void;
}) {
  const W = 640; const H = 210;
  const pad = { l: 34, r: 12, t: 14, b: 24 };
  const max = Math.max(1, ...points.map((p) => p.count));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const step = iw / Math.max(1, points.length);
  const x = (i: number) => pad.l + step * (i + 0.5);
  const y = (v: number) => pad.t + (1 - v / max) * ih;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.count).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + ih).toFixed(1)} Z`;
  const ticks = [0, Math.floor(points.length / 2), points.length - 1];
  const dotEvery = points.length > 90 ? 5 : points.length > 40 ? 2 : 1;
  const hp = hoverIdx != null ? points[hoverIdx] : null;
  return (
    <div className="chart-wrap" onMouseLeave={() => onHover(null)}>
      {hp && (
        <div
          className="chart-tip"
          style={{ left: `${Math.min(78, Math.max(0, ((hoverIdx! + 0.5) / points.length) * 100))}%` }}
        >
          <div className="tip-date">{hp.day} {wd(hp.day)}</div>
          <div className="tip-total">合计 {hp.count} 题</div>
          {PLATFORM_ORDER.filter((p) => (hp.by[p]?.n || 0) > 0).map((p) => (
            <div className="tip-row" key={p}>
              <span className="oj-dot" style={{ background: PLATFORM_META[p].accent }} />
              {PLATFORM_META[p].name}
              <b>{hp.by[p]!.n}</b>
              {hp.by[p]!.approx && <i title="活动量口径">＊</i>}
            </div>
          ))}
          {hp.count === 0 && <div className="tip-row muted">当日无记录</div>}
          <div className="tip-hint">点击查看当日明细 →</div>
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg">
        <line x1={pad.l} y1={pad.t + ih} x2={W - pad.r} y2={pad.t + ih} stroke="#232b34" />
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + ih} stroke="#232b34" />
        {[0.5, 1].map((f) => (
          <line key={f} x1={pad.l} y1={pad.t + f * ih} x2={W - pad.r} y2={pad.t + f * ih} stroke="#161c23" strokeDasharray="3 4" />
        ))}
        <text x={4} y={pad.t + 9} fill="#5f6a75" fontSize="9">{max}</text>
        <text x={4} y={pad.t + ih / 2} fill="#5f6a75" fontSize="9">{Math.round(max / 2)}</text>
        <text x={4} y={pad.t + ih} fill="#5f6a75" fontSize="9">0</text>
        <path d={area} fill="rgba(88,210,129,.13)" />
        <path d={line} fill="none" stroke="#58d281" strokeWidth="1.7" />
        {/* 每天的热区：悬停显示 tooltip、点击选中 */}
        {points.map((p, i) => (
          <rect
            key={p.day}
            x={pad.l + step * i} y={pad.t} width={step} height={ih}
            fill={p.day === selectedDay ? 'rgba(88,210,129,.08)' : 'transparent'}
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(p.day)}
            style={{ cursor: 'pointer' }}
          />
        ))}
        {points.map((p, i) =>
          i % dotEvery === 0 || p.day === selectedDay ? (
            <circle key={p.day} cx={x(i)} cy={y(p.count)} r={p.day === selectedDay ? 3.6 : 2.3}
              fill={p.day === selectedDay ? '#8ff0ae' : '#58d281'} style={{ pointerEvents: 'none' }} />
          ) : null
        )}
        {hoverIdx != null && (
          <line x1={x(hoverIdx)} y1={pad.t} x2={x(hoverIdx)} y2={pad.t + ih} stroke="#58d281" strokeWidth="0.8" opacity=".55" style={{ pointerEvents: 'none' }} />
        )}
        {ticks.map((i) => (
          <text key={i} x={Math.min(W - 20, Math.max(pad.l, x(i)))} y={H - 7} fill="#5f6a75" fontSize="9"
            textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>
            {points[i]?.day.slice(5)}
          </text>
        ))}
      </svg>
    </div>
  );
}