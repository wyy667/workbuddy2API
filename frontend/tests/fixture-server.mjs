// Isolated visual/contract fixture. Never used by the production build.
import http from "node:http";
import { createRequire } from "node:module";
const serveAssets = createRequire(import.meta.url)("../../backend/admin-assets.cjs").createAdminAssets(fileURLToPath(new URL("../../admin-ui/", import.meta.url)));
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const port = Number(process.env.FIXTURE_PORT || 8950),
  today = "2026-09-27",
  now = Date.parse(today + "T14:30:00+08:00");
const requests = [],
  streams = new Set();
const mapStreams = new Set();
let mapSeq = 0;
const mapLocation = (country, region, lat, lon) => ({country,region,label:country+' · '+region,lat,lon,precision:'省 / 州级估算'});
const mapOrigin = {ip:'220.167.103.215',kind:'源站',status:'已定位',location:mapLocation('中国','四川省',31.12,104.39)};
let mapRows = [];
function setMap(count=5) {
  const places=[mapLocation('中国','北京市',39.9,116.4),mapLocation('中国','广东省',23.1,113.3),mapLocation('中国','上海市',31.2,121.5),mapLocation('日本','东京都',35.6,139.6),mapLocation('新加坡','新加坡',1.35,103.82),null];
  mapRows=Array.from({length:count},(_,i)=>({id:'map-'+i,ip:i%6===5?'192.168.1.20':`8.8.${Math.floor(i/255)}.${i%255}`,model:['deepseek-v4','glm-5','minimax-m3','kimi-k3','hy4-preview'][i%5],stream:true,startedAt:Date.now()-35000-i*12000,keyName:i%2?'Studio 工作密钥':'开发工具',keyMasked:i%2?'sk-st…abcd':'sk-de…efgh',location:places[i%6],locationStatus:'内网或保留地址'}));
  mapSeq++;
}
const mapSnapshot=()=>({type:'snapshot',instance:'fixture-map',seq:mapSeq,now:Date.now(),origin:mapOrigin,database:{ready:true,updatedAt:Date.now(),error:''},requests:mapRows});
setMap();
const shift = (d, n) =>
  new Date(Date.parse(d + "T12:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
const names = [
  "claude-sonnet-4.6",
  "gpt-5.4",
  "gemini-3.1-pro",
  "deepseek-v4.1-flash",
  "hy4-preview",
  "kimi-k3",
  "qwen3.5-plus",
  "claude-opus-4.6",
  "gpt-5.4-mini",
  "glm-5.2",
  "minimax-m3-pay",
];
const makeUsage = (n, i = 0) => ({
  requests: n,
  total: n * (2350 + i * 100),
  prompt: n * 1850,
  completion: n * (500 + i * 100),
  cached: n * 1295,
  credit: Math.round(n * 0.83 * 100) / 100,
});
const accounts = Array.from({ length: 4 }, (_, i) => ({
  id: `account-${i}.json`,
  uid: `uid0000${i}`,
  nickname: ["小懿的主账号", "Studio 工作账号", "国际站账号", "每日签到专用"][
    i
  ],
  siteLabel: i === 2 ? "国际站" : "国内站",
  expiresSec: 20 * 86400 + i * 1000,
  refreshExpiresSec: 30 * 86400,
  expiresAt: now + 20 * 86400000,
  refreshExpiresAt: now + 30 * 86400000,
  active: i === 0,
  serving: i === 0,
  checkinOnly: i === 3,
  balance: [8420.5, 3260.8, 6180.3, 900][i],
  earliestExpire: now + 6 * 86400000,
  inflight: i === 0 ? 2 : 0,
}));
const pool = [
  {
    ...accounts[3],
    id: "pool-0.json",
    uid: "pool0000",
    nickname: "观察中的账号",
    flag403: true,
    flag403DaysLeft: 5,
    flag403At: now - 2 * 86400000,
    serving: false,
    active: false,
  },
];
const daysRaw = {},
  hoursRaw = {},
  accountDaysRaw = {};
function scaleMap(map, factor) {
  return Object.fromEntries(
    Object.entries(map).map(([m, v]) => [
      m,
      Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, Math.round(x * factor)]),
      ),
    ]),
  );
}
for (let j = 30; j >= 0; j--) {
  const d = shift(today, -j);
  daysRaw[d] = Object.fromEntries(
    names
      .slice(0, 5)
      .map((m, i) => [
        m,
        makeUsage(
          Math.round(
            (40 + i * 17) * (1 + Math.sin(j * 0.7 + i) * 0.5) + (30 - j) * 4,
          ),
          i,
        ),
      ]),
  );
  daysRaw[d]["opencode/qwen3-coder"] = makeUsage(30 + j);
  daysRaw[d]["qoder/lite"] = makeUsage(20 + j);
  for (let h = 0; h < 24; h++) {
    if (j === 0 && h > 14) break;
    const models = scaleMap(
      daysRaw[d],
      (0.25 + Math.abs(Math.sin(h * 0.3))) / 16,
    );
    hoursRaw[d + "T" + String(h).padStart(2, "0")] = {
      models,
      accounts: Object.fromEntries(
        accounts.map((a, i) => [a.uid, scaleMap(models, 1 / (i + 2))]),
      ),
    };
  }
}
const aggregate = (maps) => {
  const o = {};
  for (const map of maps)
    for (const [m, v] of Object.entries(map)) {
      const x = (o[m] ||= {});
      for (const [k, n] of Object.entries(v)) x[k] = (x[k] || 0) + n;
    }
  return o;
};
for (const [i, a] of accounts.entries())
  accountDaysRaw[a.uid] = {
    name: a.nickname,
    days: Object.fromEntries(
      Object.entries(daysRaw).map(([d, mm]) => [d, scaleMap(mm, 1 / (i + 2))]),
    ),
  };
