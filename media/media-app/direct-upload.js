// direct-upload.js — Cloudflare-free upload endpoint for whitelisted HOMEKONG users
// Listens on port 8087 (router forward) at direct.homekong.cc
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8088;
const ROOT = '/srv';
const MAX_SIZE = 50 * 1024 * 1024 * 1024; // 50 GB
const DIRECT_USERS = ['lkcwesley', 'noah_'];

function decodeJwt(t) {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64').toString('utf8')); }
  catch (e) { return null; }
}

function safe(rel) {
  const clean = path.posix.normalize('/' + String(rel || '').replace(/\\/g, '/')).replace(/^\/+/, '');
  if (clean.split('/').some(s => s === '..')) return null;
  const abs = path.join(ROOT, clean);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

function log(...a) { console.log(new Date().toISOString(), ...a); }

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Auth',
    });
    return res.end();
  }

  const url = new URL(req.url, 'http://x');
  const token = req.headers['x-auth'] || url.searchParams.get('auth') || '';

  try {
    if (req.method === 'POST' && url.pathname === '/upload') {
      const jwt = decodeJwt(token);
      const user = jwt?.user?.username;

      if (!user || !DIRECT_USERS.includes(user)) {
        log('REJECT', user || 'unknown', req.socket.remoteAddress);
        return json(res, 403, { error: 'not whitelisted' });
      }

      const destPath = url.searchParams.get('path');
      if (!destPath) return json(res, 400, { error: 'missing path parameter' });

      const finalPath = safe(destPath);
      if (!finalPath) return json(res, 400, { error: 'invalid path' });

      const dir = path.dirname(finalPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const tempPath = finalPath + '.upload-' + crypto.randomBytes(8).toString('hex');
      const writeStream = fs.createWriteStream(tempPath);
      let size = 0;
      let aborted = false;

      req.on('data', chunk => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_SIZE) {
          aborted = true;
          req.destroy();
          writeStream.destroy();
          try { fs.unlinkSync(tempPath); } catch (_) {}
          log('TOO-BIG', user, destPath, (size / 1048576).toFixed(1) + 'MB');
          return json(res, 413, { error: 'file too large' });
        }
        writeStream.write(chunk);
      });

      req.on('end', () => {
        if (aborted) return;
        writeStream.end(() => {
          try {
            if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
            fs.renameSync(tempPath, finalPath);
            try { fs.chownSync(finalPath, 1000, 1000); } catch (_) {}
            log('DONE', user, destPath, (size / 1048576).toFixed(1) + 'MB');
            return json(res, 200, { ok: true, path: destPath, size });
          } catch (e) {
            log('FAIL', user, destPath, e.message);
            try { fs.unlinkSync(tempPath); } catch (_) {}
            return json(res, 500, { error: 'write failed: ' + e.message });
          }
        });
      });

      req.on('error', (e) => {
        if (aborted) return;
        aborted = true;
        writeStream.destroy();
        try { fs.unlinkSync(tempPath); } catch (_) {}
        log('ERROR', user, destPath, e.message);
      });

      return;
    }

    if (url.pathname === '/health') return json(res, 200, { ok: true, users: DIRECT_USERS });
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    log('CRASH', req.url, e.message);
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => log('direct-upload listening on', PORT));
