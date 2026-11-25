// ===== RESOLVER — Link download/fetch tool =====
let resolverJobId = null;
let resolverPolling = null;
let _resolverActive = false;

function _resolverBeforeUnload(e) { e.preventDefault(); e.returnValue = ''; }
function _resolverSetActive(active) {
  _resolverActive = active;
  if (active) window.addEventListener('beforeunload', _resolverBeforeUnload);
  else window.removeEventListener('beforeunload', _resolverBeforeUnload);
}

function openResolver() {
  let ov = document.getElementById('resolver-overlay');
  if (ov) { ov.style.display = 'flex'; return; }

  ov = document.createElement('div');
  ov.id = 'resolver-overlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:flex-start;justify-content:center;padding-top:8vh;';
  ov.innerHTML = `<div style="background:rgba(20,22,35,0.75);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,0.1);border-radius:14px;width:92%;max-width:560px;box-shadow:0 24px 80px rgba(0,0,0,0.5);max-height:80vh;overflow-y:auto;">
    <div style="padding:16px 20px 10px;display:flex;align-items:center;gap:8px;">
      <span style="font-size:15px;">⚡</span>
      <span style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.7);flex:1;">Resolver</span>
      <span style="position:relative;display:inline-block;"><button onmouseenter="document.getElementById('resolver-info-tip').style.display='block'" onmouseleave="document.getElementById('resolver-info-tip').style.display='none'" onclick="document.getElementById('resolver-info-tip').style.display=document.getElementById('resolver-info-tip').style.display==='block'?'none':'block'" style="padding:3px 8px;border-radius:5px;border:1px solid rgba(255,255,255,0.08);background:none;color:rgba(255,255,255,0.25);font-size:9px;cursor:pointer;">?</button><div id="resolver-info-tip" style="display:none;position:absolute;top:28px;right:0;width:200px;padding:8px 10px;background:rgba(20,22,35,0.97);border:1px solid rgba(255,255,255,0.1);border-radius:6px;font-size:9px;color:rgba(255,255,255,0.5);z-index:10;backdrop-filter:blur(8px);line-height:1.4;">Supports: YouTube, Instagram, Twitter/X, TikTok, Reddit, Bilibili, direct files, websites, and 1700+ sites.<br><br>Downloads save to: Personal/Resolver/[service]/</div></span>
      <button onclick="closeResolver()" style="background:none;border:none;color:rgba(255,255,255,0.25);font-size:18px;cursor:pointer;padding:2px 6px;">✕</button>
    </div>
    <!-- Single mode -->
    <div id="resolver-single" style="padding:0 20px 12px;">
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="text" id="resolver-url" placeholder="Paste link..." style="flex:1;padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#e8edf5;font-size:15px;outline:none;transition:border-color 0.15s;" onfocus="this.style.borderColor='rgba(245,158,11,0.4)'" onblur="this.style.borderColor='rgba(255,255,255,0.08)'" onkeydown="if(event.key==='Enter')resolverDetect()">
        <button onclick="resolverDetect()" id="resolver-detect-btn" style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:10px;color:#f59e0b;font-size:18px;cursor:pointer;flex-shrink:0;transition:background 0.15s;">⚡</button>
      </div>
    </div>
    <!-- Batch mode (removed from UI) -->
    <div id="resolver-batch" style="display:none;padding:0 20px 12px;">
      <textarea id="resolver-batch-urls" rows="5" placeholder="Paste multiple links (one per line)..." style="width:100%;padding:10px 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#e8edf5;font-size:12px;outline:none;resize:none;font-family:Inter,sans-serif;line-height:1.6;margin-bottom:8px;box-sizing:border-box;" onfocus="this.style.borderColor='rgba(245,158,11,0.4)'" onblur="this.style.borderColor='rgba(255,255,255,0.08)'"></textarea>
      <div style="display:flex;gap:6px;">
        <button onclick="_resolverBatchStart('all')" style="flex:1;padding:8px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:8px;color:#f59e0b;font-size:11px;font-weight:600;cursor:pointer;">⚡ Fetch all (same settings)</button>
        <button onclick="_resolverBatchStart('each')" style="flex:1;padding:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:rgba(255,255,255,0.5);font-size:11px;cursor:pointer;">Choose per link</button>
      </div>
    </div>
    <div id="resolver-info" style="display:none;padding:0 20px;"></div>
    <div id="resolver-options" style="display:none;padding:0 20px 18px;"></div>
    <div id="resolver-progress" style="display:none;padding:0 20px 18px;"></div>
  </div>`;
  ov.addEventListener('click', e => { if (e.target === ov) closeResolver(); });
  document.body.appendChild(ov);
}

function closeResolver() {
  if (_resolverActive) {
    if (!confirm('A download is in progress. Close anyway?')) return;
    _resolverSetActive(false);
  }
  const ov = document.getElementById('resolver-overlay');
  if (ov) ov.style.display = 'none';
  if (resolverPolling) { clearInterval(resolverPolling); resolverPolling = null; }
  // Reset URL input
  const urlInput = document.getElementById('resolver-url');
  if (urlInput) urlInput.value = '';
  // Hide info/options/progress
  const info = document.getElementById('resolver-info');
  const opts = document.getElementById('resolver-options');
  const prog = document.getElementById('resolver-progress');
  if (info) info.style.display = 'none';
  if (opts) opts.style.display = 'none';
  if (prog) prog.style.display = 'none';
}

async function resolverDetect() {
  const url = document.getElementById('resolver-url').value.trim();
  if (!url) return;
  const btn = document.getElementById('resolver-detect-btn');
  btn.disabled = true; btn.style.opacity = '0.4';
  document.getElementById('resolver-info').style.display = 'none';
  document.getElementById('resolver-options').style.display = 'none';

  try {
    const res = await fetch('/resolver-api/detect', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ link: url })
    });
    const data = await res.json();
    _showResolverInfo(data, url);
  } catch(e) {
    document.getElementById('resolver-info').style.display = 'block';
    document.getElementById('resolver-info').innerHTML = `<p style="color:#ef4444;font-size:12px;">Error: ${e.message}</p>`;
  } finally {
    btn.disabled = false; btn.style.opacity = '1';
  }
}

