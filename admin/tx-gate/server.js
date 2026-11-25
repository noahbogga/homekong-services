// HOMEKONG TX gate — DockerHost (.247) Linux edition.
// Auth (bcryptjs/JWT/TOTP) + infra status + SSH-based restarts run here.
// Hyper-V VM control is delegated to the helper on the Windows host (.56).
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { TOTP, Secret } = require('otpauth');
const QRCode = require('qrcode');

// === Config ===
// Stable secret so restarts don't invalidate everyone's session.
const SECRET_FILE = path.join(__dirname, 'jwt_secret');
function loadJwtSecret() {
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); }
  catch {
    const s = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 }); } catch {}
    return s;
  }
}
const JWT_SECRET = loadJwtSecret();
const JWT_EXPIRY = '24h';
const USERS_FILE = path.join(__dirname, 'users.json');

const FXSERVER_IP = '192.168.50.235';
const GAME_PORT = 30120;
const TXADMIN_PORT = 40120;
const DEBUG_IP = '192.168.50.236';
const DEBUG_PORT = 30121;
const VPS_HOST = process.env.VPS_HOST || 'vpsip.homekong.cc';   // hostname, survives IP change
const SSH_KEY = process.env.SSH_KEY || '/root/.ssh/id_rsa';
const VM_HELPER = process.env.VM_HELPER || 'http://192.168.50.56:3002/vm';
const VM_SECRET = (() => { try { return fs.readFileSync(path.join(__dirname, 'vm_secret'), 'utf8').trim(); } catch { return ''; } })();

const LOG_PATH = '/opt/fxserver/txData/default/logs/fxserver.log';
const DEBUG_LOG_PATH = '/opt/fxserver/server/txData/debug_server/logs/fxserver.log';

// === User Store ===
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; }
}
function saveUsers(users) { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }

// === JWT / auth helpers ===
function signToken(user, role) { return jwt.sign({ user, role }, JWT_SECRET, { expiresIn: JWT_EXPIRY }); }
function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }
function extractToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/hk_token=([^;]+)/);
  if (m) return m[1];
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}
function requireAuth(req) { const t = extractToken(req); return t ? verifyToken(t) : null; }
function requireAdmin(req) { const p = requireAuth(req); return (p && p.role === 'admin') ? p : null; }
function createTOTP(username, secret) {
  return new TOTP({ issuer: 'HOMEKONG', label: username, algorithm: 'SHA1', digits: 6, period: 30, secret });
}
function parseBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  });
}

// === SSH / infra helpers (native ssh client in container) ===
function sshCmd(host, cmd) {
  return new Promise((resolve) => {
    execFile('ssh', ['-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=5', 'root@' + host, cmd],
      { timeout: 15000 }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      });
  });
}
function checkPort(host, port) {
  return new Promise((resolve) => {
    const s = new net.Socket(); s.setTimeout(2000);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}
// VM control delegated to the .56 helper
function vmCmd(vmName, action) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ vm: vmName, action });
    const u = new URL(VM_HELPER);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-hk-secret': VM_SECRET },
      timeout: 40000 }, (resp) => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { try { const j = JSON.parse(d); resolve({ ok: j.ok, stdout: j.stdout || '' }); } catch { resolve({ ok: false, stdout: '' }); } });
    });
    req.on('error', () => resolve({ ok: false, stdout: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, stdout: '' }); });
    req.write(body); req.end();
  });
}
function restart() { return sshCmd(FXSERVER_IP, 'systemctl restart fxserver').then(r => r.ok); }

