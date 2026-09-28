'use strict';

const { version } = require('./project-version.json');
const repository = 'https://github.com/wyy667/workbuddy2API';
const manifestUrl = 'https://raw.githubusercontent.com/wyy667/workbuddy2API/main/backend/project-version.json';

function compareVersions(a, b) {
  const valid = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
  if (!valid.test(a) || !valid.test(b)) throw new Error('版本信息格式无效');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

function createProjectUpdates({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let cached = null, flight = null;
  const info = () => ({ ok: true, version, repository, updateGuide: repository + '/blob/main/README-deploy.md#8-升级现有服务' });
  async function check() {
    if (cached && now() - cached.checkedAt < 60000) return cached;
    if (flight) return flight;
    flight = (async () => {
      try {
        const response = await fetchImpl(manifestUrl, {
          headers: { Accept: 'application/json', 'User-Agent': 'workbuddy2API-update-check' },
          signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        if (!response.ok) throw new Error('GitHub 暂时不可用');
        // Bound the body as well as the request time; never execute remote content.
        const reader = response.body.getReader();
        let content = '', size = 0;
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4096) throw new Error('版本信息过大');
            content += decoder.decode(value, { stream: true });
          }
          content += decoder.decode();
        } finally { await reader.cancel().catch(() => {}); }
        const latestVersion = JSON.parse(content).version;
        if (typeof latestVersion !== 'string') throw new Error('版本信息缺失');
        const comparison = compareVersions(latestVersion, version);
        cached = { ...info(), latestVersion, status: comparison > 0 ? 'available' : comparison < 0 ? 'ahead' : 'current', checkedAt: now() };
      } catch {
        cached = { ...info(), status: 'error', checkedAt: now(), message: '无法获取 GitHub 版本信息，请检查服务器网络后重试。' };
      }
      return cached;
    })();
    try { return await flight; } finally { flight = null; }
  }
  return { info, check };
}

module.exports = { createProjectUpdates, compareVersions };
