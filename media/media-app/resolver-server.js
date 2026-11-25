const http = require('http');

// Residential proxy for Instagram API calls
const PROXY_URL = 'http://USER:CHANGE_ME@PROXY_HOST:63030';
const PROXY_URL2 = 'http://USER:CHANGE_ME@PROXY_HOST:63031';
function getProxyAgent() {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  return new HttpsProxyAgent(Math.random() > 0.5 ? PROXY_URL : PROXY_URL2);
}
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3003;
const DOWNLOAD_ROOT = '/srv'; // filebrowser data root
const MAX_VPS_SIZE = 2 * 1024 * 1024 * 1024; // 2GB threshold for VPS proxy

// Job store
const jobs = {};

// HTTP helpers for calling browser-service
function _httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: {'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}, timeout: 30000 }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({error:d}); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}
function _httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: 10000 }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({error:d}); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
function _httpDelete(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'DELETE', timeout: 5000 }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({}));
    });
    req.on('error', reject); req.end();
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // POST /detect — detect link type and available formats
  if (url.pathname === '/detect' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { link } = JSON.parse(body);
        if (!link) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'missing link'})); return; }
        detectLink(link, res);
      } catch(e) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    });
    return;
  }

  // POST /download — start download job
  if (url.pathname === '/download' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { link, format, savePath, type, mergeFormat } = JSON.parse(body);
        if (!link || !savePath) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'missing link or savePath'})); return; }
        const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
        jobs[jobId] = { status: 'downloading', progress: 0, link, savePath, startTime: Date.now() };
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ jobId }));
        startDownload(jobId, link, format, savePath, type, mergeFormat);
      } catch(e) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    });
    return;
  }

  // GET /job?id=xxx — poll job status
  if (url.pathname === '/job' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    if (!id || !jobs[id]) { res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'not found'})); return; }
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(jobs[id]));
    if (jobs[id].status === 'done' || jobs[id].status === 'error') {
      setTimeout(() => delete jobs[id], 60000);
    }
    return;
  }

  // DELETE /job?id=xxx — cancel job
  if (url.pathname === '/job' && req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (id && jobs[id]) {
      if (jobs[id].proc) jobs[id].proc.kill();
      jobs[id].status = 'cancelled';
    }
    res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    return;
  }

  // GET /proxy-img?url=... — proxy external images (Instagram CDN etc)
  if (url.pathname === '/proxy-img' && req.method === 'GET') {
    const imgUrl = url.searchParams.get('url');
    if (!imgUrl) { res.writeHead(400); res.end('missing url'); return; }
    const https = require('https');
    const http2 = require('http');
    const mod = imgUrl.startsWith('https') ? https : http2;
    mod.get(imgUrl, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (imgRes) => {
      res.writeHead(200, { 'Content-Type': imgRes.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
      imgRes.pipe(res);
    }).on('error', () => { res.writeHead(502); res.end(); });
    return;
  }

  // POST /ig-list — list Instagram items by category
  if (url.pathname === '/ig-list' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { link, category, range } = JSON.parse(body);
        // Cookie rotation — pick a random account cookie file
        const cookieFiles = (() => {
          try {
            const fs2 = require('fs');
            return fs2.readdirSync('/app/cookies/').filter(f => f.startsWith('account_') && f.endsWith('.txt')).map(f => '/app/cookies/' + f);
          } catch(e) { return []; }
        })();
        const cookieFile = cookieFiles.length > 0
          ? cookieFiles[Math.floor(Math.random() * cookieFiles.length)]
          : '/app/cookies/instagram.txt';
        if (!fs.existsSync(cookieFile)) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'No cookies'})); return; }

        // Build gallery-dl URL based on category
        let targetUrl = link.replace(/\/$/, '');
        // Extract username from URL
        const usernameMatch = link.match(/instagram\.com\/([^\/\?]+)/);
        const igUsername = usernameMatch ? usernameMatch[1] : '';

        if (category === 'posts') targetUrl += '/posts/';
        else if (category === 'reels') targetUrl += '/reels/';
        else if (category === 'stories') targetUrl = 'https://www.instagram.com/stories/' + igUsername + '/';
        else if (category === 'highlights') targetUrl += '/highlights/';
        else if (category === 'avatar') targetUrl += '/avatar/';
        else targetUrl += '/posts/';

        // For highlights listing, fetch a LOT to get all highlight titles
        // Use faster settings for listing (no sleep on dump-json since we're not downloading)
        let rangeArg = range || '1-10';
        let useConfig = true;
        const timeout = 45000;
        let configArgs = ['--config', '/app/gallery-dl.conf'];

        // HIGHLIGHTS LAYER 1: Use Instagram API via proxy, fallback to gallery-dl
        if (category === 'highlights' && !range) {
          const usernameMatch2 = link.match(/instagram\.com\/([^\/\?]+)/);
          const igUser = usernameMatch2 ? usernameMatch2[1] : '';
          const cookieStr = fs.readFileSync(cookieFile, 'utf8').split('\n').filter(l => !l.startsWith('#') && l.trim()).map(l => { const p = l.split('\t'); return p[5] + '=' + p[6]; }).join('; ');
          const igHeaders = { 'Cookie': cookieStr, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'X-IG-App-ID': '936619743392459' };

          // Try IG API via residential proxy
          try {
            const agent = getProxyAgent();
            const profileTarget = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${igUser}`;
            const profileRes = await fetch(profileTarget, { headers: igHeaders, signal: AbortSignal.timeout(12000), agent });
            if (profileRes.status === 200) {
              const profile = await profileRes.json();
              const userId = profile?.data?.user?.id || '';
              if (userId) {
                const hlTarget = `https://www.instagram.com/api/v1/highlights/${userId}/highlights_tray/`;
                const hlRes = await fetch(hlTarget, { headers: igHeaders, signal: AbortSignal.timeout(12000), agent });
                if (hlRes.status === 200) {
                  const hl = await hlRes.json();
                  if (hl.tray && hl.tray.length > 0) {
                    const highlights = hl.tray.map(t => ({
                      title: t.title || 'Untitled',
                      count: t.media_count || 0,
                      id: (t.id || '').replace('highlight:', ''),
                      thumbnail: t.cover_media?.cropped_image_version?.url || t.cover_media?.media?.image_versions2?.candidates?.[0]?.url || '',
                      hasVideo: false,
                    }));
                    res.writeHead(200, {'Content-Type':'application/json'});
                    res.end(JSON.stringify({ highlights, isHighlightList: true, hasMore: false }));
                    return;
                  }
                }
              }
            }
          } catch(e) { /* API failed, fall through to gallery-dl */ }

          // Fallback: use gallery-dl to get highlights list
          const { execFile } = require('child_process');
          const hlUrl = link.replace(/\/$/, '') + '/highlights/';
          execFile('gallery-dl', ['--config', '/app/gallery-dl.conf', '--cookies', cookieFile, '--dump-json', '--range', '1-100', hlUrl], { timeout: 60000, maxBuffer: 20*1024*1024 }, (err, stdout) => {
            if (err || !stdout) {
              res.writeHead(200, {'Content-Type':'application/json'});
              res.end(JSON.stringify({highlights:[], isHighlightList:true, error:'Could not fetch highlights: ' + (err ? err.message.substring(0,80) : 'empty')}));
              return;
            }
            // Parse gallery-dl JSON output — single JSON array
            let hlItems = [];
            try { hlItems = JSON.parse(stdout); } catch(e) {}
            const groups = {};
            for (const entry of hlItems) {
              if (!Array.isArray(entry) || entry.length < 3) continue;
              const meta = entry[2] || {};
              const title = meta.highlight_title || 'Untitled';
              const thumb = meta.url || '';
              const hlId = (meta.post_url || '').match(/highlights\/(\d+)/)?.[1] || '';
              if (!groups[title]) groups[title] = { title, count: 0, thumbnail: thumb, id: hlId };
              groups[title].count++;
            }
            const highlights = Object.values(groups);
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ highlights, isHighlightList: true, hasMore: false }));
          });
          return;
        }
        const proc = execFile('gallery-dl', [...configArgs, '--cookies', cookieFile, '--dump-json', '--range', rangeArg, targetUrl], { timeout, maxBuffer: 20*1024*1024 }, async (err, stdout) => {
          if (err || !stdout) {
            // gallery-dl failed — try headless browser scraping
            // gallery-dl failed
            const errMsg = err ? err.message.substring(0,150) : 'empty';
            // Check if it's a "no items" vs actual error
            if (errMsg.includes('No results') || errMsg.includes('HttpError')) {
              res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({items:[], hasMore:false, note:'No content available for this category'})); return;
            }
            res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({items:[], error: errMsg})); return;
          }
          try {
            const data = JSON.parse(stdout);
            // For stories/highlights: DON'T group (each item is individual)
            // For posts/reels: group by post_shortcode (carousels share same shortcode)
            const isStoryLike = targetUrl.includes('/stories/') || targetUrl.includes('/highlights/') || category === 'stories';
            const postMap = {};
            let itemIndex = 0;
            for (const entry of data) {
              if (!Array.isArray(entry) || entry.length < 3) continue;
              const meta = entry[2];
              if (!meta || typeof meta !== 'object') continue;
              if (entry[0] === 6) continue; // skip directory entries
              itemIndex++;
              // For stories/highlights: each item gets unique key (no grouping)
              const shortcode = isStoryLike ? ('item_' + itemIndex) : (meta.post_shortcode || meta.shortcode || ('single_' + itemIndex));
              if (!postMap[shortcode]) {
                postMap[shortcode] = {
                  thumbnail: meta.display_url || entry[1] || '',
                  description: (meta.description || '').substring(0, 80),
                  type: meta.video_url ? 'video' : 'image',
                  date: meta.date || meta.post_date || '',
                  likes: meta.likes || 0,
                  shortcode: shortcode,
                  username: meta.username || '',
                  highlight_title: meta.highlight_title || '',
                  mediaCount: 0,
                  mediaItems: [],
                };
              }
              postMap[shortcode].mediaCount++;
              postMap[shortcode].mediaItems.push({
                url: entry[1] || meta.video_url || meta.display_url || '',
                type: meta.video_url ? 'video' : 'image',
                num: meta.num || postMap[shortcode].mediaCount,
              });
              if (meta.video_url && postMap[shortcode].type === 'image') postMap[shortcode].type = 'mixed';
            }
            const items = Object.values(postMap);
            // Determine hasMore: check if we got the full range of raw items
            const requestedCount = parseInt((rangeArg.split('-')[1] || '10')) - parseInt((rangeArg.split('-')[0] || '1')) + 1;
            // Count total raw media items received
            let totalRawItems = 0;
            for (const p of items) totalRawItems += (p.mediaCount || 1);
            const hasMore = totalRawItems >= requestedCount;

            // For highlights: group by highlight_title and return as highlight list
            if (category === 'highlights' && items.length > 0 && items[0].highlight_title) {
              const hlMap = {};
              for (const item of items) {
                const title = item.highlight_title || 'Untitled';
                if (!hlMap[title]) hlMap[title] = { title, count: 0, thumbnail: item.thumbnail, hasVideo: false };
                hlMap[title].count++;
                if (item.type === 'video') hlMap[title].hasVideo = true;
              }
              const highlights = Object.values(hlMap);
              res.writeHead(200, {'Content-Type':'application/json'});
              res.end(JSON.stringify({ highlights, isHighlightList: true, hasMore }));
              return;
            }

            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ items, count: items.length, hasMore }));
          } catch(e) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({items:[], error:'parse error'})); }
        });
      } catch(e) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    });
    return;
  }




  // GET /virustotal?hash=<sha256> — check file hash against VirusTotal
  if (url.pathname === '/virustotal' && req.method === 'GET') {
    const hash = url.searchParams.get('hash') || '';
    if (!hash || hash.length !== 64) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'invalid hash'})); return; }

    // VT API key (free tier: 4 req/min, 500/day)
    const VT_KEY = process.env.VT_API_KEY || '';

    if (!VT_KEY) {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({
        error: 'No VirusTotal API key configured. Set VT_API_KEY env var.',
        hash,
        permalink: 'https://www.virustotal.com/gui/file/' + hash
      }));
      return;
    }

    fetch('https://www.virustotal.com/api/v3/files/' + hash, {
      headers: { 'x-apikey': VT_KEY },
      signal: AbortSignal.timeout(10000),
    }).then(async vtRes => {

      if (vtRes.status === 404) {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ error: 'File not found in VirusTotal database', hash, permalink: 'https://www.virustotal.com/gui/file/' + hash }));
        return;
      }

      if (vtRes.status === 200) {
        const data = await vtRes.json();
        const stats = data.data?.attributes?.last_analysis_stats || {};
        const scans = data.data?.attributes?.last_analysis_results || {};
        const positives = (stats.malicious || 0) + (stats.suspicious || 0);
        const total = Object.keys(scans).length;

        // Only include detected engines in response
        const detectedScans = {};
        for (const [engine, result] of Object.entries(scans)) {
          if (result.category === 'malicious' || result.category === 'suspicious') {
            detectedScans[engine] = { detected: true, result: result.result || result.category };
          }
        }

        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({
          positives, total, scans: detectedScans, hash,
          permalink: 'https://www.virustotal.com/gui/file/' + hash
        }));
      } else {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ error: 'VT API error: ' + vtRes.status, hash }));
      }
    }).catch(e => {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: 'Request failed: ' + (e.message || '').substring(0,80), hash }));
    });
    return;
  }

  // POST /convert — convert/resize file using ffmpeg/ImageMagick
  if (url.pathname === '/convert' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { path: filePath, format, width, height, quality, resolution } = JSON.parse(body);
        if (!filePath || !format) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'missing path/format'})); return; }

        const fullPath = '/srv' + filePath;
        if (!fs.existsSync(fullPath)) { res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'file not found'})); return; }

        const ext = path.extname(fullPath).slice(1).toLowerCase();
        const base = path.basename(fullPath, path.extname(fullPath));
        const dir = path.dirname(fullPath);
        const outName = `${base}_converted.${format}`;
        const outPath = path.join(dir, outName);

        const isImage = ['jpg','jpeg','png','gif','webp','svg','bmp','avif','tiff'].includes(ext);
        const isVideo = ['mp4','webm','mkv','avi','mov','m4v','ogv'].includes(ext);
        const isAudio = ['mp3','wav','flac','ogg','m4a','aac','wma'].includes(ext);

        const { execFile } = require('child_process');

        if (isImage) {
          // Use ffmpeg for image conversion (works for all formats)
          let args = ['-y', '-i', fullPath];
          if (width && height) args.push('-vf', `scale=${width}:${height}`);
          else if (width) args.push('-vf', `scale=${width}:-1`);
          else if (height) args.push('-vf', `scale=-1:${height}`);
          if (quality && format !== 'png') {
            if (format === 'jpg' || format === 'jpeg') args.push('-q:v', String(Math.round((100-parseInt(quality))/3.3 + 1)));
            else if (format === 'webp') args.push('-quality', String(quality));
          }
          args.push(outPath);

          execFile('ffmpeg', args, { timeout: 30000 }, (err) => {
            if (err) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false, error:err.message.substring(0,100)})); return; }
            const stat = fs.statSync(outPath);
            const size = stat.size > 1048576 ? (stat.size/1048576).toFixed(1)+'MB' : (stat.size/1024).toFixed(0)+'KB';
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ok:true, output:outName, size}));
          });
        } else if (isVideo) {
          let args = ['-y', '-i', fullPath];
          if (resolution) args.push('-vf', `scale=${resolution.replace(':',':')}`);
          if (quality) {
            const crf = Math.round(51 - (parseInt(quality) / 100 * 40));
            args.push('-crf', String(crf));
          }
          if (format === 'gif') args.push('-vf', (resolution ? `scale=${resolution},` : '') + 'fps=15', '-loop', '0');
          else args.push('-c:a', 'copy');
          args.push(outPath);

          execFile('ffmpeg', args, { timeout: 300000 }, (err) => {
            if (err) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false, error:err.message.substring(0,100)})); return; }
            const stat = fs.statSync(outPath);
            const size = stat.size > 1048576 ? (stat.size/1048576).toFixed(1)+'MB' : (stat.size/1024).toFixed(0)+'KB';
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ok:true, output:outName, size}));
          });
        } else if (isAudio) {
          let args = ['-y', '-i', fullPath];
          if (quality && (format === 'mp3' || format === 'ogg')) {
            const bitrate = Math.round(parseInt(quality) * 3.2); // 10=32kbps, 100=320kbps
            args.push('-b:a', bitrate + 'k');
          }
          args.push(outPath);

          execFile('ffmpeg', args, { timeout: 120000 }, (err) => {
            if (err) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false, error:err.message.substring(0,100)})); return; }
            const stat = fs.statSync(outPath);
            const size = stat.size > 1048576 ? (stat.size/1048576).toFixed(1)+'MB' : (stat.size/1024).toFixed(0)+'KB';
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ok:true, output:outName, size}));
          });
        } else {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, error:'Unsupported file type'}));
        }
      } catch(e) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    });
    return;
  }

  // POST /clip — clip video segment using ffmpeg
  if (url.pathname === '/clip' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { path: filePath, start, end } = JSON.parse(body);
        if (!filePath || !start || !end) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'missing path/start/end'})); return; }

        const fullPath = '/srv' + filePath;
        if (!fs.existsSync(fullPath)) { res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'file not found'})); return; }

        // Generate output filename: original_clip_start-end.ext
        const ext = path.extname(fullPath);
        const base = path.basename(fullPath, ext);
        const dir = path.dirname(fullPath);
        const safeStart = start.replace(/[:.]/g, '');
        const safeEnd = end.replace(/[:.]/g, '');
        const outName = `${base}_clip_${safeStart}-${safeEnd}${ext}`;
        const outPath = path.join(dir, outName);

        // Run ffmpeg with stream copy (fast, no re-encoding)
        const { execFile } = require('child_process');
        execFile('ffmpeg', ['-y', '-ss', start, '-to', end, '-i', fullPath, '-c', 'copy', '-avoid_negative_ts', 'make_zero', outPath], { timeout: 60000 }, (err, stdout, stderr) => {
          if (err) {
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ok:false, error: 'ffmpeg error: ' + (err.message || '').substring(0,100)}));
            return;
          }
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true, output: outName}));
        });
      } catch(e) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

