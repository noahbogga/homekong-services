const http = require('http');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DATA_ROOT = '/srv';
const PORT = 3002;

// ===== AI JOB STORE =====
const aiJobs = {}; // { jobId: { status, startTime, b64?, error?, abort? } }
const AI_IMAGE_KEY = 'CHANGE_ME';
const AI_CHAT_KEY = 'CHANGE_ME';
const AI_BASE = 'https://YOUR_AI_API_HOST';

function _processAiJob(jobId, prompt, image) {
  const https = require('https');
  let apiReq;

  if (image && image.startsWith('data:image/')) {
    // IMAGE EDIT — multipart/form-data
    const b64Data = image.split(',')[1];
    const imgBuffer = Buffer.from(b64Data, 'base64');
    const boundary = '----Form' + Date.now().toString(36);
    const parts = [];
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n1`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n1024x1024`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nb64_json`);
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`;
    const ending = `\r\n--${boundary}--\r\n`;
    const prefix = Buffer.from(parts.join('\r\n') + '\r\n' + fileHeader);
    const suffix = Buffer.from(ending);
    const payload = Buffer.concat([prefix, imgBuffer, suffix]);

    apiReq = https.request({
      hostname: 'YOUR_AI_API_HOST', path: '/v1/images/edits', method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Authorization': 'Bearer ' + AI_IMAGE_KEY, 'Content-Length': payload.length },
      timeout: 300000,
    }, res => _handleAiResponse(jobId, res));
    apiReq.write(payload);
  } else {
    // PURE GENERATION — JSON
    const payload = JSON.stringify({ model: 'gpt-image-2', prompt, n: 1, size: '1024x1024', response_format: 'b64_json' });
    apiReq = https.request({
      hostname: 'YOUR_AI_API_HOST', path: '/v1/images/generations', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_IMAGE_KEY, 'Content-Length': Buffer.byteLength(payload) },
      timeout: 300000,
    }, res => _handleAiResponse(jobId, res));
    apiReq.write(payload);
  }

  apiReq.on('error', e => { if (aiJobs[jobId]) { aiJobs[jobId].status = 'error'; aiJobs[jobId].error = e.message; } });
  apiReq.on('timeout', () => { apiReq.destroy(); if (aiJobs[jobId]) { aiJobs[jobId].status = 'error'; aiJobs[jobId].error = 'API timeout'; } });
  aiJobs[jobId].abort = () => apiReq.destroy();
  apiReq.end();
}

function _handleAiResponse(jobId, apiRes) {
  let data = '';
  apiRes.on('data', c => data += c);
  apiRes.on('end', () => {
    if (!aiJobs[jobId]) return; // cancelled
    try {
      const result = JSON.parse(data);
      if (result.error) { aiJobs[jobId].status = 'error'; aiJobs[jobId].error = result.error.message || 'API error'; return; }
      if (result.data?.[0]?.b64_json) {
        aiJobs[jobId].status = 'done';
        aiJobs[jobId].b64 = result.data[0].b64_json.replace(/[\r\n\s]/g, '');
      } else if (result.data?.[0]?.url) {
        aiJobs[jobId].status = 'done';
        aiJobs[jobId].b64 = result.data[0].url; // store URL as b64 field for simplicity
      } else {
        aiJobs[jobId].status = 'error'; aiJobs[jobId].error = 'No image in response';
      }
    } catch(e) { aiJobs[jobId].status = 'error'; aiJobs[jobId].error = 'Parse error'; }
  });
}

// Cleanup stale jobs after 10 min
setInterval(() => { const now = Date.now(); for (const id in aiJobs) { if (now - aiJobs[id].startTime > 600000) delete aiJobs[id]; } }, 60000);


// ===== FILE INDEX (pre-built, searches are instant) =====
let fileIndex = []; // [{path, name, dir, lcName, lcPath}]
let indexBuilding = false;
let lastIndexTime = 0;