let providers = [
  {
    id: "ext_open",
    type: "opencode",
    prefix: "opencode",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    enabled: true,
    models: [],
    modelMap: {},
    knownModels: ["qwen3-coder", "kimi-k2.5-free"],
    note: "研发团队免费模型",
    credsSummary: { anonymous: true },
    modelsFetchedAt: now,
  },
  {
    id: "ext_trae",
    type: "trae",
    prefix: "trae",
    name: "Trae SOLO",
    baseUrl: "https://api.trae.cn",
    enabled: true,
    models: ["auto"],
    modelMap: {},
    knownModels: ["auto"],
    note: "国内站账号",
    credsSummary: { realm: "cn", hasRefresh: true },
    traeLoginUrl: "https://example.com/authorization",
  },
  {
    id: "ext_qoder",
    type: "qoder",
    prefix: "qoder",
    name: "Qoder Studio",
    baseUrl: "https://api3.qoder.sh",
    enabled: true,
    models: ["lite"],
    knownModels: ["lite"],
    modelMap: {},
    credsSummary: { hasPat: true, plan: "Pro" },
  },
];
let keys = [
  {
    name: "个人开发工具",
    id: "fixture-a001", tail: "a001",
    masked: "sk-••••••••a001",
    models: [],
    accounts: [],
    dailyLimit: 10000,
    dailyTokenLimit: 10000000,
    dailyCreditLimit: 500,
    disabled: false,
    usedToday: 826,
    tokensToday: 2186520,
    creditToday: 142.3,
    createdAt: now - 14 * 86400000,
  },
  {
    name: "Studio 团队共享",
    id: "fixture-b002", tail: "b002",
    masked: "sk-••••••••b002",
    models: ["claude-sonnet-4.6", "gpt-5.4"],
    accounts: ["uid00000"],
    dailyLimit: 2000,
    dailyTokenLimit: 5000000,
    dailyCreditLimit: 200,
    disabled: false,
    usedToday: 148,
    tokensToday: 628210,
    creditToday: 61.2,
    createdAt: now - 7 * 86400000,
  },
  {
    name: "实验项目",
    tail: "c003",
    masked: "sk-••••••••c003",
    models: [],
    accounts: [],
    dailyLimit: 0,
    dailyTokenLimit: 0,
    dailyCreditLimit: 0,
    disabled: true,
    usedToday: 0,
    tokensToday: 0,
    creditToday: 0,
    createdAt: now - 3 * 86400000,
  },
];
const recent = Array.from({ length: 26 }, (_, i) => ({
  t: now - i * 67000,
  model: names[i % 5],
  name: accounts[i % 3].nickname,
  uid8: accounts[i % 3].uid,
  ttft: 220 + i * 37,
  durMs: 1240 + i * 147,
  prompt: 2250 + i * 52,
  cached: 1520,
  completion: 870 + i * 20,
  credit: 2.35 + i * 0.15,
  finish: "stop",
  ...(i === 6 ? { err: "429", msg: "请求频率限制，请稍后重试" } : {}),
}));
const total = aggregate(Object.values(daysRaw)),
  week = aggregate(
    Object.entries(daysRaw)
      .filter(([d]) => d >= shift(today, -6))
      .map(([, v]) => v),
  );
