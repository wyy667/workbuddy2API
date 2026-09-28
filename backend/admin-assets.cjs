'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pickCompression } = require('./compression.cjs');
const types = {js:'application/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml',png:'image/png',webp:'image/webp',woff2:'font/woff2'};
// Public build artifacts only. No credentials or runtime data are stored here.
function createAdminAssets(root) {
  return async function serve(req, res) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (!pathname.startsWith('/admin-ui/')) return false;
    const match = /^\/admin-ui\/assets\/([A-Za-z0-9_-]+\.(js|css|svg|png|webp|woff2))$/.exec(pathname);
    if (!match || !['GET','HEAD'].includes(req.method)) { res.writeHead(404); res.end(); return true; }
    const file = path.join(root, 'assets', match[1]);
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) throw Error('not a file');
      let selected = file, encoding = pickCompression(req.headers);
      if (encoding) {
        const packed = file + (encoding === 'br' ? '.br' : '.gz');
        try { await fs.promises.access(packed); selected = packed; } catch { encoding = null; }
      }
      const size = (await fs.promises.stat(selected)).size;
      const headers = {'Content-Type':types[match[2]], 'Content-Length':size, 'Cache-Control':'public, max-age=31536000, immutable', 'Vary':'Accept-Encoding', 'X-Content-Type-Options':'nosniff'};
      if (encoding) headers['Content-Encoding'] = encoding;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') res.end();
      else {
        const stream = fs.createReadStream(selected);
        res.once('close', () => stream.destroy());
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      }
    } catch { res.writeHead(404, {'Cache-Control':'no-store'}); res.end(); }
    return true;
  };
}
module.exports = { createAdminAssets };
