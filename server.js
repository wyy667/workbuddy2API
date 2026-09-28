#!/usr/bin/env node
/**
 * codebuddy-proxy — 把 CodeBuddy/WorkBuddy 订阅暴露成标准 OpenAI 兼容 API。
 *
 * 无需安装运行时依赖，Node 22+（内置 fetch + 随包 HTTP dispatcher）。
 *
 * 功能：
 *   - OpenAI 兼容 API：POST /v1/chat/completions（SSE 流式+非流式聚合，原生 tools）
 *   - token 过期自动刷新；401 自动强刷重试一次
 *   - 可视化管理台 GET /admin：token 状态、手机号登录换号（官方 OAuth state/token 流程）、
 *     连通测试、接入信息、请求日志 —— URL 与 API Key 长期不变，换号只换 token
 *   - 可靠性：ERR_POLICY 错误分类冷却表 / 账号在途租约上限 / 整请求预算 /
 *     模型降级链（响应头回传 x-fallback-model）/ in-flight 去重 / 合批落盘 /
 *     br-gzip 压缩（SSE 直通）/ SIGINT,SIGTERM 优雅停机
 *   - 可观测：GET /admin/api/{metrics,usage/export,health/history,live(SSE)}
 *
 * 环境变量（默认值见下方「配置」常量区，全部可选）：
 *   PORT=8787                    监听端口
 *   HOST=127.0.0.1               监听地址；绑定非回环地址时强制要求 CB_API_KEY
 *   CB_API_KEY=xxx               管理台 + /v1/* 主鉴权 Key（公网必填）
 *   CB_AUTH_FILE=path            凭据 JSON；缺省自动搜索（登录成功后写入 <目录>/auth.json 并热加载）
 *   CB_DESENSITIZE=1             system 消息安全词零宽脱敏
 *   CB_FAILOVER_CREDITS=200      账号余额低于该值时自动换号
 *   CB_KEEPALIVE_AT=04:30        每日保活刷新窗口起点（HH:MM，周期天数在管理台设置）
 *   CB_CHECKIN_AT=09:00          每日自动签到窗口起点（HH:MM）
 *   CB_POLL_MIN=120              余额巡检间隔（分钟；管理台可改并持久化）
 *   CB_UPSTREAM_HEADERS_TIMEOUT=600000   等上游响应头上限 ms（覆盖 connect+首字节）
 *   CB_UPSTREAM_STREAM_IDLE=600000       流式读空闲上限 ms
 *   CB_REQ_BUDGET_MS=600000      整请求预算 ms（选号/刷新/重试直到上游响应头，下限 1s）
 *   CB_STREAM_MAX_MS=1800000     上游响应开始后的流式总时长上限 ms（0=不限，仅靠空闲超时）
 *   CB_MAX_BODY_MB=16            对话请求体上限 MB
 *   CB_ACCT_MAX_INFLIGHT=4       单账号在途上游请求上限（租约制）
 *   CB_ACCOUNTS_CACHE_MS=10000   auths/ 目录账号档案缓存 TTL ms（0=禁用，封顶 10s）
 *
 * 安全设计：
 *   - 内置上游使用固定域名；外部服务地址仅管理员配置，默认 HTTPS；redirect:'error'
 *   - 上游错误不原样回显客户端（提取 msg/message 并清洗）
 *   - /admin 及其 API 需 CB_API_KEY；管理页为纯静态文件，不注入任何动态值
 *   - 凭据只从文件/环境读取，接口只回显掩码（key 主体仅对已通过 key 鉴权的管理台回显）
 */

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const requestRuntime = require('./backend/request.cjs');
const hardening = require('./backend/hardening.cjs');
const upstreamDispatcher = require('./backend/http-dispatcher.cjs')();
// Override native fetch parser deadlines; application signals own each operation's timeout.
const fetch = (url, options) => globalThis.fetch(url, { ...options, dispatcher: upstreamDispatcher });
const { createQuotaLedger, keyId, resolveKey } = require('./backend/quota.cjs');
const { createPersistence } = require('./backend/persistence.cjs');
const { scheduledDue } = require('./backend/schedule.cjs');
const { createCompression } = require('./backend/compression.cjs');
const { identity: credentialIdentity, syncCredentialCopies } = require('./backend/credentials.cjs');
const storage = createPersistence(log);
const quotaLedger = createQuotaLedger(() => todayStr());
const chatAdmission = requestRuntime.createAdmission(Math.max(1, Number(process.env.CB_MAX_INFLIGHT) || 128));

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.CB_API_KEY || '';
const DESENSITIZE = process.env.CB_DESENSITIZE === '1';
const FAILOVER_CREDITS = Number(process.env.CB_FAILOVER_CREDITS || 200); // 余额低于该值自动切换
const KEEPALIVE_AT = process.env.CB_KEEPALIVE_AT || '04:30'; // 每天该时间无条件刷新全部 token（保活）
const CHECKIN_AT = process.env.CB_CHECKIN_AT || '09:00'; // 每日自动签到窗口起点（HH:MM，10 分钟窗口内触发）
const POLL_MIN_DEFAULT = Number(process.env.CB_POLL_MIN || 120); // 余额巡检默认间隔（分钟）；settings.json/管理台可覆盖
// 上游超时（借鉴 wb2api 分段式）：等响应头上限 + 流式读空闲上限。
// 注：标准 fetch 无法单独探测 TCP connect 阶段，headers 超时即覆盖 connect+首字节全程；
// 等待响应头及连续无字节均容忍十分钟，避免误杀长思考模型。
const UPSTREAM_HEADERS_TIMEOUT_MS = Number(process.env.CB_UPSTREAM_HEADERS_TIMEOUT || 600_000);
const UPSTREAM_STREAM_IDLE_MS = Number(process.env.CB_UPSTREAM_STREAM_IDLE || 600_000);
// 整请求预算（借鉴 opencode）：进入轮换循环前记 deadline，每轮检查剩余预算，
// 覆盖请求体、凭据刷新、重试至成功响应头；随后采用独立流时长和空闲超时。
const REQ_BUDGET_MS = Math.max(1_000, Number(process.env.CB_REQ_BUDGET_MS || 600_000) || 600_000);
// 上游 200 响应头到达后，整请求预算即解除，改由「流式空闲超时 + 流式总时长上限」约束，
// 避免思考型/长输出模型在 REQ_BUDGET_MS 处被截断。0 = 不设总时长上限（仅靠空闲超时）
const STREAM_MAX_MS = Math.max(0, Number(process.env.CB_STREAM_MAX_MS ?? 30 * 60_000) || 0);
// /v1/chat/completions 请求体上限（MB）：大上下文客户端够用，同时限制 128 并发时的内存峰值
const CHAT_BODY_LIMIT = Math.max(1, Number(process.env.CB_MAX_BODY_MB || 16) || 16) * 1024 * 1024;
const USER_AGENT = 'codebuddy2openai/2.0';
const STARTED_AT = Date.now();

// 单账号在途上游请求上限（租约制）：达到上限的账号不参与本轮候选，换下一个可用号。
// 租约在账号选中→响应体消费结束的全程持有，异常路径由 try/finally 保证释放。
const ACCT_MAX_INFLIGHT = Math.max(1, Number(process.env.CB_ACCT_MAX_INFLIGHT || 4) || 4);

// 账号档案缓存 TTL（accountFileRows）：只缓存 auths/ 目录 readdir+JSON.parse 的静态字段，
// 账号健康态每次现算；0=禁用，封顶 10s。账号增删/健康标记变更时主动失效。
const ACCTS_CACHE_MS = Math.max(0, Math.min(Number(process.env.CB_ACCOUNTS_CACHE_MS ?? 10_000), 10_000));

// 凭据文件显式路径；留空则按 candidateAuthPaths() 自动搜索
const AUTH_FILE_ENV = process.env.CB_AUTH_FILE || '';

// ---------------------------------------------------------------------------
// 上游错误分类表（借鉴 wb2api ErrKind 分层分类：状态码优先于文案，具体码优先于
// 宽泛兜底）。对话路径所有冷却决策统一经 chatErrorPolicy() 查表 + acctCooldownMs()
// 折算冷却时长（Retry-After 优先，封顶 6h），不散落硬编码。
//   scope 'none'     = 不打冷却（401 由 callUpstream 内部刷新重试；普通 4xx 透传）
//   scope 'model'    = 只冷却该账号+该模型（modelHealth），账号其它模型不受限
//   scope 'flag403'  = 除模型级冷却外另打账号级持久风控标记（flag403），
//                      直至该号任一请求成功才解除——不放宽也不加重
// ---------------------------------------------------------------------------
const ERR_POLICY = {
  ok:                { scope: 'none' },
  network:           { scope: 'model', defaultMs: 60_000 },           // 网络错/头部超时 → 短冷却
  auth_expired:      { scope: 'none' },                               // 401：沿用 callUpstream 刷新重试
  risk_control:      { scope: 'flag403', defaultMs: 60 * 60_000 },    // 403+11140/request illegal：模型级 1h + 账号级标记，原有长冷却不动
  quota:             { scope: 'model', defaultMs: 60_000 },           // 429 配额类：RA/重置时间优先
  rate_limit:        { scope: 'model', defaultMs: 60_000 },           // 429 非配额类
  model_unavailable: { scope: 'model', defaultMs: 5 * 60_000 },       // 仅冷却该账号+该模型
  region_blocked:    { scope: 'model', defaultMs: 30 * 60_000 },      // 仅冷却该账号+该模型
  server_5xx:        { scope: 'model', defaultMs: 60_000 },
  client_4xx:        { scope: 'none' },
};

// 出站 host 白名单（所有 fetch 的目标必须是这里列出的 https 主机）
const ALLOWED_HOSTS = new Set(['copilot.tencent.com', 'www.codebuddy.cn', 'www.codebuddy.ai', 'www.workbuddy.cn', 'www.workbuddy.ai']);

function validateBase(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) return null;
  return u.origin;
}

// 站点定义：auth=OAuth state/token 主机；chat=对话/刷新主机；domain=凭据缺省 X-Domain
const SITES = {
  cn:   { label: '国内站', authBase: 'https://copilot.tencent.com', chatBase: 'https://copilot.tencent.com', billingBase: 'https://www.codebuddy.cn', webBase: 'https://www.workbuddy.cn', domain: 'www.workbuddy.cn' },
  intl: { label: '国际站', authBase: 'https://www.codebuddy.ai',   chatBase: 'https://www.codebuddy.ai',   billingBase: 'https://www.workbuddy.ai', webBase: 'https://www.workbuddy.ai', domain: 'www.codebuddy.ai' },
};
for (const s of Object.values(SITES)) {
  if (!validateBase(s.authBase) || !validateBase(s.chatBase) || !validateBase(s.billingBase) || !validateBase(s.webBase)) {
    console.error(`站点 base 不在白名单: ${s.authBase}`); process.exit(1);
  }
}

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
// pollMin: 余额巡检间隔（分钟）；paidRoute: 计费模型选号策略
//   'expire'（默认）= 优先用积分最早到期的号，避免临期积分作废
//   'balance'      = 优先用余额最多的号，避免单点烧穿
let appSettings = { pollMin: POLL_MIN_DEFAULT, paidRoute: 'expire' };
try {
  if (fs.existsSync(SETTINGS_FILE)) appSettings = { ...appSettings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) };
} catch { /* ignore */ }
function saveAppSettings() { writeAuthFileAtomic(SETTINGS_FILE, appSettings); }
const requestMap = require('./backend/request-map.cjs').createRequestMapController({enabled:appSettings.requestMapEnabled !== false});

const CHAT_PATH = '/v2/chat/completions';
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';
const STATE_PATH = '/v2/plugin/auth/state';
const TOKEN_PATH = '/v2/plugin/auth/token';
const CHECKIN_PATH = '/v2/billing/meter/daily-checkin';
const CHECKIN_STATUS_PATH = '/v2/billing/meter/checkin-activity-status';

const DEFAULT_MODELS = [
  'glm-5.2', 'glm-5.1', 'glm-5v-turbo',
  'kimi-k2.7', 'kimi-k2.6', 'kimi-k2.5',
  'deepseek-v4-pro', 'deepseek-v4-flash',
  'minimax-m3-pay', 'hy4-preview', 'hy3-preview-agent', 'auto',
];

const PASSTHROUGH_BODY_KEYS = new Set([
  'model', 'messages', 'tools', 'tool_choice', 'temperature',
  'max_tokens', 'max_completion_tokens', 'top_p', 'stream',
  'stream_options', 'stop', 'presence_penalty', 'frequency_penalty',
  'n', 'response_format', 'seed', 'user', 'reasoning_effort',
  'verbosity', 'reasoning_summary',
]);

// ---------------------------------------------------------------------------
// 脱敏（port 自 codebuddy2openai/desensitize.py）
// ---------------------------------------------------------------------------

const SENSITIVE_TERMS = [
  'DoS', 'DDoS', 'exploit', 'credential testing', 'credential stuffing',
  'supply chain compromise', 'supply-chain compromise', 'detection evasion',
  'C2 frameworks', 'C2 framework', 'command and control',
  'malicious purposes', 'malicious intent', 'mass targeting',
  'brute force', 'brute-force', 'privilege escalation', 'reverse shell',
  'remote code execution', 'SQL injection', 'XSS', 'CSRF', 'phishing',
  'malware', 'ransomware', 'keylogger', 'rootkit', 'backdoor', 'botnet',
  'zero-day', '0day',
];
const ZWSP = '\u200b';
const DESENSITIZE_RE = new RegExp(
  SENSITIVE_TERMS.slice().sort((a, b) => b.length - a.length)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'gi');

function desensitizeText(text) {
  if (!text) return text;
  return text.replace(DESENSITIZE_RE, m => (m.length > 1 ? m[0] + ZWSP + m.slice(1) : m));
}

function desensitizeMessages(messages) {
  return messages.map(m => {
    if (!m || m.role !== 'system') return m;
    const nm = { ...m };
    if (typeof nm.content === 'string') {
      nm.content = desensitizeText(nm.content);
    } else if (Array.isArray(nm.content)) {
      nm.content = nm.content.map(blk =>
        blk && blk.type === 'text' ? { ...blk, text: desensitizeText(blk.text || '') } : blk);
    }
    return nm;
  });
}

// ---------------------------------------------------------------------------
// 日志（stderr + 内存环形缓冲供管理台展示）与统计
// ---------------------------------------------------------------------------

const RECENT_LOGS = [];
const STATS = { total: 0, errors: 0, inflight: 0 };

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
  RECENT_LOGS.push({ t: Date.now(), msg: String(msg) });
  if (RECENT_LOGS.length > 40) RECENT_LOGS.shift();
}

