import { sleep, nowEpoch, host, dayUtc8 } from './util.mjs';
import { gate } from './gate.mjs';

export class SyncError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const syncError = (message) => new SyncError('error', message);
const syncAuth = (message) => new SyncError('auth_required', message);

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36 OJ-Insight/0.2',
  accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
};

function withCookie(headers, cookie) {
  const c = (cookie || '').trim();
  if (!c) return headers;
  const normalized = c.includes('=') ? c : `UOJSESSID=${c}`;
  return { ...headers, cookie: normalized };
}

function withReferer(headers, referer) {
  return { ...headers, referer };
}

async function getText(url, headers) {
  await gate.acquire(url);
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(url, { headers, redirect: 'follow' });
  } catch (e) {
    gate.release(url, { path: safePath(url), status: null, ms: Date.now() - t0, error: String(e.message || e) });
    throw syncError(`网络请求失败：${e.message}`);
  }
  const text = await resp.text();
  gate.release(url, { path: safePath(url), status: resp.status, ms: Date.now() - t0 });
  if (!resp.ok) {
    throw syncError(`上游 HTTP ${resp.status}：${host(url)}`);
  }
  return text;
}

function safePath(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch {
    return '';
  }
}

async function getJson(url, headers) {
  const text = await getText(url, headers);
  try {
    return JSON.parse(text);
  } catch {
    throw syncError(`上游返回的不是有效 JSON：${host(url)}`);
  }
}

async function postJson(url, headers, body) {
  await gate.acquire(url);
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'follow',
    });
  } catch (e) {
    gate.release(url, { method: 'POST', path: safePath(url), status: null, ms: Date.now() - t0, error: String(e.message || e) });
    throw syncError(`网络请求失败：${e.message}`);
  }
  const text = await resp.text();
  gate.release(url, { method: 'POST', path: safePath(url), status: resp.status, ms: Date.now() - t0 });
  if (!resp.ok) {
    const hint = resp.status === 403 ? '（可能触发 Cloudflare / 登录校验）' : '';
    const operation = body.operationName || 'GraphQL';
    const detail = text.replace(/[\x00-\x1f]/g, '').slice(0, 240);
    throw syncError(`${operation} HTTP ${resp.status}：${host(url)}${hint} · ${detail}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw syncError(`上游返回的不是有效 JSON：${host(url)}`);
  }
  if (Array.isArray(value.errors)) {
    const message = value.errors.map((e) => e.message).filter(Boolean).join('; ');
    if (message) throw syncError(`${host(url)} GraphQL：${message}`);
  }
  return value;
}

function submission(platform, submissionId, problemKey, problemId, problemName, problemUrl, epochSecond, language, difficulty) {
  return { platform, submissionId, problemKey, problemId, problemName, problemUrl, epochSecond, language, difficulty };
}

function remote(platform, account, submissions, aggregates, solvedCount, difficulty, activityOnly, notes, cursorEpoch, replaceSubmissions, replaceAggregates) {
  return {
    platform, account, submissions, aggregates, solvedCount, difficulty, activityOnly, notes, cursorEpoch, replaceSubmissions, replaceAggregates,
  };
}

export async function fetchPlatform(platform, account, full, cursor) {
  switch (platform) {
    case 'atcoder': return fetchAtCoder(account, full, cursor);
    case 'codeforces': return fetchCodeforces(account, full, cursor);
    case 'luogu': return fetchLuogu(account, full, cursor);
    case 'nowcoder': return fetchNowcoder(account, full, cursor);
    case 'qoj': return fetchQoj(account, full, cursor);
    case 'leetcode': return fetchLeetcode(account, full, cursor);
    default: throw syncError('不支持的平台');
  }
}

// ---------------------------------------------------------------------------
// Codeforces
// ---------------------------------------------------------------------------

async function fetchCodeforces(account, full, cursor) {
  const handle = account.account.trim();
  if (!handle) throw syncError('Codeforces Handle 为空');
  let from = 1;
  const pageSize = 10000;
  const out = [];
  let maxSeen = cursor;
  const stopCursor = full ? 0 : Math.max(0, cursor - 5);
  let page = 0;
  for (;;) {
    page += 1;
    if (page > 200) throw syncError('Codeforces 分页过多，已中止');
    const url = `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=${from}&count=${pageSize}`;
    const payload = await getJson(url, BROWSER_HEADERS);
    if (payload.status !== 'OK') throw syncError(payload.comment || 'Codeforces API 返回失败');
    const rows = payload.result;
    if (!Array.isArray(rows) || rows.length === 0) break;
    let reachedOld = false;
    for (const s of rows) {
      const ts = s.creationTimeSeconds || 0;
      maxSeen = Math.max(maxSeen, ts);
      if (!full && ts <= stopCursor) {
        reachedOld = true;
        continue;
      }
      if (s.verdict !== 'OK') continue;
      const problem = s.problem || {};
      const contestId = problem.contestId ?? s.contestId ?? null;
      const index = problem.index || '';
      const name = problem.name || index;
      const key = contestId != null ? `${contestId}:${index}` : `${name}:${index}`;
      const pid = contestId != null ? `${contestId}${index}` : key;
      const purl = contestId != null
        ? (contestId >= 100000
            ? `https://codeforces.com/gym/${contestId}/problem/${index}`
            : `https://codeforces.com/contest/${contestId}/problem/${index}`)
        : 'https://codeforces.com/problemset';
      const rating = problem.rating ?? null;
      out.push(submission('codeforces', String(s.id ?? ts), key, pid, name, purl, ts, s.programmingLanguage || '', rating != null ? String(rating) : null));
    }
    if (reachedOld || rows.length < pageSize) break;
    from += rows.length;
    await sleep(2100);
  }
  return remote('codeforces', handle, out, [], null, [], false, ['Codeforces 官方 user.status API'], Math.max(maxSeen, nowEpoch() - 2), full, full);
}

