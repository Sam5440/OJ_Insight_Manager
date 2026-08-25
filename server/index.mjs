import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from './store.mjs';
import { Auth, bearerToken } from './auth.mjs';
import { Scheduler } from './scheduler.mjs';
import { Monitor, monitor, monitorSnapshot } from './monitor.mjs';
import { fetchPlatform, SyncError } from './sync.mjs';
import { gate } from './gate.mjs';
import { PLATFORMS } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(flag('--port', process.env.PORT || '4310'));
const STATIC_DIR = path.resolve(ROOT, flag('--static', 'dist'));
const OPEN_BROWSER = args.includes('--open') || process.env.OJ_OPEN === '1';

const store = new Store({ rootDir: path.join(__dirname, 'data-root') });
const auth = new Auth(store);

async function syncOne(userId, platform, full, tag = '') {
  if (!PLATFORMS.includes(platform)) throw new Error('不支持的平台');
  const user = store.getUser(userId);
  let account;
  try {
    account = store.getAccount(userId, platform);
  } catch {
    throw new Error(`${user.name} 的 ${platform} 尚未绑定账号`);
  }
  monitor.enter(userId, user.name, platform, tag || 'manual');
  try {
    monitor.markRunning(userId, platform);
    const cursor = full ? 0 : store.getCursor(userId, platform);
    store.markSyncing(userId, platform, account.account);
    store.logEvent(platform, full ? 'full rebuild started' : 'incremental sync started', account.secret, tag);
    try {
      const remote = await fetchPlatform(platform, account, full, cursor);
      const { inserted, updated } = store.applyRemote(remote, userId);
      store.logEvent(platform, `sync completed inserted=${inserted} updated=${updated}`, account.secret, tag);
      return {
        platform,
        inserted,
        updated,
        message: `同步成功 · 新增 ${inserted}，更新 ${updated}`,
        status: 'ok',
      };
    } catch (e) {
      const err = e instanceof SyncError ? e : new SyncError('error', String(e && e.message ? e.message : e));
      store.markFailed(userId, platform, account.account, err.status, err.message);
      store.logEvent(platform, `sync failed status=${err.status} message=${err.message}`, account.secret, tag);
      throw err;
    }
  } finally {
    monitor.exit(userId, platform);
  }
}

const scheduler = new Scheduler(store, (userId, platform, full, tag) => syncOne(userId, platform, full, tag));
scheduler.start();

const NO_STORE = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

const ok = (res, data) => {
  res.writeHead(200, NO_STORE);
  res.end(JSON.stringify(data === undefined ? null : data));
};