// 最近请求明细（成功含 usage/首字/耗时/积分，失败含状态），管理台可按账号/模型筛选
const RECENT_REQUESTS = [];
// 请求完成时间索引（/admin/api/metrics 算最近 N 分钟速率用；只存时间戳，按时间修剪，不替代 RECENT_REQUESTS）
const REQ_TIMES = [];
// /admin/api/live 的 SSE 客户端集合：pushRecentRequest 时实时广播
const LIVE_CLIENTS = new Set();
function pushRecentRequest(e) {
  const now = Date.now();
  const row = { t: now, ...e };
  RECENT_REQUESTS.push(row);
  if (RECENT_REQUESTS.length > 80) RECENT_REQUESTS.shift();
  REQ_TIMES.push(now);
  // 只保留最近 2 小时（N 分钟速率窗口最大 60min，2h 裕量足够）+ 数量硬上限防爆内存
  const cutoff = now - 2 * 3600_000;
  while (REQ_TIMES.length && REQ_TIMES[0] < cutoff) REQ_TIMES.shift();
  if (REQ_TIMES.length > 20000) REQ_TIMES.splice(0, REQ_TIMES.length - 20000);
  if (LIVE_CLIENTS.size) {
    const frame = `data: ${JSON.stringify(row)}\n\n`;
    for (const res of LIVE_CLIENTS) liveWrite(res, frame);
  }
}
// /admin/api/live 慢客户端保护：积压超过 256KB（对端不读）直接断开，防内存无界增长
const LIVE_MAX_CLIENTS = 16;
const LIVE_MAX_BUFFER = 256 * 1024;
function liveWrite(res, frame) {
  try {
    if (res.destroyed || res.writableEnded || res.writableLength > LIVE_MAX_BUFFER) {
      LIVE_CLIENTS.delete(res); res.destroy(); return;
    }
    res.write(frame);
  } catch { LIVE_CLIENTS.delete(res); try { res.destroy(); } catch { /* ignore */ } }
}
function cachedTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return Number(usage.prompt_cache_hit_tokens) || Number(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
}
// 积分估算：优先采用上游 usage.credit（官方真实扣费，含 thinking tokens 计费）；
// 上游未返回时回退到目录倍率推算：基准 1 积分 ≈ 8300 输入 / 3100 输出 tokens
// （官方余额每 pollMin 分钟校准一次）
function creditEstimate(model, prompt, completion, usage) {
  const reported = usage && Number(usage.credit);
  if (Number.isFinite(reported) && reported >= 0) {
    return Math.round(reported * 1000) / 1000;
  }
  const mult = modelMultiplier(model);
  if (!(mult > 0)) return 0;
  return Math.round(((Number(prompt) || 0) / 8300 + (Number(completion) || 0) / 3100) * mult * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// 凭据管理
// ---------------------------------------------------------------------------

function candidateAuthPaths() {
  const list = [];
  if (AUTH_FILE_ENV) list.push(AUTH_FILE_ENV);
  list.push(path.join(__dirname, 'auth.json'));
  const home = os.homedir();
  const cbDir = path.join(home, '.codebuddy', 'local_storage');
  try {
    if (fs.existsSync(cbDir)) {
      for (const f of fs.readdirSync(cbDir)) {
        if (f.endsWith('.info')) list.push(path.join(cbDir, f));
      }
    }
  } catch { /* ignore */ }
  // 以下为各平台标准目录环境变量（非本项目 CB_* 配置），缺省回落到常规路径
  const xdg = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  list.push(path.join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
  list.push(path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  list.push(path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
  return list;
}

function findAuthFile() {
  const files = [];
  for (const c of candidateAuthPaths()) {
    try {
      const st = fs.statSync(c);
      if (st.isDirectory()) {
        for (const f of fs.readdirSync(c)) {
          if (f.endsWith('.info') || f.endsWith('.json')) {
            const fp = path.join(c, f);
            files.push({ path: fp, mtime: fs.statSync(fp).mtimeMs });
          }
        }
      } else if (st.isFile()) {
        files.push({ path: c, mtime: st.mtimeMs });
      }
    } catch { /* 不存在 */ }
  }
  if (!files.length) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0].path;
}

function siteOfDomain(domain) {
  const d = String(domain || '').toLowerCase();
  if (d.includes('codebuddy.ai')) return 'intl';
  return 'cn'; // workbuddy.cn / copilot.tencent.com / codebuddy.cn 均按国内站处理
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    return JSON.parse(Buffer.from(p, 'base64').toString('utf-8'));
  } catch { return {}; }
}

const refreshChains = Object.create(null); // uid8 -> 刷新串行链（防巡检/保活/体检/对话并发双刷）

// 凭据文件写代次：本进程每次写/删凭据类文件都 +1，CredentialManager 据此立即失效缓存；
// 外部进程（如 IDE 插件）改写文件则靠 CRED_RECHECK_MS 节流的 stat 兜底发现。
let credFsGen = 0;
const CRED_RECHECK_MS = 1_000;
function statMtime(file) { try { return fs.statSync(file).mtimeMs; } catch { return 0; } }

class CredentialManager {
  constructor(filePath) {
    this.path = filePath;
    this._cached = null;
    this._mtime = 0;
    this._archiveMtime = 0;
    this._checkedGen = -1;
    this._checkedAt = 0;
    this._lock = Promise.resolve();
    this.session();
  }

  // 热路径每请求会调用 session() 十余次：同一写代次内 1s 只 stat 一次；
  // 自身文件或规范存档的 mtime 未变时不再重复 readFileSync + JSON.parse。
  _reloadIfStale() {
    const now = Date.now();
    if (this._cached !== null && this._checkedGen === credFsGen && now - this._checkedAt < CRED_RECHECK_MS) return this._cached;
    let mt;
    try { mt = fs.statSync(this.path).mtimeMs; }
    catch (e) { throw new Error(`无法读取凭据文件 ${this.path}: ${e.message}`); }
    let raw = null;
    if (this._cached === null || mt !== this._mtime || this._checkedGen !== credFsGen) {
      try { raw = JSON.parse(fs.readFileSync(this.path, 'utf-8')); }
      catch (e) { throw new Error(`无法读取凭据文件 ${this.path}: ${e.message}`); }
    }
    const base = raw || this._cached;
    const archive = path.join(AUTHS_DIR, stableAccountId(base));
    const isSelf = path.resolve(archive) === path.resolve(this.path);
    const amt = isSelf ? 0 : statMtime(archive);
    if (raw || amt !== this._archiveMtime) {
      // 自身或存档有变化：从自身文件重新合并（避免沿用上一轮已合并的 auth）
      let next = raw || JSON.parse(fs.readFileSync(this.path, 'utf-8'));
      if (amt) {
        try {
          const canonical = JSON.parse(fs.readFileSync(archive, 'utf8'));
          if (credentialIdentity(canonical, siteOfDomain) === credentialIdentity(next, siteOfDomain) &&
              Number(canonical.auth?.lastRefreshTime || 0) > Number(next.auth?.lastRefreshTime || 0)) {
            next = { ...next, auth: canonical.auth };
          }
        } catch { /* 存档损坏：沿用自身文件 */ }
      }
      this._cached = next;
      this._mtime = mt;
      this._archiveMtime = amt;
    }
    this._checkedGen = credFsGen;
    this._checkedAt = now;
    return this._cached;
  }

  session() { return this._reloadIfStale(); }

  site() { return siteOfDomain((this.session().auth || {}).domain); }

  base() { return SITES[this.site()].chatBase; }

  isExpired() {
    const s = this.session();
    const expiresAt = (s.auth && s.auth.expiresAt) || 0;
    return Date.now() >= expiresAt - 60_000;
  }

  buildHeaders() {
    const s = this.session();
    const auth = s.auth || {};
    const account = s.account || {};
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${auth.accessToken || ''}`,
      'X-User-Id': String(account.uid || ''),
      'X-Enterprise-Id': String(account.enterpriseId || ''),
      'X-Tenant-Id': String(account.enterpriseId || ''),
      'X-Domain': auth.domain || SITES[this.site()].domain,
      'User-Agent': USER_AGENT,
    };
  }

  async getHeaders() {
    this._lock = this._lock.then(() => {}, () => {});
    await this._lock;
    if (this.isExpired()) await this.refresh(false);
    return this.buildHeaders();
  }

  async refresh(force) {
    // 全局按账号串行化：巡检/保活/体检/对话并发触发时，同一账号只刷一次
    const s0 = this.session();
    const k = credentialIdentity(s0, siteOfDomain) || this.path;
    const prev = refreshChains[k] || Promise.resolve();
    const task = prev.then(() => {
      const archive = path.join(AUTHS_DIR, stableAccountId(s0));
      // Pin a queued refresh to its original account, even if auth.json was switched.
      const target = fs.existsSync(archive) ? credManager(archive) : this;
      if (credentialIdentity(target.session(), siteOfDomain) !== k) throw new Error('凭据身份已变更，请重试');
      return target._doRefresh(force);
    });
    const tail = task.catch(() => {});
    refreshChains[k] = tail;
    // 链尾结算后自清：长跑下账号删了又加，该 map 不留死钥匙
    tail.finally(() => { if (refreshChains[k] === tail) delete refreshChains[k]; });
    return task;
  }

  async _doRefresh(force) {
    const s = this.session();
    const auth = s.auth || {};
    // 双检：锁上排队期间 token 已被别的调用刷新过且仍有效 → 跳过（保活 force 不跳）
    if (!force && !this.isExpired() && auth.lastRefreshTime && Date.now() - auth.lastRefreshTime < 60_000) return;
    const headers = this.buildHeaders();
    headers['X-Refresh-Token'] = auth.refreshToken || '';
    headers['X-Auth-Refresh-Source'] = 'plugin';
    let data;
    try {
      const resp = await fetch(this.base() + REFRESH_PATH, {
        method: 'POST', headers, body: '{}', redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      data = await resp.json();
    } catch (e) {
      throw new Error(`刷新 token 网络失败: ${e.message}`);
    }
    if (!data || data.code !== 0 || !data.data) {
      throw new Error(`刷新 token 失败(凭据可能已被轮换，请在管理台重新手机号登录): ${JSON.stringify((data && data.msg) || data).slice(0, 200)}`);
    }
    this.applyNewAuth(data.data, s);
    log(`token 已自动刷新，新过期时间: ${new Date((s.auth && s.auth.expiresAt) || 0).toISOString()}`);
  }

  applyNewAuth(d, originalSession = this.session()) {
    const s = structuredClone(originalSession);
    const old = s.auth || {};
    const newAuth = { ...old, ...d };
    newAuth.domain = d.domain || old.domain || SITES[this.site()].domain;
    newAuth.lastRefreshTime = Math.max(Date.now(), Number(old.lastRefreshTime || 0) + 1);
    // 上游每次刷新都随新 token 下发全新的满窗口有效期（2026-09-05 实测原始响应：
    // expiresIn=60d、refreshExpiresIn=90d 均为满值）→ 到期时间必须以本次刷新为基准重算；
    // 旧逻辑只在字段缺失时才计算，导致倒计时冻结在登录日、界面逐日递减（已修）
    if (d.expiresIn) newAuth.expiresAt = Date.now() + d.expiresIn * 1000;
    if (d.refreshExpiresIn) newAuth.refreshExpiresAt = Date.now() + d.refreshExpiresIn * 1000;
    if (!newAuth.expiresAt && newAuth.expiresIn) newAuth.expiresAt = Date.now() + newAuth.expiresIn * 1000;
    if (!newAuth.refreshExpiresAt && newAuth.refreshExpiresIn) newAuth.refreshExpiresAt = Date.now() + newAuth.refreshExpiresIn * 1000;
    s.auth = newAuth;
    fs.mkdirSync(AUTHS_DIR, { recursive: true });
    syncCredentialCopies({ fs, path, session: s, originalFile: this.path,
      archiveFile: path.join(AUTHS_DIR, stableAccountId(s)), activeFile: path.join(__dirname, 'auth.json'),
      write: writeAuthFileAtomic, identify: value => credentialIdentity(value, siteOfDomain), report: storage.report });
    invalidateAccountsCache();
    // Do not retain this account's tokens in a manager whose auth.json was switched.
    this._cached = null; this._mtime = 0; this._archiveMtime = 0;
  }

  summary() {
    const s = this.session();
    const auth = s.auth || {};
    const acct = s.account || {};
    const site = SITES[this.site()];
    const expiresAt = auth.expiresAt || 0;
    const totalSec = Math.max(1, Math.floor((expiresAt - (auth.lastRefreshTime || STARTED_AT)) / 1000));
    return {
      auth_file: this.path,
      site: this.site(),
      siteLabel: site.label,
      domain: auth.domain,
      uid: acct.uid ? String(acct.uid).slice(0, 8) + '…' : null,
      nickname: acct.nickname ? String(acct.nickname)[0] + '**' : null,
      expiresAt,
      expiresSec: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
      totalSec,
      refreshExpiresAt: auth.refreshExpiresAt || null,
      token_expired: this.isExpired(),
    };
  }
}

// 凭据类文件 = auth.json 与 auths/ 下的账号档案（不含点开头的状态文件）；只有它们变动才让凭据缓存失效
function isCredentialFile(filePath) {
  const abs = path.resolve(filePath), base = path.basename(abs);
  if (abs === path.resolve(__dirname, 'auth.json') || (AUTH_FILE_ENV && abs === path.resolve(AUTH_FILE_ENV))) return true;
  return path.dirname(abs) === path.resolve(AUTHS_DIR) && base.endsWith('.json') && !base.startsWith('.');
}
function writeAuthFileAtomic(filePath, obj) { try { storage.write(filePath, obj); } finally { if (isCredentialFile(filePath)) credFsGen++; } }
function atomicWriteJson(filePath, obj) { try { storage.write(filePath, obj); } finally { if (isCredentialFile(filePath)) credFsGen++; } }
function unlinkCredFile(filePath) { try { fs.unlinkSync(filePath); } finally { credFsGen++; credManagers.delete(path.resolve(filePath)); } }

// CredentialManager 实例池（按绝对路径复用）：对话选号/巡检/体检不再每次新建实例重读文件。
// 实例自身按写代次 + mtime 自动失效，删号时移出池。
const credManagers = new Map();
function credManager(filePath) {
  const key = path.resolve(filePath);
  let cm = credManagers.get(key);
  if (cm) { cm.session(); return cm; } // 保持原语义：文件不可读时抛错
  cm = new CredentialManager(filePath);
  credManagers.set(key, cm);
  return cm;
}

// ---------------------------------------------------------------------------
// 高频同步落盘合批：recordUsage/bumpKeyUsage 等热路径不直接 writeFileSync
//（同步写会卡住事件循环），先标脏排期，delayMs 内多次调用合并为一次原子写。
// 定时器保持 ref（进程不退出就总能落盘）；SIGINT/SIGTERM 处理器里 flush 兜底。
// 管理台低频写操作（建删 key、恢复备份）仍走原函数立即落盘，语义不变。
// ---------------------------------------------------------------------------
const DEFER_WRITE_MS = 5_000;
const _deferredWrites = new Map(); // key -> { fn, timer }
const _inflightDeferredWrites = new Map(); // preserve synchronous fallbacks until asynchronous disk writes finish
// fn 可返回 Promise（异步写）：失败同样 30s 后重试
function deferWrite(key, fn, delayMs = DEFER_WRITE_MS) {
  let e = _deferredWrites.get(key);
  if (!e) { e = { fn: null, timer: null }; _deferredWrites.set(key, e); }
  e.fn = fn;
  if (e.timer) return; // 已排期，到期时写最新 fn（闭包读 live 状态）
  const retry = error => { log(`[storage] ${key} 待写入，将重试: ${error.message}`); if (!_deferredWrites.has(key)) deferWrite(key, e.fn, 30_000); };
  e.timer = setTimeout(() => {
    _deferredWrites.delete(key);
    try {
      const r = e.fn();
      if (r && typeof r.then === 'function') {
        _inflightDeferredWrites.set(key, e);
        r.catch(retry).finally(() => { if (_inflightDeferredWrites.get(key) === e) _inflightDeferredWrites.delete(key); });
      }
    } catch (error) { retry(error); }
  }, delayMs);
}
// 停机/致命退出：同步落盘所有待写项（fn.sync 为同步版本，优先使用）
function flushDeferredWrites() {
  const pending = new Map(_inflightDeferredWrites);
  for (const [key, e] of _deferredWrites) { clearTimeout(e.timer); pending.set(key, e); }
  _deferredWrites.clear(); _inflightDeferredWrites.clear();
  for (const { fn } of pending.values()) { try { (fn.sync || fn)(); } catch {} }
}

// ---------------------------------------------------------------------------
// 多账号存储：auths/ 目录存档所有登录过的账号；auth.json 始终是"当前启用"的凭据
// ---------------------------------------------------------------------------

const AUTHS_DIR = path.join(__dirname, 'auths');
let activeAccountId = null;

// ---------------------------------------------------------------------------
// 附加 API Key（分享给朋友用）：可限模型 / 限账号 / 限每日请求额度
//   仅对 /v1/* 生效；一律无管理台权限（管理台只认主 Key），避免暴露账号存档与统计
// ---------------------------------------------------------------------------

const APIKEYS_FILE = path.join(__dirname, '.api-keys.json');
let apiKeys = [];
try {
  const j = JSON.parse(fs.readFileSync(APIKEYS_FILE, 'utf-8'));
  if (Array.isArray(j)) apiKeys = j.filter(e => e && typeof e.key === 'string' && e.key);
} catch { /* 首次无配置 */ }
function saveApiKeys() {
  atomicWriteJson(APIKEYS_FILE, apiKeys);
}

// 管理台列表用（不返回完整 key 以免页面泄漏，另给 masked + 后 4 位便于辨认）
function apiKeysForDisplay() {
  const today = todayStr();
  return apiKeys.map(e => ({
    id: keyId(e), quotaPolicy: 'requests-hard-tokens-credit-settlement',
    name: e.name || '',
    masked: maskKey(e.key),
    tail: String(e.key).slice(-4),
    models: e.models || [],
    accounts: e.accounts || [],
    dailyLimit: e.dailyLimit || 0,
    dailyTokenLimit: e.dailyTokenLimit || 0,
    dailyCreditLimit: e.dailyCreditLimit || 0,
    disabled: !!e.disabled,
    createdAt: e.createdAt || null,
    usedToday: (e.usage && e.usage.date === today) ? (e.usage.requests || 0) : 0,
    tokensToday: (e.usage && e.usage.date === today) ? (e.usage.tokens || 0) : 0,
    creditToday: (e.usage && e.usage.date === today) ? (e.usage.credit || 0) : 0,
  }));
}

// 附加 Key 每次成功请求后记账（在记录用量处调用；credit 为本次积分消耗估算）
function totalTokensOf(usage) {
  return Number(usage?.total_tokens) || (Number(usage?.prompt_tokens) || 0) + (Number(usage?.completion_tokens) || 0);
}
function bumpKeyUsage(ctx, tokens, credit) {
  if (quotaLedger.settle(ctx, tokens, credit)) deferWrite('apiKeys', saveApiKeysAsync);
}
function saveApiKeysAsync() { return storage.writeAsync(APIKEYS_FILE, apiKeys, { compact: false }); }
saveApiKeysAsync.sync = saveApiKeys;

// ---------------------------------------------------------------------------
// 外部反代板块 + 内置协议板块（opencode / trae / qoder 本进程内直接反代）
//   custom：外部部署的 OpenAI 兼容上游注册 baseUrl+key；builtin：管理台配凭据即用。
//   模型以 `前缀/模型名` 并入 /v1/models；聊天按前缀路由，流式/非流式透传，记账照常。
// ---------------------------------------------------------------------------

const EXTP_FILE = path.join(__dirname, '.ext-providers.json');
let extProviders = [];
try {
  const j = JSON.parse(fs.readFileSync(EXTP_FILE, 'utf-8'));
  if (Array.isArray(j)) extProviders = j.filter(e => e && e.id && e.baseUrl);
} catch { /* 首次无配置 */ }
function saveExtProviders() {
  writeAuthFileAtomic(EXTP_FILE, extProviders);
}
function extById(id) { return extProviders.find(e => e.id === id) || null; }
// baseUrl 统一规整：去掉结尾斜杠；未以 /v1 结尾的自动补上（这些反代都暴露 /v1/*）
// noV1: trae/qoder 等内置协议的上游是裸域（API 路径非 /v1/*），不补后缀
function extNormalizeBase(u, noV1) { return hardening.normalizeBase(u, noV1); }

// model 形如 `前缀/上游模型名`；返回 { prov, upstreamModel } 或 null
function extParseModel(model) {
  const m = String(model || '');
  const i = m.indexOf('/');
  if (i <= 0) return null;
  const prefix = m.slice(0, i);
  const prov = extProviders.find(e => e.enabled !== false && e.prefix === prefix);
  if (!prov) return null;
  return { prov, upstreamModel: m.slice(i + 1) };
}
// 该板块对外暴露的上游模型清单：models 白名单优先，否则用探测缓存；空 = 尚未探测/未限制
function extExposed(prov) {
  if (prov.models && prov.models.length) return prov.models;
  return prov.knownModels || [];
}
// 对外名 → 上游名（modelMap 非空时生效；未配置条目按原名透传）
function extUpstreamName(prov, exposed) {
  const mm = prov.modelMap || {};
  return mm[exposed] || exposed;
}
// 冷却：上游不可用标记（截止时间戳），命中原因分类借鉴 CPA/sub2api
//   401/403 → 30min；429 → Retry-After 或 60s；5xx/网络 → 60s；冷却期请求直接 429 不打上游
function extCooldownMs(status, retryAfterSec) {
  if (status === 401 || status === 403) return 30 * 60_000;
  if (status === 429) return Math.max(10_000, Math.min(Number(retryAfterSec) * 1000 || 60_000, 30 * 60_000));
  return 60_000; // 5xx / 网络错误 / 超时
}
function extMarkDown(prov, status, retryAfterSec, reason) {
  prov.downUntil = Date.now() + extCooldownMs(status, retryAfterSec);
  prov.downReason = sanitizeRemoteText(reason || `HTTP ${status}`, 120);
  deferWrite('extProviders', saveExtProviders, 1_000);
}
function extIsDown(prov) {
  return prov.downUntil && prov.downUntil > Date.now();
}
function extForDisplay() {
  return extProviders.map(e => ({
    id: e.id, name: e.name || e.id, type: e.type || 'custom', prefix: e.prefix || e.id,
    baseUrl: e.baseUrl, enabled: e.enabled !== false, keyMasked: e.key ? maskKey(e.key) : '',
    models: e.models || [], modelMap: e.modelMap || {}, knownModels: e.knownModels || [],
    modelsFetchedAt: e.modelsFetchedAt || null,
    downUntil: e.downUntil || 0, downReason: e.downReason || '',
    note: e.note || '', createdAt: e.createdAt || null,
    credsSummary: extCredsSummary(e),
    traeLoginUrl: (e.type === 'trae' && e.creds) ? traeLoginUrl(e) : null,
  }));
}
// 凭据脱敏摘要：管理台展示登录状态用，绝不含 token 本体
function extCredsSummary(e) {
  const c = e.creds || {};
  const t = e.type;
  if (t === 'opencode') {
    return { anonymous: !(c.key || e.key) };
  }
  if (!e.creds) return null;
  if (t === 'trae') {
    return {
      realm: traeRealm(e), uid: c.uid || '', machineId: c.machineId || '', deviceId: c.deviceId || '',
      hasRefresh: !!c.refreshToken, hasAccess: !!c.accessToken,
      expiresAt: c.expiresAt || 0, refreshExpiresAt: c.refreshExpiresAt || 0,
    };
  }
  if (t === 'qoder') {
    const s = c.session || {};
    return {
      hasPat: !!c.pat, uid: s.uid || '', name: s.name || '', email: s.email || '',
      plan: s.plan || '', userType: s.userType || '', sessionExpiresAt: s.expireTime || 0,
    };
  }
  return null;
}
// trae 登录链接（用户走浏览器登录后回调带 refreshToken，粘回来即可）
// machine_id/device_id 先落盘再进 URL，保证回调解析出的凭据与请求指纹一致
function traeLoginUrl(prov) {
  const cfg = traeCfg(prov);
  const c = prov.creds || (prov.creds = {});
  let changed = false;
  if (!c.machineId) { c.machineId = crypto.randomBytes(32).toString('hex'); changed = true; }
  if (!c.deviceId) { c.deviceId = String(Math.floor(Math.random() * 9e15) + 1e15).slice(0, 16); changed = true; }
  if (changed) saveExtProviders();
  return cfg.loginBase + '/authorization?login_version=1&auth_from=solo&login_channel=native_ide&client_id='
    + cfg.clientId + '&auth_callback_url=' + encodeURIComponent('http://127.0.0.1:18080/authorize')
    + '&machine_id=' + c.machineId + '&device_id=' + c.deviceId;
}
// 探测板块：拉它的 /models 校验连通与 key，缓存模型目录
async function extProbe(prov) {
  const base = prov.baseUrl;
  const headers = { 'Accept': 'application/json' };
  if (prov.key) headers['Authorization'] = 'Bearer ' + prov.key;
  const t0 = Date.now();
  const resp = await fetch(base + '/models', { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  let data = null;
  try { data = await resp.json(); } catch { /* ignore */ }
  if (resp.status >= 400) {
    const err = new Error(sanitizeRemoteText((data && (data.error && data.error.message || data.message || data.msg)) || `HTTP ${resp.status}`, 160));
    err.status = resp.status;
    throw err;
  }
  const ids = ((data && data.data) || []).map(m => m && m.id).filter(Boolean);
  prov.knownModels = ids;
  prov.modelsFetchedAt = Date.now();
  saveExtProviders();
  return { latencyMs: Date.now() - t0, count: ids.length, models: ids };
}

// usage 归一化：同时认 prompt_tokens/completion_tokens 与 input_tokens/output_tokens 两套字段
function extNormUsage(u) {
  if (!u || typeof u !== 'object') return u;
  if (u.prompt_tokens == null && u.input_tokens != null) u.prompt_tokens = u.input_tokens;
  if (u.completion_tokens == null && u.output_tokens != null) u.completion_tokens = u.output_tokens;
  if (u.total_tokens == null) u.total_tokens = (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0);
  return u;
}

// 板块聊天转发：流式原样转发 SSE（仅解析统计不改写内容），非流式聚合后返回
async function handleExtChat(req, res, ctx, route, payload) {
  const { prov } = route;
  // 内置协议适配器（opencode/trae/qoder 直接在本进程内反代，无需外部板块）
  if (prov.type && prov.type !== 'custom' && BUILTIN_EXT[prov.type]) {
    return builtinExtChat(req, res, ctx, prov, route.upstreamModel, payload);
  }
  // 冷却期直接拒，不打上游（管理台可点「探测」提前解除）；流水记 err 让流水页标红
  if (extIsDown(prov)) {
    const rid0 = crypto.randomBytes(4).toString('hex');
    const wait = Math.ceil((prov.downUntil - Date.now()) / 1000);
    pushRecentRequest({ rid: rid0, model: prov.prefix + '/' + route.upstreamModel, uid8: null, name: '板块:' + prov.prefix, stream: null, finish: null, ttft: null, durMs: 0, prompt: 0, cached: 0, completion: 0, total: 0, credit: 0, filter: false, tools: 0, err: 429, msg: sanitizeRemoteText(`冷却中: ${prov.downReason || '上游故障'}`, 120) });
    return json(res, 429, openaiError(429, `板块 ${prov.prefix} 冷却中（${prov.downReason || '上游故障'}），约 ${wait}s 后恢复`, 'provider_cooldown'));
  }
  // payload 已在 handleChat 解析并校验（非空 messages 数组），这里不再重复 JSON.parse
  const messages = payload.messages;

  const upstreamModel = extUpstreamName(prov, route.upstreamModel);
  const clientWantsStream = !!payload.stream;
  const body = {};
  for (const k of PASSTHROUGH_BODY_KEYS) if (k in payload) body[k] = payload[k];
  body.model = upstreamModel;
  body.stream = true;
  if (clientWantsStream && !('stream_options' in body)) body.stream_options = { include_usage: true };
  if (DESENSITIZE) body.messages = desensitizeMessages(body.messages);

  // 附加 Key 限额校验（按带前缀的模型名匹配白名单）
  if (ctx && ctx.restrictions) {
    const err = keyRestrictionError(ctx, payload.model);
    if (err) return json(res, err.status, err.body);
  }

  const rid = crypto.randomBytes(4).toString('hex');
  const t0 = Date.now();
  log(`[${rid}] ▶ ${payload.model} → 板块 ${prov.name || prov.prefix} (${prov.baseUrl}) | stream=${clientWantsStream} | msgs=${messages.length}` +
      (ctx && ctx.restrictions ? ` | key=${ctx.name || maskKey(ctx.key)}` : ''));

  const abort = req.scope;

  const headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
  if (prov.key) headers['Authorization'] = 'Bearer ' + prov.key;
  let resp = null;
  const hto = withHeadersTimeout(abort.signal);
  try {
    if (ctx.reservation) ctx.reservation.started = true;
    resp = await fetch(prov.baseUrl + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body),
      redirect: 'error', signal: hto.signal,
    });
  } catch (e) {
    if (requestRuntime.outcomeOf(e, req.scope.signal) !== 'client_cancelled' && !e.config) extMarkDown(prov, 0, 0, sanitizeRemoteText(e.message, 160));
    return chatFailure(req, res, e, { rid, model: payload.model, name: '板块:' + prov.prefix, stream: clientWantsStream, durMs: Date.now() - t0 });
  } finally { hto.clear(); }
  if (resp.status >= 400) {
    STATS.errors++;
    let detail = `HTTP ${resp.status}`;
    try { const d = JSON.parse(await readUpstreamText(resp, req.scope)); detail = sanitizeRemoteText((d && (d.error && d.error.message || d.message || d.msg)) || detail, 200); } catch { /* ignore */ }
    // 429 读 Retry-After；401/403 长冷却；其余 4xx 视为客户端问题不冷却
    const ra = Number(resp.headers.get('retry-after')) || 0;
    if (resp.status === 401 || resp.status === 403 || resp.status === 429 || resp.status >= 500) {
      extMarkDown(prov, resp.status, ra, detail);
    }
    log(`[${rid}] ✗ 板块 ${prov.prefix} 返回 ${resp.status}: ${detail}${extIsDown(prov) ? '（已冷却至 ' + new Date(prov.downUntil).toLocaleTimeString() + '）' : ''}`);
    pushRecentRequest({ rid, model: payload.model, uid8: null, name: '板块:' + prov.prefix, stream: clientWantsStream, finish: null, ttft: null, durMs: Date.now() - t0, prompt: 0, cached: 0, completion: 0, total: 0, credit: 0, filter: false, tools: 0, err: resp.status, msg: sanitizeRemoteText(detail, 120) });
    return json(res, resp.status, openaiError(resp.status, `${prov.prefix}: ${detail}`));
  }
  // 成功：清除冷却标记（合批落盘，不在请求路径同步写）；上游已接受 → 切换为流式时长约束
  if (prov.downUntil) { prov.downUntil = 0; prov.downReason = ''; deferWrite('extProviders', saveExtProviders, 1_000); }
  req.scope.streaming();

  if (clientWantsStream) {
    return extRelayStream(req, res, ctx, prov, payload, resp, rid, t0);
  }

  try {
    const completion = await collectStream(resp, () => {}, req.scope);
    const durMs = Date.now() - t0;
    const usage = extNormUsage(completion.usage) || {};
    completion.usage = usage;
    const ch = (completion.choices || [{}])[0];
    completion.model = payload.model; // 对外保持带前缀的模型名
    log(`[${rid}] ◀ ${payload.model}@板块:${prov.prefix} | ${(durMs / 1000).toFixed(1)}s | 入 ${usage.prompt_tokens ?? '?'} | 出 ${usage.completion_tokens ?? '?'} | finish=${ch.finish_reason}`);
    pushRecentRequest({ rid, model: payload.model, uid8: null, name: '板块:' + prov.prefix, stream: false, finish: ch.finish_reason || null, ttft: null, durMs, prompt: Number(usage.prompt_tokens) || 0, cached: cachedTokensOf(usage), completion: Number(usage.completion_tokens) || 0, total: totalTokensOf(usage), credit: 0, filter: false, tools: (ch.message && ch.message.tool_calls || []).length });
    recordUsage(payload.model, null, completion.usage, '板块:' + prov.prefix);
    bumpKeyUsage(ctx, totalTokensOf(usage), 0);
    return json(res, 200, completion);
  } catch (e) {
    if (e.code === 1005 || e.code === 4008) extMarkDown(prov, 429, 0, '上游额度耗尽');
    return chatFailure(req, res, e, { rid, model: payload.model, name: '板块:' + prov.prefix, stream: false, durMs: Date.now() - t0 });
  }
}

// ---------------------------------------------------------------------------
// 内置上游协议适配器（板块 type ∈ {opencode, trae, qoder} 时启用，无需外部部署）
//   约定：adapter.chat(prov, upstreamModel, payload, clientWantsStream, signal)
//            → { resp, onData }；resp 为上游 SSE 响应，onData(rawLine, eventName)
//              把每条上游 SSE data 解析成 OpenAI chunk 片段或 null；抛错 = 上游级错误
//         adapter.probe(prov) → { latencyMs, count, models }（写 knownModels）
//   chunkObj = OpenAI 标准 chunk 片段（choices[0].delta / finish_reason / usage）
// ---------------------------------------------------------------------------

const BUILTIN_EXT = {
  opencode: { label: 'OpenCode Zen（匿名免费层，可填 key 走付费）', chat: builtinOpencodeChat, probe: builtinOpencodeProbe, quota: builtinOpencodeQuota },
  trae:     { label: 'Trae SOLO（refreshToken 登录，自动轮换）',   chat: builtinTraeChat,   probe: builtinTraeProbe,   quota: builtinTraeQuota },
  qoder:    { label: 'Qoder（PAT 换会话，lite 模型）',            chat: builtinQoderChat,   probe: builtinQoderProbe,  quota: builtinQoderQuota },
};

// custom（外部 OpenAI 兼容反代）探测额度：按 new-api/one-api 约定试 /dashboard/billing/*，
// 拿不到也不报错——quota 状态区显示「上游不提供额度接口」
async function extQuotaCustom(prov) {
  const root = String(prov.baseUrl || '').replace(/\/v1\/?$/i, '');
  const headers = {};
  if (prov.key) headers['Authorization'] = 'Bearer ' + prov.key;
  const lines = [];
  try {
    const r = await fetch(root + '/dashboard/billing/usage', { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const d = await r.json().catch(() => null);
    if (r.ok && d && (d.total_usage != null || d.total != null)) {
      const used = Number(d.total_usage ?? d.total) / 500000;
      lines.push({ k: '已用额度', v: '$' + used.toFixed(2) });
    }
    const r2 = await fetch(root + '/dashboard/billing/subscription', { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const d2 = await r2.json().catch(() => null);
    if (r2.ok && d2) {
      const hard = Number(d2.hard_limit_usd ?? d2.hard_limit ?? 0);
      if (hard > 0 && hard < 1e8) lines.push({ k: '额度上限', v: '$' + hard.toFixed(2) });
      if (d2.soft_limit_usd != null && Number(d2.soft_limit_usd) > 0) lines.push({ k: '软上限', v: '$' + Number(d2.soft_limit_usd).toFixed(2) });
    }
  } catch { /* 上游无 billing 接口或网络失败 */ }
  if (!lines.length) {
    lines.push({ k: '额度', v: '上游无 billing 接口', dim: true });
    if (prov.key) lines.push({ k: 'Key', v: maskKey(prov.key), dim: true });
    else lines.push({ k: 'Key', v: '未配置（无鉴权）', dim: true });
  }
  return { title: '额度（new-api/one-api 约定接口）', lines };
}

// 板块额度/凭据状态查询：内置走各自协议，custom 走 new-api 约定，结果缓存 60s
async function extQuota(prov, force) {
  const cached = prov.quotaCache;
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.data;
  let data;
  try {
    const adapter = BUILTIN_EXT[prov.type || ''];
    data = adapter && adapter.quota ? await adapter.quota(prov) : await extQuotaCustom(prov);
  } catch (e) {
    data = { title: '额度 / 凭据', lines: [{ k: '查询失败', v: sanitizeRemoteText(e.message, 120), bad: true }] };
  }
  data.at = Date.now();
  prov.quotaCache = { at: data.at, data };
  return data;
}

// 将「上游 SSE → 标准 OpenAI chunk」的流转发到客户端；onData 由具体适配器提供
async function extPumpStream(res, resp, emitChunk, scope) {
  const reader = scope ? scope.reader(resp) : resp.body.getReader();
  const decoder = new TextDecoder(); let buf = '', eventName = null, bytes = 0;
  const lineIn = async line => {
    line = line.replace(/\r$/, '');
    if (!line.trim()) { eventName = null; return; }
    if (line.startsWith('event:')) { eventName = line.slice(6).trim(); return; }
    if (line.startsWith('data:')) await emitChunk(line.slice(5).trim(), eventName);
  };
  try {
    for (;;) {
      const { done, value } = await readWithIdle(reader, UPSTREAM_STREAM_IDLE_MS, scope?.signal);
      if (done) { if (buf) await lineIn(buf); break; }
      bytes += value.length;
      if (bytes > 64 * 1024 * 1024) throw new Error('upstream response exceeds size limit');
      buf += decoder.decode(value, { stream: true });
      if (buf.length > 8 * 1024 * 1024) throw new Error('SSE event exceeds size limit');
      const lines = [];
      buf = requestRuntime.splitLines(buf, l => lines.push(l));
      for (const line of lines) await lineIn(line);
    }
  } finally { if (scope) scope.release(reader); else requestRuntime.stopReader(reader); }
}

// 适配器统一出口：冷却检查 → 凭据/请求构造 → 上游 fetch → 流式/聚合 → 记账
async function builtinExtChat(req, res, ctx, prov, upstreamModel, payload) {
  const adapter = BUILTIN_EXT[prov.type];
  if (extIsDown(prov)) {
    const rid0 = crypto.randomBytes(4).toString('hex');
    const wait = Math.ceil((prov.downUntil - Date.now()) / 1000);
    pushRecentRequest({ rid: rid0, model: prov.prefix + '/' + upstreamModel, uid8: null, name: '板块:' + prov.prefix, stream: null, finish: null, ttft: null, durMs: 0, prompt: 0, cached: 0, completion: 0, total: 0, credit: 0, filter: false, tools: 0, err: 429, msg: sanitizeRemoteText(`冷却中: ${prov.downReason || '上游故障'}`, 120) });
    return json(res, 429, openaiError(429, `板块 ${prov.prefix} 冷却中（${prov.downReason || '上游故障'}），约 ${wait}s 后恢复`, 'provider_cooldown'));
  }
  const messages = payload.messages;
  const clientWantsStream = !!payload.stream;
  if (ctx && ctx.restrictions) {
    const err = keyRestrictionError(ctx, payload.model);
    if (err) return json(res, err.status, err.body);
  }

  const rid = crypto.randomBytes(4).toString('hex');
  const t0 = Date.now();
  log(`[${rid}] ▶ ${payload.model} → 内置板块 ${prov.name || prov.prefix} (${prov.type}) | stream=${clientWantsStream} | msgs=${messages.length}` +
      (ctx && ctx.restrictions ? ` | key=${ctx.name || maskKey(ctx.key)}` : ''));

  const abort = req.scope;

  let prepared;
  const hto = withHeadersTimeout(abort.signal);
  try {
    if (ctx.reservation) ctx.reservation.started = true;
    const pending = adapter.chat(prov, upstreamModel, payload, clientWantsStream, hto.signal);
    pending.then(p => { if (hto.signal.aborted) p.resp?.body?.cancel().catch(() => {}); }, () => {});
    prepared = await requestRuntime.abortable(pending, hto.signal);
  } catch (e) {
    if (requestRuntime.outcomeOf(e, req.scope.signal) !== 'client_cancelled' && !e.config) extMarkDown(prov, 0, 0, sanitizeRemoteText(e.message, 160));
    return chatFailure(req, res, e, { rid, model: payload.model, name: '板块:' + prov.prefix, stream: clientWantsStream, durMs: Date.now() - t0 });
  } finally { hto.clear(); }
  const resp = prepared.resp;
  if (resp.status >= 400) {
    STATS.errors++;
    let detail = `HTTP ${resp.status}`;
    try { const d = JSON.parse(await readUpstreamText(resp, req.scope)); detail = sanitizeRemoteText((d && (d.error && (d.error.message || d.error.code) || d.message || d.msg)) || detail, 200); } catch { /* ignore */ }
    const ra = Number(resp.headers.get('retry-after')) || 0;
    if (resp.status === 401 || resp.status === 403 || resp.status === 429 || resp.status >= 500) {
      extMarkDown(prov, resp.status, ra, detail);
    }
    log(`[${rid}] ✗ 板块 ${prov.prefix} 返回 ${resp.status}: ${detail}`);
    pushRecentRequest({ rid, model: payload.model, uid8: null, name: '板块:' + prov.prefix, stream: clientWantsStream, finish: null, ttft: null, durMs: Date.now() - t0, prompt: 0, cached: 0, completion: 0, total: 0, credit: 0, filter: false, tools: 0, err: resp.status, msg: sanitizeRemoteText(detail, 120) });
    return json(res, resp.status, openaiError(resp.status, `${prov.prefix}: ${detail}`));
  }
  if (prov.downUntil) { prov.downUntil = 0; prov.downReason = ''; deferWrite('extProviders', saveExtProviders, 1_000); }
  req.scope.streaming();

  const emitId = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(t0 / 1000);
  const stats = { usage: null, finish: null };
  let streamFailure = null;
  let firstByteAt = 0;

  // 适配器把上游行 → OpenAI chunk 对象；这里负责发回客户端与统计
  const emitChunk = (raw, evName) => {
    if (raw === '[DONE]') return;
    let obj;
    try { obj = prepared.onData(raw, evName); } catch (e) {
      // 适配器抛错 = 上游级错误（如 trae event:error 1005 额度耗尽）
      const err = new Error(sanitizeRemoteText(e.message || String(e), 160));
      err.code = e.code;
      throw err;
    }
    if (!obj) return;
    if (!obj.id) obj.id = emitId;
    if (!obj.created) obj.created = created;
    if (payload.model && !obj.model) obj.model = payload.model;
    if (obj.usage) stats.usage = extNormUsage(obj.usage);
    for (const ch of obj.choices || []) if (ch.finish_reason) stats.finish = ch.finish_reason;
    return obj;
  };

  if (clientWantsStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    try {
      await extPumpStream(res, resp, async (raw, evName) => {
        const obj = emitChunk(raw, evName);
        if (obj) {
          if (!firstByteAt) firstByteAt = Date.now();
          await requestRuntime.writeChunk(res, 'data: ' + JSON.stringify(obj) + '\n\n', req.scope.signal);
        }
      }, req.scope);
      const tail = { id: emitId, object: 'chat.completion.chunk', created, model: payload.model,
        choices: [{ index: 0, delta: {}, finish_reason: stats.finish || 'stop' }] };
      res.write('data: ' + JSON.stringify(tail) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      if (e.code === 1005 || e.code === 4008) extMarkDown(prov, 429, 0, '上游额度耗尽');
      streamFailure = chatFailure(req, res, e);
    }
    const durMs = Date.now() - t0;
    const usage = stats.usage || {};
    log(`[${rid}] ◀ ${payload.model}@板块:${prov.prefix} | 首字 ${firstByteAt ? firstByteAt - t0 : '?'}ms | ${(durMs / 1000).toFixed(1)}s | 入 ${usage.prompt_tokens ?? '?'} | 出 ${usage.completion_tokens ?? '?'} | finish=${stats.finish}`);
    pushRecentRequest({ ...streamFailure, rid, model: payload.model, uid8: null, name: '板块:' + prov.prefix, stream: true, finish: stats.finish, ttft: firstByteAt ? firstByteAt - t0 : null, durMs, prompt: Number(usage.prompt_tokens) || 0, cached: cachedTokensOf(usage), completion: Number(usage.completion_tokens) || 0, total: totalTokensOf(usage), credit: 0, filter: false, tools: 0 });
    recordUsage(payload.model, null, stats.usage, '板块:' + prov.prefix);
    bumpKeyUsage(ctx, totalTokensOf(usage), 0);
    return;
  }

  // 非流式：聚合 chunk → 完整 completion
  const contentParts = [], reasoningParts = [];
  const toolCalls = new Map();
  try {
    await extPumpStream(res, resp, async (raw, evName) => {
      const obj = emitChunk(raw, evName);
      if (!obj) return;
      for (const ch of obj.choices || []) {
        const d = ch.delta || {};
        if (d.reasoning_content) reasoningParts.push(d.reasoning_content);
        if (d.content) contentParts.push(d.content);
        for (const tc of d.tool_calls || []) {
          const i = tc.index || 0;
          const slot = toolCalls.get(i) || { id: null, name: null, arguments: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function && tc.function.name) slot.name = tc.function.name;
          if (tc.function && tc.function.arguments) slot.arguments += tc.function.arguments;
          toolCalls.set(i, slot);
        }
      }
    }, req.scope);
  } catch (e) {
    if (e.code === 1005 || e.code === 4008) extMarkDown(prov, 429, 0, '上游额度耗尽');
    return chatFailure(req, res, e, { rid, model: payload.model, name: '板块:' + prov.prefix, stream: false, durMs: Date.now() - t0 });
  }
  const tcs = toolCalls.size
    ? [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({ id: v.id, type: 'function', function: { name: v.name, arguments: v.arguments } }))
    : null;
  const message = { role: 'assistant', content: contentParts.join('') || null };
  if (reasoningParts.length) message.reasoning_content = reasoningParts.join('');
  if (tcs) message.tool_calls = tcs;
  const durMs = Date.now() - t0;
  const usage = stats.usage || {};
  const completion = {
    id: emitId, object: 'chat.completion', created, model: payload.model,
    choices: [{ index: 0, message, finish_reason: stats.finish || (tcs ? 'tool_calls' : 'stop') }],
    usage,
  };
  log(`[${rid}] ◀ ${payload.model}@板块:${prov.prefix} | ${(durMs / 1000).toFixed(1)}s | 入 ${usage.prompt_tokens ?? '?'} | 出 ${usage.completion_tokens ?? '?'} | finish=${completion.choices[0].finish_reason}`);
  pushRecentRequest({ rid, model: payload.model, uid8: null, name: '板块:' + prov.prefix, stream: false, finish: completion.choices[0].finish_reason, ttft: null, durMs, prompt: Number(usage.prompt_tokens) || 0, cached: cachedTokensOf(usage), completion: Number(usage.completion_tokens) || 0, total: totalTokensOf(usage), credit: 0, filter: false, tools: tcs ? tcs.length : 0 });
  recordUsage(payload.model, null, usage, '板块:' + prov.prefix);
  bumpKeyUsage(ctx, totalTokensOf(usage), 0);
  return json(res, 200, completion);
}

// custom 板块的流式透传：原始字节原样回客户端，仅解析统计不改写内容
async function extRelayStream(req, res, ctx, prov, payload, resp, rid, t0) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  let firstByteAt = 0;
  const stats = { usage: null, finish: null, model: null };
  let streamFailure = null;
  try {
    const reader = req.scope.reader(resp);
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await readWithIdle(reader, UPSTREAM_STREAM_IDLE_MS, req.scope.signal);
      if (done) break;
      if (value && value.length) {
        if (!firstByteAt) firstByteAt = Date.now();
        await requestRuntime.writeChunk(res, value, req.scope.signal);
        buf += decoder.decode(value, { stream: true });
        if (buf.length > 8 * 1024 * 1024) throw new Error('SSE event exceeds size limit');
        buf = requestRuntime.splitLines(buf, rawLine => {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) return;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') return;
          try {
            const obj = JSON.parse(raw);
            if (obj.error) { const error = new Error(sanitizeRemoteText(obj.error.message || 'upstream SSE error', 160)); error.upstreamEvent = true; throw error; }
            if (obj.usage) stats.usage = extNormUsage(obj.usage);
            if (obj.model) stats.model = obj.model;
            for (const ch of obj.choices || []) if (ch.finish_reason) stats.finish = ch.finish_reason;
          } catch (error) { if (error.upstreamEvent) throw error; }
        });
      }
    }
    res.end();
  } catch (e) {
    streamFailure = chatFailure(req, res, e);
  }
  const durMs = Date.now() - t0;
  const usage = stats.usage || {};
  const cached = cachedTokensOf(usage);
  log(`[${rid}] ◀ ${payload.model}@板块:${prov.prefix} | 首字 ${firstByteAt ? firstByteAt - t0 : '?'}ms | ${(durMs / 1000).toFixed(1)}s | 入 ${usage.prompt_tokens ?? '?'} | 出 ${usage.completion_tokens ?? '?'} | finish=${stats.finish}`);
  pushRecentRequest({ ...streamFailure, rid, model: payload.model, uid8: null, name: '板块:' + prov.prefix, stream: true, finish: stats.finish, ttft: firstByteAt ? firstByteAt - t0 : null, durMs, prompt: Number(usage.prompt_tokens) || 0, cached, completion: Number(usage.completion_tokens) || 0, total: totalTokensOf(usage), credit: 0, filter: false, tools: 0 });
  recordUsage(payload.model, null, stats.usage, '板块:' + prov.prefix);
  bumpKeyUsage(ctx, totalTokensOf(usage), 0);
}

// ---- 模型可用性测试（管理台「测试」按钮）：真实打一条最小对话 ---------------
// custom 板块走与生产相同的请求构造；内置板块直接调适配器。
// 结果写入 prov.modelHealth[对外名] 供反代面板展示；失败不触发板块级冷却（测试是诊断动作）。
async function extTestModel(prov, exposedName) {
  const upstreamModel = extUpstreamName(prov, exposedName);
  const payload = {
    model: upstreamModel, stream: true,
    messages: [{ role: 'user', content: 'Reply with just: OK' }],
    max_tokens: 16,
  };
  const t0 = Date.now();
  const timeout = AbortSignal.timeout(45_000);
  const out = { ok: false, latencyMs: 0, ttft: null, tokens: null, preview: '', msg: '', finish: null };
  let resp = null;
  try {
    if (prov.type && prov.type !== 'custom' && BUILTIN_EXT[prov.type]) {
      const prepared = await BUILTIN_EXT[prov.type].chat(prov, upstreamModel, payload, true, timeout);
      resp = prepared.resp;
      if (resp.status >= 400) {
        let detail = 'HTTP ' + resp.status;
        try { const d = await resp.json(); detail = sanitizeRemoteText((d && (d.error && (d.error.message || d.error.code) || d.message || d.msg)) || detail, 160); } catch { /* ignore */ }
        out.msg = detail;
        return out;
      }
      let firstByteAt = 0, content = '';
      await extPumpStream(null, resp, (raw, evName) => {
        let obj = null;
        try { obj = prepared.onData(raw, evName); } catch (e) { throw e; }
        if (!obj) return;
        if (!firstByteAt) firstByteAt = Date.now();
        for (const ch of obj.choices || []) {
          if (ch.delta && ch.delta.content) content += ch.delta.content;
          if (ch.finish_reason) out.finish = ch.finish_reason;
        }
        if (obj.usage) out.tokens = extNormUsage(obj.usage);
      });
      out.ttft = firstByteAt ? firstByteAt - t0 : null;
      out.preview = content.slice(0, 60);
      out.ok = true;
      return out;
    }
    // custom：与 handleExtChat 相同构造
    const headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
    if (prov.key) headers['Authorization'] = 'Bearer ' + prov.key;
    const body = { ...payload, stream_options: { include_usage: true } };
    resp = await fetch(prov.baseUrl + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: timeout,
    });
    if (resp.status >= 400) {
      let detail = 'HTTP ' + resp.status;
      try { const d = await resp.json(); detail = sanitizeRemoteText((d && (d.error && d.error.message || d.message || d.msg)) || detail, 160); } catch { /* ignore */ }
      out.msg = detail;
      return out;
    }
    let firstByteAt = 0, content = '';
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await readWithIdle(reader, UPSTREAM_STREAM_IDLE_MS);
      if (done) break;
      if (!value || !value.length) continue;
      if (!firstByteAt) firstByteAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const obj = JSON.parse(raw);
          if (obj.usage) out.tokens = extNormUsage(obj.usage);
          for (const ch of obj.choices || []) {
            if (ch.delta && ch.delta.content) content += ch.delta.content;
            if (ch.finish_reason) out.finish = ch.finish_reason;
          }
        } catch { /* ignore */ }
      }
    }
    out.ttft = firstByteAt ? firstByteAt - t0 : null;
    out.preview = content.slice(0, 60);
    out.ok = true;
    return out;
  } catch (e) {
    out.msg = e.name === 'AbortError' || e.name === 'TimeoutError' ? '超时（45s）' : sanitizeRemoteText(e.message || String(e), 160);
    return out;
  } finally {
    out.latencyMs = Date.now() - t0;
  }
}

// ---- opencode (Zen 匿名免费层) --------------------------------------------
// 上游: https://opencode.ai/zen/v1；匿名 Bearer 'public'，硬约束：
//   stream=true + stream_options.include_usage + tools 含 bash/edit/glob/grep/read
//   session 形态 ses_[0-9a-f]{12}[0-9A-Za-z]{14}（否则 403 FreeTierError）
const OC_BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const OC_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
function ocSessionId(signal) {
  const s = String(signal || '');
  if (OC_SESSION_RE.test(s)) return s;
  const sum = crypto.createHash('sha256').update('ses\x00' + s).digest();
  const timePart = sum.slice(0, 6).toString('hex');
  // 14 位 base62：把 sum[6..16) 的 10 字节大整数逐位取模
  let n = BigInt('0x' + sum.slice(6, 16).toString('hex'));
  let out = '';
  for (let i = 0; i < 14; i++) { out = OC_BASE62[Number(n % 62n)] + out; n = n / 62n; }
  return 'ses_' + timePart + out;
}
function ocConversationSeed(messages) {
  for (const m of messages || []) {
    if (m && m.role === 'user') {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (c && c !== 'null') return c;
    }
  }
  return '';
}
const OC_CORE_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read'];
function ocEnsureTools(tools) {
  const arr = Array.isArray(tools) ? tools.slice() : [];
  const have = new Set(arr.map(t => t && t.function && t.function.name).filter(Boolean));
  for (const name of OC_CORE_TOOLS) {
    if (!have.has(name)) {
      arr.push({ type: 'function', function: { name, description: 'Agent tool ' + name, parameters: { type: 'object', properties: {} } } });
    }
  }
  return arr;
}
const OC_FREE_RE = /free/i;

function ocBase(prov) {
  let s = String(prov.baseUrl || '').trim().replace(/\/+$/, '') || 'https://opencode.ai/zen';
  if (!/^https?:/i.test(s)) s = 'https://' + s;
  if (!/\/v1$/i.test(s)) s += '/v1';
  return s;
}

async function builtinOpencodeChat(prov, upstreamModel, payload, wantStream, signal) {
  const key = (prov.creds && prov.creds.key) || prov.key || 'public';
  const anonymous = key === 'public';
  const ses = ocSessionId(ocConversationSeed(payload.messages) || crypto.randomBytes(8).toString('hex'));
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'User-Agent': 'opencode/1.18.31 (linux amd64; go1.25)',
    'x-opencode-client': 'cli',
    'x-opencode-session': ses,
    'x-session-affinity': ses,
    'X-Session-Id': ses,
    'x-opencode-request': 'req_' + crypto.randomBytes(16).toString('hex'),
    'x-opencode-project': 'prj_' + crypto.createHash('sha256').update('opencode2api:default-project').digest().slice(0, 12).toString('hex'),
    'Authorization': 'Bearer ' + key,
  };
  const body = {};
  for (const k of PASSTHROUGH_BODY_KEYS) if (k in payload) body[k] = payload[k];
  body.model = upstreamModel;
  body.stream = true;
  if (anonymous) {
    body.stream_options = { include_usage: true };
    body.tools = ocEnsureTools(payload.tools);
  }
  const resp = await fetch(ocBase(prov) + '/chat/completions', {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal,
  });
  return {
    resp,
    onData(raw) {
      if (raw === '[DONE]') return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
  };
}

async function builtinOpencodeProbe(prov) {
  const key = (prov.creds && prov.creds.key) || prov.key || 'public';
  const t0 = Date.now();
  const resp = await fetch(ocBase(prov) + '/models', {
    headers: {
      'Authorization': 'Bearer ' + key,
      'User-Agent': 'opencode/1.18.31 (linux amd64; go1.25)',
      'x-opencode-client': 'cli',
    },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* ignore */ }
  if (resp.status >= 400) {
    const e = new Error(sanitizeRemoteText((data && (data.error && data.error.message || data.message || data.msg)) || `HTTP ${resp.status}`, 160));
    e.status = resp.status;
    throw e;
  }
  const all = ((data && data.data) || []).map(m => m && m.id).filter(Boolean);
  const anonymous = key === 'public';
  const ids = anonymous ? all.filter(id => OC_FREE_RE.test(id)) : all;
  prov.knownModels = ids.length ? ids : all;
  prov.modelsFetchedAt = Date.now();
  saveExtProviders();
  return { latencyMs: Date.now() - t0, count: prov.knownModels.length, models: prov.knownModels };
}

// ---- trae (SOLO，国内区 refreshToken→JWT 轮换) -------------------------------
// chat:  POST {chatBase}/api/agent/v3/llm_utils_chat        function=solo_work_lite
// models: POST {chatBase}/api/ide/v1/get_detail_param        {function:"solo_work_lite"}
// auth:   POST {authBase}/cloudide/api/v3/trae/oauth/ExchangeToken  (refreshToken 轮换必须写回)
const TRAE_REALM = {
  cn: { chat: 'https://trae-api-cn.mchost.guru', auth: 'https://api.trae.cn', clientId: 'en1oxy7wnw8j9n', loginBase: 'https://www.trae.cn', ideVersion: '0.1.52', ideVersionCode: '20260811' },
  sg: { chat: 'https://coresg-normal.trae.ai',   auth: 'https://growsg-normal.trae.ai', clientId: 'ono9krqynydwx5', loginBase: 'https://www.trae.ai', ideVersion: '3.5.51', ideVersionCode: '20260401' },
  us: { chat: 'https://coreva-normal.trae.ai',   auth: 'https://growsg-normal.trae.ai', clientId: 'ono9krqynydwx5', loginBase: 'https://www.trae.ai', ideVersion: '3.5.51', ideVersionCode: '20260401' },
};
const TRAE_STATIC_MODELS = ['glm-5.3', 'glm-5.2', 'glm-5-turbo', 'glm-5', 'DeepSeek-V4-Flash', 'DeepSeek-V4-Pro', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'minimax-m3', 'qwen-3.7-plus', 'Doubao-Seed-2.1-Pro', 'Doubao-Seed-2.1-Turbo', 'Doubao-Seed-2.0-Code'];
const traeRefreshLocks = new Map(); // prov.id -> Promise，避免并发刷新把 refreshToken 写乱

function traeRealm(prov) {
  const r = String(prov.realm || (prov.creds && prov.creds.realm) || 'cn').toLowerCase();
  return TRAE_REALM[r] ? r : 'cn';
}
function traeCfg(prov) { return TRAE_REALM[traeRealm(prov)]; }
function traeChatBase(prov) {
  const b = String(prov.baseUrl || '').trim().replace(/\/+$/, '');
  return b || traeCfg(prov).chat;
}
function traeAuthBase(prov) {
  const b = String((prov.creds && prov.creds.authBase) || '').trim().replace(/\/+$/, '');
  return b || traeCfg(prov).auth;
}
function traeJwtUid(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString());
    return (p && (p.data && (p.data.id || p.data.userId) || p.id || p.userId)) || '';
  } catch { return ''; }
}
function traeJwtExpMs(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString());
    return p && p.exp ? p.exp * 1000 : 0;
  } catch { return 0; }
}
async function traeEnsureToken(prov) {
  const c = prov.creds || (prov.creds = {});
  if (c.accessToken && c.expiresAt && Date.now() < c.expiresAt - 10 * 60_000) return c;
  if (!c.refreshToken) {
    const e = new Error('Trae 未配置 refreshToken（在板块编辑里粘贴回调 URL 或 refreshToken）');
    e.config = true;
    throw e;
  }
  if (traeRefreshLocks.has(prov.id)) return traeRefreshLocks.get(prov.id);
  const p = (async () => {
    const cfg = traeCfg(prov);
    const resp = await fetch(traeAuthBase(prov) + '/cloudide/api/v3/trae/oauth/ExchangeToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ClientID: cfg.clientId, RefreshToken: c.refreshToken, ClientSecret: '-', UserID: '' }),
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(`ExchangeToken HTTP ${resp.status}: ${sanitizeRemoteText(JSON.stringify(data), 140)}`);
    const r = (data && data.Result) || data || {};
    const token = r.Token || r.token;
    if (!token) throw new Error('ExchangeToken 返回空 token');
    c.accessToken = token;
    if (r.RefreshToken || r.refreshToken) c.refreshToken = r.RefreshToken || r.refreshToken; // 轮换必须写回
    c.expiresAt = (r.TokenExpireAt && Number(r.TokenExpireAt)) || (r.tokenExpireAt && Number(r.tokenExpireAt)) || traeJwtExpMs(token) || (Date.now() + 3600e3);
    c.refreshExpiresAt = (r.RefreshExpireAt && Number(r.RefreshExpireAt)) || c.refreshExpiresAt || 0;
    if (!c.uid) c.uid = traeJwtUid(token);
    saveExtProviders();
    return c;
  })().finally(() => traeRefreshLocks.delete(prov.id));
  traeRefreshLocks.set(prov.id, p);
  return p;
}
function traeHeaders(prov, c) {
  const cfg = traeCfg(prov);
  const traceId = crypto.randomUUID().replace(/-/g, '');
  const reqId = crypto.randomUUID();
  return {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Authorization': 'Cloud-IDE-JWT ' + c.accessToken,
    'X-Cloudide-Token': c.accessToken,
    'X-Ide-Token': c.accessToken,
    'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-app-version': 'default',
    'x-ide-version': cfg.ideVersion,
    'x-ide-version-code': cfg.ideVersionCode,
    'x-app-version-code': cfg.ideVersionCode,
    'x-ide-version-type': 'stable',
    'x-device-brand': '83DG',
    'x-device-cpu': 'Intel',
    'x-device-id': String(c.deviceId || ''),
    'x-machine-id': String(c.machineId || ''),
    'x-device-type': 'windows',
    'x-os-version': 'Windows 11 Pro',
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': '04-' + traceId + '-' + traceId.slice(0, 16) + '-01',
    'request-traffic-type': 'prod',
    'x-uid': String(c.uid || ''),
    'X-Request-ID': reqId,
    'X-Trae-Request-ID': reqId,
    'User-Agent': 'Trae/' + cfg.ideVersion,
  };
}
// assistant.tool_calls → 文本化；tool 角色降级为 user（上游不吃结构化 tool 消息）
function traeMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    const role = m && m.role;
    const text = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map(x => (x && (x.text || x.content)) || '').filter(Boolean).join('\n\n')
      : (m.content == null ? '' : String(m.content));
    let body = text;
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const tcs = m.tool_calls.map(t => (t.function && t.function.name ? `${t.function.name}(${(t.function.arguments || '').slice(0, 300)})` : '')).filter(Boolean).join('; ');
      body = (body ? body + '\n' : '') + '[调用工具: ' + tcs + ']';
    }
    if (role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'text', text: '[工具返回' + (m.name ? ' ' + m.name : '') + ']: ' + body }] });
      continue;
    }
    out.push({ role: role === 'system' || role === 'assistant' || role === 'user' ? role : 'user', content: [{ type: 'text', text: body }] });
  }
  return out;
}
function traeChunkDelta(obj, emitId, created, model) {
  return { id: emitId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: obj, finish_reason: null }] };
}

async function builtinTraeChat(prov, upstreamModel, payload, wantStream, signal) {
  const c = await traeEnsureToken(prov);
  const configName = upstreamModel;
  const body = {
    messages: traeMessages(payload.messages),
    function: 'solo_work_lite',
    stream: true,
    config_name: configName,
    model: configName,
  };
  for (const k of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'stop', 'seed', 'n', 'max_tokens']) {
    if (payload[k] !== undefined) body[k] = payload[k];
  }
  const resp = await fetch(traeChatBase(prov) + '/api/agent/v3/llm_utils_chat', {
    method: 'POST', headers: traeHeaders(prov, c), body: JSON.stringify(body), redirect: 'error', signal,
  });
  return {
    resp,
    onData(raw, eventName) {
      if (raw === '[DONE]') return null;
      let chunk;
      try { chunk = JSON.parse(raw); } catch { return null; }
      if (eventName === 'output') {
        const d = {};
        if (chunk.response) d.content = (d.content || '') + chunk.response;
        if (chunk.content) d.content = (d.content || '') + chunk.content;
        if (chunk.reasoning_content) d.reasoning_content = chunk.reasoning_content;
        if (chunk.reasoning) d.reasoning_content = chunk.reasoning;
        if (Array.isArray(chunk.tool_calls) && chunk.tool_calls.length) {
          d.tool_calls = chunk.tool_calls.map((tc, i) => {
            const name = tc.name || (tc.function && tc.function.name) || tc.tool_name || '';
            const args = tc.params != null ? tc.params : (tc.arguments != null ? tc.arguments : (tc.input != null ? tc.input : (tc.function && tc.function.arguments)));
            return { index: tc.index != null ? tc.index : i, id: tc.id || ('call_' + crypto.randomBytes(12).toString('hex')), type: 'function', function: { name: String(name), arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) } };
          }).filter(t => t.function.name);
        }
        if (!d.content && !d.reasoning_content && !d.tool_calls) return null;
        return { choices: [{ index: 0, delta: d, finish_reason: null }] };
      }
      if (eventName === 'token_usage') {
        const u = {
          prompt_tokens: Number(chunk.prompt_tokens) || Number(chunk.input_tokens) || 0,
          completion_tokens: Number(chunk.completion_tokens) || Number(chunk.output_tokens) || 0,
          total_tokens: Number(chunk.total_tokens) || 0,
        };
        return { choices: [], usage: u };
      }
      if (eventName === 'done') {
        return { choices: [{ index: 0, delta: {}, finish_reason: chunk.finish_reason || 'stop' }] };
      }
      if (eventName === 'error') {
        const e = new Error(chunk.message || ('trae error ' + chunk.code));
        e.code = Number(chunk.code) || 0;
        throw e;
      }
      return null;
    },
  };
}

async function builtinTraeProbe(prov) {
  const c = await traeEnsureToken(prov);
  const t0 = Date.now();
  const resp = await fetch(traeChatBase(prov) + '/api/ide/v1/get_detail_param', {
    method: 'POST', headers: traeHeaders(prov, c),
    body: JSON.stringify({ function: 'solo_work_lite', config_names: null, need_prompt: false, current_config_info: null, poly_prompt: true, mode_type: null, agent_type: null }),
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const e = new Error(`get_detail_param HTTP ${resp.status}: ${sanitizeRemoteText(JSON.stringify(data), 140)}`);
    e.status = resp.status;
    throw e;
  }
  const list = (data && data.config_info_list) || [];
  const names = list.map(x => x && x.config_name).filter(Boolean);
  prov.knownModels = names.length ? names : TRAE_STATIC_MODELS;
  prov.modelsFetchedAt = Date.now();
  saveExtProviders();
  return { latencyMs: Date.now() - t0, count: prov.knownModels.length, models: prov.knownModels };
}

// ---- qoder (PAT → jobToken 会话 → COSY Bearer + QoderEncoding) ---------------
// chat:  POST https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
// auth:  POST https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1   (PAT 换会话)
// 请求体: baseprompt 模板 + QoderEncoding(base64→三段旋转→自定义字母表)
// Bearer: COSY.<payloadB64>.<md5(payloadB64\n cosyKey\n unix\n body\n path)>
const QODER_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const QODER_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const QODER_PUBKEY = '-----BEGIN PUBLIC KEY-----\n'
  + 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc\n'
  + '4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l\n'
  + '6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17\n'
  + 'XcW+ML9FoCI6AOvOzwIDAQAB\n'
  + '-----END PUBLIC KEY-----';
const QODER_SECRET = 'd2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==';
const qoderSessionLocks = new Map();
let _qoderTemplate = null;
function qoderTemplate() {
  if (_qoderTemplate) return JSON.parse(_qoderTemplate.replace(/\{UUID\d\}/g, () => crypto.randomUUID()).replace(/\{TIME1\}/g, () => Date.now()));
  try {
    const { qoderBasePromptB64 } = require('./ext-assets.js');
    const raw = Buffer.from(qoderBasePromptB64, 'base64').toString('utf-8');
    _qoderTemplate = raw;
  } catch (e) {
    _qoderTemplate = null;
    const err = new Error('qoder baseprompt 模板缺失: ' + sanitizeRemoteText(e.message, 120));
    err.config = true;
    throw err;
  }
  return qoderTemplate();
}
function qoderMd5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }
function qoderEncode(input) {
  const std = Buffer.isBuffer(input) ? input.toString('base64') : Buffer.from(String(input), 'utf8').toString('base64');
  const n = std.length, a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = '';
  for (const ch of rearranged) {
    const i = QODER_STD.indexOf(ch);
    if (i >= 0) { out += QODER_ALPHABET[i]; continue; }
    if (ch === '=') { out += '$'; continue; }
    throw new Error('qoderEncode: char out of alphabet');
  }
  return out;
}
async function qoderSession(prov) {
  const c = prov.creds || (prov.creds = {});
  if (c.session && c.session.accessToken && c.session.expireTime && Date.now() < c.session.expireTime - 5 * 60_000) return c.session;
  if (!c.pat) {
    const e = new Error('Qoder 未配置 PAT（在板块编辑里填 personalToken）');
    e.config = true;
    throw e;
  }
  if (qoderSessionLocks.has(prov.id)) return qoderSessionLocks.get(prov.id);
  const p = (async () => {
    if (!c.machineId) c.machineId = crypto.randomUUID();
    if (!c.machineToken) c.machineToken = Buffer.from((crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '').slice(0, 50)).toString('base64url');
    if (!c.machineType) c.machineType = crypto.randomUUID().replace(/-/g, '').slice(0, 18);
    const date = new Date().toUTCString();
    const sig = qoderMd5('cosy&' + QODER_SECRET + '&' + date);
    const inner = { personalToken: c.pat, securityOauthToken: '', refreshToken: '', needRefresh: false, authInfo: {} };
    const outer = { payload: JSON.stringify(inner), encodeVersion: '1' };
    const body = qoderEncode(JSON.stringify(outer));
    const resp = await fetch('https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1', {
      method: 'POST',
      headers: {
        'cosy-machinetoken': c.machineToken, 'cosy-machinetype': c.machineType, 'login-version': 'v2',
        'appcode': 'cosy', 'accept': 'application/json', 'accept-encoding': 'identity',
        'cosy-version': '0.1.43', 'cosy-clienttype': '5', 'date': date, 'signature': sig,
        'content-type': 'application/json', 'cosy-machineid': c.machineId, 'user-agent': 'Go-http-client/2.0',
      },
      body, redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    const j = await resp.json().catch(() => null);
    if (!resp.ok || !j) throw new Error(`jobToken HTTP ${resp.status}: ${sanitizeRemoteText(JSON.stringify(j), 140)}`);
    c.session = {
      accessToken: j.securityOauthToken || '',
      refreshToken: j.refreshToken || '',
      expireTime: Number(j.expireTime) || (Date.now() + 3500e3),
      uid: j.id || '', name: j.name || '', email: j.email || '', plan: j.plan || '', userType: j.userType || 'personal_standard',
    };
    saveExtProviders();
    return c.session;
  })().finally(() => qoderSessionLocks.delete(prov.id));
  qoderSessionLocks.set(prov.id, p);
  return p;
}
// 每个请求独立构造 COSY Bearer（tempKey RSA→b64 + info AES-128-CBC(key=iv=tempKey)）
function qoderBearer(sess, bodyEncoded, pathSig) {
  const tempKey = crypto.randomBytes(16); // 16 字节 ASCII key
  const cosyKey = crypto.publicEncrypt({ key: QODER_PUBKEY, padding: crypto.constants.RSA_PKCS1_PADDING }, tempKey).toString('base64');
  const info = {
    name: sess.name, aid: sess.uid, uid: sess.uid, yx_uid: '',
    organization_id: '', organization_name: '', user_type: sess.userType,
    security_oauth_token: sess.accessToken, refresh_token: sess.refreshToken,
  };
  const cipher = crypto.createCipheriv('aes-128-cbc', tempKey, tempKey);
  const infoB64 = Buffer.concat([cipher.update(JSON.stringify(info), 'utf8'), cipher.final()]).toString('base64');
  const payloadB64 = Buffer.from(JSON.stringify({
    cosyVersion: '0.1.43', ideVersion: '', info: infoB64, requestId: crypto.randomUUID(), version: 'v1',
  })).toString('base64');
  const date = String(Math.floor(Date.now() / 1000));
  const sig = qoderMd5(payloadB64 + '\n' + cosyKey + '\n' + date + '\n' + bodyEncoded + '\n' + pathSig);
  return { bearer: 'Bearer COSY.' + payloadB64 + '.' + sig, cosyKey, date };
}
async function builtinQoderChat(prov, upstreamModel, payload, wantStream, signal) {
  const sess = await qoderSession(prov);
  const c = prov.creds;
  const tpl = qoderTemplate();
  const body = JSON.parse(JSON.stringify(tpl));
  const rid = crypto.randomUUID();
  body.request_id = rid;
  body.chat_record_id = rid;
  body.request_set_id = crypto.randomUUID();
  body.session_id = crypto.randomUUID();
  body.stream = true;
  body.aliyun_user_type = sess.userType;
  body.model_config = body.model_config || {};
  body.model_config.key = upstreamModel || 'lite';
  body.business = body.business || {};
  body.business.id = crypto.randomUUID();
  body.business.begin_at = Date.now();
  const lastUser = [...(payload.messages || [])].reverse().find(m => m && m.role === 'user');
  const prompt = typeof lastUser?.content === 'string' ? lastUser.content
    : Array.isArray(lastUser?.content) ? lastUser.content.map(x => (x && x.text) || '').join('\n') : '';
  body.chat_context = body.chat_context || {};
  body.chat_context.text = { type: 'text', text: prompt };
  body.chat_context.extra = body.chat_context.extra || {};
  body.chat_context.extra.originalContent = { type: 'text', text: prompt };
  body.business.name = prompt.length > 30 ? prompt.slice(0, 30) : prompt;
  // messages：保留模板 system，重写 user/assistant/tool 消息
  const keepSys = !(payload.messages || []).some(m => m && m.role === 'system');
  const rebuilt = [];
  if (keepSys) {
    for (const m of tpl.messages || []) if (m.role === 'system') rebuilt.push(JSON.parse(JSON.stringify(m)));
  }
  const toolsEnabled = Array.isArray(payload.tools) && payload.tools.length > 0;
  for (const m of payload.messages || []) {
    const role = m && m.role;
    let text = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map(x => (x && x.text) || (x && x.type === 'text' ? x.text : '')).filter(Boolean).join('\n\n') : '';
    if (!text && m.content != null && !Array.isArray(m.content)) text = String(m.content);
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const tcs = m.tool_calls.map(t => t.function && t.function.name).filter(Boolean).join(', ');
      text = (text ? text + '\n' : '') + '[调用工具: ' + tcs + ']';
    }
    if (role === 'tool') { text = '[工具返回' + (m.name ? ' ' + m.name : '') + ']: ' + text; }
    if (!text.trim()) continue;
    if (role === 'user') {
      rebuilt.push({ role: 'user', content: '', contents: [{ type: 'text', text }], response_meta: { id: '', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }, reasoning_content_signature: '' });
    } else {
      rebuilt.push({ role: role === 'tool' ? 'user' : role, content: text, response_meta: { id: '', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }, reasoning_content_signature: '' });
    }
  }
  if (!rebuilt.length) rebuilt.push({ role: 'user', content: '', contents: [{ type: 'text', text: prompt }], response_meta: { id: '', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }, reasoning_content_signature: '' });
  body.messages = rebuilt;
  if (toolsEnabled) body.tools = payload.tools;
  const url = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';
  const bodyEncoded = qoderEncode(JSON.stringify(body));
  const pathSig = '/api/v2/service/pro/sse/agent_chat_generation';
  const { bearer, cosyKey, date } = qoderBearer(sess, bodyEncoded, pathSig);
  const headers = {
    'cosy-data-policy': 'AGREE', 'content-type': 'application/json',
    'cosy-machinetype': c.machineType, 'cosy-clienttype': '5', 'cosy-date': date,
    'cosy-user': sess.uid, 'cosy-key': cosyKey, 'cache-control': 'no-cache',
    'accept': 'text/event-stream', 'cosy-clientip': '169.254.198.161',
    'authorization': bearer, 'accept-encoding': 'identity', 'cosy-version': '0.1.43',
    'cosy-machineid': c.machineId, 'cosy-machinetoken': c.machineToken,
    'login-version': 'v2', 'user-agent': 'Go-http-client/2.0',
    'x-model-key': body.model_config.key, 'x-model-source': (body.model_config.source || 'system'),
  };
  const resp = await fetch(url, { method: 'POST', headers, body: bodyEncoded, redirect: 'error', signal });
  return {
    resp,
    onData(raw) {
      if (raw === '[DONE]') return null;
      let wrap;
      try { wrap = JSON.parse(raw); } catch { return null; }
      const inner = wrap && (wrap.body || wrap.data || '');
      if (!inner) return null;
      let innerJson;
      try { innerJson = JSON.parse(inner); } catch { return null; }
      for (const ch of innerJson.choices || []) {
        const d = ch.delta || {};
        const out = {};
        if (d.role) out.role = d.role;
        if (d.content) out.content = d.content;
        if (d.reasoning_content) out.reasoning_content = d.reasoning_content;
        if (Array.isArray(d.tool_calls) && d.tool_calls.length) out.tool_calls = d.tool_calls;
        if (ch.finish_reason) {
          return { choices: [{ index: 0, delta: {}, finish_reason: ch.finish_reason }] };
        }
        if (out.role || out.content || out.reasoning_content || out.tool_calls) {
          return { choices: [{ index: 0, delta: out, finish_reason: null }] };
        }
      }
      if (innerJson.usage) return { choices: [], usage: extNormUsage(innerJson.usage) };
      return null;
    },
  };
}
async function builtinQoderProbe(prov) {
  const sess = await qoderSession(prov);
  prov.knownModels = ['lite'];
  prov.modelsFetchedAt = Date.now();
  saveExtProviders();
  return { latencyMs: 0, count: 1, models: ['lite'], note: '已获取会话 ' + (sess.name || sess.uid) };
}

// ---- 内置板块额度/凭据状态（反代面板「额度」卡） -----------------------------

// opencode：免费层没有计费接口，展示匿名/付费身份 + 免费模型目录；
// 填了 key 时顺带试官方 models 目录是否可用（可用性即额度信号）
async function builtinOpencodeQuota(prov) {
  const key = (prov.creds && prov.creds.key) || prov.key || 'public';
  const lines = [];
  if (key === 'public') {
    lines.push({ k: '计费模式', v: '匿名免费层（Bearer public，cost=0）' });
    lines.push({ k: '额度', v: '免费层无余额概念 · 按上游限流', dim: true });
  } else {
    lines.push({ k: '计费模式', v: '付费 key' });
    lines.push({ k: 'Key', v: maskKey(key), dim: true });
  }
  // 免费模型数 = 匿名身份可见的目录（探测缓存；未探测过就给提示）
  const known = prov.knownModels || [];
  if (known.length) {
    lines.push({ k: '可用模型', v: known.length + ' 个（' + (key === 'public' ? 'free 层目录' : '完整目录') + '）' });
  } else {
    lines.push({ k: '可用模型', v: '尚未探测目录', dim: true });
  }
  if (prov.modelsFetchedAt) lines.push({ k: '目录刷新于', v: new Date(prov.modelsFetchedAt).toLocaleString(), dim: true });
  return { title: '额度 / 凭据（OpenCode Zen）', lines };
}

// trae：无官方额度查询接口；展示登录态（realm/uid/两枚 token 的到期时间）+ 冷却
async function builtinTraeQuota(prov) {
  const c = prov.creds || {};
  const realm = traeRealm(prov);
  const realmLabel = { cn: '国内站', sg: '国际站(sg)', us: '美国站(us)' }[realm] || realm;
  const lines = [{ k: '区域', v: realmLabel }];
  if (!c.refreshToken) {
    lines.push({ k: '登录态', v: '未配置 refreshToken（到「扩展接入」粘贴回调 URL）', bad: true });
    return { title: '额度 / 凭据（Trae SOLO）', lines };
  }
  lines.push({ k: '登录态', v: 'refreshToken 已配置' });
  if (c.uid) lines.push({ k: '账号 uid', v: String(c.uid).slice(0, 12) + '…' });
  if (c.expiresAt) {
    const left = Math.round((c.expiresAt - Date.now()) / 60000);
    lines.push({ k: 'accessToken', v: left > 0 ? '剩余约 ' + (left >= 60 ? (left / 60).toFixed(1) + ' 小时' : left + ' 分钟') : '已过期（下次请求自动轮换）', warn: left <= 0 });
  }
  if (c.refreshExpiresAt) {
    lines.push({ k: 'refreshToken 到期', v: new Date(c.refreshExpiresAt).toLocaleString() });
  }
  lines.push({ k: '额度', v: 'Trae 无对外余额接口；触发 4008/1005 会记为额度耗尽并冷却', dim: true });
  return { title: '额度 / 凭据（Trae SOLO）', lines };
}

// qoder：PAT 会话本身带账号信息；调一次 jobToken 顺带刷新会话态显示
async function builtinQoderQuota(prov) {
  const c = prov.creds || {};
  const lines = [];
  if (!c.pat) {
    lines.push({ k: '登录态', v: '未配置 PAT（到「扩展接入」填 personalToken）', bad: true });
    return { title: '额度 / 凭据（Qoder）', lines };
  }
  try {
    const sess = await qoderSession(prov);
    lines.push({ k: '登录态', v: 'PAT 有效 · 会话已建立' });
    if (sess.name || sess.email) lines.push({ k: '账号', v: [sess.name, sess.email].filter(Boolean).join(' · ') });
    if (sess.plan || sess.userType) lines.push({ k: '套餐', v: sess.plan || sess.userType });
    if (sess.expireTime) lines.push({ k: '会话到期', v: new Date(sess.expireTime).toLocaleString(), dim: true });
  } catch (e) {
    lines.push({ k: '登录态', v: 'PAT 会话换取失败', bad: true });
    lines.push({ k: '原因', v: sanitizeRemoteText(e.message, 120), bad: true });
  }
  lines.push({ k: '额度', v: 'Qoder 无对外余额接口；按会话可用性判断', dim: true });
  return { title: '额度 / 凭据（Qoder）', lines };
}

function accountFile(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id)) return null;
  const resolved = path.resolve(AUTHS_DIR, id);
  if (!resolved.startsWith(path.resolve(AUTHS_DIR) + path.sep)) return null;
  return resolved;
}

// 账号级 403 风控标记（持久化 auths/.account-403.json，重启不丢）：
//   11140 等内容审查拦截 → 打标记，该号退出轮换候选、聊天候选直接跳过；
//   解除条件：该号任一请求成功（体检探测 / 轮换前探测 / 真实对话），手动启用后请求成功同样解除
const FLAG403_FILE = path.join(AUTHS_DIR, '.account-403.json');
let flag403 = (() => { try { return JSON.parse(fs.readFileSync(FLAG403_FILE, 'utf-8')) || {}; } catch { return {}; } })();
function saveFlag403() { try { atomicWriteJson(FLAG403_FILE, flag403); } catch { /* ignore */ } }
function markAccount403(uid8, reason) {
  const k = String(uid8 || '').slice(0, 8);
  if (!k) return;
  if (flag403[k]) {
    flag403[k].lastAt = Date.now();
    flag403[k].reason = String(reason || flag403[k].reason || '').slice(0, 200);
  } else {
    flag403[k] = { at: Date.now(), lastAt: Date.now(), reason: String(reason || '').slice(0, 200) };
    log(`[403] 账号 ${k} 被上游风控拦截，已打标记（轮换/聊天跳过，直至请求成功解除）`);
  }
  deferWrite('flag403', saveFlag403, 1_000);
  invalidateAccountsCache();
}
function clearAccount403(uid8) {
  const k = String(uid8 || '').slice(0, 8);
  if (!k || !flag403[k]) return;
  const next = { ...flag403 }; delete next[k];
  atomicWriteJson(FLAG403_FILE, next);
  delete flag403[k];
  invalidateAccountsCache();
  log(`[403] 账号 ${k} 请求成功，风控标记已解除`);
}
function is403Flagged(uid8) { const k = String(uid8 || '').slice(0, 8); return !!flag403[k]; }

// 观察池（删除号池）：403 标记即入池——暂停自动签到、每天自动体检一次、POOL_MAX_DAYS 天未解除自动彻底删除
const POOL_MAX_DAYS = 7;

function stableAccountId(credObj) {
  const auth = credObj.auth || {};
  const acct = credObj.account || {};
  const site = siteOfDomain(auth.domain);
  let uidPart = String(acct.uid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  if (!uidPart) {
    uidPart = 'anon' + crypto.createHash('sha256').update(String(auth.accessToken || '')).digest('hex').slice(0, 8);
  }
  return `${site}_${uidPart}.json`;
}

// 登录成功后存档（同账号重复登录会覆盖旧档，token 保持最新）
function saveToStore(credObj) {
  try {
    fs.mkdirSync(AUTHS_DIR, { recursive: true });
    const id = stableAccountId(credObj);
    writeAuthFileAtomic(path.join(AUTHS_DIR, id), credObj);
    invalidateAccountsCache();
    return id;
  } catch (e) {
    log(`账号存档失败: ${sanitizeRemoteText(e.message, 120)}`);
    return null;
  }
}

// 启动时把当前启用的 auth.json 镜像入库（让已有账号出现在管理列表里）
function importActiveToStore() {
  if (!cred) return;
  try {
    const s = cred.session();
    if (!s.account || !s.account.uid) return;
    fs.mkdirSync(AUTHS_DIR, { recursive: true });
    const id = stableAccountId(s);
    const dest = path.join(AUTHS_DIR, id);
    if (!fs.existsSync(dest)) { writeAuthFileAtomic(dest, s); invalidateAccountsCache(); }
    activeAccountId = id;
  } catch { /* ignore */ }
}

// 账号档案缓存：只缓存 readdir+JSON.parse 出来的文件内容（expiresAt/uid/checkinOnly 等
// 静态字段），账号健康态（blocked/flag403/balance/inflight）每次现算现拼。
// TTL 见顶部常量 ACCTS_CACHE_MS（CB_ACCOUNTS_CACHE_MS 可调，0=禁用，封顶 10s），
// 账号增删/健康标记变更时主动失效。
let _acctsFiles = null; // [{ id, data }]
let _acctsFilesAt = 0;
function invalidateAccountsCache() { _acctsFiles = null; _acctsFilesAt = 0; }
function accountFileRows() {
  const now = Date.now();
  if (_acctsFiles && now - _acctsFilesAt < ACCTS_CACHE_MS) return _acctsFiles;
  let files = [];
  try { files = fs.readdirSync(AUTHS_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    try {
      out.push({ id: f, data: JSON.parse(fs.readFileSync(path.join(AUTHS_DIR, f), 'utf-8')) });
    } catch { /* 坏文件跳过 */ }
  }
  _acctsFiles = out;
  _acctsFilesAt = now;
  return out;
}

function listAccounts() {
  const now = Date.now();
  const out = [];
  // modelHealth 先按 uid8 一次性分组取「最晚恢复」，避免 账号数 × 条目数 的双重循环
  const latestByUid = new Map();
  for (const mk in modelHealth) {
    const mv = modelHealth[mk];
    if (!mv || !(mv.blockedUntil > now)) continue;
    const sep = mk.indexOf('|');
    if (sep < 0) continue;
    const u = mk.slice(0, sep), cur = latestByUid.get(u);
    if (!cur || mv.blockedUntil > cur.until) latestByUid.set(u, { until: mv.blockedUntil, model: mk.slice(sep + 1) });
  }
  for (const { id: f, data: d } of accountFileRows()) {
    try {
      const auth = d.auth || {};
      const acct = d.account || {};
      const k = String(acct.uid || '').slice(0, 8);
      const h = accountHealth[k] || {};
      // 账号级（余额兜底）与模型级（6004）限额合并展示，取最晚恢复时间
      let blockedUntil = null;
      let blockedModel = null;
      const mb = latestByUid.get(k);
      if (mb && (!blockedUntil || mb.until > blockedUntil)) { blockedUntil = mb.until; blockedModel = mb.model; }
      out.push({
        id: f,
        nickname: acct.nickname || '(未命名)',
        uid: acct.uid ? String(acct.uid).slice(0, 8) : null,
        siteLabel: SITES[siteOfDomain(auth.domain)].label,
        expiresAt: auth.expiresAt || 0,
        expiresSec: Math.max(0, Math.floor(((auth.expiresAt || 0) - now) / 1000)),
        refreshExpiresAt: auth.refreshExpiresAt || null,
        refreshExpiresSec: Math.max(0, Math.floor((((auth.refreshExpiresAt || 0) - now) / 1000))),
        active: f === activeAccountId,
        serving: servingOverrideId ? (f === servingOverrideId) : (f === activeAccountId),
        checkinOnly: !!d.checkinOnly,
        blockedUntil,
        blockedModel,
        flag403: is403Flagged(k),
        flag403At: (flag403[k] || {}).at || null,
        flag403DaysLeft: flag403[k] ? Math.max(0, Math.ceil((flag403[k].at + POOL_MAX_DAYS * 86400_000 - now) / 86400_000)) : null,
        balance: (h.balance === undefined || h.balance === null) ? null : h.balance,
        earliestExpire: h.earliestExpire || null,
        inflight: acctInflight[k] || 0,
      });
    } catch { /* 坏文件跳过 */ }
  }
  out.sort((a, b) => b.expiresAt - a.expiresAt);
  return out;
}

function switchAccount(id) {
  const src = accountFile(id);
  if (!src || !fs.existsSync(src)) return { ok: false, message: '账号不存在' };
  let obj;
  try { obj = JSON.parse(fs.readFileSync(src, 'utf-8')); }
  catch { return { ok: false, message: '账号文件损坏' }; }
  const target = path.join(__dirname, 'auth.json');
  writeAuthFileAtomic(target, obj);
  try { cred = new CredentialManager(target); } catch (e) {
    return { ok: false, message: sanitizeRemoteText(e.message, 150) };
  }
  activeAccountId = id;
  invalidateAccountsCache();
  log(`已切换启用账号: ${id}`);
  return { ok: true };
}

function deleteAccount(id) {
  const src = accountFile(id);
  if (!src || !fs.existsSync(src)) return { ok: false, message: '账号不存在' };
  let oldUid8 = null;
  try { oldUid8 = uid8Of(JSON.parse(fs.readFileSync(src, 'utf-8'))); } catch { /* ignore */ }
  unlinkCredFile(src);
  invalidateAccountsCache();
  if (oldUid8) {
    clearAccount403(oldUid8); // 删号同时清掉观察池标记，防孤儿标记
    // 同步清掉健康态内存条目，防长跑下 deleted 号留下死数据
    delete accountHealth[oldUid8];
    for (const mk of Object.keys(modelHealth)) {
      if (mk.startsWith(oldUid8 + '|')) delete modelHealth[mk];
    }
    delete refreshChains[oldUid8];
  }
  let clearedActive = false;
  if (id === activeAccountId) {
    // 删除的是正在使用的账号：清空 auth.json，服务回到未登录状态
    try { unlinkCredFile(path.join(__dirname, 'auth.json')); } catch { /* ignore */ }
    cred = null;
    activeAccountId = null;
    clearedActive = true;
  }
  log(`已删除账号: ${id}${clearedActive ? '（原启用账号，服务暂停待重新登录/切换）' : ''}`);
  return { ok: true, clearedActive };
}

// ---------------------------------------------------------------------------
// 账号健康与自动故障转移
//   触发1: 429/6004（免费额度用完，报错含重置时间）→ 标记受限 + 自动切其它号重试
//   触发2: 余额低于 FAILOVER_CREDITS → 预测式切到余额最多的号
//   切换均为本地文件操作，不产生登录行为
// ---------------------------------------------------------------------------

// Consecutive failures are per account, across requests; reset only after completion.
const accountFailureStreak = Object.create(null);
function recordAccountFailure(u8, model, ctx) {
  if (!u8) return;
  const n = accountFailureStreak[u8] = (accountFailureStreak[u8] || 0) + 1;
  log(`[failover] ${u8} 连续失败 ${n}/3`);
  if (n < 3 || servingOverrideId || !cred || uid8Of(cred.session()) !== u8) return;
  const candidates = listAccounts().filter(a => a.uid && a.uid !== u8 && !a.checkinOnly && !a.flag403 &&
    !isBlockedModel(a.uid, model) &&
    (accountFailureStreak[a.uid] || 0) < 3 && accountAllowed(ctx, a.uid));
  // Latest cached balance, descending. Unknown balances rank after known balances.
  const balanceOf = a => Number.isFinite(accountHealth[a.uid]?.balance) ? accountHealth[a.uid].balance : -Infinity;
  candidates.sort((a, b) => {
    const av = balanceOf(a), bv = balanceOf(b);
    return av === bv ? 0 : av > bv ? -1 : 1;
  });
  const alt = candidates[0];
  if (!alt) { log('[failover] 连续失败达到阈值，但无合格替代账号'); return; }
  const sw = switchAccount(alt.id);
  if (sw.ok) log(`[failover] 连续失败阈值触发：默认启用账号已切换到 ${alt.id}（候选余额最高：${Number.isFinite(balanceOf(alt)) ? balanceOf(alt) : '未知，按存档顺序兜底'}）`);
}
function recordAccountSuccess(u8) {
  if (u8) accountFailureStreak[u8] = 0;
}

const accountHealth = Object.create(null); // uid8 -> { balance, balanceAt }; model cooldowns live in modelHealth

function parseResetTimeMs(msg) { return hardening.parseReset(msg); }

function uid8Of(sessionObj) {
  return String((sessionObj && sessionObj.account && sessionObj.account.uid) || '').slice(0, 8);
}


// 单账号在途租约：key 用 uid8（匿名存档兜底 file:<id>，当前服务号兜底 auth.json），
// 对话路径在账号选中→响应体消费结束全程持有；命中上限的账号该轮直接跳过换下一个。
const acctInflight = Object.create(null); // leaseKey -> 在途数
function acctLeaseKey(cm, fileId) {
  if (cm) {
    try {
      const k = uid8Of(cm.session());
      if (k) return k;
    } catch { /* 凭据损坏时按文件兜底 */ }
  }
  return 'file:' + (fileId || 'auth.json');
}
function acctLeaseBusy(cm, fileId) { return (acctInflight[acctLeaseKey(cm, fileId)] || 0) >= ACCT_MAX_INFLIGHT; }
function acctLeaseAcquire(cm, fileId) {
  const k = acctLeaseKey(cm, fileId);
  if ((acctInflight[k] || 0) >= ACCT_MAX_INFLIGHT) return null;
  acctInflight[k] = (acctInflight[k] || 0) + 1;
  return k;
}
function acctLeaseRelease(leaseKey) {
  if (!leaseKey) return;
  const n = (acctInflight[leaseKey] || 0) - 1;
  if (n > 0) acctInflight[leaseKey] = n; else delete acctInflight[leaseKey];
}

// 统一冷却折算：Retry-After（秒）优先 → 配额类回退解析 msg 中的重置时间 → 策略默认时长；
// 上限统一封顶 6 小时（与既有 429 封顶一致，不放宽）
function acctCooldownMs(kind, retryAfterSec, resetMsg) {
  const pol = ERR_POLICY[kind] || {};
  const raMs = Math.max(0, Number(retryAfterSec) || 0) * 1000;
  let ms = raMs > 0
    ? raMs
    : (kind === 'quota' ? Math.max(0, (resetMsg ? parseResetTimeMs(resetMsg) : 0) - Date.now()) || pol.defaultMs : pol.defaultMs) || pol.defaultMs || 0;
  return Math.min(ms, 6 * 3600_000);
}

// 对话路径错误分类：状态码优先于文案（借鉴 wb2api），具体码优先于兜底。
// 返回 ERR_POLICY 的 key；命中即按该 kind 的 scope/defaultMs 冷却。
function chatErrorPolicy(status, code, msg) {
  if (!status) return 'network';
  if (status === 401) return 'auth_expired';
  const m = String(msg || '');
  if (status === 403) {
    return (code === 11140 || /request illegal|safety review/i.test(m)) ? 'risk_control' : 'client_4xx';
  }
  if (status === 429) {
    return (code === 6004 || /频率限制|用量已超|上限/.test(m)) ? 'quota' : 'rate_limit';
  }
  if (/region.*(block|deny|restrict|not available|unavailable)|not available in (your |this )?(region|country|location)|地区限制|区域限制/i.test(m)) {
    return 'region_blocked';
  }
  if (/(model|后端).*(unavailable|not available|不存在|不可用|not found)|model.*does not exist|unsupported model/i.test(m)) {
    return 'model_unavailable';
  }
  if (status >= 500) return 'server_5xx';
  return 'client_4xx';
}

// 模型级限额（实测 6004 是按模型计的：hy4 打满不影响同账号其它模型）
// 持久化到 .model-health.json：重启不再对已受限组合重复探测（避免顺延滚动窗口）
const modelHealth = Object.create(null); // 'uid8|model' -> { blockedUntil, reason }
const MODEL_HEALTH_FILE = path.join(AUTHS_DIR, '.model-health.json');
try {
  if (fs.existsSync(MODEL_HEALTH_FILE)) {
    const saved = JSON.parse(fs.readFileSync(MODEL_HEALTH_FILE, 'utf-8'));
    for (const [k, v] of Object.entries(saved || {})) {
      if (v && v.blockedUntil > Date.now()) modelHealth[k] = v; // 只恢复未过期的
    }
  }
} catch { /* ignore */ }

function saveModelHealth() {
  try {
    for (const k of Object.keys(modelHealth)) {
      if (!modelHealth[k] || (modelHealth[k].blockedUntil || 0) < Date.now()) delete modelHealth[k];
    }
    writeAuthFileAtomic(MODEL_HEALTH_FILE, modelHealth);
  } catch { /* ignore */ }
}

function markBlockedModel(uid8, model, untilMs, reason, kind) {
  modelHealth[uid8 + '|' + model] = { blockedUntil: untilMs, reason: String(reason || '').slice(0, 200), at: Date.now(), ...(kind ? { kind } : {}) };
  // 模型级受限只在异常路径触发，合批落盘即可，不在请求路径同步写文件
  deferWrite('modelHealth', saveModelHealth, 1_000);
  invalidateAccountsCache();
  log(`[failover] ${uid8} 的 ${model} 受限至 ${new Date(untilMs).toLocaleString()}${kind ? `（${kind}）` : ''}`);
}

function isBlockedModel(uid8, model) {
  const h = modelHealth[uid8 + '|' + model];
  return !!(h && h.blockedUntil && h.blockedUntil > Date.now());
}

// 软冷却（内存态，不持久化）：网络错误 / 非配额 429 / 5xx 这类瞬时故障。
// 选号时仅降低优先级（先选未冷却的号），别无可选时仍可使用，避免单号部署被一次抖动锁死。
const softCooling = new Map(); // 'uid8|model' -> { until, kind }
function isSoftCooling(uid8, model) {
  const k = uid8 + '|' + model, v = softCooling.get(k);
  if (!v) return false;
  if (v.until > Date.now()) return true;
  softCooling.delete(k);
  return false;
}
function clearSoftCooling(uid8, model) { if (uid8) softCooling.delete(uid8 + '|' + model); }

const HARD_KINDS = new Set(['quota', 'risk_control', 'model_unavailable', 'region_blocked']);
// 对话失败统一入口：chatErrorPolicy 分类 → acctCooldownMs 折算 → 硬/软冷却。
// 配额类（6004）沿用「按报错里的重置时间封存、解析失败 1h」的既有语义且不封顶，
// 否则提前重试会把上游滚动窗口的重置时间往后推。返回分类 kind 供日志与降级判断。
function applyChatErrorPolicy(uid8, model, status, code, msg, retryAfterSec) {
  const kind = chatErrorPolicy(status, Number(code), msg);
  const pol = ERR_POLICY[kind] || {};
  if (!uid8 || pol.scope === 'none' || !pol.scope) return kind;
  if (HARD_KINDS.has(kind)) {
    const until = kind === 'quota'
      ? (retryAfterSec > 0 ? Date.now() + Math.min(retryAfterSec * 1000, 6 * 3600_000) : parseResetTimeMs(msg))
      : Date.now() + acctCooldownMs(kind, retryAfterSec, msg);
    markBlockedModel(uid8, model, until, msg, kind);
    if (pol.scope === 'flag403') markAccount403(uid8, msg);
  } else {
    softCooling.set(uid8 + '|' + model, { until: Date.now() + acctCooldownMs(kind, retryAfterSec, msg), kind });
    if (softCooling.size > 4096) { const now = Date.now(); for (const [k, v] of softCooling) if (v.until <= now) softCooling.delete(k); while (softCooling.size > 4096) softCooling.delete(softCooling.keys().next().value); }
  }
  return kind;
}

// 所有可服务账号上该模型都因指定类别被硬冷却（用于「一个号都没打」时仍能触发降级链）
function modelBlockedByKinds(model, kinds, ctx) {
  const now = Date.now();
  const uids = new Set(listAccounts().filter(a => a.uid && !a.checkinOnly && !a.flag403 && accountAllowed(ctx, a.uid)).map(a => a.uid));
  const cm = resolveServingCm();
  if (cm) { try { const u = uid8Of(cm.session()); if (u && !is403Flagged(u) && accountAllowed(ctx, u)) uids.add(u); } catch { /* ignore */ } }
  if (!uids.size) return false;
  for (const u of uids) {
    const h = modelHealth[u + '|' + model];
    if (!h || !(h.blockedUntil > now) || !kinds.includes(h.kind)) return false;
  }
  return true;
}

// 模型降级链（借鉴 trae）：模型在全部账号上 model_unavailable/region_blocked 时，
// 按系列降级到兜底模型重试一次。目标必须实际存在于上游模型目录（modelsCache/DEFAULT_MODELS）
// 且未被健康表全局封锁，才允许降级——否则原样返回最后错误。
const MODEL_FALLBACK_CHAIN = [
  { match: /^(kimi|claude)/i, target: 'hy4-preview' },
  { match: /^gpt/i,           target: 'deepseek-v4.1-flash' },
];
function catalogHasModel(id) {
  const list = modelsCache.list && modelsCache.list.length
    ? modelsCache.list
    : DEFAULT_MODELS.map(m => ({ id: m }));
  return list.some(m => m && m.id === id);
}
function fallbackModelFor(model, serveCmRef, acctsSnap) {
  const entry = MODEL_FALLBACK_CHAIN.find(e => e.match.test(String(model || '')));
  if (!entry || entry.target === model) return null;
  if (!catalogHasModel(entry.target)) return null;
  // 降级目标若在"本请求可见的全部账号"上都处于模型级冷却，降级无意义——跳过
  if (serveCmRef) { const u8 = uid8Of(serveCmRef.session()); if (u8 && !isBlockedModel(u8, entry.target)) return entry.target; }
  for (const a of acctsSnap || []) {
    if (a.uid && !a.checkinOnly && !a.flag403 && !isBlockedModel(a.uid, entry.target)) return entry.target;
  }
  return null;
}

// 临时启用：仅签到账号临时参与服务（内存态，重启/恢复默认后失效，不改默认账号）
let servingOverrideId = null;

function resolveServingCm() {
  if (servingOverrideId) {
    const p = accountFile(servingOverrideId);
    if (p && fs.existsSync(p)) {
      try { return credManager(p); } catch { servingOverrideId = null; invalidateAccountsCache(); }
    } else {
      servingOverrideId = null;
      invalidateAccountsCache();
    }
  }
  return cred;
}

// 模型计费倍率（来自上游模型目录，x0.29 → 0.29；未知按 0/免费处理）
// list→{id→倍率} 索引懒构建：原实现每次调用都线性扫目录（热路径每请求多次），
// list 引用变化（上游刷新）时自动重建。
let _multIdx = { list: null, map: null };
function modelMultiplier(model) {
  const id = String(model || '');
  const list = modelsCache.list || [];
  if (_multIdx.list !== list) {
    const map = new Map();
    for (const m of list) {
      if (!m || typeof m.id !== 'string') continue;
      const v = parseFloat(String(m.credits || '').replace('x', ''));
      map.set(m.id, Number.isFinite(v) ? v : 0);
    }
    _multIdx = { list, map };
  }
  const direct = _multIdx.map.get(id);
  if (direct !== undefined) return direct;
  // 目录外的别名（如 kimi-k3 → kimi-k3-1）：取同名系列中最新的一条做兜底倍率
  // 仅用于上游未返回 credit 时的估算，官方 credit 优先
  const prefix = id.replace(/-?\d+(\.\d+)*$/, '');
  if (prefix && prefix !== id) {
    const cands = list.filter(m => m.id === prefix || m.id.startsWith(prefix));
    // 优先选数字后缀最大的（通常是同系列最新/最贵版本）
    let best = null, bestNum = -Infinity;
    for (const m of cands) {
      const v = parseFloat(String(m.credits || '').replace('x', ''));
      if (!Number.isFinite(v)) continue;
      const num = parseFloat((m.id.slice(prefix.length).match(/-?\d+(\.\d+)*/) || ['0'])[0]);
      if (!Number.isFinite(num)) continue;
      if (num > bestNum) { bestNum = num; best = v; }
    }
    if (best !== null) return best;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function openaiError(status, message, type) {
  return { error: { message, type: type || 'upstream_error', code: status } };
}

// 常量时间比较：先各自哈希成等长摘要，避免按字节短路比较泄露长度/前缀信息
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}
function findApiKey(token) {
  let hit = null;
  for (const e of apiKeys) if (safeEqual(e.key, token) && !hit) hit = e; // 不提前 break，耗时与命中位置无关
  return hit;
}

function checkAuth(req) {
  if (!API_KEY) return null; // 未启用鉴权：无限制，返回无约束的上下文
  let token = '';
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) token = h.slice(7).trim();
  if (!token && req.headers['x-api-key']) token = String(req.headers['x-api-key']).trim();
  if (!token) throw { status: 401, body: openaiError(401, 'invalid api key', 'auth_error') };
  if (safeEqual(token, API_KEY)) return { key: 'master', admin: true, restrictions: null }; // 主 Key：全权
  const ent = findApiKey(token);
  if (!ent) throw { status: 401, body: openaiError(401, 'invalid api key', 'auth_error') };
  if (ent.disabled) throw { status: 401, body: openaiError(401, 'api key 已被停用', 'auth_error') };
  return { key: ent.key, admin: false, restrictions: ent, name: ent.name || '' };
}

// 附加 Key 的限额校验：模型白名单 / 账号白名单 / 每日请求额度
function keyRestrictionError(ctx, model) {
  const error = quotaLedger.check(ctx, model);
  return error ? { status: error.status, body: openaiError(error.status, error.message, error.status === 403 ? 'permission_denied' : 'quota_exceeded') } : null;
}

function accountAllowed(ctx, uid8) {
  const r = ctx && ctx.restrictions;
  if (!r || !r.accounts || !r.accounts.length) return true;
  return r.accounts.includes(String(uid8 || ''));
}

// 管理台会话 cookie：值为主 Key 的 HMAC 派生（不含 Key 明文），HttpOnly + SameSite=Strict + Path=/admin。
// 前端首次用 ?key= 打开后即从地址栏抹掉 key，后续 API/SSE 靠 cookie 或 X-Api-Key 头鉴权，
// 后续 API/SSE 不携带 URL key；首次入口 URL 仍可能被访问日志记录。更换主 key 后 cookie 失效。
const ADMIN_COOKIE = 'wb_admin';
const ADMIN_SESSION = API_KEY ? crypto.createHmac('sha256', API_KEY).update('wb-admin-session-v1').digest('base64url') : '';
function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
function adminCookieHeader(req) {
  const secure = req.socket?.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `${ADMIN_COOKIE}=${ADMIN_SESSION}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`;
}

function checkAdmin(req, urlObj) {
  if (!API_KEY) throw { status: 503, body: { ok: false, message: '服务未设置 CB_API_KEY，管理台不可用' } };
  let token = urlObj.searchParams.get('key') || '';
  if (!token) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) token = h.slice(7).trim();
    if (!token && req.headers['x-api-key']) token = String(req.headers['x-api-key']).trim();
  }
  if (token) {
    if (safeEqual(token, API_KEY)) return 'key';
  } else {
    const c = readCookie(req, ADMIN_COOKIE);
    if (c && safeEqual(c, ADMIN_SESSION)) {
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
        let same = false; try { const origin = new URL(req.headers.origin); same = ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host; } catch {}
        if (!same) throw { status: 403, body: { ok: false, message: '跨站管理操作已拒绝' } };
      }
      return 'cookie';
    }
  }
  // 附加 Key（带限额的分享 Key）一律不得访问管理台——否则会暴露全部账号存档与统计
  if (token && findApiKey(token)) log('[security] 附加 Key 尝试访问管理台，已拒绝');
  throw { status: 401, body: { ok: false, message: '需要主 key（附加 key 无管理台权限）' } };
}

function sseErrorEvent(message, status) {
  return `data: ${JSON.stringify(openaiError(status, message))}\n\n`;
}

function sanitizeRemoteText(s, max = 300) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f<>"'`\\]/g, ' ')
    .trim()
    .slice(0, max);
}

function extractUpstreamErrorMsg(rawBody, status) {
  const fallback = `upstream HTTP ${status}`;
  if (!rawBody) return fallback;
  try {
    const obj = JSON.parse(rawBody);
    const msg = (obj && (
      obj.msg || obj.message ||
      (obj.error && (obj.error.message || obj.error.msg || obj.error.code)) ||
      (obj.data && (obj.data.msg || obj.data.message)) ||
      (obj.code != null && String(obj.code))
    )) || '';
    return msg ? sanitizeRemoteText(msg) : fallback;
  } catch {
    // 非 JSON 响应体（WAF 拦截页/纯文本）：截取前 200 字符脱敏透传，比裸状态码更可诊断
    const text = sanitizeRemoteText(String(rawBody), 200);
    return text || fallback;
  }
}

function maskKey(k) {
  if (!k) return '(未设置)';
  return k.length > 12 ? k.slice(0, 6) + '…' + k.slice(-4) : '…';
}

// ---------------------------------------------------------------------------
// SSE 统计与聚合
// ---------------------------------------------------------------------------

function makeStreamStats() {
  return { finish: null, usage: null, toolNames: [], sawFilter: false, model: null };
}

// 内容审核判定只看结构化信号：finish_reason=content-filter / 错误片的审核类 code。
// 旧实现对整片原文做「敏感」「审核」子串匹配，模型正文里出现这些词就会被误标。
const FILTER_ERR_RE = /content[-_ ]?filter|sensitive|moderation|敏感|审核/i;
function feedSseObj(stats, obj) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.model) stats.model = obj.model;
  if (obj.usage) stats.usage = obj.usage;
  if (obj.error && FILTER_ERR_RE.test(String(obj.error.code || '') + ' ' + String(obj.error.type || '') + ' ' + String(obj.error.message || ''))) stats.sawFilter = true;
  for (const ch of obj.choices || []) {
    if (ch.finish_reason) { stats.finish = ch.finish_reason; if (/^content[-_]filter$/.test(ch.finish_reason)) stats.sawFilter = true; }
    const delta = ch.delta || {};
    for (const tc of delta.tool_calls || []) {
      const nm = tc.function && tc.function.name;
      if (nm) stats.toolNames.push(nm);
    }
  }
}

