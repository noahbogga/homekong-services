// ===== VIEWER =====
let viewerFilePath='';let monacoEditor=null;
let viewerCurrentIdx = -1; // Track current item for nav
require.config({paths:{vs:'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs'}});

// Viewer navigation (arrow keys + swipe)
function isMediaFile(name) { const ext = name.split(".").pop().toLowerCase(); return ["jpg","jpeg","png","gif","webp","svg","bmp","avif","mp4","webm","mkv","avi","mov","m4v","mp3","wav","flac","ogg","m4a"].includes(ext); }
function viewerNext() { for (let i = viewerCurrentIdx + 1; i < items.length; i++) { if (!items[i].isDir) { openViewer(i); return; } } }
function viewerPrev() { for (let i = viewerCurrentIdx - 1; i >= 0; i--) { if (!items[i].isDir) { openViewer(i); return; } } }

// Keyboard nav in viewer
document.addEventListener('keydown', e => {
  if (!document.getElementById('viewer').classList.contains('flex')) return;
  if (editorCanvas) return; // don't nav while editing
  if (monacoEditor) return; // don't nav while in text editor
  if (e.key === 'ArrowRight') { e.preventDefault(); viewerNext(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); viewerPrev(); }
});

// Swipe detection for viewer
let _viewerTouchStartX = 0;
document.getElementById('viewer')?.addEventListener('touchstart', e => { _viewerTouchStartX = e.touches[0].clientX; }, {passive:true});
document.getElementById('viewer')?.addEventListener('touchend', e => {
  if (editorCanvas || monacoEditor) return;
  const diff = e.changedTouches[0].clientX - _viewerTouchStartX;
  if (Math.abs(diff) > 60) { if (diff > 0) viewerPrev(); else viewerNext(); }
}, {passive:true});
function getFileType(name){const ext=name.split('.').pop().toLowerCase();const img=['jpg','jpeg','png','gif','webp','svg','bmp','ico','tiff','tif','avif'];const vid=['mp4','webm','mkv','avi','mov','m4v','ogv'];const aud=['mp3','wav','flac','ogg','m4a','aac','wma'];const bin=['exe','dll','so','bin','iso','dmg','zip','rar','7z','tar','gz','db','sqlite','psd'];if(img.includes(ext))return 'image';if(vid.includes(ext))return 'video';if(aud.includes(ext))return 'audio';if(bin.includes(ext))return 'binary';return 'text';}
function getMonacoLang(name){const ext=name.split('.').pop().toLowerCase();const m={js:'javascript',ts:'typescript',json:'json',html:'html',css:'css',xml:'xml',yml:'yaml',yaml:'yaml',md:'markdown',py:'python',lua:'lua',sql:'sql',sh:'shell',bat:'bat',ps1:'powershell',meta:'xml',cfg:'ini',ini:'ini',conf:'ini',toml:'ini',log:'plaintext',txt:'plaintext',csv:'plaintext'};return m[ext]||'plaintext';}
async function openViewer(idx){
  viewerCurrentIdx = idx;
  const item=items[idx];viewerFilePath=getItemPath(idx);const type=getFileType(item.name);
  const body=document.getElementById('viewer-body');const saveBtn=document.getElementById('viewer-save');
  const editBtn=document.getElementById('viewer-edit');
  // Update position counter
  const mediaItems = items.filter((it,i) => !it.isDir && isMediaFile(it.name));
  const mediaIdx = mediaItems.findIndex(it => it.name === item.name);
  let counterEl = document.getElementById('viewer-counter');
  if (!counterEl) { counterEl = document.createElement('span'); counterEl.id = 'viewer-counter'; counterEl.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.4);margin-left:8px;flex-shrink:0;'; document.getElementById('viewer-header').insertBefore(counterEl, document.getElementById('viewer-filename').nextSibling); }
  counterEl.textContent = mediaIdx >= 0 ? (mediaIdx+1)+'/'+mediaItems.length : '';
  document.getElementById('viewer-filename').textContent=viewerFilePath;
  document.getElementById('viewer-filename').title='Click to copy: '+viewerFilePath;body.innerHTML='';saveBtn.classList.add('hidden');document.getElementById('viewer-clip')?.classList.add('hidden');
  editBtn.classList.add('hidden');
  const textEditBtn=document.getElementById('viewer-textedit');if(textEditBtn)textEditBtn.classList.add('hidden');
  const rawUrl='/api/raw'+encodeURI(viewerFilePath)+'?auth='+token;
  if(type==='image'){body.innerHTML=`<img src="${rawUrl}" alt="${item.name}" class="max-w-full max-h-full object-contain absolute inset-0 m-auto">`;editBtn.classList.remove('hidden');}  else if(type==="video"){document.getElementById("viewer-clip")?.classList.remove("hidden");body.innerHTML=`<div class="absolute inset-0 flex items-center justify-center"><video id="plyr-video" controls autoplay playsinline class="max-w-full max-h-full"><source src="${rawUrl}"></video></div>`;setTimeout(()=>{if(window.Plyr&&document.getElementById("plyr-video")){window._plyrInstance=new Plyr("#plyr-video",{speed:{selected:1,options:[0.5,0.75,1,1.25,1.5,2]},keyboard:{global:true}});}},100);}
  else if(type==='audio'){body.innerHTML=`<div class="flex items-center justify-center h-full"><audio controls autoplay><source src="${rawUrl}"></audio></div>`;}
  else if(type==='text'){
    if(textEditBtn)textEditBtn.classList.remove('hidden');
    body.innerHTML=`<div id="monaco-container"><p class="p-5 text-cream-dim">Loading editor...</p></div>`;
    const r=await api('/raw'+encodeURI(viewerFilePath)+'?t='+Date.now());
    if(!r.ok){body.innerHTML='<p class="p-5 text-danger">Failed to load</p>';document.getElementById('viewer').classList.remove('hidden');document.getElementById('viewer').classList.add('flex');return;}
    const content=await r.text();
    require(['vs/editor/editor.main'],function(){document.getElementById('monaco-container').innerHTML='';monacoEditor=monaco.editor.create(document.getElementById('monaco-container'),{value:content,language:getMonacoLang(item.name),theme:'vs-dark',automaticLayout:true,minimap:{enabled:true},fontSize:14,wordWrap:'on',scrollBeyondLastLine:false,bracketPairColorization:{enabled:true},folding:true,lineNumbers:'on',tabSize:2,readOnly:true});});
  } else {
    body.innerHTML=`<div class="flex flex-col items-center justify-center h-full gap-3.5"><p class="text-lg">📄 ${item.name}</p><p class="text-cream-dim text-sm">Cannot preview this file type</p><button class="inline-flex items-center gap-1 px-5 py-2.5 rounded text-sm font-semibold border border-success text-success bg-success/[.15] hover:bg-success/25 transition" onclick="downloadViewing()">⬇ Download</button></div>`;
  }
  document.getElementById('viewer').classList.remove('hidden');document.getElementById('viewer').classList.add('flex');
}
function toggleTextEdit(){
  if(!monacoEditor)return;
  const isReadOnly=monacoEditor.getOption(monaco.editor.EditorOption.readOnly);
  monacoEditor.updateOptions({readOnly:!isReadOnly});
  const btn=document.getElementById('viewer-textedit');
  const saveBtn=document.getElementById('viewer-save');
  if(isReadOnly){
    // Switching to edit mode
    if(btn){btn.textContent='👁 View';btn.style.borderColor='rgba(34,197,94,0.5)';btn.style.color='#22c55e';}
    if(saveBtn)saveBtn.classList.remove('hidden');
  } else {
    // Switching to view-only
    if(btn){btn.textContent='✏ Edit';btn.style.borderColor='';btn.style.color='';}
    if(saveBtn)saveBtn.classList.add('hidden');
  }
}
async function saveFile(){
  if(!monacoEditor||!viewerFilePath)return;
  const content=monacoEditor.getValue();const blob=new Blob([content],{type:'text/plain'});
  const saveBtn=document.getElementById('viewer-save');saveBtn.textContent='💾 Saving...';saveBtn.style.opacity='0.5';
  try{
    const r=await api('/resources'+encodeURI(viewerFilePath)+'?override=true',{method:'PUT',body:blob});
    if(r.ok||r.status===200){
      saveBtn.textContent='✓ Saved';saveBtn.style.borderColor='#27ae60';saveBtn.style.color='#27ae60';saveBtn.style.opacity='1';
      const container=document.getElementById('monaco-container');container.style.boxShadow='inset 0 0 20px rgba(39,174,96,0.3)';
      setTimeout(()=>{container.style.boxShadow='';saveBtn.textContent='💾 Save';saveBtn.style.borderColor='';saveBtn.style.color='';},2000);
      toast('Saved ✓','success');
    }else{
      saveBtn.textContent='✕ Failed';saveBtn.style.borderColor='#e74c3c';saveBtn.style.color='#e74c3c';saveBtn.style.opacity='1';
      setTimeout(()=>{saveBtn.textContent='💾 Save';saveBtn.style.borderColor='';saveBtn.style.color='';},3000);
      toast('Save failed: '+r.status,'error');
    }
  }catch(e){saveBtn.textContent='✕ Error';saveBtn.style.opacity='1';setTimeout(()=>{saveBtn.textContent='💾 Save';saveBtn.style.borderColor='';saveBtn.style.color='';},3000);toast('Save error: '+e.message,'error');}
}
function downloadViewing(){if(!viewerFilePath)return;const a=document.createElement('a');a.href='/api/raw'+encodeURI(viewerFilePath)+'?auth='+token;a.download=viewerFilePath.split('/').pop();a.click();}
async function shareViewing(){if(!viewerFilePath)return;try{const r=await fetch('/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filepath:viewerFilePath})});if(!r.ok){toast('Share failed: '+r.status,'error');return;}const d=await r.json();const shareUrl=location.origin+d.url;_showShareDialog(shareUrl,viewerFilePath);}catch(e){toast('Share error: '+e.message,'error');}}
function closeViewer(){if(window._plyrInstance){window._plyrInstance.destroy();window._plyrInstance=null;}if(editorCanvas&&editorDirty){editorRequestClose();return;}if(editorCanvas)closeImageEditor();document.getElementById('viewer').classList.add('hidden');document.getElementById('viewer').classList.remove('flex');if(monacoEditor){monacoEditor.dispose();monacoEditor=null;}viewerFilePath='';}

// ===== VIDEO CLIP =====
function openClipModal() {
  const video = document.querySelector('#plyr-video') || document.querySelector('#viewer-body video');
  if (!video) { toast('No video playing', 'error'); return; }

  const duration = video.duration || 0;
  const currentTime = video.currentTime || 0;

  // Format time as HH:MM:SS.ms
  function fmtTime(s) {
    const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60); const sec = Math.floor(s%60); const ms = Math.floor((s%1)*10);
    return (h>0?h+':':'') + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0') + '.' + ms;
  }

  const ov = document.createElement('div');
  ov.id = 'clip-modal';
  ov.className = 'fixed inset-0 z-[900] bg-black/60 flex items-end justify-center pb-4';
  ov.innerHTML = `<div class="bg-[rgba(15,20,35,0.9)] backdrop-blur-xl border border-white/[.08] rounded-xl p-4 w-[90%] max-w-[400px]">
    <div class="flex justify-between items-center mb-3">
      <h3 class="text-sm font-medium text-white/80">✂ Clip Video</h3>
      <button onclick="document.getElementById('clip-modal').remove()" class="text-white/40 text-lg">&times;</button>
    </div>
    <div class="flex gap-3 mb-3">
      <div class="flex-1">
        <label class="block text-[.6rem] uppercase tracking-wider text-white/40 mb-1">Start</label>
        <input id="clip-start" type="text" value="${fmtTime(currentTime)}" class="w-full px-2 py-1.5 bg-white/[.04] border border-white/[.08] rounded text-xs text-white/90 font-mono">
      </div>
      <div class="flex-1">
        <label class="block text-[.6rem] uppercase tracking-wider text-white/40 mb-1">End</label>
        <input id="clip-end" type="text" value="${fmtTime(duration)}" class="w-full px-2 py-1.5 bg-white/[.04] border border-white/[.08] rounded text-xs text-white/90 font-mono">
      </div>
    </div>
    <div class="flex gap-2 mb-3">
      <button onclick="document.getElementById('clip-start').value=_clipFmtTime(document.querySelector('#plyr-video,#viewer-body video')?.currentTime||0)" class="flex-1 px-2 py-1.5 bg-white/[.04] border border-white/[.08] rounded text-[.6rem] text-white/60 hover:bg-white/[.08] transition">Set Start = Now</button>
      <button onclick="document.getElementById('clip-end').value=_clipFmtTime(document.querySelector('#plyr-video,#viewer-body video')?.currentTime||0)" class="flex-1 px-2 py-1.5 bg-white/[.04] border border-white/[.08] rounded text-[.6rem] text-white/60 hover:bg-white/[.08] transition">Set End = Now</button>
    </div>
    <p class="text-[.55rem] text-white/25 mb-3">Duration: ${fmtTime(duration)} · Format: same as source (fast copy)</p>
    <button onclick="executeClip()" class="w-full py-2.5 bg-gold/10 border border-gold/20 text-gold rounded-lg font-semibold text-sm cursor-pointer hover:bg-gold/20 transition">Export Clip</button>
    <p id="clip-status" class="text-center text-xs text-white/30 mt-2 hidden"></p>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
}

function _clipFmtTime(s) {
  const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60); const sec = Math.floor(s%60); const ms = Math.floor((s%1)*10);
  return (h>0?h+':':'') + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0') + '.' + ms;
}

async function executeClip() {
  const startTime = document.getElementById('clip-start').value;
  const endTime = document.getElementById('clip-end').value;
  const status = document.getElementById('clip-status');

  if (!viewerFilePath) { toast('No file open', 'error'); return; }

  status.classList.remove('hidden');
  status.innerHTML = '<div class="hk-spinner hk-spinner-sm inline-block mr-2"></div>Clipping...';

  try {
    const r = await fetch('/resolver-api/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: viewerFilePath, start: startTime, end: endTime }),
    });
    const data = await r.json();
    if (data.ok) {
      status.innerHTML = '\u2713 Saved: ' + data.output;
      status.style.color = '#22c55e';
      toast('Clip exported: ' + data.output, 'success');
    } else {
      status.innerHTML = '\u2717 ' + (data.error || 'Failed');
      status.style.color = '#ef4444';
    }
  } catch(e) {
    status.innerHTML = '\u2717 ' + e.message;
    status.style.color = '#ef4444';
  }
}

// ===== SEARCH =====
let searchAbort=null;
let searchScopeAll=true;
let searchIntext=false;
let searchAiMode=false;

function openSearch(){
  const modal=document.getElementById('search-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  // Animate in
  modal.style.opacity='0';
  modal.firstElementChild.style.transform='scale(0.95)';
  modal.firstElementChild.style.transition='transform 0.2s ease, opacity 0.2s ease';
  modal.style.transition='opacity 0.2s ease';
  requestAnimationFrame(()=>{modal.style.opacity='1';modal.firstElementChild.style.transform='scale(1)';});
  setTimeout(()=>document.getElementById('search-input').focus(),100);
}
function closeSearch(){
  const modal=document.getElementById('search-modal');
  modal.style.opacity='0';
  modal.firstElementChild.style.transform='scale(0.97)';
  setTimeout(()=>{modal.classList.add('hidden');modal.classList.remove('flex');modal.style.opacity='';modal.firstElementChild.style.transform='';},180);
  if(searchAbort)searchAbort.abort();
}

function toggleSearchScope(){
  const pathInput=document.getElementById('search-scope-path');
  const label=document.getElementById('search-scope-label');
  const btn=document.getElementById('search-scope-btn');
  if(searchScopeAll){
    searchScopeAll=false;
    pathInput.classList.remove('hidden');
    pathInput.value=currentRoot||'/';
    pathInput.focus();
    label.textContent='Path:';
    btn.style.borderColor='rgba(96,165,250,0.5)';
    btn.style.background='rgba(96,165,250,0.1)';
    btn.querySelector('img').style.opacity='0.9';
  } else {
    searchScopeAll=true;
    pathInput.classList.add('hidden');
    label.textContent='All roots';
    btn.style.borderColor='rgba(255,255,255,0.07)';
    btn.style.background='none';
    btn.querySelector('img').style.opacity='0.35';
  }
}
function toggleSearchIntext(){
  searchIntext=!searchIntext;
  const btn=document.getElementById('search-intext-btn');
  if(!btn)return;
  btn.style.borderColor=searchIntext?'rgba(96,165,250,0.5)':'rgba(255,255,255,0.07)';
  btn.style.background=searchIntext?'rgba(96,165,250,0.1)':'none';
  const img=btn.querySelector('img');
  if(img)img.style.opacity=searchIntext?'0.9':'0.35';
}
function toggleSearchAi(){
  searchAiMode=!searchAiMode;
  const btn=document.getElementById('search-ai-btn');
  if(!btn)return;
  btn.style.borderColor=searchAiMode?'rgba(194,163,90,0.5)':'rgba(255,255,255,0.07)';
  btn.style.background=searchAiMode?'rgba(194,163,90,0.1)':'none';
  const img=btn.querySelector('img');
  if(img)img.style.opacity=searchAiMode?'0.9':'0.35';
  const input=document.getElementById('search-input');
  if(input)input.placeholder=searchAiMode?'Describe what to find... (press Enter)':'Search';
}

function showSearchSyntaxHelp(){
  const html=`<div style="font-size:11px;color:#c8c0e0;line-height:1.6;">
    <p style="font-weight:600;margin-bottom:6px;">Search Syntax:</p>
    <p><code style="background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px;">"exact phrase"</code> — match exact text</p>
    <p><code style="background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px;">*.lua</code> — wildcard extension match</p>
    <p><code style="background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px;">-exclude</code> — exclude word from results</p>
    <p><code style="background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px;">path:/fxMain</code> — limit to path</p>
    <p style="margin-top:6px;color:rgba(200,180,240,0.4);">Multiple words match independently (OR). Results ranked by relevance.</p>
  </div>`;
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';
  ov.innerHTML=`<div style="background:#122050;border:1px solid rgba(194,163,90,0.3);border-radius:10px;padding:20px;max-width:360px;width:90%;">${html}<button onclick="this.closest('div[style]').parentElement.remove()" style="margin-top:12px;width:100%;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:none;color:rgba(245,240,230,0.5);font-size:11px;cursor:pointer;">Close</button></div>`;
  ov.addEventListener('click',e=>{if(e.target===ov)ov.remove();});
  document.body.appendChild(ov);
}

let searchTimer=null;
function onSearchInput(){
  clearTimeout(searchTimer);
  const q=document.getElementById('search-input').value.trim();
  if(q.length>=2 && !searchAiMode) searchTimer=setTimeout(()=>{ if(searchIntext) executeGrepSearch(); else executeSearch(); },300);
  else if(q.length<2) { document.getElementById('search-results').style.display='none'; document.getElementById('search-count').textContent=''; }
}

async function executeSearch(){
  const query=document.getElementById('search-input').value.trim();
  if(!query||query.length<2)return;

  const typeFilter=document.getElementById('search-type')?.value||'';
  const extInput=(document.getElementById('search-ext')?.value||'').trim();
  const extMode=document.getElementById('search-ext-mode')?.value||'include';
  const searchPath=searchScopeAll?'/':((document.getElementById('search-scope-path')?.value||'/').replace(/^\/?/,'/'));
  const mode=searchIntext?'both':'name';

  document.getElementById('search-results').style.display='block';
  document.getElementById('search-results').innerHTML='<div style="padding:20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px;"><div class="hk-spinner"></div><span style="font-size:11px;color:rgba(255,255,255,0.3);">Searching</span></div>';
  document.getElementById('search-count').textContent='';
  document.getElementById('search-scope-label').textContent=searchScopeAll?'All roots':'Path: '+searchPath;

  if(searchAbort)searchAbort.abort();
  searchAbort=new AbortController();

  // AI mode: parse natural language into search keywords
  let actualQuery = query;
  let aiSuggestion = '';
  if (searchAiMode) {
    try {
      document.getElementById('search-results').innerHTML='<div style="padding:20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px;"><div class="hk-spinner" style="border-top-color:rgba(168,130,255,0.8);border-color:rgba(168,130,255,0.2);"></div><span style="font-size:11px;color:rgba(168,130,255,0.5);">✦ AI analyzing</span></div>';
      document.getElementById('search-results').style.display='block';
      const aiRes = await fetch('/search-api/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'You help turn natural language file search queries into keywords. Reply in exactly 2 lines: KEYWORDS: <terms> and INTERPRETED: <short explanation>. Example input: find bugatti chiron handling. Reply: KEYWORDS: chiron handling.meta INTERPRETED: Looking for Chiron handling config' },
            { role: 'user', content: query }
          ],
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 60,
        }),
        signal: searchAbort.signal,
      });
      if (aiRes.ok) {
        const reader = aiRes.body.getReader();
        const decoder = new TextDecoder();
        let aiText = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of decoder.decode(value, { stream: true }).split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const d = line.slice(6).trim();
            if (d === '[DONE]') break;
            try { const j = JSON.parse(d); const c = j.choices?.[0]?.delta?.content; if (c) aiText += c; } catch(e) {}
          }
        }
        const kwMatch = aiText.match(/KEYWORDS:s*(.+)/i);
        const intMatch = aiText.match(/INTERPRETED:\s*(.+)/i);
        if (kwMatch) actualQuery = kwMatch[1].trim();
        if (intMatch) aiSuggestion = intMatch[1].trim();
      }
    } catch(e) { if(e.name==='AbortError')return; }
  }

  try{
    const res=await fetch('/search-api/search?q='+encodeURIComponent(actualQuery)+'&path='+encodeURIComponent(searchPath)+'&mode='+mode+'&limit=80',{signal:searchAbort.signal});
    if(!res.ok){document.getElementById('search-results').innerHTML='<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.25);font-size:12px;">No results</div>';return;}
    const data=await res.json();let results=data.results||[];

    // In-text mode: exclude folders
    if(searchIntext){results=results.filter(item=>!item.dir);}

    // Apply type filter
    if(typeFilter){results=results.filter(item=>{const ext=(item.path||'').split('.').pop().toLowerCase();if(typeFilter==='folder')return item.dir;if(item.dir)return false;if(typeFilter==='image')return['jpg','jpeg','png','gif','webp','svg','bmp'].includes(ext);if(typeFilter==='video')return['mp4','webm','mkv','avi','mov'].includes(ext);if(typeFilter==='audio')return['mp3','wav','flac','ogg','m4a'].includes(ext);if(typeFilter==='text')return['txt','log','md','json','js','ts','lua','py','cfg','xml','yml','yaml','ini','html','css','meta','conf','sh'].includes(ext);if(typeFilter==='archive')return['zip','rar','7z','tar','gz'].includes(ext);return true;});}

    // Apply extension filter
    if(extInput){
      const exts=extInput.split(/[\s,]+/).map(e=>e.replace(/^\./,'').toLowerCase()).filter(Boolean);
      if(exts.length){results=results.filter(item=>{if(item.dir)return extMode==='include'?false:true;const ext=(item.path||'').split('.').pop().toLowerCase();return extMode==='include'?exts.includes(ext):!exts.includes(ext);});}
    }

    renderSearchResults2(results, actualQuery, aiSuggestion);
    if(!results.length){document.getElementById('search-results').innerHTML=(aiSuggestion?'<div style="padding:10px 14px;font-size:11px;color:rgba(194,163,90,0.7);border-bottom:1px solid rgba(255,255,255,0.04);">✦ '+aiSuggestion+'</div>':'')+'<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.25);font-size:12px;">No results found</div>';}
  }catch(e){if(e.name==='AbortError')return;document.getElementById('search-results').innerHTML='<p class="text-center text-cream-dim text-xs py-8">Search error</p>';}
}


// VS Code-style "Find in Files" — line-by-line results
async function executeGrepSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query || query.length < 2) return;

  const searchPath = searchScopeAll ? '/' : ((document.getElementById('search-scope-path')?.value || '/').replace(/^\/?/, '/'));
  const container = document.getElementById('search-results');
  container.style.display = 'block';
  container.innerHTML = '<div style="padding:20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px;"><div class="hk-spinner"></div><span style="font-size:11px;color:rgba(255,255,255,0.3);">Searching in files</span></div>';
  document.getElementById('search-count').textContent = '';

  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();

  try {
    const res = await fetch('/search-api/grep?q=' + encodeURIComponent(query) + '&path=' + encodeURIComponent(searchPath) + '&limit=40', { signal: searchAbort.signal });
    const data = await res.json();
    if (!data.results || !data.results.length) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.25);font-size:12px;">No matches in file contents</div>';
      return;
    }

    document.getElementById('search-count').textContent = data.total + ' files · ' + data.lineCount + ' lines';
    const words = query.toLowerCase().split(/[\s\-_\.]+/).filter(w => w.length >= 2);
    let html = '';

    for (const file of data.results) {
      const parentPath = '/' + file.path.split('/').slice(0, -1).join('/');
      const icon = getFileIcon(file.name);
      html += `<div style="margin-bottom:2px;">`;
      html += `<div onclick="closeSearch();navigate('${parentPath}')" style="display:flex;align-items:center;gap:6px;padding:5px 10px;cursor:pointer;border-radius:6px;background:rgba(255,255,255,0.02);" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='rgba(255,255,255,0.02)'">`;
      html += `<span style="font-size:13px;">${icon}</span>`;
      html += `<span style="font-size:11px;color:#e8e8e8;font-weight:500;">${file.name}</span>`;
      html += `<span style="font-size:9px;color:rgba(255,255,255,0.2);margin-left:auto;">${file.lines.length} match${file.lines.length > 1 ? 'es' : ''}</span>`;
      html += `</div>`;

      for (const line of file.lines) {
        let lineHtml = _escHtml(line.text);
        for (const w of words) {
          lineHtml = lineHtml.replace(new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<span style="color:#f59e0b;font-weight:600;">$1</span>');
        }
        html += `<div style="display:flex;gap:8px;padding:2px 10px 2px 30px;font-family:monospace;font-size:10px;line-height:1.6;">`;
        html += `<span style="color:rgba(255,255,255,0.2);min-width:28px;text-align:right;flex-shrink:0;">${line.num}</span>`;
        html += `<span style="color:rgba(255,255,255,0.6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${lineHtml}</span>`;
        html += `</div>`;
      }
      html += `</div>`;
    }

    container.innerHTML = html;
  } catch(e) {
    if (e.name === 'AbortError') return;
    container.innerHTML = '<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.25);font-size:12px;">Search error</div>';
  }
}

function renderSearchResults2(results, query, aiSuggestion){
  const container=document.getElementById('search-results');
  document.getElementById('search-count').textContent=results.length+' result'+(results.length!==1?'s':'');
  if(!results.length){container.style.display='none';return;}
  container.style.display='block';
  const words=query.toLowerCase().split(/[\s\-_\.]+/).filter(w=>w.length>=2);
  let html='';
  // AI interpretation bar
  if(aiSuggestion){
    html+=`<div style="padding:8px 14px;font-size:11px;color:rgba(194,163,90,0.8);border-bottom:1px solid rgba(255,255,255,0.04);display:flex;align-items:center;gap:6px;"><span style="opacity:0.6;">✦</span> ${_escHtml(aiSuggestion)} <span style="margin-left:auto;font-size:9px;color:rgba(255,255,255,0.2);cursor:pointer;" onclick="document.getElementById('search-input').value='${query.replace(/'/g,"\\'")}';executeSearch();">searching: ${_escHtml(query)}</span></div>`;
  }
  for(const item of results){
    const name=item.name||item.path.split('/').pop();
    const parentPath='/'+item.path.split('/').slice(0,-1).join('/');
    const icon=item.dir?'<img src="/assets/folder.png" style="width:20px;height:20px;">':'<span style="font-size:16px;">'+getFileIcon(name)+'</span>';
    let nameHtml=_escHtml(name);
    for(const w of words){nameHtml=nameHtml.replace(new RegExp('('+w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),'<span style="color:#6cb6ff;font-weight:600;">$1</span>');}
    const pathShort=item.path.length>50?'...'+item.path.slice(-47):item.path;
    const badge=item.matchType==='content'?'<span style="margin-left:6px;padding:1px 5px;background:rgba(168,130,255,0.15);color:rgba(168,130,255,0.8);border-radius:3px;font-size:9px;">in-file</span>':'';
    html+=`<div onclick="closeSearch();navigate('${parentPath}')" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;cursor:pointer;transition:background .1s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='none'">`;
    html+=`<div style="width:28px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${icon}</div>`;
    html+=`<div style="flex:1;min-width:0;overflow:hidden;">`;
    html+=`<div style="font-size:13px;color:#e8e8e8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${nameHtml}${badge}</div>`;
    html+=`<div style="font-size:10px;color:rgba(255,255,255,0.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">/${pathShort}</div>`;
    if(item.snippet){html+=`<div style="font-size:10px;color:rgba(168,130,255,0.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;margin-top:1px;">${_escHtml(item.snippet)}</div>`;}
    html+=`</div></div>`;
  }
  container.innerHTML=html;
}
function _escHtml(t){return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