function _showResolverInfo(data, url) {
  const info = document.getElementById('resolver-info');
  const opts = document.getElementById('resolver-options');
  info.style.display = 'block';
  opts.style.display = 'block';

  const defaultSavePath = '/.userdata/' + (localStorage.getItem('hk_user') || 'noah') + '/storage';

  // Info section
  let infoHtml = `<div style="padding:10px 12px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04);border-radius:8px;margin-bottom:10px;">`;
  if (data.type === 'instagram' && data.subtype === 'profile') {
    // Profile layout: avatar + name side by side
    infoHtml += `<div style="display:flex;align-items:center;gap:10px;">`;
    if (data.thumbnail) {
      const thumbProxy = '/resolver-api/proxy-img?url=' + encodeURIComponent(data.thumbnail);
      infoHtml += `<img src="${thumbProxy}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;flex-shrink:0;border:2px solid rgba(255,255,255,0.08);">`;
    }
    infoHtml += `<div><div style="font-size:13px;color:rgba(255,255,255,0.9);font-weight:600;">${data.title || ''}</div>`;
    if (data.username) infoHtml += `<div style="font-size:10px;color:rgba(255,255,255,0.35);">@${data.username}</div>`;
    infoHtml += `</div></div>`;
  } else {
    if (data.thumbnail) infoHtml += `<img src="${data.thumbnail}" style="width:100%;max-height:100px;object-fit:cover;border-radius:6px;margin-bottom:6px;">`;
    infoHtml += `<div style="font-size:12px;color:rgba(255,255,255,0.85);font-weight:500;">${data.title || url}</div>`;
    infoHtml += `<div style="font-size:9px;color:rgba(255,255,255,0.3);margin-top:2px;">${data.type}${data.subtype ? ' · ' + data.subtype : ''} ${data.duration ? '· ' + Math.floor(data.duration/60) + ':' + String(data.duration%60).padStart(2,'0') : ''}</div>`;
  }
  if (data.note) infoHtml += `<div style="font-size:9px;color:#f59e0b;margin-top:6px;">⚠ ${data.note}</div>`;
  if (data.error) infoHtml += `<div style="font-size:9px;color:#ef4444;margin-top:4px;">${data.error}</div>`;
  infoHtml += `</div>`;
  info.innerHTML = infoHtml;

  // Instagram profile — separate UI (no video format buttons)
  if (data.type === 'instagram' && data.subtype === 'profile') {
    let igHtml = '';
    igHtml += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px;">`;
    igHtml += `<button onclick="_igLoadCategory('${url}','posts')" style="padding:6px 12px;border-radius:6px;border:1px solid rgba(168,130,255,0.25);background:rgba(168,130,255,0.06);color:rgba(168,130,255,0.8);font-size:10px;cursor:pointer;">Posts</button>`;
    igHtml += `<button onclick="_igLoadCategory('${url}','reels')" style="padding:6px 12px;border-radius:6px;border:1px solid rgba(168,130,255,0.25);background:rgba(168,130,255,0.06);color:rgba(168,130,255,0.8);font-size:10px;cursor:pointer;">Reels</button>`;
    igHtml += `<button onclick="_igLoadCategory('${url}','stories')" style="padding:6px 12px;border-radius:6px;border:1px solid rgba(168,130,255,0.25);background:rgba(168,130,255,0.06);color:rgba(168,130,255,0.8);font-size:10px;cursor:pointer;">Stories</button>`;
    igHtml += `<button onclick="_igLoadCategory('${url}','highlights')" style="padding:6px 12px;border-radius:6px;border:1px solid rgba(168,130,255,0.25);background:rgba(168,130,255,0.06);color:rgba(168,130,255,0.8);font-size:10px;cursor:pointer;">Highlights</button>`;
    igHtml += `<button onclick="_igLoadProfile('${url}')" style="padding:6px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);color:rgba(255,255,255,0.4);font-size:10px;cursor:pointer;">Profile</button>`;
    igHtml += `</div>`;
    igHtml += `<div id="ig-grid" style="max-height:250px;overflow-y:auto;"></div>`;
    igHtml += `<div id="ig-actions" style="display:none;margin-top:8px;">`;
    igHtml += `<button onclick="_igDownloadSelected('${url}')" style="width:100%;padding:10px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:8px;color:#22c55e;font-size:12px;font-weight:600;cursor:pointer;">⚡ Download Selected</button>`;
    igHtml += `</div>`;
    opts.innerHTML = igHtml;
    return;
  }

  // Instagram single post/reel — just download button, max quality
  if (data.type === 'instagram') {
    const thumbProxy = data.thumbnail ? '/resolver-api/proxy-img?url=' + encodeURIComponent(data.thumbnail) : '';
    if (thumbProxy) info.querySelector('img')?.setAttribute('src', thumbProxy);
    let igHtml = `<button onclick="resolverStartDownload('${url.replace(/'/g,"\\'")}','instagram')" style="width:100%;padding:12px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:8px;color:#22c55e;font-size:13px;font-weight:600;cursor:pointer;">⚡ Download (max quality)</button>`;
    opts.innerHTML = igHtml;
    return;
  }

  // Options section — button groups by category (for non-Instagram)
  let optsHtml = '';

  // Determine content type
  const isVideo = data.type === 'video' || data.type === 'instagram';
  const isAudio = data.type === 'audio';

  if (isVideo) {
    // 0. Quality preset (top)
    optsHtml += `<div style="margin-bottom:10px;"><label style="font-size:9px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.05em;">Quality</label>`;
    optsHtml += `<div style="display:flex;gap:4px;margin-top:4px;" id="resolver-quality-btns">`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-quality-btns','high')" data-val="high" class="_rsel" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(96,165,250,0.3);background:rgba(96,165,250,0.08);color:#60a5fa;font-size:10px;font-weight:500;cursor:pointer;">High</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-quality-btns','medium')" data-val="medium" class="_rsel" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">Medium</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-quality-btns','low')" data-val="low" class="_rsel" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">Low</button>`;
    optsHtml += `</div></div>`;

    // 1. Mode: Video or Audio
    optsHtml += `<div style="margin-bottom:10px;"><label style="font-size:9px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.05em;">Mode</label>`;
    optsHtml += `<div style="display:flex;gap:4px;margin-top:4px;" id="resolver-mode-btns">`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-mode-btns','video')" data-val="video" class="_rsel" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(34,197,94,0.3);background:rgba(34,197,94,0.08);color:#22c55e;font-size:10px;font-weight:600;cursor:pointer;">Video</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-mode-btns','audio')" data-val="audio" class="_rsel" style="flex:1;padding:6px;border-radius:6px;border:1px solid rgba(255,255,255,0.08);background:none;color:rgba(255,255,255,0.4);font-size:10px;cursor:pointer;">Audio</button>`;
    optsHtml += `</div></div>`;

    // 2a. Audio format (hidden by default, shows when Audio mode selected)
    optsHtml += `<div style="margin-bottom:10px;display:none;" id="resolver-audioformat-section"><label style="font-size:9px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.05em;">Audio format</label>`;
    optsHtml += `<div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;" id="resolver-audioformat-btns">`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-audioformat-btns','mp3')" data-val="mp3" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(96,165,250,0.3);background:rgba(96,165,250,0.08);color:#60a5fa;font-size:10px;font-weight:500;cursor:pointer;">MP3</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-audioformat-btns','wav')" data-val="wav" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">WAV</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-audioformat-btns','flac')" data-val="flac" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">FLAC</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-audioformat-btns','ogg')" data-val="ogg" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">OGG</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-audioformat-btns','m4a')" data-val="m4a" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">M4A</button>`;
    optsHtml += `</div></div>`;

    // 2b. Video file type
    optsHtml += `<div style="margin-bottom:10px;" id="resolver-filetype-section"><label style="font-size:9px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.05em;">File type</label>`;
    optsHtml += `<div style="display:flex;gap:4px;margin-top:4px;" id="resolver-filetype-btns">`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-filetype-btns','mp4')" data-val="mp4" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(96,165,250,0.3);background:rgba(96,165,250,0.08);color:#60a5fa;font-size:10px;font-weight:500;cursor:pointer;">MP4</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-filetype-btns','webm')" data-val="webm" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">WebM</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-filetype-btns','mkv')" data-val="mkv" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">MKV</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-filetype-btns','avi')" data-val="avi" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">AVI</button>`;
    optsHtml += `</div></div>`;

    // 3. Resolution
    optsHtml += `<div style="margin-bottom:10px;" id="resolver-res-section"><label style="font-size:9px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.05em;">Resolution</label>`;
    optsHtml += `<div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;" id="resolver-res-btns">`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-res-btns','best')" data-val="best" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(96,165,250,0.3);background:rgba(96,165,250,0.08);color:#60a5fa;font-size:10px;font-weight:500;cursor:pointer;">Source</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-res-btns','2160')" data-val="2160" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">4K</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-res-btns','1080')" data-val="1080" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">1080p</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-res-btns','720')" data-val="720" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">720p</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-res-btns','480')" data-val="480" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">480p</button>`;
    optsHtml += `<button onclick="_rSelBtn(this,'resolver-res-btns','360')" data-val="360" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">360p</button>`;
    optsHtml += `</div></div>`;

    // 4. Compress + misc (collapsed by default)
    optsHtml += `<div style="margin-bottom:10px;"><button onclick="document.getElementById('resolver-misc').style.display=document.getElementById('resolver-misc').style.display==='none'?'block':'none'" style="font-size:9px;color:rgba(255,255,255,0.25);background:none;border:none;cursor:pointer;padding:0;">▸ More options</button>`;
    optsHtml += `<div id="resolver-misc" style="display:none;margin-top:6px;">`;
    optsHtml += `<div style="display:flex;gap:4px;flex-wrap:wrap;">`;
    optsHtml += `<button onclick="this.classList.toggle('_ractive');this.style.borderColor=this.classList.contains('_ractive')?'rgba(245,158,11,0.4)':'rgba(255,255,255,0.06)';this.style.color=this.classList.contains('_ractive')?'#f59e0b':'rgba(255,255,255,0.35)'" id="resolver-compress" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">Compress</button>`;
    optsHtml += `<button onclick="this.classList.toggle('_ractive');this.style.borderColor=this.classList.contains('_ractive')?'rgba(245,158,11,0.4)':'rgba(255,255,255,0.06)';this.style.color=this.classList.contains('_ractive')?'#f59e0b':'rgba(255,255,255,0.35)'" id="resolver-zip" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.35);font-size:10px;cursor:pointer;">Zip after</button>`;
    optsHtml += `</div></div></div>`;

  } else if (data.formats && data.formats.length) {
    // Non-video: simple format select for other types
    optsHtml += `<div style="margin-bottom:10px;"><label style="font-size:9px;color:rgba(255,255,255,0.3);text-transform:uppercase;">Format</label>`;
    optsHtml += `<div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;" id="resolver-format-btns">`;
    data.formats.forEach((f,i) => {
      const active = i === 0;
      optsHtml += `<button onclick="_rSelBtn(this,'resolver-format-btns','${f.id}')" data-val="${f.id}" class="_rsel" style="padding:5px 10px;border-radius:6px;border:1px solid ${active?'rgba(96,165,250,0.3)':'rgba(255,255,255,0.06)'};background:${active?'rgba(96,165,250,0.08)':'none'};color:${active?'#60a5fa':'rgba(255,255,255,0.35)'};font-size:10px;cursor:pointer;">${f.label}</button>`;
    });
    optsHtml += `</div></div>`;
  }

  // Save location (always Resolver folder, auto-organized)
  optsHtml += `<div style="margin-bottom:12px;padding:8px 10px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04);border-radius:6px;">`;
  optsHtml += `<div style="font-size:9px;color:rgba(255,255,255,0.3);">Saves to: <span style="color:rgba(96,165,250,0.6);">Personal/Resolver/[service]/</span></div>`;
  optsHtml += `</div>`;

  // Download buttons
  optsHtml += `<div style="display:flex;gap:6px;">`;
  optsHtml += `<button onclick="resolverStartDownload('${url.replace(/'/g,"\'")}','${data.type}')" style="flex:1;padding:12px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:8px;color:#22c55e;font-size:12px;font-weight:600;cursor:pointer;">⚡ Save to Storage</button>`;
  optsHtml += `<button onclick="resolverDirectDownload('${url.replace(/'/g,"\'")}','${data.type}')" style="padding:12px 16px;background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.25);border-radius:8px;color:#60a5fa;font-size:12px;cursor:pointer;" title="Download directly to this device">⬇</button>`;
  optsHtml += `</div>`;
  opts.innerHTML = optsHtml;
}