// Detect link type
// Clean URL — strip tracking params, normalize to canonical form
function cleanUrl(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());

    // Instagram: remove igsh, utm_*, img_index, etc — keep only the path
    if (u.hostname.includes('instagram.com')) {
      // Strip all query params for IG — they're all tracking/sharing junk
      return u.origin + u.pathname.replace(/\/+$/, '') + '/';
    }

    // YouTube: keep v= and t=, remove everything else (si=, feature=, etc)
    if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) {
      if (u.hostname.includes('youtu.be')) {
        // Short URL: https://youtu.be/ID?si=xxx&t=45 → https://www.youtube.com/watch?v=ID&t=45
        const videoId = u.pathname.slice(1);
        const t = u.searchParams.get('t');
        let clean = 'https://www.youtube.com/watch?v=' + videoId;
        if (t) clean += '&t=' + t;
        return clean;
      }
      // Full URL: keep v= and t= only
      const v = u.searchParams.get('v');
      const t = u.searchParams.get('t');
      const list = u.searchParams.get('list');
      if (v) {
        let clean = u.origin + '/watch?v=' + v;
        if (t) clean += '&t=' + t;
        if (list) clean += '&list=' + list;
        return clean;
      }
      // Playlist or channel URL — return as-is with cleaned params
      return u.origin + u.pathname;
    }

    // Twitter/X: remove tracking params
    if (u.hostname.includes('twitter.com') || u.hostname.includes('x.com')) {
      return u.origin + u.pathname;
    }

    // TikTok: remove query params (tracking)
    if (u.hostname.includes('tiktok.com')) {
      return u.origin + u.pathname;
    }

    // Generic: remove common tracking params
    const trackingParams = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','gclid','ref','si','feature','igsh','igshid'];
    trackingParams.forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch(e) {
    return rawUrl.trim();
  }
}