const sumMap = (mm) =>
  Object.values(mm).reduce((o, v) => {
    for (const [k, n] of Object.entries(v)) o[k] = (o[k] || 0) + n;
    return o;
  }, {});
const usage = {
  todayDate: today,
  weekStart: shift(today, -6),
  today: daysRaw[today],
  week,
  total,
  firstAt: now - 30 * 86400000,
  daysRaw,
  hoursRaw,
  hourlySince: now - 25 * 86400000,
  serverNow: new Date(now).toISOString(),
  timezone: "Asia/Shanghai",
  accountDaysRaw,
  accounts: accounts.map((a) => ({ uid8: a.uid, name: a.nickname })),
  cross: accounts.map((a) => ({
    uid8: a.uid,
    name: a.nickname,
    models: Object.fromEntries(
      Object.entries(aggregate(Object.values(accountDaysRaw[a.uid].days))).map(
        ([m, v]) => [
          m,
          {
            total: v.total,
            today: accountDaysRaw[a.uid].days[today][m]?.total || 0,
            week: v.total / 4,
            reqAll: v.requests,
            reqT: 40,
            credit: v.credit,
            creditT: 22,
            cached: v.cached,
          },
        ],
      ),
    ),
  })),
};
let checkup = {
  ok: true,
  at: now,
  accounts,
  models: names.slice(0, 6),
  results: Object.fromEntries(
    accounts.flatMap((a, i) =>
      names.slice(0, 6).map((m, j) => [
        a.uid + "|" + m,
        {
          ok: !(i === 2 && j === 3),
          kind: i === 2 && j === 3 ? "capped" : "ok",
          msg: i === 2 && j === 3 ? "上游配额不足" : "",
        },
      ]),
    ),
  ),
};
let queue = {
  ok: true,
  running: false,
  startedAt: now - 90000,
  items: accounts.slice(0, 3).map((a) => ({
    id: a.id,
    status: "done",
    steps: [
      { name: "每日签到", ok: true, msg: "+100 积分" },
      { name: "成长任务", ok: true, msg: "任务完成" },
    ],
  })),
};
let settings = {
  pollMin: 30,
  paidRoute: "expire",
  keepaliveEveryDays: 7,
  keepaliveAt: "06:00",
  backupAt: "05:30",
  autoBackupLast: { at: now - 86400000 },
};
let rotation = { enabled: true, intervalMin: 30, nextAt: now + 25 * 60000 },
  servingOverride = null,
  loginCount = 0;
const allResults = () =>
  accounts.map((a) => ({
    id: a.id,
    ok: true,
    data: { credit: 100, signed: true, continueDays: 7 },
  }));
