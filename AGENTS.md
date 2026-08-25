# AGENTS.md — OJ Insight Manager 开发指南

> 本文件面向后续参与开发的 AI 编码代理与人类协作者。改动前请通读「架构」「硬性约定」「踩坑记录」三节。

## 项目是什么

**OJ_Insight Manager**（`sam5440/OJ_Insight_Manager`）是基于 [Whalica/OJ_Insight](https://github.com/Whalica/OJ_Insight) v0.2.0 的二次开发版本：一个多平台（Codeforces / AtCoder / 洛谷 / 牛客 / QOJ / LeetCode）刷题数据聚合面板。

存在**两套运行时，共享同一前端**：

| 运行时 | 后端 | 说明 |
|---|---|---|
| 桌面版 | Rust (Tauri v2, `src-tauri/`) + SQLite | 原仓库功能，保持可用 |
| Web 版（主要开发方向） | Node ≥22 内置 http（`server/`），零 npm 依赖 | 多用户 + 管理后台 + 调度器 |

前端是同一个 React SPA；`src/lib/api.ts` 通过 `isTauri = '__TAURI_INTERNALS__' in window` 在运行时双分支。Web 版所有新功能只做浏览器分支；桌面分支没有的能力（多用户、管理后台等）返回合理的降级值或直接不支持。

## 目录结构

```
server/                  # Web 后端（纯 ESM .mjs，无第三方依赖）
  index.mjs              # HTTP 路由 + 静态托管 dist/（SPA 回退）
  store.mjs              # 数据存储（JSON 文件持久化）+ 全部查询/统计逻辑
  auth.mjs               # 管理员登录（scrypt+盐）与内存 Bearer token
  scheduler.mjs          # 自动同步调度器（唯一 setInterval 驱动槽位）
  monitor.mjs            # 监控队列快照（活动任务、下次计划时间）
  gate.mjs               # ★ 共享限流计时器 + 最近 200 条请求日志环形缓冲
  sync.mjs               # 六个平台的抓取 provider（getText/getJson/postJson 必须经 gate）
  util.mjs               # PLATFORMS、UTC+8 日界工具、id/时间工具
  data-root/             # 运行数据（gitignore！含账号 Cookie 与密码哈希，严禁提交）
src/
  App.tsx                # 前台 SPA：页面切换、用户切换、hash 同步、权限门
  Admin.tsx              # 管理后台（#/admin）：用户/分组/同步计划/监控/安全 五个 tab
  main.tsx               # hash 路由：#/admin → AdminPage，其余 → App
  lib/api.ts             # ★ API 双分支封装 + adminApi；req() 一律 cache:'no-store'
  lib/export.ts          # 热力图 PNG/SVG 导出 + CSV 导出（浏览器下载 / Tauri 另存为）
  components/            # Sidebar(抽屉)、TrendModal、MonitorBoard、Heatmap、DayDrawer、StatCards
dist/                    # vite 构建产物（gitignore）
```

## 常用命令

```bash
npm install                       # 安装前端依赖
npm run web                       # 构建 + 启动生产服务（默认 :4310，自动开浏览器）
npm run server                    # 仅启动后端（复用已有 dist/）
npm run dev                       # Vite 开发服 :1420（已代理 /api → :4310，需另起 server）

npm run build                     # tsc && vite build —— 提交前必须零错误
node --check server/index.mjs     # 后端快速语法检查（改哪个查哪个）
cargo check --manifest-path src-tauri/Cargo.toml   # 动了 src-tauri/ 后必须通过
```

调试入口：前台 `http://localhost:4310/#/`，管理后台 `/#/admin`（默认 `admin/qwe123`，可在「安全设置」修改；密码哈希存于数据文件的 `auth` 字段）。

## 数据模型（Web 版）

持久化为单文件 JSON：`server/data-root/data/oj-insight.json`，结构：

```text
groups[]            { id, name, createdAt }
users[]             { id(u_*), name, groupId|null, createdAt }   // 数组顺序 = 调度错开顺序
accounts{}          [userId][platform] -> { account, secret }
submissions[]       { userId, platform, submission_id, problem_key, problem_id,
                      problem_name, problem_url, epoch_second, language, difficulty|null }
dailyCounts[]       { userId, platform, day(YYYY-MM-DD UTC+8), metric, count }
dailyAggregates[]   同上 + note（洛谷/LeetCode 的活动量来源说明）
platformStats{}     "userId:platform" -> { activity_only:'0'|'1', solved_count?,
                      notes(JSON数组字符串), "<uid>:<plat>:first_seen"? -> 见下 }
difficultyStats[]   { userId, platform, label, count, order }    // 有显式值时优先于推导
syncState{}         "userId:platform" -> { account, status, message,
                      last_attempt, last_success, cursor_epoch }
settings{}          { schedule:{enabled,startHour,intervalHours,userStaggerMinutes},
                      summary:{defaultPeriod:'week'|'month'|'year'|'total'} }
auth                { username, salt, hash }   // scrypt(password, salt)
```

`metric` 四种口径：`first_ac` / `daily_unique` / `accepted_submissions` / `activity`。
逐题平台由 `_recomputeRawDaily()` 从 submissions 重算前三种；聚合型平台（洛谷、LeetCode）只写外部给的活动量到 `activity`。

**序列化命名约定（极易踩坑）**：对外 JSON 一律 snake_case（如 `epoch_second`、`cached_records`、`metric_available`）；仅两个例外使用 camelCase——`StorageInfo` 与 `UpdateInfo`（沿用原 Rust serde 配置）。新增字段请遵循同一规则。

## HTTP API 契约

公开（无需登录，CORS \*，响应一律 `cache-control: no-store`）：

```
GET  /api/health | storage_info | users | public_settings | check_updates
GET  /api/statuses?userId=            GET /api/cards?period=week|month|year|total
GET  /api/user_trend?userId=&days=30|180        GET /api/summary?limit=
GET  /api/records?userId=(空=全部)&start=&end=   （CSV 数据源，按时间升序）
GET  /api/monitor                    （监控队列：hosts/platforms/logs，无需登录）
POST /api/snapshot                   { userId, platform|null, startDay, endDay, metric }
POST /api/day_detail                 { day, userId, platform|null }
POST /api/sync                       { userId, platform, full }   // 手动增量/重建
POST /api/open_external              { url }                      // 白名单校验
```

管理（`Authorization: Bearer <token>`；token 为内存 Map，**服务重启即全体登出**）：

```
POST /api/admin/login {username,password} -> {token}
GET  /api/admin/verify | overview
PUT  /api/admin/groups {id|null,name}      DELETE /api/admin/groups/:id
PUT  /api/admin/users  {id|null,name,groupId}   DELETE /api/admin/users/:id   // 删除级联清数据
PUT  /api/admin/users/:id/accounts {platform,account,secret}
POST /api/admin/clear {userId, platform|null}
PUT  /api/admin/settings {schedule?, summary?:{defaultPeriod}}
POST /api/admin/password {oldPassword,newPassword}     POST /api/admin/sync {userId,platform|null,full}
POST /api/admin/logout
```

错误统一 `{ error: string }` + 相应状态码；401 时前端 `adminReq` 会清除本地 token 并要求重新登录。

## 核心机制与硬性约定

### 1. 共享限流计时器（gate.mjs）
对 OJ 的**每一次**出站请求必须走 `gate.acquire(url)` → fetch → `gate.release(url, info)`（`sync.mjs` 的 getText/postJson 已封装）。全局只有一个 `setInterval(120ms)` tick 按各平台 `MIN_GAP` 放行队列（CF≥2100ms、AtCoder/kenkoooo≥1100ms、洛谷≥600ms、牛客≥300ms、QOJ≥400ms、LC≥200ms）。不要在 provider 里绕过它直连 fetch；`polite_sleep` 仅作为翻页间的额外礼让保留。release 会写请求日志（环形 200 条），供监控页展示。

### 2. 时间基准全部是 UTC+8
`util.mjs` 的 `dayUtc8 / dayStartEpoch / dayEndEpoch / todayUtc8` 是唯一起点。任何"周/月/年"区间先换算成日期串再比较。卡片周期定义见 `store.cards()`：周从周一开始；`prev` 区间紧邻 `cur`。

### 3. 统计口径
- 卡片（`store.cards`）：提交类平台统计**唯一 AC 题数**（按 `problem_key` 去重，`_countUniqueInRange`）；`activity_only` 平台（洛谷/LeetCode）回退为 dailyCounts 活动量并在 cell 上标 `approx:true`（前端渲染黄色 ＊）。
- 曲线（`store.userTrend`）：逐日逐平台同样去重；approx 平台用活动量。返回 `points[].by[platform] = {n, approx}`。
- 生涯解题数：优先 `platform_stats.solved_count`，否则 distinct problem_key。

### 4. 洛谷合成提交（重要语义）
洛谷公开接口拿不到逐题历史，provider 会：
- 抓 practice.passed 得到题目 pid 列表 → 写入 `platformStats["uid:luogu:first_seen"].map`，**首次扫描时所有题目的首次发现日期 = 本次扫描日期**，之后新出现的题以发现当日为准；
- 对每个活动量>0 的历史日期生成一条**合成提交**：`submission_id = lg-{day}`、时间固定当天 **23:59:59 UTC+8**、题名含免责声明「因为平台限制无法获得具体题目信息（23:59 仅为当日汇总提交时间，不代表洛谷正式提交日期）」。
这些行会出现在最近列表 / 当日抽屉 / CSV 里，属于有意设计；改文案时三处免责声明语义必须保留。`replaceSubmissions=true` 使每次全量重建合成行，幂等。

### 5. 调度器（scheduler.mjs）
槽位 = 每天 `startHour + k*intervalHours` 点（k≥0，含起始时刻）；同槽内第 i 个用户延后 `i * userStaggerMinutes` 分钟。默认 0 点起、每 4 小时、错开 10 分钟。错过槽位超过 30 分钟（MAX_LAG）不补跑。任务进串行 Promise 队列执行，自动任务日志 tag=`auto`，手动为 `manual`。

### 6. 前端页面与权限
- 页面集合 `Page = overview|summary|monitor|export|data|settings|about|平台名`；**hash ↔ page 双向同步**（`pageFromHash/hashFromPage`），深链接可用。
- `TOOLS` 区（export/data/settings/about）**仅管理员登录可见**：App 挂载时 `verifyAdmin()`（带 Bearer 调 `/api/admin/verify`）决定；未登录访问这些路由渲染 `AdminRequired` 引导页。桌面 Tauri 视为始终管理员。
- 侧栏 ≤900px 是抽屉（汉堡 `.mobile-topbar` + `.sidebar-backdrop`），选菜单/切用户自动关闭。

### 7. 缓存策略（防"改了没生效"）
- HTML：`no-cache`；带 hash 的 assets：immutable；**JSON API：`no-store`**；前端 `fetch` 全部 `cache:'no-store'`。
- 浏览器验证新构建时，若行为像旧版，用带随机 query 的地址强制刷新（旧缓存条目可能无视 no-cache 头）。

### 8. 弹窗与移动端
- `TrendModal` 固定 **75vw × 75vh 屏幕正中**；左图右详情；图表每天有透明热区 rect（hover 出 tooltip 显示当日合计+分平台去重数，click 加载右侧当日明细）。
- 全站已适配移动端：≤900px 抽屉导航、各网格塌缩单列；横向溢出审计方法见下。

## 踩坑记录（务必先读再动手）

1. **字段大小写**：后端漏写 snake_case 或前端用错驼峰不会报编译错，只会运行时 undefined（曾导致白屏）。
2. **React 受控输入**：自动化测试里 `el.value='x'` 直接赋值会污染 React 值跟踪器，导致后续真实输入失效；必须用原型 setter + input 事件，或交给 Playwright 的 fill()。
3. **SVG 元素没有 `.click()`**：对 svg 内 rect 用 `el.click()` 会抛 TypeError；用 Playwright locator.click() 或 `dispatchEvent(new MouseEvent('click', {bubbles:true}))`。
4. **token 在内存**：重启后端后所有管理员会话失效属预期；前端收到 401 会自动清 token 并跳登录页。
5. **删除用户/分组**：删组把成员移到未分组；删用户会级联删除其全部 submissions/counts/stats/syncState。
6. **`body{min-width:1024px}` 已在 ≤1023px 解除**——这是当年"手机完全没适配"的根因，别加回来。
7. **静态资源缓存**：index.html no-cache 但浏览器旧条目可能仍命中；自测新构建时用 `?v=n` 或强制刷新。
8. **clipboard.readText** 在部分浏览器会拒绝：涉及粘贴的功能必须同时提供文本框手动粘贴路径。
9. **洛谷反爬**：匿名 record/list 易触发验证码；provider 只用个人页 + practice（x-lentille-request 头）。触发限制时错误信息要能区分"需要 UID""触发验证"两种场景。
10. **改 Rust 后**必须 `cargo check`；改前端必须 `npm run build`（tsc 会抓住大部分跨文件类型问题）。

## 验证清单（提交前）

```bash
npm run build                                        # 必须 ✓
node --check <改动过的 server/*.mjs>                   # 必须 ✓
cargo check --manifest-path src-tauri/Cargo.toml     # 动了 src-tauri 才需要
```

浏览器冒烟（Playwright 或手测）：
1. 前台总览/全站汇总/监控队列/导出/数据源 各开一次，控制台零 error；
2. 未登录访问 `#/export` 应看到管理员引导页；登录后恢复；
3. 手机尺寸（390×844）横向溢出审计：遍历元素 `right > innerWidth+1` 且排除 `.heatmap-scroll/.mq-logs/.histogram`（它们本就横向滚动），应为 0 条；
4. 弹窗卡片宽高 ≈ 视口 75%、居中偏差 <2px。

## Git 约定

- 远端：`https://github.com/sam5440/OJ_Insight_Manager`（main）。
- 提交信息英文 conventional 风格（feat:/fix:/style:…），正文列要点。
- **严禁提交** `server/data-root/`（账号凭据+密码哈希）、`dist/`、`node_modules/`、截图等临时产物（均已 gitignore）。
- 发布：打 `vX.Y.Z` tag 并创建 GitHub Release（About 页更新检查读 latest release）。

## 后续可做的方向（候选）

- 洛谷 first_seen 差集：连续两次扫描对比即可识别"新解题目"，可用于周报/新题提醒（数据已在 platformStats.first_seen）。
- 监控页增加每个平台的实时限流倒计时可视化（gate.snapshotHosts 已有 nextAt）。
- 用户维度导出（单用户 PDF/图片报告）。
- 桌面 Tauri 版补齐多用户能力（当前桌面为单用户本地模式，verifyAdmin 恒真）。