function buildIndex() {
  if (indexBuilding) return;
  indexBuilding = true;
  console.log('Building search index...');
  const start = Date.now();
  const newIndex = [];

  function walk(dir, rel) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const name = entry.name;
        // Skip junk directories
        if (entry.isDirectory() && (name === 'node_modules' || name === '.git' || name === 'alpine' || name === 'citizen' || name === 'cache')) continue;
        const fullRel = rel ? rel + '/' + name : name;
        const isDir = entry.isDirectory();
        newIndex.push({ path: fullRel, name, dir: isDir, lcName: name.toLowerCase(), lcPath: fullRel.toLowerCase() });
        if (isDir) {
          walk(path.join(dir, name), fullRel);
        }
      }
    } catch (e) {}
  }

  walk(DATA_ROOT, '');
  fileIndex = newIndex;
  lastIndexTime = Date.now();
  indexBuilding = false;
  console.log(`Index built: ${fileIndex.length} entries in ${Date.now() - start}ms`);
}

// Build on startup, rebuild every 60s
buildIndex();
setInterval(buildIndex, 60000);

// ===== CONTENT SEARCH (grep on disk, limited) =====
function grepContent(searchPath, query, limit) {
  const results = [];
  const fullPath = path.join(DATA_ROOT, searchPath);
  try {
    const cmd = ["/bin/sh","-c"]; console.log("GREP CMD executing..."); const out = execFileSync('/bin/sh', ['-c',
      `LC_ALL=C.UTF-8 find "${fullPath}" \\( -name "*.lua" -o -name "*.js" -o -name "*.json" -o -name "*.cfg" -o -name "*.meta" -o -name "*.xml" -o -name "*.txt" -o -name "*.yml" -o -name "*.yaml" -o -name "*.ini" -o -name "*.conf" -o -name "*.toml" -o -name "*.md" -o -name "*.html" -o -name "*.css" -o -name "*.py" -o -name "*.sh" -o -name "*.bat" -o -name "*.ps1" -o -name "*.sql" -o -name "*.csv" -o -name "*.ts" -o -name "*.log" \\) -not -path "*/node_modules/*" -not -path "*/alpine/*" -not -path "*/.git/*" -not -path "*/cache/*" -not -path "*/citizen/*" -size -1M -type f 2>/dev/null | head -500 | xargs grep -ilF -- "${query}" 2>/dev/null | head -${limit}`
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
    out.trim().split('\n').filter(Boolean).forEach(line => {
      const rel = line.startsWith(DATA_ROOT + '/') ? line.slice(DATA_ROOT.length + 1) : line;
      let snippet = '';
      try { snippet = execFileSync('grep', ['-im1F', '--', query, line], { encoding: 'utf8', timeout: 1000 }).trim().slice(0, 200); } catch(e) {}
      results.push({ path: rel, name: path.basename(line), dir: false, matchType: 'content', snippet });
    });
  } catch (e) {}
  return results;
}

// ===== HTTP SERVER =====
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // GET /grep — VS Code-style line-by-line search results
  if (url.pathname === '/grep') {
    const query = url.searchParams.get('q') || '';
    const searchPath = url.searchParams.get('path') || '/';
    const limit = parseInt(url.searchParams.get('limit') || '50');

    if (!query || query.length < 2) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'query too short'})); return; }

    const fullPath = path.join(DATA_ROOT, searchPath);
    const cmd = `LC_ALL=C.UTF-8 find "${fullPath}" \\( -name "*.lua" -o -name "*.js" -o -name "*.json" -o -name "*.cfg" -o -name "*.meta" -o -name "*.xml" -o -name "*.txt" -o -name "*.yml" -o -name "*.yaml" -o -name "*.ini" -o -name "*.conf" -o -name "*.md" -o -name "*.html" -o -name "*.css" -o -name "*.py" -o -name "*.sh" -o -name "*.sql" -o -name "*.csv" -o -name "*.ts" -o -name "*.log" -o -name "*.toml" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/cache/*" -not -path "*/citizen/*" -not -path "*/alpine/*" -size -2000k -type f -print0 | xargs -0 grep -niF -- "${query}" 2>/dev/null | head -${limit * 3}`;

     let out = '';
    try { out = execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', timeout: 20000, maxBuffer: 10*1024*1024 }); }
    catch(e) { out = (e.stdout || '') + '';  }

     const lines = out.trim().split('\n').filter(Boolean);
    const fileGroups = {};
    for (const line of lines) {
      const firstColon = line.indexOf(':');
      if (firstColon < 0) continue;
      const secondColon = line.indexOf(':', firstColon + 1);
      if (secondColon < 0) continue;
      const fileFull = line.substring(0, firstColon);
      const lineNum = parseInt(line.substring(firstColon + 1, secondColon));
      const lineContent = line.substring(secondColon + 1).trim().substring(0, 200);
      if (isNaN(lineNum)) continue;
      const relPath = fileFull.startsWith(DATA_ROOT + '/') ? fileFull.slice(DATA_ROOT.length + 1) : fileFull;
      const fileName = path.basename(fileFull);
      if (!fileGroups[relPath]) fileGroups[relPath] = { path: relPath, name: fileName, lines: [] };
      if (fileGroups[relPath].lines.length < 10) fileGroups[relPath].lines.push({ num: lineNum, text: lineContent });
    }
    const grouped = Object.values(fileGroups).slice(0, limit);
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ results: grouped, total: grouped.length, lineCount: lines.length }));
    return;
  }

  if (url.pathname === '/search') {
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    const searchPath = url.searchParams.get('path') || '/';
    const mode = url.searchParams.get('mode') || 'both';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '60'), 200);

    if (!query || query.length < 2) {
      res.writeHead(400, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'query too short'}));
      return;
    }

    const pathPrefix = searchPath === '/' ? '' : searchPath.replace(/^\//, '');
    let results = [];

    // NAME + PATH SEARCH — split query into words, match any word against name OR path
    // Also try the full query as-is (important for Chinese/non-Latin text)
    if (mode === 'name' || mode === 'both') {
      const words = query.split(/[\s\-_\.]+/).filter(w => w.length >= 2);
      // Always include the full query as one search term too
      if (!words.includes(query) && query.length >= 2) words.push(query);

      const scored = [];
      for (const f of fileIndex) {
        if (pathPrefix && !f.lcPath.startsWith(pathPrefix.toLowerCase())) continue;
        let score = 0;
        for (const w of words) {
          if (f.lcName.includes(w)) score += 3; // name match = high priority
          else if (f.lcPath.includes(w)) score += 1; // path match = lower
        }
        if (score > 0) scored.push({ ...f, score, matchType: 'name' });
      }

      // Sort by score desc, then by path length (shorter = more relevant)
      scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
      results = scored.slice(0, limit);
    }

    // CONTENT SEARCH (grep, slower but limited)
    if ((mode === 'content' || mode === 'both') && results.length < limit) {
      const remaining = limit - results.length;
      const existingPaths = new Set(results.map(r => r.path));
      const contentResults = grepContent(searchPath, url.searchParams.get('q'), remaining)
        .filter(r => !existingPaths.has(r.path));
      results = results.concat(contentResults);
    }

    // Remove internal fields
    const cleaned = results.map(({lcName, lcPath, ...rest}) => rest);

    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ results: cleaned, total: cleaned.length, indexed: fileIndex.length }));
    return;
  }

  if (url.pathname === '/status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ indexed: fileIndex.length, lastBuild: lastIndexTime, building: indexBuilding }));
    return;
  }

  if (url.pathname === '/report' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const report = JSON.parse(body);
        report.receivedAt = new Date().toISOString();
        const logFile = '/srv/error-reports.json';
        let reports = [];
        try { reports = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch(e) {}
        reports.push(report);
        if (reports.length > 200) reports = reports.slice(-200); // keep last 200
        fs.writeFileSync(logFile, JSON.stringify(reports, null, 2));
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true}));
      } catch(e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'invalid json'}));
      }
    });
    return;
  }

  // ===== PROXY TO AETHER CORE =====
  if (url.pathname.startsWith('/ai-') || url.pathname.startsWith('/aether/') || url.pathname === '/user-settings') {
    const http2 = require('http');
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const proxyReq = http2.request({
        hostname: 'aether-core', port: 3005, path: req.url, method: req.method,
        headers: { ...req.headers, host: 'aether-core:3005' },
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', e => { res.writeHead(502, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'aether unavailable'})); });
      if (body) proxyReq.write(body);
      proxyReq.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => console.log('Search service on :' + PORT));