// ---------------------------------------------------------------------------
// AtCoder
// ---------------------------------------------------------------------------

async function fetchAtCoder(account, full, cursor) {
  const user = account.account.trim();
  if (!user) throw syncError('AtCoder 用户名为空');
  await getText(`https://atcoder.jp/users/${encodeURIComponent(user)}`, BROWSER_HEADERS);
  let problems = [];
  try {
    problems = await getJson('https://kenkoooo.com/atcoder/resources/problems.json', BROWSER_HEADERS);
  } catch { /* optional resource */ }
  const titles = new Map();
  if (Array.isArray(problems)) {
    for (const p of problems) {
      if (p.id) titles.set(p.id, [p.title || p.id, p.contest_id || '']);
    }
  }
  let models = {};
  try {
    models = await getJson('https://kenkoooo.com/atcoder/resources/problem-models.json', BROWSER_HEADERS);
  } catch { /* optional resource */ }
  let fromSecond = full ? 0 : Math.max(0, cursor - 2);
  const out = [];
  let maxSeen = cursor;
  for (let i = 0; i < 5000; i++) {
    const url = `https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions?user=${encodeURIComponent(user)}&from_second=${fromSecond}`;
    const rows = await getJson(url, BROWSER_HEADERS);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const s of rows) {
      const ts = s.epoch_second || 0;
      maxSeen = Math.max(maxSeen, ts);
      if (s.result !== 'AC') continue;
      const problemId = s.problem_id || '';
      const contestId = s.contest_id || '';
      const entry = titles.get(problemId) || [problemId, contestId];
      const cid = contestId || entry[1];
      const diff = models[problemId]?.difficulty;
      const difficulty = diff != null ? String(Math.round(diff)) : null;
      out.push(
        submission(
          'atcoder',
          String(s.id ?? ts),
          problemId,
          problemId,
          entry[0],
          cid ? `https://atcoder.jp/contests/${cid}/tasks/${problemId}` : 'https://atcoder.jp/contests/',
          ts,
          s.language || '',
          difficulty
        )
      );
    }
    if (rows.length < 500) break;
    const last = rows[rows.length - 1]?.epoch_second;
    if (last == null) throw syncError('AtCoder 分页缺少时间字段');
    const next = last + 1;
    if (next <= fromSecond) throw syncError('AtCoder 分页游标未前进');
    fromSecond = next;
    await sleep(1100);
  }
  return remote('atcoder', user, out, [], null, [], false, ['AtCoder Problems submission API'], Math.max(maxSeen, nowEpoch() - 2), full, full);
}