const fail = (res, status, message) => {
  res.writeHead(status, NO_STORE);
  res.end(JSON.stringify({ error: message }));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('请求体不是有效 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function versionTuple(v) {
  const parts = String(v)
    .split('.')
    .map((x) => parseInt(x.split('-')[0], 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

async function checkUpdates(res) {
  try {
    const resp = await fetch('https://api.github.com/repos/sam5440/OJ_Insight_Manager/releases/latest', {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!resp.ok) throw new Error(`GitHub Releases：HTTP ${resp.status}`);
    const value = await resp.json();
    const latest = String(value.tag_name || '').replace(/^v/, '');
    if (!latest) throw new Error('GitHub Releases 没有可用版本');
    const currentT = versionTuple('0.2.0');
    const latestT = versionTuple(latest);
    const updateAvailable =
      latestT[0] > currentT[0] ||
      (latestT[0] === currentT[0] && latestT[1] > currentT[1]) ||
      (latestT[0] === currentT[0] && latestT[1] === currentT[1] && latestT[2] > currentT[2]);
    return ok(res, {
      currentVersion: '0.2.0',
      latestVersion: latest,
      releaseUrl: value.html_url || 'https://github.com/sam5440/OJ_Insight_Manager/releases',
      updateAvailable,
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

// ------------------------------------------------------------------ routing

async function handlePublic(req, res, urlPath, query, body) {
  switch (`${req.method} ${urlPath}`) {
    case 'GET /api/health':
      return ok(res, { ok: true, scheduler: { running: true, enabled: store.scheduleSettings().enabled } });
    case 'GET /api/storage_info':
      return ok(res, store.storageInfo());
    case 'GET /api/users':
      return ok(res, store.publicUsers());
    case 'GET /api/statuses': {
      try {
        return ok(res, store.statuses(String(query.get('userId') || '')));
      } catch (e) {
        return fail(res, 400, e.message);
      }
    }
    case 'POST /api/snapshot': {
      try {
        return ok(res, store.snapshot(String(body.userId || ''), body.platform || null, body.startDay || null, body.endDay || null, body.metric));
      } catch (e) {
        return fail(res, 400, e.message);
      }
    }
    case 'POST /api/day_detail': {
      try {
        return ok(res, store.dayDetail(body.day, String(body.userId || ''), body.platform || null));
      } catch (e) {
        return fail(res, 400, e.message);
      }
    }
    case 'GET /api/records': {
      try {
        return ok(res, store.recordsWithUser(query.get('userId') || null, query.get('start') || null, query.get('end') || null));
      } catch (e) {
        return fail(res, 400, e.message);
      }
    }
    case 'GET /api/summary':
      return ok(res, store.summary(Math.min(Number(query.get('limit')) || 200, 1000)));
    case 'GET /api/public_settings':
      return ok(res, { summaryDefaultPeriod: store.summarySettings().defaultPeriod });
    case 'GET /api/cards':
      try {
        return ok(res, store.cards(String(query.get('period') || 'week')));
      } catch (e) {
        return fail(res, 400, e.message);
      }
    case 'GET /api/user_trend':
      try {
        return ok(res, store.userTrend(String(query.get('userId') || ''), Number(query.get('days')) || 30));
      } catch (e) {
        return fail(res, 400, e.message);
      }
    case 'GET /api/monitor':
      return ok(res, monitorSnapshot(store, gate, scheduler));
    case 'POST /api/sync': {
      try {
        return ok(res, await syncOne(String(body.userId || ''), String(body.platform || ''), !!body.full));
      } catch (e) {
        return fail(res, 500, e.message);
      }
    }
    case 'GET /api/check_updates':
      return checkUpdates(res);
    case 'POST /api/open_external': {
      const allowed = [
        'https://github.com/sam5440/OJ_Insight_Manager',
        'https://github.com/sam5440/OJ_Insight_Manager/issues',
        'https://github.com/sam5440/OJ_Insight_Manager/releases',
      ];
      if (!allowed.some((prefix) => String(body.url || '').startsWith(prefix))) {
        return fail(res, 400, '不允许打开该链接');
      }
      return ok(res, null);
    }
    default:
      return fail(res, 404, `未知接口：${req.method} ${urlPath}`);
  }
}

async function handleAdmin(req, res, urlPath, query, body) {
  // 登录接口无需 token
  if (req.method === 'POST' && urlPath === '/api/admin/login') {
    const token = auth.login(String(body.username || ''), String(body.password || ''));
    if (!token) return fail(res, 401, '用户名或密码错误');
    return ok(res, { token, username: body.username });
  }

  const token = bearerToken(req);
  if (!auth.verify(token)) return fail(res, 401, '未登录或登录已过期');

  switch (`${req.method} ${urlPath}`) {
    case 'POST /api/admin/logout':
      auth.logout(token);
      return ok(res, null);
    case 'GET /api/admin/verify':
      return ok(res, { username: store.data.auth.username });
    case 'GET /api/admin/overview':
      return ok(res, {
        username: store.data.auth.username,
        groups: store.listGroups(),
        users: store.listUsers().map((u) => store.adminUser(u)),
        settings: { schedule: store.scheduleSettings(), summary: store.summarySettings() },
      });
    default:
      break;
  }

  try {
    let m;
    if (req.method === 'PUT' && urlPath === '/api/admin/groups') {
      store.upsertGroup(body);
      return ok(res, store.listGroups());
    }
    if ((m = /^\/api\/admin\/groups\/([\w-]+)$/.exec(urlPath)) && req.method === 'DELETE') {
      store.deleteGroup(m[1]);
      return ok(res, store.listGroups());
    }
    if (req.method === 'PUT' && urlPath === '/api/admin/users') {
      store.upsertUser(body);
      return ok(res, store.listUsers().map((u) => store.adminUser(u)));
    }
    if ((m = /^\/api\/admin\/users\/([\w-]+)$/.exec(urlPath)) && req.method === 'DELETE') {
      store.deleteUser(m[1]);
      return ok(res, store.listUsers().map((u) => store.adminUser(u)));
    }
    if ((m = /^\/api\/admin\/users\/([\w-]+)\/accounts$/.exec(urlPath)) && req.method === 'PUT') {
      store.setUserAccount(m[1], body.platform, body.account, body.secret);
      return ok(res, store.adminUser(store.getUser(m[1])));
    }
    if (req.method === 'POST' && urlPath === '/api/admin/clear') {
      if (body.platform) store.clearPlatform(String(body.userId), String(body.platform));
      else store.clearAll(String(body.userId));
      return ok(res, null);
    }
    if (req.method === 'PUT' && urlPath === '/api/admin/settings') {
      const out = {};
      if (body.schedule) out.schedule = store.setScheduleSettings(body.schedule);
      if (body.summary) out.summary = store.setSummarySettings(body.summary);
      return ok(res, out);
    }
    if (req.method === 'POST' && urlPath === '/api/admin/password') {
      store.changePassword(String(body.oldPassword || ''), String(body.newPassword || ''));
      return ok(res, null);
    }
    if (req.method === 'POST' && urlPath === '/api/admin/sync') {
      const userId = String(body.userId || '');
      const user = store.getUser(userId);
      const results = [];
      const targets = body.platform ? [String(body.platform)] : PLATFORMS;
      for (const p of targets) {
        try {
          results.push(await syncOne(userId, p, !!body.full, 'manual'));
        } catch (e) {
          results.push({ platform: p, inserted: 0, updated: 0, message: e.message, status: 'error' });
        }
      }
      return ok(res, { user: user.name, results });
    }
  } catch (e) {
    return fail(res, 400, e.message);
  }
  return fail(res, 404, `未知管理接口：${req.method} ${urlPath}`);
}

// ------------------------------------------------------------------- static

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(STATIC_DIR, rel));
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    const isHtml = filePath.endsWith('.html');
    // index.html 不缓存（保证发新版后立即生效）；带 hash 的静态资源可长缓存
    const cacheControl = isHtml ? 'no-cache' : 'public, max-age=31536000, immutable';
    if (!err && stat.isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'cache-control': cacheControl });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    const index = path.join(STATIC_DIR, 'index.html');
    fs.stat(index, (err2) => {
      if (err2) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found. 请先运行 npm run build 生成前端产物。');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      fs.createReadStream(index).pipe(res);
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const urlPath = url.pathname;
  try {
    if (urlPath.startsWith('/api/admin/') || urlPath === '/api/admin') {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      return await handleAdmin(req, res, urlPath, url.searchParams, body);
    }
    if (urlPath.startsWith('/api/')) {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      return await handlePublic(req, res, urlPath, url.searchParams, body);
    }
    return serveStatic(req, res, urlPath);
  } catch (e) {
    return fail(res, 400, e.message);
  }
});

server.listen(PORT, () => {
  const staticDir = fs.existsSync(path.join(STATIC_DIR, 'index.html')) ? STATIC_DIR : null;
  const target = `http://localhost:${PORT}`;
  console.log('OJ Insight Web 服务已启动：');
  console.log(`  URL        ${target}`);
  console.log(`  管理后台   ${target}/#/admin（默认账号 admin / qwe123）`);
  console.log(`  静态目录   ${staticDir || STATIC_DIR + '（尚未构建，请运行 npm run build）'}`);
  console.log(`  数据目录   ${store.dataDir}`);
  const s = store.scheduleSettings();
  console.log(`  自动同步   ${s.enabled ? `每天 ${String(s.startHour).padStart(2, '0')}:00 起、每 ${s.intervalHours} 小时、用户间隔 ${s.userStaggerMinutes} 分钟` : '已停用'}`);
  if (OPEN_BROWSER) {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', target], { detached: true, stdio: 'ignore' });
    } else {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(cmd, [target], { detached: true, stdio: 'ignore' });
    }
  }
});

process.on('SIGINT', () => {
  scheduler.stop();
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  scheduler.stop();
  server.close(() => process.exit(0));
});