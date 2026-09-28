'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function createPersistence(log) {
  const errors = new Map();
  function report(file, error) {
    const now = Date.now(), last = errors.get(file);
    errors.set(file, { at: now, code: error.code || 'WRITE_FAILED', count: (last?.count || 0) + 1, loggedAt: last?.loggedAt || 0 });
    if (!last || now - last.loggedAt >= 60000) {
      errors.get(file).loggedAt = now;
      log(`[storage] ${path.basename(file)} 写入失败 (${error.code || 'WRITE_FAILED'})`);
    }
  }
  const failure = (file, error) => {
    report(file, error);
    const wrapped = new Error(`无法保存 ${path.basename(file)}，请检查服务器存储状态`);
    wrapped.cause = error; wrapped.code = 'PERSISTENCE_FAILED'; wrapped.status = 503;
    return wrapped;
  };
  const tempOf = file => file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  // 每个文件的写版本：任何写入（同步或异步）开始时 +1。异步写在 rename 前核对版本，
  // 若期间已有更新的写入（例如管理台同步写），放弃这次旧快照，绝不以旧覆盖新。
  const versions = new Map();
  const bump = file => { const v = (versions.get(file) || 0) + 1; versions.set(file, v); return v; };
  // compact: 大体积高频文件（如用量统计）不缩进，体积与序列化耗时都显著下降
  function write(file, value, { compact = false } = {}) {
    bump(file);
    const temp = tempOf(file);
    try {
      fs.writeFileSync(temp, compact ? JSON.stringify(value) : JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, file); errors.delete(file);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw failure(file, error);
    }
  }
  function writeBatch(entries) {
    const staged = [], committed = [];
    try {
      for (const [file, value] of entries) {
        bump(file);
        const temp = tempOf(file), previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
        staged.push({ file, temp, previous });
        fs.writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
      }
      for (const item of staged) { fs.renameSync(item.temp, item.file); committed.push(item); errors.delete(item.file); }
    } catch (error) {
      for (const item of committed.reverse()) {
        try {
          if (item.previous === null) fs.unlinkSync(item.file);
          else { fs.writeFileSync(item.temp, item.previous, {mode:0o600}); fs.renameSync(item.temp,item.file); }
        } catch (rollbackError) { report(item.file, rollbackError); }
      }
      throw failure(staged.at(-1)?.file || 'backup', error);
    } finally { for (const item of staged) { try { fs.unlinkSync(item.temp); } catch {} } }
  }
  // 异步原子写：序列化在调用时同步完成（快照当下状态），磁盘 I/O 不占事件循环。
  // 同一文件的写入串行执行，后写的一定覆盖先写的。
  const chains = new Map();
  function writeAsync(file, value, { compact = true } = {}) {
    const text = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
    const version = bump(file);
    const prev = chains.get(file) || Promise.resolve();
    const task = prev.catch(() => {}).then(async () => {
      if (versions.get(file) !== version) return; // 已被更新的写入取代
      const temp = tempOf(file);
      try {
        await fs.promises.writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
        // 版本检查与 rename 必须在同一事件循环片段内完成：用同步 rename（仅元数据操作，开销极小），
        // 保证不会与管理台的同步写交错；await 期间若已有更新写入，放弃旧快照
        if (versions.get(file) !== version) { await fs.promises.unlink(temp).catch(() => {}); return; }
        fs.renameSync(temp, file); errors.delete(file);
      } catch (error) {
        try { await fs.promises.unlink(temp); } catch {}
        throw failure(file, error);
      }
    });
    chains.set(file, task);
    task.catch(() => {}).finally(() => { if (chains.get(file) === task) chains.delete(file); });
    return task;
  }
  // 停机前等待在途异步写完成
  function drain() { return Promise.allSettled([...chains.values()]); }
  return { write, writeBatch, writeAsync, drain, report, status: () => [...errors].map(([file, e]) => ({ file: path.basename(file), ...e })) };
}
module.exports = { createPersistence };
