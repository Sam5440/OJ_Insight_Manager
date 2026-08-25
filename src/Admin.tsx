import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowLeft, Check, KeyRound, Layers, LogOut, Plus,
  RefreshCw, Save, Settings2, ShieldCheck, Trash2, UsersRound,
} from 'lucide-react';
import MonitorBoard from './components/MonitorBoard';
import { adminApi } from './lib/api';
import { PLATFORM_META, PLATFORM_ORDER } from './lib/platforms';
import type { AdminOverview, Platform, ScheduleSettings } from './types';

type Tab = 'users' | 'groups' | 'schedule' | 'monitor' | 'security';

const errText = (e: unknown) => {
  const msg = (e as { message?: string })?.message;
  return String(msg || e);
};

export default function AdminPage() {
  const [hasToken, setHasToken] = useState(() => !!localStorage.getItem('oj_admin_token'));
  if (!hasToken) return <Login onOk={() => setHasToken(true)} />;
  return <Panel onLogout={() => setHasToken(false)} />;
}

// ------------------------------------------------------------------- login

function Login({ onOk }: { onOk: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError('');
    try { await adminApi.login(username, password); onOk(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="admin-shell">
      <div className="admin-login">
        <div className="admin-login-mark"><ShieldCheck size={22} /></div>
        <h1>OJ Insight 管理后台</h1>
        <p className="muted">登录后可管理用户组、用户与平台绑定、自动同步计划。</p>
        <label>用户名<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></label>
        <label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} autoComplete="current-password" /></label>
        {error && <div className="admin-error"><AlertTriangle size={14} />{error}</div>}
        <button className="primary" onClick={submit} disabled={busy || !password}>{busy ? '登录中…' : '登录'}</button>
        <small className="muted">默认账号 admin / qwe123，登录后可在「安全设置」修改密码。</small>
        <a href="#/" className="admin-back"><ArrowLeft size={13} />返回前台</a>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- panel

function Panel({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('users');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try {
      setError('');
      setOverview(await adminApi.overview());
    } catch (e) {
      const msg = errText(e);
      if (msg.includes('未登录')) onLogout();
      else setError(msg);
    }
  }, [onLogout]);
  useEffect(() => { reload(); }, [reload]);
  const groupName = (id: string | null) => overview?.groups.find((g) => g.id === id)?.name || '未分组';
  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div><small>OJ INSIGHT ADMIN</small><h1>管理后台</h1></div>
        <div className="topbar-actions">
          <a className="btn-ghost" href="#/"><ArrowLeft size={14} />返回前台</a>
          <button className="btn-ghost" onClick={async () => { await adminApi.logout(); onLogout(); }}><LogOut size={14} />退出登录</button>
        </div>
      </header>
      <nav className="admin-tabs">
        <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}><UsersRound size={15} />用户与绑定</button>
        <button className={tab === 'groups' ? 'active' : ''} onClick={() => setTab('groups')}><Layers size={15} />用户组</button>
        <button className={tab === 'schedule' ? 'active' : ''} onClick={() => setTab('schedule')}><Settings2 size={15} />同步计划</button>
        <button className={tab === 'monitor' ? 'active' : ''} onClick={() => setTab('monitor')}><Activity size={15} />监控队列</button>
        <button className={tab === 'security' ? 'active' : ''} onClick={() => setTab('security')}><KeyRound size={15} />安全设置</button>
      </nav>
      {error && <div className="warning"><AlertTriangle size={16} />{error}</div>}
      {!overview && !error && <div className="loading-block">读取中…</div>}
      {overview && tab === 'users' && <UsersTab overview={overview} reload={reload} />}
      {overview && tab === 'groups' && <GroupsTab overview={overview} reload={reload} />}
      {overview && tab === 'schedule' && <ScheduleTab settings={overview.settings} reload={reload} />}
      {tab === 'monitor' && <MonitorTab />}
      {overview && tab === 'security' && <SecurityTab username={overview.username} onLogout={onLogout} />}
      {overview && <p className="muted admin-foot">当前登录：{overview.username} · 用户 {overview.users.length} 个 / 分组 {overview.groups.length} 个</p>}
    </div>
  );
}

function groupNameOf(overview: AdminOverview, id: string | null) {
  return overview.groups.find((g) => g.id === id)?.name || '未分组';
}