// 分片规范化：CodeBuddy 网关每个分片都回显全量字段（content:"" / function_call:null /
// tool_calls:[] / refusal:"" / extra_fields:null），而标准 OpenAI 流的思考分片没有 content 键。
// 很多客户端按"分片里是否出现 content 键"切换思考/正文状态，空 content 会把思考链切碎。
// 这里只保留携带数据的键，role 仅保留首片，语义零损失，纯恢复标准形状。
function sanitizeSseChunk(obj, state) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.error) return obj; // 错误片原样透传
  const out = {};
  for (const k of ['id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier']) {
    if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  }
  if (obj.usage) out.usage = obj.usage;
  if (Array.isArray(obj.choices)) {
    out.choices = obj.choices.map(ch => {
      const c = {};
      if (ch.index !== undefined && ch.index !== null) c.index = ch.index;
      if (ch.finish_reason) c.finish_reason = ch.finish_reason;
      if (ch.logprobs !== undefined && ch.logprobs !== null) c.logprobs = ch.logprobs;
      const d = ch.delta || {};
      const nd = {};
      if (d.role && !state.roleSent) { nd.role = d.role; state.roleSent = true; }
      if (d.reasoning_content) nd.reasoning_content = d.reasoning_content;
      if (d.content) nd.content = d.content;
      if (d.function_call && (d.function_call.name || d.function_call.arguments)) nd.function_call = d.function_call;
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) nd.tool_calls = d.tool_calls;
      if (d.refusal) nd.refusal = d.refusal;
      c.delta = nd;
      return c;
    });
  }
  const hasData = Array.isArray(out.choices) && out.choices.some(ch =>
    (ch.delta && Object.keys(ch.delta).length > 0) || ch.finish_reason);
  if (!hasData && !out.usage) return null; // 纯噪声片，丢弃
  return out;
}

