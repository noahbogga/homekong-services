const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const httpProxy = require('http-proxy');

const PORT = 3001;
const DIRECT_PORT = 8443;
const HK_BACKEND = 'http://guacamole:8080';
const LOG_FILE = path.join(__dirname, 'sessions.log');
const CERT_PATH = '/certs/fullchain.pem';
const KEY_PATH = '/certs/privkey.pem';

const streamTokens = new Map();

const sessions = new Map();
const pendingLogins = new Map();

const loginAttempts = new Map();
const BF_MAX_ATTEMPTS = 10;
const BF_WINDOW_MS = 300000;
const BF_BLOCK_MS = 120000;
const TRUSTED_NETS = ['192.168.50.', '116.49.242.', '218.102.194.'];

const proxy = httpProxy.createProxyServer({ target: HK_BACKEND, ws: true, changeOrigin: true });
proxy.on('error', (err, req, res) => {
  if (res && res.writeHead) { res.writeHead(502); res.end('Backend unavailable'); }
});

function genId() { return crypto.randomBytes(16).toString('hex'); }
function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
}
function logSession(entry) {
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
  fs.appendFile(LOG_FILE, line, () => {});
}
function isTrusted(ip) { return TRUSTED_NETS.some(n => ip.startsWith(n)); }
function checkBruteForce(ip) {
  if (isTrusted(ip)) return false;
  const now = Date.now();
  let r = loginAttempts.get(ip);
  if (!r) { r = { count: 0, first: now, blocked: 0 }; loginAttempts.set(ip, r); }
  if (r.blocked > now) return true;
  if (now - r.first > BF_WINDOW_MS) { r.count = 0; r.first = now; }
  return false;
}
function recordFail(ip) {
  const now = Date.now();
  let r = loginAttempts.get(ip) || { count: 0, first: now, blocked: 0 };
  r.count++;
  if (r.count >= BF_MAX_ATTEMPTS) {
    r.blocked = now + BF_BLOCK_MS;
    logSession({ event: 'brute_force_block', ip, attempts: r.count });
  }
  loginAttempts.set(ip, r);
}
function parseBody(req, maxBytes = 4096) {
  return new Promise(resolve => {
    let b = ''; let size = 0;
    req.on('data', c => { size += c.length; if (size > maxBytes) { b = ''; return; } b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  });
}
function getSessionFromReq(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/hk_session=([a-f0-9]{32})/);
  return m ? m[1] : null;
}
function getUaHash(req) {
  return crypto.createHash('sha256').update(req.headers['user-agent'] || '').digest('hex').slice(0, 16);
}
function validateSession(req) {
  const sessionId = getSessionFromReq(req);
  if (!sessionId || !sessions.has(sessionId)) return null;
  const s = sessions.get(sessionId);
  const ua = getUaHash(req);
  if (s.ua !== ua) {
    logSession({ event: 'session_mismatch', sessionId, user: s.user });
    sessions.delete(sessionId);
    return null;
  }
  s.lastActivity = Date.now();
  return { sessionId, session: s };
}
function hkAuth(username, password, totp) {
  return new Promise((resolve, reject) => {
    let body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    if (totp) body += `&guac-totp=${encodeURIComponent(totp)}`;
    const opts = {
      hostname: 'guacamole', port: 8080, path: '/guacamole/api/tokens',
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

function getLoginHtml() { return fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8'); }
function getDashHtml() { return fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'); }

const server = http.createServer(async (req, res) => {
  const ip = getClientIp(req);
  const url = new URL(req.url, 'http://localhost');

  // Login page
  if (url.pathname === '/' || url.pathname === '/login') {
    const v = validateSession(req);
    if (v) { res.writeHead(302, { Location: '/s/' + v.sessionId }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getLoginHtml());
    return;
  }

  // API: Create session
  if (url.pathname === '/api/session' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    if (checkBruteForce(ip)) {
      res.writeHead(429);
      res.end(JSON.stringify({ ok: false, error: 'Too many attempts. Try again later.' }));
      return;
    }
    const data = await parseBody(req);
    if (!data) { res.writeHead(400); res.end(JSON.stringify({ ok: false })); return; }

    // Step 2: TOTP verification (resend creds + code)
    if (data.pending_id && data.totp) {
      const pending = pendingLogins.get(data.pending_id);
      if (!pending || Date.now() - pending.created > 300000) {
        pendingLogins.delete(data.pending_id);
        res.writeHead(401);
        res.end(JSON.stringify({ ok: false, error: 'Session expired. Please login again.' }));
        return;
      }
      try {
        const result = await hkAuth(pending.username, pending.password, data.totp);
        if (result.status >= 200 && result.status < 300 && result.body?.authToken) {
          pendingLogins.delete(data.pending_id);
          const sessionId = genId();
          const ua = getUaHash(req);
          sessions.set(sessionId, { token: result.body.authToken, ip, ua, started: Date.now(), lastActivity: Date.now(), user: result.body.username });
          logSession({ event: 'login', ip, user: result.body.username, sessionId });
          res.writeHead(200, { 'Set-Cookie': `hk_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict` });
          res.end(JSON.stringify({ ok: true, session: sessionId }));
          return;
        }
      } catch {}
      recordFail(ip);
      logSession({ event: 'failed_totp', ip });
      res.writeHead(401);
      res.end(JSON.stringify({ ok: false, error: 'Invalid authentication code' }));
      return;
    }

    // Step 1: Username + password
    if (!data.username || !data.password) { res.writeHead(400); res.end(JSON.stringify({ ok: false })); return; }
    try {
      const result = await hkAuth(data.username, data.password);
      if (result.status >= 200 && result.status < 300 && result.body?.authToken) {
        const sessionId = genId();
        const ua = getUaHash(req);
        sessions.set(sessionId, { token: result.body.authToken, ip, ua, started: Date.now(), lastActivity: Date.now(), user: result.body.username });
        logSession({ event: 'login', ip, user: result.body.username, sessionId });
        res.writeHead(200, { 'Set-Cookie': `hk_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict` });
        res.end(JSON.stringify({ ok: true, session: sessionId }));
        return;
      }
      // 403 with INSUFFICIENT_CREDENTIALS = TOTP required
      if (result.status === 403 && result.body?.type === 'INSUFFICIENT_CREDENTIALS') {
        const pendingId = genId();
        pendingLogins.set(pendingId, { username: data.username, password: data.password, created: Date.now() });
        res.writeHead(200);
        res.end(JSON.stringify({ ok: false, requires_2fa: true, pending_id: pendingId }));
        return;
      }
    } catch {}
    recordFail(ip);
    logSession({ event: 'failed_login', ip, user: data.username });
    res.writeHead(401);
    res.end(JSON.stringify({ ok: false, error: 'Invalid credentials' }));
    return;
  }

  // API: Logout
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const sessionId = getSessionFromReq(req);
    if (sessionId && sessions.has(sessionId)) {
      const s = sessions.get(sessionId);
      logSession({ event: 'logout', ip, user: s.user, sessionId, duration: Math.round((Date.now() - s.started) / 1000) });
      sessions.delete(sessionId);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'hk_session=; Path=/; HttpOnly; Max-Age=0' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // API: Session validity check (lightweight, no side effects)
  if (url.pathname === '/api/ping' && req.method === 'POST') {
    const v = validateSession(req);
    if (!v) { res.writeHead(401); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // API: Get stream token for direct connection
  if (url.pathname === '/api/stream-token' && req.method === 'POST') {
    const v = validateSession(req);
    if (!v) { res.writeHead(401); res.end('{}'); return; }
    const token = crypto.randomBytes(32).toString('hex');
    streamTokens.set(token, { guacToken: v.session.token, user: v.session.user, created: Date.now(), ua: v.session.ua });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token, host: 'v.wxyz.stream', port: 8443 }));
    return;
  }

  // API: Update resolution
  if (url.pathname === '/api/resolution' && req.method === 'POST') {
    const v = validateSession(req);
    if (!v) { res.writeHead(401); res.end('{}'); return; }
    const data = await parseBody(req);
    if (data && data.width && data.height) {
      v.session.resWidth = data.width;
      v.session.resHeight = data.height;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Serve static JS libraries
  if (url.pathname === '/guacamole.min.js' || url.pathname === '/novnc-keyboard.js') {
    const fname = url.pathname.slice(1);
    const jsPath = path.join(__dirname, fname);
    try {
      const js = fs.readFileSync(jsPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'max-age=86400' });
      res.end(js);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // Serve PWA assets
  if (url.pathname === '/manifest.json') {
    try {
      const data = fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
    return;
  }
  if (url.pathname === '/sw.js') {
    try {
      const data = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
      res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
    return;
  }
  if (url.pathname === '/icon-192.png' || url.pathname === '/icon-512.png') {
    try {
      const data = fs.readFileSync(path.join(__dirname, url.pathname.slice(1)));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
    return;
  }

  // Dashboard (session page)
  if (url.pathname.startsWith('/s/')) {
    const v = validateSession(req);
    if (!v) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashHtml().replace('__GUAC_TOKEN__', v.session.token));
    return;
  }

  // Proxy: /tunnel/* -> backend
  if (url.pathname.startsWith('/tunnel/') || url.pathname === '/tunnel') {
    const v = validateSession(req);
    if (!v) { res.writeHead(401); res.end('Unauthorized'); return; }
    req.url = '/guacamole' + req.url.slice(7);
    proxy.web(req, res, { ws: true });
    return;
  }

  // Fallback
  res.writeHead(302, { Location: '/' }); res.end();
});

// WebSocket upgrade for tunnel
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/tunnel/websocket-tunnel') { socket.destroy(); return; }
  const v = validateSession(req);
  if (!v) { socket.destroy(); return; }
  req.url = '/guacamole' + req.url.slice(7);
  proxy.ws(req, socket, head, { target: HK_BACKEND });
});

// Cleanup expired sessions (1h idle) + stale pending logins + expired stream tokens
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > 28800000) {
      logSession({ event: 'expired', user: s.user, sessionId: id, duration: Math.round((now - s.started) / 1000) });
      sessions.delete(id);
    }
  }
  for (const [id, p] of pendingLogins) {
    if (now - p.created > 300000) pendingLogins.delete(id);
  }
  for (const [ip, r] of loginAttempts) {
    if (now - r.first > BF_BLOCK_MS + BF_WINDOW_MS) loginAttempts.delete(ip);
  }
  for (const [t, d] of streamTokens) {
    if (now - d.created > 30000) streamTokens.delete(t);
  }
}, 60000);

server.listen(PORT, () => console.log(`mgmt-gate listening on :${PORT}`));

// Direct-stream HTTPS server (token-authed, no CF)
function startDirectServer() {
  if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
    console.log('Direct-stream: certs not found, skipping HTTPS listener');
    return;
  }
  const tlsOpts = {
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
  };
  const directProxy = httpProxy.createProxyServer({ target: HK_BACKEND, ws: true, changeOrigin: true });
  directProxy.on('error', () => {});

  const directServer = https.createServer(tlsOpts, (req, res) => {
    res.writeHead(444);
    res.end();
  });

  directServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'https://localhost');
    const pathParts = url.pathname.split('/');
    if (pathParts.length !== 3 || pathParts[1] !== 'stream') { socket.destroy(); return; }
    const token = pathParts[2];
    if (!token || !streamTokens.has(token)) { socket.destroy(); return; }
    const td = streamTokens.get(token);
    streamTokens.delete(token);
    const clientUa = crypto.createHash('sha256').update(req.headers['user-agent'] || '').digest('hex').slice(0, 16);
    if (td.ua !== clientUa) {
      logSession({ event: 'stream_token_ua_mismatch', user: td.user });
      socket.destroy();
      return;
    }
    logSession({ event: 'direct_stream', user: td.user });
    req.url = '/guacamole/websocket-tunnel' + (url.search || '');
    directProxy.ws(req, socket, head, { target: HK_BACKEND });
  });

  directServer.listen(DIRECT_PORT, () => console.log(`direct-stream listening on :${DIRECT_PORT} (TLS)`));
}
startDirectServer();
