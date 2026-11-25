// cfg-editor.js - Direct .cfg file editor bypass for filebrowser 403 issue
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3009;
const ALLOWED_USERS = ['noah_', 'lkcwesley'];

function decodeJwt(t) {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64').toString('utf8')); }
  catch (e) { return null; }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Auth',
    });
    return res.end();
  }

  const url = new URL(req.url, 'http://x');
  const token = req.headers['x-auth'] || '';
  const jwt = decodeJwt(token);
  const user = jwt?.user?.username;

  if (!user || !ALLOWED_USERS.includes(user)) {
    return json(res, 403, { error: 'not authorized' });
  }

  const filePath = url.searchParams.get('path');
  if (!filePath || !filePath.endsWith('.cfg')) {
    return json(res, 400, { error: 'only .cfg files allowed' });
  }

  // Map filebrowser paths to real paths
  let realPath;
  if (filePath.startsWith('/fxMain/')) {
    realPath = '/srv/fxMain/' + filePath.slice(8);
  } else if (filePath.startsWith('/fxTest/')) {
    realPath = '/srv/fxTest/' + filePath.slice(8);
  } else {
    return json(res, 400, { error: 'invalid path' });
  }

  try {
    if (req.method === 'GET') {
      const content = fs.readFileSync(realPath, 'utf8');
      return json(res, 200, { content });
    }

    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const data = JSON.parse(body);
        fs.writeFileSync(realPath, data.content, 'utf8');
        console.log(new Date().toISOString(), 'SAVED', user, filePath);
        return json(res, 200, { ok: true });
      });
      return;
    }

    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log('cfg-editor listening on', PORT));