// 流式读取带上游空闲超时：UPSTREAM_STREAM_IDLE_MS 内无任何字节即 cancel reader 并抛错，
// 让上游连接被释放（fetch abort 只断在途请求，半挂起的流会永久占住连接）
function readWithIdle(reader, idleMs, signal) { return requestRuntime.readWithIdle(reader, idleMs, signal); }

async function collectStream(resp, onFirstByte, scope) {
  const contentParts = [];
  const reasoningParts = [];
  const toolCalls = new Map();
  let model = null, finish = null, usage = null;
  const reader = scope ? scope.reader(resp) : resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', receivedBytes = 0;
  try { for (;;) {
    const { done, value } = await readWithIdle(reader, UPSTREAM_STREAM_IDLE_MS, scope?.signal);
    if (done && !buf) break;
    receivedBytes += value?.length || 0;
    if (receivedBytes > 64 * 1024 * 1024) throw new Error('upstream response exceeds size limit');
    if (onFirstByte && value && value.length) { try { onFirstByte(); } catch { /* ignore */ } onFirstByte = null; }
    buf += done ? '\n' : decoder.decode(value, { stream: true });
    if (buf.length > 8 * 1024 * 1024) throw new Error('SSE event exceeds size limit');
    buf = requestRuntime.splitLines(buf, rawLine => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(data); } catch { return; }
      if (obj.error) throw new Error(sanitizeRemoteText(obj.error.message || 'upstream SSE error', 160));
      if (obj.model) model = obj.model;
      if (obj.usage) usage = obj.usage;
      for (const ch of obj.choices || []) {
        if (ch.finish_reason) finish = ch.finish_reason;
        const delta = ch.delta || {};
        if (delta.reasoning_content) reasoningParts.push(delta.reasoning_content);
        if (delta.content) contentParts.push(delta.content);
        for (const tc of delta.tool_calls || []) {
          const i = tc.index || 0;
          const slot = toolCalls.get(i) || { id: null, name: null, arguments: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function && tc.function.name) slot.name = tc.function.name;
          if (tc.function && tc.function.arguments) slot.arguments += tc.function.arguments;
          toolCalls.set(i, slot);
        }
      }
    });
    if (done) break;
  }
  } finally { if (scope) scope.release(reader); else requestRuntime.stopReader(reader) }
  let tcs = null;
  if (toolCalls.size) {
    tcs = [...toolCalls.entries()].sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ id: v.id, type: 'function', function: { name: v.name, arguments: v.arguments } }));
    finish = finish || 'tool_calls';
  }
  const message = { role: 'assistant', content: contentParts.join('') || null };
  if (reasoningParts.length) message.reasoning_content = reasoningParts.join('');
  if (tcs) message.tool_calls = tcs;
  return {
    id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'unknown',
    choices: [{ index: 0, message, finish_reason: finish || 'stop' }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// 上游调用
// ---------------------------------------------------------------------------

// 等响应头阶段（connect+TLS+首字节）超时控制：把调用方 signal 和超时合并成一个 signal。
// 收到响应头后必须 clear() 解除计时，否则流读阶段会被误杀（流读由 readWithIdle 的空闲超时接管）。
function withHeadersTimeout(signal) { return requestRuntime.withHeadersTimeout(signal, UPSTREAM_HEADERS_TIMEOUT_MS); }

async function callUpstream(cred, body, signal) {
  let headers = await requestRuntime.abortable(cred.getHeaders(), signal);
  signal?.throwIfAborted();
  const h1 = withHeadersTimeout(signal);
  let resp;
  try {
    resp = await fetch(cred.base() + CHAT_PATH, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: h1.signal,
    });
  } finally { h1.clear(); }
  if (resp.status === 401) {
    try { resp.body.cancel().catch(() => {}); } catch { /* ignore */ }
    log('上游返回 401，强制刷新 token 后重试一次');
    await requestRuntime.abortable(cred.refresh(), signal);
    headers = await requestRuntime.abortable(cred.getHeaders(), signal);
    signal?.throwIfAborted();
    const h2 = withHeadersTimeout(signal);
    try {
      resp = await fetch(cred.base() + CHAT_PATH, {
        method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: h2.signal,
      });
    } finally { h2.clear(); }
  }
  return resp;
}

// ---------------------------------------------------------------------------
// OAuth 登录（管理台用，官方 state/token 流程）
// ---------------------------------------------------------------------------

let loginSession = null; // { site, state, authUrl, createdAt, expiresAt, done }

function authStartHeaders(domain) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Domain': domain,
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'User-Agent': 'CLI/1.0.8 CodeBuddy/1.0.8',
    'X-Product': 'SaaS',
    'X-Request-ID': crypto.randomBytes(16).toString('hex'),
  };
}

function authPollHeaders(domain) {
  const rid = crypto.randomBytes(16).toString('hex');
  const span = crypto.randomBytes(8).toString('hex');
  return {
    'Accept': 'application/json, text/plain, */*',
    'Cache-Control': 'no-cache',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Request-ID': rid,
    'b3': `${rid}-${span}-1-`,
    'X-B3-TraceId': rid,
    'X-B3-SpanId': span,
    'X-B3-Sampled': '1',
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'X-Domain': domain,
    'User-Agent': 'CLI/1.0.8 CodeBuddy/1.0.8',
    'X-Product': 'SaaS',
  };
}

async function startLogin(site, checkinOnly) {
  const cfg = SITES[site];
  const nonce = crypto.randomBytes(8).toString('hex');
  const url = cfg.authBase + STATE_PATH + `?platform=CLI&nonce=${nonce}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: authStartHeaders(cfg.domain),
    body: JSON.stringify({ nonce }),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const data = await resp.json();
  if (!data || data.code !== 0 || !data.data || !data.data.state || !data.data.authUrl) {
    throw new Error(extractUpstreamErrorMsg(JSON.stringify(data), resp.status));
  }
  // authUrl 只展示给用户、从不主动请求，但仍校验 host 白名单
  let u;
  try { u = new URL(data.data.authUrl); } catch { throw new Error('上游返回的登录链接非法'); }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new Error('上游返回的登录链接 host 不在白名单');
  }
  loginSession = {
    site,
    checkinOnly: !!checkinOnly,
    state: data.data.state,
    authUrl: data.data.authUrl,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
    done: false,
  };
  return loginSession;
}

async function pollLogin(state) {
  if (!loginSession || loginSession.state !== state) {
    return { status: 'error', message: '没有进行中的登录会话，请先生成登录链接' };
  }
  if (Date.now() > loginSession.expiresAt) {
    return { status: 'expired' };
  }
  const cfg = SITES[loginSession.site];
  const url = cfg.authBase + TOKEN_PATH + `?state=${encodeURIComponent(state)}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: authPollHeaders(cfg.domain),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const data = await resp.json();
  if (data && data.code === 11217) {
    return { status: 'pending', left: Math.floor((loginSession.expiresAt - Date.now()) / 1000) };
  }
  if (data && data.code === 0 && data.data && data.data.accessToken) {
    const d = data.data;
    const jwt = decodeJwtPayload(d.accessToken);
    const credObj = {
      account: {
        uid: jwt.sub || jwt.uid || '',
        nickname: jwt.name || jwt.preferred_username || jwt.email || '',
        enterpriseId: null,
      },
      auth: {
        accessToken: d.accessToken,
        tokenType: d.tokenType || 'Bearer',
        expiresIn: d.expiresIn,
        expiresAt: Date.now() + (d.expiresIn || 0) * 1000,
        refreshToken: d.refreshToken,
        refreshExpiresIn: d.refreshExpiresIn,
        sessionState: d.sessionState,
        scope: d.scope,
        domain: d.domain || cfg.domain,
        lastRefreshTime: Date.now(),
      },
    };
    credObj.checkinOnly = !!loginSession.checkinOnly;
    const storedId = saveToStore(credObj);
    clearAccount403(uid8Of(credObj)); // 重新登录视为手动干预：清旧 403 标记退出观察池；若仍被拦，下次对话会再次入池
    const target = path.join(__dirname, 'auth.json');
    if (!credObj.checkinOnly) {
      // 正常登录：设为当前服务账号
      writeAuthFileAtomic(target, credObj);
      if (storedId) activeAccountId = storedId;
      try { cred = new CredentialManager(target); } catch (e) {
        return { status: 'error', message: '凭据写入但加载失败: ' + sanitizeRemoteText(e.message, 120) };
      }
    } else {
      // 仅签到：只入库 + 每日签到，不影响当前服务账号
      log(`[checkin] 新账号登记为仅签到: ${storedId || '(无名)'}`);
    }
    // 立即自动首签，领取当天的 100 积分（失败不影响登录）
    const checkinTarget = storedId ? path.join(AUTHS_DIR, storedId) : target;
    checkinFile(checkinTarget).then(r => {
      if (r.ok && storedId) { checkinState.accounts[storedId] = todayStr(); saveCheckinState(); }
      log(`[checkin] 新账号首签: ${r.ok ? '+' + ((r.data && r.data.credit) || 100) + ' 积分' : r.msg}`);
    }).catch(() => {});
    loginSession.done = true;
    log(`管理台登录成功: site=${loginSession.site} 到期=${new Date(credObj.auth.expiresAt).toISOString()}`);
    return {
      status: 'success',
      nickname: credObj.account.nickname,
      expiresAt: credObj.auth.expiresAt,
    };
  }
  return { status: 'error', message: extractUpstreamErrorMsg(JSON.stringify(data), resp.status) };
}

// ---------------------------------------------------------------------------
// Buddy 加油站每日签到（官方接口，与桌面端同一实现：POST 空 body + 标准鉴权头）
// 签到窗口起点见顶部常量 CHECKIN_AT（CB_CHECKIN_AT，默认 09:00）
// ---------------------------------------------------------------------------

const CHECKIN_STATE_FILE = path.join(AUTHS_DIR, '.checkin-state.json');
let checkinState = { lastRunDate: null, lastRunAt: null, lastResults: [], accounts: {} }; // accounts: 账号文件 -> 最后签到日期
let checkinRunning = false;

try {
  if (fs.existsSync(CHECKIN_STATE_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(CHECKIN_STATE_FILE, 'utf-8'));
    checkinState = { ...checkinState, ...parsed, accounts: parsed.accounts || {} };
  }
} catch { /* ignore */ }

function saveCheckinState() {
  try {
    fs.mkdirSync(AUTHS_DIR, { recursive: true });
    writeAuthFileAtomic(CHECKIN_STATE_FILE, checkinState);
  } catch (e) { storage.report(CHECKIN_STATE_FILE, e); throw e; }
}