// -------------------------------------------------------------------- users

function UsersTab({ overview, reload }: { overview: AdminOverview; reload: () => Promise<void> }) {
  const [selectedId, setSelectedId] = useState<string>(overview.users[0]?.id || '');
  const selected = overview.users.find((u) => u.id === selectedId) || overview.users[0] || null;
  return (
    <div className="admin-users">
      <section className="panel admin-user-list">
        <div className="panel-head"><div><small>USERS</small><h2>用户列表</h2></div></div>
        <NewUserForm overview={overview} reload={reload} />
        <div className="admin-user-items">
          {overview.users.map((u) => (
            <button key={u.id} className={selected?.id === u.id ? 'active' : ''} onClick={() => setSelectedId(u.id)}>
              <strong>{u.name}</strong>
              <small>{groupNameOf(overview, u.groupId)} · {Object.values(u.accounts || {}).filter((a) => a.account).length} 个平台</small>
            </button>
          ))}
          {!overview.users.length && <div className="empty">还没有用户，先在上方新建。</div>}
        </div>
      </section>
      {selected && <UserEditor key={selected.id} user={selected} overview={overview} reload={reload} />}
    </div>
  );
}

function NewUserForm({ overview, reload }: { overview: AdminOverview; reload: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await adminApi.upsertUser(null, name.trim(), groupId || null); setName(''); await reload(); }
    finally { setBusy(false); }
  };
  return (
    <div className="admin-inline-form">
      <input placeholder="新用户名称" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
        <option value="">未分组</option>
        {overview.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
      <button className="btn-ghost" onClick={add} disabled={busy || !name.trim()}><Plus size={14} />添加用户</button>
    </div>
  );
}

