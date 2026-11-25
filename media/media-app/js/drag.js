// ===== DRAG-TO-MOVE SYSTEM =====
let dragState = {
  active: false,
  srcPaths: [],
  srcNames: [],
  srcDirs: [],  // boolean array: true if item is a directory
  navTimer: null,
  navTarget: null,
};

function onItemDragStart(e,idx){
  dragState.active=true;
  if(selectedSet.size>1&&selectedSet.has(idx)){
    dragState.srcPaths=[...selectedSet].map(i=>getItemPath(i));
    dragState.srcNames=[...selectedSet].map(i=>items[i].name);
    dragState.srcDirs=[...selectedSet].map(i=>items[i].isDir);
  } else {
    dragState.srcPaths=[getItemPath(idx)];
    dragState.srcNames=[items[idx].name];
    dragState.srcDirs=[items[idx].isDir];
  }
  e.dataTransfer.setData('text/plain',idx.toString());
  e.dataTransfer.effectAllowed='move';
  const ghost=document.createElement('div');
  ghost.style.cssText='position:absolute;top:-999px;padding:6px 12px;background:rgba(15,20,35,.95);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.1);border-radius:8px;font-size:12px;color:rgba(255,255,255,0.85);display:flex;align-items:center;gap:6px;max-width:250px;';
  if(dragState.srcNames.length===1){
    const icon=dragState.srcDirs[0]?'📁':'📄';
    ghost.innerHTML=`<span>${icon}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${dragState.srcNames[0]}</span>`;
  } else {
    ghost.innerHTML=`<span>📑</span><span>${dragState.srcNames.length} items</span>`;
  }
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost,40,20);
  setTimeout(()=>ghost.remove(),0);
}

function onItemDragOver(e,idx){
  const t=items[idx];
  if(!t||!t.isDir)return;
  const tPath=getItemPath(idx);
  if(dragState.srcPaths.includes(tPath))return;
  e.preventDefault();e.dataTransfer.dropEffect='move';
  e.currentTarget.classList.add('item-drag-over');
  if(dragState.navTarget!==idx){
    clearTimeout(dragState.navTimer);
    dragState.navTarget=idx;
    dragState.navTimer=setTimeout(()=>{
      if(dragState.active){navigate(currentPath+(currentPath.endsWith('/')?'':'/')+t.name);}
    },800);
  }
}
function onItemDragLeave(e){
  e.currentTarget.classList.remove('item-drag-over');
  clearTimeout(dragState.navTimer);dragState.navTarget=null;
}
function onItemDrop(e,idx){
  e.preventDefault();e.stopPropagation();
  e.currentTarget.classList.remove('item-drag-over');
  clearTimeout(dragState.navTimer);dragState.navTarget=null;
  const target=items[idx];
  if(!target||!target.isDir)return;
  const destPath=target.path||currentPath+(currentPath.endsWith('/')?'':'/')+target.name;
  if(dragState.srcPaths.includes(destPath))return;
  showDropConfirm(destPath);
}
function onBackDragOver(e){
  if(!dragState.active)return;
  e.preventDefault();e.dataTransfer.dropEffect='move';
  e.currentTarget.classList.add('item-drag-over');
  if(dragState.navTarget!=='__back'){
    clearTimeout(dragState.navTimer);
    dragState.navTarget='__back';
    dragState.navTimer=setTimeout(()=>{if(dragState.active)navigateUp();},800);
  }
}
function onBackDrop(e){
  e.preventDefault();e.stopPropagation();
  e.currentTarget.classList.remove('item-drag-over');
  clearTimeout(dragState.navTimer);dragState.navTarget=null;
  if(!dragState.srcPaths.length)return;
  if(currentPath===currentRoot){dragState.active=false;dragState.srcPaths=[];return;}
  const parts=currentPath.split('/').filter(Boolean);parts.pop();
  showDropConfirm('/'+parts.join('/'));
}

let dragExpandTimer=null;let dragExpandPath=null;
function onTreeDragOver(e,path){
  if(!dragState.active)return;
  e.preventDefault();e.dataTransfer.dropEffect='move';
  e.currentTarget.classList.add('tree-drag-over');
  if(dragExpandPath!==path){
    clearTimeout(dragExpandTimer);dragExpandPath=path;
    dragExpandTimer=setTimeout(async()=>{if(!treeExpanded.has(path)){treeExpanded.add(path);await renderSidebar();}},800);
  }
}
function onTreeDragLeave(e){e.currentTarget.classList.remove('tree-drag-over');clearTimeout(dragExpandTimer);dragExpandPath=null;}
function onTreeDrop(e,destPath){
  e.preventDefault();e.stopPropagation();
  e.currentTarget.classList.remove('tree-drag-over');
  clearTimeout(dragExpandTimer);dragExpandPath=null;
  if(!dragState.srcPaths.length)return;
  showDropConfirm(destPath);
}