// Button group selection helper
function _rSelBtn(btn, groupId, val) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('._rsel').forEach(b => {
    b.style.borderColor = 'rgba(255,255,255,0.06)';
    b.style.background = 'none';
    b.style.color = 'rgba(255,255,255,0.35)';
  });
  btn.style.borderColor = 'rgba(96,165,250,0.3)';
  btn.style.background = 'rgba(96,165,250,0.08)';
  btn.style.color = '#60a5fa';

  // If mode switched to audio, show audio formats and hide video options
  if (groupId === 'resolver-mode-btns') {
    const isAudio = val === 'audio';
    const ftSec = document.getElementById('resolver-filetype-section');
    const resSec = document.getElementById('resolver-res-section');
    const afSec = document.getElementById('resolver-audioformat-section');
    if (ftSec) ftSec.style.display = isAudio ? 'none' : '';
    if (resSec) resSec.style.display = isAudio ? 'none' : '';
    if (afSec) afSec.style.display = isAudio ? '' : 'none';
  }
}

function _rGetSelected(groupId) {
  const group = document.getElementById(groupId);
  if (!group) return null;
  const active = group.querySelector('._rsel[style*="96,165,250"]');
  return active ? active.dataset.val : null;
}

async function resolverStartDownload(link, type) {
  // For Baidu: pass the password extracted during detection
  if (type === 'baidu') {
    const pwd = window._resolverBaiduPwd || '';
    const savePath = getPersonalPath() + '/Resolver/BaiduYun';
    const res = await fetch('/resolver-api/download', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ link, format: pwd, savePath, type: 'baidu' })
    });
    const data = await res.json();
    if (data.jobId) { resolverJobId = data.jobId; _resolverSetActive(true); _showResolverProgress(savePath); }
    else toast('Failed: ' + (data.error||''), 'error');
    return;
  }

  // Build format string from button selections
  const mode = _rGetSelected('resolver-mode-btns') || 'video';
  const fileType = _rGetSelected('resolver-filetype-btns') || 'mp4';
  const resolution = _rGetSelected('resolver-res-btns') || 'best';
  const bitrate = _rGetSelected('resolver-bitrate-btns') || 'auto';
  const formatGeneric = _rGetSelected('resolver-format-btns');

  let format;
  if (mode === 'audio') {
    format = 'bestaudio';
  } else if (resolution === 'best') {
    format = 'bestvideo+bestaudio/best';
  } else {
    format = `bestvideo[height<=${resolution}]+bestaudio/best[height<=${resolution}]`;
  }
  // Use generic format if non-video type
  if (formatGeneric) format = formatGeneric;

  // Determine service name from URL for folder structure
  const urlObj = new URL(link);
  const host = urlObj.hostname.replace('www.','');
  let serviceName = 'Other';
  if (host.includes('youtube') || host.includes('youtu.be')) serviceName = 'YouTube';
  else if (host.includes('instagram')) serviceName = 'Instagram';
  else if (host.includes('twitter') || host.includes('x.com')) serviceName = 'Twitter';
  else if (host.includes('tiktok')) serviceName = 'TikTok';
  else if (host.includes('bilibili')) serviceName = 'Bilibili';
  else if (host.includes('reddit')) serviceName = 'Reddit';
  else if (host.includes('baidu')) serviceName = 'BaiduYun';
  else serviceName = host.split('.')[0];

  // Save path: Resolver/ServiceName/
  const savePath = getPersonalPath() + '/Resolver/' + serviceName;

  // Determine output format
  const audioFormat = _rGetSelected('resolver-audioformat-btns') || 'mp3';
  const mergeFormat = mode === 'audio' ? audioFormat : fileType;

  const res = await fetch('/resolver-api/download', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ link, format, savePath, type, mergeFormat })
  });
  const data = await res.json();
  if (data.error) { toast('Resolver error: ' + data.error, 'error'); return; }
  resolverJobId = data.jobId;
  _resolverSetActive(true);

  // Show progress
  const prog = document.getElementById('resolver-progress');
  prog.style.display = 'block';
  document.getElementById('resolver-options').style.display = 'none';
  prog.innerHTML = '<div style="text-align:center;padding:12px;"><div style="font-size:12px;color:rgba(255,255,255,0.6);">Downloading...</div><div id="resolver-pct" style="font-size:20px;color:#22c55e;font-weight:700;margin-top:6px;">0%</div><button onclick="resolverCancel()" style="margin-top:10px;padding:6px 14px;background:none;border:1px solid rgba(239,68,68,0.3);border-radius:6px;color:#ef4444;font-size:11px;cursor:pointer;">Cancel</button></div>';

  // Poll
  resolverPolling = setInterval(async () => {
    try {
      const r = await fetch('/resolver-api/job?id=' + resolverJobId);
      const j = await r.json();
      const pct = document.getElementById('resolver-pct');
      if (j.status === 'downloading') {
        if (pct) pct.textContent = Math.round(j.progress) + '%';
      } else if (j.status === 'done') {
        clearInterval(resolverPolling); resolverPolling = null; _resolverSetActive(false);
        prog.innerHTML = `<div style="text-align:center;padding:12px;"><div style="font-size:14px;color:#22c55e;font-weight:600;">✓ Downloaded</div><div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:4px;">${j.filename || ''}</div><button onclick="closeResolver();navigate('${savePath}')" style="margin-top:10px;padding:8px 16px;background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.3);border-radius:6px;color:#60a5fa;font-size:11px;cursor:pointer;">Open folder</button></div>`;
        toast('Download complete: ' + (j.filename||''), 'success');
      } else if (j.status === 'error') {
        clearInterval(resolverPolling); resolverPolling = null;
        prog.innerHTML = `<div style="text-align:center;padding:12px;"><div style="font-size:12px;color:#ef4444;">Error: ${j.error||'Failed'}</div></div>`;
      }
    } catch(e) {}
  }, 1500);
}