function UserEditor({ user, overview, reload }: { user: NonNullable<AdminOverview['users'][number]>; overview: AdminOverview; reload: () => Promise<void> }) {
  const [name, setName] = useState(user.name);
  const [groupId, setGroupId] = useState(user.groupId || '');
  const [bindings, setBindings] = useState<Record<string, { account: string; secret: string }>>(() => {
    const next: Record<string, { account: string; secret: string }> = {};
    for (const p of PLATFORM_ORDER) next[p] = { account: user.accounts?.[p]?.account || '', secret: user.accounts?.[p]?.secret || '' };
    return next;
  });
  const [jsonText, setJsonText] = useState(() => JSON.stringify(
    PLATFORM_ORDER
      .map((p) => ({ p, acc: user.accounts?.[p] }))
      .filter((x): x is { p: Platform; acc: { account: string; secret: string } } => !!x.acc?.account)
      .map(({ p, acc }) => ({ platform: p, account: acc.account, secret: acc.secret || '' })),
    null, 2,
  ));
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [syncing, setSyncing] = useState(false);

  // 某行的输入与服务器不一致时视为「未保存」，用于高亮提示。
  const profileDirty = name.trim() !== user.name || (groupId || null) !== (user.groupId ?? null);
  const isDirty = (p: Platform) =>
    (user.accounts?.[p]?.account || '') !== bindings[p].account ||
    (user.accounts?.[p]?.secret || '') !== bindings[p].secret;
  const hasDirty = profileDirty || PLATFORM_ORDER.some(isDirty);

  const say = (text: string, ok = true) => { setMsg({ text, ok }); window.setTimeout(() => setMsg(null), 3600); };

  const saveProfile = async () => {
    try { await adminApi.upsertUser(user.id, name.trim(), groupId || null); say('资料已保存'); await reload(); }
    catch (e) { say(errText(e), false); }
  };
  const saveBinding = async (platform: Platform) => {
    try {
      await adminApi.saveAccount(user.id, platform, bindings[platform].account, bindings[platform].secret);
      say(`${PLATFORM_META[platform].name} 绑定已保存`);
      // 只刷新概览数据；本地输入框状态保留，避免把其他行未保存的编辑冲掉。
      await reload();
    } catch (e) { say(errText(e), false); }
  };
  const saveAll = async () => {
    try {
      if (!name.trim()) throw new Error('用户名不能为空');
      // 先保存用户名/分组，再保存全部平台绑定——一个按钮搞定。
      if (profileDirty) await adminApi.upsertUser(user.id, name.trim(), groupId || null);
      for (const p of PLATFORM_ORDER) {
        await adminApi.saveAccount(user.id, p, bindings[p].account, bindings[p].secret);
      }
      say('用户资料与全部绑定已保存');
      await reload();
    } catch (e) { say(errText(e), false); }
  };
  const removeUser = async () => {
    if (!confirm(`删除用户「${user.name}」？其全部同步数据将被删除，不可恢复。`)) return;
    try { await adminApi.deleteUser(user.id); await reload(); }
    catch (e) { say(errText(e), false); }
  };
  const doSync = async (full: boolean) => {
    setSyncing(true);
    try {
      const r = await adminApi.sync(user.id, null, full);
      const fails = r.results.filter((x) => x.status !== 'ok').length;
      say(`同步完成：${r.results.length - fails} 成功 / ${fails} 失败`, fails === 0);
      await reload();
    } catch (e) { say(errText(e), false); }
    finally { setSyncing(false); }
  };
  const clearData = async () => {
    if (!confirm(`清空「${user.name}」的全部本地同步数据？账号绑定保留。`)) return;
    try { await adminApi.clearData(user.id, null); say('数据已清空'); await reload(); }
    catch (e) { say(errText(e), false); }
  };
  const importJson = async () => {
    try {
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed)) throw new Error('JSON 必须是数组');
      for (const item of parsed) {
        if (!item || !PLATFORM_ORDER.includes(item.platform)) throw new Error(`未知平台：${item?.platform}`);
        await adminApi.saveAccount(user.id, item.platform, String(item.account ?? ''), String(item.secret ?? ''));
      }
      say(`已导入 ${parsed.length} 条绑定`); await reload();
    } catch (e) { say(`导入失败：${errText(e)}`, false); }
  };

  return (
    <section className="panel admin-user-editor">
      <div className="panel-head"><div><small>USER PROFILE</small><h2>编辑用户 · {user.name}{profileDirty ? '（资料未保存）' : ''}</h2></div>
        <div className="topbar-actions">
          <button className="primary" onClick={saveAll} disabled={syncing}><Save size={14} />{hasDirty ? '保存全部 *' : '保存全部'}</button>
          <button className="btn-ghost" onClick={() => doSync(false)} disabled={syncing}><RefreshCw size={14} className={syncing ? 'spin' : ''} />增量同步</button>
          <button className="btn-ghost" onClick={() => doSync(true)} disabled={syncing}>重建全部</button>
        </div>
      </div>
      {msg && <div className={`account-json-msg${msg.ok ? '' : ' error'}`}>{msg.text}</div>}
      <div className="admin-profile-row">
        <label>用户名{profileDirty && <em className="dirty-mark">未保存</em>}<input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveProfile(); }} /></label>
        <label>所属分组<select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">未分组</option>
          {overview.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select></label>
        <div className="admin-profile-actions">
          <button className="btn-ghost" onClick={saveProfile}><Save size={14} />保存资料</button>
          <button className="btn-ghost danger" onClick={removeUser}><Trash2 size={14} />删除用户</button>
        </div>
      </div>
      <div className="admin-bindings">
        {PLATFORM_ORDER.map((p) => (
          <div className={`admin-binding-row${isDirty(p) ? ' dirty' : ''}`} key={p}>
            <span className="oj-dot" style={{ background: PLATFORM_META[p].accent }} />
            <strong>{PLATFORM_META[p].name}{isDirty(p) && <em className="dirty-mark">未保存</em>}</strong>
            <input value={bindings[p].account} placeholder={PLATFORM_META[p].accountHint}
              onChange={(e) => setBindings({ ...bindings, [p]: { ...bindings[p], account: e.target.value } })}
              onKeyDown={(e) => { if (e.key === 'Enter') saveBinding(p); }} />
            {p === 'qoj'
              ? <input type="password" value={bindings[p].secret} placeholder={PLATFORM_META[p].secretHint}
                  onChange={(e) => setBindings({ ...bindings, [p]: { ...bindings[p], secret: e.target.value } })} />
              : <span />}
            <button className="btn-ghost" onClick={() => saveBinding(p)}>保存</button>
          </div>
        ))}
      </div>
      <div className="admin-json">
        <div className="panel-head"><div><small>BULK BINDING</small><h3>批量绑定 JSON</h3></div>
          <div className="topbar-actions">
            <button className="btn-ghost" onClick={() => navigator.clipboard.writeText(jsonText).then(() => say('已复制'))}><Save size={13} />复制</button>
            <button className="btn-ghost" onClick={importJson}><Check size={13} />导入</button>
          </div>
        </div>
        <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false}
          placeholder='[{ "platform": "codeforces", "account": "handle", "secret": "" }]' />
      </div>
      <div className="danger-zone">
        <div><strong>清空该用户数据</strong><p>删除此用户所有平台的提交缓存、活动统计与同步状态；账号绑定保留。</p></div>
        <button onClick={clearData}><Trash2 size={15} />清空数据</button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------- groups