// ---------------------------------------------------------------------------
// 洛谷
// ---------------------------------------------------------------------------

function luoguBaseHeaders() {
  return {
    'user-agent': 'OJ-Insight/0.2 local analytics',
    accept: 'application/json,text/plain,*/*',
    referer: 'https://www.luogu.com.cn/',
  };
}

function luoguLentilleHeaders() {
  return { ...luoguBaseHeaders(), 'x-lentille-request': 'content-only' };
}

function parsePayload(text) {
  try {
    return JSON.parse(text);
  } catch { /* fall through */ }
  const fallback = /decodeURIComponent\(\("((?:[^"\\]|\\.)*)"\)\)/i.exec(text);
  try {
    if (fallback && fallback[1]) {
      const decoded = decodeURIComponent(JSON.parse(`"${fallback[1]}"`));
      return JSON.parse(decoded);
    }
  } catch { /* fall through */ }
  const plain = text.replace(/[\n\r\t]/g, ' ');
  const lower = plain.toLowerCase();
  if (
    plain.includes('访问') ||
    plain.includes('频繁') ||
    plain.includes('验证码') ||
    lower.includes('captcha') ||
    lower.includes('forbidden') ||
    lower.includes('challenge')
  ) {
    throw syncError('洛谷触发访问限制或验证页面');
  }
  throw syncError('洛谷返回格式异常');
}

async function resolveUid(input) {
  if (/^\d+$/.test(input)) return [input, input];
  const url = `https://www.luogu.com.cn/api/user/search?keyword=${encodeURIComponent(input)}`;
  let payload;
  try {
    payload = await getJson(url, luoguBaseHeaders());
  } catch (e) {
    throw syncError(`洛谷用户名搜索失败；可直接填写数字 UID。${e.message}`);
  }
  const candidates = payload.users || payload.data?.users || payload.currentData?.users || payload.result;
  if (!Array.isArray(candidates) || candidates.length === 0) throw syncError('未找到洛谷用户；可改填数字 UID');
  let chosen = candidates[0];
  for (const u of candidates) {
    const name = u.name || u.username || '';
    if (name.toLowerCase() === String(input).toLowerCase()) {
      chosen = u;
      break;
    }
  }
  if (!chosen) throw syncError('未找到洛谷用户');
  const uid = chosen.uid ?? chosen.id;
  if (uid == null) throw syncError('洛谷用户名解析失败；可改填数字 UID');
  const name = chosen.name || chosen.username || input;
  return [String(uid), name];
}