function detectLink(link, res) {
  // Clean URL — remove tracking params, normalize
  link = cleanUrl(link);
  const lc = link.toLowerCase();

  // Baidu Pan — needs headless browser to extract files
  if (lc.includes('pan.baidu.com') || lc.includes('baidu.com/s/')) {
    // Extract password from URL if present (?pwd=xxxx)
    let pwd = '';
    try { pwd = new URL(link).searchParams.get('pwd') || ''; } catch(e) {}
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ type: 'baidu', title: 'Baidu Pan Link', pwd, formats: [{id:'best',label:'Download all files'}], note: 'Baidu Pan downloads use headless browser extraction. May be slow.' }));
    return;
  }

  // Google Drive / Dropbox — yt-dlp handles these natively
  if (lc.includes('drive.google.com') || lc.includes('docs.google.com')) {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ type: 'direct', title: 'Google Drive File', formats: [{id:'direct',label:'Download file'}] }));
    return;
  }
  if (lc.includes('dropbox.com')) {
    // Convert dropbox share link to direct download
    const directLink = link.replace('dl=0', 'dl=1').replace('www.dropbox.com', 'dl.dropboxusercontent.com');
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ type: 'direct', title: 'Dropbox File', formats: [{id:'direct',label:'Download file'}], directLink }));
    return;
  }

  // Instagram — special handling
  if (lc.includes('instagram.com')) {
    const instaType = lc.includes('/stories/') ? 'story' :
                      lc.includes('/reel/') ? 'reel' :
                      lc.includes('/p/') ? 'post' :
                      lc.match(/instagram\.com\/[^\/]+\/?$/) ? 'profile' : 'post';

    if (instaType === 'profile') {
      // Cookie rotation — pick a random account cookie file
        const cookieFiles = (() => {
          try {
            const fs2 = require('fs');
            return fs2.readdirSync('/app/cookies/').filter(f => f.startsWith('account_') && f.endsWith('.txt')).map(f => '/app/cookies/' + f);
          } catch(e) { return []; }
        })();
        const cookieFile = cookieFiles.length > 0
          ? cookieFiles[Math.floor(Math.random() * cookieFiles.length)]
          : '/app/cookies/instagram.txt';
      const cookieExists = fs.existsSync(cookieFile);

      // Try to fetch profile info (avatar, username, fullname)
      let profileInfo = { title: 'Instagram Profile', thumbnail: null, username: '' };
      if (cookieExists) {
        try {
          const { execFileSync } = require('child_process');
          // Get avatar/profile pic
          const avatarOut = execFileSync('gallery-dl', ['--config', '/app/gallery-dl.conf', '--cookies', cookieFile, '--dump-json', link + 'avatar/'], { timeout: 15000, maxBuffer: 1024*1024, encoding: 'utf8' });
          const avatarData = JSON.parse(avatarOut);
          for (const item of avatarData) {
            if (Array.isArray(item) && item[1] && typeof item[1] === 'string' && item[1].startsWith('http')) {
              profileInfo.thumbnail = item[1];
            }
            if (Array.isArray(item) && item[2] && item[2].fullname) {
              profileInfo.title = item[2].fullname;
              profileInfo.username = item[2].username || '';
            }
          }
        } catch(e) {}
      }

      // Extract username from URL as fallback
      if (!profileInfo.username) {
        const match = link.match(/instagram\.com\/([^\/\?]+)/);
        if (match) { profileInfo.username = match[1]; profileInfo.title = '@' + match[1]; }
      }

      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ type: 'instagram', subtype: 'profile', title: profileInfo.title, thumbnail: profileInfo.thumbnail, username: profileInfo.username, formats: [
        {id:'posts',label:'Posts'},
        {id:'reels',label:'Reels'},
        {id:'stories',label:'Stories'},
        {id:'highlights',label:'Highlights'},
        {id:'all',label:'Everything'},
      ], note: cookieExists ? null : 'Login cookies required.' }));
      return;
    }

    // For single post/reel/story — fetch info with gallery-dl (more reliable than yt-dlp for IG)
    // Cookie rotation — pick a random account cookie file
        const cookieFiles = (() => {
          try {
            const fs2 = require('fs');
            return fs2.readdirSync('/app/cookies/').filter(f => f.startsWith('account_') && f.endsWith('.txt')).map(f => '/app/cookies/' + f);
          } catch(e) { return []; }
        })();
        const cookieFile = cookieFiles.length > 0
          ? cookieFiles[Math.floor(Math.random() * cookieFiles.length)]
          : '/app/cookies/instagram.txt';
    const cookieExists = fs.existsSync(cookieFile);
    if (cookieExists) {
      const proc = execFile('gallery-dl', ['--config', '/app/gallery-dl.conf', '--cookies', cookieFile, '--dump-json', '--range', '1-1', link], { timeout: 20000, maxBuffer: 5*1024*1024 }, (err, stdout) => {
        if (err || !stdout) {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ type: 'instagram', subtype: instaType, title: 'Instagram ' + instaType, formats: [{id:'bestvideo+bestaudio/best',label:'Video (best)'},{id:'bestaudio',label:'Audio only'}] }));
          return;
        }
        try {
          const data = JSON.parse(stdout);
          let title = 'Instagram ' + instaType, thumbnail = null, duration = null;
          if (data && data[0]) {
            const meta = (data[0][2] || data[0]);
            title = (meta.description || '').substring(0, 60) || '@' + (meta.username || 'unknown');
            thumbnail = meta.display_url || meta.profile_pic_url || null;
            duration = meta.duration || null;
          }
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ type: 'instagram', subtype: instaType, title, thumbnail, duration, formats: [{id:'bestvideo+bestaudio/best',label:'Video (best)'},{id:'bestaudio',label:'Audio only'}] }));
        } catch(e) {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ type: 'instagram', subtype: instaType, title: 'Instagram ' + instaType, formats: [{id:'bestvideo+bestaudio/best',label:'Video (best)'}] }));
        }
      });
    } else {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ type: 'instagram', subtype: instaType, title: 'Instagram ' + instaType, formats: [{id:'bestvideo+bestaudio/best',label:'Video (best)'},{id:'bestaudio',label:'Audio only'}], note: 'Login cookies required for full access.' }));
    }
    return;
  }

  // Website (not a known media site)
  const mediaSites = ['youtube','youtu.be','twitter','x.com','tiktok','bilibili','vimeo','dailymotion','twitch','soundcloud','spotify'];
  const isMedia = mediaSites.some(s => lc.includes(s));

  if (!isMedia && (lc.startsWith('http://') || lc.startsWith('https://'))) {
    // Check if URL points directly to a media file
    let urlPath = '';
    try { urlPath = new URL(link).pathname.toLowerCase(); } catch(e) {}
    const mediaExts = ['.mp4','.webm','.mkv','.avi','.mov','.mp3','.flac','.wav','.ogg','.m4a','.aac','.jpg','.jpeg','.png','.gif','.webp','.svg','.zip','.rar','.7z','.tar','.gz','.bz2','.m3u8','.ts','.iso','.dmg','.exe','.msi','.apk','.deb','.rpm','.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.txt','.csv','.json','.xml'];
    const ext = path.extname(urlPath);
    if (mediaExts.includes(ext)) {
      // Direct media file or stream
      const isStream = ext === '.m3u8' || ext === '.ts';
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ type: isStream ? 'video' : 'direct', title: path.basename(urlPath) || 'download', formats: isStream ? [{id:'bestvideo+bestaudio/best',label:'Best quality'},{id:'bestaudio',label:'Audio only'}] : [{id:'direct',label:'Direct download'}] }));
      return;
    }

    // Try yt-dlp generic extractor on this URL (catches embedded videos on unknown sites)
    const proc = execFile('yt-dlp', ['--dump-json', '--no-download', link], { timeout: 15000, maxBuffer: 10*1024*1024 }, (err, stdout) => {
      if (!err && stdout) {
        try {
          const info = JSON.parse(stdout);
          const formats = (info.formats || []).filter(f => f.vcodec !== 'none' || f.acodec !== 'none').map(f => ({
            id: f.format_id, label: `${f.resolution || f.format_note || '?'} ${f.ext} ${f.filesize ? (f.filesize/1024/1024).toFixed(1)+'MB' : ''}`.trim(),
          })).slice(-10);
          formats.push({id:'bestvideo+bestaudio/best',label:'Best video + audio (mp4)'});
          formats.push({id:'bestaudio',label:'Audio only'});
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ type: 'video', title: info.title || link, thumbnail: info.thumbnail, duration: info.duration, formats: formats.reverse() }));
          return;
        } catch(e) {}
      }
      // yt-dlp failed — fall back to website mode
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ type: 'website', title: link, formats: [{id:'text',label:'Save as text (for AI)'},{id:'archive',label:'Download full site (zip)'}] }));
    });
    return;
  }

  // Use yt-dlp to detect formats (known media sites)
  const proc = execFile('yt-dlp', ['--dump-json', '--no-download', link], { timeout: 30000, maxBuffer: 10*1024*1024 }, (err, stdout) => {
    if (err) {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ type: 'unknown', title: link, error: 'Could not detect: ' + (err.message||'').substring(0,100), formats: [{id:'best',label:'Best quality'}] }));
      return;
    }
    try {
      const info = JSON.parse(stdout);
      const formats = (info.formats || [])
        .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
        .map(f => ({
          id: f.format_id,
          label: `${f.resolution || f.format_note || '?'} ${f.ext} ${f.filesize ? (f.filesize/1024/1024).toFixed(1)+'MB' : ''}`.trim(),
          ext: f.ext,
          size: f.filesize || 0,
          hasVideo: f.vcodec !== 'none',
          hasAudio: f.acodec !== 'none',
        }))
        .slice(-15); // last 15 (best quality last)
      formats.push({id:'bestvideo+bestaudio/best',label:'Best video + audio (mp4)'});
      formats.push({id:'bestaudio',label:'Audio only (mp3)'});
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ type: 'video', title: info.title || link, thumbnail: info.thumbnail, duration: info.duration, formats: formats.reverse() }));
    } catch(e) {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ type: 'video', title: link, formats: [{id:'best',label:'Best quality'}] }));
    }
  });
}