async function showDropConfirm(destFolder){
  if(!dragState.srcPaths.length)return;
  const validPaths=dragState.srcPaths.filter(p=>{
    const parent=p.substring(0,p.lastIndexOf('/'));
    return parent!==destFolder&&p!==destFolder&&!destFolder.startsWith(p+'/');
  });
  if(!validPaths.length){dragState.active=false;dragState.srcPaths=[];dragState.srcNames=[];dragState.srcDirs=[];return;}
  const validIndices=dragState.srcPaths.map((p,i)=>validPaths.includes(p)?i:-1).filter(i=>i>=0);
  const names=validPaths.map(p=>p.split('/').pop());
  const dirs=validIndices.map(i=>dragState.srcDirs[i]||false);

  // Pre-fetch destination to detect dupes
  let existingNames=new Set();
  try{
    const res=await api('/resources'+destFolder);
    if(res.ok){const d=await res.json();existingNames=new Set((d.items||[]).map(i=>i.name));}
  }catch(e){}
  const dupes=names.filter(n=>existingNames.has(n));

  // Build unified modal
  let html=`<p class="text-sm mb-2">Move ${names.length} item(s) here?</p>`;
  html+=names.slice(0,6).map((n,i)=>{
    const isDupe=existingNames.has(n);
    const dupeTag=isDupe?'<span class="ml-1 px-1 py-0.5 bg-warn/20 text-warn rounded text-[.5rem]">exists</span>':'';
    return `<p class="text-gold mb-0.5 text-xs flex items-center gap-1.5">${getConfirmItemIcon(n,dirs[i])} ${n}${dupeTag}</p>`;
  }).join('');
  if(names.length>6)html+=`<p class="text-cream-dim text-xs mt-1">...and ${names.length-6} more</p>`;
  html+=`<p class="text-[.7rem] text-success mt-2">To: ${destFolder}</p>`;
  if(dupes.length)html+=`<p class="text-[.65rem] text-warn mt-1">⚠ ${dupes.length} item(s) already exist at destination</p>`;

  document.getElementById('move-confirm-detail').innerHTML=html;
  const modal=document.getElementById('move-confirm-modal');
  modal.querySelector('h2').textContent='↪ Confirm Move';
  const execBtn=document.getElementById('move-confirm-exec-btn');
  const cancelBtn=document.getElementById('move-confirm-cancel-btn');
  cancelBtn.style.display='';

  if(dupes.length){
    // Show dupe-aware buttons
    execBtn.style.display='';execBtn.textContent='Replace & Move';
    execBtn.setAttribute('onclick',`executeDropWithDupeAction('${destFolder.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}','replace');`);
    // Add extra buttons for rename/skip
    let extraHtml=`<button class="w-full py-2.5 mt-2 bg-sky-400/10 border border-sky-400/40 text-sky-400 rounded font-semibold cursor-pointer text-sm hover:bg-sky-400/20 transition" onclick="executeDropWithDupeAction('${destFolder.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}','rename')">Keep both (auto-rename)</button>`;
    extraHtml+=`<button class="w-full py-2.5 mt-2 bg-white/5 border border-cream-dim/30 text-cream-dim rounded font-semibold cursor-pointer text-sm hover:bg-white/10 transition" onclick="executeDropWithDupeAction('${destFolder.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}','skip')">Skip duplicates</button>`;
    cancelBtn.insertAdjacentHTML('beforebegin',extraHtml);
  } else {
    execBtn.style.display='';execBtn.textContent='Move';
    execBtn.setAttribute('onclick',`executeDropWithDupeAction('${destFolder.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}','replace');`);
  }
  // Store existingNames for the execute function
  window._dropExistingNames=existingNames;
  modal.classList.remove('hidden');modal.classList.add('flex');
}

async function executeDropWithDupeAction(destFolder,dupeAction){
  const existingNames=window._dropExistingNames||new Set();
  window._dropExistingNames=null;
  const paths=[...dragState.srcPaths];
  closeDragConfirm();
  if(!paths.length)return;
  const validPaths=paths.filter(p=>destFolder!==p&&!destFolder.startsWith(p+'/'));
  if(!validPaths.length){toast('Cannot move into itself','error');return;}
  toast('Moving...','info');
  let ok=0,fail=0,skipped=0;const undoActions=[];
  for(const srcPath of validPaths){
    const name=srcPath.split('/').pop();
    const isDupe=existingNames.has(name);
    if(isDupe&&dupeAction==='skip'){skipped++;continue;}
    let dest;
    if(isDupe&&dupeAction==='rename'){
      dest=getRenamePath(destFolder,name,existingNames);
    } else {
      dest=destFolder+(destFolder.endsWith('/')?'':'/')+name;
      if(isDupe&&dupeAction==='replace'){
        await api('/resources'+encodeURI(dest),{method:'DELETE'});
      }
    }
    if(srcPath===dest)continue;
    const r=await api('/resources'+encodeURI(srcPath)+'?action=rename&destination='+encodeURIComponent(dest),{method:'PATCH'});
    if(r.ok){ok++;undoActions.push({from:srcPath,to:dest});}else fail++;
  }
  if(ok)pushUndo('move',undoActions);
  let msg=ok?`Moved ${ok} item(s)`:'Move failed';
  if(skipped)msg+=` · ${skipped} skipped`;
  toast(msg,fail?'error':'success');
  treeCache={};selectedSet.clear();activeIdx=-1;multiSelectMode=false;navigate(currentPath);
}