function normalizeDay(raw) {
  const s = String(raw).trim().replace('/', '-');
  const parts = s.split('-');
  if (parts.length !== 3) return '';
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function fetchLuogu(account) {
  const input = account.account.trim();
  if (!input) throw syncError('洛谷用户名/UID 为空');
  const [uid, display] = await resolveUid(input);
  const profileText = await getText(
    `https://www.luogu.com.cn/user/${uid}`,
    luoguLentilleHeaders()
  );
  const payload = parsePayload(profileText);
  const data = payload.data || payload.currentData || payload;
  const daily = data.dailyCounts;
  if (daily == null) {
    throw syncError('洛谷个人页未返回 dailyCounts；可能是接口变更或当前用户不可公开访问');
  }
  const aggregates = [];
  for (const rawDay of Object.keys(daily || {})) {
    const raw = daily[rawDay];
    let count = 0;
    if (Array.isArray(raw)) {
      count = raw[0] || 0;
    } else if (raw && typeof raw === 'object') {
      count = raw.count ?? raw.value ?? 0;
    } else {
      count = raw || 0;
    }
    if (count <= 0) continue;
    const day = normalizeDay(rawDay);
    if (!day) continue;
    aggregates.push({ day, metric: 'activity', count, note: '洛谷公开个人页 dailyCounts；仅有日期计数，无当天逐题明细' });
  }
  let solvedCount = null;
  let difficulty = [];
  try {
    const practiceText = await getText(
      `https://www.luogu.com.cn/user/${uid}/practice`,
      luoguLentilleHeaders()
    );
    const practice = parsePayload(practiceText);
    const pd = practice.data || practice.currentData || practice;
    if (Array.isArray(pd.passed)) {
      solvedCount = pd.passed.length;
      const buckets = [0, 0, 0, 0, 0, 0, 0, 0];
      for (const p of pd.passed) {
        const d = p.difficulty;
        if (typeof d === 'number' && d >= 0 && d < 8) buckets[d] += 1;
      }
      const labels = ['入门', '普及-', '普及/提高-', '普及+/提高', '提高+/省选-', '省选/NOI-', 'NOI/NOI+/CTSC', '未知/特殊'];
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i] > 0) difficulty.push({ label: labels[i], count: buckets[i], order: i });
      }
    }
  } catch { /* optional */ }
  return remote('luogu', display, [], aggregates, solvedCount, difficulty, true,
    [`洛谷个人页热度图 · UID ${uid}`, 'record/list 匿名访问容易触发限制，因此 Activity 使用 dailyCounts'],
    nowEpoch(), true, true);
}

// ---------------------------------------------------------------------------
// HTML helpers (nowcoder / qoj)
// ---------------------------------------------------------------------------

function rowsOf(html) {
  const out = [];
  const re = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function cellsOf(row) {
  const out = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(row))) out.push(m[1]);
  return out;
}

function textOf(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aLinks(html) {
  const out = [];
  const re = /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ href: m[1], text: textOf(m[2]) });
  return out;
}

function parseChinaTime(s) {
  const m = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return 0;
  const text = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
  const ts = Date.parse(text) / 1000;
  return Number.isNaN(ts) ? 0 : ts;
}

// ---------------------------------------------------------------------------
// 牛客
// ---------------------------------------------------------------------------

