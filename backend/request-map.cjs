'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { normalize, publicIP, clientIP } = require('./geo-ip.cjs');

function maskMapKey(key) {
  const value = String(key || '');
  return value.length >= 12 ? value.slice(0, 5) + '…' + value.slice(-4) : value.length > 2 ? '••••…' + value.slice(-2) : '••••';
}
function createGeoService(options = {}) {
  const disabled = process.env.CB_GEO_DISABLED === '1';
  const cache = new Map(), pending = new Map();
  let worker, serial = 0, closed = false, retry, updateTimer;
  const service = { status: { ready: false, updatedAt: 0, error: disabled ? '定位已禁用' : '正在加载本地地理库' }, changed: () => {}, lookup, close };
  function resolveAll() { for (const item of pending.values()) { clearTimeout(item.timer); item.resolve(null); } pending.clear(); }
  function start() {
    if (closed || disabled) return;
    try {
      worker = new Worker(path.join(__dirname, 'geo-worker.cjs'), { workerData: { file: process.env.CB_GEO_DB || path.resolve(__dirname, '../data/dbip-city-lite.mmdb'), autoUpdate: process.env.CB_GEO_AUTO_UPDATE !== '0' } });
      worker.on('message', message => {
        if (message.type === 'status') { service.status = message.status; cache.clear(); service.changed(); }
        if (message.type === 'result') {
          const item = pending.get(message.id); if (!item) return;
          pending.delete(message.id); clearTimeout(item.timer);
          if (cache.size >= 4096) cache.delete(cache.keys().next().value);
          cache.set(item.ip, { location: message.location, until: Date.now() + (message.location ? 86400000 : 60000) });
          item.resolve(message.location);
        }
      });
      worker.on('error', () => { service.status = { ...service.status, ready: false, error: '定位进程暂时不可用' }; service.changed(); });
      worker.on('exit', () => { worker = null; resolveAll(); if (!closed) { retry = setTimeout(start, 60000); retry.unref(); } });
      worker.unref();
    } catch { service.status.error = '定位进程启动失败'; }
  }
  function lookup(ip) {
    if (closed || !publicIP(ip) || !worker || !service.status.ready) return Promise.resolve(null);
    const hit = cache.get(ip); if (hit?.until > Date.now()) return Promise.resolve(hit.location);
    for (const item of pending.values()) if (item.ip === ip) return item.promise;
    if (pending.size >= 1024) return Promise.resolve(null);
    const id = ++serial;
    let resolve; const promise = new Promise(done => { resolve = done; });
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, 5000); timer.unref();
    pending.set(id, { ip, resolve, promise, timer });
    try { worker.postMessage({ type: 'lookup', ip, id }); } catch { clearTimeout(timer); pending.delete(id); resolve(null); }
    return promise;
  }
  function close() { closed = true; clearTimeout(retry); clearInterval(updateTimer); resolveAll(); cache.clear(); return worker?.terminate(); }
  start();
  if (!disabled && process.env.CB_GEO_AUTO_UPDATE !== '0') { updateTimer = setInterval(() => worker?.postMessage({ type: 'update' }), 86400000); updateTimer.unref(); }
  return service;
}