// Direct download to user's PC (saves to server first, then triggers browser download)
async function resolverDirectDownload(link, type) {
  toast('Preparing download...', 'info');
  // Save to temp location on server, then serve as download
  const savePath = getPersonalPath() + '/Resolver/.temp';
  const format = _rGetSelected('resolver-mode-btns') === 'audio' ? 'bestaudio' : (_rGetSelected('resolver-res-btns') === 'best' ? 'bestvideo+bestaudio/best' : 'bestvideo+bestaudio/best');
  const res = await fetch('/resolver-api/download', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ link, format, savePath, type, mergeFormat: _rGetSelected('resolver-filetype-btns') || 'mp4' })
  });
  const data = await res.json();
  if (!data.jobId) { toast('Download failed', 'error'); return; }
  // Poll until done, then trigger browser download
  const poll = setInterval(async () => {
    const r = await fetch('/resolver-api/job?id=' + data.jobId);
    const j = await r.json();
    if (j.status === 'done') {
      clearInterval(poll);
      const filename = j.filename || 'download';
      const filePath = savePath + '/' + filename;
      // Trigger browser download via filebrowser API
      const a = document.createElement('a');
      a.href = '/api/raw' + encodeURI(filePath) + '?auth=' + token;
      a.download = filename;
      a.click();
      toast('Download started: ' + filename, 'success');
    } else if (j.status === 'error') {
      clearInterval(poll);
      toast('Download failed: ' + (j.error || ''), 'error');
    }
  }, 2000);
}

function resolverCancel() {
  if (resolverJobId) fetch('/resolver-api/job?id=' + resolverJobId, { method: 'DELETE' });
  if (resolverPolling) { clearInterval(resolverPolling); resolverPolling = null; }
  document.getElementById('resolver-progress').innerHTML = '<div style="text-align:center;padding:12px;color:rgba(255,255,255,0.4);font-size:12px;">Cancelled</div>';
}

// Batch mode toggle
// ===== INSTAGRAM CATEGORY BROWSER =====
let _igSelectedItems = new Set();
let _igCurrentRange = 1;
let _igPageSize = 10;

async function _igLoadCategory(profileUrl, category) {
  const grid = document.getElementById('ig-grid');
  const actions = document.getElementById('ig-actions');
  grid.innerHTML = '<div style="padding:20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px;"><div class="hk-spinner"></div><span style="font-size:10px;color:rgba(255,255,255,0.3);">Loading</span></div>';
  actions.style.display = 'none';
  _igSelectedItems.clear();
  _igCurrentRange = 1;
  window._igItems = [];
  window._igProfileUrl = profileUrl;
  window._igCategory = category;
  await _igFetchPage(profileUrl, category, false);
}