async function fetchNowcoder(account, full, cursor) {
  const uid = account.account.trim();
  if (!uid || !/^\d+$/.test(uid)) {
    throw syncError('牛客目前需要数字 User ID（个人主页 users/ 后面的数字）');
  }
  const base = `https://ac.nowcoder.com/acm/contest/profile/${uid}/practice-coding`;
  const out = [];
  let page = 1;
  let maxSeen = cursor;
  const cutoff = full ? 0 : Math.max(0, cursor - 5);
  const reProblem = /\/acm\/problem\/(\d+)/;
  const reContest = /\/acm\/contest\/(\d+)\/([^/?#]+)/;
  for (;;) {
    if (page > 5000) throw syncError('牛客分页过多，已中止');
    const url = `${base}?languageCategoryFilter=-1&orderType=DESC&page=${page}&pageSize=200&search=&statusTypeFilter=5`;
    const html = await getText(url, withReferer(BROWSER_HEADERS, 'https://ac.nowcoder.com/'));
    const bodyText = textOf(html.replace(/<script[\s\S]*?<\/script>/gi, ''));
    if (bodyText.includes('登录') && !bodyText.includes('提交时间')) {
      throw syncAuth('牛客页面需要登录或当前账号不可公开访问');
    }
    const rows = parseNowcoderRows(html, uid, reProblem, reContest);
    if (rows.length === 0) break;
    let old = false;
    for (const s of rows) {
      maxSeen = Math.max(maxSeen, s.epochSecond);
      if (!full && s.epochSecond <= cutoff) {
        old = true;
        continue;
      }
      out.push(s);
    }
    if (old || !html.includes(`page=${page + 1}`)) break;
    page += 1;
    await sleep(260);
  }
  return remote('nowcoder', uid, out, [], null, [], false,
    ['牛客竞赛站公开练习提交页 · statusTypeFilter=5'],
    Math.max(maxSeen, nowEpoch() - 2), full, full);
}

function parseNowcoderRows(html, uid, reProblem, reContest) {
  const out = [];
  for (const row of rowsOf(html)) {
    const cells = cellsOf(row);
    if (cells.length < 9) continue;
    const verdict = textOf(cells[2]);
    if (!(verdict.includes('答案正确') || verdict.toLowerCase().includes('accepted') || verdict.trim() === 'AC')) {
      continue;
    }
    const links = aLinks(cells[1]);
    const link = links[0]?.href;
    if (!link) continue;
    const problemName = textOf(cells[1]);
    const language = textOf(cells[7]);
    const timeText = textOf(cells[8]);
    const ts = parseChinaTime(timeText);
    if (ts <= 0) continue;
    const absolute = /^https?:/.test(link) ? link : `https://ac.nowcoder.com${link}`;
    const pid =
      reProblem.exec(absolute)?.[1] ||
      (() => {
        const m = reContest.exec(absolute);
        return m ? `${m[1]}/${m[2]}` : absolute;
      })();
    const idRaw = textOf(cells[0]).replace(/\D/g, '');
    const submissionId = idRaw || `${uid}-${ts}-${pid}`;
    out.push(submission('nowcoder', submissionId, pid, pid, problemName, absolute, ts, language, null));
  }
  return out;
}

// ---------------------------------------------------------------------------
// QOJ
// ---------------------------------------------------------------------------

async function fetchQoj(account, full, cursor) {
  const user = account.account.trim();
  if (!user) throw syncError('QOJ 用户名为空');
  if (!account.secret.trim()) {
    throw syncAuth('QOJ 当前要求登录后才能查看完整提交列表；请在设置中填写 UOJSESSID Cookie');
  }
  const out = [];
  const cutoff = full ? 0 : Math.max(0, cursor - 5);
  let maxSeen = cursor;
  const reProblem = /\/problem\/(\d+)/;
  const reSub = /(?:\/submission\/|#)(\d+)/;
  for (let page = 1; page <= 5000; page++) {
    const url = `https://qoj.ac/submissions?submitter=${encodeURIComponent(user)}&min_score=100&max_score=100&page=${page}`;
    const html = await getText(url, withCookie(BROWSER_HEADERS, account.secret));
    if (looksLikeLogin(html)) {
      throw syncAuth('QOJ 未登录或 UOJSESSID 已过期；可填写完整 UOJSESSID=value，也可只填写 value');
    }
    const rows = parseQojRows(html, user, reProblem, reSub);
    if (rows.length === 0) {
      if (page === 1) {
        if (isValidEmptyQojPage(html)) {
          return remote('qoj', user, [], [], 0, [], false,
            ['QOJ 已登录，当前筛选下没有 AC 提交'], nowEpoch(), full, full);
        }
        throw syncError('QOJ 页面已返回，但未识别到提交表结构；请查看 logs/oj-insight.log 后更新应用');
      }
      break;
    }
    let reachedOld = false;
    for (const s of rows) {
      maxSeen = Math.max(maxSeen, s.epochSecond);
      if (!full && s.epochSecond <= cutoff) {
        reachedOld = true;
        continue;
      }
      out.push(s);
    }
    if (reachedOld || !html.includes(`page=${page + 1}`)) break;
    await sleep(350);
  }
  return remote('qoj', user, out, [], null, [], false,
    ['QOJ 完整提交列表当前需要登录；本地通过 UOJSESSID 读取'],
    Math.max(maxSeen, nowEpoch() - 2), full, full);
}

function looksLikeLogin(html) {
  const low = html.toLowerCase();
  return (
    ((low.includes('name="password"') || low.includes("name='password'")) &&
      (low.includes('login') || html.includes('登录'))) ||
    low.includes('must now be logged in to view submissions')
  );
}

function isValidEmptyQojPage(html) {
  const low = html.toLowerCase();
  const hasStructure =
    low.includes('submission') && low.includes('problem') &&
    (low.includes('submit time') || low.includes('提交时间'));
  if (!hasStructure) return false;
  return (
    low.includes('no submissions') ||
    low.includes('no records') ||
    low.includes('没有提交') ||
    low.includes('暂无记录') ||
    rowsOf(html).length === 0
  );
}

function parseQojRows(html, user, reProblem, reSub) {
  const out = [];
  for (const row of rowsOf(html)) {
    const cells = cellsOf(row);
    if (cells.length === 0) continue;
    const texts = cells.map((c) => textOf(c));
    const rowText = texts.join(' ');
    const rowLow = rowText.toLowerCase();
    if (!(rowText.includes('100') || rowLow.includes('accepted') || rowLow.split(/\s+/).some((w) => w === 'ac'))) {
      continue;
    }
    const anchors = [];
    for (const cell of cells) {
      for (const a of aLinks(cell)) anchors.push(a);
    }
    const problemAnchor = anchors.find((a) => reProblem.test(a.href));
    if (!problemAnchor) continue;
    const pidMatch = reProblem.exec(problemAnchor.href);
    if (!pidMatch) continue;
    const pid = pidMatch[1];
    const problemName = problemAnchor.text;
    const ts = parseChinaTime(rowText);
    if (ts <= 0) continue;
    const id = anchors.map((a) => a.href).find((h) => reSub.test(h))?.replace(/\D/g, '') || `${user}-${ts}-${pid}`;
    const language = texts.find((x) => {
      const l = x.toLowerCase();
      return l.includes('c++') || l.includes('python') || l.includes('rust') || l.includes('java');
    }) || '';
    out.push(submission('qoj', id, pid, `#${pid}`, problemName, `https://qoj.ac/problem/${pid}`, ts, language, null));
  }
  return out;
}

// ---------------------------------------------------------------------------
// LeetCode
// ---------------------------------------------------------------------------

function parseAccount(raw) {
  const value = String(raw).trim();
  const cn = value.match(/^cn:/i);
  if (cn) {
    return {
      user: value.slice(3).trim(),
      site: {
        endpoint: 'https://leetcode.cn/graphql/',
        origin: 'https://leetcode.cn',
        referer: 'https://leetcode.cn/',
        label: 'LeetCode CN',
        china: true,
      },
    };
  }
  return {
    user: value,
    site: {
      endpoint: 'https://leetcode.com/graphql',
      origin: 'https://leetcode.com',
      referer: 'https://leetcode.com/',
      label: 'LeetCode',
      china: false,
    },
  };
}

function leetcodeHeaders(site) {
  return {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
    accept: 'application/json',
    'content-type': 'application/json',
    origin: site.origin,
    referer: site.referer,
    'x-requested-with': 'XMLHttpRequest',
  };
}

const GLOBAL_QUERY =
  'query userProfileCalendar($username: String!, $year: Int) { matchedUser(username: $username) { username submitStatsGlobal { acSubmissionNum { difficulty count submissions } } userCalendar(year: $year) { activeYears streak totalActiveDays submissionCalendar } } }';
const CN_PROGRESS_QUERY =
  'query userQuestionProgress($userSlug: String!) { userProfileUserQuestionProgress(userSlug: $userSlug) { numAcceptedQuestions { count difficulty } } }';
const CN_PROGRESS_V2_QUERY =
  'query userProfileUserQuestionProgressV2($userSlug: String!) { userProfileUserQuestionProgressV2(userSlug: $userSlug) { numAcceptedQuestions { count difficulty } } }';

async function calendarRequest(user, year, site) {
  return postJson(
    site.endpoint,
    leetcodeHeaders(site),
    { operationName: 'userProfileCalendar', query: GLOBAL_QUERY, variables: { username: user, year } }
  );
}

function calendarNode(payload) {
  return payload?.data?.matchedUser?.userCalendar;
}

async function loadCalendar(user, site) {
  const current = new Date().getUTCFullYear();
  const first = await calendarRequest(user, current, site);
  const initialCalendar = calendarNode(first);
  if (!initialCalendar) {
    throw syncError(`${site.label} 用户不存在，或 userCalendar 未返回数据`);
  }
  const years = new Set([current]);
  if (Array.isArray(initialCalendar.activeYears)) {
    for (const y of initialCalendar.activeYears) {
      if (typeof y === 'number') years.add(y);
    }
  }
  const calendar = {};
  for (const year of years) {
    const payload = year === current ? first : await calendarRequest(user, year, site);
    const s = calendarNode(payload)?.submissionCalendar;
    if (typeof s === 'string') {
      try {
        const map = JSON.parse(s);
        for (const [epoch, count] of Object.entries(map)) {
          if (count > 0) calendar[epoch] = count;
        }
      } catch { /* ignore malformed year */ }
    }
    await sleep(160);
  }
  const aggregates = Object.entries(calendar)
    .map(([epoch, count]) => {
      const ts = parseInt(epoch, 10);
      if (Number.isNaN(ts)) return null;
      return {
        day: dayUtc8(ts),
        metric: 'activity',
        count,
        note: `${site.label} submissionCalendar：提交活动计数，不等同于首次 AC`,
      };
    })
    .filter(Boolean);
  return { first, aggregates };
}

function parseProfileStats(rows) {
  let solved = null;
  const difficulty = [];
  let sum = 0;
  rows.forEach((row, i) => {
    const label = row.difficulty || '';
    const count = row.count || 0;
    if (label.toLowerCase() === 'all') {
      solved = count;
    } else if (label) {
      sum += count;
      difficulty.push({ label, count, order: i });
    }
  });
  if (solved === null && difficulty.length > 0) solved = sum;
  return { solved, difficulty };
}

async function fetchLeetcode(account) {
  const { user, site } = parseAccount(account.account);
  if (!user) throw syncError('LeetCode 用户名为空');
  if (site.china) {
    const { solved, difficulty } = await chinaProfileStats(user, site);
    return remote('leetcode', `cn:${user}`, [], [], solved, difficulty, true,
      ['LeetCode 中国站公开个人资料使用独立 GraphQL schema',
        '中国站目前没有稳定可用的公开 Activity 日历接口；解题总数与难度正常同步，已有日期缓存不会被清空。'],
      nowEpoch(), false, false);
  }
  const { first, aggregates } = await loadCalendar(user, site);
  const rows = first?.data?.matchedUser?.submitStatsGlobal?.acSubmissionNum || [];
  const stats = parseProfileStats(rows);
  return remote('leetcode', user, [], aggregates, stats.solved, stats.difficulty, true,
    [`${site.label} 独立 GraphQL provider`, '逐日 calendar 是提交活动，不提供完整历史逐题 AC 明细'],
    nowEpoch(), true, true);
}

async function chinaProfileStats(user, site) {
  const v1 = { operationName: 'userQuestionProgress', query: CN_PROGRESS_QUERY, variables: { userSlug: user } };
  let value;
  try {
    value = await postJson(site.endpoint, leetcodeHeaders(site), v1);
  } catch (v1Error) {
    try {
      const v2 = { operationName: 'userProfileUserQuestionProgressV2', query: CN_PROGRESS_V2_QUERY, variables: { userSlug: user } };
      value = await postJson(site.endpoint, leetcodeHeaders(site), v2);
    } catch (v2Error) {
      throw syncError(`LeetCode CN 难度统计请求失败（V1：${v1Error.message}；V2：${v2Error.message}）`);
    }
  }
  const rows =
    value?.data?.userProfileUserQuestionProgress?.numAcceptedQuestions ||
    value?.data?.userProfileUserQuestionProgressV2?.numAcceptedQuestions ||
    [];
  return parseProfileStats(rows);
}