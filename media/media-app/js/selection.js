// ===== SELECTION =====
function handleClick(idx,event){
  if(longPressedIdx===idx){longPressedIdx=-1;renderFiles();return;}
  longPressedIdx=-1;
  const item=items[idx];
  const isMobile=window.innerWidth<768||'ontouchstart' in window;

  // MOBILE: single tap = select ONE (no tick). Double tap = open. Long press = multi-select mode.
  if(isMobile){
    const now=Date.now();
    if(lastTapIdx===idx&&(now-lastTapTime)<400){
      // Double tap → open
      lastTapIdx=-1;lastTapTime=0;
      selectedSet.clear();activeIdx=-1;
      const tapItem=lastTapItem||items[idx];
      if(tapItem&&tapItem.isDir)navigate(tapItem.path||currentPath+(currentPath.endsWith('/')?'':'/')+tapItem.name);
      else if(tapItem)openViewer(idx);
      lastTapItem=null;
      return;
    }
    lastTapIdx=idx;lastTapTime=now;lastTapItem=items[idx];

    if(multiSelectMode){
      // Multi-select mode (entered via long-press): toggle items with tick
      if(selectedSet.has(idx))selectedSet.delete(idx);else selectedSet.add(idx);
      activeIdx=selectedSet.size>0?[...selectedSet].pop():-1;
      if(selectedSet.size===0)multiSelectMode=false;
    } else {
      // Normal single tap: highlight ONE item, no tick, no multi-select
      if(selectedSet.has(idx)&&selectedSet.size===1){selectedSet.clear();activeIdx=-1;}
      else{selectedSet.clear();selectedSet.add(idx);activeIdx=idx;}
    }
    renderFiles();
    return;
  }

  // DESKTOP: single click = select (highlight). Ctrl+click = multi-select (tick). Double click = open.
  if(event&&(event.ctrlKey||event.metaKey)){
    // Ctrl+click: multi-select mode with tick
    multiSelectMode=true;
    if(selectedSet.has(idx))selectedSet.delete(idx);else selectedSet.add(idx);
    activeIdx=selectedSet.size>0?[...selectedSet].pop():-1;
    if(selectedSet.size===0)multiSelectMode=false;
  } else {
    // Normal click: select ONE item (highlight only, no tick, no multi-select)
    multiSelectMode=false;
    if(selectedSet.has(idx)&&selectedSet.size===1){selectedSet.clear();activeIdx=-1;}
    else{selectedSet.clear();selectedSet.add(idx);activeIdx=idx;}
  }
  renderFiles();
}
let longPressedIdx=-1;
let touchDragActive=false;

function handleLongPress(idx){
  longPressedIdx=idx;
  multiSelectMode=true;
  touchDragActive=false;
  if(!selectedSet.has(idx))selectedSet.add(idx);
  activeIdx=idx;
  if(navigator.vibrate)navigator.vibrate(30);
  const el=document.querySelector(`[data-idx="${idx}"]`);
  if(el){el.classList.add('bg-gold/10');el.style.outline='1px solid rgba(194,163,90,0.5)';
    const tick=el.querySelector('.select-tick');if(tick)tick.style.display='block';
    if(!el.querySelector('.select-tick')){const s=document.createElement('span');s.className='select-tick absolute top-1 right-2 text-[.5rem] text-gold font-bold bg-hk-light rounded px-1';s.textContent='✓';el.appendChild(s);}
  }
  updateToolbar();
}

function onItemTouchStart(idx,e){
  if(e)e.stopPropagation();
  longPressTimer=setTimeout(()=>handleLongPress(idx),500);
}
function onItemTouchEnd(e){
  clearTimeout(longPressTimer);
}
function onItemTouchMove(event){clearTimeout(longPressTimer);}

let lastTapIdx=-1;let lastTapTime=0;let lastTapItem=null;
function handleDblClick(idx){
  const item=items[idx];
  if(item.isDir)navigate(item.path||currentPath+(currentPath.endsWith('/')?'':'/')+item.name);
  else openViewer(idx);
}
function handleMobileTap(idx){
  const now=Date.now();
  if(lastTapIdx===idx&&(now-lastTapTime)<400){
    lastTapIdx=-1;lastTapTime=0;
    handleDblClick(idx);
  } else {
    lastTapIdx=idx;lastTapTime=now;
  }
}
function navigateUp(){const parts=currentPath.split('/').filter(Boolean);parts.pop();const p='/'+parts.join('/');if(p.length>=currentRoot.length)navigate(p);else navigate(currentRoot);}

function toggleView(){viewMode=viewMode==='list'?'grid':'list';localStorage.setItem('hk_view',viewMode);activeIdx=-1;selectedSet.clear();renderFiles();}
function updateViewToggleIcon(){const b=document.getElementById('view-toggle');b.textContent=viewMode==='list'?'⊞':'☰';b.title=viewMode==='list'?'Grid':'List';}