// === Log polling (SSH tail from container) ===
let logCache = [], lastLogBytes = 0, logSeq = 0;
let debugLogCache = [], debugLastLogBytes = 0, debugLogSeq = 0;
let vpsLogCache = [], vpsLastLogBytes = 0, vpsLogSeq = 0;
function tailLog(host, logPath, fromByte) {
  return new Promise((resolve) => {
    const remote = `if [ ! -f '${logPath}' ]; then exit 1; fi; SIZE=$(stat -c%s '${logPath}'); if [ ${fromByte} -gt $SIZE ]; then echo '|||OFFSET:${fromByte}'; exit 0; fi; CHUNK=$(tail -c +${fromByte} '${logPath}' | head -c 8192 | wc -c); NEWOFF=$((${fromByte} + $CHUNK)); tail -c +${fromByte} '${logPath}' | head -c 8192; echo "|||OFFSET:$NEWOFF"`;
    execFile('ssh', ['-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=3', 'root@' + host, remote],
      { timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}
async function pollGeneric(host, logPath, getOff, setOff, cache, seqRef) {
  const out = await tailLog(host, logPath, getOff() + 1);
  if (!out) return;
  const parts = out.split('|||OFFSET:');
  if (parts.length < 2) return;
  const newOff = parseInt(parts[1].trim());
  if (newOff && newOff > getOff()) {
    for (const line of parts[0].split('\n').filter(l => l.trim())) {
      const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (clean) { cache.push({ seq: seqRef.v++, text: clean }); }
    }
    while (cache.length > 200) cache.shift();
    setOff(newOff - 1);
  }
}
const gameSeq = { v: 0 }, dbgSeq = { v: 0 }, vpsSeq = { v: 0 };
setInterval(() => pollGeneric(FXSERVER_IP, LOG_PATH, () => lastLogBytes, v => lastLogBytes = v, logCache, gameSeq), 3000);
setInterval(() => pollGeneric(DEBUG_IP, DEBUG_LOG_PATH, () => debugLastLogBytes, v => debugLastLogBytes = v, debugLogCache, dbgSeq), 3000);
setInterval(() => pollGeneric(VPS_HOST, '/var/log/syslog', () => vpsLastLogBytes, v => vpsLastLogBytes = v, vpsLogCache, vpsSeq), 5000);
async function initOff(host, logPath, set) {
  const r = await sshCmd(host, `stat -c%s '${logPath}' 2>/dev/null || echo 0`);
  const size = parseInt((r.stdout || '0').trim()) || 0;
  set(Math.max(0, size - 8192));
}
initOff(FXSERVER_IP, LOG_PATH, v => lastLogBytes = v);
initOff(DEBUG_IP, DEBUG_LOG_PATH, v => debugLastLogBytes = v);
initOff(VPS_HOST, '/var/log/syslog', v => vpsLastLogBytes = v);

// === HTTP Server ===
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.end('{}'); return; }
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/auth/validate') {
    const p = requireAuth(req);
    if (p) { res.statusCode = 200; res.end(JSON.stringify({ ok: true, user: p.user, role: p.role })); }
    else { res.statusCode = 401; res.end(JSON.stringify({ ok: false })); }
    return;
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    const data = await parseBody(req);
    if (!data || !data.username || !data.password) { res.statusCode = 400; res.end(JSON.stringify({ ok: false })); return; }
    const users = loadUsers(); const user = users[data.username];
    if (!user || !bcrypt.compareSync(data.password, user.hash)) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'Invalid credentials' })); return; }
    if (user.totp_enabled) {
      const pendingToken = jwt.sign({ user: data.username, role: user.role, pending_2fa: true }, JWT_SECRET, { expiresIn: '5m' });
      res.end(JSON.stringify({ ok: true, requires_2fa: true, pending_token: pendingToken })); return;
    }
    res.end(JSON.stringify({ ok: true, token: signToken(data.username, user.role), user: data.username, role: user.role }));
    return;
  }

  if (url.pathname === '/login/totp' && req.method === 'POST') {
    const data = await parseBody(req);
    if (!data || !data.pending_token || !data.code) { res.statusCode = 400; res.end(JSON.stringify({ ok: false })); return; }
    const pending = verifyToken(data.pending_token);
    if (!pending || !pending.pending_2fa) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'Invalid or expired' })); return; }
    const users = loadUsers(); const user = users[pending.user];
    if (!user || !user.totp_enabled) { res.statusCode = 400; res.end(JSON.stringify({ ok: false })); return; }
    const valid = createTOTP(pending.user, Secret.fromBase32(user.totp_secret)).validate({ token: data.code, window: 1 }) !== null;
    if (!valid) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'Invalid code' })); return; }
    res.end(JSON.stringify({ ok: true, token: signToken(pending.user, user.role), user: pending.user, role: user.role }));
    return;
  }

  if (url.pathname === '/api/me') {
    const p = requireAuth(req);
    if (!p) { res.statusCode = 401; res.end(JSON.stringify({ ok: false })); return; }
    const u = loadUsers()[p.user];
    res.end(JSON.stringify({ ok: true, user: p.user, role: p.role, totp_enabled: u ? u.totp_enabled : false }));
    return;
  }

  if (url.pathname === '/api/settings/password' && req.method === 'PUT') {
    const p = requireAuth(req);
    if (!p) { res.statusCode = 401; res.end(JSON.stringify({ ok: false })); return; }
    const data = await parseBody(req);
    if (!data || !data.current || !data.newPassword || data.newPassword.length < 6) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'Password must be 6+ chars' })); return; }
    const users = loadUsers(); const user = users[p.user];
    if (!user || !bcrypt.compareSync(data.current, user.hash)) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'Current password incorrect' })); return; }
    user.hash = bcrypt.hashSync(data.newPassword, 10); saveUsers(users);
    res.end(JSON.stringify({ ok: true })); return;
  }

  if (url.pathname === '/api/settings/2fa/setup' && req.method === 'GET') {
    const p = requireAuth(req);
    if (!p) { res.statusCode = 401; res.end(JSON.stringify({ ok: false })); return; }
    const secret = new Secret({ size: 20 });
    const uri = createTOTP(p.user, secret).toString();
    res.end(JSON.stringify({ ok: true, secret: secret.base32, qr: await QRCode.toDataURL(uri), uri })); return;
  }

  if (url.pathname === '/api/settings/2fa/enable' && req.method === 'POST') {
    const p = requireAuth(req);
    if (!p) { res.statusCode = 401; res.end(JSON.stringify({ ok: false })); return; }
    const data = await parseBody(req);
    if (!data || !data.secret || !data.code) { res.statusCode = 400; res.end(JSON.stringify({ ok: false })); return; }
    const valid = createTOTP(p.user, Secret.fromBase32(data.secret)).validate({ token: data.code, window: 1 }) !== null;
    if (!valid) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'Invalid code — try again' })); return; }
    const recovery = crypto.randomBytes(16).toString('hex');
    const users = loadUsers();
    users[p.user].totp_secret = data.secret; users[p.user].totp_enabled = true; users[p.user].recovery_token = bcrypt.hashSync(recovery, 10);
    saveUsers(users);
    res.end(JSON.stringify({ ok: true, recovery_token: recovery })); return;
  }

  if (url.pathname === '/api/settings/2fa/disable' && req.method === 'POST') {
    const p = requireAuth(req);
    if (!p) { res.statusCode = 401; res.end(JSON.stringify({ ok: false })); return; }
    const data = await parseBody(req);
    if (!data || !data.recovery_token) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'Recovery token required' })); return; }
    const users = loadUsers(); const user = users[p.user];
    if (!user || !user.recovery_token || !bcrypt.compareSync(data.recovery_token, user.recovery_token)) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'Invalid recovery token' })); return; }
    user.totp_secret = null; user.totp_enabled = false; user.recovery_token = null; saveUsers(users);
    res.end(JSON.stringify({ ok: true })); return;
  }

  if (url.pathname === '/api/admin/users' && req.method === 'GET') {
    const p = requireAdmin(req);
    if (!p) { res.statusCode = 403; res.end(JSON.stringify({ ok: false })); return; }
    const list = Object.entries(loadUsers()).map(([name, u]) => ({ name, role: u.role, totp_enabled: u.totp_enabled }));
    res.end(JSON.stringify({ ok: true, users: list })); return;
  }

  if (url.pathname === '/api/admin/users' && req.method === 'POST') {
    const p = requireAdmin(req);
    if (!p) { res.statusCode = 403; res.end(JSON.stringify({ ok: false })); return; }
    const data = await parseBody(req);
    if (!data || !data.username || !data.password || data.password.length < 6) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'Username and password (6+) required' })); return; }
    const users = loadUsers();
    if (users[data.username]) { res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: 'User already exists' })); return; }
    users[data.username] = { hash: bcrypt.hashSync(data.password, 10), role: data.role || 'user', totp_secret: null, totp_enabled: false, recovery_token: null };
    saveUsers(users);
    res.end(JSON.stringify({ ok: true })); return;
  }

  if (url.pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
    const p = requireAdmin(req);
    if (!p) { res.statusCode = 403; res.end(JSON.stringify({ ok: false })); return; }
    const target = decodeURIComponent(url.pathname.split('/api/admin/users/')[1]);
    if (target === 'noah') { res.statusCode = 403; res.end(JSON.stringify({ ok: false, error: 'Cannot delete main admin' })); return; }
    const users = loadUsers();
    if (!users[target]) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'User not found' })); return; }
    delete users[target]; saveUsers(users);
    res.end(JSON.stringify({ ok: true })); return;
  }

  if (url.pathname.startsWith('/api/admin/users/') && url.pathname.endsWith('/role') && req.method === 'PUT') {
    const p = requireAdmin(req);
    if (!p) { res.statusCode = 403; res.end(JSON.stringify({ ok: false })); return; }
    const target = decodeURIComponent(url.pathname.replace('/api/admin/users/', '').replace('/role', ''));
    if (target === 'noah') { res.statusCode = 403; res.end(JSON.stringify({ ok: false, error: 'Cannot change main admin role' })); return; }
    const data = await parseBody(req);
    if (!data || !data.role || !['admin','user'].includes(data.role)) { res.statusCode = 400; res.end(JSON.stringify({ ok: false })); return; }
    const users = loadUsers();
    if (!users[target]) { res.statusCode = 404; res.end(JSON.stringify({ ok: false })); return; }
    users[target].role = data.role; saveUsers(users);
    res.end(JSON.stringify({ ok: true })); return;
  }
  if (url.pathname === '/services/status') {
    const [debugGame, debugVm, gameGame, gameTx, gameVm, vpsCheck, gameVmUptime, debugVmUptime, gameFxUptime, debugFxUptime] = await Promise.all([
      checkPort(DEBUG_IP, DEBUG_PORT),
      vmCmd('hk-fxtest', 'status'),
      checkPort(FXSERVER_IP, GAME_PORT),
      checkPort(FXSERVER_IP, TXADMIN_PORT),
      vmCmd('hk-fxmain', 'status'),
      sshCmd(VPS_HOST, 'echo ok;wg show wg0 2>&1 | head -1;uptime -p'),
      sshCmd(FXSERVER_IP, 'uptime -p'),
      sshCmd(DEBUG_IP, 'uptime -p'),
      sshCmd(FXSERVER_IP, "ps -o etime= -p $(pgrep -f 'FXServer.*serverProfile' | head -1) 2>/dev/null || echo offline"),
      sshCmd(DEBUG_IP, "ps -o etime= -p $(pgrep -f 'FXServer.*serverProfile' | head -1) 2>/dev/null || echo offline"),
    ]);
    let vpsData = { online: false, wg: false, uptime: 'Unknown' };
    if (vpsCheck.ok) {
      const lines = vpsCheck.stdout.split('\n');
      vpsData.online = true;
      vpsData.wg = lines[1] && lines[1].trim().startsWith('interface:');
      vpsData.uptime = lines[2] ? lines[2].trim() : 'Unknown';
    }
    res.end(JSON.stringify({
      debug: { game: debugGame, vm: debugVm.stdout.includes('Running'), vmUptime: debugVmUptime.ok ? debugVmUptime.stdout : 'Unknown', fxUptime: debugFxUptime.ok ? debugFxUptime.stdout.trim() || 'offline' : 'offline' },
      game: { game: gameGame, txadmin: gameTx, vm: gameVm.stdout.includes('Running'), vmUptime: gameVmUptime.ok ? gameVmUptime.stdout : 'Unknown', fxUptime: gameFxUptime.ok ? gameFxUptime.stdout.trim() || 'offline' : 'offline' },
      vps: vpsData
    }));
    return;
  }

  if (url.pathname === '/services' && req.method === 'POST') {
    const data = await parseBody(req);
    if (!data) { res.statusCode = 400; res.end(JSON.stringify({ ok: false })); return; }
    const { action, target } = data;
    let result = { ok: false, error: 'unknown action' };
    if (target === 'debug') {
      if (action === 'vm-restart') result = await vmCmd('hk-fxtest', 'restart');
      else if (action === 'fx-restart') result = await sshCmd(DEBUG_IP, 'systemctl restart fxserver');
      else if (action === 'fx-stop') result = await sshCmd(DEBUG_IP, 'systemctl stop fxserver');
      else if (action === 'fx-start') result = await sshCmd(DEBUG_IP, 'systemctl start fxserver');
    } else if (target === 'game') {
      if (action === 'vm-restart') result = await vmCmd('hk-fxmain', 'restart');
      else if (action === 'fx-restart') result = await sshCmd(FXSERVER_IP, 'systemctl restart fxserver');
      else if (action === 'fx-stop') result = await sshCmd(FXSERVER_IP, 'systemctl stop fxserver');
      else if (action === 'fx-start') result = await sshCmd(FXSERVER_IP, 'systemctl start fxserver');
    } else if (target === 'vps') {
      if (action === 'wg-restart') result = await sshCmd(VPS_HOST, 'wg-quick down wg0; sleep 1; wg-quick up wg0');
      else if (action === 'nginx-restart') result = await sshCmd(VPS_HOST, 'systemctl restart nginx');
      else if (action === 'reboot') { result = await sshCmd(VPS_HOST, 'reboot'); result.ok = true; }
    }
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === '/status') {
    const [game, tx, debug] = await Promise.all([
      checkPort(FXSERVER_IP, GAME_PORT), checkPort(FXSERVER_IP, TXADMIN_PORT), checkPort(DEBUG_IP, DEBUG_PORT)
    ]);
    let players = 0;
    if (game) {
      try {
        const data = await new Promise((resolve) => {
          const r = http.get(`http://${FXSERVER_IP}:${GAME_PORT}/players.json`, { timeout: 2000 }, (resp) => {
            let b = ''; resp.on('data', c => b += c); resp.on('end', () => resolve(b));
          });
          r.on('error', () => resolve('[]')); r.on('timeout', () => { r.destroy(); resolve('[]'); });
        });
        players = JSON.parse(data).length;
      } catch { players = 0; }
    }
    res.end(JSON.stringify({ game, txadmin: tx, debug, players })); return;
  }

  if (url.pathname === '/logs' || url.pathname.startsWith('/logs?')) {
    const since = parseInt(url.searchParams.get('since') || '-1');
    const lines = since < 0 ? logCache.slice(-100).map(e => e.text) : logCache.filter(e => e.seq >= since).map(e => e.text);
    res.end(JSON.stringify({ lines, since: logCache.length ? logCache[logCache.length - 1].seq + 1 : 0 })); return;
  }
  if (url.pathname === '/logs/debug' || url.pathname.startsWith('/logs/debug?')) {
    const since = parseInt(url.searchParams.get('since') || '-1');
    const lines = since < 0 ? debugLogCache.slice(-100).map(e => e.text) : debugLogCache.filter(e => e.seq >= since).map(e => e.text);
    res.end(JSON.stringify({ lines, since: debugLogCache.length ? debugLogCache[debugLogCache.length - 1].seq + 1 : 0 })); return;
  }
  if (url.pathname === '/logs/vps' || url.pathname.startsWith('/logs/vps?')) {
    const since = parseInt(url.searchParams.get('since') || '-1');
    const lines = since < 0 ? vpsLogCache.slice(-100).map(e => e.text) : vpsLogCache.filter(e => e.seq >= since).map(e => e.text);
    res.end(JSON.stringify({ lines, since: vpsLogCache.length ? vpsLogCache[vpsLogCache.length - 1].seq + 1 : 0 })); return;
  }

  if (url.pathname === '/restart' && req.method === 'POST') {
    res.end(JSON.stringify({ ok: true, msg: 'Restart initiated' })); restart(); return;
  }

  res.statusCode = 404; res.end('{}');
});
server.listen(3001, '0.0.0.0', () => console.log('HOMEKONG TX gate (dockerhost) on port 3001'));

