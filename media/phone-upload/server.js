// phone-upload — base64 JSON relay for FiveM qb-phone camera → Zipline
// Accepts: POST /upload { "file": "<base64 string>", "token": "..." }
// Returns: Zipline's response JSON (with .files[].url)
// Reason: FiveM PerformHttpRequest truncates binary at null bytes;
//         base64 is ASCII-safe, so this relay decodes + re-uploads as multipart.
const http = require('http');

const PORT = 3090;
const ZIPLINE_URL = 'http://zipline:3000/api/upload'; // internal docker network

function log(...a) { console.log(new Date().toISOString(), '[phone-upload]', ...a); }

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', c => {
      len += c.length;
      if (len > maxBytes) { reject(new Error('too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function uploadToZipline(imgBuf, token, filename) {
  return new Promise((resolve, reject) => {
    const boundary = '----hkphoneRelay' + Date.now();
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, imgBuf, footer]);

    const url = new URL(ZIPLINE_URL);
    const opts = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: url.pathname,
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': body.length,
        'authorization': token,
        'x-zipline-domain': 'image.homekong.cc',
        'x-zipline-format': 'random',
      },
    };

    const zReq = http.request(opts, zRes => {
      const parts = [];
      zRes.on('data', c => parts.push(c));
      zRes.on('end', () => {
        const respBody = Buffer.concat(parts).toString('utf8');
        resolve({ status: zRes.statusCode, body: respBody });
      });
    });
    zReq.on('error', reject);
    zReq.setTimeout(30000, () => { zReq.destroy(); reject(new Error('timeout')); });
    zReq.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }

  if (req.method !== 'POST' || !req.url.startsWith('/upload')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end('{"error":"not found"}');
  }

  try {
    const raw = await readBody(req, 20 * 1024 * 1024); // 20MB max (base64 ~= 15MB image)
    const data = JSON.parse(raw.toString('utf8'));

    const token = data.token || req.headers['authorization'] || '';
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":"no token"}');
    }

    let b64 = data.file || '';
    if (!b64 || b64.length < 100) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end('{"error":"no file data"}');
    }

    // Strip data URI prefix if present
    b64 = b64.replace(/^data:image\/[^;]+;base64,/, '');

    const imgBuf = Buffer.from(b64, 'base64');
    log('decoding', b64.length, 'b64 chars →', imgBuf.length, 'bytes');

    const filename = 'phone_' + Date.now() + '.jpg';
    const result = await uploadToZipline(imgBuf, token, filename);

    log('zipline responded', result.status);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body);
  } catch (e) {
    log('ERROR', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => log('listening on', PORT));