async function _igFetchPage(profileUrl, category, append) {
  const grid = document.getElementById('ig-grid');
  const actions = document.getElementById('ig-actions');
  // For posts: request more raw items since carousels consume multiple
  const rawPageSize = (category === 'posts') ? _igPageSize * 5 : _igPageSize;
  const rangeStr = _igCurrentRange + '-' + (_igCurrentRange + rawPageSize - 1);

  if (!append) {
    grid.innerHTML = '<div style="padding:20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px;"><div class="hk-spinner"></div><span style="font-size:10px;color:rgba(255,255,255,0.3);">Loading</span></div>';
  }

  try {
    const bodyObj = { link: profileUrl, category };
    if (category !== 'highlights') bodyObj.range = rangeStr;
    const res = await fetch('/resolver-api/ig-list', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(bodyObj)
    });
    const data = await res.json();
    if (data.error) { grid.innerHTML = `<div style="padding:12px;color:#f59e0b;font-size:10px;">⚠ ${data.error}</div>`; return; }
    if (data.note) { grid.innerHTML = `<div style="padding:12px;color:rgba(255,255,255,0.4);font-size:10px;">${data.note}</div>`; return; }

    // Highlights: show as a list of highlight covers to click into
    if (data.isHighlightList && data.highlights) {
      let html = `<div style="font-size:9px;color:rgba(255,255,255,0.3);margin-bottom:10px;">${data.highlights.length} highlights</div>`;
      html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:10px;">`;
      data.highlights.forEach(hl => {
        const thumb = '/resolver-api/proxy-img?url=' + encodeURIComponent(hl.thumbnail);
        const hlId = hl.id || '';
        html += `<div onclick="_igLoadHighlight('${window._igProfileUrl}','${hl.title.replace(/'/g,"\'")}','${hlId}')" style="display:flex;flex-direction:column;align-items:center;gap:5px;cursor:pointer;transition:transform .15s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">`;
        html += `<div style="width:62px;height:62px;border-radius:50%;background:linear-gradient(135deg,#833AB4,#C13584,#E1306C,#FD1D1D,#F77737,#FCAF45);padding:2.5px;"><div style="width:100%;height:100%;border-radius:50%;background:#0a0e1a;padding:2px;"><img src="${thumb}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;"></div></div>`;
        html += `<span style="font-size:9px;color:rgba(255,255,255,0.7);text-align:center;max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;font-weight:500;">${hl.title}</span>`;
        html += `<span style="font-size:8px;color:rgba(255,255,255,0.25);">${hl.count} items</span>`;
        html += `</div>`;
      });
      html += `</div>`;
      grid.innerHTML = html;
      return;
    }

    if (!data.items || !data.items.length) {
      if (!append) grid.innerHTML = '<div style="padding:12px;color:rgba(255,255,255,0.3);font-size:10px;">No items found</div>';
      return;
    }

    // Add to stored items
    const startIdx = window._igItems.length;
    window._igItems.push(...data.items);

    // Render grid
    let html = '';
    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">`;
    html += `<span id="ig-count" style="font-size:9px;color:rgba(255,255,255,0.3);">${window._igItems.length} loaded${data.hasMore ? '+' : ''}</span>`;
    html += `<div style="display:flex;gap:6px;align-items:center;">`;
    if (data.hasMore) html += `<button onclick="_igLoadAll()" id="ig-load-all-btn" style="font-size:9px;color:rgba(96,165,250,0.7);background:none;border:none;cursor:pointer;">Load all</button>`;
    html += `<button id="ig-sel-btn" onclick="_igToggleSelectAll()" style="font-size:9px;color:rgba(168,130,255,0.6);background:none;border:none;cursor:pointer;">Select all</button>`;
    html += `</div></div>`;
    html += `<div id="ig-thumb-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:3px;">`;
    window._igItems.forEach((item, i) => {
      const thumb = '/resolver-api/proxy-img?url=' + encodeURIComponent(item.thumbnail);
      const isVid = item.type === 'video' || item.type === 'mixed';
      const isCarousel = item.mediaCount > 1;
      const selected = _igSelectedItems.has(i);
      html += `<div class="ig-item" data-idx="${i}" onclick="_igPreviewItem(${i})" style="position:relative;aspect-ratio:1;border-radius:5px;overflow:hidden;cursor:pointer;border:2px solid ${selected?'rgba(34,197,94,0.7)':'transparent'};transition:border-color .15s;">`;
      html += `<img src="${thumb}" style="width:100%;height:100%;object-fit:cover;" loading="lazy">`;
      if (isVid) html += `<span style="position:absolute;top:3px;right:3px;font-size:8px;background:rgba(0,0,0,0.6);padding:1px 4px;border-radius:2px;color:#fff;">▶</span>`;
      if (isCarousel) html += `<span style="position:absolute;top:3px;left:3px;font-size:8px;background:rgba(0,0,0,0.6);padding:1px 4px;border-radius:2px;color:#fff;">${item.mediaCount}</span>`;
      html += `<div onclick="event.stopPropagation();_igToggleItem(${i},this.parentElement)" style="position:absolute;bottom:3px;right:3px;width:18px;height:18px;border-radius:4px;border:1.5px solid ${selected?'rgba(34,197,94,0.9)':'rgba(255,255,255,0.5)'};background:${selected?'rgba(34,197,94,0.9)':'rgba(0,0,0,0.4)'};display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;cursor:pointer;z-index:2;">${selected?'✓':''}</div>`;
      html += `</div>`;
    });
    html += `</div>`;

    // Load more button
    if (data.hasMore) {
      html += `<button onclick="_igLoadMore()" id="ig-load-more" style="width:100%;margin-top:6px;padding:6px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.3);font-size:9px;cursor:pointer;">Load more...</button>`;
    }

    grid.innerHTML = html;
    // Update count
    const countEl = document.getElementById('ig-count');
    if (countEl) countEl.textContent = window._igItems.length + ' loaded' + (data.hasMore ? '+' : '');
    actions.style.display = '';
  } catch(e) {
    if (!append) grid.innerHTML = `<div style="padding:12px;color:#ef4444;font-size:10px;">Error: ${e.message}</div>`;
  }
}

async function _igLoadMore() {
  const btn = document.getElementById('ig-load-more');
  if (btn) { btn.textContent = 'Loading...'; btn.disabled = true; }
  const category = window._igCategory || 'posts';
  const rawPageSize = (category === 'posts') ? _igPageSize * 5 : _igPageSize;
  _igCurrentRange += rawPageSize;
  await new Promise(r => setTimeout(r, 1500));
  await _igFetchPage(window._igProfileUrl, category, true);
}