function todayStr(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 对单个凭据文件执行签到（token 过期会先自动刷新并写回存档）
const checkinFlights = new Map();
function checkinFile(filePath) {
  const key = path.resolve(filePath);
  if (checkinFlights.has(key)) return checkinFlights.get(key);
  const task = checkinFileOnce(filePath).finally(() => checkinFlights.delete(key));
  checkinFlights.set(key, task);
  return task;
}
async function checkinFileOnce(filePath) {
  const cm = credManager(filePath);
  const headers = await cm.getHeaders();
  const resp = await fetch(cm.base() + CHECKIN_PATH, {
    method: 'POST', headers, body: '{}', redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* ignore */ }
  if (resp.status === 200 && data && data.code === 0 && data.data) {
    return { ok: true, data: data.data };
  }
  return {
    ok: false,
    code: data ? data.code : null,
    msg: sanitizeRemoteText((data && data.msg) || (`HTTP ${resp.status}`), 120),
  };
}

// 查询签到状态（不产生签到动作）
async function checkinStatusFile(filePath) {
  const cm = credManager(filePath);
  const headers = await cm.getHeaders();
  const resp = await fetch(cm.base() + CHECKIN_STATUS_PATH, {
    method: 'POST', headers, body: '{}', redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* ignore */ }
  if (resp.status === 200 && data && data.code === 0 && data.data) {
    return { ok: true, data: data.data };
  }
  return { ok: false, msg: sanitizeRemoteText((data && data.msg) || (`HTTP ${resp.status}`), 120) };
}

// 批量：为 auths/ 里所有账号签到
async function runDailyCheckinAll() {
  if (checkinRunning) return { ok: false, msg: '已有签到任务在进行中' };
  checkinRunning = true;
  try {
    const files = fs.readdirSync(AUTHS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    const results = [];
    for (const f of files) {
      try {
        const r = await checkinFile(path.join(AUTHS_DIR, f));
        results.push({ id: f, ...r });
        if (r.ok) { checkinState.accounts[f] = todayStr(); log(`[checkin] ${f}: ok +${(r.data && r.data.credit) || 100}`); }
        else if ((r.msg || '').includes('已签到')) { checkinState.accounts[f] = todayStr(); log(`[checkin] ${f}: 已签过（跳过）`); }
        else log(`[checkin] ${f}: ${r.msg}`);
      } catch (e) {
        results.push({ id: f, ok: false, msg: sanitizeRemoteText(e.message, 120) });
        log(`[checkin] ${f}: ✗ ${e.message}`);
      }
    }
    checkinState.lastRunDate = todayStr();
    checkinState.lastRunAt = Date.now();
    checkinState.lastResults = results;
    saveCheckinState();
    return { ok: true, results };
  } finally {
    checkinRunning = false;
  }
}

// 定时器：每 10 分钟检查，过了当天签到时间后，为所有"今天还没签"的账号签到（新增账号也会被补上）
setInterval(async () => {
  if (checkinRunning) return;
  checkinRunning = true;
  try {
    const [hh, mm] = CHECKIN_AT.split(':').map(Number);
    const n = new Date();
    const scheduled = new Date(n);
    scheduled.setHours(hh || 0, mm || 0, 0, 0);
    if (n < scheduled) return; // 当天签到时间未到
    fs.mkdirSync(AUTHS_DIR, { recursive: true });
    const files = fs.readdirSync(AUTHS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    const pending = files.filter(f => checkinState.accounts[f] !== todayStr());
    if (!pending.length) return;
    // 观察池内的账号暂停自动签到（手动签到仍可用）
    const skippedPool = [];
    const todo = [];
    for (const f of pending) {
      let u8 = null;
      try { u8 = uid8Of(JSON.parse(fs.readFileSync(path.join(AUTHS_DIR, f), 'utf-8'))); } catch { /* ignore */ }
      if (u8 && is403Flagged(u8)) skippedPool.push(f);
      else todo.push(f);
    }
    for (const f of skippedPool) log(`[checkin] ${f}: 观察池内，暂停自动签到`);
    if (!todo.length) return;
    log(`[checkin] 开始为 ${todo.length} 个未签账号签到`);
    for (const f of todo) {
      try {
        const r = await checkinFile(path.join(AUTHS_DIR, f));
        if (r.ok) {
          checkinState.accounts[f] = todayStr();
          log(`[checkin] ${f}: ok +${(r.data && r.data.credit) || 100}`);
        } else if ((r.msg || '').includes('已签到')) {
          checkinState.accounts[f] = todayStr(); // 官方确认已签 → 记账防重试噪音
          log(`[checkin] ${f}: 已签过（跳过）`);
        } else {
          log(`[checkin] ${f}: ${r.msg}（稍后重试）`);
        }
        if (checkinState.accounts[f] === todayStr()) {
          try { await runDailyExtras(path.join(AUTHS_DIR, f)); } catch (e) { log(`[daily] ${f}: ✗ ${e.message}`); }
        }
      } catch (e) {
        log(`[checkin] ${f}: ✗ ${e.message}`);
      }
    }
    checkinState.lastRunDate = todayStr();
    checkinState.lastRunAt = Date.now();
    saveCheckinState();
  } catch { /* ignore */ } finally { checkinRunning = false; }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// 账号剩余积分（官方 get-user-resource 接口，响应: Response.Data.Accounts[]）
// ---------------------------------------------------------------------------

function parseMaybeMs(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n > 1e12) return n;              // 毫秒时间戳
    if (n > 1e9) return n * 1000;        // 秒时间戳
    return null;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

async function creditsFile(filePath) {
  const cm = credManager(filePath);
  const headers = await cm.getHeaders();
  headers['Accept-Language'] = 'zh';
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3], // AccountStatus.valid / usedUp
    PackageStartTimeRangeBegin: '2024-12-01 21:25:00',
    PackageStartTimeRangeEnd: fmt(now),
  };
  let lastErr = 'HTTP ?';
  for (const p of ['/billing/meter/get-user-resource', '/v2/billing/meter/get-user-resource']) {
    let data = null;
    try {
      const resp = await fetch(cm.base() + p, {
        method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      data = await resp.json().catch(() => null);
      lastErr = 'HTTP ' + resp.status;
    } catch (e) {
      lastErr = sanitizeRemoteText(e.message, 100);
      continue;
    }
    const accounts = data && data.data && data.data.Response && data.data.Response.Data && data.data.Response.Data.Accounts;
    if (Array.isArray(accounts)) {
      const packs = accounts.map(r => ({
        packageCode: r.PackageCode || '',
        packageName: r.PackageName || '',
        total: Number(r.CycleCapacitySizePrecise) || 0,
        left: Number(r.CycleCapacityRemainPrecise) || 0,
        expireAt: parseMaybeMs(r.DeductionEndTime || r.CycleEndTime),
      }));
      const activePacks = packs.filter(p => p.left > 0 && p.expireAt);
      const earliestExpire = activePacks.length ? Math.min(...activePacks.map(p => p.expireAt)) : null;
      return {
        ok: true,
        totalLeft: packs.reduce((s, x) => s + x.left, 0),
        earliestExpire,
        packs,
        uid: String((cm.session().account || {}).uid || ''),
      };
    }
    lastErr = sanitizeRemoteText(JSON.stringify((data && (data.msg || data.code)) || lastErr), 120);
  }
  return { ok: false, msg: lastErr };
}

const creditsCache = { at: 0, data: null };
// 同参数并发请求共享一次扫描（auths 遍历 × creditsFile 远端拉取较贵，
// 管理台多点并发 /admin/api/credits 时不再重复打上游）
const _creditsInflight = new Map(); // key -> Promise

async function getAllCredits(force) {
  if (!force && creditsCache.data && Date.now() - creditsCache.at < 5 * 60_000) {
    return creditsCache.data;
  }
  const key = force ? 'f' : 'n';
  const running = _creditsInflight.get(key);
  if (running) return running;
  const p = _getAllCreditsImpl(force);
  _creditsInflight.set(key, p);
  p.finally(() => { if (_creditsInflight.get(key) === p) _creditsInflight.delete(key); }).catch(() => {});
  return p;
}

async function _getAllCreditsImpl(force) {
  if (!force && creditsCache.data && Date.now() - creditsCache.at < 5 * 60_000) {
    return creditsCache.data;
  }
  let files = [];
  try {
    fs.mkdirSync(AUTHS_DIR, { recursive: true });
    files = fs.readdirSync(AUTHS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  } catch { /* ignore */ }
  const out = [];
  for (const f of files) {
    try {
      const r = await creditsFile(path.join(AUTHS_DIR, f));
      const k8 = String(r.uid || '').slice(0, 8);
      if (k8 && r.ok) {
        const hh = accountHealth[k8] = accountHealth[k8] || {};
        hh.balance = r.totalLeft;
        hh.earliestExpire = r.earliestExpire || null;
        hh.balanceAt = Date.now();
      }
      out.push({ id: f, active: f === activeAccountId, ...r });
    } catch (e) {
      out.push({ id: f, active: f === activeAccountId, ok: false, msg: sanitizeRemoteText(e.message, 100) });
    }
  }
  creditsCache.at = Date.now();
  creditsCache.data = { ok: true, fetchedAt: creditsCache.at, accounts: out };
  return creditsCache.data;
}

// ---------------------------------------------------------------------------
// 动态模型列表（官方 /v2/enterprises/personal/models，缓存 10 分钟，失败回退内置清单）
// ---------------------------------------------------------------------------

const MODELS_UPSTREAM_PATH = '/v2/enterprises/personal/models';
const modelsCache = { at: 0, list: null };
// 上游目录拉取去重：status/models/refresh 并发时共享一次请求；
// strict（手动刷新）与非 strict 分开合并，避免互相吞错
const _modelsInflight = new Map();

async function fetchUpstreamModels(cm) {
  const headers = await cm.getHeaders();
  const resp = await fetch(cm.base() + MODELS_UPSTREAM_PATH, {
    method: 'GET', headers, redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* ignore */ }
  const arr = data && data.data && Array.isArray(data.data.models) ? data.data.models
    : (data && Array.isArray(data.models) ? data.models : null);
  if (!arr) throw new Error(sanitizeRemoteText((data && data.msg) || (`HTTP ${resp.status}`), 100));
  return arr
    .filter(m => m && typeof m.id === 'string' && m.id)
    .filter(m => !(Array.isArray(m.tags) ? m.tags.map(String) : []).includes('text-to-image'))
    .map(m => ({ id: m.id, name: typeof m.name === 'string' ? m.name : '', tags: Array.isArray(m.tags) ? m.tags.map(String) : [], credits: typeof m.credits === 'string' ? m.credits : '' }));
}

async function getAvailableModels(cm, force, strict) {
  if (!force && modelsCache.list && Date.now() - modelsCache.at < 10 * 60_000) {
    return modelsCache.list;
  }
  const key = strict ? 's' : 'n';
  const running = _modelsInflight.get(key);
  if (running) return running;
  const p = _getAvailableModelsImpl(cm, strict);
  _modelsInflight.set(key, p);
  p.finally(() => { if (_modelsInflight.get(key) === p) _modelsInflight.delete(key); }).catch(() => {});
  return p;
}

async function _getAvailableModelsImpl(cm, strict) {
  if (cm) {
    try {
      const list = await fetchUpstreamModels(cm);
      if (list.length) {
        for (const d of DEFAULT_MODELS) {
          if (!list.some(m => m.id === d)) list.push({ id: d, name: '', tags: [] });
        }
        modelsCache.list = list;
        modelsCache.at = Date.now();
        log(`[models] 已从上游拉取 ${list.length} 个可用模型`);
      }
    } catch (e) {
      // strict（手动刷新）要把失败原因抛给调用方，否则静默返回旧清单会让用户误以为已是最新
      if (strict) throw e;
      log(`[models] 上游拉取失败，使用内置清单: ${sanitizeRemoteText(e.message, 100)}`);
    }
  }
  return modelsCache.list || DEFAULT_MODELS.map(id => ({ id, name: '', tags: [] }));
}

// ---------------------------------------------------------------------------
// Token 消耗统计（按模型、按天持久化；本周/累计由聚合计算；无消耗不记录）
// ---------------------------------------------------------------------------

const USAGE_FILE = path.join(__dirname, 'usage-stats.json');
let usageStats = { days: {}, total: {}, accountStats: {}, firstAt: null, hours: {}, hourlySince: Date.now() };
try {
  if (fs.existsSync(USAGE_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
    usageStats = { days: parsed.days || {}, total: parsed.total || {}, accountStats: parsed.accountStats || {}, firstAt: parsed.firstAt || null, hours: parsed.hours || {}, hourlySince: parsed.hourlySince || Date.now() };
  }
} catch { /* ignore */ }

// 用量统计体积大（31 天 × 24 小时 × 模型/账号）：紧凑 JSON；热路径走异步写，停机/恢复走同步写
function saveUsageStats() { storage.write(USAGE_FILE, usageStats, { compact: true }); }
function saveUsageStatsAsync() { return storage.writeAsync(USAGE_FILE, usageStats, { compact: true }); }
saveUsageStatsAsync.sync = saveUsageStats;

// 31 天窗口修剪：原先每条请求都遍历全部小时/日期键做 Date.parse，改为每小时最多一次
let _usagePrunedAt = 0;
function pruneUsageStats(force) {
  const now = Date.now();
  if (!force && now - _usagePrunedAt < 3600_000) return;
  _usagePrunedAt = now;
  const cutoff = now - 31 * 86400 * 1000;
  for (const key of Object.keys(usageStats.hours || {})) {
    if (Date.parse(key.slice(0, 10)) < cutoff) delete usageStats.hours[key];
  }
  for (const k of Object.keys(usageStats.days)) {
    const t = Date.parse(k);
    if (!Number.isNaN(t) && t < cutoff) delete usageStats.days[k];
  }
  for (const a of Object.values(usageStats.accountStats || {})) {
    for (const k of Object.keys(a.days || {})) {
      const t = Date.parse(k);
      if (!Number.isNaN(t) && t < cutoff) delete a.days[k];
    }
    for (const k of Object.keys(a.modelDays || {})) {
      const t = Date.parse(k);
      if (!Number.isNaN(t) && t < cutoff) delete a.modelDays[k];
    }
  }
}

// usageStats 变更计数：recordUsage / restore 递增，aggregateUsage 用版本号做短 TTL 缓存
let usageStatsVer = 0;

function recordUsage(model, servedUid8, usage, servedName) {
  try {
    if (!usage || typeof usage !== 'object') return; // 无 usage（失败/被拦）不记录
    const m = String(model || 'unknown');
    const day = todayStr();
    const inc = {
      requests: 1,
      prompt: Number(usage.prompt_tokens) || 0,
      cached: cachedTokensOf(usage),
      completion: Number(usage.completion_tokens) || 0,
      total: Number(usage.total_tokens) || ((Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0)),
      credit: creditEstimate(m, usage.prompt_tokens, usage.completion_tokens, usage),
    };
    // 实时扣减本地余额跟踪（官方余额每 pollMin 分钟校准一次）
    if (inc.credit > 0 && servedUid8) {
      const hh = accountHealth[servedUid8] = accountHealth[servedUid8] || {};
      if (typeof hh.balance === 'number') {
        hh.balance = Math.max(0, Math.round((hh.balance - inc.credit) * 1000) / 1000);
      }
    }
    const bump = (map) => {
      const slot = map[m] = map[m] || { requests: 0, prompt: 0, cached: 0, completion: 0, total: 0, credit: 0 };
      slot.requests += inc.requests;
      slot.prompt += inc.prompt;
      slot.cached = Math.round(((slot.cached || 0) + inc.cached) * 1000) / 1000;
      slot.completion += inc.completion;
      slot.total += inc.total;
      slot.credit = Math.round((slot.credit + inc.credit) * 1000) / 1000;
    };
    const bumpNum = (o) => {
      o.requests += inc.requests;
      o.prompt += inc.prompt;
      o.cached = Math.round(((o.cached || 0) + inc.cached) * 1000) / 1000;
      o.completion += inc.completion;
      o.total += inc.total;
      o.credit = Math.round((o.credit + inc.credit) * 1000) / 1000;
    };
    const dayMap = usageStats.days[day] = usageStats.days[day] || {};
    bump(dayMap);
    usageStats.hours = usageStats.hours || {};
    const hourKey = day + 'T' + String(new Date().getHours()).padStart(2, '0');
    const hour = usageStats.hours[hourKey] = usageStats.hours[hourKey] || { models: {}, accounts: {} };
    bump(hour.models);
    if (servedUid8) bump(hour.accounts[servedUid8] = hour.accounts[servedUid8] || {});
    bump(usageStats.total);
    // 按账号维度 + 账号×模型交叉维度（供管理台按账号/模型筛选）
    if (servedUid8) {
      usageStats.accountStats = usageStats.accountStats || {};
      const acc = usageStats.accountStats[servedUid8] = usageStats.accountStats[servedUid8] ||
        { name: servedName || servedUid8, days: {}, modelDays: {}, total: { requests: 0, prompt: 0, cached: 0, completion: 0, total: 0, credit: 0 } };
      if (servedName) acc.name = servedName;
      const ad = acc.days[day] = acc.days[day] || { requests: 0, prompt: 0, cached: 0, completion: 0, total: 0, credit: 0 };
      bumpNum(ad);
      bumpNum(acc.total);
      const md = acc.modelDays = acc.modelDays || {};
      const mm = md[day] = md[day] || {};
      bump(mm);
    }
    if (!usageStats.firstAt) usageStats.firstAt = Date.now();
    usageStatsVer++;
    // 热路径不落盘：5s 合批防抖写（进程退出前 flushDeferredWrites 兜底），
    // 避免每条 SSE 流结束都同步 writeFileSync 卡住事件循环
    deferWrite('usageStats', saveUsageStatsAsync);
    // 只保留 31 天的日明细（本周视图只需 7 天）；每小时修剪一次
    pruneUsageStats(false);
  } catch { /* 统计失败不影响主流程 */ }
}

// /admin/api/status 高频调用聚合：usageStats 不变时 500ms 内直接复用上次结果，
// 避免管理台轮询每次都重算 accounts/cross 全表
let _aggUsageCache = { ver: -1, at: 0, data: null };
function aggregateUsage() {
  const now = Date.now();
  if (_aggUsageCache.data && _aggUsageCache.ver === usageStatsVer && now - _aggUsageCache.at < 500) {
    return _aggUsageCache.data;
  }
  const data = _aggregateUsageImpl();
  _aggUsageCache = { ver: usageStatsVer, at: now, data };
  return data;
}

function _aggregateUsageImpl() {
  const today = todayStr();
  const weekStart = todayStr(new Date(Date.now() - 6 * 86400 * 1000));
  const week = {};
  for (const [day, models] of Object.entries(usageStats.days)) {
    if (day < weekStart) continue;
    for (const [m, v] of Object.entries(models)) {
      const slot = week[m] = week[m] || { requests: 0, prompt: 0, cached: 0, completion: 0, total: 0, credit: 0 };
      slot.requests += v.requests || 0;
      slot.prompt += v.prompt || 0;
      slot.cached = Math.round((slot.cached + (v.cached || 0)) * 1000) / 1000;
      slot.completion += v.completion || 0;
      slot.total += v.total || 0;
      slot.credit = Math.round((slot.credit + (v.credit || 0)) * 1000) / 1000;
    }
  }
  // 按账号聚合
  const accounts = [];
  for (const [uid8, a] of Object.entries(usageStats.accountStats || {})) {
    const row = { uid8, name: a.name || uid8, today: 0, week: 0, total: 0, reqT: 0, reqAll: 0, credit: 0, creditT: 0 };
    if (a.days && a.days[today]) {
      row.today = a.days[today].total || 0;
      row.reqT = a.days[today].requests || 0;
      row.creditT = a.days[today].credit || 0;
    }
    for (const [day, v] of Object.entries(a.days || {})) {
      if (day >= weekStart) row.week += v.total || 0;
    }
    row.total = (a.total && a.total.total) || 0;
    row.reqAll = (a.total && a.total.requests) || 0;
    row.credit = (a.total && a.total.credit) || 0;
    accounts.push(row);
  }
  accounts.sort((x, y) => y.total - x.total);
  // 账号×模型交叉聚合（供管理台按账号/模型/都选筛选）
  const cross = [];
  for (const [uid8, a] of Object.entries(usageStats.accountStats || {})) {
    const models = {};
    for (const [day, mm] of Object.entries(a.modelDays || {})) {
      for (const [m, v] of Object.entries(mm)) {
        const slot = models[m] = models[m] || { today: 0, week: 0, total: 0, reqT: 0, reqAll: 0, creditT: 0, credit: 0, cached: 0 };
        if (day === today) {
          slot.today += v.total || 0;
          slot.reqT += v.requests || 0;
          slot.creditT = Math.round((slot.creditT + (v.credit || 0)) * 1000) / 1000;
        }
        if (day >= weekStart) slot.week += v.total || 0;
        slot.total += v.total || 0;
        slot.reqAll += v.requests || 0;
        slot.credit = Math.round((slot.credit + (v.credit || 0)) * 1000) / 1000;
        slot.cached = Math.round((slot.cached + (v.cached || 0)) * 1000) / 1000;
      }
    }
    cross.push({ uid8, name: a.name || uid8, models });
  }
  return { todayDate: today, weekStart, today: usageStats.days[today] || {}, week, total: usageStats.total, firstAt: usageStats.firstAt, accounts, cross,
    // 原始按日×模型明细（31 天窗口），供管理台 7 日走势图按平台前缀聚合过滤
    daysRaw: usageStats.days || {}, hoursRaw: usageStats.hours || {},
    hourlySince: usageStats.hourlySince, serverNow: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    accountDaysRaw: Object.fromEntries(Object.entries(usageStats.accountStats || {}).map(([id, a]) => [id, {name:a.name, days:a.modelDays || {}}])) };
}

// ---------------------------------------------------------------------------
// 一键体检：所有账号 × 所有模型 可用性矩阵（结果持久化，探测时顺带更新模型限额标记）
// ---------------------------------------------------------------------------

const CHECKUP_FILE = path.join(__dirname, 'checkup-result.json');
let checkupRunning = false;
let checkupCache = null;
try { if (fs.existsSync(CHECKUP_FILE)) checkupCache = JSON.parse(fs.readFileSync(CHECKUP_FILE, 'utf-8')); } catch { /* ignore */ }

// 体检/轮换探测用模型：优先取模型目录里第一个免费模型（倍率 0 不会消耗余额），
// 免费模型没有配额（6004）问题更贴近"账号可用性"判断；目录为空才回退 hy4-preview
function pickProbeModel() {
  const list = modelsCache.list || [];
  const free = list.find(m => modelMultiplier(m.id) === 0);
  return (free && free.id) || (list[0] && list[0].id) || 'hy4-preview';
}

async function probeOne(cm, uid8, model) {
  try {
    const headers = await cm.getHeaders();
    const payload = JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true }, max_tokens: 1 });
    const resp = await fetch(cm.base() + CHAT_PATH, { method: 'POST', headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(25_000) });
    if (resp.status === 200) {
      try { await resp.body.cancel(); } catch { /* ignore */ }
      clearAccount403(uid8);
      return { ok: true };
    }
    let data = null;
    try { data = await resp.json(); } catch { /* ignore */ }
    const msg = sanitizeRemoteText((data && data.msg) || (`HTTP ${resp.status}`), 120);
    if (resp.status === 403 && ((data && data.code === 11140) || /request illegal|safety review/i.test(msg))) {
      markAccount403(uid8, msg);
      return { ok: false, kind: 'blocked403', msg };
    }
    if (resp.status === 429 && data && data.code === 6004) {
      const until = parseResetTimeMs((data && data.msg) || '');
      markBlockedModel(uid8, model, until, msg);
      return { ok: false, kind: 'capped', until, msg };
    }
    return { ok: false, kind: 'error', msg };
  } catch (e) {
    return { ok: false, kind: 'error', msg: sanitizeRemoteText(e.message, 80) };
  }
}

async function runCheckup() {
  if (checkupRunning) return { ok: false, msg: '体检正在进行中' };
  checkupRunning = true;
  try {
    const accounts = listAccounts().filter(a => a.uid);
    const models = (await getAvailableModels(cred)).map(m => m.id);
    const cms = {};
    for (const a of accounts) {
      try { cms[a.uid] = credManager(path.join(AUTHS_DIR, a.id)); } catch { /* ignore */ }
    }
    const tasks = [];
    for (const a of accounts) for (const m of models) tasks.push({ uid8: a.uid, model: m });
    const results = {};
    let idx = 0;
    async function worker() {
      while (idx < tasks.length) {
        const t = tasks[idx++];
        const cm = cms[t.uid8];
        results[t.uid8 + '|' + t.model] = cm
          ? await probeOne(cm, t.uid8, t.model)
          : { ok: false, kind: 'error', msg: '凭据不可用' };
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    checkupCache = {
      at: Date.now(),
      accounts: accounts.map(a => ({ id: a.id, nickname: a.nickname, uid: a.uid })),
      models,
      results,
    };
    try { writeAuthFileAtomic(CHECKUP_FILE, checkupCache); } catch { /* ignore */ }
    log(`[checkup] 体检完成: ${models.length} 模型 × ${accounts.length} 账号`);
    return { ok: true, ...checkupCache };
  } finally {
    checkupRunning = false;
  }
}

// ---------------------------------------------------------------------------
// 任务中心 / 成长任务自动化（判据移植自 workbuddy2api-panel 逆向成果）
//   - 任务列表/接受/领奖：growth 域（chatBase /v2/activity/growth/*，领奖走 Web 域）
//   - 行为事件上报：POST /v2/report（body 为事件数组，按 CLI/桌面/Web/小程序四种指纹）
//   - 日常链：活跃上报(点亮连登) + 补签卡 + 礼包 + 连登档位兑换 + 抽奖 + 猫猫旅行
//   - 说明：report body 必须是数组；桌面指纹 X-Domain 是整个 base URL 而非域名；
//     chat_request_send 的 userId 缺失会被上游 200 静默丢弃
// ---------------------------------------------------------------------------

const taskSleep = ms => new Promise(r => setTimeout(r, ms));
const hex32 = () => crypto.randomBytes(16).toString('hex');
const uuidv4 = () => crypto.randomUUID();
const sha256hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const tail8 = s => String(s || '').slice(-8);
const TASK_REPORT_GAP = 1050;

function taskCmOf(id) {
  const f = accountFile(id);
  if (!f || !fs.existsSync(f)) return null;
  try { return credManager(f); } catch { return null; }
}

// BillingHeaders 口径：getHeaders 基础上覆盖 UA / X-CodeBuddy-Request / Accept-Language
async function taskHeaders(cm) {
  const h = await cm.getHeaders();
  h['User-Agent'] = 'WorkBuddy/5.5.4';
  h['X-CodeBuddy-Request'] = '1';
  h['Accept-Language'] = cm.site() === 'cn' ? 'zh-CN' : 'en-US';
  return h;
}

// 统一信封：上游一律 {code,msg,data}；code!=0 视为业务错误
async function taskCall(cm, base, method, path, body, extraHeaders) {
  const headers = await taskHeaders(cm);
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const resp = await fetch(base + path, {
    method, headers,
    body: method === 'GET' ? undefined : JSON.stringify(body === undefined ? {} : body),
    redirect: 'error', signal: AbortSignal.timeout(25_000),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* ignore */ }
  if (resp.status >= 400 || !data || data.code !== 0) {
    const msg = sanitizeRemoteText((data && (data.msg || data.message)) || `HTTP ${resp.status}`, 160);
    const err = new Error(msg);
    err.status = resp.status; err.code = data ? data.code : null;
    throw err;
  }
  return data.data;
}

const growthCall = (cm, method, path, body, extra) => taskCall(cm, cm.base(), method, path, body, extra);
const billingCall = (cm, method, path, body, extra) => taskCall(cm, SITES[cm.site()].billingBase, method, path, body, extra);
const webBaseOf = cm => SITES[cm.site()].webBase;

// ---- 成长任务列表 / 接受 / 领奖 ----

function parseTaskItem(t) {
  let cur = Number(t.current) || 0, tgt = Number(t.target) || 0;
  if (t.progress && typeof t.progress === 'object') {
    if (Number(t.progress.target) > 0 || Number(t.progress.current) > 0) {
      cur = Number(t.progress.current) || 0;
      tgt = Number(t.progress.target) || 0;
    }
  }
  const claimed = t.accept_status === 'claimed';
  return {
    code: t.task_code, title: t.title || t.task_code, desc: t.description || t.task_desc || '',
    credit: Number(t.reward_credit) || 0, energy: Number(t.reward_energy) || 0,
    hasReward: !!t.has_reward, rewardBuddy: !!t.reward_buddy,
    taskType: t.task_type || '', tag: t.tag || '', locked: !!t.locked,
    acceptStatus: t.accept_status || '', status: t.status || '',
    current: cur, target: tgt,
    claimable: !claimed && tgt > 0 && cur >= tgt,
    claimed,
  };
}

async function taskList(cm, mp) {
  const data = await growthCall(cm, 'GET', '/v2/activity/growth/tasks', undefined,
    mp ? { 'X-Client-Platform': 'miniprogram' } : undefined);
  const arr = (data && data.tasks) || [];
  return arr.map(parseTaskItem);
}

// mp 口径列表是默认口径超集（含小程序专属码），按 task_code 合并去重
async function taskListMerged(cm) {
  const base = await taskList(cm, false);
  let mp = [];
  try { mp = await taskList(cm, true); } catch { /* mp 口径失败不阻塞 */ }
  const seen = new Set(base.map(t => t.code));
  for (const t of mp) {
    if (!seen.has(t.code)) { t.mp = true; base.push(t); }
  }
  return base;
}

async function taskAccept(cm, codes, mp) {
  if (!codes.length) return;
  // 上游批量 accept 上限约 20 条
  for (let i = 0; i < codes.length; i += 20) {
    await growthCall(cm, 'POST', '/v2/activity/growth/tasks/accept',
      { task_codes: codes.slice(i, i + 20) },
      mp ? { 'X-Client-Platform': 'miniprogram' } : undefined);
    if (i + 20 < codes.length) await taskSleep(TASK_REPORT_GAP);
  }
}

// 领奖：Web 域路径参数形式（code 在路径、无 body）；mp 码先走 chat 域 mp 头，400 降级 web
async function taskClaim(cm, code, mp) {
  const doWeb = async () => {
    const h = await taskHeaders(cm);
    const web = webBaseOf(cm);
    Object.assign(h, {
      'Accept': 'application/json, text/plain, */*',
      'Origin': web, 'Referer': web + '/profile/growth-center',
      'x-client-platform': 'web',
      'User-Agent': 'WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1',
    });
    const resp = await fetch(web + '/activity/growth/tasks/' + encodeURIComponent(code) + '/claim', {
      method: 'POST', headers: h, redirect: 'error', signal: AbortSignal.timeout(25_000),
    });
    let data = null;
    try { data = await resp.json(); } catch { /* ignore */ }
    if (resp.status >= 400 || !data || data.code !== 0) {
      const err = new Error(sanitizeRemoteText((data && data.msg) || `HTTP ${resp.status}`, 160));
      err.status = resp.status;
      throw err;
    }
    const d = data.data || {};
    return { alreadyClaimed: !!d.already_claimed, credit: Number(d.credit) || 0, energy: Number(d.energy) || 0 };
  };
  if (!mp) return doWeb();
  try {
    const d = await growthCall(cm, 'POST', '/activity/growth/tasks/' + encodeURIComponent(code) + '/claim',
      undefined, { 'X-Client-Platform': 'miniprogram' });
    return { alreadyClaimed: !!(d && d.already_claimed), credit: Number(d && d.credit) || 0, energy: Number(d && d.energy) || 0 };
  } catch (e) {
    if (e.status === 400) return doWeb();
    throw e;
  }
}

// ---- /v2/report 事件构造（四种指纹族） ----

function taskIdentity(cm) {
  const s = cm.session();
  const acct = s.account || {};
  return { uid: String(acct.uid || ''), nickname: String(acct.nickname || ''), enterpriseId: String(acct.enterpriseId || '') };
}

// CLI 族：chat_request_send（billing 域，点亮每日连登 / chat_5 / 模型体验类）
function evCliChatRequest(uid, convId, reqId, modelId, modelName) {
  const now = Date.now();
  return {
    eventCode: 'chat_request_send', timestamp: now, reportDelay: 0, mode: 'craft',
    conversationId: convId, requestId: reqId || convId, inputLength: 12,
    requestModelId: modelId || 'deepseek-v4-flash',
    requestModelName: modelName || modelId || 'DeepSeek V4 Flash',
    isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false, codebaseEnable: false,
    maxToken: 0, maxSteps: 0, temperature: 0, maxRetries: 0,
    mentionContexts: [], knowledgeId: [], knowledgeName: [],
    codebaseId: '', mentionContextCount: 0, command: '', expertId: '',
    recommendId: '', skillId: '', skillCount: 0, totalCount: 0, fileUri: '',
    presentAt: now, traceId: '', rootRequestId: reqId || convId,
    parentConversationId: convId, agentName: 'default', agentType: 'conversation',
    userId: uid,
  };
}

async function reportCli(cm, events) {
  const h = await taskHeaders(cm);
  const resp = await fetch(SITES[cm.site()].billingBase + '/v2/report', {
    method: 'POST', headers: h, body: JSON.stringify(events),
    redirect: 'error', signal: AbortSignal.timeout(25_000),
  });
  if (resp.status >= 400) throw new Error(`report HTTP ${resp.status}`);
}

// 桌面族公共指纹
function desktopFp(idn) {
  const now = Date.now();
  return {
    timezone: 'Asia/Shanghai', reportDelay: 2000,
    userId: idn.uid, username: idn.nickname, userNickname: idn.nickname,
    product: 'SaaS', releaseDate: 1789036585355,
    commit: '5f9692923c93033111c51ad7b003eb80204a9b75',
    ideName: 'WorkBuddy', ideType: 'WorkBuddy', ideVersion: '5.5.6',
    machineId: sha256hex('machine:' + idn.uid).slice(0, 36),
    sessionId: sha256hex('session:' + idn.uid).slice(0, 18),
    extName: 'workbuddy-desktop', extVersion: '5.5.6',
    os: 'win32', arch: 'x64', osVersion: '10.0.26220', cpuCores: 20, memorySize: 24,
    timestamp: now, presentAt: now,
  };
}

async function reportDesktop(cm, events) {
  const idn = taskIdentity(cm);
  const fp = desktopFp(idn);
  const arr = events.map(ev => ({ ...fp, ...ev }));
  const h = await taskHeaders(cm);
  const chatBase = cm.base();
  Object.assign(h, {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1',
    'X-Domain': chatBase, // 桌面指纹的 X-Domain 是整个 base URL
    'X-Product': 'SaaS',
    'X-Request-ID': hex32(),
  });
  delete h['X-CodeBuddy-Request']; delete h['X-Enterprise-Id']; delete h['X-Tenant-Id'];
  const resp = await fetch(chatBase + '/v2/report', {
    method: 'POST', headers: h, body: JSON.stringify(arr),
    redirect: 'error', signal: AbortSignal.timeout(25_000),
  });
  if (resp.status >= 400) throw new Error(`desktop report HTTP ${resp.status}`);
}

// Web 族：页面行为事件（Library_read）
async function reportWeb(cm, ev) {
  const idn = taskIdentity(cm);
  const web = webBaseOf(cm);
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
  const body = [{
    timestamp: Date.now(), reportDelay: 0,
    os: 'Win32', arch: '', osVersion: '10.0', userAgent: ua,
    machineId: sha256hex('webmachine:' + idn.uid),
    userId: idn.uid, userNickname: idn.nickname, enterpriseId: idn.enterpriseId,
    ...ev,
  }];
  const h = await taskHeaders(cm);
  Object.assign(h, {
    'x-client-platform': 'web', 'Origin': web, 'Referer': ev.pageURL || web,
    'User-Agent': ua,
  });
  const resp = await fetch(web + '/v2/report', {
    method: 'POST', headers: h, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(25_000),
  });
  if (resp.status >= 400) throw new Error(`web report HTTP ${resp.status}`);
}

// 桌面端「成功对话」6 事件链（RichMeow_Chat / 模板 / 灵感 / 画布等的 JOIN 链）
function desktopChatSeq(convId, reqId, msgId, modelId, modelName) {
  const m = modelId || 'fast-model';
  const mn = modelName || m;
  return [
    { eventCode: 'agent_task_created', source: 'LOCAL', name: 'working', task_target: 'local', mode: 'craft',
      requestModelId: m, requestModelName: mn,
      has_repo: false, repo_type: 'none', workspace_type: 'empty',
      has_connector: false, connector_types: [], has_mention: false, mention_types: [],
      has_template: false, action: '', template_name: '',
      has_expert: false, expert_id: '', expert_name: '', expert_industry_id: '',
      has_skill: false, skill_names: [],
      conversationId: convId, messageId: msgId, buddyId: '', buddyName: '' },
    { eventCode: 'chat_message_send', messageId: msgId + '-assistant', historyCount: 0,
      isContextTruncated: false, currentStepCount: 1, traceId: reqId,
      rootRequestId: reqId, parentConversationId: convId, agentName: 'cli', agentType: 'main' },
    { eventCode: 'chat_request_send', inputLength: 24, isPlan: false,
      isAutoExecuteTerminal: false, isAutoModify: false, codebaseEnable: false,
      maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [],
      codebaseId: '', mentionContextCount: 0, command: '',
      recommendId: '', skillId: '', skillCount: 0, totalCount: 0,
      traceId: reqId, rootRequestId: reqId, parentConversationId: convId,
      agentName: 'cli', agentType: 'main',
      'codebuddy.session_id': convId, 'codebuddy.conversation_request_id': reqId },
    { eventCode: 'chat_message_response', messageId: msgId + '-assistant', responseModelId: m,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: '', finishReason: 'stop',
      firstTokenAt: Date.now(), traceId: reqId, conversationId: convId,
      rootRequestId: reqId, parentConversationId: convId, agentName: 'cli', agentType: 'main',
      'codebuddy.session_id': convId, 'codebuddy.conversation_request_id': reqId },
    { eventCode: 'chat_message_status', messageId: msgId + '-assistant', messageErrorCode: '0',
      traceId: reqId, rootRequestId: reqId, parentConversationId: convId,
      agentName: 'cli', agentType: 'main' },
    { eventCode: 'chat_request_response', mode: 'craft', toolCallCount: 0,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: '', finishReason: 'stop',
      rootRequestId: reqId, parentConversationId: convId },
  ];
}

// 真实桌面指纹对话：从 SSE 抓服务端 requestId（自造 UUID 不计数）
async function taskRealChat(cm, expertId, requestedModel = 'fast-model') {
  const convId = 'wb2api-conv-' + Date.now();
  const h = await taskHeaders(cm);
  const chatBase = cm.base();
  Object.assign(h, {
    'Accept': 'text/event-stream',
    'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1',
    'X-Domain': chatBase, 'X-Product': 'SaaS',
    'X-Conversation-ID': convId,
    'X-Request-ID': String(Date.now()) + String(Math.floor(Math.random() * 1e6)),
    'X-Agent-Intent': 'craft', 'X-Agent-Type': 'main',
    'X-IDE-Name': 'WorkBuddy', 'X-IDE-Type': 'WorkBuddy', 'X-IDE-Version': '5.5.6',
    'x-codebuddy-request': '1',
  });
  if (expertId) h['X-Expert-Id'] = expertId;
  const resp = await fetch(chatBase + CHAT_PATH, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      model: requestedModel,
      messages: [
        { role: 'system', content: 'You are a helpful assistant. 当前处于中文环境，使用简体中文回答。' },
        { role: 'user', content: '1+1等于几？直接回答。' },
      ],
      agent: 'cli', temperature: 1, stream: true, stream_options: { include_usage: true },
    }),
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
  if (resp.status !== 200) {
    let msg = `HTTP ${resp.status}`;
    try { const d = await resp.json(); if (d && d.msg) msg = sanitizeRemoteText(d.msg, 120); } catch { /* ignore */ }
    throw new Error('真实对话失败: ' + msg);
  }
  const decoder = new TextDecoder();
  let pending = '', reqId = null, sawContent = false, finished = false;
  function parseLine(line) {
    if (!line.startsWith('data:')) return;
    const text = line.slice(5).trim();
    if (text === '[DONE]') { finished = true; return; }
    if (!text) return;
    let obj; try { obj = JSON.parse(text); } catch { return; }
    if (obj.error) throw new Error('上游流错误: ' + sanitizeRemoteText(obj.error.message || JSON.stringify(obj.error), 160));
    if (typeof obj.id === 'string' && obj.id) reqId = obj.id;
    for (const c of obj.choices || []) {
      if (c.delta?.content || c.message?.content) sawContent = true;
      if (c.finish_reason) finished = true;
    }
  }
  for await (const chunk of resp.body) {
    pending += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      parseLine(pending.slice(0, i).replace(/\r$/, '')); pending = pending.slice(i + 1);
    }
    if (pending.length > 1024 * 1024) throw new Error('上游 SSE 行过长');
  }
  pending += decoder.decode();
  if (pending.trim()) parseLine(pending.replace(/\r$/, ''));
  if (!finished || !sawContent) throw new Error('真实对话未正常完成或未返回正文');
  if (!reqId) throw new Error('对话已完成，但 SSE 未返回请求 ID');
  return { convId, reqId, model: requestedModel };
}

// ---- 各任务的一键完成动作 ----

async function marketExperts(cm, expertType) {
  const h = await taskHeaders(cm);
  const chatBase = cm.base();
  Object.assign(h, {
    'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1',
    'X-Domain': chatBase, 'X-Product': 'SaaS',
  });
  const resp = await fetch(chatBase + '/portal/operation-platform/market/expert/list', {
    method: 'POST', headers: h,
    body: JSON.stringify({ page: 1, page_size: 20, sort_by: 'reco_rank', sort_order: 'desc', expert_type: expertType }),
    redirect: 'error', signal: AbortSignal.timeout(25_000),
  });
  const data = await resp.json().catch(() => null);
  const list = (data && data.data && data.data.experts) || (data && data.experts) || [];
  return list;
}

function expertSummonSeq(e) {
  const cat = (Array.isArray(e.categories) && typeof e.categories[0] === 'string') ? e.categories[0] : 'expert-all';
  const ver = e.version || '1.0.0';
  return [
    { eventCode: 'web_element_click', source: e.expert_id, type: cat, version: ver,
      elementId: 'expert_summon_click', elementName: '立即召唤',
      pageURL: '/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html' },
    { eventCode: 'expert_summon_click', id: e.expert_id, name: e.display_name_zh,
      expertTitle: e.profession_zh, type: 'expert-all', position: 0,
      expertType: e.expert_type, version: ver, mode: 'LOCAL' },
    { eventCode: 'expert_summoned', id: e.expert_id, name: e.display_name_zh,
      expertTitle: e.profession_zh, type: 'expert-all' },
  ];
}

function expertActualUse(e, convId, reqId, local) {
  const cat = (Array.isArray(e.categories) && typeof e.categories[0] === 'string') ? e.categories[0] : 'expert-all';
  return {
    eventCode: 'expert_actual_use',
    id: e.expert_id, name: e.display_name_zh, expertTitle: e.profession_zh,
    type: cat, expertType: e.expert_type, source: 'builtin', version: e.version || '1.0.0',
    cost: 9000, characterCount: 14,
    conversationId: convId, requestId: reqId, messageId: 'msg-' + tail8(reqId),
    requestModelId: 'fast-model', requestModelName: 'fast-model',
    mode: local ? 'LOCAL' : 'craft',
  };
}

// 任务动作注册表：key=task_code。kind: report=纯事件上报, chat=含真实对话
const TASK_ACTIONS = {
  chat_5: {
    kind: 'report',
    run: async (cm, t) => {
      const need = Math.max(1, (t.target || 5) - (t.current || 0));
      const idn = taskIdentity(cm);
      const convId = 'wb2api-chat5-' + Date.now();
      for (let i = 0; i < need; i++) {
        await reportCli(cm, [evCliChatRequest(idn.uid, convId, convId + '-' + i)]);
        if (i < need - 1) await taskSleep(TASK_REPORT_GAP);
      }
      return `已上报对话活跃事件 ×${need}`;
    },
  },
  first_buddy: {
    kind: 'report',
    run: async (cm) => {
      const idn = taskIdentity(cm);
      await reportCli(cm, [evCliChatRequest(idn.uid, 'wb2api-adopt-' + Date.now())]);
      await taskSleep(TASK_REPORT_GAP);
      await growthCall(cm, 'POST', '/activity/growth/buddy/agreement', { agree: true });
      await growthCall(cm, 'POST', '/activity/growth/buddy/first', {});
      return '已上报活跃 → 同意协议 → 领养第一只 Buddy';
    },
  },
  Buddy_App: {
    kind: 'report',
    run: async (cm) => {
      const bid = 'cb_y5Dy46tPQGGWtueMxXbe', bn = '企鹅教师助手';
      await reportDesktop(cm, [
        { eventCode: 'buddyapp_discover_click', mode: 'LOCAL', buddyId: bid, buddyName: bn },
        { eventCode: 'buddyapp_show', mode: 'LOCAL', buddyId: bid, buddyName: bn, elementId: bid, elementName: bn, position: 2 },
        { eventCode: 'buddyapp_enter_click', mode: 'LOCAL', buddyId: bid, buddyName: bn, elementId: bid, elementName: bn, position: 2, isFirstPage: '1' },
        { eventCode: 'buddyapp_auth_confirm_click', mode: 'LOCAL', buddyId: bid, buddyName: bn, elementId: bid, elementName: bn },
        { eventCode: 'buddyapp_bindaccount_skip_click', mode: 'LOCAL', buddyId: bid, buddyName: bn, elementId: bid, elementName: bn },
      ]);
      return '已上报 Buddy 应用进入五连事件（同时覆盖 Buddy_App_QQ）';
    },
  },
  Buddy_App_QQ: { kind: 'report', run: (cm, t) => TASK_ACTIONS.Buddy_App.run(cm, t) },
  automation_1: {
    kind: 'report',
    run: async (cm) => {
      await reportDesktop(cm, [{
        eventCode: 'automated_task_create_suc', name: '每日健康自检',
        source: 'manually', modelId: 'fast-model', modelIsThinking: true,
        connectorCount: 0, skills: '', skillCount: 0, scheduleType: 'once', mode: 'LOCAL',
      }]);
      return '已上报名定时任务创建成功事件';
    },
  },
  Library_read: {
    kind: 'report',
    run: async (cm) => {
      await reportWeb(cm, {
        eventCode: 'web_element_click',
        pageURL: 'https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm',
        elementId: 'library_doc_intro_click', elementName: 'WorkBuddy资料库介绍',
      });
      return '已上报资料库介绍阅读事件';
    },
  },
  RichMeow_Chat: {
    kind: 'report',
    run: async (cm) => {
      const convId = 'wb2api-meow-' + Date.now(), reqId = hex32(), msgId = 'msg-' + tail8(reqId);
      await reportDesktop(cm, desktopChatSeq(convId, reqId, msgId, 'fast-model', 'fast-model'));
      return '已上报桌面对话六事件链';
    },
  },
  template_5: {
    kind: 'report',
    run: async (cm) => {
      const tpls = [['1', '深度研究'], ['2', '周报生成'], ['3', '竞品分析'], ['4', '活动策划'], ['5', '代码评审']];
      for (let i = 0; i < tpls.length; i++) {
        const ms = Date.now();
        const convId = `wb2api-tpl-${ms}-${i}`, reqId = `wb2api-tpl-req-${ms}-${i}`;
        const events = desktopChatSeq(convId, reqId, 'msg-' + tpls[i][0], 'fast-model', 'fast-model');
        events.push(
          { eventCode: 'agent_task_created_with_template', mode: 'working',
            isCustomModel: false, id: tpls[i][0], name: tpls[i][1], requestId: reqId },
          { eventCode: 'template_used', template_id: tpls[i][0], task_mode: 'working' });
        await reportDesktop(cm, events);
        if (i < tpls.length - 1) await taskSleep(300);
      }
      return '已上报 template_used ×5';
    },
  },
  playbook_prompt: {
    kind: 'report',
    run: async (cm) => {
      const ms = Date.now();
      const convId = `wb2api-pb-${ms}`, reqId = `wb2api-pb-req-${ms}`;
      const caseID = 'pm-gtm-launch-plan', caseName = '新产品上市 GTM 发布计划一页纸';
      const payload = { id: caseID, name: caseName, type: 'document', categoryId: '', categoryName: '' };
      const events = desktopChatSeq(convId, reqId, 'msg-pb', 'fast-model', 'fast-model');
      events.push(
        { eventCode: 'web_element_click', pageName: 'playbook_detail',
          elementId: 'playbook_ctaClick', elementName: caseName, source: 'discover' },
        { eventCode: 'playbook_cta_click', source: 'discover', position: 0, ...payload },
        { eventCode: 'playbook_prompt_send', conversationId: convId, requestId: reqId, ...payload });
      await reportDesktop(cm, events);
      return '已上报 playbook_cta_click + playbook_prompt_send';
    },
  },
  create_canvas: {
    kind: 'report',
    run: async (cm) => {
      const ms = Date.now();
      const convId = `wb2api-canvas-${ms}`, reqId = `wb2api-canvas-req-${ms}`;
      const events = desktopChatSeq(convId, reqId, 'msg-canvas', 'fast-model', 'fast-model');
      events.push(
        { eventCode: 'wbx_design_canvas_task_create', conversationId: convId,
          requestId: reqId, source: 'summon_keyword', cost: 12000, isSuccessful: true },
        { eventCode: 'wbx_design_canvas_open', conversationId: convId,
          requestId: reqId, id: 'ardot-file-' + tail8(reqId),
          source: 'summon_keyword', type: 'page', cost: 13000, isSuccessful: true });
      await reportDesktop(cm, events);
      return '已上报 wbx_design_canvas_task_create/open';
    },
  },
  Hp_Appearance: {
    kind: 'report',
    run: async (cm) => {
      const themeKey = 'theme-tkmw7j';
      const h = await taskHeaders(cm);
      Object.assign(h, {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1',
        'X-Product': 'SaaS',
      });
      const resp = await fetch(cm.base() + '/v2/user-asset/appearance/set', {
        method: 'POST', headers: h,
        body: JSON.stringify({ kind: 'theme', resource_key: themeKey }),
        redirect: 'error', signal: AbortSignal.timeout(25_000),
      });
      if (resp.status >= 400) throw new Error(`设置主题 HTTP ${resp.status}`);
      await taskSleep(2000);
      await reportDesktop(cm, [{
        eventCode: 'appearance_skin_apply', action: 'apply', source: 'settings_close',
        id: themeKey, vipLevel: 0, series: '', type: 'unknown',
      }]);
      return '已设置主题并上报皮肤生效事件';
    },
  },
  'Model_chat_GLM5.2': {
    kind: 'chat',
    run: async (cm) => {
      await taskRealChat(cm, null, 'glm-5.2');
      return '已完成 glm-5.2 真实对话，等待官方确认任务进度';
    },
  },
  skill_1: {
    kind: 'chat',
    run: async (cm) => {
      const { convId, reqId } = await taskRealChat(cm, null);
      const msgId = 'msg-' + tail8(reqId);
      const events = desktopChatSeq(convId, reqId, msgId, 'fast-model', 'fast-model');
      for (const ev of events) if (ev.eventCode === 'chat_message_response') ev.finishReason = 'tool_calls';
      events.push({
        eventCode: 'skill_info', id: '润泽小馆·日报撰写',
        skillId: 'skill_2097350077599879168', skillVersion: '1.0.0',
        toolStatus: 'success', fileCount: 56, source: 'workbuddy-desktop',
        conversationId: convId, requestId: reqId, messageId: msgId,
        requestModelId: 'fast-model', requestModelName: 'fast-model', traceId: reqId,
      });
      await reportDesktop(cm, events);
      return '已上报真实对话 + skill_info 技能加载事件';
    },
  },
  expert_5: {
    kind: 'chat',
    run: async (cm) => {
      const experts = await marketExperts(cm, 'agent');
      if (!experts.length) throw new Error('专家市场列表为空');
      let ok = 0;
      for (let i = 0; i < experts.length && ok < 5; i++) {
        const e = experts[i];
        try {
          await reportDesktop(cm, expertSummonSeq(e));
          const { convId, reqId } = await taskRealChat(cm, e.expert_id);
          await reportDesktop(cm, [...desktopChatSeq(convId, reqId, 'msg-' + tail8(reqId), 'fast-model', 'fast-model'), expertActualUse(e, convId, reqId, false)]);
          ok++;
          if (i < experts.length - 1) await taskSleep(6000);
        } catch { /* 单专家失败继续下一个 */ }
      }
      return `已对 ${ok} 位真实专家完成召唤+使用链`;
    },
  },
  Expert_team_use_3: {
    kind: 'chat',
    run: async (cm) => {
      const experts = await marketExperts(cm, 'team');
      if (!experts.length) throw new Error('专家团市场列表为空');
      let ok = 0;
      for (let i = 0; i < experts.length && ok < 3; i++) {
        const e = experts[i];
        try {
          await reportDesktop(cm, expertSummonSeq(e));
          const { convId, reqId } = await taskRealChat(cm, e.expert_id);
          await reportDesktop(cm, [...desktopChatSeq(convId, reqId, 'msg-' + tail8(reqId), 'fast-model', 'fast-model'), expertActualUse(e, convId, reqId, false)]);
          ok++;
          if (i < experts.length - 1) await taskSleep(6000);
        } catch { /* ignore */ }
      }
      return `已对 ${ok} 个专家团完成召唤+使用链`;
    },
  },
  Expert_lighthouse: {
    kind: 'chat',
    run: async (cm) => {
      let lh = { expert_id: 'ex_2cvvUZQhDyeJ', expert_type: 'agent', display_name_zh: '腾讯轻量云专家', profession_zh: '腾讯轻量云专家', version: '1.0.2' };
      try {
        const list = await marketExperts(cm, 'agent');
        const hit = list.find(e => e.expert_id === lh.expert_id);
        if (hit) lh = hit;
      } catch { /* 用内置默认 */ }
      await reportDesktop(cm, expertSummonSeq(lh));
      const { convId, reqId } = await taskRealChat(cm, lh.expert_id);
      const events = desktopChatSeq(convId, reqId, 'msg-' + tail8(reqId), 'fast-model', 'fast-model');
      for (const ev of events) {
        if (ev.eventCode === 'agent_task_created') {
          ev.has_expert = true; ev.expert_id = lh.expert_id;
          ev.expert_name = lh.display_name_zh; ev.expert_industry_id = '';
        }
      }
      const use = expertActualUse(lh, convId, reqId, true);
      use.type = ''; use.cost = 0;
      events.push(use);
      await reportDesktop(cm, events);
      return '已上报轻量云专家召唤+使用链';
    },
  },
};

// 任务码 → 是否可自动（供列表标注）
function taskAutoKind(code) {
  const a = TASK_ACTIONS[code];
  return a ? a.kind : null;
}

// 执行单个任务：执行动作 → 回读进度 → 达标自动领奖
async function taskAutoOne(cm, code, mp) {
  const act = TASK_ACTIONS[code];
  if (!act) return { ok: false, message: '该任务暂不支持自动完成' };
  const before = (await taskListMerged(cm)).find(t => t.code === code);
  if (!before) return { ok: false, message: '该账号无此任务' };
  if (before.claimed) return { ok: true, skipped: true, message: '已领取过奖励' };
  if (before.claimable) {
    const c = await taskClaim(cm, code, mp || before.mp);
    return { ok: true, message: `进度已达标，直接领奖 +${c.credit}c +${c.energy}e`, claimed: true, credit: c.credit, energy: c.energy };
  }
  if (code === 'Model_chat_GLM5.2' && before.acceptStatus !== 'accepted' && before.acceptStatus !== 'completed') {
    await taskAccept(cm, [code], !!(mp || before.mp));
    const accepted = (await taskListMerged(cm)).find(t => t.code === code);
    if (!accepted || !['accepted', 'completed', 'claimed'].includes(accepted.acceptStatus)) {
      return { ok: false, message: '接受接口未报错，但官方回查仍未接受；已停止，未消耗模型积分' };
    }
    if (accepted.claimed) return { ok: true, skipped: true, message: '已领取过奖励' };
  }
  const msg = await act.run(cm, before);
  // 回读轮询（≈12s 预算）→ 达标即领奖
  let after = null, claimed = null;
  for (let i = 0; i < 4; i++) {
    await taskSleep(3000);
    try { after = (await taskListMerged(cm)).find(t => t.code === code); } catch { /* ignore */ }
    if (after && after.claimable) break;
  }
  if (after && after.claimable) {
    try { claimed = await taskClaim(cm, code, mp || after.mp); } catch (e) {
      return { ok: true, message: msg + `；进度达标但领奖失败: ${e.message}`, claimable: true };
    }
  }
  return {
    ok: code === 'Model_chat_GLM5.2' ? !!claimed : true,
    message: msg + (code === 'Model_chat_GLM5.2' && !claimed ? '；官方尚未确认达标或领奖，不能算成功' : ''),
    progressBefore: `${before.current}/${before.target}`,
    progressAfter: after ? `${after.current}/${after.target}` : null,
    claimable: !!(after && after.claimable),
    claimed: !!claimed, credit: claimed ? claimed.credit : 0, energy: claimed ? claimed.energy : 0,
  };
}

// 全量自动：批量 accept → 逐个跑可自动任务 → 领奖汇总
async function taskRunAll(cm) {
  const out = [];
  const list = await taskListMerged(cm);
  const pending = list.filter(t => !t.claimed && !t.locked && t.acceptStatus !== 'accepted' && t.acceptStatus !== 'completed');
  const normal = pending.filter(t => !t.mp).map(t => t.code);
  const mpc = pending.filter(t => t.mp).map(t => t.code);
  try { if (normal.length) await taskAccept(cm, normal, false); out.push({ code: '(批量接受)', status: 'done', message: `已接受 ${normal.length} 个任务` }); }
  catch (e) { out.push({ code: '(批量接受)', status: 'error', message: e.message }); }
  try { if (mpc.length) await taskAccept(cm, mpc, true); out.push({ code: '(批量接受·小程序)', status: 'done', message: `已接受 ${mpc.length} 个` }); }
  catch (e) { if (mpc.length) out.push({ code: '(批量接受·小程序)', status: 'error', message: e.message }); }
  await taskSleep(TASK_REPORT_GAP);

  for (const [code, act] of Object.entries(TASK_ACTIONS)) {
    if (code === 'Buddy_App_QQ') continue; // 与 Buddy_App 共用判据
    const t = list.find(x => x.code === code);
    if (!t) { out.push({ code, status: 'skipped', message: '该账号无此任务' }); continue; }
    if (t.claimed || (t.target > 0 && t.current >= t.target)) {
      if (t.claimable && !t.claimed) {
        try { const c = await taskClaim(cm, code, t.mp); out.push({ code, status: 'done', message: `领奖 +${c.credit}c +${c.energy}e` }); }
        catch (e) { out.push({ code, status: 'error', message: '领奖失败: ' + e.message }); }
      } else {
        out.push({ code, status: 'skipped', message: `已完成（${t.current}/${t.target}）` });
      }
      continue;
    }
    try {
      const r = await taskAutoOne(cm, code, t.mp);
      out.push({ code, status: r.claimed ? 'done' : (r.ok ? 'done' : 'error'), message: r.message + (r.claimed ? ` +${r.credit}c` : '') });
    } catch (e) {
      out.push({ code, status: 'error', message: sanitizeRemoteText(e.message, 160) });
    }
    await taskSleep(TASK_REPORT_GAP);
  }
  return out;
}

// ---- 日常链（连登点亮 + 补签 + 礼包 + 连登兑换 + 抽奖 + 猫猫旅行） ----

async function dailyExtras(cm, steps) {
  const idn = taskIdentity(cm);
  const push = (name, ok, msg) => steps.push({ name, ok, msg: sanitizeRemoteText(msg || '', 120) });

  // 1. 活跃上报（点亮当日连登）
  try {
    await reportCli(cm, [evCliChatRequest(idn.uid, 'wb2api-active-' + Date.now())]);
    push('活跃上报', true, 'ok');
  } catch (e) { push('活跃上报', false, e.message); }

  // 2. 补签卡：昨日 heatmap score==0 且有卡 → 补签
  try {
    const hm = await growthCall(cm, 'GET', '/activity/growth/heatmap');
    const streak = await growthCall(cm, 'GET', '/activity/growth/streak');
    const cells = (hm && hm.cells) || [];
    const y = new Date(Date.now() - 86400_000);
    const ystr = todayStr(y);
    const missed = cells.some(c => c.date === ystr && !c.score);
    const cards = (streak && streak.makeup_cards && streak.makeup_cards.balance) || 0;
    if (missed && cards > 0) {
      await growthCall(cm, 'POST', '/activity/growth/makeup-cards/use', { target_date: ystr });
      push('补签卡', true, '已补签昨日');
    } else {
      push('补签卡', true, missed ? '昨日漏签但无卡' : '昨日已签');
    }
    // 3. 连登档位兑换（未 locked/claimed 的档位逐个兑）
    const tiers = (streak && streak.redemption_status && streak.redemption_status.tiers) || [];
    const stMap = {
      '7d': streak && streak.redemption_status && streak.redemption_status.tier_7d_status,
      '14d': streak && streak.redemption_status && streak.redemption_status.tier_14d_status,
      '28d': streak && streak.redemption_status && streak.redemption_status.tier_28d_status,
    };
    let redeemed = [];
    for (const tier of tiers) {
      const tname = tier.tier;
      const st = stMap[tname];
      if (st === 'locked' || st === 'claimed') continue;
      try {
        await growthCall(cm, 'POST', '/activity/growth/redeem', { tier: tname, client_token: uuidv4() });
        redeemed.push(tname);
      } catch { /* 未解锁跳过 */ }
    }
    push('连登兑换', true, redeemed.length ? '已兑 ' + redeemed.join('/') : '无可兑档位');
  } catch (e) { push('连登/补签', false, e.message); }

  // 4. 礼包 / 补偿（billing 域，无 /v2 前缀）
  try { const d = await billingCall(cm, 'POST', '/billing/meter/claim-gift', {}); push('每日礼包', true, '+' + ((d && d.credit) || 0) + 'c'); }
  catch (e) { push('每日礼包', false, e.message); }
  try { const d = await billingCall(cm, 'POST', '/billing/meter/claim-compensation', {}); push('补偿礼包', true, '+' + ((d && d.credit) || 0) + 'c'); }
  catch (e) { push('补偿礼包', false, e.message); }

  // 5. 抽奖：抽完剩余次数
  try {
    const s = await growthCall(cm, 'GET', '/activity/growth/lottery/summary');
    let chances = (s && s.chances) || 0;
    let drew = 0;
    while (chances-- > 0 && drew < 20) {
      await growthCall(cm, 'POST', '/activity/growth/lottery/draw', { client_token: uuidv4() });
      drew++;
      await taskSleep(400);
    }
    push('连登抽奖', true, drew ? `已抽 ${drew} 次` : '无剩余次数');
  } catch (e) { push('连登抽奖', false, e.message); }

  // 6. 猫猫旅行：无猫先领养；idle→派出，arrived→领奖
  try {
    let buddy = null;
    try {
      const bi = await growthCall(cm, 'GET', '/activity/growth/buddy/info');
      buddy = bi && bi.buddy;
    } catch { /* ignore */ }
    if (!buddy) {
      try {
        await growthCall(cm, 'POST', '/activity/growth/buddy/agreement', { agree: true });
        await growthCall(cm, 'POST', '/activity/growth/buddy/first', {});
        push('领养 Buddy', true, 'ok');
      } catch (e) { push('领养 Buddy', false, e.message); }
    }
    const st = await growthCall(cm, 'GET', '/activity/growth/buddy/travel/status');
    if (st) {
      if (st.state === 'arrived' && st.record_id) {
        const c = await growthCall(cm, 'POST', '/activity/growth/buddy/travel/claim', { record_id: st.record_id });
        push('猫猫旅行', true, '到站领奖 +' + ((c && c.reward_credit) || st.reward_credit || 0) + 'c');
      } else if (st.state === 'idle' && !st.daily_limit_reached) {
        await growthCall(cm, 'POST', '/activity/growth/buddy/travel/depart', { location_id: 4 });
        push('猫猫旅行', true, '已派出');
      } else {
        push('猫猫旅行', true, st.daily_limit_reached ? '今日已派出' : '旅行中');
      }
    }
  } catch (e) { push('猫猫旅行', false, e.message); }
}

// 日常链包装：签到后顺带跑活跃上报/补签/礼包/抽奖/猫猫旅行/开学季，逐步写日志
async function runDailyExtras(filePath) {
  const cm = credManager(filePath);
  const steps = [];
  try { await dailyExtras(cm, steps); } catch (e) { steps.push({ name: '日常链', ok: false, msg: sanitizeRemoteText(e.message, 120) }); }
  try { await schoolRun(cm, steps); } catch (e) { steps.push({ name: '开学季', ok: false, msg: sanitizeRemoteText(e.message, 120) }); }
  for (const s of steps) log(`[daily] ${path.basename(filePath)} ${s.name}: ${s.ok ? 'ok' : 'FAIL'} ${s.msg || ''}`);
  return steps;
}

// ---- 开学季活动（窗口期接口；过期返回 in_period=false） ----

async function schoolStatus(cm) {
  const base = SITES[cm.site()].billingBase;
  const tasks = await taskCall(cm, base, 'GET', '/portal/activity/school/tasks');
  let chances = null;
  try { const cfg = await taskCall(cm, base, 'GET', '/portal/activity/school/config'); chances = cfg && cfg.chance && cfg.chance.balance; } catch { /* ignore */ }
  return { inPeriod: !!(tasks && tasks.in_period), tasks: (tasks && tasks.tasks) || [], chances };
}

async function schoolRun(cm, steps) {
  const base = SITES[cm.site()].billingBase;
  const st = await schoolStatus(cm);
  if (!st.inPeriod) { steps.push({ name: '开学季', ok: true, msg: '活动已结束' }); return; }
  const push = (name, ok, msg) => steps.push({ name: '开学季·' + name, ok, msg: sanitizeRemoteText(msg || '', 120) });
  for (const t of st.tasks) {
    if (t.status === 'claimed' || t.task_code === 'task_student_verify') continue;
    try {
      if (t.task_code === 'share_invite') {
        await taskCall(cm, base, 'POST', '/portal/activity/school/tasks/share-complete', { channel: 'wechat' });
      }
      if (t.status === 'pending') {
        await taskCall(cm, base, 'POST', `/portal/activity/school/tasks/${t.task_code}/viewed`, {});
        await taskSleep(600);
      }
      // 进度类任务需要 mp 指纹上报，这里仅对达标任务领奖
      if (Number(t.progress) >= Number(t.target_count) && Number(t.target_count) > 0) {
        await taskCall(cm, base, 'POST', `/portal/activity/school/tasks/${t.task_code}/claim`, {});
        push(t.task_code, true, '已领奖');
      } else {
        push(t.task_code, true, `进度 ${t.progress || 0}/${t.target_count || 0}（需客户端行为，已标记 viewed）`);
      }
    } catch (e) { push(t.task_code, false, e.message); }
  }
  // 转盘抽奖抽完
  try {
    const cfg = await taskCall(cm, base, 'GET', '/portal/activity/school/config');
    let bal = (cfg && cfg.chance && cfg.chance.balance) || 0;
    let drew = 0;
    while (bal-- > 0 && drew < 20) {
      await taskCall(cm, base, 'POST', '/portal/activity/school/wheel/draw', { draw_uuid: uuidv4() });
      drew++;
      await taskSleep(400);
    }
    if (drew) push('转盘', true, `已抽 ${drew} 次`);
  } catch (e) { push('转盘', false, e.message); }
}

// ---- 任务执行队列（跨账号串行，后台跑） ----

const taskQueue = { running: false, startedAt: 0, items: [], log: [] };

async function taskQueueRun(accountIds, action) {
  if (taskQueue.running) return { ok: false, message: '已有队列在执行' };
  taskQueue.running = true;
  taskQueue.startedAt = Date.now();
  taskQueue.items = [];
  taskQueue.log = [];
  (async () => {
    for (const id of accountIds) {
      const cm = taskCmOf(id);
      const item = { id, status: 'running', steps: [] };
      taskQueue.items.push(item);
      if (!cm) { item.status = 'error'; item.steps.push({ name: '加载凭据', ok: false, msg: '凭据不可用' }); continue; }
      try {
        if (action === 'daily') {
          const r = await checkinFile(accountFile(id));
          item.steps.push({ name: '每日签到', ok: r.ok, msg: r.ok ? ('+' + ((r.data && r.data.credit) || 100) + 'c') : r.msg });
          if (r.ok) { checkinState.accounts[id] = todayStr(); saveCheckinState(); }
          await dailyExtras(cm, item.steps);
          await schoolRun(cm, item.steps);
        } else if (action === 'tasks') {
          const results = await taskRunAll(cm);
          for (const r of results) item.steps.push({ name: r.code, ok: r.status !== 'error', msg: r.message });
        }
        item.status = 'done';
      } catch (e) {
        item.status = 'error';
        item.steps.push({ name: '执行', ok: false, msg: sanitizeRemoteText(e.message, 120) });
      }
      await taskSleep(800); // 账号间隔
    }
    taskQueue.running = false;
    log(`[tasks] 队列完成: ${taskQueue.items.filter(i => i.status === 'done').length}/${taskQueue.items.length} 账号`);
  })().catch(e => { taskQueue.running = false; log(`[tasks] 队列异常: ${e.message}`); });
  return { ok: true, total: accountIds.length };
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

const ADMIN_HTML = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf-8'); }
  catch { return '<!DOCTYPE html><html><body><h3>admin.html 缺失</h3></body></html>'; }
})();

// ---------------------------------------------------------------------------
// gzip/br 响应压缩（零依赖）：只压缩"一次性 res.end(body)"的文本响应
// （/admin 页面、/admin/api/* JSON、/v1/models 等）。SSE 流（writeHead→write×N→end）
// 在首个 res.write 时即落回原生 writeHead，绝不缓冲压缩，保证事件实时到达。
// 协商 Accept-Encoding（br 优先），只压 1KB~10MB 的可压缩 Content-Type。
// ---------------------------------------------------------------------------
const COMPRESSIBLE_RE = /^application\/(json|javascript)|^text\/(html|plain|css|csv)/i;
const responseCompression = createCompression(ADMIN_HTML);
function pickCompression(req) { return responseCompression.pickCompression(req.headers || {}); }

function enableCompression(req, res) {
  const enc = pickCompression(req);
  if (!enc) return;
  const origWriteHead = res.writeHead;
  const origWrite = res.write;
  const origEnd = res.end;
  // pending：暂存 writeHead 参数，推迟到首个 write/end 时决定压缩与否
  let pending = null;

  res.writeHead = function (statusCode, ...rest) {
    pending = [statusCode, ...rest];
    return this;
  };
  const flushHead = () => {
    if (!pending) return;
    const args = pending;
    pending = null;
    origWriteHead.apply(res, args);
  };
  res.write = function (chunk, encoding, cb) {
    flushHead(); // 一旦写 body（SSE/流式），按原样直通
    return origWrite.call(this, chunk, encoding, cb);
  };
  res.end = function (chunk, encoding, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; encoding = undefined; }
    else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    if (!pending) return origEnd.call(this, chunk, encoding, cb);
    const args = pending;
    pending = null;
    let buf = null;
    if (chunk !== undefined && chunk !== null) {
      buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf-8');
    }
    // 从暂存的 headers 数组里找 Content-Type（对象或 [k,v] 数组两种形态）
    let ctype = '';
    for (const a of args.slice(1)) {
      if (a && typeof a === 'object') {
        if (Array.isArray(a)) {
          for (let i = 0; i < a.length; i += 2) {
            if (String(a[i]).toLowerCase() === 'content-type') ctype = String(a[i + 1] || '');
          }
        } else {
          for (const k of Object.keys(a)) {
            if (k.toLowerCase() === 'content-type') ctype = String(a[k] || '');
          }
        }
      }
    }
    const status = args[0];
    if (buf && buf.length >= 1024 && buf.length <= 10 * 1024 * 1024 && (status === 200 || status === 201) && COMPRESSIBLE_RE.test(ctype)) {
      responseCompression.pack(buf, enc).then(packed => {
        if (res.destroyed || res.writableEnded) return;
        if (packed.length < buf.length) {
          for (const a of args.slice(1)) if (a && typeof a === 'object' && !Array.isArray(a)) {
            a['Content-Encoding'] = enc; a['Content-Length'] = packed.length;
            a['Vary'] = a['Vary'] ? a['Vary'] + ', Accept-Encoding' : 'Accept-Encoding';
          }
          origWriteHead.apply(res, args); origEnd.call(res, packed, cb);
        } else { origWriteHead.apply(res, args); origEnd.call(res, buf, cb); }
      }).catch(() => { if (!res.destroyed && !res.writableEnded) { origWriteHead.apply(res, args); origEnd.call(res, buf, cb); } });
      return this;
    }
    // 不压缩时仍标 Vary：内容随 Accept-Encoding 变化，便于缓存区分
    if (COMPRESSIBLE_RE.test(ctype)) {
      for (const a of args.slice(1)) {
        if (a && typeof a === 'object' && !Array.isArray(a)) {
          if (!a['Vary']) a['Vary'] = 'Accept-Encoding';
        }
      }
    }
    origWriteHead.apply(res, args);
    return origEnd.call(this, buf !== null ? buf : chunk, encoding, cb);
  };
}

const serveAdminAssets = require("./backend/admin-assets.cjs").createAdminAssets(path.join(__dirname, "admin-ui"));
const server = http.createServer(async (req, res) => {
  if (await serveAdminAssets(req, res)) return;
  enableCompression(req, res);
  // 进程级在途请求计数（/admin/api/metrics）：finish 或 close 先到者结算，只减一次
  STATS.inflight++;
  {
    let settled = false;
    const done = () => { if (!settled) { settled = true; STATS.inflight--; } };
    res.once('finish', done);
    res.once('close', done);
  }
  const u = new URL(req.url || '/', 'http://localhost');
  const urlPath = u.pathname;

  try {
    if (req.method === 'GET' && urlPath === '/health') {
      const info = {
        status: 'ok',
        upstream: cred ? cred.base() : SITES.cn.chatBase,
        desensitize: DESENSITIZE,
        auth_configured: !!cred,
        mode: 'direct-proxy (native function calling)',
      };
      if (cred) {
        try { info.credential = cred.summary(); }
        catch (e) { info.credential_error = sanitizeRemoteText(e.message); }
      }
      return json(res, 200, info);
    }

    if (req.method === 'GET' && urlPath === '/admin') {
      try { checkAdmin(req, u); } catch (e) {
        return json(res, e.status, e.body);
      }
      // 纯静态页面，不向 HTML 注入任何动态值；鉴权通过即下发 HttpOnly 会话 cookie，
      // 页面 JS 读取 ?key= 后立即从地址栏移除，后续请求走 cookie / X-Api-Key 头
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'", 'X-Frame-Options': 'SAMEORIGIN', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Set-Cookie': adminCookieHeader(req) });
      return res.end(ADMIN_HTML);
    }

    if (urlPath.startsWith('/admin/api/')) {
      try {
        const auth = checkAdmin(req, u);
        if (auth === 'key' && urlPath === '/admin/api/status') res.setHeader('Set-Cookie', adminCookieHeader(req));
      } catch (e) {
        return json(res, e.status, e.body);
      }
      return await handleAdmin(req, res, urlPath);
    }

    if (req.method === 'GET' && urlPath === '/v1/models') {
      checkAuth(req);
      const list = await getAvailableModels(cred);
      const data = list.map(m => ({ id: m.id, object: 'model', created: 1700000000, owned_by: 'codebuddy' }));
      // 外部板块模型以 `前缀/模型名` 并入
      for (const p of extProviders) {
        if (p.enabled === false) continue;
        for (const mid of extExposed(p)) {
          data.push({ id: (p.prefix || p.id) + '/' + mid, object: 'model', created: 1700000000, owned_by: 'ext:' + (p.prefix || p.id) });
        }
      }
      return json(res, 200, { object: 'list', data });
    }

    if (req.method === 'POST' && urlPath === '/v1/chat/completions') {
      return await handleChat(req, res);
    }

    return json(res, 404, openaiError(404, `no route: ${sanitizeRemoteText(req.method)} ${sanitizeRemoteText(urlPath, 100)}`, 'invalid_request_error'));
  } catch (e) {
    if (e && e.status && e.body) return json(res, e.status, e.body);
    log(`✗ ${sanitizeRemoteText(e.message || e)}`);
    if (res.destroyed || res.writableEnded) return;
    const status = Number(e.status) || 500;
    return json(res, status, openaiError(status, sanitizeRemoteText(e.message || String(e))));
  }
});

// ---------------------------------------------------------------------------
// 管理台 API
// ---------------------------------------------------------------------------

async function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, settled = false;
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted); };
    const fail = e => { if (settled) return; settled = true; cleanup(); chunks = []; reject(e); };
    const aborted = () => fail(new Error('request aborted'));
    const data = c => {
      size += c.length;
      if (size > limit) { const e = new Error('request body too large'); e.tooLarge = true; e.status = 413; fail(e); req.resume(); return; }
      chunks.push(c);
    };
    const end = () => { if (settled) return; settled = true; cleanup(); resolve(Buffer.concat(chunks)); chunks = []; };
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted);
    if (Number(req.headers['content-length']) > limit) { const e = new Error('request body too large'); e.tooLarge = true; e.status = 413; fail(e); req.resume(); }
  });
}

