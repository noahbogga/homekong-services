const http = require('http');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DATA_ROOT = '/srv';
const PORT = 3002;

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
    const out = execFileSync('/bin/sh', ['-c',
      `find "${fullPath}" \\( -name "*.lua" -o -name "*.js" -o -name "*.json" -o -name "*.cfg" -o -name "*.meta" -o -name "*.xml" -o -name "*.txt" -o -name "*.yml" -o -name "*.yaml" -o -name "*.ini" -o -name "*.conf" -o -name "*.toml" \\) -not -path "*/node_modules/*" -not -path "*/alpine/*" -not -path "*/.git/*" -not -path "*/cache/*" -not -path "*/citizen/*" -size -1M -type f 2>/dev/null | head -500 | xargs grep -il "${query}" 2>/dev/null | head -${limit}`
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
    out.trim().split('\n').filter(Boolean).forEach(line => {
      const rel = line.startsWith(DATA_ROOT + '/') ? line.slice(DATA_ROOT.length + 1) : line;
      let snippet = '';
      try { snippet = execFileSync('grep', ['-im1', query, line], { encoding: 'utf8', timeout: 1000 }).trim().slice(0, 200); } catch(e) {}
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

  if (url.pathname === '/search') {
    const query = (url.searchParams.get('q') || '').toLowerCase();
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

    // NAME SEARCH (instant from index)
    if (mode === 'name' || mode === 'both') {
      const nameResults = fileIndex.filter(f =>
        (pathPrefix ? f.lcPath.startsWith(pathPrefix.toLowerCase()) : true) &&
        f.lcName.includes(query)
      ).slice(0, limit).map(f => ({ ...f, matchType: 'name' }));
      results = nameResults;
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

  // ===== AI IMAGE GENERATION PROXY =====
  if (url.pathname === '/ai-image' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const { prompt, image } = JSON.parse(body);
        if (!prompt) { res.writeHead(400); res.end('missing prompt'); return; }

        const API_KEY = 'CHANGE_ME';
        const API_URL = 'https://YOUR_AI_API_HOST/v1/chat/completions';

        // Build messages with image if provided
        const messages = [];
        const content = [];
        content.push({ type: 'text', text: prompt });
        if (image && image.startsWith('data:image/')) {
          content.push({ type: 'image_url', image_url: { url: image } });
        }
        messages.push({ role: 'user', content });

        const payload = JSON.stringify({
          model: 'gpt-image-1',
          messages,
          max_tokens: 4096,
        });

        // Use https module for the API call
        const https = require('https');
        const apiUrl = new URL(API_URL);
        const options = {
          hostname: apiUrl.hostname,
          path: apiUrl.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + API_KEY,
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 120000,
        };

        const apiReq = https.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.error) {
                res.writeHead(500, {'Content-Type':'text/plain'});
                res.end(result.error.message || 'API error');
                return;
              }
              // Try to extract image from response
              const choice = result.choices?.[0]?.message;
              let imageData = null;

              // Check for base64 image in response
              if (result.data?.[0]?.b64_json) {
                imageData = { b64: result.data[0].b64_json };
              } else if (result.data?.[0]?.url) {
                imageData = { url: result.data[0].url };
              } else if (choice?.content) {
                // Try to find base64 or URL in content
                const b64Match = choice.content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
                if (b64Match) imageData = { b64: b64Match[1] };
              }

              if (imageData) {
                res.writeHead(200, {'Content-Type':'application/json'});
                res.end(JSON.stringify(imageData));
              } else {
                // Return text response for non-image models
                res.writeHead(200, {'Content-Type':'application/json'});
                res.end(JSON.stringify({ text: choice?.content || 'No image generated', raw: result }));
              }
            } catch(e) {
              res.writeHead(500, {'Content-Type':'text/plain'});
              res.end('Failed to parse API response');
            }
          });
        });
        apiReq.on('error', (e) => {
          res.writeHead(500, {'Content-Type':'text/plain'});
          res.end('API request failed: ' + e.message);
        });
        apiReq.on('timeout', () => {
          apiReq.destroy();
          res.writeHead(504, {'Content-Type':'text/plain'});
          res.end('API timeout');
        });
        apiReq.write(payload);
        apiReq.end();
      } catch(e) {
        res.writeHead(400, {'Content-Type':'text/plain'});
        res.end('Invalid request: ' + e.message);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => console.log('Search service on :' + PORT));