function closeDragConfirm(){
  const modal=document.getElementById('move-confirm-modal');
  modal.classList.add('hidden');modal.classList.remove('flex');
  modal.querySelector('h2').textContent='↪ Confirm Move';
  // Remove any extra injected buttons (dupe options)
  const detail=document.getElementById('move-confirm-detail');
  const execBtn=document.getElementById('move-confirm-exec-btn');
  const cancelBtn=document.getElementById('move-confirm-cancel-btn');
  // Remove buttons between detail and execBtn (injected dupe buttons are siblings)
  modal.querySelectorAll('.modal-dupe-btn').forEach(b=>b.remove());
  // Also remove by checking non-standard buttons in the modal body
  const modalBody=execBtn.parentElement;
  modalBody.querySelectorAll('button:not(#move-confirm-exec-btn):not(#move-confirm-cancel-btn):not(.modal-close)').forEach(b=>{
    if(b!==execBtn&&b!==cancelBtn)b.remove();
  });
  execBtn.setAttribute('onclick','executeMoveConfirm()');
  execBtn.style.display='';
  cancelBtn.style.display='';
  dragState.active=false;dragState.srcPaths=[];dragState.srcNames=[];dragState.srcDirs=[];
  clearTimeout(dragState.navTimer);dragState.navTarget=null;
  window._dropExistingNames=null;
  window._pasteExistingNames=null;
}
// closeMoveConfirm alias for paste/dupe modal reuse
function closeMoveConfirm(){closeDragConfirm();}
// executeMoveConfirm — placeholder for modal button; actual logic in executeDrop
function executeMoveConfirm(){}

// ===== GLOBAL DRAG & DROP (file uploads from OS) =====
function setupDragDrop(){
  document.addEventListener('dragenter',e=>{e.preventDefault();if(dragState.active)return;dragCounter++;if(dragCounter===1&&token){document.getElementById('drag-overlay').classList.remove('hidden');document.getElementById('drag-overlay').classList.add('flex');}});
  document.addEventListener('dragleave',e=>{e.preventDefault();if(dragState.active)return;dragCounter--;if(dragCounter<=0){dragCounter=0;document.getElementById('drag-overlay').classList.add('hidden');document.getElementById('drag-overlay').classList.remove('flex');}});
  document.addEventListener('dragover',e=>{e.preventDefault();});
  document.addEventListener('drop',async e=>{
    e.preventDefault();dragCounter=0;
    document.getElementById('drag-overlay').classList.add('hidden');document.getElementById('drag-overlay').classList.remove('flex');
    if(dragState.active){
      // Dropping on empty space while dragging items = drop into current folder
      if(dragState.srcPaths.length){
        showDropConfirm(currentPath);
      } else {
        dragState.active=false;dragState.srcPaths=[];dragState.srcNames=[];dragState.srcDirs=[];
      }
      return;
    }
    if(!token)return;
    const files=await getDroppedFiles(e.dataTransfer);
    if(files.length){uploadQueue=[];addFilesToQueue(files);document.getElementById('upload-modal').classList.remove('hidden');document.getElementById('upload-modal').classList.add('flex');}
  });
  document.addEventListener('dragend',()=>{
    // Delay cleanup to let drop handler fire first (drop fires before dragend in spec,
    // but if the source element was destroyed by navigate(), dragend fires immediately)
    setTimeout(()=>{
      // Only clean up if no confirm modal is showing
      const modal=document.getElementById('move-confirm-modal');
      if(!modal.classList.contains('flex')){
        dragState.active=false;dragState.srcPaths=[];dragState.srcNames=[];dragState.srcDirs=[];
        clearTimeout(dragState.navTimer);dragState.navTarget=null;
      }
    },100);
  });

  // File-list level: catch drops on empty space within the file grid
  const fileListEl=document.getElementById('file-list');
  fileListEl.addEventListener('dragover',e=>{
    if(!dragState.active)return;
    e.preventDefault();e.dataTransfer.dropEffect='move';
  });
  fileListEl.addEventListener('drop',e=>{
    if(!dragState.active||!dragState.srcPaths.length)return;
    // Only handle if the drop target is the file-list itself or empty space (not a .file-item)
    if(e.target.closest('.file-item'))return;
    e.preventDefault();e.stopPropagation();
    showDropConfirm(currentPath);
  });
}