function updateToolbar(){
  const tb=document.getElementById('toolbar');
  const discardBtn=document.getElementById('discard-btn');
  const hasClip=clipboard.items.length>0;
  const hasUndo=undoStack.length>0;
  const hasRedo=redoStack.length>0;
  const hasSelection=selectedSet.size>0;
  const showTb=hasSelection||hasClip||hasUndo||hasRedo;
  if(showTb){tb.classList.remove('hidden');tb.classList.add('flex');}
  else{tb.classList.add('hidden');tb.classList.remove('flex');}
  // Paste visibility
  const tbPaste=document.getElementById('tb-paste');
  if(tbPaste)tbPaste.style.display=hasClip?'':'none';
  // Undo/redo visibility
  const tbUndo=document.getElementById('tb-undo');
  const tbRedo=document.getElementById('tb-redo');
  if(tbUndo)tbUndo.style.display=hasUndo?'':'none';
  if(tbRedo)tbRedo.style.display=hasRedo?'':'none';
  // Discard button: only show when multi-select with 2+ items, or clipboard has items
  const hasSel=multiSelectMode&&selectedSet.size>=2;
  const headerBtns=document.querySelectorAll('#header .header-btn');
  if(hasSel||hasClip){
    discardBtn.classList.remove('hidden');
    headerBtns.forEach(b=>b.style.display='none');
    if(hasSel){
      discardBtn.textContent=`✕ Discard (${selectedSet.size})`;
    } else {
      discardBtn.textContent=`✕ Clear clipboard (${clipboard.items.length})`;
    }
  } else {
    discardBtn.classList.add('hidden');
    headerBtns.forEach(b=>b.style.display='');
  }
}
function discardAll(){
  // Progressive: clear selection first, then clipboard on next press
  if(selectedSet.size>0){
    multiSelectMode=false;selectedSet.clear();activeIdx=-1;longPressedIdx=-1;
    renderFiles();
  } else if(clipboard.items.length>0){
    clipboard={items:[],mode:null,sourcePath:''};
    updateToolbar();
    toast('Clipboard cleared','info');
  }
}
function discardSelection(){discardAll();}

// ===== TOOLBAR DELEGATES =====
function downloadSelected(){
  if(selectedSet.size>0){[...selectedSet].forEach(i=>downloadItem(i));}
  else if(activeIdx>=0)downloadItem(activeIdx);
}

function _showShareDialog(shareUrl, filePath) {
  const rawUrl = location.origin + '/api/raw' + encodeURI(filePath) + '?auth=' + token;
  const ext = filePath.split('.').pop().toLowerCase();
  const isText = ['txt','log','md','json','js','ts','lua','py','cfg','xml','yml','yaml','ini','html','css','meta','conf','sh','bat','ps1','sql','csv','toml'].includes(ext);

  let rawSection = '';
  if (isText) {
    rawSection = `<div style="margin-bottom:16px;">
      <label style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:rgba(245,240,230,0.5);margin-bottom:4px;">Raw (view in browser)</label>
      <div style="display:flex;gap:4px;">
        <input type="text" value="${rawUrl}" readonly style="flex:1;padding:7px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(194,163,90,0.25);border-radius:4px;color:#F5F0E6;font-size:11px;outline:none;" onclick="this.select()">
        <button data-action="copy-raw" style="padding:6px 10px;background:rgba(194,163,90,0.12);border:1px solid rgba(194,163,90,0.3);border-radius:4px;color:#C2A35A;font-size:11px;cursor:pointer;white-space:nowrap;">Copy</button>
        <button data-action="open-raw" style="padding:6px 10px;background:rgba(52,152,219,0.1);border:1px solid rgba(52,152,219,0.3);border-radius:4px;color:#3498db;font-size:11px;cursor:pointer;white-space:nowrap;">Open</button>
      </div>
    </div>`;
  }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `<div style="background:#122050;border:1px solid rgba(194,163,90,0.5);border-radius:12px;padding:24px;width:90%;max-width:440px;font-family:Inter,sans-serif;">
    <h2 style="font-family:Cinzel,serif;font-size:14px;letter-spacing:0.08em;margin-bottom:16px;color:#F5F0E6;">🔗 Share</h2>
    <div style="margin-bottom:${isText ? '12px' : '16px'};">
      <label style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:rgba(245,240,230,0.5);margin-bottom:4px;">Share Link</label>
      <div style="display:flex;gap:4px;">
        <input type="text" value="${shareUrl}" readonly style="flex:1;padding:7px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(194,163,90,0.25);border-radius:4px;color:#F5F0E6;font-size:11px;outline:none;" onclick="this.select()">
        <button data-action="copy-share" style="padding:6px 10px;background:rgba(194,163,90,0.12);border:1px solid rgba(194,163,90,0.3);border-radius:4px;color:#C2A35A;font-size:11px;cursor:pointer;white-space:nowrap;">Copy</button>
        <button data-action="open-share" style="padding:6px 10px;background:rgba(52,152,219,0.1);border:1px solid rgba(52,152,219,0.3);border-radius:4px;color:#3498db;font-size:11px;cursor:pointer;white-space:nowrap;">Open</button>
      </div>
    </div>
    ${rawSection}
    <button data-action="close" style="width:100%;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:rgba(245,240,230,0.6);font-weight:600;font-size:13px;cursor:pointer;">Close</button>
  </div>`;
  overlay.addEventListener('click', e => {
    const action = e.target.dataset?.action;
    if (action === 'copy-share') { navigator.clipboard.writeText(shareUrl).then(()=>{e.target.textContent='✓';setTimeout(()=>e.target.textContent='Copy',1500);}); }
    else if (action === 'copy-raw') { navigator.clipboard.writeText(rawUrl).then(()=>{e.target.textContent='✓';setTimeout(()=>e.target.textContent='Copy',1500);}); }
    else if (action === 'open-share') { window.open(shareUrl, '_blank'); }
    else if (action === 'open-raw') { window.open(rawUrl, '_blank'); }
    else if (action === 'close' || e.target === overlay) { overlay.remove(); }
  });
  document.body.appendChild(overlay);
  try { navigator.clipboard.writeText(shareUrl); } catch(e) {}
}