// Load all items with slow random delays to avoid ban
let _igLoadAllAbort = false;
async function _igLoadAll() {
  _igLoadAllAbort = false;
  const ov = document.createElement('div');
  ov.id = 'ig-loadall-overlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:300000;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;';
  ov.innerHTML = `<div style="background:rgba(20,22,35,0.9);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:28px 36px;text-align:center;min-width:240px;">
    <div class="hk-spinner hk-spinner-lg" style="margin:0 auto 14px;"></div>
    <p id="ig-loadall-status" style="font-size:12px;color:rgba(255,255,255,0.6);margin:0 0 6px;">Loading all posts...</p>
    <p id="ig-loadall-count" style="font-size:18px;color:#60a5fa;font-weight:700;margin:0 0 14px;">${window._igItems.length}</p>
    <button onclick="_igLoadAllAbort=true" style="padding:6px 16px;border-radius:6px;border:1px solid rgba(239,68,68,0.3);background:none;color:#ef4444;font-size:11px;cursor:pointer;">Cancel</button>
  </div>`;
  document.body.appendChild(ov);

  const category = window._igCategory || 'posts';
  const rawPageSize = (category === 'posts') ? _igPageSize * 5 : _igPageSize;
  let hasMore = true;
  let batch = 0;

  while (hasMore && !_igLoadAllAbort) {
    batch++;
    _igCurrentRange += rawPageSize;
    // Random delay 2-5s, extra pause every 3 batches
    const baseDelay = 2000 + Math.random() * 3000;
    const extraDelay = (batch % 3 === 0) ? 2000 + Math.random() * 3000 : 0;
    const delay = Math.round(baseDelay + extraDelay);

    const statusEl = document.getElementById('ig-loadall-status');
    const countEl = document.getElementById('ig-loadall-count');
    if (statusEl) statusEl.textContent = `Waiting ${(delay/1000).toFixed(1)}s...`;
    await new Promise(r => setTimeout(r, delay));

    if (_igLoadAllAbort) break;
    if (statusEl) statusEl.textContent = `Fetching batch ${batch}...`;

    try {
      const rangeStr = _igCurrentRange + '-' + (_igCurrentRange + rawPageSize - 1);
      const res = await fetch('/resolver-api/ig-list', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ link: window._igProfileUrl, category, range: rangeStr })
      });
      const data = await res.json();
      if (data.error) { if (statusEl) statusEl.textContent = 'Error: ' + data.error; await new Promise(r => setTimeout(r, 2000)); break; }
      if (!data.items || !data.items.length) { hasMore = false; break; }
      window._igItems.push(...data.items);
      hasMore = data.hasMore || false;
      if (countEl) countEl.textContent = window._igItems.length + ' loaded';
    } catch(e) {
      if (statusEl) statusEl.textContent = 'Network error, retrying...';
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Remove overlay
  const ovEl = document.getElementById('ig-loadall-overlay');
  if (ovEl) ovEl.remove();

  // Re-render full grid
  const grid = document.getElementById('ig-grid');
  let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">`;
  html += `<span id="ig-count" style="font-size:9px;color:rgba(255,255,255,0.3);">${window._igItems.length} loaded</span>`;
  html += `<div style="display:flex;gap:6px;align-items:center;">`;
  html += `<button id="ig-sel-btn" onclick="_igToggleSelectAll()" style="font-size:9px;color:rgba(168,130,255,0.6);background:none;border:none;cursor:pointer;">Select all</button>`;
  html += `</div></div>`;
  html += `<div id="ig-thumb-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:3px;">`;
  window._igItems.forEach((item, i) => {
    const thumb = '/resolver-api/proxy-img?url=' + encodeURIComponent(item.thumbnail);
    const isVid = item.type === 'video' || item.type === 'mixed';
    const isCarousel = (item.mediaCount || 1) > 1;
    const selected = _igSelectedItems.has(i);
    html += `<div class="ig-item" data-idx="${i}" onclick="_igPreviewItem(${i})" style="position:relative;aspect-ratio:1;border-radius:5px;overflow:hidden;cursor:pointer;border:2px solid ${selected?'rgba(34,197,94,0.7)':'transparent'};transition:border-color .15s;">`;
    html += `<img src="${thumb}" style="width:100%;height:100%;object-fit:cover;" loading="lazy">`;
    if (isVid) html += `<span style="position:absolute;top:3px;right:3px;font-size:8px;background:rgba(0,0,0,0.6);padding:1px 4px;border-radius:2px;color:#fff;">▶</span>`;
    if (isCarousel) html += `<span style="position:absolute;top:3px;left:3px;font-size:8px;background:rgba(0,0,0,0.6);padding:1px 4px;border-radius:2px;color:#fff;">${item.mediaCount}</span>`;
    html += `<div onclick="event.stopPropagation();_igToggleItem(${i},this.parentElement)" style="position:absolute;bottom:3px;right:3px;width:18px;height:18px;border-radius:4px;border:1.5px solid ${selected?'rgba(34,197,94,0.9)':'rgba(255,255,255,0.5)'};background:${selected?'rgba(34,197,94,0.9)':'rgba(0,0,0,0.4)'};display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;cursor:pointer;z-index:2;">${selected?'✓':''}</div>`;
    html += `</div>`;
  });
  html += `</div>`;
  grid.innerHTML = html;
  document.getElementById('ig-actions').style.display = '';
}

function _igPreview(imgUrl) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:200000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;cursor:pointer;';
  ov.innerHTML = `<img src="${imgUrl}" style="max-width:90%;max-height:90%;object-fit:contain;border-radius:8px;">`;
  ov.onclick = () => ov.remove();
  document.body.appendChild(ov);
}

// Preview a specific item by index (used by grid click)
function _igPreviewItem(idx) {
  const item = window._igItems[idx];
  if (!item) return;
  const thumb = '/resolver-api/proxy-img?url=' + encodeURIComponent(item.thumbnail);
  _igPreview(thumb);
}

function _igToggleItem(idx, el) {
  const checkbox = el.querySelector('[onclick*="_igToggleItem"]') || el.lastElementChild;
  if (_igSelectedItems.has(idx)) {
    _igSelectedItems.delete(idx);
    el.style.borderColor = 'transparent';
    if (checkbox) { checkbox.style.borderColor = 'rgba(255,255,255,0.5)'; checkbox.style.background = 'rgba(0,0,0,0.4)'; checkbox.textContent = ''; }
  } else {
    _igSelectedItems.add(idx);
    el.style.borderColor = 'rgba(34,197,94,0.7)';
    if (checkbox) { checkbox.style.borderColor = 'rgba(34,197,94,0.9)'; checkbox.style.background = 'rgba(34,197,94,0.9)'; checkbox.textContent = '✓'; }
  }
  // Update select all button text
  const btn = document.getElementById('ig-sel-btn');
  if (btn) btn.textContent = _igSelectedItems.size === window._igItems.length ? 'Deselect all' : 'Select all';
}

function _igToggleSelectAll() {
  const items = document.querySelectorAll('.ig-item');
  const btn = document.getElementById('ig-sel-btn');
  const allSelected = _igSelectedItems.size === window._igItems.length;

  if (allSelected) {
    // Deselect all
    _igSelectedItems.clear();
    items.forEach(el => {
      el.style.borderColor = 'transparent';
      const cb = el.querySelector('[onclick*="_igToggleItem"]');
      if (cb) { cb.style.borderColor = 'rgba(255,255,255,0.5)'; cb.style.background = 'rgba(0,0,0,0.4)'; cb.textContent = ''; }
    });
    if (btn) btn.textContent = 'Select all';
  } else {
    // Select all
    items.forEach((el, i) => {
      _igSelectedItems.add(i);
      el.style.borderColor = 'rgba(34,197,94,0.7)';
      const cb = el.querySelector('[onclick*="_igToggleItem"]');
      if (cb) { cb.style.borderColor = 'rgba(34,197,94,0.9)'; cb.style.background = 'rgba(34,197,94,0.9)'; cb.textContent = '✓'; }
    });
    if (btn) btn.textContent = 'Deselect all';
  }
}

function _igSelectAll() {
  const items = document.querySelectorAll('.ig-item');
  items.forEach((el, i) => {
    _igSelectedItems.add(i);
    el.style.borderColor = 'rgba(34,197,94,0.7)';
    const cb = el.querySelector('[onclick*="_igToggleItem"]');
    if (cb) { cb.style.borderColor = 'rgba(34,197,94,0.9)'; cb.style.background = 'rgba(34,197,94,0.9)'; cb.textContent = '✓'; }
  });
  const btn = document.getElementById('ig-sel-btn');
  if (btn) btn.textContent = 'Deselect all';
}

