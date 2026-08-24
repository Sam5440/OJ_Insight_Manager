import { Activity, BarChart3, CircleHelp, Database, Download, LayoutDashboard, Settings2, ShieldCheck, Users } from 'lucide-react';
import { PLATFORM_META, PLATFORM_ORDER } from '../lib/platforms';
import type { GroupInfo, Platform, UserLite } from '../types';

type Page = 'overview' | 'summary' | 'monitor' | 'export' | 'data' | 'settings' | 'about' | Platform;

export default function Sidebar({ page, onChange, users, groups, currentUserId, onChangeUser, open, onClose }: {
  page: Page;
  onChange: (page: Page) => void;
  users: UserLite[];
  groups: GroupInfo[];
  currentUserId: string;
  onChangeUser: (id: string) => void;
  open?: boolean;
  onClose?: () => void;
}) {
  const groupName = (id: string | null) => groups.find((g) => g.id === id)?.name || '未分组';
  const ordered = [...groups.map((g) => ({ id: g.id as string | null, name: g.name })), { id: null, name: '未分组' }];
  const go = (p: Page) => { onChange(p); onClose?.(); };
  const pick = (id: string) => { onChangeUser(id); onClose?.(); };
  return (
    <>
      {open && <button className="sidebar-backdrop" onClick={onClose} aria-label="关闭导航" />}
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="brand" onClick={() => go('overview')}>
          <div className="brand-mark"><span /><span /><span /><span /></div>
          <div><strong>OJ Insight</strong><small>Competitive Programming Analytics</small></div>
        </div>
        <div className="user-switcher">
          <Users size={14} />
          <select value={currentUserId} onChange={(e) => pick(e.target.value)}>
            {ordered.map((g) => {
              const members = users.filter((u) => (u.groupId ?? null) === g.id);
              if (!members.length) return null;
              return (
                <optgroup key={g.name} label={g.name}>
                  {members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </optgroup>
              );
            })}
          </select>
        </div>
        <nav>
          <button className={page === 'overview' ? 'active' : ''} onClick={() => go('overview')}><LayoutDashboard size={17} />总览</button>
          <button className={page === 'summary' ? 'active' : ''} onClick={() => go('summary')}><Users size={17} />全站汇总</button>
          <button className={page === 'monitor' ? 'active' : ''} onClick={() => go('monitor')}><Activity size={17} />监控队列</button>
          <div className="nav-title">PLATFORMS</div>
          {PLATFORM_ORDER.map((p) => (
            <button key={p} className={page === p ? 'active' : ''} onClick={() => go(p)}>
              <span className="oj-dot" style={{ background: PLATFORM_META[p].accent }} />{PLATFORM_META[p].name}
            </button>
          ))}
          <div className="nav-title">TOOLS</div>
          <button className={page === 'export' ? 'active' : ''} onClick={() => go('export')}><Download size={17} />导出</button>
          <button className={page === 'data' ? 'active' : ''} onClick={() => go('data')}><Database size={17} />数据源</button>
          <button className={page === 'settings' ? 'active' : ''} onClick={() => go('settings')}><Settings2 size={17} />账号绑定</button>
          <button className={page === 'about' ? 'active' : ''} onClick={() => go('about')}><CircleHelp size={17} />关于</button>
        </nav>
        <div className="sidebar-foot">
          <a href="#/admin" onClick={onClose}><ShieldCheck size={13} /> 管理后台</a>
          <span><BarChart3 size={14} /> Local-first · SQLite</span>
        </div>
      </aside>
    </>
  );
}
