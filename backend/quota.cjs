'use strict';
const crypto = require('node:crypto');
const keyId = entry => entry.id || 'key_' + crypto.createHash('sha256').update(entry.key).digest('hex').slice(0, 24);
function resolveKey(entries, body) {
  if (body.id) return entries.find(e => keyId(e) === body.id) || null;
  const tail = String(body.tail || '').trim();
  if (tail.length < 4) return null;
  const matches = entries.filter(e => e.key.endsWith(tail));
  if (matches.length > 1) { const error = new Error('密钥尾号重复，请刷新页面后使用唯一 ID'); error.status = 409; throw error; }
  return matches[0] || null;
}
// Request limits are hard admission limits. Token/credit limits are settlement
// thresholds: serialize limited keys so only one request can overshoot a threshold.
function createQuotaLedger(today) {
  const buckets = new WeakMap();
  const bucket = (entry, day) => {
    if (!buckets.has(entry)) buckets.set(entry, new Map());
    const days = buckets.get(entry);
    if (!days.has(day)) days.set(day, { pending: 0 });
    return days.get(day);
  };
  const usage = (entry, day) => entry.usage?.date === day ? entry.usage : { requests: 0, tokens: 0, credit: 0 };
  return {
    check(ctx, model) {
      const e = ctx?.restrictions; if (!e) return null;
      if (e.models?.length && !e.models.includes(String(model || ''))) return { status: 403, message: `该 key 仅允许使用模型: ${e.models.join(', ')}` };
      const day = today(), u = usage(e, day);
      const own = ctx.reservation && !ctx.reservation.settled && ctx.reservation.day === day ? 1 : 0;
      const pending = (buckets.get(e)?.get(day)?.pending || 0) - own;
      if (e.dailyLimit && u.requests + pending >= e.dailyLimit) return { status: 429, message: '该 key 今日请求额度已用尽或已被在途请求预占' };
      if (e.dailyTokenLimit && u.tokens >= e.dailyTokenLimit) return { status: 429, message: '该 key 今日 Token 停用阈值已达到' };
      if (e.dailyCreditLimit && u.credit >= e.dailyCreditLimit) return { status: 429, message: '该 key 今日积分停用阈值已达到' };
      if ((e.dailyTokenLimit || e.dailyCreditLimit) && pending > 0) return { status: 429, message: '该 key 正在结算上一请求的用量，请稍后重试' };
      return null;
    },
    reserve(ctx, model) {
      const error = this.check(ctx, model); if (error) return error;
      if (!ctx?.restrictions) return null;
      const day = today(); bucket(ctx.restrictions, day).pending++;
      ctx.reservation = { day, started: false, settled: false };
      return null;
    },
    settle(ctx, tokens = 0, credit = 0) {
      const e = ctx?.restrictions, r = ctx?.reservation;
      if (!e || !r || r.settled) return false;
      r.settled = true;
      const b = bucket(e, r.day); b.pending = Math.max(0, b.pending - 1);
      if (!b.pending) buckets.get(e).delete(r.day);
      if (!r.started || r.day !== today()) return false;
      if (e.usage?.date !== r.day) e.usage = { date: r.day, requests: 0, tokens: 0, credit: 0 };
      e.usage.requests = (Number(e.usage.requests) || 0) + 1;
      e.usage.tokens = (Number(e.usage.tokens) || 0) + Math.max(0, Number(tokens) || 0);
      e.usage.credit = Math.round(((Number(e.usage.credit) || 0) + Math.max(0, Number(credit) || 0)) * 1000) / 1000;
      return true;
    },
  };
}
module.exports = { keyId, resolveKey, createQuotaLedger };