async function _igDownloadSelected(profileUrl) {
  if (!_igSelectedItems.size) {
    toast('Select items to download first', 'error');
    return;
  }
  const items = window._igItems || [];
  const selected = [..._igSelectedItems].map(i => items[i]).filter(Boolean);
  if (!selected.length) { toast('No items selected', 'error'); return; }

  // Save path: Resolver/Instagram/username/category/
  const username = (items[0]?.username || profileUrl.split('/').filter(Boolean).pop() || 'unknown');
  const category = window._igCategory || 'posts';
  const savePath = getPersonalPath() + '/Resolver/Instagram/' + username + '/' + category;

  toast(`Downloading ${selected.length} items...`, 'info');

  // Build range from selected posts' media items
  // Each post has mediaItems with their actual indices in the gallery-dl output
  let mediaIndices = [];
  let totalMedia = 0;
  const allItems = window._igItems || [];
  for (let i = 0; i < allItems.length; i++) {
    const post = allItems[i];
    const count = post.mediaCount || 1;
    if (_igSelectedItems.has(i)) {
      for (let n = 0; n < count; n++) mediaIndices.push(totalMedia + n + 1);
    }
    totalMedia += count;
  }
  const range = mediaIndices.join(',');
  let targetUrl = profileUrl.replace(/\/$/, '') + '/' + category + '/';

  const res = await fetch('/resolver-api/download', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ link: targetUrl, format: range, savePath, type: 'instagram' })
  });
  const data = await res.json();
  if (data.jobId) {
    // Show progress
    const prog = document.getElementById('resolver-progress');
    prog.style.display = 'block';
    document.getElementById('resolver-options').style.display = 'none';
    prog.innerHTML = `<div style="text-align:center;padding:12px;"><div style="font-size:12px;color:rgba(255,255,255,0.6);">Downloading ${selected.length} items...</div><div id="resolver-pct" style="font-size:18px;color:#22c55e;font-weight:700;margin-top:6px;">⚡</div></div>`;
    resolverJobId = data.jobId;
    resolverPolling = setInterval(async () => {
      const r = await fetch('/resolver-api/job?id=' + data.jobId);
      const j = await r.json();
      if (j.status === 'done') { clearInterval(resolverPolling); prog.innerHTML = `<div style="text-align:center;padding:12px;color:#22c55e;font-weight:600;">✓ Downloaded ${j.filename || ''}</div>`; toast('Instagram download complete','success'); }
      else if (j.status === 'error') { clearInterval(resolverPolling); prog.innerHTML = `<div style="text-align:center;padding:12px;color:#ef4444;">Error: ${j.error||''}</div>`; }
    }, 2000);
  }
}

// Load a specific highlight's contents (Layer 2 — uses direct highlight URL)
async function _igLoadHighlight(profileUrl, highlightTitle, highlightId) {
  const grid = document.getElementById('ig-grid');
  const actions = document.getElementById('ig-actions');
  grid.innerHTML = `<div style="padding:16px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px;"><div class="hk-spinner hk-spinner-sm"></div><span style="font-size:10px;color:rgba(255,255,255,0.3);">Loading ${highlightTitle}</span></div>`;
  if (actions) actions.style.display = 'none';
  window._igCategory = 'highlights';
  _igSelectedItems.clear();
  window._igItems = [];
  _igCurrentRange = 1;

  // Use direct highlight URL (much faster than crawling all highlights)
  const highlightUrl = highlightId ?
    `https://www.instagram.com/stories/highlights/${highlightId}/` :
    profileUrl.replace(/\/$/, '') + '/highlights/';

  try {
    const res = await fetch('/resolver-api/ig-list', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ link: highlightUrl, category: 'posts', range: '1-100' })
    });
    const data = await res.json();
    if (data.items && data.items.length) {
      window._igItems = data.items;
      _igRenderHighlightSplit(data.items);
      if (actions) actions.style.display = '';
    } else {
      grid.innerHTML = '<div style="padding:12px;color:rgba(255,255,255,0.3);font-size:10px;">No items in this highlight</div>';
    }
  } catch(e) {
    grid.innerHTML = `<div style="padding:12px;color:#ef4444;font-size:10px;">Error: ${e.message}</div>`;
  }
}

// Render highlight items split by type (photos on top, videos on bottom)
function _igRenderHighlightSplit(items) {
  const grid = document.getElementById("ig-grid");
  const photos = []; const videos = [];
  items.forEach((item, i) => { if (item.type === "video" || item.type === "mixed") videos.push({...item, _idx: i}); else photos.push({...item, _idx: i}); });
  let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><span id="ig-count" style="font-size:9px;color:rgba(255,255,255,0.3);">${items.length} items (${photos.length} 📷 · ${videos.length} 🎬)</span><button id="ig-sel-btn" onclick="_igToggleSelectAll()" style="font-size:9px;color:rgba(168,130,255,0.6);background:none;border:none;cursor:pointer;">Select all</button></div>`;
  if (photos.length) {
    html += `<div style="margin-bottom:10px;"><div style="font-size:9px;color:rgba(255,255,255,0.25);margin-bottom:4px;">📷 Photos (${photos.length})</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:3px;">`;
    photos.forEach(item => { const thumb = "/resolver-api/proxy-img?url=" + encodeURIComponent(item.thumbnail); const sel = _igSelectedItems.has(item._idx); html += `<div class="ig-item" data-idx="${item._idx}" onclick="_igPreviewItem(${item._idx})" style="position:relative;aspect-ratio:1;border-radius:5px;overflow:hidden;cursor:pointer;border:2px solid ${sel?"rgba(34,197,94,0.7)":"transparent"};transition:border-color .15s;"><img src="${thumb}" style="width:100%;height:100%;object-fit:cover;" loading="lazy"><div onclick="event.stopPropagation();_igToggleItem(${item._idx},this.parentElement)" style="position:absolute;bottom:3px;right:3px;width:18px;height:18px;border-radius:4px;border:1.5px solid ${sel?'rgba(34,197,94,0.9)':'rgba(255,255,255,0.5)'};background:${sel?'rgba(34,197,94,0.9)':'rgba(0,0,0,0.4)'};display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;cursor:pointer;z-index:2;">${sel?'✓':''}</div></div>`; });
    html += "</div></div>";
  }
  if (videos.length) {
    html += `<div><div style="font-size:9px;color:rgba(255,255,255,0.25);margin-bottom:4px;">🎬 Videos (${videos.length})</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:3px;">`;
    videos.forEach(item => { const thumb = "/resolver-api/proxy-img?url=" + encodeURIComponent(item.thumbnail); const sel = _igSelectedItems.has(item._idx); html += `<div class="ig-item" data-idx="${item._idx}" onclick="_igPreviewItem(${item._idx})" style="position:relative;aspect-ratio:1;border-radius:5px;overflow:hidden;cursor:pointer;border:2px solid ${sel?"rgba(34,197,94,0.7)":"transparent"};transition:border-color .15s;"><img src="${thumb}" style="width:100%;height:100%;object-fit:cover;" loading="lazy"><span style="position:absolute;top:3px;right:3px;font-size:8px;background:rgba(0,0,0,0.6);padding:1px 4px;border-radius:2px;color:#fff;">▶</span><div onclick="event.stopPropagation();_igToggleItem(${item._idx},this.parentElement)" style="position:absolute;bottom:3px;right:3px;width:18px;height:18px;border-radius:4px;border:1.5px solid ${sel?'rgba(34,197,94,0.9)':'rgba(255,255,255,0.5)'};background:${sel?'rgba(34,197,94,0.9)':'rgba(0,0,0,0.4)'};display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;cursor:pointer;z-index:2;">${sel?'✓':''}</div></div>`; });
    html += "</div></div>";
  }
  grid.innerHTML = html;
}

