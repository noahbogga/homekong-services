const http = require('http');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3003;
const DOWNLOAD_ROOT = '/srv'; // filebrowser data root
const MAX_VPS_SIZE = 2 * 1024 * 1024 * 1024; // 2GB threshold for VPS proxy

// Job store
const jobs = {};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // POST /detect — detect link type and available formats
  if (url.pathname === '/detect' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
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
    req.on('end', () => {
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
    req.on('end', () => {
      try {
        const { link, category, range } = JSON.parse(body);
        const cookieFile = '/app/cookies/instagram.txt';
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

        const rangeArg = range || '1-5';
        const proc = execFile('gallery-dl', ['--cookies', cookieFile, '--dump-json', '--range', rangeArg, targetUrl], { timeout: 45000, maxBuffer: 20*1024*1024 }, (err, stdout) => {
          if (err || !stdout) {
            const errMsg = err ? err.message.substring(0,150) : 'empty';
            // Check if it's a "no items" vs actual error
            if (errMsg.includes('No results') || errMsg.includes('HttpError')) {
              res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({items:[], hasMore:false, note:'No content available for this category'})); return;
            }
            res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({items:[], error: errMsg})); return;
          }
          try {
            const data = JSON.parse(stdout);
            // Group items by post_shortcode (carousels share the same shortcode)
            const postMap = {};
            for (const entry of data) {
              if (!Array.isArray(entry) || entry.length < 3) continue;
              const meta = entry[2];
              if (!meta || typeof meta !== 'object') continue;
              if (entry[0] === 6) continue; // skip directory entries
              const shortcode = meta.post_shortcode || meta.shortcode || ('single_' + items.length);
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
              // If first item is image but later ones are video, mark as mixed
              if (meta.video_url && postMap[shortcode].type === 'image') postMap[shortcode].type = 'mixed';
            }
            const items = Object.values(postMap);
            // Determine if there's likely more
            const requestedCount = parseInt((rangeArg.split('-')[1] || '10')) - parseInt((rangeArg.split('-')[0] || '1')) + 1;
            const hasMore = items.length >= requestedCount;

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

  // Baidu pan
  if (lc.includes('pan.baidu.com') || lc.includes('baidu.com/s/')) {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ type: 'baidu', title: 'Baidu Pan Link', formats: [] }));
    return;
  }

  // Instagram — special handling
  if (lc.includes('instagram.com')) {
    const instaType = lc.includes('/stories/') ? 'story' :
                      lc.includes('/reel/') ? 'reel' :
                      lc.includes('/p/') ? 'post' :
                      lc.match(/instagram\.com\/[^\/]+\/?$/) ? 'profile' : 'post';

    if (instaType === 'profile') {
      const cookieFile = '/app/cookies/instagram.txt';
      const cookieExists = fs.existsSync(cookieFile);

      // Try to fetch profile info (avatar, username, fullname)
      let profileInfo = { title: 'Instagram Profile', thumbnail: null, username: '' };
      if (cookieExists) {
        try {
          const { execFileSync } = require('child_process');
          // Get avatar/profile pic
          const avatarOut = execFileSync('gallery-dl', ['--cookies', cookieFile, '--dump-json', link + 'avatar/'], { timeout: 15000, maxBuffer: 1024*1024, encoding: 'utf8' });
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
    const cookieFile = '/app/cookies/instagram.txt';
    const cookieExists = fs.existsSync(cookieFile);
    if (cookieExists) {
      const proc = execFile('gallery-dl', ['--cookies', cookieFile, '--dump-json', '--range', '1-1', link], { timeout: 20000, maxBuffer: 5*1024*1024 }, (err, stdout) => {
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
    const mediaExts = ['.mp4','.webm','.mkv','.avi','.mov','.mp3','.flac','.wav','.ogg','.m4a','.jpg','.jpeg','.png','.gif','.webp','.zip','.rar','.7z','.m3u8','.ts'];
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
    // Use gallery-dl for Instagram with cookies for auth
    const cookieFile = '/app/cookies/instagram.txt';
    const cookieArgs = fs.existsSync(cookieFile) ? ['--cookies', cookieFile] : [];
    // format field may contain range like "1,3,5" for selected items
    const rangeArgs = format && /^[\d,\-]+$/.test(format) ? ['--range', format] : [];
    // Filename: username_type_date_num.ext
    const args = ['-d', destDir, '--filename', '{username}_{subcategory}_{date:%Y%m%d}_{num}.{extension}', ...cookieArgs, ...rangeArgs, link];
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
  const cookieFile = '/app/cookies/instagram.txt';
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
