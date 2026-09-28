'use strict';
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);
const options = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } };
function pickCompression(headers) {
  const quality = new Map(String(headers['accept-encoding'] || '').toLowerCase().split(',').map(part => {
    const [name, ...params] = part.trim().split(';');
    const q = params.find(p=>p.trim().startsWith('q='));
    return [name, q ? Number(q.trim().slice(2)) : 1];
  }));
  const q = name => quality.has(name) ? quality.get(name) : quality.get('*') || 0;
  if (q('br') > 0 && q('br') >= q('gzip')) return 'br';
  return q('gzip') > 0 ? 'gzip' : null;
}
function createCompression(html) {
  const input = Buffer.from(html);
  // Fixed HTML is encoded once, never on the request event loop.
  const staticCache = { br: brotli(input, options), gzip: gzip(input) };
  for (const value of Object.values(staticCache)) value.catch(() => {});
  return { pickCompression, async pack(buffer, encoding) {
    if (buffer.equals(input)) return staticCache[encoding];
    return encoding === 'br' ? brotli(buffer, options) : gzip(buffer);
  } };
}
module.exports = { createCompression, pickCompression };