function GroupsTab({ overview, reload }: { overview: AdminOverview; reload: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const membersOf = (id: string) => overview.users.filter((u) => u.groupId === id);
  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await adminApi.upsertGroup(null, name.trim()); setName(''); await reload(); }
    catch (e) { alert(errText(e)); }
    finally { setBusy(false); }
  };
  return (
    <section className="panel admin-groups">
      <div className="panel-head"><div><small>GROUPS</small><h2>用户组管理</h2><p>用户组用于在前台侧边栏对用户分组展示。</p></div></div>
      <div className="admin-inline-form">
        <input placeholder="新分组名称" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn-ghost" onClick={add} disabled={busy || !name.trim()}><Plus size={14} />添加分组</button>
      </div>
      <div className="admin-group-list">
        {overview.groups.map((g) => (
          <div className="admin-group-row" key={g.id}>
            <input value={edits[g.id] ?? g.name} onChange={(e) => setEdits({ ...edits, [g.id]: e.target.value })} />
            <small>{membersOf(g.id).length} 个成员</small>
            <button className="btn-ghost" onClick={async () => { try { await adminApi.upsertGroup(g.id, edits[g.id] ?? g.name); await reload(); } catch (err) { alert(errText(err)); } }}>保存</button>
            <button className="btn-ghost danger" onClick={async () => {
              if (!confirm(`删除分组「${g.name}」？组内用户将移动到「未分组」。`)) return;
              try { await adminApi.deleteGroup(g.id); await reload(); } catch (err) { alert(errText(err)); }
            }}><Trash2 size={13} />删除</button>
          </div>
        ))}
        {!overview.groups.length && <div className="empty">暂无分组。</div>}
      </div>
    </section>
  );
}

// ----------------------------------------------------------------- schedule

function slotPreview(schedule: ScheduleSettings, userNames: string[], count = 4) {
  const { startHour, intervalHours } = schedule;
  const base = new Date(); base.setHours(startHour, 0, 0, 0);
  const cands: number[] = [];
  for (let d = -1; d <= 2; d++) {
    for (let k = 0; k * intervalHours < 48; k++) {
      const t = new Date(base);
      t.setDate(t.getDate() + d);
      t.setHours(startHour + k * intervalHours);
      cands.push(t.getTime());
    }
  }
  cands.sort((a, b) => a - b);
  const now = Date.now();
  return cands.filter((t) => t > now).slice(0, count).map((t) => ({ at: new Date(t), users: userNames.slice(0, 3) }));
}

const PERIOD_OPTIONS: Array<{ value: 'week' | 'month' | 'year' | 'total'; label: string }> = [
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'year', label: '本年' },
  { value: 'total', label: '总计' },
];