function shareSelected(){
  if(selectedSet.size>1){shareMultiple([...selectedSet]);return;}
  if(activeIdx>=0)shareItem(activeIdx);
}
async function shareMultiple(indices){
  // For multiple files, create individual share links
  toast('Creating share links...','info');
  const links=[];
  for(const idx of indices){
    const item=items[idx];
    if(item.isDir)continue;
    const fp=getItemPath(idx);
    try{
      const r=await fetch('/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filepath:fp})});
      if(r.ok){const d=await r.json();links.push(location.origin+d.url);}
    }catch(e){}
  }
  if(!links.length){toast('No files to share','error');return;}
  const text=links.join('\n');
  try{await navigator.clipboard.writeText(text);toast(`🔗 ${links.length} link(s) copied!`,'success');}
  catch(e){await showPromptModal(`Share links (${links.length}):`,text);}
}
function duplicateSelected(){
  if(selectedSet.size>0){duplicateMultiple([...selectedSet]);}
  else if(activeIdx>=0)duplicateItem(activeIdx);
}
async function duplicateMultiple(indices){
  let ok=0;const undoActions=[];
  for(const idx of indices){
    const item=items[idx],src=getItemPath(idx);
    let nn;if(item.isDir)nn=item.name+'_copy';else{const dot=item.name.lastIndexOf('.');nn=dot>0?item.name.slice(0,dot)+'_copy'+item.name.slice(dot):item.name+'_copy';}
    const dest=currentPath+(currentPath.endsWith('/')?'':'/')+nn;
    const r=await api('/resources'+encodeURI(src)+'?action=copy&destination='+encodeURIComponent(dest),{method:'PATCH'});
    if(r.ok){ok++;undoActions.push({from:src,to:dest});}
  }
  if(ok)pushUndo('duplicate',undoActions);
  toast(`Duplicated ${ok} item(s)`,'success');treeCache={};navigate(currentPath);
}
function moveSelected(){
  if(selectedSet.size>0){window._moveTargetIndices=[...selectedSet];openMoveModal();}
  else if(activeIdx>=0){window._moveTargetIndices=[activeIdx];openMoveModal();}
}
function deleteSelected(){
  if(selectedSet.size===0&&activeIdx>=0){deleteItem(activeIdx);return;}
  if(selectedSet.size===0)return;
  const indices=[...selectedSet];
  const names=indices.map(i=>items[i].name);
  document.getElementById('delete-warning').textContent=`Delete permanently:\n${names.map(n=>'• '+n).join('\n')}\n\nThis cannot be undone.`;
  document.getElementById('delete-modal').classList.remove('hidden');document.getElementById('delete-modal').classList.add('flex');
  window._deleteIndices=indices;
}
function infoSelected(){if(activeIdx>=0)infoItem(activeIdx);}
function renameSelected(){if(selectedSet.size>0)openRenameModal([...selectedSet]);else if(activeIdx>=0)openRenameModal([activeIdx]);}

// ===== ITEM ACTIONS =====
function getItemPath(idx){return items[idx].path||currentPath+(currentPath.endsWith('/')?'':'/')+items[idx].name;}

async function downloadItem(idx){const item=items[idx],p=getItemPath(idx);if(item.isDir){toast('Downloading .zip...','info');const r=await api('/raw'+encodeURI(p)+'?algo=zip');if(!r.ok){toast('Failed: '+r.status,'error');return;}downloadBlob(await r.blob(),item.name+'.zip');}else{const a=document.createElement('a');a.href='/api/raw'+encodeURI(p)+'?auth='+token;a.download=item.name;a.click();}}
async function shareItem(idx){const item=items[idx];if(item.isDir)return;const fp=getItemPath(idx);try{const r=await fetch('/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filepath:fp})});if(!r.ok){toast('Share failed: '+r.status,'error');return;}const d=await r.json();const shareUrl=location.origin+d.url;_showShareDialog(shareUrl,fp);}catch(e){toast('Share error: '+e.message,'error');}}
async function duplicateItem(idx){
  if(selectedSet.size>1){duplicateMultiple([...selectedSet]);return;}
  const item=items[idx],src=getItemPath(idx);let nn;if(item.isDir)nn=item.name+'_copy';else{const dot=item.name.lastIndexOf('.');nn=dot>0?item.name.slice(0,dot)+'_copy'+item.name.slice(dot):item.name+'_copy';}const dest=currentPath+(currentPath.endsWith('/')?'':'/')+nn;toast('Duplicating...','info');const r=await api('/resources'+encodeURI(src)+'?action=copy&destination='+encodeURIComponent(dest),{method:'PATCH'});if(r.ok){pushUndo('duplicate',[{from:src,to:dest}]);toast('Duplicated','success');treeCache={};navigate(currentPath);}else toast('Failed: '+r.status,'error');
}

function moveItem(idx){
  if(selectedSet.size>1){window._moveTargetIndices=[...selectedSet];}
  else{window._moveTargetIndices=[idx];}
  openMoveModal();
}
let moveBrowsePath='/';
function openMoveModal(){moveBrowsePath=currentPath;document.getElementById('move-modal').classList.remove('hidden');document.getElementById('move-modal').classList.add('flex');renderMoveFolders();}
function closeMove(){document.getElementById('move-modal').classList.add('hidden');document.getElementById('move-modal').classList.remove('flex');}
async function renderMoveFolders(){
  const bc=document.getElementById('move-breadcrumb');const parts=moveBrowsePath.split('/').filter(Boolean);
  let bcH=`<span class="cursor-pointer text-gold" onclick="moveBrowsePath='/';renderMoveFolders()">⌂</span>`;let built='';
  parts.forEach(p=>{built+='/'+p;const bp=built;bcH+=` / <span class="cursor-pointer text-gold" onclick="moveBrowsePath='${bp}';renderMoveFolders()">${p}</span>`;});
  bc.innerHTML=bcH;
  const list=document.getElementById('move-folder-list');list.innerHTML='<div class="flex items-center gap-2 py-2"><div class="hk-spinner hk-spinner-sm"></div><span class="text-cream-dim text-[.7rem]">Loading</span></div>';
  try{const r=await api('/resources'+moveBrowsePath);if(!r.ok){list.innerHTML='Error';return;}const d=await r.json();const folders=(d.items||[]).filter(i=>i.isDir);if(!folders.length){list.innerHTML='<p class="text-cream-dim text-[.7rem]">No subfolders</p>';return;}list.innerHTML=folders.map(f=>{const fp=moveBrowsePath+(moveBrowsePath.endsWith('/')?'':'/')+f.name;return `<div class="px-2.5 py-1.5 cursor-pointer text-xs rounded hover:bg-hk-card flex items-center gap-1.5" ondblclick="moveBrowsePath='${fp}';renderMoveFolders()"><img src="/assets/folder.png" class="w-4 h-4"> ${f.name}</div>`;}).join('');}catch(e){list.innerHTML='Error';}
}
async function confirmMove(){
  const indices=window._moveTargetIndices||[];
  if(!indices.length)return;
  closeMove();
  // Check for duplicates at destination
  const names=indices.map(idx=>items[idx].name);
  const {action:dupeAction,existingNames}=await checkDuplicates(moveBrowsePath,names,'move');
  if(dupeAction==='cancel')return;
  toast('Moving...','info');
  let ok=0,fail=0,skipped=0;const undoActions=[];
  for(const idx of indices){
    const item=items[idx],src=getItemPath(idx);
    const isDupe=existingNames.has(item.name);
    if(isDupe&&dupeAction==='skip'){skipped++;continue;}
    let dest;
    if(isDupe&&dupeAction==='rename'){
      dest=getRenamePath(moveBrowsePath,item.name,existingNames);
    } else {
      dest=moveBrowsePath+(moveBrowsePath.endsWith('/')?'':'/')+item.name;
      if(isDupe&&dupeAction==='replace'){
        await api('/resources'+encodeURI(dest),{method:'DELETE'});
      }
    }
    if(src===dest){continue;}
    const r=await api('/resources'+encodeURI(src)+'?action=rename&destination='+encodeURIComponent(dest),{method:'PATCH'});
    if(r.ok){ok++;undoActions.push({from:src,to:dest});}else fail++;
  }
  if(ok)pushUndo('move',undoActions);
  let msg=ok?`Moved ${ok} item(s)`:'Move failed';
  if(skipped)msg+=` · ${skipped} skipped`;
  toast(msg,fail?'error':'success');
  treeCache={};selectedSet.clear();activeIdx=-1;multiSelectMode=false;navigate(currentPath);
}

function deleteItem(idx){
  const indices=(selectedSet.size>1)?[...selectedSet]:[idx];
  const names=indices.map(i=>items[i].name);
  document.getElementById('delete-warning').textContent=`Delete permanently:\n${names.map(n=>'• '+n).join('\n')}\n\nThis cannot be undone.`;
  document.getElementById('delete-modal').classList.remove('hidden');document.getElementById('delete-modal').classList.add('flex');
  window._deleteIndices=indices;
}
function closeDelete(){document.getElementById('delete-modal').classList.add('hidden');document.getElementById('delete-modal').classList.remove('flex');}
async function confirmDelete(){
  closeDelete();
  const indices=window._deleteIndices||[];
  const directPaths=window._deletePaths||[];
  window._deletePaths=null;
  let ok=0,fail=0;
  for(const idx of indices){
    const srcPath=getItemPath(idx);
    // Protect Resolver folder from deletion
    if(srcPath===getPersonalPath()+'/Resolver'||srcPath===getPersonalPath()+'/Resolver/'){toast('Resolver folder cannot be deleted','error');fail++;continue;}
    const r=await api('/resources'+encodeURI(srcPath),{method:'DELETE'});if(r.ok)ok++;else fail++;
  }
  for(const srcPath of directPaths){
    if(srcPath===getPersonalPath()+'/Resolver'||srcPath===getPersonalPath()+'/Resolver/'){toast('Resolver folder cannot be deleted','error');fail++;continue;}
    const r=await api('/resources'+encodeURI(srcPath),{method:'DELETE'});if(r.ok)ok++;else fail++;
  }
  toast(ok?`Deleted ${ok} item(s)`:'Delete failed',fail?'error':'success');
  treeCache={};selectedSet.clear();activeIdx=-1;multiSelectMode=false;navigate(currentPath);
}

function renameItem(idx){openRenameModal([idx]);}
function openRenameModal(indices){const list=document.getElementById('rename-list');list.innerHTML=indices.map(idx=>{const item=items[idx];return `<div class="flex items-center gap-2 mb-2"><span class="text-lg">${item.isDir?'<img src="/assets/folder.png" class="w-5 h-5">':getFileIcon(item.name)}</span><input type="text" value="${item.name}" data-idx="${idx}" data-original="${item.name}" class="flex-1 px-2.5 py-1.5 bg-white/[.06] border border-gold/25 rounded text-cream text-sm outline-none focus:border-gold"></div>`;}).join('');document.getElementById('rename-modal').classList.remove('hidden');document.getElementById('rename-modal').classList.add('flex');const fi=list.querySelector('input');if(fi){fi.focus();fi.select();}}
function closeRename(){document.getElementById('rename-modal').classList.add('hidden');document.getElementById('rename-modal').classList.remove('flex');}
async function confirmRename(){const inputs=document.querySelectorAll('#rename-list input');let ok=0;const undoActions=[];for(const inp of inputs){const orig=inp.dataset.original,nn=inp.value.trim();if(!nn||nn===orig)continue;const src=currentPath+(currentPath.endsWith('/')?'':'/')+orig;const dest=currentPath+(currentPath.endsWith('/')?'':'/')+nn;const r=await api('/resources'+encodeURI(src)+'?action=rename&destination='+encodeURIComponent(dest),{method:'PATCH'});if(r.ok){ok++;undoActions.push({from:src,to:dest});}}closeRename();if(ok){pushUndo('rename',undoActions);toast(`Renamed ${ok}`,'success');treeCache={};selectedSet.clear();activeIdx=-1;multiSelectMode=false;navigate(currentPath);}}


// Convert/Resize modal
function openConvertModal(idx) {
  const item = items[idx];
  if (!item) return;
  const ext = item.name.split('.').pop().toLowerCase();
  const isImage = ['jpg','jpeg','png','gif','webp','svg','bmp','avif','tiff'].includes(ext);
  const isVideo = ['mp4','webm','mkv','avi','mov','m4v','ogv'].includes(ext);
  const isAudio = ['mp3','wav','flac','ogg','m4a','aac','wma'].includes(ext);
  const fileType = isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'unknown';

  const formatMap = {
    image: [['jpg','JPG'],['png','PNG'],['webp','WebP'],['avif','AVIF']],
    video: [['mp4','MP4'],['webm','WebM'],['mkv','MKV'],['gif','GIF (no audio)']],
    audio: [['mp3','MP3'],['wav','WAV'],['flac','FLAC'],['ogg','OGG'],['m4a','M4A']],
  };
  const formats = formatMap[fileType] || [];
  const formatOpts = formats.map(([v,l]) => `<option value="${v}" ${v===ext?'selected':''}>${l}</option>`).join('');

  const ov = document.createElement('div');
  ov.id = 'convert-modal';
  ov.className = 'modal-overlay fixed inset-0 bg-black/70 z-[9999] flex items-center justify-center';

  ov.innerHTML = `<div class="bg-[rgba(15,20,35,0.85)] backdrop-blur-xl border border-white/[.08] rounded-xl w-[90%] max-w-[380px] relative overflow-hidden">
    <div class="px-5 pt-4 pb-3 border-b border-white/[.05]">
      <div class="flex justify-between items-center">
        <h2 class="font-sans font-medium text-sm text-white/90">Convert / Resize</h2>
        <button onclick="document.getElementById('convert-modal').remove()" class="text-white/30 hover:text-white/60 text-lg leading-none">&times;</button>
      </div>
      <p class="text-[.65rem] text-white/35 mt-1 truncate">${item.name} · ${formatSize(item.size)}</p>
    </div>

    <div class="px-5 py-4 space-y-4">
      <div>
        <label class="block text-[.6rem] uppercase tracking-wider text-white/40 mb-1.5">Output Format</label>
        <select id="conv-format" class="w-full px-3 py-2 bg-white/[.04] border border-white/[.08] rounded-lg text-xs text-white/90 focus:border-gold/30 focus:outline-none transition">${formatOpts}</select>
      </div>

      ${isImage ? `<div>
        <label class="block text-[.6rem] uppercase tracking-wider text-white/40 mb-1.5">Dimensions</label>
        <div class="flex gap-2 items-center">
          <input id="conv-width" type="number" placeholder="Width" class="flex-1 px-3 py-2 bg-white/[.04] border border-white/[.08] rounded-lg text-xs text-white/90 focus:border-gold/30 focus:outline-none transition">
          <button id="conv-lock" onclick="this.dataset.locked=this.dataset.locked==='1'?'0':'1';this.textContent=this.dataset.locked==='1'?'🔗':'🔓'" data-locked="1" class="text-sm px-1">🔗</button>
          <input id="conv-height" type="number" placeholder="Height" class="flex-1 px-3 py-2 bg-white/[.04] border border-white/[.08] rounded-lg text-xs text-white/90 focus:border-gold/30 focus:outline-none transition">
        </div>
        <p class="text-[.55rem] text-white/20 mt-1">Empty = keep original. Lock maintains aspect ratio.</p>
      </div>` : ''}

      ${(isImage || isVideo) ? `<div>
        <label class="block text-[.6rem] uppercase tracking-wider text-white/40 mb-1.5">Quality</label>
        <div class="flex items-center gap-3">
          <input id="conv-quality" type="range" min="10" max="100" value="85" class="flex-1 accent-[#C2A35A]" oninput="document.getElementById('conv-q-val').textContent=this.value+'%'">
          <span id="conv-q-val" class="text-xs text-white/50 w-8">85%</span>
        </div>
      </div>` : ''}

      ${isVideo ? `<div>
        <label class="block text-[.6rem] uppercase tracking-wider text-white/40 mb-1.5">Resolution</label>
        <select id="conv-resolution" class="w-full px-3 py-2 bg-white/[.04] border border-white/[.08] rounded-lg text-xs text-white/90 focus:border-gold/30 focus:outline-none transition">
          <option value="">Keep original</option>
          <option value="1920:1080">1080p</option>
          <option value="1280:720">720p</option>
          <option value="854:480">480p</option>
          <option value="640:360">360p</option>
        </select>
      </div>` : ''}
    </div>

    <div class="px-5 pb-4">
      <button onclick="startConversion(${idx})" class="w-full py-2.5 bg-gold/[.08] border border-gold/20 text-gold rounded-lg font-semibold text-sm cursor-pointer hover:bg-gold/[.15] transition">Convert</button>
      <div id="conv-status" class="text-center text-xs mt-2 hidden"></div>
    </div>
  </div>`;

  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
}

async function startConversion(idx) {
  const item = items[idx];
  const format = document.getElementById('conv-format')?.value;
  const width = document.getElementById('conv-width')?.value || '';
  const height = document.getElementById('conv-height')?.value || '';
  const quality = document.getElementById('conv-quality')?.value || '85';
  const resolution = document.getElementById('conv-resolution')?.value || '';
  const status = document.getElementById('conv-status');
  const ext = item.name.split('.').pop().toLowerCase();
  const isImage = ['jpg','jpeg','png','gif','webp','svg','bmp','avif','tiff'].includes(ext);

  if (!format) { toast('Select a format', 'error'); return; }
  status.classList.remove('hidden');
  status.style.color = '';

  // Images: try Cloudflare edge transform first (instant, no server load)
  if (isImage) {
    status.innerHTML = '<div class="hk-spinner hk-spinner-sm inline-block mr-2 align-middle"></div><span class="align-middle">Transforming via edge...</span>';
    const filePath = getItemPath(idx);
    const rawUrl = '/api/raw' + encodeURI(filePath) + '?auth=' + token;
    // Build Cloudflare transform params
    let cfParams = ['format=' + format, 'quality=' + quality];
    if (width) cfParams.push('width=' + width);
    if (height) cfParams.push('height=' + height);
    if (width || height) cfParams.push('fit=scale-down');
    const cfUrl = '/cdn-cgi/image/' + cfParams.join(',') + rawUrl;

    try {
      const r = await fetch(cfUrl);
      if (r.ok && r.headers.get('content-type')?.includes('image')) {
        const blob = await r.blob();
        const size = blob.size > 1048576 ? (blob.size/1048576).toFixed(1)+'MB' : (blob.size/1024).toFixed(0)+'KB';
        // Offer download
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const base = item.name.substring(0, item.name.lastIndexOf('.'));
        a.download = base + '_converted.' + format;
        a.click();
        URL.revokeObjectURL(a.href);
        status.innerHTML = '\u2713 Downloaded (' + size + ') via Cloudflare edge';
        status.style.color = '#22c55e';
        toast('Converted via edge: ' + size, 'success');
        setTimeout(() => { document.getElementById('convert-modal')?.remove(); }, 2000);
        return;
      }
    } catch(e) { /* edge transform failed, fall through to server */ }

    // Fallback: server-side ffmpeg
    status.innerHTML = '<div class="hk-spinner hk-spinner-sm inline-block mr-2 align-middle"></div><span class="align-middle">Converting on server...</span>';
  } else {
    status.innerHTML = '<div class="hk-spinner hk-spinner-sm inline-block mr-2 align-middle"></div><span class="align-middle">Converting...</span>';
  }

  try {
    const r = await fetch('/resolver-api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: getItemPath(idx), format, width: width||null, height: height||null, quality: parseInt(quality), resolution: resolution||null }),
    });
    const data = await r.json();
    if (data.ok) {
      status.innerHTML = '\u2713 ' + data.output + ' (' + data.size + ')';
      status.style.color = '#22c55e';
      toast('Converted: ' + data.output, 'success');
      setTimeout(() => { document.getElementById('convert-modal')?.remove(); refreshFiles(); }, 2000);
    } else {
      status.innerHTML = '\u2717 ' + (data.error || 'Failed');
      status.style.color = '#ef4444';
    }
  } catch(e) {
    status.innerHTML = '\u2717 ' + e.message;
    status.style.color = '#ef4444';
  }
}




// VirusTotal scan — compute hash and check
async function scanViruses(idx) {
  const item = items[idx];
  if (!item || item.isDir) return;

  // Show scanning overlay
  const ov = document.createElement('div');
  ov.id = 'vt-modal';
  ov.className = 'modal-overlay fixed inset-0 bg-black/70 z-[9999] flex items-center justify-center';
  ov.innerHTML = `<div class="bg-[rgba(15,20,35,0.85)] backdrop-blur-xl border border-white/[.08] rounded-xl p-5 w-[90%] max-w-[380px] relative">
    <div class="flex justify-between items-center mb-3">
      <h2 class="font-sans font-medium text-sm text-white/90">🛡 Virus Scan</h2>
      <button onclick="document.getElementById('vt-modal').remove()" class="text-white/30 hover:text-white/60 text-lg">&times;</button>
    </div>
    <p class="text-[.65rem] text-white/35 mb-3 truncate">${item.name} · ${formatSize(item.size)}</p>
    <div id="vt-status" class="text-center py-4">
      <div class="hk-spinner mx-auto mb-2"></div>
      <p class="text-xs text-white/40">Computing file hash...</p>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });

  const status = document.getElementById('vt-status');

  try {
    // Fetch file and compute SHA256
    const filePath = getItemPath(idx);
    const r = await api('/raw' + encodeURI(filePath));
    if (!r.ok) { status.innerHTML = '<p class="text-danger text-xs">Failed to read file</p>'; return; }
    const buffer = await r.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const sha256 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    status.innerHTML = `<p class="text-xs text-white/50 mb-2">SHA-256: <span class="font-mono text-[.6rem] text-white/70">${sha256.substring(0,32)}...</span></p>
      <div class="hk-spinner hk-spinner-sm mx-auto mb-2"></div>
      <p class="text-xs text-white/40">Checking VirusTotal...</p>`;

    // Query VT via our backend (proxied to avoid CORS)
    const vtRes = await fetch('/resolver-api/virustotal?hash=' + sha256);
    const vtData = await vtRes.json();

    if (vtData.error) {
      status.innerHTML = `<p class="text-xs text-white/50 mb-2">SHA-256: <span class="font-mono text-[.6rem]">${sha256.substring(0,32)}...</span></p>
        <p class="text-xs text-amber-400">⚠ ${vtData.error}</p>`;
      return;
    }

    const detected = vtData.positives || 0;
    const total = vtData.total || 0;
    const isClean = detected === 0;
    const color = isClean ? '#22c55e' : detected <= 3 ? '#f59e0b' : '#ef4444';
    const icon = isClean ? '✓' : detected <= 3 ? '⚠' : '✗';
    const label = isClean ? 'Clean' : detected + '/' + total + ' engines detected threats';

    let html = `<div style="text-align:center;">
      <div style="font-size:2rem;color:${color};margin-bottom:8px;">${icon}</div>
      <p style="font-size:13px;font-weight:600;color:${color};margin-bottom:4px;">${label}</p>
      <p class="text-[.6rem] text-white/30 font-mono mb-3">${sha256}</p>`;

    if (vtData.scans && detected > 0) {
      html += '<div style="text-align:left;max-height:120px;overflow-y:auto;padding:8px;background:rgba(0,0,0,0.2);border-radius:6px;margin-bottom:8px;">';
      for (const [engine, result] of Object.entries(vtData.scans)) {
        if (result.detected) html += `<div style="font-size:10px;color:#fca5a5;margin-bottom:2px;">${engine}: ${result.result}</div>`;
      }
      html += '</div>';
    }

    if (vtData.permalink) html += `<a href="${vtData.permalink}" target="_blank" style="font-size:10px;color:rgba(96,165,250,0.7);">View on VirusTotal →</a>`;
    html += '</div>';
    status.innerHTML = html;

  } catch(e) {
    status.innerHTML = `<p class="text-danger text-xs">Error: ${e.message}</p>`;
  }
}

// Pack selected files/folder as ZIP download
async function packAsZip() {
  if (selectedSet.size === 0) { toast('Select files first', 'error'); return; }

  toast('Packing ZIP...', 'info');

  if (selectedSet.size === 1) {
    // Single item — download it directly as zip
    const idx = [...selectedSet][0];
    const item = items[idx];
    const itemPath = getItemPath(idx);
    const zipUrl = '/api/raw' + encodeURI(itemPath) + (item.isDir ? '/' : '') + '?auth=' + token + '&algo=zip';
    const a = document.createElement('a');
    a.href = zipUrl;
    a.download = item.name + '.zip';
    a.click();
    toast('Downloading ZIP', 'success');
  } else {
    // Multiple items — use filebrowser's batch download (downloads current folder as zip with selection)
    // Filebrowser doesn't support selective zip, so we'll zip the whole current folder
    // Alternative: create a temp folder, copy selected, zip that — but that's heavy
    // Simplest: download current directory as zip
    const zipUrl = '/api/raw' + encodeURI(currentPath) + '?auth=' + token + '&algo=zip';
    const a = document.createElement('a');
    a.href = zipUrl;
    a.download = (currentPath.split('/').filter(Boolean).pop() || 'files') + '.zip';
    a.click();
    toast('Downloading folder as ZIP (all items in current folder)', 'info');
  }
}

function infoItem(idx){const item=items[idx];const rows=[['Name',item.name],['Type',item.isDir?'Folder':item.type||'File'],['Size',item.isDir?(item.numFiles||0)+' items':formatSize(item.size)],['Created',item.created?new Date(item.created).toLocaleString():'—'],['Modified',item.modified?new Date(item.modified).toLocaleString():'—'],['Path',getItemPath(idx)]];document.getElementById('info-content').innerHTML=rows.map(([k,v])=>`<div class="flex justify-between py-1.5 border-b border-white/5 text-xs"><span class="text-cream-dim">${k}</span><span class="text-cream text-right max-w-[60%] break-all">${v}</span></div>`).join('');document.getElementById('info-modal').classList.remove('hidden');document.getElementById('info-modal').classList.add('flex');}
function closeInfo(){document.getElementById('info-modal').classList.add('hidden');document.getElementById('info-modal').classList.remove('flex');}

// ===== CUSTOM PROMPT MODAL =====
let _promptResolve=null;
function showPromptModal(title,defaultValue=''){
  return new Promise((resolve)=>{
    _promptResolve=resolve;
    document.getElementById('prompt-title').textContent=title;
    const inp=document.getElementById('prompt-input');
    inp.value=defaultValue;
    document.getElementById('prompt-modal').classList.remove('hidden');
    document.getElementById('prompt-modal').classList.add('flex');
    setTimeout(()=>{inp.focus();inp.select();},100);
  });
}
function resolvePrompt(){
  const val=document.getElementById('prompt-input').value.trim();
  closePromptModal();
  if(_promptResolve)_promptResolve(val||null);
  _promptResolve=null;
}
function closePromptModal(){
  document.getElementById('prompt-modal').classList.add('hidden');
  document.getElementById('prompt-modal').classList.remove('flex');
  if(_promptResolve)_promptResolve(null);
  _promptResolve=null;
}
document.getElementById('prompt-input').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();resolvePrompt();}if(e.key==='Escape'){closePromptModal();}});

// ===== NEW FILE/FOLDER (Modal) =====
let createNewType = 'folder';
let createNewUserName = '';
let createNewLocationPath = '';

const CREATE_TYPES = {
  folder: {ext:'', default:'New Folder'},
  txt: {ext:'.txt', default:'untitled'},
  json: {ext:'.json', default:'data'},
  lua: {ext:'.lua', default:'script'},
  zip: {ext:'.zip', default:'archive'},
  blank: {ext:'', default:'newfile'},
};

function openCreateNewModal(){
  createNewLocationPath = currentPath;
  createNewUserName = '';
  document.getElementById('create-new-location').textContent = currentPath;
  selectNewType('folder');
  document.getElementById('create-new-modal').classList.remove('hidden');
  document.getElementById('create-new-modal').classList.add('flex');
  setTimeout(()=>{document.getElementById('create-new-name').focus();document.getElementById('create-new-name').select();},100);
}
function closeCreateNewModal(){
  document.getElementById('create-new-modal').classList.add('hidden');
  document.getElementById('create-new-modal').classList.remove('flex');
}
function selectNewType(type){
  createNewType = type;
  const typeInfo = CREATE_TYPES[type];
  document.querySelectorAll('.create-type-btn').forEach(btn=>{
    if(btn.dataset.type===type)btn.classList.add('!border-gold','!bg-gold/[.15]','!text-gold');
    else btn.classList.remove('!border-gold','!bg-gold/[.15]','!text-gold');
  });
  const extEl = document.getElementById('create-new-ext');
  if(typeInfo.ext){extEl.textContent=typeInfo.ext;extEl.style.display='';}
  else{extEl.textContent='';extEl.style.display='none';}
  const nameInput = document.getElementById('create-new-name');
  if(!createNewUserName){nameInput.value=typeInfo.default;}
  if(!typeInfo.ext){nameInput.classList.remove('rounded-l');nameInput.classList.add('rounded');}
  else{nameInput.classList.add('rounded-l');nameInput.classList.remove('rounded');}
  nameInput.focus();nameInput.select();
}
document.getElementById('create-new-name').addEventListener('input',e=>{createNewUserName=e.target.value;});
document.getElementById('create-new-name').addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();executeCreateNew();}
  if(e.key==='Escape'){closeCreateNewModal();}
});

function changeCreateLocation(){
  moveBrowsePath = createNewLocationPath;
  document.getElementById('move-modal').classList.remove('hidden');
  document.getElementById('move-modal').classList.add('flex');
  const origConfirmMove = window.confirmMove;
  window.confirmMove = function(){
    createNewLocationPath = moveBrowsePath;
    document.getElementById('create-new-location').textContent = createNewLocationPath;
    document.getElementById('move-modal').classList.add('hidden');
    document.getElementById('move-modal').classList.remove('flex');
    window.confirmMove = origConfirmMove;
  };
  const moveBtn = document.querySelector('#move-modal button[onclick="confirmMove()"]');
  if(moveBtn)moveBtn.textContent='Select This Location';
  renderMoveFolders();
}

async function executeCreateNew(){
  const name = document.getElementById('create-new-name').value.trim();
  if(!name){toast('Please enter a name','error');return;}
  const typeInfo = CREATE_TYPES[createNewType];
  const fullName = name + typeInfo.ext;
  closeCreateNewModal();
  const basePath = createNewLocationPath || currentPath;
  if(createNewType==='folder'){
    const path = basePath+(basePath.endsWith('/')?'':'/')+fullName+'/';
    const res = await api('/resources'+encodeURI(path),{method:'POST',body:''});
    if(res.ok){toast('Folder created','success');treeCache={};navigate(currentPath);}
    else toast('Failed: '+res.status,'error');
  } else {
    const path = basePath+(basePath.endsWith('/')?'':'/')+fullName;
    let body;
    if(createNewType==='json')body=new Blob(['{\n  \n}\n'],{type:'application/json'});
    else if(createNewType==='lua')body=new Blob(['-- '+fullName+'\n\n'],{type:'text/plain'});
    else if(createNewType==='zip'){const zipBytes=new Uint8Array([80,75,5,6,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);body=new Blob([zipBytes],{type:'application/zip'});}
    else body=new Blob([''],{type:'text/plain'});
    const res = await api('/resources'+encodeURI(path),{method:'POST',headers:{'X-Auth':token,'Content-Type':body.type},body:body});
    if(res.ok){toast('Created '+fullName,'success');navigate(currentPath);}
    else toast('Failed: '+res.status,'error');
  }
}

