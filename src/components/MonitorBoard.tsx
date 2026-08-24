import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { PLATFORM_META, PLATFORM_ORDER } from '../lib/platforms';
import type { MonitorData } from '../types';

const fmtTime = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—';

export default function MonitorBoard() {
  const [data, setData] = useState<MonitorData | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setData(await api.monitor()); setError(''); }
    catch (e) { setError(String((e as Error)?.message || e)); }
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [load]);

  const stateChip = (state?: string) =>
    state === 'running' ? <em className="mq-chip running">运行中</em>
      : state === 'waiting' ? <em className="mq-chip waiting">排队中</em>
        : null;

  return (
    <>
      <section className="panel mq-board">
        <div className="panel-head"><div><small>SYNC QUEUE MONITOR</small><h2>监控队列</h2>
          <p>横轴为各做题平台；每列展示等待/运行中的用户与空闲用户的下次计划刷新。底层所有出站请求共用一个限流计时器。</p></div>
          <small className="muted">{data ? `刷新于 ${new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })} · 每 2 秒轮询` : '读取中…'}</small>
        </div>
        {error && <div className="admin-error"><AlertTriangle size={14} />{error}</div>}
        <div className="mq-grid">
          {PLATFORM_ORDER.map((p) => {
            const col = data?.platforms.find((x) => x.platform === p);
            const entries = (col?.entries || []).slice().sort((a, b) => (b.kind === 'active' ? 1 : 0) - (a.kind === 'active' ? 1 : 0));
            const rolling = entries.length > 6;
            return (
              <div className="mq-col" key={p}>
                <header>
                  <span className="oj-dot" style={{ background: PLATFORM_META[p].accent }} />
                  <strong>{PLATFORM_META[p].name}</strong>
                  <small>{entries.length} 人</small>
                </header>
                <div className={`mq-col-list${rolling ? ' rolling' : ''}`}>
                  <div className="mq-roll">
                    {(rolling ? [...entries, ...entries] : entries).map((e, i) => (
                      <div className={`mq-item${e.state ? ' active' : ''}`} key={`${e.userId}-${i}`}>
                        <div className="mq-id">
                          {stateChip(e.state)}
                          <strong>{e.userName}</strong>
                          <code>{e.userId.slice(0, 9)}</code>
                        </div>
                        <small>
                          {e.state
                            ? <>来源 {e.source === 'auto' ? '自动计划' : '手动'} · 排队 {fmtTime(e.enqueuedAt)}</>
                            : e.nextAt
                              ? <>下次刷新 {new Date(e.nextAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</>
                              : <>未排入自动计划</>}
                        </small>
                        <small>上次成功 {fmtTime(e.lastSuccessAt)}</small>
                      </div>
                    ))}
                    {!entries.length && <div className="mq-empty">暂无绑定用户</div>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><div><small>REQUEST LOG · 最近 200 条</small><h2>请求日志</h2>
          <p>所有经过共享限流计时器的平台请求（含状态码与耗时），最新在最上。</p></div></div>
        <div className="mq-logs">
          <table>
            <thead><tr><th>时间</th><th>平台</th><th>方法</th><th>路径</th><th>状态</th><th>耗时</th><th>错误</th></tr></thead>
            <tbody>
              {(data?.logs || []).map((l, i) => (
                <tr key={i} className={l.error || (l.status && l.status >= 400) ? 'bad' : ''}>
                  <td>{new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false })}.{String(l.ts % 1000).padStart(3, '0')}</td>
                  <td>{l.platform}</td>
                  <td>{l.method}</td>
                  <td className="mq-path">{l.path}</td>
                  <td>{l.status ?? '—'}</td>
                  <td>{l.ms != null ? `${l.ms}ms` : '—'}</td>
                  <td>{l.error || ''}</td>
                </tr>
              ))}
              {!data?.logs.length && <tr><td colSpan={7} className="mq-empty">暂无请求记录，触发一次同步后即可看到。</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}