// Render the thumbnail grid from items array
function _igRenderGrid(items, hasMore) {
  const grid = document.getElementById('ig-grid');
  let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">`;
  html += `<span id="ig-count" style="font-size:9px;color:rgba(255,255,255,0.3);">${items.length} items</span>`;
  html += `<button id="ig-sel-btn" onclick="_igToggleSelectAll()" style="font-size:9px;color:rgba(168,130,255,0.6);background:none;border:none;cursor:pointer;">Select all</button>`;
  html += `</div>`;
  html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:3px;">`;
  items.forEach((item, i) => {
    const thumb = '/resolver-api/proxy-img?url=' + encodeURIComponent(item.thumbnail);
    const isVid = item.type === 'video' || item.type === 'mixed';
    const isCarousel = (item.mediaCount || 1) > 1;
    html += `<div class="ig-item" data-idx="${i}" onclick="_igPreviewItem(${i})" style="position:relative;aspect-ratio:1;border-radius:5px;overflow:hidden;cursor:pointer;border:2px solid transparent;transition:border-color .15s;">`;
    html += `<img src="${thumb}" style="width:100%;height:100%;object-fit:cover;" loading="lazy">`;
    if (isVid) html += `<span style="position:absolute;top:3px;right:3px;font-size:8px;background:rgba(0,0,0,0.6);padding:1px 4px;border-radius:2px;color:#fff;">▶</span>`;
    if (isCarousel) html += `<span style="position:absolute;top:3px;left:3px;font-size:8px;background:rgba(0,0,0,0.6);padding:1px 4px;border-radius:2px;color:#fff;">${item.mediaCount}</span>`;
    html += `<div onclick="event.stopPropagation();_igToggleItem(${i},this.parentElement)" style="position:absolute;bottom:3px;right:3px;width:18px;height:18px;border-radius:4px;border:1.5px solid rgba(255,255,255,0.5);background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;cursor:pointer;z-index:2;"></div>`;
    html += `</div>`;
  });
  html += `</div>`;
  if (hasMore) html += `<button onclick="_igLoadMore()" id="ig-load-more" style="width:100%;margin-top:6px;padding:6px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:none;color:rgba(255,255,255,0.3);font-size:9px;cursor:pointer;">Load more...</button>`;
  grid.innerHTML = html;
}

// Profile info button
async function _igLoadProfile(profileUrl) {
  const grid = document.getElementById('ig-grid');
  grid.innerHTML = '<div style="padding:16px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px;"><div class="hk-spinner"></div><span style="font-size:10px;color:rgba(255,255,255,0.3);">Loading profile</span></div>';
  document.getElementById('ig-actions').style.display = 'none';

  try {
    // Fetch avatar which gives us basic info
    const res = await fetch('/resolver-api/ig-list', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ link: profileUrl, category: 'avatar', range: '1-1' })
    });
    const data = await res.json();
    const username = profileUrl.match(/instagram\.com\/([^\/\?]+)/)?.[1] || '';
    let html = `<div style="padding:12px;border:1px solid rgba(255,255,255,0.04);border-radius:8px;">`;
    html += `<div style="font-size:12px;color:rgba(255,255,255,0.8);font-weight:600;margin-bottom:8px;">@${username}</div>`;
    if (data.items && data.items[0]) {
      const thumb = '/resolver-api/proxy-img?url=' + encodeURIComponent(data.items[0].thumbnail);
      html += `<div style="margin-bottom:8px;"><img src="${thumb}" style="width:60px;height:60px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,0.08);"></div>`;
    }
    html += `<button onclick="_igDownloadAvatar('${profileUrl}')" style="padding:6px 12px;border-radius:6px;border:1px solid rgba(34,197,94,0.25);background:rgba(34,197,94,0.06);color:#22c55e;font-size:10px;cursor:pointer;">⬇ Download Profile Picture</button>`;
    html += `</div>`;
    grid.innerHTML = html;
  } catch(e) {
    grid.innerHTML = `<div style="padding:12px;color:#ef4444;font-size:10px;">Error: ${e.message}</div>`;
  }
}

async function _igDownloadAvatar(profileUrl) {
  const savePath = getPersonalPath() + '/ig_avatar_' + new Date().toISOString().slice(0,10);
  const targetUrl = profileUrl.replace(/\/$/, '') + '/avatar/';
  const res = await fetch('/resolver-api/download', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ link: targetUrl, format: '1', savePath, type: 'instagram' })
  });
  const data = await res.json();
  if (data.jobId) toast('Downloading profile picture...', 'info');
}

let resolverBatchMode = false;
function _resolverToggleBulk() {
  resolverBatchMode = !resolverBatchMode;
  const btn = document.getElementById('resolver-bulk-btn');
  const single = document.getElementById('resolver-single');
  const batch = document.getElementById('resolver-batch');
  if (resolverBatchMode) {
    single.style.display = 'none';
    batch.style.display = 'block';
    btn.style.borderColor = 'rgba(245,158,11,0.4)';
    btn.style.color = '#f59e0b';
    btn.style.background = 'rgba(245,158,11,0.08)';
  } else {
    single.style.display = 'block';
    batch.style.display = 'none';
    btn.style.borderColor = 'rgba(255,255,255,0.08)';
    btn.style.color = 'rgba(255,255,255,0.3)';
    btn.style.background = 'none';
  }
}

async function _resolverBatchStart(mode) {
  const text = document.getElementById('resolver-batch-urls').value.trim();
  if (!text) return;
  const links = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
  if (!links.length) { toast('No valid links found', 'error'); return; }

  if (mode === 'each') {
    // Process one by one — put first link in single mode and let user choose
    resolverBatchMode = false;
    document.getElementById('resolver-single').style.display = 'block';
    document.getElementById('resolver-batch').style.display = 'none';
    document.getElementById('resolver-url').value = links[0];
    // Store remaining for later
    window._resolverBatchQueue = links.slice(1);
    resolverDetect();
    toast(links.length + ' links queued — processing first', 'info');
  } else {
    // Fetch all with same settings — detect first link, apply to all
    const savePath = getPersonalPath();
    toast('Fetching ' + links.length + ' links...', 'info');
    const prog = document.getElementById('resolver-progress');
    prog.style.display = 'block';
    document.getElementById('resolver-batch').style.display = 'none';
    let done = 0, fail = 0;
    prog.innerHTML = `<div style="text-align:center;padding:12px;"><div style="font-size:12px;color:rgba(255,255,255,0.6);">Processing ${links.length} links...</div><div id="resolver-batch-pct" style="font-size:18px;color:#f59e0b;font-weight:700;margin-top:6px;">0/${links.length}</div></div>`;

    for (const link of links) {
      try {
        // Detect type
        const dRes = await fetch('/resolver-api/detect', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({link}) });
        const dData = await dRes.json();
        const type = dData.type || 'video';
        // Start download
        const dlRes = await fetch('/resolver-api/download', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({link, format:'best', savePath, type}) });
        const dlData = await dlRes.json();
        if (dlData.jobId) {
          // Wait for completion
          let attempts = 0;
          while (attempts < 120) {
            await new Promise(r => setTimeout(r, 2000));
            const jRes = await fetch('/resolver-api/job?id=' + dlData.jobId);
            const j = await jRes.json();
            if (j.status === 'done') { done++; break; }
            if (j.status === 'error') { fail++; break; }
            attempts++;
          }
          if (attempts >= 120) fail++;
        } else { fail++; }
      } catch(e) { fail++; }
      const pct = document.getElementById('resolver-batch-pct');
      if (pct) pct.textContent = (done + fail) + '/' + links.length;
    }
    prog.innerHTML = `<div style="text-align:center;padding:12px;"><div style="font-size:14px;color:#22c55e;font-weight:600;">✓ Batch complete</div><div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:4px;">${done} done${fail ? ', ' + fail + ' failed' : ''}</div><button onclick="closeResolver();navigate('${savePath}')" style="margin-top:10px;padding:8px 16px;background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.3);border-radius:6px;color:#60a5fa;font-size:11px;cursor:pointer;">Open folder</button></div>`;
    toast('Batch done: ' + done + ' downloaded', 'success');
  }
}