// Start download
function startDownload(jobId, link, format, savePath, type, mergeFormat) {
  const destDir = path.join(DOWNLOAD_ROOT, savePath);
  fs.mkdirSync(destDir, { recursive: true });

  if (type === 'baidu') {
    // Baidu Pan — use headless browser to extract and download
    // This calls our browser-service API to navigate, enter password, and get download links
    const http = require('http');

// Residential proxy for Instagram API calls
const PROXY_URL = 'http://USER:CHANGE_ME@PROXY_HOST:63030';
const PROXY_URL2 = 'http://USER:CHANGE_ME@PROXY_HOST:63031';
function getProxyAgent() {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  return new HttpsProxyAgent(Math.random() > 0.5 ? PROXY_URL : PROXY_URL2);
}
    const pwd = format || ''; // password passed via format field
    jobs[jobId].filename = 'Extracting Baidu links...';

    (async () => {
      try {
        // Create browser session
        const sessionRes = await _httpPost('http://browser-service:3004/session', {});
        const sessionId = sessionRes.sessionId;
        if (!sessionId) { jobs[jobId].status = 'error'; jobs[jobId].error = 'Failed to create browser session'; return; }

        // Navigate to Baidu link
        await _httpPost('http://browser-service:3004/browse', { sessionId, url: link, waitFor: 'networkidle' });
        await new Promise(r => setTimeout(r, 2000));

        // If password is needed, enter it
        if (pwd) {
          await _httpPost('http://browser-service:3004/type', { sessionId, selector: 'input[type="text"]', text: pwd });
          await _httpPost('http://browser-service:3004/click', { sessionId, text: '提取文件' });
          await new Promise(r => setTimeout(r, 3000));
        }

        // Get the page content to find file names
        const textRes = await _httpPost('http://browser-service:3004/text', { sessionId });
        const pageText = textRes.text || '';

        // Try to find and click download button
        await _httpPost('http://browser-service:3004/click', { sessionId, text: '下载' });
        await new Promise(r => setTimeout(r, 2000));

        // Get cookies for direct download
        const cookieRes = await _httpGet(`http://browser-service:3004/cookies/${sessionId}`);
        const cookies = (cookieRes.cookies || []).map(c => `${c.name}=${c.value}`).join('; ');

        // Try to extract download URL from page
        const evalRes = await _httpPost('http://browser-service:3004/evaluate', {
          sessionId,
          script: "Array.from(document.querySelectorAll('a[href*=\"download\"], a[href*=\"d.pcs.baidu.com\"]')).map(a=>a.href).join('|')"
        });

        const downloadUrls = (evalRes.result || '').split('|').filter(u => u.startsWith('http'));

        // Close session
        await _httpDelete(`http://browser-service:3004/session/${sessionId}`);

        if (downloadUrls.length) {
          // Download each file
          let fileCount = 0;
          for (const dlUrl of downloadUrls) {
            const fname = decodeURIComponent(path.basename(new URL(dlUrl).pathname)) || `baidu_file_${fileCount}`;
            const dest = path.join(destDir, fname);
            const proc = spawn('wget', ['-O', dest, '--header', `Cookie: ${cookies}`, '-q', dlUrl]);
            await new Promise(r => proc.on('close', r));
            fileCount++;
          }
          jobs[jobId].status = 'done';
          jobs[jobId].filename = fileCount + ' file(s) downloaded';
        } else {
          // Fallback: note what we found
          jobs[jobId].status = 'error';
          jobs[jobId].error = 'Could not extract download links. Baidu may require SVIP account for large files. Page content: ' + pageText.substring(0, 100);
        }
      } catch(e) {
        jobs[jobId].status = 'error';
        jobs[jobId].error = 'Baidu extraction failed: ' + e.message;
      }
    })();
    return;
  }

  if (type === 'direct') {
    // Direct file download with aria2c or wget
    const filename = path.basename(new URL(link).pathname) || 'download';
    const dest = path.join(destDir, filename);
    const proc = spawn('wget', ['-O', dest, '-q', '--show-progress', link]);
    jobs[jobId].proc = proc;
    proc.on('close', code => {
      jobs[jobId].status = code === 0 ? 'done' : 'error';
      jobs[jobId].filename = filename;
      if (code !== 0) jobs[jobId].error = 'Download failed';
    });
    return;
  }

  if (type === 'instagram') {
    // Use gallery-dl for Instagram with cookies + config for human-like delays
    // Cookie rotation — pick a random account cookie file
        const cookieFiles = (() => {
          try {
            const fs2 = require('fs');
            return fs2.readdirSync('/app/cookies/').filter(f => f.startsWith('account_') && f.endsWith('.txt')).map(f => '/app/cookies/' + f);
          } catch(e) { return []; }
        })();
        const cookieFile = cookieFiles.length > 0
          ? cookieFiles[Math.floor(Math.random() * cookieFiles.length)]
          : '/app/cookies/instagram.txt';
    const configArgs = fs.existsSync('/app/gallery-dl.conf') ? ['--config', '/app/gallery-dl.conf'] : [];
    const cookieArgs = fs.existsSync(cookieFile) ? ['--cookies', cookieFile] : [];
    // format field may contain range like "1,3,5" for selected items
    const rangeArgs = format && /^[\d,\-]+$/.test(format) ? ['--range', format] : [];
    // Filename: username_type_date_num.ext
    const args = [...configArgs, '-d', destDir, '--filename', '{username}_{subcategory}_{date:%Y%m%d}_{num}.{extension}', ...cookieArgs, ...rangeArgs, link];
    const proc = spawn('gallery-dl', args);
    jobs[jobId].proc = proc;
    let fileCount = 0;
    proc.stdout.on('data', data => {
      const line = data.toString();
      if (line.includes('/')) fileCount++;
      jobs[jobId].progress = fileCount;
      jobs[jobId].filename = fileCount + ' files';
    });
    proc.stderr.on('data', data => {
      const line = data.toString();
      if (line.includes('ERROR') || line.includes('error')) jobs[jobId].error = line.substring(0, 200);
    });
    proc.on('close', code => {
      jobs[jobId].status = code === 0 ? 'done' : (fileCount > 0 ? 'done' : 'error');
      jobs[jobId].filename = fileCount + ' files downloaded';
      if (code !== 0 && !fileCount && !jobs[jobId].error) jobs[jobId].error = 'gallery-dl failed';
    });
    return;
  }

  if (type === 'website') {
    if (format === 'text') {
      // Simple text extraction
      const proc = execFile('wget', ['-qO-', link], { timeout: 15000, maxBuffer: 5*1024*1024 }, (err, stdout) => {
        if (err) { jobs[jobId].status = 'error'; jobs[jobId].error = err.message; return; }
        // Strip HTML tags for text
        const text = stdout.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const filename = 'page_' + Date.now() + '.txt';
        fs.writeFileSync(path.join(destDir, filename), text);
        jobs[jobId].status = 'done';
        jobs[jobId].filename = filename;
      });
      jobs[jobId].proc = proc;
    } else {
      // Full site archive
      const dirname = 'site_' + Date.now();
      const proc = spawn('wget', ['--mirror', '--convert-links', '--page-requisites', '--no-parent', '-P', path.join(destDir, dirname), link], { timeout: 60000 });
      jobs[jobId].proc = proc;
      proc.on('close', code => {
        jobs[jobId].status = code === 0 || code === 8 ? 'done' : 'error';
        jobs[jobId].filename = dirname;
      });
    }
    return;
  }

  // Video/audio download with yt-dlp
  let formatArg = format || 'bestvideo+bestaudio/best';
  if (formatArg === 'best') formatArg = 'bestvideo+bestaudio/best';
  const outFormat = mergeFormat || 'mp4';
  const mergeArgs = formatArg.includes('+') ? ['--merge-output-format', outFormat] : [];
  const audioArgs = formatArg === 'bestaudio' ? ['--extract-audio', '--audio-format', outFormat] : [];
  // Cookie rotation — pick a random account cookie file
        const cookieFiles = (() => {
          try {
            const fs2 = require('fs');
            return fs2.readdirSync('/app/cookies/').filter(f => f.startsWith('account_') && f.endsWith('.txt')).map(f => '/app/cookies/' + f);
          } catch(e) { return []; }
        })();
        const cookieFile = cookieFiles.length > 0
          ? cookieFiles[Math.floor(Math.random() * cookieFiles.length)]
          : '/app/cookies/instagram.txt';
  const cookieArgs = (link.includes('instagram.com') && fs.existsSync(cookieFile)) ? ['--cookies', cookieFile] : [];
  const args = ['-f', formatArg, ...mergeArgs, ...audioArgs, ...cookieArgs, '--no-playlist', '-o', path.join(destDir, '%(title)s.%(ext)s'), '--newline', link];
  const proc = spawn('yt-dlp', args);
  jobs[jobId].proc = proc;

  proc.stdout.on('data', data => {
    const line = data.toString();
    const pctMatch = line.match(/(\d+\.?\d*)%/);
    if (pctMatch) jobs[jobId].progress = parseFloat(pctMatch[1]);
    const fnMatch = line.match(/Destination:\s*(.+)/);
    if (fnMatch) jobs[jobId].filename = path.basename(fnMatch[1]);
  });
  proc.stderr.on('data', data => {
    const line = data.toString();
    if (line.includes('ERROR')) jobs[jobId].error = line.substring(0, 200);
  });
  proc.on('close', code => {
    jobs[jobId].status = code === 0 ? 'done' : 'error';
    if (code !== 0 && !jobs[jobId].error) jobs[jobId].error = 'yt-dlp exit code ' + code;
  });
}

// Cleanup old jobs
setInterval(() => { const now = Date.now(); for (const id in jobs) { if (now - jobs[id].startTime > 3600000) delete jobs[id]; } }, 60000);

server.listen(PORT, () => console.log('Resolver service on :' + PORT));