async function readSmallJson(req) {
  const raw = (await readBody(req, 8192)).toString('utf-8').trim();
  if (!raw) return {};
  try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; } catch { throw { status: 400, body: { ok: false, message: '请求必须是有效 JSON 对象' } }; }
}

// 展示用地址：优先取请求的 Host 头（用户用什么地址打开管理台，就显示什么地址），
// 避免把服务器主机名（外部解析不了）展示出去
function baseUrlForDisplay(req) {
  let host = sanitizeRemoteText((req && req.headers && req.headers.host) || '', 100).replace(/\s/g, '');
  if (!/^[a-zA-Z0-9.\-]+(:\d+)?$/.test(host)) {
    host = HOST === '0.0.0.0' ? require('os').hostname() : HOST;
  }
  if (!/:\d+$/.test(host)) host = host + ':' + PORT;
  return { root: `http://${host}`, v1: `http://${host}/v1` };
}

async function handleAdmin(req, res, urlPath) {
  if (req.method === 'POST' && urlPath === '/admin/api/request-map/settings') {
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    if (typeof body.enabled !== 'boolean') return json(res, 400, {ok:false,message:'enabled 必须为布尔值'});
    const draft = {...appSettings,requestMapEnabled:body.enabled};
    writeAuthFileAtomic(SETTINGS_FILE, draft);
    appSettings.requestMapEnabled = body.enabled;
    await requestMap.setEnabled(body.enabled);
    return json(res,200,{ok:true,enabled:body.enabled});
  }
  if (req.method === 'GET' && urlPath === '/admin/api/request-map') {
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, requestMap.snapshot());
  }
  if (req.method === 'GET' && urlPath === '/admin/api/request-map/live') return requestMap.subscribe(req, res);
  // SSE 实时请求流水：pushRecentRequest 时向所有订阅端广播（25s 心跳保活）
  if (req.method === 'GET' && urlPath === '/admin/api/live') {
    if (LIVE_CLIENTS.size >= LIVE_MAX_CLIENTS) {
      res.writeHead(503, { 'Retry-After': '10', 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, message: '实时流水订阅数已达上限' }));
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': hello\n\n');
    LIVE_CLIENTS.add(res);
    const hb = setInterval(() => liveWrite(res, ': hb\n\n'), 25000);
    hb.unref?.();
    const cleanup = () => { clearInterval(hb); LIVE_CLIENTS.delete(res); };
    res.once('close', cleanup);
    return;
  }
  if (req.method === 'GET' && urlPath === '/admin/api/usage') return json(res, 200, { ok: true, usage: aggregateUsage() });
  if (req.method === 'GET' && urlPath === '/admin/api/status') {
    const light = new URL(req.url, 'http://localhost').searchParams.get('detail') === 'light';
    let credential = null;
    const serveCmStatus = resolveServingCm();
    if (serveCmStatus) {
      try { credential = serveCmStatus.summary(); }
      catch (e) { credential = { error: sanitizeRemoteText(e.message) }; }
    }
    const bu = baseUrlForDisplay(req);
    // The first screen must never wait for an upstream model catalogue refresh.
    const cachedModels = () => modelsCache.list || DEFAULT_MODELS.map(id => ({ id, name: '', tags: [] }));
    let availModels;
    if (light) {
      availModels = cachedModels();
      getAvailableModels(cred).catch(() => {});
    } else availModels = await getAvailableModels(cred).catch(cachedModels);
    // 观察池内的账号从「账号管理」移出，只在 pool 列表出现（管理台单独渲染）
    const allAccs = listAccounts();
    return json(res, 200, {
      ok: true,
      now: Date.now(),
      uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
      stats: STATS,
      credential,
      accounts: allAccs.filter(a => !a.flag403),
      pool: allAccs.filter(a => a.flag403),
      servingOverride: servingOverrideId ? { id: servingOverrideId } : null,
      rotation: {
        enabled: rotationCfg.enabled,
        intervalMin: rotationCfg.intervalMin,
        nextAt: rotationRuntime.nextAt,
        lastRotation: rotationRuntime.lastRotation,
        flaggedCount: Object.keys(flag403).length,
      },
      usage: light ? undefined : aggregateUsage(),
      usageVersion: usageStatsVer,
      storageErrors: storage.status(),
      modelsDetail: availModels,
      modelsFetchedAt: modelsCache.at || null,
      checkin: {
        at: CHECKIN_AT,
        lastRunDate: checkinState.lastRunDate,
        lastRunAt: checkinState.lastRunAt,
        lastResults: checkinState.lastResults || [],
      },
      settings: {
        requestMapEnabled: appSettings.requestMapEnabled !== false,
        pollMin: appSettings.pollMin,
        keepaliveAt: appSettings.keepaliveAt || KEEPALIVE_AT,
        keepaliveEveryDays: Math.max(1, Number(appSettings.keepaliveEveryDays) || 1),
        keepaliveLast: checkinState.keepalive || null,
        backupAt: appSettings.backupAt || '05:30',
        paidRoute: appSettings.paidRoute || 'expire',
        autoBackupLast: checkinState.autoBackup || null,
      },
      service: {
        baseUrl: bu.v1,
        baseUrlRoot: bu.root,
        apiKeyMasked: maskKey(API_KEY),
        apiKeyFull: API_KEY, // 该接口本身已要求持有 key 才能访问
        models: availModels.map(m => m.id),
        desensitize: DESENSITIZE,
      },
      login: loginSession ? {
        site: loginSession.site,
        authUrl: loginSession.done ? null : loginSession.authUrl,
        expiresAt: loginSession.expiresAt,
        done: loginSession.done,
      } : null,
      apiKeys: apiKeysForDisplay(),
      logs: [...RECENT_LOGS].reverse(),
      recentRequests: RECENT_REQUESTS.slice(-80).reverse(),
    });
  }

  if (req.method === 'POST' && urlPath === '/admin/api/login/start') {
    const body = await readSmallJson(req);
    const site = body.site === 'intl' ? 'intl' : 'cn';
    try {
      const s = await startLogin(site, body.checkinOnly === true);
      return json(res, 200, { ok: true, state: s.state, authUrl: s.authUrl, expiresAt: s.expiresAt });
    } catch (e) {
      log(`✗ 生成登录链接失败: ${sanitizeRemoteText(e.message, 160)}`);
      return json(res, 502, { ok: false, message: sanitizeRemoteText(e.message, 200) || '上游无响应' });
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/api/login/poll') {
    const body = await readSmallJson(req);
    if (!body.state) return json(res, 400, { ok: false, status: 'error', message: '缺少 state' });
    try {
      const r = await pollLogin(String(body.state));
      return json(res, 200, { ok: r.status === 'success', ...r });
    } catch (e) {
      return json(res, 502, { ok: false, status: 'error', message: sanitizeRemoteText(e.message, 200) });
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/api/account/switch') {
    const body = await readSmallJson(req);
    if (!body.id) return json(res, 400, { ok: false, message: '缺少 id' });
    const f = accountFile(String(body.id));
    if (!f || !fs.existsSync(f)) return json(res, 404, { ok: false, message: '账号不存在' });
    let isCO = false;
    try { isCO = !!JSON.parse(fs.readFileSync(f, 'utf-8')).checkinOnly; } catch { /* ignore */ }
    if (isCO || body.temporary) {
      // 临时启用：内存态覆盖，不改默认账号（重启/恢复默认后失效）
      servingOverrideId = String(body.id);
      invalidateAccountsCache(); // serving 标记变了，账号行缓存立即失效
      log(`[failover] 临时启用账号参与服务: ${body.id}${isCO ? '（仅签到号）' : ''}`);
      return json(res, 200, { ok: true, temporary: true });
    }
    return json(res, 200, switchAccount(String(body.id)));
  }

  if (req.method === 'POST' && urlPath === '/admin/api/account/restore-default') {
    servingOverrideId = null;
    invalidateAccountsCache(); // serving 标记回到默认账号，账号行缓存立即失效
    log('[failover] 已恢复默认服务账号');
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && urlPath === '/admin/api/account/delete') {
    const body = await readSmallJson(req);
    if (!body.id) return json(res, 400, { ok: false, message: '缺少 id' });
    return json(res, 200, deleteAccount(String(body.id)));
  }

  if (req.method === 'POST' && urlPath === '/admin/api/checkin') {
    const body = await readSmallJson(req);
    let target;
    if (body.id) {
      const f = accountFile(String(body.id));
      if (!f || !fs.existsSync(f)) return json(res, 404, { ok: false, message: '账号不存在' });
      target = f;
    } else {
      if (!cred) return json(res, 503, { ok: false, message: '尚无凭据' });
      target = cred.path;
    }
    try {
      const r = await checkinFile(target);
      log(`[checkin] 手动签到 ${path.basename(target)}: ${r.ok ? 'ok' : r.msg}`);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 200, { ok: false, msg: sanitizeRemoteText(e.message, 150) });
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/api/checkin/all') {
    try {
      const r = await runDailyCheckinAll();
      return json(res, 200, r);
    } catch (e) {
      return json(res, 200, { ok: false, msg: sanitizeRemoteText(e.message, 150) });
    }
  }

  if (req.method === 'GET' && urlPath === '/admin/api/checkin/status') {
    let files = [];
    try { fs.mkdirSync(AUTHS_DIR, { recursive: true }); files = fs.readdirSync(AUTHS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.')); } catch { /* ignore */ }
    const out = [];
    for (const f of files) {
      try {
        const r = await checkinStatusFile(path.join(AUTHS_DIR, f));
        out.push({ id: f, active: f === activeAccountId, ...r });
      } catch (e) {
        out.push({ id: f, active: f === activeAccountId, ok: false, msg: sanitizeRemoteText(e.message, 100) });
      }
    }
    return json(res, 200, { ok: true, accounts: out });
  }

  // ---- 任务中心 API ----

  if (req.method === 'GET' && urlPath === '/admin/api/tasks/accounts') {
    // 账号摘要（不含任务明细，明细按账号单独拉）
    const out = listAccounts().filter(a => a.uid).map(a => ({
      id: a.id, uid: a.uid, nickname: a.nickname, siteLabel: a.siteLabel,
      checkinOnly: a.checkinOnly, flag403: a.flag403,
    }));
    return json(res, 200, { ok: true, accounts: out });
  }

  if (req.method === 'GET' && urlPath === '/admin/api/tasks/list') {
    const id = new URL(req.url || '/', 'http://localhost').searchParams.get('id');
    const cm = id ? taskCmOf(String(id)) : resolveServingCm();
    if (!cm) return json(res, 404, { ok: false, message: '账号不存在' });
    try {
      const tasks = await taskListMerged(cm);
      for (const t of tasks) t.autoKind = taskAutoKind(t.code);
      return json(res, 200, { ok: true, tasks });
    } catch (e) {
      return json(res, 200, { ok: false, message: sanitizeRemoteText(e.message, 150) });
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/api/tasks/accept') {
    const body = await readSmallJson(req);
    const cm = body.id ? taskCmOf(String(body.id)) : resolveServingCm();
    if (!cm) return json(res, 404, { ok: false, message: '账号不存在' });
    try {
      const list = await taskListMerged(cm);
      const codes = Array.isArray(body.codes) && body.codes.length
        ? body.codes.map(String)
        : list.filter(t => !t.claimed && !t.locked && t.acceptStatus !== 'accepted' && t.acceptStatus !== 'completed').map(t => t.code);
      const norm = codes.filter(c => !(list.find(t => t.code === c) || {}).mp);
      const mpc = codes.filter(c => (list.find(t => t.code === c) || {}).mp);
      if (norm.length) await taskAccept(cm, norm, false);
      if (mpc.length) await taskAccept(cm, mpc, true);
      return json(res, 200, { ok: true, accepted: codes.length });
    } catch (e) {
      return json(res, 200, { ok: false, message: sanitizeRemoteText(e.message, 150) });
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/api/tasks/claim') {
    const body = await readSmallJson(req);
    if (!body.code) return json(res, 400, { ok: false, message: '缺少 code' });
    const cm = body.id ? taskCmOf(String(body.id)) : resolveServingCm();
    if (!cm) return json(res, 404, { ok: false, message: '账号不存在' });
    try {
      const mp = !!body.mp;
      const r = await taskClaim(cm, String(body.code), mp);
      log(`[tasks] 领奖 ${body.code}: +${r.credit}c +${r.energy}e${r.alreadyClaimed ? '（重复领取）' : ''}`);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 200, { ok: false, message: sanitizeRemoteText(e.message, 150) });
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/api/tasks/auto') {
    const body = await readSmallJson(req);
    if (!body.code) return json(res, 400, { ok: false, message: '缺少 code' });
    const cm = body.id ? taskCmOf(String(body.id)) : resolveServingCm();
    if (!cm) return json(res, 404, { ok: false, message: '账号不存在' });
    try {
      const r = await taskAutoOne(cm, String(body.code), !!body.mp);
      log(`[tasks] 自动完成 ${body.code}: ${r.message}`);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 200, { ok: false, message: sanitizeRemoteText(e.message, 150) });
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/api/tasks/run_all') {
    const body = await readSmallJson(req);
    const cm = body.id ? taskCmOf(String(body.id)) : resolveServingCm();
    if (!cm) return json(res, 404, { ok: false, message: '账号不存在' });
    try {
      const results = await taskRunAll(cm);
      return json(res, 200, { ok: true, results });
    } catch (e) {
      return json(res, 200, { ok: false, message: sanitizeRemoteText(e.message, 150) });
    }
  }

  // 跨账号队列：action=daily(签到+日常+开学季) | tasks(成长任务一键全做)
  if (req.method === 'POST' && urlPath === '/admin/api/tasks/queue') {
    const body = await readSmallJson(req);
    let ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (!ids.length) ids = listAccounts().filter(a => a.uid && !a.checkinOnly).map(a => a.id);
    const action = body.action === 'tasks' ? 'tasks' : 'daily';
    return json(res, 200, await taskQueueRun(ids, action));
  }

  if (req.method === 'GET' && urlPath === '/admin/api/tasks/queue') {
    return json(res, 200, {
      ok: true, running: taskQueue.running, startedAt: taskQueue.startedAt,
      items: taskQueue.items,
    });
  }

  if (req.method === 'GET' && urlPath === '/admin/api/tasks/school') {
    const id = new URL(req.url || '/', 'http://localhost').searchParams.get('id');
    const cm = id ? taskCmOf(String(id)) : resolveServingCm();
    if (!cm) return json(res, 404, { ok: false, message: '账号不存在' });
    try {
      return json(res, 200, { ok: true, ...(await schoolStatus(cm)) });
    } catch (e) {
      return json(res, 200, { ok: false, message: sanitizeRemoteText(e.message, 150) });
    }
  }

  // 单账号一键日常（签到+连登+抽奖+旅行+开学季），同步返回明细
  if (req.method === 'POST' && urlPath === '/admin/api/tasks/daily') {
    const body = await readSmallJson(req);
    const cm = body.id ? taskCmOf(String(body.id)) : resolveServingCm();
    if (!cm) return json(res, 404, { ok: false, message: '账号不存在' });
    const file = body.id ? accountFile(String(body.id)) : (cred && cred.path);
    const steps = [];
    try {
      if (file) {
        const r = await checkinFile(file);
        steps.push({ name: '每日签到', ok: r.ok, msg: r.ok ? ('+' + ((r.data && r.data.credit) || 100) + 'c') : r.msg });
        if (r.ok && body.id) { checkinState.accounts[String(body.id)] = todayStr(); saveCheckinState(); }
      }
      await dailyExtras(cm, steps);
      await schoolRun(cm, steps);
      return json(res, 200, { ok: true, steps });
    } catch (e) {
      return json(res, 200, { ok: false, message: sanitizeRemoteText(e.message, 150), steps });
    }
  }

  // ---- 板块管理（custom 外部反代 + opencode/trae/qoder 内置协议） ----
  if (req.method === 'GET' && urlPath === '/admin/api/ext/list') {
    return json(res, 200, { ok: true, providers: extForDisplay() });
  }

  if (req.method === 'POST' && urlPath === '/admin/api/ext/save') {
    const body = await readSmallJson(req);
    const type = String(body.type || 'custom').slice(0, 30);
    if (!/^[a-z][a-z0-9_-]{0,29}$/.test(type)) return json(res, 400, { ok: false, message: '非法 type' });
    const builtin = !!BUILTIN_EXT[type];
    const isTraeQoder = type === 'trae' || type === 'qoder';
    // custom/opencode 需要 baseUrl（opencode 留空走默认 https://opencode.ai/zen）；
    // trae/qoder 可留空（realm/内置默认主机决定），填了则不补 /v1
    let baseUrl = extNormalizeBase(body.baseUrl, isTraeQoder);
    if (!baseUrl && builtin) {
      baseUrl = type === 'opencode' ? 'https://opencode.ai/zen/v1'
        : type === 'trae' ? traeCfg({ creds: { realm: String(body.realm || 'cn') } }).chat
        : 'https://api3.qoder.sh';
    }
    if (!baseUrl) return json(res, 400, { ok: false, message: '缺少 baseUrl' });
    const name = String(body.name || '').trim().slice(0, 40);
    const note = String(body.note || '').slice(0, 200);
    const models = Array.isArray(body.models) ? body.models.map(s => String(s).trim()).filter(Boolean).slice(0, 500) : [];
    const modelMap = {};
    if (body.modelMap && typeof body.modelMap === 'object') {
      for (const [k, v] of Object.entries(body.modelMap)) {
        const kk = String(k).trim(), vv = String(v).trim();
        if (kk && vv) modelMap[kk] = vv;
      }
    }
    const current = body.id ? extById(String(body.id)) : null;
    let ent = current ? structuredClone(current) : null;
    if (ent) {
      const prevType = ent.type;
      ent.name = name || ent.name;
      ent.type = type;
      ent.baseUrl = baseUrl;
      if (body.key !== undefined && String(body.key).trim()) ent.key = String(body.key).trim();
      if (body.clearKey) delete ent.key;
      ent.enabled = body.enabled !== false;
      ent.note = note;
      ent.models = models;
      ent.modelMap = modelMap;
      if (body.clearDown) { ent.downUntil = 0; ent.downReason = ''; }
      if (prevType !== type) ent.creds = {}; // 换协议类型时清空旧凭据
      if (body.prefix) {
        const p = String(body.prefix).trim().toLowerCase().slice(0, 20);
        if (!/^[a-z0-9][a-z0-9_-]{0,19}$/.test(p)) return json(res, 400, { ok: false, message: '前缀只能用小写字母/数字/-/_' });
        if (extProviders.some(e => e !== current && e.prefix === p)) return json(res, 400, { ok: false, message: '前缀已被占用' });
        ent.prefix = p;
      }
    } else {
      const prefix = (String(body.prefix || '').trim().toLowerCase() || 'ext' + (extProviders.length + 1));
      if (!/^[a-z0-9][a-z0-9_-]{0,19}$/.test(prefix)) return json(res, 400, { ok: false, message: '前缀只能用小写字母/数字/-/_' });
      if (extProviders.some(e => e.prefix === prefix)) return json(res, 400, { ok: false, message: '前缀已被占用' });
      ent = {
        id: 'ext_' + crypto.randomBytes(4).toString('hex'),
        name: name || prefix, type, prefix, baseUrl,
        enabled: body.enabled !== false, note, models, modelMap, knownModels: [], creds: {}, createdAt: Date.now(),
      };
      if (String(body.key || '').trim()) ent.key = String(body.key).trim();

    }
    // ---- 内置协议凭据 ----
    if (builtin) {
      const c = ent.creds || (ent.creds = {});
      if (type === 'opencode') {
        // key 可留空 = 匿名免费层；空时清掉回匿名
        // A status-only update omits key and must preserve existing credentials.
        // An explicitly empty key (legacy UI) or clearKey still restores anonymous mode.
        if (body.key !== undefined && !String(body.key || '').trim()) delete ent.key;
      } else if (type === 'trae') {
        if (!TRAE_REALM[String(body.realm || '').toLowerCase()] && body.realm) {
          return json(res, 400, { ok: false, message: 'realm 仅支持 cn/sg/us' });
        }
        if (body.realm) c.realm = String(body.realm).toLowerCase();
        c.machineId = c.machineId || crypto.randomBytes(32).toString('hex');
        c.deviceId = c.deviceId || String(Math.floor(Math.random() * 9e15) + 1e15).slice(0, 16);
        // 回调 URL 优先（含 refreshToken+machine_id+device_id），其次裸 refreshToken
        const rt = String(body.refreshToken || '').trim();
        const cb = String(body.callbackUrl || '').trim();
        const src = cb || rt;
        if (src) {
          if (/^https?:/i.test(src)) {
            let u;
            try { u = new URL(src); } catch { return json(res, 400, { ok: false, message: '回调 URL 无法解析' }); }
            const token = u.searchParams.get('refreshToken') || u.searchParams.get('refresh_token') || u.searchParams.get('token');
            if (!token) return json(res, 400, { ok: false, message: '回调 URL 里没找到 refreshToken 参数' });
            c.refreshToken = token;
            if (u.searchParams.get('machine_id')) c.machineId = u.searchParams.get('machine_id');
            if (u.searchParams.get('device_id')) c.deviceId = u.searchParams.get('device_id');
          } else {
            c.refreshToken = src;
          }
          delete c.accessToken; delete c.expiresAt; // 新 refreshToken 必然让旧 access 作废
        }
        if (body.clearCreds) { delete c.refreshToken; delete c.accessToken; delete c.expiresAt; }
      } else if (type === 'qoder') {
        const pat = String(body.pat || '').trim();
        if (pat) { c.pat = pat; delete c.session; }
        if (body.clearCreds) { delete c.pat; delete c.session; }
      }
    }
    atomicWriteJson(EXTP_FILE, current ? extProviders.map(e => e === current ? ent : e) : [...extProviders, ent]);
    if (current) { for (const k of Object.keys(current)) delete current[k]; Object.assign(current, ent); }
    else extProviders.push(ent);
    return json(res, 200, { ok: true, provider: extForDisplay().find(e => e.id === ent.id) });
  }

  if (req.method === 'POST' && urlPath === '/admin/api/ext/delete') {
    const body = await readSmallJson(req);
    const i = extProviders.findIndex(e => e.id === String(body.id || ''));
    if (i < 0) return json(res, 404, { ok: false, message: '板块不存在' });
    atomicWriteJson(EXTP_FILE, extProviders.filter((_, index) => index !== i));
    extProviders.splice(i, 1);
    return json(res, 200, { ok: true });
  }

  // 探测板块连通性并缓存其模型目录；探测成功同时清除冷却
  if (req.method === 'POST' && urlPath === '/admin/api/ext/probe') {
    const body = await readSmallJson(req);
    const ent = extById(String(body.id || ''));
    if (!ent) return json(res, 404, { ok: false, message: '板块不存在' });
    try {
      const builtin = BUILTIN_EXT[ent.type || ''];
      const r = builtin ? await builtin.probe(ent) : await extProbe(ent);
      if (ent.downUntil) { ent.downUntil = 0; ent.downReason = ''; saveExtProviders(); }
      log(`[ext] 板块 ${ent.prefix} 探测成功: ${r.count} 个模型 (${r.latencyMs}ms)`);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 200, { ok: false, message: sanitizeRemoteText(e.message, 160) });
    }
  }

  // 反代面板：单板块详情（额度 + 聚合用量 + 模型可用性 + 最近请求）
  if (req.method === 'GET' && urlPath === '/admin/api/ext/status') {
    const id = new URL(req.url || '/', 'http://localhost').searchParams.get('id') || '';
    const ent = extById(id);
    if (!ent) return json(res, 404, { ok: false, message: '板块不存在' });
    const prefix = (ent.prefix || ent.id) + '/';
    const today = todayStr();
    const weekStart = todayStr(new Date(Date.now() - 6 * 86400 * 1000));
    // 按 `前缀/` 聚合 usageStats.days（无消耗不记录，无数据即空）
    const stat = { today: { requests: 0, prompt: 0, cached: 0, completion: 0, total: 0 }, week: { requests: 0, prompt: 0, cached: 0, completion: 0, total: 0 }, total: { requests: 0, prompt: 0, cached: 0, completion: 0, total: 0 }, models: {} };
    for (const [day, models] of Object.entries(usageStats.days || {})) {
      const isToday = day === today;
      const inWeek = day >= weekStart;
      for (const [m, v] of Object.entries(models || {})) {
        if (!m.startsWith(prefix)) continue;
        const bump = (slot) => {
          slot.requests += v.requests || 0;
          slot.prompt += v.prompt || 0;
          slot.cached += v.cached || 0;
          slot.completion += v.completion || 0;
          slot.total += v.total || 0;
        };
        bump(stat.total);
        if (isToday) bump(stat.today);
        if (inWeek) bump(stat.week);
        const ms = stat.models[m.slice(prefix.length)] = stat.models[m.slice(prefix.length)] || { requests: 0, prompt: 0, cached: 0, completion: 0, total: 0, today: 0 };
        bump(ms);
        if (isToday) ms.today += v.total || 0;
      }
    }
    const models = extExposed(ent).map(name => ({
      name,
      upstream: extUpstreamName(ent, name),
      health: (ent.modelHealth || {})[name] || null,
      usage: stat.models[name] || null,
    }));
    // RECENT_REQUESTS 按时间 push 追加（最新在尾部），取末 15 条并反转为最新在前，与 recentRequests 语义一致
    const recent = RECENT_REQUESTS.filter(r => String(r.model || '').startsWith(prefix)).slice(-15).reverse();
    const quota = await extQuota(ent, false).catch(() => null);
    // 冷却状态派生（只读）：downUntil/downReason 统一翻译成 {cooling, reason, until, remainingSec}
    const downRemain = Math.max(0, Math.ceil(((ent.downUntil || 0) - Date.now()) / 1000));
    const policy = {
      cooling: downRemain > 0,
      reason: downRemain > 0 ? (ent.downReason || '') : '',
      until: downRemain > 0 ? ent.downUntil : 0,
      remainingSec: downRemain,
    };
    return json(res, 200, {
      ok: true,
      provider: extForDisplay().find(e => e.id === ent.id),
      label: (BUILTIN_EXT[ent.type] || {}).label || '外部 OpenAI 兼容反代',
      policy,
      quota, stat, models, recent,
    });
  }

  // 反代面板：手动刷新额度
  if (req.method === 'GET' && urlPath === '/admin/api/ext/quota') {
    const id = new URL(req.url || '/', 'http://localhost').searchParams.get('id') || '';
    const ent = extById(id);
    if (!ent) return json(res, 404, { ok: false, message: '板块不存在' });
    const data = await extQuota(ent, true);
    return json(res, 200, { ok: true, quota: data });
  }

  // 反代面板：单模型连通测试（真实最小对话，45s 超时；失败不触发板块冷却）
  if (req.method === 'POST' && urlPath === '/admin/api/ext/test') {
    const body = await readSmallJson(req);
    const ent = extById(String(body.id || ''));
    if (!ent) return json(res, 404, { ok: false, message: '板块不存在' });
    const model = String(body.model || '').trim();
    if (!model) return json(res, 400, { ok: false, message: '缺少 model' });
    const r = await extTestModel(ent, model);
    ent.modelHealth = ent.modelHealth || {};
    ent.modelHealth[model] = { at: Date.now(), ok: r.ok, msg: r.ok ? '' : r.msg, latencyMs: r.latencyMs };
    if (Object.keys(ent.modelHealth).length > 200) {
      const keys = Object.keys(ent.modelHealth).sort((a, b) => (ent.modelHealth[a].at || 0) - (ent.modelHealth[b].at || 0));
      for (const k of keys.slice(0, keys.length - 200)) delete ent.modelHealth[k];
    }
    saveExtProviders();
    log(`[ext] 板块 ${ent.prefix} 模型测试 ${model}: ${r.ok ? 'ok' : 'fail'} ${r.latencyMs}ms ${r.msg || ''}`);
    return json(res, 200, { ok: true, result: r });
  }

  if (req.method === 'GET' && urlPath === '/admin/api/credits') {
    try {
      const force = new URL(req.url || '/', 'http://localhost').searchParams.get('force') === '1';
      return json(res, 200, await getAllCredits(force));
    } catch (e) {
      return json(res, 200, { ok: false, msg: sanitizeRemoteText(e.message, 150) });
    }
  }

  // 强制从上游重新拉取模型目录（绕过 10 分钟内存缓存），用于上游上新模型后立即同步
  if (req.method === 'POST' && urlPath === '/admin/api/models/refresh') {
    try {
      const cm = resolveServingCm();
      if (!cm) return json(res, 200, { ok: false, msg: '无可用账号凭据，无法拉取模型目录' });
      const beforeIds = new Set((modelsCache.list || []).map(m => m.id));
      const hadCache = beforeIds.size > 0;
      const list = await getAvailableModels(cm, true, true);
      const after = list.length;
      // 与刷新前的差集：只在刷新前已有缓存时才有意义
      const added = hadCache ? list.filter(m => !beforeIds.has(m.id)).map(m => m.id) : [];
      if (added.length) log(`[models] 手动刷新新增 ${added.length} 个模型: ${added.join(', ')}`);
      return json(res, 200, {
        ok: true,
        count: after,
        added,
        fetchedAt: modelsCache.at,
        models: list,
      });
    } catch (e) {
      return json(res, 200, { ok: false, msg: sanitizeRemoteText(e.message, 150) });
    }
  }

  if (req.method === 'GET' && urlPath === '/admin/api/checkup') {
    return json(res, 200, { ok: !!checkupCache, ...(checkupCache || { msg: '尚未体检' }) });
  }

  if (req.method === 'POST' && urlPath === '/admin/api/checkup') {
    const body = await readSmallJson(req);
    // 单模型体检：只探测一个模型在所有账号上的可用性（温和，不易触发风控）
    if (typeof body.model === 'string' && body.model.trim()) {
      const model = body.model.trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(model)) {
        return json(res, 400, { ok: false, msg: '模型名不合法' });
      }
      const accounts = listAccounts().filter(a => a.uid);
      if (!checkupCache) {
        checkupCache = { at: Date.now(), accounts: [], models: [model], results: {} };
      }
      // 账号列跟随当前存档实时刷新（加号后矩阵自动变多），并清理已删除账号的旧结果
      checkupCache.accounts = accounts.map(a => ({ id: a.id, nickname: a.nickname, uid: a.uid }));
      const uidSet = new Set(accounts.map(a => a.uid));
      for (const rk of Object.keys(checkupCache.results || {})) {
        if (!uidSet.has(rk.split('|')[0])) delete checkupCache.results[rk];
      }
      if (!Array.isArray(checkupCache.models)) checkupCache.models = [];
      if (checkupCache.models.indexOf(model) < 0) checkupCache.models.push(model);
      if (!checkupCache.results) checkupCache.results = {};
      for (const a of accounts) {
        const key = a.uid + '|' + model;
        try {
          const cm = credManager(path.join(AUTHS_DIR, a.id));
          checkupCache.results[key] = await probeOne(cm, a.uid, model);
        } catch (e) {
          checkupCache.results[key] = { ok: false, kind: 'error', msg: sanitizeRemoteText(e.message, 80) };
        }
      }
      checkupCache.at = Date.now();
      try { writeAuthFileAtomic(CHECKUP_FILE, checkupCache); } catch { /* ignore */ }
      log(`[checkup] 单模型体检 ${model}: ${accounts.length} 个账号`);
      return json(res, 200, { ok: true, ...checkupCache });
    }
    const r = await runCheckup();
    return json(res, r.ok ? 200 : 409, r);
  }

  if (req.method === 'GET' && urlPath === '/admin/api/backup') {
    const bundle = buildBackupBundle();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="codebuddy-backup-${todayStr()}.json"`,
    });
    return res.end(JSON.stringify(bundle, null, 2));
  }

  if (req.method === 'POST' && urlPath === '/admin/api/backup/run') {
    return json(res, 200, runAutoBackup('manual'));
  }

  if (req.method === 'GET' && urlPath === '/admin/api/backup/status') {
    let list = [];
    try { list = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('codebuddy-backup-') && f.endsWith('.json')).sort().reverse(); } catch { /* ignore */ }
    return json(res, 200, { ok: true, keep: AUTO_BACKUP_KEEP, at: appSettings.backupAt || '05:30', last: checkinState.autoBackup || null, files: list.slice(0, AUTO_BACKUP_KEEP) });
  }

  // ---- 附加 API Key 管理（仅主 Key 可用；附加 Key 本身无管理台权限）----
  if (req.method === 'GET' && urlPath === '/admin/api/keys') {
    return json(res, 200, { ok: true, keys: apiKeysForDisplay(), masterMasked: maskKey(API_KEY) });
  }

  if (req.method === 'POST' && urlPath === '/admin/api/keys/create') {
    const body = await readSmallJson(req);
    const key = 'sk-' + crypto.randomBytes(24).toString('hex');
    const ent = {
      key, id: 'key_' + crypto.randomBytes(12).toString('hex'),
      name: String(body.name || '').slice(0, 40) || ('key-' + (apiKeys.length + 1)),
      models: Array.isArray(body.models) ? body.models.filter(m => typeof m === 'string').slice(0, 50) : [],
      accounts: Array.isArray(body.accounts) ? body.accounts.filter(a => typeof a === 'string').slice(0, 50) : [],
      dailyLimit: Number(body.dailyLimit) > 0 ? Math.round(Number(body.dailyLimit)) : 0, // 0=不限
      dailyTokenLimit: Number(body.dailyTokenLimit) > 0 ? Math.round(Number(body.dailyTokenLimit)) : 0, // 0=不限
      dailyCreditLimit: Number(body.dailyCreditLimit) > 0 ? Math.round(Number(body.dailyCreditLimit) * 100) / 100 : 0, // 0=不限
      disabled: false,
      createdAt: Date.now(),
      usage: { date: todayStr(), requests: 0, tokens: 0, credit: 0 },
    };
    atomicWriteJson(APIKEYS_FILE, [...apiKeys, ent]);
    apiKeys.push(ent);
    log(`[keys] 新建附加 Key「${ent.name}」限模型 ${ent.models.join(',') || '(不限)'} / 账号 ${ent.accounts.join(',') || '(不限)'} / 每日 ${ent.dailyLimit || '不限'} 次 / token ${ent.dailyTokenLimit || '不限'} / 积分 ${ent.dailyCreditLimit || '不限'}`);
    // 创建时返回明文一次，之后列表只显示脱敏
    return json(res, 200, { ok: true, key, entry: apiKeysForDisplay().slice(-1)[0] });
  }

  if (req.method === 'POST' && urlPath === '/admin/api/keys/update') {
    const body = await readSmallJson(req);
    const current = resolveKey(apiKeys, body);
    const ent = current ? { ...current, id: keyId(current) } : null;
    if (!ent) return json(res, 404, { ok: false, message: '未找到该 key' });
    if (body.name !== undefined) ent.name = String(body.name).slice(0, 40);
    if (body.models !== undefined) ent.models = Array.isArray(body.models) ? body.models.filter(m => typeof m === 'string').slice(0, 50) : [];
    if (body.accounts !== undefined) ent.accounts = Array.isArray(body.accounts) ? body.accounts.filter(a => typeof a === 'string').slice(0, 50) : [];
    if (body.dailyLimit !== undefined) ent.dailyLimit = Number(body.dailyLimit) > 0 ? Math.round(Number(body.dailyLimit)) : 0;
    if (body.dailyTokenLimit !== undefined) ent.dailyTokenLimit = Number(body.dailyTokenLimit) > 0 ? Math.round(Number(body.dailyTokenLimit)) : 0;
    if (body.dailyCreditLimit !== undefined) ent.dailyCreditLimit = Number(body.dailyCreditLimit) > 0 ? Math.round(Number(body.dailyCreditLimit) * 100) / 100 : 0;
    if (body.disabled !== undefined) ent.disabled = !!body.disabled;
    atomicWriteJson(APIKEYS_FILE, apiKeys.map(e => e === current ? ent : e));
    Object.assign(current, ent);
    log(`[keys] 更新附加 Key「${ent.name}」`);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && urlPath === '/admin/api/keys/delete') {
    const body = await readSmallJson(req);
    const target = resolveKey(apiKeys, body);
    const i = target ? apiKeys.indexOf(target) : -1;
    if (i < 0) return json(res, 404, { ok: false, message: '未找到该 key' });
    atomicWriteJson(APIKEYS_FILE, apiKeys.filter((_, index) => index !== i));
    const [gone] = apiKeys.splice(i, 1);
    log(`[keys] 删除附加 Key「${gone.name}」`);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && urlPath === '/admin/api/restore') {
    let payload = null;
    try { payload = JSON.parse((await readBody(req)).toString('utf-8')); } catch { return json(res, 400, { ok: false, message: 'bad json' }); }
    let data;
    try { data = hardening.validateBackup(payload && payload.payload ? payload.payload : payload); }
    catch (e) { return json(res, 400, {ok:false,message:e.message}); }
    if (chatAdmission.active || checkinRunning || checkinFlights.size || rotationRuntime.rotating || taskQueue.running || checkupRunning || keepaliveRunning) return json(res,409,{ok:false,message:'有请求或账号任务正在进行，请完成后重试恢复'});
    fs.mkdirSync(AUTHS_DIR, { recursive: true });
    const entries = Object.entries(data.accounts).map(([f,obj]) => [accountFile(f),obj]);
    if (data.active) { entries.push([AUTH_FILE_ENV || path.join(__dirname,'auth.json'),data.active]); entries.push([path.join(AUTHS_DIR,stableAccountId(data.active)),data.active]); }
    const restoredUsage = data.usageStats ? {days:{},total:{},accountStats:{},hours:{},...data.usageStats} : null;
    const restoredCheckin = data.checkinState ? {...checkinState,...data.checkinState,accounts:data.checkinState.accounts||{}} : null;
    const restoredSettings = data.settings ? {...appSettings,...data.settings} : null;
    for (const [file,value] of [[USAGE_FILE,restoredUsage],[CHECKIN_STATE_FILE,restoredCheckin],[APIKEYS_FILE,data.apiKeys],[EXTP_FILE,data.extProviders],[SETTINGS_FILE,restoredSettings],[ROTATION_FILE,data.rotation]]) if(value!==undefined&&value!==null) entries.push([file,value]);
    storage.writeBatch([...new Map(entries)]);
    credFsGen++; credManagers.clear(); invalidateAccountsCache();
    if(restoredUsage){usageStats=restoredUsage;usageStatsVer++;}
    if(restoredCheckin)checkinState=restoredCheckin;
    if(data.apiKeys)apiKeys=data.apiKeys;
    if(data.extProviders)extProviders=data.extProviders;
    if(restoredSettings)appSettings=restoredSettings;
    if(data.rotation){rotationCfg={enabled:data.rotation.enabled,intervalMin:data.rotation.intervalMin};rotationRuntime.lastRotation=data.rotation.lastRotation||null;scheduleRotation();}
    const af2=findAuthFile();cred=af2?new CredentialManager(af2):null; activeAccountId=cred?stableAccountId(cred.session()):null;
    await requestMap.setEnabled(appSettings.requestMapEnabled!==false);
    log(`[backup] 已从备份恢复 ${Object.keys(data.accounts).length} 个账号及包含的配置`);
    return json(res,200,{ok:true,restored:Object.keys(data.accounts).length});
  }

  if (req.method === 'POST' && urlPath === '/admin/api/keepalive') {
    try {
      const r = await runKeepalive(true);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 200, { ok: false, msg: sanitizeRemoteText(e.message, 150) });
    }
  }

  // 单账号手动刷新 token（存档号直接强刷，无需切换/重新登录）
  if (req.method === 'POST' && urlPath === '/admin/api/account/refresh') {
    const body = await readSmallJson(req);
    const f = accountFile(String(body.id || ''));
    if (!f || !fs.existsSync(f)) return json(res, 404, { ok: false, message: '账号不存在' });
    try {
      const cm = credManager(f);
      await cm.refresh(true);
      const auth = cm.session().auth || {};
      return json(res, 200, {
        ok: true,
        expiresAt: auth.expiresAt || null,
        refreshExpiresAt: auth.refreshExpiresAt || null,
        message: `已刷新，token 到期 ${new Date(auth.expiresAt || 0).toLocaleString()}`,
      });
    } catch (e) {
      return json(res, 200, { ok: false, message: sanitizeRemoteText(e.message, 200) });
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/api/settings') {
    const body = await readSmallJson(req);
    const draft = { ...appSettings };
    const pm = Number(body.pollMin);
    if (!Number.isFinite(pm) || pm < 5 || pm > 1440) {
      return json(res, 400, { ok: false, message: '巡检间隔需在 5-1440 分钟之间' });
    }
    draft.pollMin = Math.round(pm);
    // 自动刷新（保活）周期：每 N 天刷一轮全部号（1-30 天，越长越低调；token 过期仍有按需刷新兜底）
    if (body.keepaliveEveryDays !== undefined) {
      const kd = Number(body.keepaliveEveryDays);
      if (!Number.isFinite(kd) || kd < 1 || kd > 30) {
        return json(res, 400, { ok: false, message: '自动刷新周期需在 1-30 天之间' });
      }
      draft.keepaliveEveryDays = Math.round(kd);
    }
    // 自动刷新（保活）时间：HH:MM，到点按周期刷新全部账号 token
    if (body.keepaliveAt !== undefined) {
      const ka = String(body.keepaliveAt || '').trim();
      if (!/^\d{1,2}:\d{2}$/.test(ka) || Number(ka.split(':')[0]) > 23 || Number(ka.split(':')[1]) > 59) {
        return json(res, 400, { ok: false, message: '自动刷新时间格式应为 HH:MM' });
      }
      draft.keepaliveAt = ka;
    }
    // 自动备份时间：HH:MM（与自动刷新时间独立）
    if (body.backupAt !== undefined) {
      const ba = String(body.backupAt || '').trim();
      if (!/^\d{1,2}:\d{2}$/.test(ba) || Number(ba.split(':')[0]) > 23 || Number(ba.split(':')[1]) > 59) {
        return json(res, 400, { ok: false, message: '自动备份时间格式应为 HH:MM' });
      }
      draft.backupAt = ba;
    }
    // 计费模型选号策略：expire=优先最早到期，balance=优先余额最多
    if (body.paidRoute !== undefined) {
      const pr = String(body.paidRoute || '').trim();
      if (pr !== 'expire' && pr !== 'balance') return json(res, 400, { ok: false, message: '选号策略仅支持 expire / balance' });
      draft.paidRoute = pr;
    }
    atomicWriteJson(SETTINGS_FILE, draft);
    Object.assign(appSettings, draft);
    log(`[settings] 已保存：余额巡检 ${appSettings.pollMin} 分钟${appSettings.keepaliveAt ? `，自动刷新每 ${Math.max(1, Number(appSettings.keepaliveEveryDays) || 1)} 天 ${appSettings.keepaliveAt}` : ''}${appSettings.backupAt ? `，自动备份 ${appSettings.backupAt}` : ''}；计费选号 ${appSettings.paidRoute === 'balance' ? '余额最多' : '最早到期'}`);
    return json(res, 200, { ok: true, pollMin: appSettings.pollMin, keepaliveAt: appSettings.keepaliveAt || KEEPALIVE_AT, keepaliveEveryDays: Math.max(1, Number(appSettings.keepaliveEveryDays) || 1), backupAt: appSettings.backupAt || '05:30', paidRoute: appSettings.paidRoute });
  }

  if (req.method === 'GET' && urlPath === '/admin/api/rotation') {
    return json(res, 200, {
      ok: true,
      enabled: rotationCfg.enabled,
      intervalMin: rotationCfg.intervalMin,
      nextAt: rotationRuntime.nextAt,
      lastRotation: rotationRuntime.lastRotation,
      flaggedCount: Object.keys(flag403).length,
    });
  }

  if (req.method === 'POST' && urlPath === '/admin/api/rotation/set') {
    const body = await readSmallJson(req);
    const draft = { ...rotationCfg };
    if ('intervalMin' in body) {
      const m = Number(body.intervalMin);
      if (![15, 30, 60, 120].includes(m)) return json(res, 400, { ok: false, message: '间隔仅支持 15/30/60/120 分钟' });
      draft.intervalMin = m;
    }
    if ('enabled' in body) draft.enabled = !!body.enabled;
    atomicWriteJson(ROTATION_FILE, { ...draft, lastRotation: rotationRuntime.lastRotation });
    Object.assign(rotationCfg, draft);
    scheduleRotation();
    log(`[rotation] 配置已更新：${rotationCfg.enabled ? `每 ${rotationCfg.intervalMin} 分钟` : '关闭'}`);
    return json(res, 200, { ok: true, enabled: rotationCfg.enabled, intervalMin: rotationCfg.intervalMin, nextAt: rotationRuntime.nextAt });
  }

  if (req.method === 'POST' && urlPath === '/admin/api/rotation/now') {
    const r = await rotateNow('manual');
    return json(res, 200, r);
  }

  if (req.method === 'POST' && urlPath === '/admin/api/pool/checkup') {
    const body = await readSmallJson(req);
    const f = accountFile(String(body.id || ''));
    if (!f || !fs.existsSync(f)) return json(res, 404, { ok: false, message: '账号不存在' });
    let uid8 = null;
    try { uid8 = uid8Of(JSON.parse(fs.readFileSync(f, 'utf-8'))); } catch { /* ignore */ }
    if (!uid8) return json(res, 400, { ok: false, message: '账号文件缺少 uid' });
    try {
      const r = await poolProbeOne(String(body.id), uid8);
      if (r.ok) { log(`[pool] 手动体检 ${body.id}: 通过，已解除风控标记并移出观察池`); return json(res, 200, { ok: true, message: '体检通过，已解除风控标记并移出观察池' }); }
      log(`[pool] 手动体检 ${body.id}: 未通过（${sanitizeRemoteText(r.msg || r.kind || '', 80)}）`);
      return json(res, 200, { ok: false, kind: r.kind || 'error', message: sanitizeRemoteText(r.msg || '体检未通过，继续观察', 150) });
    } catch (e) {
      return json(res, 200, { ok: false, message: sanitizeRemoteText(e.message, 150) });
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/api/pool/release') {
    const body = await readSmallJson(req);
    const f = accountFile(String(body.id || ''));
    if (!f || !fs.existsSync(f)) return json(res, 404, { ok: false, message: '账号不存在' });
    let uid8 = null;
    try { uid8 = uid8Of(JSON.parse(fs.readFileSync(f, 'utf-8'))); } catch { /* ignore */ }
    if (!uid8) return json(res, 400, { ok: false, message: '账号文件缺少 uid' });
    clearAccount403(uid8);
    log(`[pool] 手动移出观察池: ${body.id}（若上游仍拦截，下次对话请求会再次自动入池）`);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && urlPath === '/admin/api/test') {
    const serveCmTest = resolveServingCm();
    if (!serveCmTest) return json(res, 503, { ok: false, message: '尚无凭据，请先登录' });
    const t0 = Date.now();
    try {
      const body = {
        model: 'auto',
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        stream: true,
        stream_options: { include_usage: true },
      };
      const resp = await callUpstream(serveCmTest, body, AbortSignal.timeout(90_000));
      if (resp.status !== 200) {
        const raw = await resp.text().catch(() => '');
        STATS.errors++;
        return json(res, 200, { ok: false, message: extractUpstreamErrorMsg(raw, resp.status) });
      }
      const completion = await collectStream(resp);
      const msg = (completion.choices[0] && completion.choices[0].message) || {};
      const testSess = serveCmTest.session();
      recordUsage(completion.model, uid8Of(testSess), completion.usage, (testSess.account || {}).nickname || null);
      return json(res, 200, {
        ok: true,
        model: completion.model,
        content: String(msg.content || '').slice(0, 120),
        tokens: completion.usage ? completion.usage.total_tokens : null,
        ms: Date.now() - t0,
      });
    } catch (e) {
      STATS.errors++;
      return json(res, 200, { ok: false, message: sanitizeRemoteText(e.message, 200) });
    }
  }

  // ---- 观测端点（gen3）：全部只读，只聚合内存结构，无副作用 ----

  // 进程级指标摘要：uptime/内存/在途/账号租约/用量/错误率/最近N分钟速率
  if (req.method === 'GET' && urlPath === '/admin/api/metrics') {
    const now = Date.now();
    const sp = new URL(req.url || '/', 'http://localhost').searchParams;
    const rateMin = Math.max(1, Math.min(60, Number(sp.get('rateMin')) || 5));
    const usage = aggregateUsage();
    const sumUsage = (m) => {
      const s = { requests: 0, prompt: 0, cached: 0, completion: 0, total: 0, credit: 0 };
      for (const v of Object.values(m || {})) {
        s.requests += v.requests || 0;
        s.prompt += v.prompt || 0;
        s.cached += v.cached || 0;
        s.completion += v.completion || 0;
        s.total += v.total || 0;
        s.credit += v.credit || 0;
      }
      s.cached = Math.round(s.cached * 1000) / 1000;
      s.credit = Math.round(s.credit * 1000) / 1000;
      return s;
    };
    // REQ_TIMES 按 push 时间单调递增（近似有序），尾端向前数窗口内条数
    const winMs = rateMin * 60_000;
    let recentReqs = 0;
    for (let i = REQ_TIMES.length - 1; i >= 0; i--) {
      if (REQ_TIMES[i] >= now - winMs) recentReqs++; else break;
    }
    // 同窗口内带 err 标记的失败数（ext 板块路径失败行不带 err 字段，故这里只覆盖 codebuddy 主路径失败）
    const recentErrors = RECENT_REQUESTS.filter(r => r.err && r.outcome !== 'client_cancelled' && r.t >= now - winMs).length;
    const mem = process.memoryUsage();
    return json(res, 200, {
      ok: true,
      now,
      uptimeSec: Math.floor((now - STARTED_AT) / 1000),
      pid: process.pid,
      node: process.version,
      storageErrors: storage.status(),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      requests: {
        total: STATS.total,
        errors: STATS.errors,
        errorRate: STATS.total ? Math.round(STATS.errors / STATS.total * 10000) / 10000 : 0,
        inflight: STATS.inflight,
        admitted: chatAdmission.active,
        acctInflight: { ...acctInflight }, // leaseKey(uid8 / file:<id>) -> 在途租约数
        recentWindowMin: rateMin,
        recentRequests: recentReqs,
        recentErrors,
        reqPerMin: Math.round(recentReqs / rateMin * 100) / 100,
      },
      usage: {
        todayDate: usage.todayDate,
        today: { sum: sumUsage(usage.today), byModel: usage.today },
        total: { sum: sumUsage(usage.total), byModel: usage.total },
        firstAt: usage.firstAt,
      },
      liveClients: LIVE_CLIENTS.size,
      extProviders: extProviders.length,
      extCooling: extProviders.filter(p => p.downUntil && p.downUntil > now).map(p => ({
        prefix: p.prefix || p.id,
        reason: p.downReason || '',
        until: p.downUntil,
        remainingSec: Math.max(0, Math.ceil((p.downUntil - now) / 1000)),
      })),
      blockedModels: Object.entries(modelHealth).filter(([, v]) => v && v.blockedUntil > now)
        .map(([k, v]) => ({ key: k, until: v.blockedUntil, reason: v.reason || '', remainingSec: Math.max(0, Math.ceil((v.blockedUntil - now) / 1000)) })),
    });
  }

  // 用量 CSV 导出：date,model,requests,prompt,cached,completion,total（days 默认 31，封顶 62；usageStats 只保留 31 天）
  if (req.method === 'GET' && urlPath === '/admin/api/usage/export') {
    const sp = new URL(req.url || '/', 'http://localhost').searchParams;
    const days = Math.max(1, Math.min(62, Number(sp.get('days')) || 31));
    const startDay = todayStr(new Date(Date.now() - (days - 1) * 86400 * 1000));
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = ['date,model,requests,prompt,cached,completion,total'];
    const sortedDays = Object.keys(usageStats.days || {}).filter(d => d >= startDay).sort();
    for (const day of sortedDays) {
      const models = usageStats.days[day] || {};
      for (const m of Object.keys(models).sort()) {
        const v = models[m] || {};
        lines.push([esc(day), esc(m), v.requests || 0, v.prompt || 0, v.cached || 0, v.completion || 0, v.total || 0].join(','));
      }
    }
    const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="usage-${todayStr()}-${days}d.csv"`,
      'Cache-Control': 'no-store',
    });
    return res.end(csv);
  }

  // 模型健康历史：codebuddy 账号×模型受限（modelHealth 持久化表）+ 各 ext 板块模型探测结果（ent.modelHealth）
  if (req.method === 'GET' && urlPath === '/admin/api/health/history') {
    const now = Date.now();
    const out = [];
    for (const [k, v] of Object.entries(modelHealth)) {
      if (!v) continue;
      const sep = k.indexOf('|');
      const blocked = (v.blockedUntil || 0) > now;
      out.push({
        source: 'account',
        account: sep >= 0 ? k.slice(0, sep) : k,
        model: sep >= 0 ? k.slice(sep + 1) : '',
        lastCheck: v.at || null,
        ok: !blocked,                       // 受限中 = false；已自然过期 = true（历史受限记录）
        blocked,
        blockedUntil: v.blockedUntil || 0,
        remainingSec: blocked ? Math.ceil((v.blockedUntil - now) / 1000) : 0,
        msg: v.reason || '',
        latencyMs: null,
        history: Array.isArray(v.history) ? v.history.slice(-20) : null,
      });
    }
    for (const p of extProviders) {
      const mh = p.modelHealth || {};
      for (const [m, v] of Object.entries(mh)) {
        if (!v) continue;
        out.push({
          source: 'ext',
          provider: p.prefix || p.id,
          model: (p.prefix || p.id) + '/' + m,
          lastCheck: v.at || null,
          ok: !!v.ok,
          msg: v.msg || '',
          latencyMs: typeof v.latencyMs === 'number' ? v.latencyMs : null,
          history: Array.isArray(v.history) ? v.history.slice(-20) : null,
        });
      }
    }
    out.sort((a, b) => (b.lastCheck || 0) - (a.lastCheck || 0));
    return json(res, 200, { ok: true, now, count: out.length, items: out });
  }

  return json(res, 404, { ok: false, message: 'no admin route' });
}

// ---------------------------------------------------------------------------
// 对话主路径
// ---------------------------------------------------------------------------

function chatFailure(req, res, error, info = {}) {
  const outcome = requestRuntime.outcomeOf(error, req.scope?.signal);
  const status = outcome === 'timeout' ? 504 : (Number(error.status) || 502);
  if (outcome !== 'client_cancelled' && !req.failureCounted) { STATS.errors++; req.failureCounted = true; }
  const detail = { err: outcome, outcome, msg: sanitizeRemoteText(error.message || outcome, 160) };
  if (info.rid) pushRecentRequest({ ...info, ...detail });
  if (outcome !== 'client_cancelled' && !res.destroyed && !res.writableEnded) {
    if (res.headersSent) res.end(sseErrorEvent(outcome === 'timeout' ? 'upstream timeout' : 'stream interrupted', status));
    else json(res, status, openaiError(status, detail.msg));
  }
  return detail;
}

async function readUpstreamText(resp, scope, maxBytes = 1024 * 1024) {
  const reader = scope.reader(resp), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await readWithIdle(reader, UPSTREAM_STREAM_IDLE_MS, scope.signal);
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('upstream response exceeds size limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { scope.release(reader); }
}

async function handleChat(req, res) {
  let ctx;
  try { ctx = checkAuth(req) || {}; } catch (e) { return json(res, e.status, e.body); }
  const release = chatAdmission.acquire();
  if (!release) { res.setHeader('Retry-After', '1'); return json(res, 429, openaiError(429, '服务繁忙，请稍后重试', 'capacity_exceeded')); }
  req.scope = requestRuntime.createRequestScope(req, res, REQ_BUDGET_MS, STREAM_MAX_MS);
  const startedAt = Date.now();
  let payload, finishMap;
  try {
    let rawBody;
    try { rawBody = (await requestRuntime.abortable(readBody(req, CHAT_BODY_LIMIT), req.scope.signal)).toString('utf8'); payload = JSON.parse(rawBody); rawBody = null; }
    catch (e) {
      if (req.scope.signal.aborted) throw e;
      if (e && e.tooLarge) return json(res, 413, openaiError(413, `请求体超过 ${Math.round(CHAT_BODY_LIMIT / 1048576)}MB 上限`, 'invalid_request_error'));
      return json(res, 400, openaiError(400, '请求体必须为有效 JSON', 'invalid_request_error'));
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.messages) || !payload.messages.length || (payload.tools !== undefined && !Array.isArray(payload.tools)) || (payload.model !== undefined && typeof payload.model !== 'string')) {
      return json(res, 400, openaiError(400, '需要非空 messages 数组，model 必须为字符串，tools 必须为数组', 'invalid_request_error'));
    }
    const quotaError = quotaLedger.reserve(ctx, payload.model || 'auto');
    if (quotaError) { res.setHeader('Retry-After', '1'); return json(res, quotaError.status, openaiError(quotaError.status, quotaError.message, 'quota_exceeded')); }
    STATS.total++;
    // Observability must never fail an admitted model request.
    try { finishMap = requestMap.begin(req, res, ctx, payload, API_KEY); } catch {}
    const extRoute = extParseModel(payload.model);
    if (extRoute) await handleExtChat(req, res, ctx, extRoute, payload);
    else await handleNativeChat(req, res, ctx, payload);
  } catch (e) {
    chatFailure(req, res, e, { rid: crypto.randomBytes(4).toString('hex'), model: payload?.model || 'auto', durMs: Date.now() - startedAt });
  } finally {
    try { finishMap?.(); } catch {}
    bumpKeyUsage(ctx, 0, 0);
    acctLeaseRelease(req.accountLease); req.accountLease = null;
    req.scope.finish(); release();
  }
}

async function handleNativeChat(req, res, ctx, payload) {
  const serveCm = resolveServingCm();
  if (!serveCm) {
    return json(res, 503, openaiError(503, '未找到登录凭据：请在管理台 /admin 完成手机号登录', 'auth_error'));
  }

  const messages = payload.messages; // handleChat 已校验为非空数组

  const clientWantsStream = !!payload.stream;
  const body = {};
  for (const k of PASSTHROUGH_BODY_KEYS) if (k in payload) body[k] = payload[k];
  if (!body.model) body.model = 'auto';
  body.stream = true;
  if (!('stream_options' in body)) body.stream_options = { include_usage: true };
  if (DESENSITIZE) body.messages = desensitizeMessages(body.messages);

  const rid = crypto.randomBytes(4).toString('hex');
  const t0 = Date.now();
  let firstByteAt = 0; // 上游首字节（首字延迟基准）
  const toolNames = (payload.tools || []).map(t => t && t.function && t.function.name).filter(Boolean);

  // 附加 Key 限额：模型白名单 + 每日请求额度（在发上游前拦截，不消耗上游资源）
  if (ctx && ctx.restrictions) {
    const err = keyRestrictionError(ctx, body.model);
    if (err) {
      log(`[${rid}] ⊘ key 限额拦截: ${err.body.error.message}`);
      return json(res, err.status, err.body);
    }
    log(`[${rid}] ▶ [key ${ctx.name || maskKey(ctx.key)}] ${body.model} | stream=${clientWantsStream} | msgs=${messages.length}` +
        (toolNames.length ? ` | tools=${toolNames.length}` : ''));
  } else {
    log(`[${rid}] ▶ ${body.model} | stream=${clientWantsStream} | msgs=${messages.length}` +
        (toolNames.length ? ` | tools=${toolNames.length}` : ''));
  }

  const abort = req.scope;

  let resp = null;
  let quotaMsg = null;
  let servedUid8 = null;
  let servedName = null;
  let fallbackFrom = null;   // 触发模型降级时记录原模型
  let beforeFallback = null;
  let servedModel = body.model;

  // 选号：hard 冷却（模型级受限/403 标记）一律跳过；soft 冷却（网络/5xx/非配额 429）
  // 只降优先级——ignoreSoft=false 时跳过，别无可选时第二轮 ignoreSoft=true 仍可使用，
  // 避免单账号部署因一次瞬时抖动就在冷却期内全部快速失败。
  function selectAccount(model, tried, ignoreSoft) {
    let account = null, accountFileId = null;
    const usable = u8 => !isBlockedModel(u8, model) && (ignoreSoft || !isSoftCooling(u8, model));
    {
      const u8OfCred = serveCm ? uid8Of(serveCm.session()) : null;
      const paid = modelMultiplier(model) > 0;
      if (paid) {
        // 计费模型：自动路由到"余额最多"的账号，防止把低余额号烧穿
        // 初值 -2：余额未知（重启后巡检未跑）的候选按 -1 计，保证窗口期内仍能选出账号
        // 选号策略：'expire' 优先消耗最早到期的积分，'balance' 优先用余额最多的号
        const byExpire = appSettings.paidRoute !== 'balance';
        let bestCand = null, bestBal = -2, bestExp = Infinity;
        const cands = [];
        // 当前服务号也参与竞选，但它是 CredentialManager 实例而非存档文件，故记 cm、id 为 null
        if (serveCm && !tried.has(u8OfCred) && usable(u8OfCred) && !is403Flagged(u8OfCred) && accountAllowed(ctx, u8OfCred) && !acctLeaseBusy(serveCm, null)) cands.push({ id: null, cm: serveCm, u8: u8OfCred });
        for (const a of listAccounts()) {
          if (!a.uid || a.checkinOnly || a.flag403 || tried.has(a.uid) || !usable(a.uid) || !accountAllowed(ctx, a.uid) || (acctInflight[a.uid] || 0) >= ACCT_MAX_INFLIGHT) continue;
          cands.push({ id: a.id, cm: null, u8: a.uid });
        }
        for (const c of cands) {
          const hh = accountHealth[c.u8] || {};
          const b = typeof hh.balance === 'number' ? hh.balance : -1;
          const e = typeof hh.earliestExpire === 'number' ? hh.earliestExpire : Infinity;
          if (byExpire) {
            // 主要按到期时间升序；到期相同（或都未知）时用余额降序做决胜，避免总打同一个号
            if (e < bestExp || (e === bestExp && b > bestBal)) { bestExp = e; bestBal = b; bestCand = c; }
          } else {
            if (b > bestBal) { bestBal = b; bestCand = c; }
          }
        }
        // 判空必须用候选对象而非 id：当前服务号胜出时 id 为 null，
        // 旧代码 if (bestId) 会漏判，导致明明有号可用却报「所有账号均受限」
        if (bestCand) {
          account = bestCand.cm || credManager(path.join(AUTHS_DIR, bestCand.id));
          accountFileId = bestCand.id; // 服务号胜出时为 null → 后续不做持久切换（它已是启用号）
          const label = bestCand.id || u8OfCred + '(当前服务号)';
          if (byExpire) {
            const dt = Number.isFinite(bestExp) ? new Date(bestExp).toLocaleDateString() : '未知';
            log(`[route] 计费模型 ${model} → 积分最早到期的账号 ${label}（到期 ${dt}，余额 ${bestBal}）`);
          } else {
            log(`[route] 计费模型 ${model} → 余额最多的账号 ${label}（余额 ${bestBal}）`);
          }
        }
      } else {
        // 免费模型：当前服务账号优先，受限则换其它账号（仅签到号/403标记号/key 未授权号不参与）
        if (serveCm && !tried.has(u8OfCred) && usable(u8OfCred) && !is403Flagged(u8OfCred) && accountAllowed(ctx, u8OfCred) && !acctLeaseBusy(serveCm, null)) account = serveCm;
        if (!account) {
          for (const a of listAccounts()) {
            if (!a.uid || a.checkinOnly || a.flag403 || tried.has(a.uid) || !usable(a.uid) || !accountAllowed(ctx, a.uid) || (acctInflight[a.uid] || 0) >= ACCT_MAX_INFLIGHT) continue;
            account = credManager(path.join(AUTHS_DIR, a.id));
            accountFileId = a.id;
            break;
          }
        }
      }
    }
    return account ? { account, accountFileId } : null;
  }

  try {
    // 故障转移候选循环：只调用"该模型未受限"的账号。
    // 关键：已标记受限的组合直接跳过、不打上游——否则每次 429 都会把滚动窗口的重置时间往后推。
    // 外层 hop：原模型在全部账号上 model_unavailable/region_blocked 时，按降级链换模型重试一次。
    let model = body.model;
    for (let hop = 0; hop < 2; hop++) {
      const tried = new Set();
      let lastKind = null, attempted = false;
      for (let round = 0; round < 2; round++) {
        const pick = selectAccount(model, tried, false) || selectAccount(model, tried, true);
        if (!pick) { log(`[${rid}] 所有账号的 ${model} 均受限，快速失败（不打上游）`); break; }
        let { account, accountFileId } = pick;
        const archivePath = path.join(AUTHS_DIR, stableAccountId(account.session()));
        if (fs.existsSync(archivePath)) account = credManager(archivePath);
        req.scope.signal.throwIfAborted();
        req.accountLease = acctLeaseAcquire(account, accountFileId);
        if (!req.accountLease) continue;
        tried.add(uid8Of(account.session()));
        attempted = true;
        const attemptBody = { ...body, model };
        const attemptUid = uid8Of(account.session());
        let raw = '', status = 0, retryAfter = 0;
        try {
          if (ctx.reservation) ctx.reservation.started = true;
          const upstream = await callUpstream(account, attemptBody, abort.signal);
          if (upstream.status === 200) {
            resp = upstream;
            servedModel = model;
            const sess = account.session();
            servedUid8 = uid8Of(sess);
            servedName = (sess.account || {}).nickname || null;
            clearAccount403(servedUid8);
            clearSoftCooling(servedUid8, model);
            break;
          }
          status = upstream.status;
          retryAfter = Number(upstream.headers.get('retry-after')) || 0;
          raw = await readUpstreamText(upstream, req.scope);
          // Preserve the body for the final error handler; never consume it twice.
          resp = new Response(raw, { status, headers: upstream.headers });
        } catch (e) {
          if (abort.signal.aborted) throw e;
          raw = JSON.stringify({ error: { message: sanitizeRemoteText(e.message, 200) } });
          resp = new Response(raw, { status: 502 }); // status 仍为 0 → 按网络错误分类
        }
        acctLeaseRelease(req.accountLease); req.accountLease = null;
        let errBody = null;
        try { errBody = JSON.parse(raw); } catch {}
        const code = errBody && errBody.code;
        quotaMsg = sanitizeRemoteText((errBody && (errBody.msg || errBody.error?.message || errBody.message)) || raw || `HTTP ${resp.status}`, 200);
        lastKind = applyChatErrorPolicy(attemptUid, model, status, code, quotaMsg, retryAfter);
        log(`[${rid}] ✗ HTTP ${resp.status} (code=${code}, ${lastKind}) ${model}: ${quotaMsg} → ${round === 0 ? '换另一账号重试一次' : '重试次数已用完'}`);
        recordAccountFailure(attemptUid, model, ctx);
        // tried ensures the second attempt always uses a different account.
      }
      if ((resp && resp.status === 200) || hop > 0) break;
      const unavailable = modelBlockedByKinds(model, ['model_unavailable', 'region_blocked'], ctx);
      const target = unavailable ? fallbackModelFor(model, serveCm, listAccounts()) : null;
      if (!target || keyRestrictionError(ctx, target)) break;
      log(`[${rid}] ↘ ${model} 在全部可用账号上不可用，按降级链改用 ${target} 重试`);
      beforeFallback = { resp, quotaMsg };
      fallbackFrom = model; model = target; resp = null; quotaMsg = null;
    }
    // 降级目标也选不到号：返回原模型的错误，而不是笼统的「无可用账号」
    if (fallbackFrom && !resp && beforeFallback) { ({ resp, quotaMsg } = beforeFallback); fallbackFrom = null; }
  } catch (e) {
    return chatFailure(req, res, e, { rid, model: body.model, uid8: servedUid8, name: servedName, durMs: Date.now() - t0 });
  }
  if (!resp) {
    const msg = quotaMsg || '账号已达并发上限或当前模型不可用，请稍后重试';
    res.setHeader('Retry-After', '1');
    STATS.errors++;
    log(`[${rid}] ✗ 无可用账号: ${msg}`);
    pushRecentRequest({ rid, model: body.model, uid8: null, name: null, err: 'limited', msg: String(msg).slice(0, 120), ttft: null, durMs: Date.now() - t0 });
    json(res, 429, openaiError(429, msg));
    return;
  }

  if (resp.status !== 200) {
    let raw = '';
    try { raw = await resp.text(); } catch { /* ignore */ }
    STATS.errors++;
    log(`[${rid}] ✗ HTTP ${resp.status} | ${raw.slice(0, 300).replace(/\n/g, ' ')}`);
    const safeMsg = extractUpstreamErrorMsg(raw, resp.status);
    pushRecentRequest({ rid, model: body.model, uid8: servedUid8 || null, name: servedName || null, err: resp.status, msg: String(safeMsg).slice(0, 120), ttft: null, durMs: Date.now() - t0 });
    if (clientWantsStream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.end(sseErrorEvent(safeMsg, resp.status));
    } else {
      json(res, resp.status, openaiError(resp.status, safeMsg));
    }
    return;
  }

  // 上游已接受：解除整请求预算，改由流式空闲超时 + 流式总时长上限约束
  req.scope.streaming();
  const fallbackHeaders = fallbackFrom ? { 'x-fallback-model': servedModel, 'x-original-model': fallbackFrom } : {};
  if (fallbackFrom) log(`[${rid}] ↘ 已降级：${fallbackFrom} → ${servedModel}`);

  if (clientWantsStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...fallbackHeaders,
    });
    const stats = makeStreamStats();
    const chunkState = { roleSent: false };
    const decoder = new TextDecoder();
    let buf = '';
    const reader = req.scope.reader(resp);
    let streamFailure = null;
    try {
      // 逐行处理需要 await 写回压，先同步切行收集，再顺序处理
      const lines = [];
      for (;;) {
        const { done, value } = await readWithIdle(reader, UPSTREAM_STREAM_IDLE_MS, req.scope.signal);
        if (done) break;
        if (!res.writable) break;
        if (!firstByteAt && value && value.length) firstByteAt = Date.now();
        buf += decoder.decode(value, { stream: true });
        if (buf.length > 8 * 1024 * 1024) throw new Error('SSE event exceeds size limit');
        lines.length = 0;
        buf = requestRuntime.splitLines(buf, l => lines.push(l));
        for (let line of lines) {
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') { await requestRuntime.writeChunk(res, 'data: [DONE]\n\n', req.scope.signal); continue; }
          let obj;
          try { obj = JSON.parse(raw); } catch { await requestRuntime.writeChunk(res, line + '\n\n', req.scope.signal); continue; } // 非 JSON 原样放行
          if (obj.error) { feedSseObj(stats, obj); throw new Error(sanitizeRemoteText(obj.error.message || 'upstream SSE error', 160)); }
          feedSseObj(stats, obj);
          const clean = sanitizeSseChunk(obj, chunkState);
          if (clean) await requestRuntime.writeChunk(res, 'data: ' + JSON.stringify(clean) + '\n\n', req.scope.signal);
        }
      }
      recordAccountSuccess(servedUid8);
      res.end();
    } catch (e) {
      streamFailure = chatFailure(req, res, e);
      if (streamFailure.outcome !== 'client_cancelled') recordAccountFailure(servedUid8, body.model, ctx);
    } finally { req.scope.release(reader); }
    const tag = (stats.sawFilter || stats.finish === 'content-filter') ? ' ⚠️内容审核拦截' : '';
    const durMs = Date.now() - t0;
    const usage = stats.usage || {};
    const cached = cachedTokensOf(usage);
    const credit = creditEstimate(stats.model || body.model, usage.prompt_tokens, usage.completion_tokens, usage);
    log(`[${rid}] ◀ ${body.model}@${servedUid8 || '?'} | 首字 ${firstByteAt ? firstByteAt - t0 : '?'}ms | ${(durMs / 1000).toFixed(1)}s | 入 ${usage.prompt_tokens ?? '?'}${cached ? `(缓存 ${cached})` : ''} | 出 ${usage.completion_tokens ?? '?'} | 积分 ${credit} | finish=${stats.finish}${tag}` +
        (stats.toolNames.length ? ` | tool_calls=${[...new Set(stats.toolNames)].join(',')}` : ''));
    pushRecentRequest({ ...streamFailure, rid, model: body.model, uid8: servedUid8 || null, name: servedName || null, stream: true, finish: stats.finish || null, ttft: firstByteAt ? firstByteAt - t0 : null, durMs, prompt: Number(usage.prompt_tokens) || 0, cached, completion: Number(usage.completion_tokens) || 0, total: totalTokensOf(usage), credit, filter: !!(stats.sawFilter || stats.finish === 'content-filter'), tools: stats.toolNames.length });
    recordUsage(stats.model || body.model, servedUid8, stats.usage, servedName);
    bumpKeyUsage(ctx, totalTokensOf(usage), credit);
    return;
  }

  try {
    const completion = await collectStream(resp, () => { if (!firstByteAt) firstByteAt = Date.now(); }, req.scope);
    const ch = (completion.choices || [{}])[0];
    const tag = (ch.finish_reason === 'content-filter') ? ' ⚠️内容审核拦截' : '';
    const durMs = Date.now() - t0;
    const usage = completion.usage || {};
    const cached = cachedTokensOf(usage);
    const credit = creditEstimate(completion.model || body.model, usage.prompt_tokens, usage.completion_tokens, usage);
    log(`[${rid}] ◀ ${body.model}@${servedUid8 || '?'} | 首字 ${firstByteAt ? firstByteAt - t0 : '?'}ms | ${(durMs / 1000).toFixed(1)}s | 入 ${usage.prompt_tokens ?? '?'}${cached ? `(缓存 ${cached})` : ''} | 出 ${usage.completion_tokens ?? '?'} | 积分 ${credit} | finish=${ch.finish_reason}${tag}`);
    pushRecentRequest({ rid, model: body.model, uid8: servedUid8 || null, name: servedName || null, stream: false, finish: ch.finish_reason || null, ttft: firstByteAt ? firstByteAt - t0 : null, durMs, prompt: Number(usage.prompt_tokens) || 0, cached, completion: Number(usage.completion_tokens) || 0, total: totalTokensOf(usage), credit, filter: ch.finish_reason === 'content-filter', tools: (completion.choices[0].message.tool_calls || []).length });
    recordUsage(completion.model || body.model, servedUid8, completion.usage, servedName);
    bumpKeyUsage(ctx, totalTokensOf(usage), credit);
    recordAccountSuccess(servedUid8);
    for (const [k, v] of Object.entries(fallbackHeaders)) res.setHeader(k, v);
    return json(res, 200, completion);
  } catch (e) {
    if (requestRuntime.outcomeOf(e, req.scope.signal) !== 'client_cancelled') recordAccountFailure(servedUid8, body.model, ctx);
    return chatFailure(req, res, e, { rid, model: body.model, uid8: servedUid8, name: servedName, stream: false, durMs: Date.now() - t0 });
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

let cred = null;
const authFile = findAuthFile();
if (authFile) {
  try { cred = new CredentialManager(authFile); } catch (e) { log(`凭据初始化失败: ${sanitizeRemoteText(e.message)}`); }
}
try { importActiveToStore(); } catch { /* ignore */ }

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !API_KEY) {
  log('✗ 拒绝启动：监听非回环地址时必须设置 CB_API_KEY');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  log(`==== codebuddy-proxy v2 启动 ====`);
  log(`监听     : http://${HOST}:${PORT}`);
  log(`凭据文件 : ${authFile || '(未找到！请访问 /admin 登录)'}`);
  log(`鉴权     : ${API_KEY ? '已启用 CB_API_KEY' : '未启用(仅回环可用)'}`);
  log(`模型超时 : headers=${UPSTREAM_HEADERS_TIMEOUT_MS}ms idle=${UPSTREAM_STREAM_IDLE_MS}ms admission=${REQ_BUDGET_MS}ms stream=${STREAM_MAX_MS}ms`);
  log(`脱敏     : ${DESENSITIZE ? '已启用' : '关闭'}`);
  log(`管理台   : GET /admin?key=<CB_API_KEY>`);
  if (cred) {
    try {
      const s = cred.summary();
      log(`账号     : ${s.nickname} (${s.siteLabel}) token过期: ${new Date(s.expiresAt).toISOString()}`);
    } catch (e) { log(`账号读取失败: ${sanitizeRemoteText(e.message)}`); }
  }
  log(`路由     : GET /health | GET /admin | GET /v1/models | POST /v1/chat/completions`);
});