function createRequestMap(options = {}) {
  const geo = options.geo || createGeoService();
  const active = new Map(), clients = new Set(), blocked = new WeakSet();
  const instance = crypto.randomUUID(); let seq = 0, closed = false;
  let origin = { ip: '', kind: '源站', location: null, status: '正在识别源站' };
  const ranges = (options.trustedProxies ?? process.env.CB_TRUSTED_PROXIES ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const snapshot = () => ({ instance, seq, now: Date.now(), origin, database: geo.status, requests: [...active.values()] });
  function write(res, value) {
    try {
      if (res.destroyed || res.writableLength > 262144 || blocked.has(res)) { clients.delete(res); res.destroy(); return; }
      if (!res.write('data: ' + JSON.stringify(value) + '\n\n')) { blocked.add(res); res.once('drain', () => blocked.delete(res)); }
    } catch { clients.delete(res); res.destroy(); }
  }
  function broadcast(type, data) { const message = { instance, seq: ++seq, type, ...data }; for (const res of clients) write(res, message); }
  async function locate(row) {
    const location = await geo.lookup(row.ip).catch(() => null);
    if (closed || !active.has(row.id)) return;
    row.location = location;
    row.locationStatus = location ? '已定位' : publicIP(row.ip) ? '暂无法定位' : '内网或保留地址';
    broadcast('upsert', { request: row });
  }
  async function locateOrigin() {
    const ip = origin.ip;
    const location = ip ? await geo.lookup(ip).catch(() => null) : null;
    if (closed || ip !== origin.ip) return;
    origin = { ...origin, location, status: location ? '已定位' : ip ? '暂无法定位' : '未识别到公网地址' };
    broadcast('origin', { origin, database: geo.status });
  }
  async function discoverOrigin() {
    const explicit = normalize(options.originIP ?? process.env.CB_ORIGIN_IP);
    if (publicIP(explicit)) origin = { ...origin, ip: explicit, kind: '源站' };
    else {
      const candidates = [...new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map(x => normalize(x.address)).filter(publicIP))];
      if (candidates.length === 1) origin = { ...origin, ip: candidates[0], kind: '源站' };
      else if (process.env.CB_GEO_DISABLED !== '1' && options.discover !== false) {
        try {
          const response = await fetch('https://api64.ipify.org?format=json', { signal: AbortSignal.timeout(8000), redirect: 'error' });
          const value = normalize((await response.json()).ip);
          if (publicIP(value)) origin = { ...origin, ip: value, kind: '公网出口' };
        } catch {}
      }
    }
    await locateOrigin();
  }
  geo.changed = () => { locateOrigin(); for (const row of active.values()) locate(row); };
  const ready = discoverOrigin();
  const originRetry = setInterval(() => { if (!origin.ip) discoverOrigin(); }, 900000); originRetry.unref();
  function begin(req, res, ctx, payload, masterKey = '') {
    const id = crypto.randomUUID();
    const row = { id, startedAt: Date.now(), ip: clientIP(req, ranges), model: String(payload.model || 'auto').slice(0, 200), stream: !!payload.stream, keyName: ctx.admin ? '主密钥' : ctx.name || '未命名密钥', keyMasked: maskMapKey(ctx.admin ? masterKey : ctx.key), location: null, locationStatus: '正在定位' };
    active.set(id, row); broadcast('upsert', { request: row }); locate(row);
    let finished = false;
    const end = () => {
      if (finished) return; finished = true;
      active.delete(id); res.off('close', end); res.off('finish', end); req.scope?.signal.removeEventListener('abort', end);
      broadcast('remove', { id });
    };
    res.once('close', end); res.once('finish', end); req.scope?.signal.addEventListener('abort', end, { once: true });
    if (res.destroyed || res.writableEnded || req.scope?.signal.aborted) end();
    return end;
  }
  function subscribe(req, res) {
    if (clients.size >= 32) { res.writeHead(503, { 'Retry-After': '10' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    clients.add(res); write(res, { type: 'snapshot', ...snapshot() });
    const timer = setInterval(() => write(res, { type: 'heartbeat', instance, seq, now: Date.now() }), 15000); timer.unref();
    res.once('close', () => { clearInterval(timer); clients.delete(res); });
  }
  return { begin, snapshot, subscribe, ready, close() { closed = true; clearInterval(originRetry); broadcast('disabled', {enabled:false}); for (const res of clients) res.end(); clients.clear(); active.clear(); return geo.close(); } };
}
function createRequestMapController(options = {}) {
  let engine = options.enabled === false ? null : createRequestMap(options.engineOptions), transition = Promise.resolve();
  const instance = crypto.randomUUID(); let seq = 0;
  return {
    begin(...args) { return engine?.begin(...args); },
    snapshot() { return engine ? { ...engine.snapshot(), enabled:true } : { enabled:false, instance, seq, now:Date.now(), requests:[], origin:null, database:{ready:false,error:'地图已关闭'} }; },
    subscribe(req,res) { if(engine) return engine.subscribe(req,res);res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.end('data: '+JSON.stringify({type:'disabled',enabled:false})+'\n\n'); },
    setEnabled(enabled) { transition = transition.then(async()=>{ if(enabled && !engine)engine=createRequestMap(options.engineOptions); else if(!enabled && engine){const previous=engine;engine=null;seq++;await previous.close();} });return transition; },
    close() { const previous=engine;engine=null;return previous?.close(); },
  };
}
module.exports = { createRequestMap, createRequestMapController, maskMapKey, createGeoService };
