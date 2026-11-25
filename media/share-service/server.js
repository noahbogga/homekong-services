const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = '/data/shares.json';
const FILES_ROOT = '/srv';

let shares = {};
if (fs.existsSync(DB_FILE)) {
  shares = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(shares, null, 2));
}

function genId() {
  return crypto.randomBytes(6).toString('base64url');
}

function getMime(file) {
  const ext = path.extname(file).toLowerCase();
  const types = {
    '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif',
    '.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.bmp':'image/bmp',
    '.mp4':'video/mp4','.webm':'video/webm','.mkv':'video/x-matroska','.avi':'video/x-msvideo','.mov':'video/quicktime',
    '.mp3':'audio/mpeg','.wav':'audio/wav','.flac':'audio/flac','.ogg':'audio/ogg','.m4a':'audio/mp4',
    '.pdf':'application/pdf',
    '.txt':'text/plain','.log':'text/plain','.md':'text/markdown','.csv':'text/csv',
    '.json':'application/json','.xml':'application/xml','.yml':'text/yaml','.yaml':'text/yaml',
    '.js':'text/javascript','.ts':'text/typescript','.css':'text/css','.html':'text/html',
    '.lua':'text/x-lua','.py':'text/x-python','.sh':'text/x-shellscript',
    '.cfg':'text/plain','.ini':'text/plain','.conf':'text/plain','.meta':'text/xml',
    '.zip':'application/zip','.rar':'application/x-rar-compressed','.7z':'application/x-7z-compressed','.tar':'application/x-tar','.gz':'application/gzip'
  };
  return types[ext] || 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/create') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { filepath } = JSON.parse(body);
        if (!filepath) { res.writeHead(400); res.end('missing filepath'); return; }
        const full = path.join(FILES_ROOT, filepath);
        if (!fs.existsSync(full)) { res.writeHead(404); res.end('file not found'); return; }
        const id = genId();
        shares[id] = { filepath, created: Date.now() };
        save();
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ id, url: '/p/' + id }));
      } catch(e) { res.writeHead(400); res.end('bad request'); }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/p/')) {
    const id = url.pathname.slice(3);
    const entry = shares[id];
    if (!entry) { res.writeHead(404); res.end('not found'); return; }
    const full = path.join(FILES_ROOT, entry.filepath);
    if (!fs.existsSync(full)) { res.writeHead(404); res.end('file gone'); return; }
    const stat = fs.statSync(full);
    const mime = getMime(full);
    const filename = path.basename(full);
    const dl = url.searchParams.get('dl') === '1';
    const headers = {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    };
    // Inline display by default, download only with ?dl=1
    if (dl) {
      headers['Content-Disposition'] = 'attachment; filename= + filename + ';
    } else {
      headers['Content-Disposition'] = 'inline; filename= + filename + ';
    }
    res.writeHead(200, headers);
    fs.createReadStream(full).pipe(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/list') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(shares));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(3000, () => console.log('Share service on :3000'));