// ---------------------------------------------------------------------------
// 定时轮换服务号（摊薄单号被上游风控的概率）：每 intervalMin 分钟切到下一个健康号
//   候选过滤：仅签到号 / 403 标记号 / 账号级受限号 不参与；切换前用体检探测验证（探测成功/失败同时维护 403 标记）
//   临时启用期间暂停轮换；关闭后行为与旧版一致（仅余额巡检/故障转移自动换号）
//   配置持久化 auths/.rotation.json，重启不丢
// ---------------------------------------------------------------------------

const ROTATION_FILE = path.join(AUTHS_DIR, '.rotation.json');
let rotationCfg = { enabled: false, intervalMin: 60 };
const rotationRuntime = { nextAt: null, lastRotation: null, rotating: false };
try {
  const j = JSON.parse(fs.readFileSync(ROTATION_FILE, 'utf-8'));
  if (j && typeof j === 'object') {
    rotationCfg.enabled = !!j.enabled;
    if ([15, 30, 60, 120].includes(Number(j.intervalMin))) rotationCfg.intervalMin = Number(j.intervalMin);
    rotationRuntime.lastRotation = j.lastRotation || null;
  }
} catch { /* 首次无配置 */ }
function saveRotationCfg() {
  try {
    atomicWriteJson(ROTATION_FILE, {
      enabled: rotationCfg.enabled, intervalMin: rotationCfg.intervalMin, lastRotation: rotationRuntime.lastRotation,
    });
  } catch { /* ignore */ }
}
let rotationTimer = null;
function scheduleRotation() {
  if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; }
  rotationRuntime.nextAt = rotationCfg.enabled ? Date.now() + rotationCfg.intervalMin * 60_000 : null;
  if (rotationCfg.enabled) {
    rotationTimer = setInterval(() => {
      rotationRuntime.nextAt = Date.now() + rotationCfg.intervalMin * 60_000;
      rotateNow('timer').catch(() => {});
    }, rotationCfg.intervalMin * 60_000);
  }
  log(`[rotation] 定时轮换${rotationCfg.enabled ? `已开启：每 ${rotationCfg.intervalMin} 分钟` : '已关闭'}`);
}
async function rotateNow(trigger) {
  if (rotationRuntime.rotating) return { ok: false, message: '轮换正在进行中' };
  rotationRuntime.rotating = true;
  try {
    if (servingOverrideId) return { ok: false, message: '临时启用期间暂停轮换' };
    if (!cred) return { ok: false, message: '无默认服务账号' };
    const curUid8 = uid8Of(cred.session());
    // 候选按文件名稳定排序，从当前账号之后循环取，保证轮转公平
    const all = listAccounts().slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const cands = all.filter(a => a.uid && a.uid !== curUid8 && !a.checkinOnly && !a.flag403);
    if (!cands.length) { log('[rotation] 无可用候选账号（已排除仅签到/403标记/受限号），保持不变'); return { ok: false, message: '无可用候选账号' }; }
    const idx = all.findIndex(a => a.uid === curUid8);
    const ordered = idx >= 0 ? [...all.slice(idx + 1), ...all.slice(0, idx)].filter(a => cands.includes(a)) : cands;
    for (const c of ordered) {
      try {
        const cm = credManager(accountFile(c.id));
        const pr = await probeOne(cm, c.uid, pickProbeModel()); // 探测通过会顺带解除 403 标记，11140 会打标
        if (!pr.ok) { log(`[rotation] 候选 ${c.id} 探测未通过（${sanitizeRemoteText(pr.msg || pr.kind || 'unknown', 80)}），跳过`); continue; }
        const sw = switchAccount(c.id);
        if (!sw.ok) { log(`[rotation] 切换到 ${c.id} 失败：${sanitizeRemoteText(sw.message || '', 80)}`); continue; }
        rotationRuntime.lastRotation = { at: Date.now(), trigger: trigger || 'manual', from: curUid8 || null, to: c.id, toUid8: c.uid };
        saveRotationCfg();
        log(`[rotation] 已轮换：${curUid8 || '(none)'} → ${c.id}（探测通过）`);
        return { ok: true, switchedTo: c.id, toUid8: c.uid };
      } catch (e) {
        log(`[rotation] 候选 ${c.id} 异常: ${sanitizeRemoteText(e.message, 100)}`);
      }
    }
    log('[rotation] 所有候选探测未通过，保持当前账号');
    return { ok: false, message: '所有候选探测未通过，保持当前账号' };
  } finally {
    rotationRuntime.rotating = false;
  }
}
scheduleRotation();

