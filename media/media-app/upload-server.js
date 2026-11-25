// upload-server.js — chunked upload sidecar for HOMEKONG media (media.homekong.cc)
// Large files (> Cloudflare Business 200MB request-body cap) can't use the single-POST
// filebrowser path, so the browser slices them into 64MB chunks and this service
// reassembles them. It mounts the SAME /srv as filebrowser, so finished files appear
// directly in the file browser. Auth piggybacks on filebrowser's own JWT.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3007;
const ROOT = '/srv';
const FB = 'http://filebrowser-app:8080';
const CHUNK = 64 * 1024 * 1024;            // 64 MiB per chunk (well under CF 200MB cap)
const MAX_SIZE = 50 * 1024 * 1024 * 1024;  // 50 GB hard ceiling (matches nginx)
const SESSION_TTL = 60 * 60 * 1000;        // abandon idle sessions after 1h

const sessions = new Map(); // id -> {fd,size,partPath,finalPath,received,idx:Set,user,last,chunk}

function decodeJwt(t) {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64').toString('utf8')); }
  catch (e) { return null; }
}

// Prove the token is genuine by asking filebrowser to honor it (validates signature).
function fbValidate(token) {
  return new Promise(resolve => {
    const req = http.request(FB + '/api/resources/', { method: 'GET', headers: { 'X-Auth': token } }, r => {
      r.resume();
      resolve(r.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Resolve a client-supplied path to an absolute path inside ROOT, or null if it escapes.
function safe(rel) {
  const clean = path.posix.normalize('/' + String(rel || '').replace(/\\/g, '/')).replace(/^\/+/, '');
  if (clean.split('/').some(s => s === '..')) return null;
  const abs = path.join(ROOT, clean);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}
function log(...a) { console.log(new Date().toISOString(), ...a); }

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []; let len = 0;
    req.on('data', c => { len += c.length; if (len > limit) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function cleanupStale() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.last > SESSION_TTL) {
      try { fs.closeSync(s.fd); } catch (e) {}
      try { fs.unlinkSync(s.partPath); } catch (e) {}
      sessions.delete(id);
    }
  }
}
setInterval(cleanupStale, 5 * 60 * 1000).unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/upload-api/, '') || '/';
  const token = req.headers['x-auth'] || url.searchParams.get('auth') || '';

  try {
    // ---- INIT: open a session, validate auth + destination once ----
    if (req.method === 'POST' && p === '/init') {
      if (!(await fbValidate(token))) return json(res, 401, { error: 'unauthorized' });
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
      const size = Number(body.size);
      if (!body.path || !Number.isFinite(size) || size < 0 || size > MAX_SIZE)
        return json(res, 400, { error: 'bad path or size' });
      const finalPath = safe(body.path);
      if (!finalPath) return json(res, 400, { error: 'invalid path' });
      const dir = path.dirname(finalPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(finalPath) && !body.overwrite)
        return json(res, 409, { error: 'exists' });
      const id = crypto.randomBytes(16).toString('hex');
      const partPath = path.join(dir, '.upload-' + id + '.part');
      const fd = fs.openSync(partPath, 'w');
      const jwt = decodeJwt(token) || {};
      const user = (jwt.user && jwt.user.username) || '?';
      sessions.set(id, {
        fd, size, partPath, finalPath, received: 0, idx: new Set(),
        user, last: Date.now(), chunk: CHUNK,
      });
      log('INIT', user, finalPath, (size / 1048576).toFixed(1) + 'MB', 'id=' + id.slice(0, 8));
      return json(res, 200, { id, chunkSize: CHUNK });
    }

    // ---- CHUNK: write one slice at its byte offset ----
    if (req.method === 'POST' && p === '/chunk') {
      const id = url.searchParams.get('id');
      const index = parseInt(url.searchParams.get('index'), 10);
      const s = sessions.get(id);
      if (!s) return json(res, 404, { error: 'no session' });
      if (!Number.isInteger(index) || index < 0) return json(res, 400, { error: 'bad index' });
      const buf = await readBody(req, s.chunk + 1024);
      const offset = index * s.chunk;
      if (offset + buf.length > s.size) return json(res, 400, { error: 'overflow' });
      fs.writeSync(s.fd, buf, 0, buf.length, offset);
      if (!s.idx.has(index)) { s.idx.add(index); s.received += buf.length; }
      s.last = Date.now();
      return json(res, 200, { ok: true, received: s.received });
    }

    // ---- COMPLETE: fsync, verify size, atomic rename into place ----
    if (req.method === 'POST' && p === '/complete') {
      const id = url.searchParams.get('id');
      const s = sessions.get(id);
      if (!s) return json(res, 404, { error: 'no session' });
      if (s.received !== s.size) {
        log('INCOMPLETE', s.user, s.finalPath, 'got', s.received, 'of', s.size);
        return json(res, 400, { error: 'incomplete', received: s.received, expected: s.size });
      }
      fs.fsyncSync(s.fd); fs.closeSync(s.fd);
      try {
        if (fs.existsSync(s.finalPath)) fs.unlinkSync(s.finalPath);
        fs.renameSync(s.partPath, s.finalPath);
        try { fs.chownSync(s.finalPath, 1000, 1000); } catch (_) {} // match filebrowser's uid
      } catch (e) {
        log('ASSEMBLE-FAIL', s.user, s.finalPath, e.message);
        try { fs.unlinkSync(s.partPath); } catch (_) {}
        sessions.delete(id);
        return json(res, 500, { error: 'assemble failed: ' + e.message });
      }
      sessions.delete(id);
      log('DONE', s.user, s.finalPath, (s.size / 1048576).toFixed(1) + 'MB');
      return json(res, 200, { ok: true, path: s.finalPath.replace(ROOT, '') });
    }

    // ---- ABORT: drop session + partial file ----
    if (req.method === 'POST' && p === '/abort') {
      const id = url.searchParams.get('id');
      const s = sessions.get(id);
      if (s) {
        try { fs.closeSync(s.fd); } catch (e) {}
        try { fs.unlinkSync(s.partPath); } catch (e) {}
        sessions.delete(id);
      }
      return json(res, 200, { ok: true });
    }

    if (p === '/health') return json(res, 200, { ok: true, sessions: sessions.size });
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    log('ERROR', p, e.message);
    return json(res, e.message === 'too big' ? 413 : 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log('upload-service listening on ' + PORT));