function ScheduleTab({ settings, reload }: { settings: AdminOverview['settings']; reload: () => Promise<void> }) {
  const [form, setForm] = useState<ScheduleSettings>(settings.schedule);
  const [defaultPeriod, setDefaultPeriod] = useState(settings.summary?.defaultPeriod || 'week');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const preview = useMemo(
    () => slotPreview(form, ['用户A', '用户B', '用户C']),
    [form],
  );
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      await adminApi.saveSettings({ schedule: form, summary: { defaultPeriod } });
      setMsg('已保存：同步计划立即生效，全站汇总默认周期已更新。');
      await reload();
    }
    catch (e) { setMsg(errText(e)); }
    finally { setBusy(false); }
  };
  return (
    <section className="panel admin-schedule">
      <div className="panel-head"><div><small>AUTO SYNC SCHEDULE</small><h2>自动同步计划</h2><p>每天从指定小时开始，每隔固定小时数刷新一次（包含起始时刻）；同一时刻多个用户按顺序错开执行。</p></div></div>
      <div className="admin-form-grid">
        <label className="toggle-row">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          <span>启用自动同步{form.enabled ? '（已启用）' : '（已停用）'}</span>
        </label>
        <label>每日开始小时（0–23）<input type="number" min={0} max={23} value={form.startHour} onChange={(e) => setForm({ ...form, startHour: Number(e.target.value) })} /></label>
        <label>刷新间隔（小时，1–24）<input type="number" min={1} max={24} value={form.intervalHours} onChange={(e) => setForm({ ...form, intervalHours: Number(e.target.value) })} /></label>
        <label>用户间错开分钟（0–720）<input type="number" min={0} max={720} value={form.userStaggerMinutes} onChange={(e) => setForm({ ...form, userStaggerMinutes: Number(e.target.value) })} /></label>
      </div>
      <div className="admin-preview">
        <small>下次执行预览（服务器本地时间）：</small>
        <ul>
          {preview.map(({ at }, i) => (
            <li key={i}>
              <strong>{at.toLocaleString('zh-CN', { hour12: false })}</strong>
              {form.enabled && (
                <span>
                  {' '}→ 用户A {new Date(at.getTime()).toLocaleTimeString('zh-CN', { hour12: false })}
                  {form.userStaggerMinutes > 0 && <> · 用户B +{form.userStaggerMinutes}min · 用户C +{form.userStaggerMinutes * 2}min…</>}
                </span>
              )}
            </li>
          ))}
        </ul>
        <small className="muted">默认配置即需求值：从 0 点开始、每 4 小时（00:00 / 04:00 / …）、每个用户间隔 10 分钟。以上示例用户名仅作演示。</small>
      </div>
      <div className="panel-head" style={{ marginTop: 18 }}><div><small>SUMMARY DEFAULT PERIOD</small><h2>全站汇总默认周期</h2><p>前台「全站汇总」页面首次进入与刷新时默认选中的统计周期。</p></div></div>
      <div className="segmented seg-inline" style={{ width: 'max-content' }}>
        {PERIOD_OPTIONS.map((p) => (
          <button key={p.value} className={defaultPeriod === p.value ? 'active' : ''} onClick={() => setDefaultPeriod(p.value)}>{p.label}</button>
        ))}
      </div>
      <div className="csv-actions">
        <button className="primary" onClick={save} disabled={busy}><Save size={15} />{busy ? '保存中…' : '保存全部设置'}</button>
        {msg && <span className={`account-json-msg${msg.includes('已保存') ? '' : ' error'}`}>{msg}</span>}
      </div>
    </section>
  );
}

// ----------------------------------------------------------------- security

function SecurityTab({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [repeat, setRepeat] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const change = async () => {
    if (newPassword !== repeat) { setMsg({ text: '两次输入的新密码不一致', ok: false }); return; }
    try {
      await adminApi.changePassword(oldPassword, newPassword);
      setMsg({ text: '密码已修改', ok: true });
      setOld(''); setNew(''); setRepeat('');
    } catch (e) { setMsg({ text: errText(e), ok: false }); }
  };
  return (
    <section className="panel admin-security">
      <div className="panel-head"><div><small>SECURITY</small><h2>安全设置</h2></div></div>
      <p className="muted">当前管理员：<strong>{username}</strong></p>
      <div className="admin-form-grid">
        <label>原密码<input type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} /></label>
        <label>新密码（至少 6 位）<input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} /></label>
        <label>确认新密码<input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} /></label>
      </div>
      {msg && <div className={`account-json-msg${msg.ok ? '' : ' error'}`}>{msg.text}</div>}
      <div className="csv-actions">
        <button className="primary" onClick={change} disabled={!oldPassword || newPassword.length < 6}>修改密码</button>
        <button className="btn-ghost" onClick={async () => { await adminApi.logout(); onLogout(); }}><LogOut size={14} />退出登录</button>
      </div>
    </section>
  );
}


// ---------------------------------------------------------------- 监控队列

function MonitorTab() {
  return <MonitorBoard />;
}