const statusData = (empty = false) => ({
  ok: true,
  now,
  uptimeSec: 485200,
  stats: { total: 24689, errors: 41, inflight: 2 },
  credential: { nickname: "小懿", expiresSec: 864000 },
  accounts: empty ? [] : accounts,
  pool: empty ? [] : pool,
  servingOverride,
  rotation,
  usage: empty
    ? { todayDate: today, daysRaw: {}, total: {}, today: {}, hoursRaw: {} }
    : usage,
  settings,
  checkin: {
    at: "08:30",
    lastRunDate: today,
    lastRunAt: now - 6 * 3600000,
    lastResults: empty ? [] : allResults(),
  },
  modelsDetail: empty
    ? []
    : names.map((id, i) => ({
        id,
        name: id,
        credits: i === 4 ? "0.00" : (i * 0.2 + 0.2).toFixed(2),
        tags: i === 4 ? ["夜间免费"] : i < 2 ? ["旗舰模型"] : ["高效推理"],
      })),
  modelsFetchedAt: now - 1800000,
  service: {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    baseUrlRoot: `http://127.0.0.1:${port}`,
    apiKeyMasked: "fixture-••••",
    apiKeyFull: "fixture-only-key",
    models: names,
  },
  apiKeys: empty ? [] : keys,
  recentRequests: empty ? [] : recent,
  logs: empty
    ? []
    : [
        { t: now, msg: `模型目录已更新，${names.length} 个原生模型可用` },
        { t: now - 20000, msg: "自动轮换完成，当前服务账号：小懿的主账号" },
        { t: now - 60000, msg: "每日签到完成：4 / 4 个账号成功" },
      ],
});
const baseline = structuredClone({
  accounts,
  pool,
  providers,
  keys,
  settings,
  rotation,
  queue,
  checkup,
});
const server = http.createServer(async (req, res) => {
  if (await serveAssets(req, res)) return;
  const url = new URL(req.url, "http://127.0.0.1"),
    p = url.pathname.replace("/admin/api", ""),
    key = url.searchParams.get("key") || req.headers["x-api-key"] || /(?:^|;\s*)fixture_admin=([^;]+)/.exec(req.headers.cookie || "")?.[1],
    empty = key === "empty";
  const send = (d, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(d));
  };
  if (url.pathname === "/__reset") {
    setMap();
    for(const s of mapStreams)s.write('data: '+JSON.stringify(mapSnapshot())+'\n\n');
    const b = structuredClone(baseline);
    accounts.splice(0, accounts.length, ...b.accounts);
    pool.splice(0, pool.length, ...b.pool);
    providers = b.providers;
    keys = b.keys;
    settings = b.settings;
    rotation = b.rotation;
    queue = b.queue;
    checkup = b.checkup;
    servingOverride = null;
    loginCount = 0;
    requests.length = 0;
    return send({ ok: true });
  }
  if (url.pathname === "/__requests") return send(requests);
  if (url.pathname === '/__map') {
    let raw='';for await(const chunk of req)raw+=chunk;
    const job=JSON.parse(raw||'{}');
    if(job.count!==undefined)setMap(job.count);
    if(job.requests){mapRows=job.requests;mapSeq++;}
    if(job.origin){Object.assign(mapOrigin,job.origin);mapSeq++;}
    for(const s of mapStreams){if(job.disconnect)s.end();else s.write('data: '+JSON.stringify(mapSnapshot())+'\n\n');}
    return send({ok:true});
  }
  if (url.pathname === "/__sse") {
    const row = {
      ...recent[0],
      t: Math.max(now + 1, Date.now()),
      model: "live-fixture-event",
    };
    for (const s of streams) s.write("data: " + JSON.stringify(row) + "\n\n");
    return send({ ok: true });
  }
  if (!url.pathname.startsWith("/admin/api/")) {
    res.writeHead(200, { "Content-Type": "text/html", ...(key ? {"Set-Cookie": `fixture_admin=${key}; Path=/admin; HttpOnly; SameSite=Strict`} : {}) });
    return res.end(
      fs.readFileSync(new URL("../../admin.html", import.meta.url)),
    );
  }
  if (!key || key === "invalid")
    return send({ ok: false, message: "管理密钥无效" }, 401);
  let body = {};
  if (req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return send({ ok: false, message: "invalid JSON" }, 400);
    }
  }
  requests.push({
    path: p,
    method: req.method,
    body,
    query: Object.fromEntries(url.searchParams),
  });
  if (p === '/request-map/settings') {
    settings.requestMapEnabled=body.enabled;
    if(!body.enabled)for(const s of mapStreams){s.write('data: '+JSON.stringify({type:'disabled',enabled:false})+'\n\n');s.end();}
    return send({ok:true,enabled:body.enabled});
  }
  if (p === '/request-map') return send({...mapSnapshot(),enabled:settings.requestMapEnabled!==false,requests:empty?[]:mapRows});
  if (p === '/request-map/live') {
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});
    res.write('data: '+JSON.stringify({...mapSnapshot(),requests:empty?[]:mapRows})+'\n\n');mapStreams.add(res);
    const timer=setInterval(()=>res.write('data: '+JSON.stringify({type:'heartbeat',instance:'fixture-map',seq:mapSeq})+'\n\n'),15000);
    res.on('close',()=>{clearInterval(timer);mapStreams.delete(res);});return;
  }
  if (p === "/live") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }
  if (p === "/status") { const data = statusData(empty); if (url.searchParams.get("detail") === "light") delete data.usage; return send(data); }
  if (p === "/usage") return send({ok:true,usage:statusData(empty).usage});
  if (p === "/metrics")
    return send({
      ok: true,
      uptimeSec: 485200,
      memory: { rss: 92 * 1024 * 1024 },
      requests: {
        total: 24689,
        errors: 41,
        errorRate: 0.00166,
        inflight: 2,
        reqPerMin: 12.4,
      },
      extProviders: 3,
      extCooling: [],
      blockedModels: [],
    });
  if (p === "/credits")
    return send({
      ok: true,
      accounts: empty
        ? []
        : accounts.map((a) => ({
            ...a,
            ok: true,
            totalLeft: a.balance,
            packs: [{ left: a.balance, expireAt: a.earliestExpire }],
          })),
    });
  if (p === "/checkup")
    return send(empty ? { ok: false, msg: "尚未体检" } : checkup);
  if (p === "/health/history")
    return send({
      ok: true,
      items: empty
        ? []
        : [
            {
              source: "account",
              account: "uid00002",
              model: "deepseek-v4.1-flash",
              lastCheck: now,
              ok: false,
              blocked: true,
              blockedUntil: now + 900000,
              msg: "额度暂时受限",
            },
            {
              source: "ext",
              provider: "opencode",
              model: "qwen3-coder",
              lastCheck: now,
              ok: true,
              latencyMs: 685,
            },
          ],
    });
  if (p === "/test")
    return send({
      ok: true,
      model: "hy4-preview",
      content: "ok",
      tokens: 5,
      ms: 368,
    });
  if (p === "/models/refresh")
    return send({
      ok: true,
      models: statusData().modelsDetail,
      count: names.length,
    });
  if (p === "/settings") {
    if (!(body.pollMin >= 5 && body.pollMin <= 1440))
      return send({ ok: false, message: "pollMin required" }, 400);
    Object.assign(settings, body);
    return send({ ok: true });
  }
  if (p === "/rotation/set") {
    if (![15, 30, 60, 120].includes(body.intervalMin))
      return send({ ok: false, message: "Invalid rotation" }, 400);
    Object.assign(rotation, body);
    return send({ ok: true });
  }
  if (p === "/rotation/now" || p === "/keepalive")
    return send({ ok: true, results: [{ ok: true, name: "完成" }] });
  if (p === "/login/start") {
    loginCount = 0;
    return send({
      ok: true,
      state: "fixture-state",
      authUrl: "https://example.com/authorize?fixture=1",
      expiresAt: Date.now() + 300000,
    });
  }
  if (p === "/login/poll") {
    loginCount++;
    return send(
      loginCount > 1
        ? { ok: true, status: "success" }
        : { ok: false, status: "pending" },
    );
  }
  if (p === "/account/switch") {
    accounts.forEach((a) => (a.serving = a.id === body.id));
    servingOverride = body.temporary ? { id: body.id } : null;
    return send({ ok: true });
  }
  if (p === "/account/restore-default") {
    accounts.forEach((a) => (a.serving = a.active));
    servingOverride = null;
    return send({ ok: true });
  }
  if (p === "/account/delete") {
    const i = accounts.findIndex((a) => a.id === body.id);
    if (i >= 0) accounts.splice(i, 1);
    else {
      const j = pool.findIndex((a) => a.id === body.id);
      if (j >= 0) pool.splice(j, 1);
    }
    return send({ ok: true });
  }
  if (p === "/account/refresh")
    return send({ ok: true, message: "token refreshed" });
  if (p.startsWith("/pool/")) {
    const i = pool.findIndex((a) => a.id === body.id);
    if (i >= 0) accounts.push({ ...pool.splice(i, 1)[0], flag403: false });
    return send({ ok: true });
  }
  if (p === "/checkin/all") return send({ ok: true, results: allResults() });
  if (p === "/checkin/status")
    return send({ ok: true, accounts: empty ? [] : allResults() });
  if (p === "/checkin") return send({ ok: true, data: { credit: 100 } });
  if (p === "/tasks/accounts")
    return send({ ok: true, accounts: empty ? [] : accounts });
  if (p === "/tasks/list")
    return send({
      ok: true,
      tasks: empty
        ? []
        : [
            {
              code: "chat",
              title: "与模型完成对话",
              current: 1,
              target: 3,
              credit: 50,
              autoKind: "chat",
              acceptStatus: "accepted",
            },
            {
              code: "daily",
              title: "完成每日探索",
              current: 1,
              target: 1,
              credit: 100,
              claimable: true,
            },
            {
              code: "explore",
              title: "探索更多模型",
              current: 5,
              target: 5,
              energy: 30,
              claimed: true,
            },
          ],
    });
  if (p === "/tasks/school")
    return send({ ok: true, data: { status: "活动进行中", days: 7 } });
  if (p === "/tasks/queue") {
    if (req.method === "POST") queue = { ...queue, running: false };
    return send(empty ? { ok: true, running: false, items: [] } : queue);
  }
  if (p.startsWith("/tasks/"))
    return send({
      ok: true,
      steps: [
        { name: "签到", ok: true, msg: "+100 积分" },
        { name: "成长", ok: true, msg: "完成" },
      ],
      results: [{ code: "chat", ok: true, message: "完成" }],
    });
  if (p === "/keys/create") {
    if (!Array.isArray(body.models) || !Array.isArray(body.accounts))
      return send({ ok: false, message: "missing permissions" }, 400);
    const k = {
      ...body,
      id: "fixture-created", tail: "test",
      masked: "sk-fixture-test",
      disabled: false,
      createdAt: now,
    };
    keys.push(k);
    return send({ ok: true, key: "sk-fixture-created-test", entry: k });
  }
  if (p === "/keys/update") {
    const k = keys.find((k) => k.tail === body.tail);
    if (k) Object.assign(k, body);
    return send({ ok: true });
  }
  if (p === "/keys/delete") {
    keys = keys.filter((k) => k.tail !== body.tail);
    return send({ ok: true });
  }
  if (p === "/ext/list")
    return send({ ok: true, providers: empty ? [] : providers });
  if (p === "/ext/save") {
    if (!body.type || !Array.isArray(body.models) || !body.modelMap)
      return send({ ok: false, message: "provider body incomplete" }, 400);
    let p = providers.find((p) => p.id === body.id);
    if (p) Object.assign(p, body);
    else {
      p = { ...body, id: "ext_" + Date.now(), knownModels: ["sample-model"] };
      providers.push(p);
    }
    if (p.type === "trae") {
      p.credsSummary = { realm: body.realm || "cn" };
      p.traeLoginUrl = "https://example.com/trae";
    }
    return send({ ok: true, provider: p });
  }
  if (p === "/ext/delete") {
    providers = providers.filter((p) => p.id !== body.id);
    return send({ ok: true });
  }
  if (p === "/ext/probe") return send({ ok: true, models: ["sample-model"] });
  if (p === "/ext/status") {
    const provider = providers.find((p) => p.id === url.searchParams.get("id"));
    return send({
      ok: true,
      provider,
      label: "OpenAI 兼容聚合服务",
      policy: { cooling: false },
      quota: {
        at: now,
        lines: [
          { k: "方案", v: "开发者方案" },
          { k: "可用额度", v: "8,420 积分" },
          { k: "本月使用", v: "24%" },
        ],
      },
      stat: {
        today: { total: 234890, requests: 216 },
        week: { total: 1246850, requests: 2410 },
        total: { total: 8376200, requests: 9180, cached: 1728600 },
      },
      models: (provider.models?.length
        ? provider.models
        : provider.knownModels || []
      ).map((name) => ({
        name,
        upstream: name,
        health: { ok: true, latencyMs: 682 },
        usage: { total: 146700 },
      })),
      recent: recent.slice(0, 3),
    });
  }
  if (p === "/ext/quota")
    return send({
      ok: true,
      quota: { at: now, lines: [{ k: "剩余额度", v: "8,400 积分" }] },
    });
  if (p === "/ext/test")
    return send({
      ok: true,
      result: { ok: true, latencyMs: 824, model: body.model },
    });
  if (p === "/backup/status")
    return send({
      ok: true,
      keep: 7,
      at: settings.backupAt,
      last: { at: now - 86400000 },
      files: empty
        ? []
        : [
            "codebuddy-backup-2026-09-27.json",
            "codebuddy-backup-2026-09-26.json",
            "codebuddy-backup-2026-09-25.json",
          ],
    });
  if (p === "/backup")
    return send({
      app: "codebuddy-proxy",
      accounts: { "fixture.json": { auth: { fixture: true } } },
      exportedAt: now,
    });
  if (p === "/backup/run") return send({ ok: true, at: now });
  if (p === "/restore")
    return send({
      ok: true,
      restored: Object.keys((body.payload || body).accounts || {}).length,
    });
  if (p === "/usage/export") {
    res.writeHead(200, { "Content-Type": "text/csv" });
    return res.end("date,model,requests\n2026-09-27,fixture,1");
  }
  send({ ok: false, message: "Unhandled fixture endpoint: " + p }, 404);
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Isolated fixture: http://127.0.0.1:${port}/admin?key=fixture`),
);