// ---------------------------------------------------------------------------
// 自动备份（本地落盘 + 滚动保留）：数据范围与 GET /admin/api/backup 完全一致。
// 定时器必须注册在模块顶层：原先在 handleAdmin 内定义，每个 admin API 请求都会
// 泄漏一个 setInterval（10 分钟粒度不断累积）。
// ---------------------------------------------------------------------------

const BACKUP_DIR = path.join(__dirname, 'backups');
const AUTO_BACKUP_KEEP = 7; // 滚动保留份数
function buildBackupBundle() {
  const bundle = { version: 2, exportedAt: Date.now(), app: 'codebuddy-proxy', accounts: {}, active: cred ? cred.session() : null, usageStats, checkinState,
    apiKeys, extProviders, settings: appSettings, rotation: { ...rotationCfg, lastRotation: rotationRuntime.lastRotation } };
  fs.mkdirSync(AUTHS_DIR, { recursive: true });
  for (const f of fs.readdirSync(AUTHS_DIR)) {
    if (f.endsWith('.json') && !f.startsWith('.')) bundle.accounts[f] = JSON.parse(fs.readFileSync(path.join(AUTHS_DIR,f),'utf8'));
  }
  return bundle;
}

function runAutoBackup(trigger) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `codebuddy-backup-${todayStr()}-${Date.now()}.json`;
    atomicWriteJson(path.join(BACKUP_DIR, name), buildBackupBundle());
    // 滚动清理：按文件名（含时间戳）升序，超出保留份数删最旧
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('codebuddy-backup-') && f.endsWith('.json')).sort();
    const removed = [];
    while (files.length > AUTO_BACKUP_KEEP) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); removed.push(old); } catch { /* ignore */ }
    }
    checkinState.autoBackup = { at: Date.now(), trigger: trigger || 'timer', file: name, kept: files.length, removedOld: removed.length };
    saveCheckinState();
    log(`[backup] 自动备份完成: ${name}（保留 ${files.length} 份${removed.length ? `，清理旧备份 ${removed.length} 份` : ''}）`);
    return { ok: true, file: name, kept: files.length };
  } catch (e) {
    log(`[backup] 自动备份失败: ${sanitizeRemoteText(e.message, 150)}`);
    return { ok: false, message: sanitizeRemoteText(e.message, 150) };
  }
}
function backupTick() {
  if (scheduledDue(new Date(), appSettings.backupAt || '05:30', checkinState.autoBackup?.at)) runAutoBackup('timer');
}
setInterval(backupTick, 60_000).unref();
setTimeout(backupTick, 8_000).unref();

// ---------------------------------------------------------------------------
// 观察池（删除号池）：账号打上 403 风控标记即自动入池观察
//   - 暂停每日自动签到（签到定时器里过滤），手动签到仍可用
//   - 每天自动单独体检一次（probeOne / pickProbeModel）：通过 → 解除标记自动出池，恢复签到/服务资格
//   - POOL_MAX_DAYS 天风控未解除 → 自动彻底删除存档（若为当前服务号，先切到健康号再删）
//   - 管理台可操作：立即体检 / 移出观察池 / 彻底删除；重新登录同一账号也会清标记出池
// ---------------------------------------------------------------------------

const POOL_STATE_FILE = path.join(AUTHS_DIR, '.pool-state.json');
let poolState = { lastRunDate: null };
try { const j = JSON.parse(fs.readFileSync(POOL_STATE_FILE, 'utf-8')); if (j && typeof j === 'object') poolState.lastRunDate = j.lastRunDate || null; } catch { /* 首次无状态 */ }
function savePoolState() { try { atomicWriteJson(POOL_STATE_FILE, poolState); } catch { /* ignore */ } }

async function poolProbeOne(id, uid8) {
  const cm = credManager(accountFile(id));
  return probeOne(cm, uid8, pickProbeModel()); // 通过→自动解除标记；11140→保持标记
}

async function poolEvict(id, reason) {
  // 若删的是当前默认服务号，先切到健康备选，避免删完后服务暂停
  if (cred && activeAccountId === id) {
    const curUid8 = uid8Of(cred.session());
    const alt = listAccounts().find(a => a.uid && a.uid !== curUid8 && !a.checkinOnly && !a.flag403);
    if (alt) switchAccount(alt.id);
  }
  const r = deleteAccount(id); // 内部会同步清掉 403 标记
  log(`[pool] ${reason}，账号 ${id} 已${r.ok ? '彻底删除' : '删除失败：' + sanitizeRemoteText(r.message || '', 80)}`);
  return r;
}

async function poolDailyTick() {
  for (const [uid8, meta] of Object.entries(flag403)) {
    const acc = listAccounts().find(a => a.uid === uid8);
    if (!acc) { delete flag403[uid8]; saveFlag403(); continue; } // 存档已不在，清孤儿标记
    const ageDays = (Date.now() - (meta.at || Date.now())) / 86400_000;
    if (ageDays >= POOL_MAX_DAYS) {
      await poolEvict(acc.id, `入池观察满 ${POOL_MAX_DAYS} 天风控未解除（入池 ${new Date(meta.at).toLocaleDateString()}）`);
      continue;
    }
    try {
      const r = await poolProbeOne(acc.id, uid8);
      if (r.ok) log(`[pool] 账号 ${uid8} 体检通过，已解除风控标记并退出观察池（恢复签到/服务资格）`);
      else log(`[pool] 账号 ${uid8} 体检仍未通过（${sanitizeRemoteText(r.msg || r.kind || 'unknown', 80)}），继续观察（剩 ${acc.flag403DaysLeft} 天）`);
    } catch (e) {
      log(`[pool] 账号 ${uid8} 体检异常: ${sanitizeRemoteText(e.message, 100)}`);
    }
  }
}

// 每 10 分钟醒一次，按日期去重触发当天体检（首次部署后会在 10 分钟内跑第一轮）
setInterval(async () => {
  try {
    if (poolState.lastRunDate === todayStr()) return;
    if (!Object.keys(flag403).length) return;
    poolState.lastRunDate = todayStr();
    savePoolState();
    log(`[pool] 开始今日观察池体检（${Object.keys(flag403).length} 个账号）`);
    await poolDailyTick();
  } catch { /* ignore */ }
}, 10 * 60 * 1000).unref();

// 余额巡检（每 3 分钟刷新全部账号余额 + 积分到期时间）+ 两类自动切换：
//   ① 余额低于阈值 → 切到余额最多的号
//   ② 余额充足但别的号积分更早到期 → 优先轮换到快过期的号（防浪费）
async function pollBalances() {
  try {
    if (!fs.existsSync(AUTHS_DIR)) return;
    await getAllCredits(true); // 刷新所有账号余额/到期时间（写入 accountHealth + creditsCache）
  } catch { /* ignore */ }
  if (servingOverrideId) return; // 临时启用期间跳过自动轮换，保持用户选择
  try {
    if (!cred) return;
    const activeUid8 = uid8Of(cred.session());
    const ah = accountHealth[activeUid8] || {};
    const activeBal = typeof ah.balance === 'number' ? ah.balance : null;
    const activeExp = ah.earliestExpire || null;
    // 候选：未受限、余额达标的其它账号，按积分最早到期排序
    let best = null;
      for (const a of listAccounts()) {
        if (a.uid === activeUid8 || a.checkinOnly || a.flag403) continue;
      const hh = accountHealth[a.uid] || {};
      if (typeof hh.balance !== 'number' || hh.balance < FAILOVER_CREDITS) continue;
      const exp = hh.earliestExpire || Infinity;
      if (!best || exp < best.exp) best = { id: a.id, exp, bal: hh.balance };
    }
    const belowThreshold = activeBal !== null && activeBal < FAILOVER_CREDITS;
    if (best && (belowThreshold || (activeExp !== null && best.exp < activeExp))) {
      const reason = belowThreshold
        ? `当前账号余额 ${activeBal} 低于阈值 ${FAILOVER_CREDITS}`
        : `轮换到积分更早到期的账号（当前到期 ${new Date(activeExp).toLocaleDateString()}，目标 ${new Date(best.exp).toLocaleDateString()}）`;
      const sw = switchAccount(best.id);
      if (sw.ok) log(`[failover] ${reason}，已切换到 ${best.id}（余额 ${best.bal}）`);
    } else if (belowThreshold) {
      log(`[failover] 当前账号余额 ${activeBal} 低于阈值 ${FAILOVER_CREDITS}，无达标备选账号`);
    }
  } catch { /* ignore */ }
}
let lastPollAt = 0;
setInterval(async () => {
  // 巡检间隔由管理台设置（appSettings.pollMin，默认 120 分钟）
  if (Date.now() - lastPollAt < (appSettings.pollMin || 120) * 60_000) return;
  lastPollAt = Date.now();
  await pollBalances();
}, 60 * 1000).unref();
setTimeout(async () => { lastPollAt = Date.now(); await pollBalances(); }, 8 * 1000).unref(); // 启动后 8 秒先跑一轮

// Token 保活：每天 KEEPALIVE_AT 无条件刷新全部账号 token，防止长期闲置的号 refresh token 过期
let keepaliveRunning = false;
async function runKeepalive(force) {
  if (keepaliveRunning) return { ok: false, skipped: true, msg: '保活任务正在运行' };
  const today = todayStr();
  if (!force && checkinState.keepalive && checkinState.keepalive.date === today && checkinState.keepalive.results?.every(r => r.ok)) {
    return { ok: true, skipped: true, msg: '今天已保活过' };
  }
  keepaliveRunning = true;
  try {
  fs.mkdirSync(AUTHS_DIR, { recursive: true });
  const files = fs.readdirSync(AUTHS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  const results = [];
  for (const f of files) {
    try {
      const cm = credManager(path.join(AUTHS_DIR, f));
      await cm.refresh(true);
      results.push({ id: f, ok: true });
      log(`[keepalive] ${f}: token 已刷新`);
    } catch (e) {
      results.push({ id: f, ok: false, msg: sanitizeRemoteText(e.message, 120) });
      log(`[keepalive] ${f}: ✗ ${sanitizeRemoteText(e.message, 120)}`);
    }
  }
  const ok = results.every(r => r.ok);
  checkinState.keepalive = { date: today, at: Date.now(), lastSuccessAt: ok ? Date.now() : (checkinState.keepalive?.lastSuccessAt || 0), results };
  saveCheckinState();
  return { ok, results };
  } finally { keepaliveRunning = false; }
}
function keepaliveTick() {
  const state = checkinState.keepalive;
  const last = state?.lastSuccessAt ?? (state?.results?.every(r => r.ok) ? state.at : 0);
  if (state?.at && Date.now() - state.at < 30 * 60_000) return; // failed batches retry after 30 minutes
  if (scheduledDue(new Date(), appSettings.keepaliveAt || KEEPALIVE_AT, last, Math.max(1, Number(appSettings.keepaliveEveryDays) || 1))) {
    runKeepalive(false).catch(e => log(`[keepalive] ${sanitizeRemoteText(e.message, 160)}`));
  }
}
setInterval(keepaliveTick, 60_000).unref();
setTimeout(keepaliveTick, 8_000).unref();

// Fatal exceptions may leave state inconsistent: flush what is safe and let systemd restart.
let fatalExiting = false;
function fatalExit(kind, error) {
  if (fatalExiting) return;
  fatalExiting = true;
  try { log(`${kind}: ${sanitizeRemoteText(error?.stack || String(error), 2000)}`); } catch {}
  try { flushDeferredWrites(); } catch {}
  const timer = setTimeout(() => process.exit(1), 1000);
  try { server.close(() => { clearTimeout(timer); process.exit(1); }); server.closeIdleConnections?.(); } catch { process.exit(1); }
}
process.on('unhandledRejection', e => fatalExit('unhandledRejection', e));
process.on('uncaughtException', e => fatalExit('uncaughtException', e));

// 优雅停机：server.close() 先拒绝新连接 → 主动 end 掉 SSE 长连接（res.end 触发 req 'close'，
// 心跳定时器随之清理）→ 在途普通请求自行排水 → 连接清零即 close 回调 flush+退出；
// 3s 兜底强制退出（覆盖异常挂起的连接）。倒序补做 flush 防回调竞态漏写。
let shuttingDown = false;
function gracefulShutdown(sig) {
  if (shuttingDown) return; // 两个信号各注册了 handler，连发时只走一次
  shuttingDown = true;
  requestMap.close();
  log(`收到 ${sig}，优雅停机中（排水上限 3s）`);
  server.close(() => {
    try { flushDeferredWrites(); } catch { /* ignore */ }
    log('连接已排空，退出');
    process.exit(0);
  });
  for (const res of LIVE_CLIENTS) { try { res.end(); } catch { /* ignore */ } }
  LIVE_CLIENTS.clear();
  try { if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections(); } catch { /* ignore */ }
  setTimeout(() => {
    try { flushDeferredWrites(); } catch { /* ignore */ }
    log('排水超时，强制退出');
    process.exit(0);
  }, 3_000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => gracefulShutdown(sig));
